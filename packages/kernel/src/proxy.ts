import type { GovernedCallResult } from '@tcpcore1/shared';
import { ACTOR_ID_HEADER, ACTOR_TYPE_HEADER, ON_BEHALF_OF_HEADER } from '@tcpcore1/shared';
import { formatIssues, validateAgainstSchema, type ValidationIssue } from './schema-validate.js';
import { sanitizePayload, type InjectionSignal } from './sanitize.js';
import {
  assertOutboundAllowed,
  buildPath,
  buildUrl,
  OutboundRequestError,
  redactHeaders,
} from './ssrf-guard.js';
import type { Actor, AuditSink, KernelCapabilityRecord, RecordAuditInput } from './types.js';

export interface AuthHeaderProvider {
  getAuthHeader(
    integration: { name: string; id: string; authType: string },
    actor: Actor,
  ): Promise<{ headers: Record<string, string>; mechanism: string; refreshed: boolean }>;
}

export interface GovernedProxyOptions {
  auditor: AuditSink;
  tokenBroker: AuthHeaderProvider;
  /** Outbound host allowlist. Empty = unrestricted (development only). */
  outboundHostAllowlist?: string[];
  requireHttps?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Force sanitisation even for capabilities not marked `content_risk`. */
  sanitizeAllResponses?: boolean;
  fetchImpl?: typeof fetch;
}

export interface GovernedProxyInput {
  integration: {
    id: string;
    name: string;
    baseUrl: string;
    authType: string;
    /**
     * Forward `x-tcpcore-actor-*` identity headers to this integration.
     *
     * Defaults to false, and must stay false for any third-party SaaS target:
     * those headers would leak our internal actor ids to an external system and
     * fingerprint every request as TCPcore-originated. They exist so an
     * *internal* integration can attribute the originating agent, and real
     * identity is carried by the brokered Authorization header regardless.
     *
     * This is an explicit opt-in rather than a `name === 'internal'` check:
     * matching on a magic name silently breaks the moment an adapter is
     * renamed, and silently *leaks* the moment someone names a third-party
     * adapter "internal".
     */
    forwardActorHeaders?: boolean;
  };
  capability: KernelCapabilityRecord;
  args: Record<string, unknown>;
  actor: Actor;
  requestId?: string;
  approvalId?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * `governedCall` — the single execution path.
 *
 * Every agent-originated request to any integration passes through here. That
 * invariant is what makes the governance claims true: if a call can reach an
 * integration without passing through this function, the risk gate, audit trail
 * and credential brokering have all been bypassed.
 *
 * Ordering is deliberate:
 *   1. Validate arguments against the declared input schema (before any I/O).
 *   2. Assemble and authorise the URL (SSRF guard).
 *   3. Broker credentials.
 *   4. Execute with a timeout and a response size cap.
 *   5. Sanitise the response for prompt injection.
 *   6. Audit — success and failure alike.
 */
export class GovernedProxy {
  private readonly auditor: AuditSink;
  private readonly tokenBroker: AuthHeaderProvider;
  private readonly outboundHostAllowlist: string[];
  private readonly requireHttps: boolean;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly sanitizeAllResponses: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GovernedProxyOptions) {
    this.auditor = options.auditor;
    this.tokenBroker = options.tokenBroker;
    this.outboundHostAllowlist = options.outboundHostAllowlist ?? [];
    this.requireHttps = options.requireHttps ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sanitizeAllResponses = options.sanitizeAllResponses ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(input: GovernedProxyInput): Promise<GovernedCallResult> {
    const { integration, capability, actor } = input;
    const started = Date.now();

    const baseMetadata = {
      riskLevel: capability.riskLevel,
      riskDecision: 'allow',
      requestId: input.requestId,
      approvalId: input.approvalId,
    };

    // ---------------------------------------------------------------------
    // 1. Validate arguments against the declared schema.
    // ---------------------------------------------------------------------
    const validated = validateAgainstSchema(capability.inputSchema, input.args ?? {}, {
      coerce: false,
      strict: true,
    });

    if (!validated.ok) {
      return this.fail(input, started, baseMetadata, {
        message: `input validation failed: ${formatIssues(validated.issues)}`,
        issues: validated.issues,
        action: 'DENY',
      });
    }

    const args = (validated.value ?? {}) as Record<string, unknown>;

    // ---------------------------------------------------------------------
    // 2. Build and authorise the target URL (SSRF guard).
    // ---------------------------------------------------------------------
    let url: URL;
    let remaining: Record<string, unknown>;
    try {
      const built = buildPath(capability.pathTemplate, args);
      const path = built.path;
      remaining = built.remaining;

      const isQueryMethod =
        capability.method === 'GET' ||
        capability.method === 'HEAD' ||
        capability.method === 'DELETE';

      let query: string | undefined;
      if (isQueryMethod) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(remaining)) {
          if (value === undefined || value === null) continue;
          params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        const encoded = params.toString();
        query = encoded.length > 0 ? encoded : undefined;
      }

      url = buildUrl(integration.baseUrl, path, query);
      assertOutboundAllowed(url, {
        allowlist: this.outboundHostAllowlist,
        requireHttps: this.requireHttps,
      });
    } catch (error) {
      const message =
        error instanceof OutboundRequestError
          ? error.message
          : `could not build target URL: ${(error as Error).message}`;
      return this.fail(input, started, baseMetadata, { message, action: 'DENY' });
    }

    // ---------------------------------------------------------------------
    // 3. Broker credentials.
    // ---------------------------------------------------------------------
    let authHeaders: Record<string, string>;
    try {
      const result = await this.tokenBroker.getAuthHeader(integration, actor);
      authHeaders = result.headers;
    } catch (error) {
      return this.fail(input, started, baseMetadata, {
        message: `credential resolution failed: ${(error as Error).message}`,
        action: 'FAIL',
      });
    }

    // ---------------------------------------------------------------------
    // 4. Execute.
    // ---------------------------------------------------------------------
    const isBodyMethod = !(
      capability.method === 'GET' ||
      capability.method === 'HEAD' ||
      capability.method === 'DELETE'
    );

    // Inbound copies of our own identity headers must never be forwarded: a
    // caller could otherwise forge `x-tcpcore-actor-id` and impersonate another
    // actor to the internal integration.
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'tcpcore-kernel/0.1.0',
      ...authHeaders,
    };

    if (isBodyMethod) headers['Content-Type'] = 'application/json';

    // Tell the target who the kernel is acting for — but only when the
    // integration explicitly asked for it. These are advisory metadata and are
    // never trusted for authorization by a well-built target; real identity is
    // carried by the brokered Authorization header above.
    if (integration.forwardActorHeaders) {
      headers[ACTOR_ID_HEADER] = actor.id;
      headers[ACTOR_TYPE_HEADER] = actor.type;
      headers[ON_BEHALF_OF_HEADER] = actor.id;
    }

    if (input.requestId) headers['x-request-id'] = input.requestId;
    if (input.approvalId) headers['x-tcpcore-approval-id'] = input.approvalId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    let rawBody: string;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: capability.method,
        headers,
        // Send only what was NOT consumed as a path parameter. Previously the
        // full argument object went on the wire, so a value already present in
        // the URL was duplicated into the body — the target received the same
        // field twice, which a target that trusts the body over the path can be
        // confused by.
        body: isBodyMethod ? JSON.stringify(remaining) : undefined,
        signal: controller.signal,
        redirect: 'manual', // A redirect could escape the allowlist; never follow blindly.
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '(none)';
        throw new OutboundRequestError(
          `target returned a redirect (${response.status} -> ${location}); redirects are not followed`,
        );
      }

      rawBody = await this.readCapped(response);
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      const message = aborted
        ? `target call timed out after ${this.timeoutMs}ms`
        : `target call failed: ${(error as Error).message}`;
      return this.fail(input, started, baseMetadata, { message, action: 'FAIL' });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;

    // Parse, tolerating non-JSON bodies.
    let payload: unknown;
    try {
      payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch {
      payload = { raw: rawBody.slice(0, 20_000) };
    }

    if (!response.ok) {
      return this.fail(
        input,
        started,
        baseMetadata,
        {
          message: `target returned HTTP ${response.status}`,
          httpStatus: response.status,
          action: 'FAIL',
        },
        { status: response.status, body: payload },
      );
    }

    // ---------------------------------------------------------------------
    // 5. Prompt-injection sanitisation.
    // ---------------------------------------------------------------------
    const shouldSanitize = this.sanitizeAllResponses || (capability.contentRisk ?? null) !== null;
    let data = payload;
    let sanitized = false;
    let injectionSignals: InjectionSignal[] = [];

    if (shouldSanitize) {
      const result = sanitizePayload(payload);
      data = result.value;
      sanitized = result.sanitized;
      injectionSignals = result.signals;
    }

    // ---------------------------------------------------------------------
    // 6. Audit success.
    // ---------------------------------------------------------------------
    const record = await this.auditor.record({
      actorId: actor.id,
      actorName: actor.name,
      actorType: actor.type,
      targetSystem: integration.name,
      integrationId: integration.id,
      capabilityName: capability.name,
      targetResource: null,
      // Store the *validated* args: what actually went on the wire.
      targetPayload: args,
      action: mapAction(capability.method),
      diff: summariseResponse(data),
      metadata: {
        ...baseMetadata,
        latencyMs,
        httpStatus: response.status,
        sanitized,
        injectionSignals: injectionSignals.map((s) => `${s.id}@${s.path}`),
        compliance: sanitized
          ? 'NIST AU-3 governed call executed (response flagged for injection risk)'
          : 'NIST AU-3 governed call executed',
      },
    });

    return {
      status: 'executed',
      data,
      auditId: record.id,
      latencyMs,
      httpStatus: response.status,
      sanitized,
      injectionSignals: injectionSignals.map((s) => `${s.id}@${s.path}`),
    };
  }

  /** Read a response body with a hard byte cap, streaming to avoid OOM. */
  private async readCapped(response: Response): Promise<string> {
    if (!response.body) return '';

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          throw new OutboundRequestError(
            `target response exceeded ${this.maxResponseBytes} bytes; refusing to buffer further`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }

  /**
   * Audit a failure and return the canonical `failed`/`denied` result.
   *
   * A failed call is audited exactly like a successful one — the architecture
   * requires the outcome to be recorded, not just the happy path. When the call
   * belongs to an approval, the error is written back onto the approval row by
   * `Kernel.executeApproval`, which owns that lifecycle.
   */
  private async fail(
    input: GovernedProxyInput,
    started: number,
    baseMetadata: Record<string, unknown>,
    error: {
      message: string;
      action: 'FAIL' | 'DENY';
      issues?: ValidationIssue[];
      httpStatus?: number;
    },
    diff?: unknown,
  ): Promise<GovernedCallResult> {
    const latencyMs = Date.now() - started;
    const { integration, capability, actor } = input;

    const record = await this.auditor.record({
      actorId: actor.id,
      actorName: actor.name,
      actorType: actor.type,
      targetSystem: integration.name,
      integrationId: integration.id,
      capabilityName: capability.name,
      targetResource: null,
      targetPayload: input.args,
      action: error.action,
      diff: diff ?? { error: error.message },
      metadata: {
        ...baseMetadata,
        latencyMs,
        httpStatus: error.httpStatus,
        error: error.message,
        compliance: 'NIST AU-3 governed call failure',
      },
    });

    // A policy denial is not a technical failure, and the caller must be able
    // to tell them apart: the API layer maps `denied` to 403 and `failed` to
    // 502/404. Reporting a denial as `failed` told a caller "the network broke"
    // when the truth was "policy refused this".
    if (error.action === 'DENY') {
      return { status: 'denied', reason: error.message, auditId: record.id };
    }

    return { status: 'failed', error: error.message, auditId: record.id };
  }
}

function mapAction(method: string): RecordAuditInput['action'] {
  switch (method) {
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    default:
      return 'CALL';
  }
}

/**
 * Keep audit `diff` bounded and secret-free. Full response bodies are not
 * stored: they can be large and may contain customer PII. A shape summary plus
 * a short preview is enough to reconstruct *what* happened.
 */
function summariseResponse(data: unknown): unknown {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return { kind: 'array', length: data.length, sample: data.slice(0, 3) };
  if (typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>);
    return { kind: 'object', keys: keys.slice(0, 40), preview: truncate(data, 4000) };
  }
  if (typeof data === 'string')
    return { kind: 'string', length: data.length, preview: data.slice(0, 2000) };
  return data;
}

function truncate(value: unknown, maxChars: number): unknown {
  const json = JSON.stringify(value, null, 2);
  if (typeof json !== 'string') return value;
  return json.length <= maxChars ? value : `${json.slice(0, maxChars)}…[truncated]`;
}

export { redactHeaders };
export type { KernelCapabilityRecord };

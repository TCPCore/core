import type { AuditLog } from '@tcpcore1/shared';
import { auditId } from './ids.js';
import type { AuditQueryInput, KernelStore, RecordAuditInput } from './types.js';

/**
 * NIST SP 800-53 AU-3 audit recording.
 *
 * Design rules enforced here:
 *  - Append-only. There is deliberately no update or delete function; the
 *    Prisma model grants none either. Immutability is a property of the API, not
 *    just a convention.
 *  - Never throws into the caller. An audit write failure must not take down a
 *    governed call, but it is reported through `onError` so it is visible.
 *  - Credentials are never written. `targetPayload` is scanned and redacted for
 *    anything that looks like a secret before it is persisted.
 */

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk_live_[A-Za-z0-9]{16,}/g,
  /sk_test_[A-Za-z0-9]{16,}/g,
  /rk_live_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret|refresh[_-]?token)/i;

const REDACTED = '[REDACTED]';

/** Recursively strip secret-shaped values and sensitive keys from a value. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';

  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactForAudit(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactForAudit(child, depth + 1);
    }
    return out;
  }

  return value;
}

export interface AuditorOptions {
  store: KernelStore;
  /** Called when an audit write fails, so hosts can alert without crashing. */
  onError?: (error: unknown, record: AuditLog) => void;
}

export interface AuditExplorerQuery extends AuditQueryInput {
  page?: number;
  limit?: number;
}

export class Auditor {
  private readonly store: KernelStore;
  private readonly onError?: (error: unknown, record: AuditLog) => void;

  constructor(options: AuditorOptions) {
    this.store = options.store;
    this.onError = options.onError;
  }

  /**
   * Build and persist an audit record. Returns the record either way so callers
   * can surface `auditId` to the client.
   */
  async record(input: RecordAuditInput): Promise<AuditLog> {
    const record: AuditLog = {
      id: auditId(),
      actorId: input.actorId,
      actorName: input.actorName,
      actorType: input.actorType,
      targetSystem: input.targetSystem,
      integrationId: input.integrationId ?? null,
      capabilityName: input.capabilityName,
      targetResource: input.targetResource ?? null,
      targetPayload:
        input.targetPayload === undefined ? undefined : redactForAudit(input.targetPayload),
      action: input.action,
      diff: input.diff === undefined ? undefined : redactForAudit(input.diff),
      // `metadata` is redacted too. It carries `error` strings, and an error
      // from a misconfigured target can echo a URL with embedded credentials
      // back into the log. Redacting only `targetPayload`/`diff` left that
      // channel open.
      metadata: {
        ...((input.metadata === undefined ? {} : redactForAudit(input.metadata)) as Record<
          string,
          unknown
        >),
        compliance: input.metadata?.compliance ?? 'NIST SP 800-53 AU-3 / TCPcore governance kernel',
      },
      createdAt: new Date().toISOString(),
    };

    try {
      await this.store.appendAudit(record);
    } catch (error) {
      this.onError?.(error, record);
    }

    return record;
  }

  /** Fire-and-forget variant for paths where latency matters more than ordering. */
  recordDetached(input: RecordAuditInput): void {
    void this.record(input).catch((error) => this.onError?.(error, input as unknown as AuditLog));
  }

  async query(query: AuditExplorerQuery): Promise<{ records: AuditLog[]; total: number }> {
    return this.store.listAudit(query);
  }
}

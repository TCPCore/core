import type {
  ActorType,
  AdapterConfig,
  ApprovalRequest,
  AuditAction,
  AuditLog,
  CapabilityConfig,
  GovernedCallResult,
  Integration,
  IntegrationCredential,
  RiskDecision,
  RiskLevel,
} from '@tcpcore1/shared';

/**
 * The minimal actor shape the kernel needs. Deliberately not the full domain
 * `User`: the kernel must not depend on the ticket manager.
 */
export interface Actor {
  id: string;
  name: string;
  type: ActorType;
  /** Only meaningful for `type === 'AGENT'`. */
  capabilities?: string[];
  /**
   * The actor's own verified bearer token, when the request carried one.
   *
   * Used for `auth.type: jwt` with `source: agent_token`, which passes the
   * caller's identity through to an internal integration rather than minting a
   * shared service token. Never logged: it is a credential.
   */
  bearerToken?: string;
}

/**
 * A tenant identifier.
 *
 * Branded on purpose: a `TenantId` is not interchangeable with `string`, so a raw
 * string cannot be passed by accident. A caller converts at the boundary, which is
 * the right place to validate what the value actually is.
 *
 * The kernel is tenant-aware, not tenant-specific. A single-tenant self-hosted
 * deployment passes {@link SINGLE_TENANT} and behaves exactly as it did before
 * tenancy existed.
 */
export type TenantId = string & { readonly __brand: 'TenantId' };

/**
 * The tenant a single-tenant self-hosted deployment operates as.
 *
 * Exported from the public surface rather than kept internal: it is part of the
 * contract, and a single-tenant user needs it to call the store at all.
 */
export const SINGLE_TENANT = '__single__' as TenantId;

/** Convert a validated string into a `TenantId`. The one sanctioned cast. */
export function asTenantId(value: string): TenantId {
  if (value.length === 0) {
    throw new Error('asTenantId requires a non-empty tenant id');
  }
  return value as TenantId;
}

/**
 * Persistence boundary.
 *
 * The kernel never talks to a database driver directly. A host injects a
 * Postgres-backed store in production and the in-memory store when there is no
 * database, which is what makes the kernel testable and self-hostable.
 *
 * ## A store is bound to one tenant for its lifetime
 *
 * These signatures take no tenant. The tenant is bound **once**, when the store is
 * obtained from a {@link KernelStoreFactory}, and every call on that store
 * inherits it.
 *
 * That is a deliberate choice over passing a tenant to each method, and the
 * difference is not cosmetic:
 *
 *   - **One decision, not sixteen.** A request that acquires tenant A's store and
 *     then makes sixteen calls has decided which tenant it is acting for exactly
 *     once. Threading a parameter through those calls is sixteen decisions, and
 *     only the first is auditable.
 *   - **Cross-tenant reads-then-writes become unrepresentable.** A request holding
 *     one store cannot read tenant A and write tenant B. Threading a parameter
 *     permits exactly that mistake.
 *   - **Isolation is structural.** The bound tenant is a private field of the
 *     store. There is no ambient state to forget to set and no parameter a caller
 *     can omit, so a query that is missing its tenant predicate cannot be written
 *     at all.
 */
export interface KernelStore {
  saveIntegration(integration: Integration): Promise<void>;
  deleteIntegration(name: string): Promise<void>;
  listIntegrations(): Promise<Integration[]>;

  saveCapabilities(integration: Integration, capabilities: KernelCapabilityRecord[]): Promise<void>;
  listCapabilities(filter?: {
    risk?: RiskLevel;
    integrationName?: string;
  }): Promise<KernelCapabilityRecord[]>;

  saveCredential(credential: StoredCredential): Promise<void>;
  getCredential(integrationName: string): Promise<StoredCredential | undefined>;
  deleteCredential(integrationName: string): Promise<void>;

  appendAudit(record: AuditLog): Promise<void>;
  listAudit(query: AuditQueryInput): Promise<{ records: AuditLog[]; total: number }>;

  saveApproval(approval: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  listApprovals(status?: string): Promise<ApprovalRequest[]>;

  saveAgentRun(run: KernelAgentRun): Promise<void>;
  listAgentRuns(limit?: number): Promise<KernelAgentRun[]>;
}

/**
 * Where a tenant-bound store comes from.
 *
 * This is the **one** place a tenant is bound. Every object downstream (the
 * registry, the auditor, the approval queue, the token broker) receives a
 * {@link KernelStore} and inherits its tenant without holding one itself. Nothing
 * in the kernel keeps a tenant as a field, so there is no second copy to disagree
 * with the first.
 *
 * ## `SINGLE_TENANT` is a factory input, never a method default
 *
 * `forTenant` requires an argument, so there is no default to fall through to. A
 * single-tenant deployment constructs its factory knowing that is what it is; a
 * multi-tenant deployment's factory can refuse `SINGLE_TENANT` outright, which
 * makes accidental single-tenant operation in a multi-tenant system impossible
 * rather than merely discouraged.
 *
 * ## Why a parameter rather than ambient context
 *
 * An earlier shape read the tenant from ambient async context. That fails on the
 * hot path beneath every governed call three ways: it interleaves under
 * concurrency, it is invisible coupling (the store cannot be called from a worker
 * or a CLI without a context provider), and it fails silently, because an unset
 * tenant makes a `WHERE tenant_id = ...` predicate match nothing, so the caller
 * sees an empty result rather than an error.
 */
export interface KernelStoreFactory {
  forTenant(tenantId: TenantId): KernelStore;
}

/**
 * A capability as the kernel indexes it, with the owning integration flattened
 * in so hot paths do not need a second lookup.
 */
export interface KernelCapabilityRecord {
  id: string;
  integrationId: string;
  integrationName: string;
  name: string;
  fullName: string;
  description: string;
  method: CapabilityConfig['method'];
  pathTemplate: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  agentForbidden: boolean;
  contentRisk: RiskLevel | null;
  deprecated: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string;
}

/** Decrypted credential material. Never persisted in this shape. */
export interface StoredCredential {
  integrationId: string;
  integrationName: string;
  authType: AdapterConfig['auth']['type'];
  /** AES-256-GCM ciphertext, base64. */
  encryptedBlob: string;
  refreshTokenEnc: string | null;
  expiresAt: string | null;
  scopes: string[] | null;
  updatedAt: string;
}

export interface AuditQueryInput {
  actorType?: ActorType;
  targetSystem?: string;
  capabilityName?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface KernelAgentRun {
  id: string;
  agentId: string;
  agentName: string;
  trigger: string;
  status: 'SUCCESS' | 'FAILED' | 'STOPPED';
  steps: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  costUsd: number;
  spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    durationMs: number;
    status: 'OK' | 'ERROR';
  }>;
  reasoningLogs: string[];
  createdAt: string;
}

export interface RecordAuditInput {
  actorId: string | null;
  actorName: string;
  actorType: ActorType;
  targetSystem: string;
  integrationId?: string | null;
  capabilityName: string;
  targetResource?: string | null;
  targetPayload?: unknown;
  action: AuditAction;
  diff?: unknown;
  metadata?: AuditLog['metadata'];
}

/**
 * The audit write surface the rest of the kernel depends on.
 *
 * Declared as an interface (rather than depending on the concrete `Auditor`
 * class) so the risk gate, the proxy and the approval queue can be unit-tested
 * with a stub and none of them can reach the audit store directly.
 */
export interface AuditSink {
  record(input: RecordAuditInput): Promise<AuditLog>;
}

export interface GovernedCallInput {
  integration: Integration;
  capability: KernelCapabilityRecord;
  args: Record<string, unknown>;
  actor: Actor;
  /** Correlates kernel activity with the inbound HTTP request. */
  requestId?: string;
  /**
   * Set when the call is being executed as the result of an approval, so the
   * audit trail can link execution back to the approval decision.
   */
  approvalId?: string;
}

export interface EvaluateRiskInput {
  capability: KernelCapabilityRecord;
  actor: Actor;
  requestId?: string;
}

/** Extra knobs apps can set; all have safe defaults. */
export interface KernelConfig {
  store: KernelStore;
  /** AES-256-GCM key material, as a 32-byte buffer. Required for credential storage. */
  encryptionKey?: Buffer;
  /**
   * Hostname allowlist for outbound calls. Empty means "no restriction" and is
   * only acceptable in development. Demo mode always populates this.
   */
  outboundHostAllowlist?: string[];
  /** Reject any outbound call whose URL is not https (except loopback). */
  requireHttps?: boolean;
  /** Per-request timeout for outbound governed calls. */
  callTimeoutMs?: number;
  /** Maximum response body size accepted from a governed call. */
  maxResponseBytes?: number;
  /**
   * Scan *every* response for prompt-injection content, not only capabilities
   * marked `content_risk`. Useful for a hardened or public deployment; the
   * per-capability flag remains the precise control.
   */
  sanitizeAllResponses?: boolean;
  /**
   * Injected `fetch`, for tests and for hosts that need to intercept governed
   * calls (e.g. to serve the internal reference adapter in-process rather than
   * over a loopback socket). Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Feature flag mirroring AGENTS_ENABLED. */
  agentsEnabled?: boolean;
}

export type {
  GovernedCallResult,
  RiskDecision,
  Integration,
  IntegrationCredential,
  ApprovalRequest,
};

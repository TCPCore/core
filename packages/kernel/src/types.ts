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
 * Persistence boundary.
 *
 * The kernel never talks to Prisma directly. `apps/api` injects a Prisma-backed
 * store; the CLI injects the in-memory store so `tcpctl serve` runs with no
 * database at all. This is what makes the kernel testable and self-hostable.
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

/**
 * Shared constant tables for TCPcore.
 *
 * These are the single source of truth for enum-like values. Zod schemas in
 * `./schemas/*` derive their `z.enum(...)` members from these arrays so the
 * runtime validators and the TypeScript types can never drift apart.
 */

/** Human/agent roles. `VIEWER` is read-only. */
export const ROLES = ['ADMIN', 'AGENT', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

/** Discriminates an actor as a person or an autonomous agent. */
export const ACTOR_TYPES = ['HUMAN', 'AGENT'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The three-tier governance risk model. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Numeric ordering for risk comparisons (filtering by `minRisk`/`maxRisk`,
 * escalation of conditional rules). Never compare risk levels as strings.
 */
export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Lifecycle of a human-in-the-loop approval request. */
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Authentication strategies an adapter may declare. */
export const AUTH_TYPES = ['bearer', 'oauth2', 'api_key', 'jwt', 'none'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** Where a `jwt` integration sources its token from. */
export const AUTH_SOURCES = ['agent_token', 'credential_store'] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

/** Adapter methods the kernel and generator both understand. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Generator input formats. */
export const SPEC_FORMATS = ['auto', 'openapi', 'swagger', 'postman', 'har'] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

/** Domain ticket lifecycle. */
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Domain ticket priority (ascending urgency). */
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Domain client lifecycle. */
export const CLIENT_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * Canonical audit actions.
 *
 * The Prisma column is a plain string so it can carry these plus future
 * values without a migration, but these are the values the kernel emits.
 */
export const AUDIT_ACTIONS = [
  'EXECUTE',
  'PROPOSE',
  'APPROVE',
  'REJECT',
  'DENY',
  'FAIL',
  'CREATE',
  'UPDATE',
  'DELETE',
  'CALL',
  'REGISTER',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Status of a single governed call, as returned to the caller. */
export const GOVERNED_CALL_STATUSES = ['executed', 'pending_approval', 'denied', 'failed'] as const;
export type GovernedCallStatus = (typeof GOVERNED_CALL_STATUSES)[number];

/** Agent run outcome. */
export const AGENT_RUN_STATUSES = ['SUCCESS', 'FAILED', 'STOPPED'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * Header names the kernel uses to propagate actor identity to internal
 * integrations. Cleanup of inbound copies of these headers is mandatory —
 * see `packages/kernel/src/proxy.ts` (header spoofing defence).
 */
export const ACTOR_ID_HEADER = 'x-tcpcore-actor-id';
export const ACTOR_TYPE_HEADER = 'x-tcpcore-actor-type';
export const ON_BEHALF_OF_HEADER = 'x-tcpcore-on-behalf-of';
export const CORRELATION_ID_HEADER = 'x-request-id';

/** Manifest protocol version advertised on the MCP surface. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Minimum viable secret length for JWT HMAC keys. */
export const MIN_SECRET_LENGTH = 32;

/** Risk levels a human may execute but an agent may never. */
export const AGENT_HARD_BLOCK_RISK: RiskLevel = 'high';

/** Default page size for paginated list endpoints. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

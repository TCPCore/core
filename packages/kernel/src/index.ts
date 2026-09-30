/**
 * @tcpcore1/kernel — the TCPcore governance kernel (MIT).
 *
 * Domain-agnostic by construction: it knows about Integrations, Capabilities,
 * Actors and Audit records, and nothing about tickets, clients or comments. The
 * ticket manager in `apps/api` is its first client, not its host.
 */

export * from './types.js';

export { Kernel, type GatewayOptions, type InvokeResult } from './kernel.js';
export { Registry, parseAdapterYaml, AdapterLoadError, capabilityId } from './registry.js';
export { Auditor, redactForAudit, type AuditExplorerQuery, type AuditorOptions } from './audit.js';
export { ApprovalQueue, extractResource, type EnqueueApprovalInput } from './approvals.js';
export {
  RiskGate,
  capabilityGranted,
  type RiskDecision,
  type EvaluateRiskInput,
} from './risk-gate.js';
export { GovernedProxy, type GovernedProxyInput, type AuthHeaderProvider } from './proxy.js';
export { TokenBroker, CredentialError, type AuthHeaderResult } from './token-broker.js';
export {
  encryptSecret,
  decryptSecret,
  maskSecret,
  fingerprintSecret,
  normalizeKey,
  generateKeyHex,
  safeEqual,
  KEY_LENGTH,
  CredentialCryptoError,
} from './crypto.js';
export {
  buildMcpTools,
  buildMcpServerInfo,
  formatMcpManifest,
  type McpSurfaceOptions,
} from './mcp-surface.js';
export {
  sanitizePayload,
  wrapUntrusted,
  type SanitizeResult,
  type InjectionSignal,
} from './sanitize.js';
export {
  buildPath,
  buildUrl,
  assertOutboundAllowed,
  redactHeaders,
  isLoopbackHost,
  OutboundRequestError,
  type OutboundGuardOptions,
} from './ssrf-guard.js';
export {
  validateAgainstSchema,
  formatIssues,
  type ValidationIssue,
  type ValidateOptions,
} from './schema-validate.js';
export { MemoryStore } from './stores/memory.js';
export { newId, requestId, auditId } from './ids.js';

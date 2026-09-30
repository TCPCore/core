import { z } from 'zod';
import { AUTH_TYPES } from '../constants.js';
import { CapabilityNameSchema, IntegrationNameSchema, RiskLevelSchema } from './adapter.js';

/** A registered integration = one loaded adapter plus its persisted identity. */
export const IntegrationSchema = z.object({
  id: z.string(),
  name: IntegrationNameSchema,
  displayName: z.string(),
  baseUrl: z.string(),
  authType: z.enum(AUTH_TYPES),
  configYaml: z.string(),
  enabled: z.boolean().default(true),
  isBuiltin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A capability as persisted/indexed, with its owning integration resolved. */
export const CapabilityRecordSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  integrationName: IntegrationNameSchema,
  name: CapabilityNameSchema,
  /** `integration.capability` — the identifier agents and MCP clients use. */
  fullName: z.string(),
  description: z.string(),
  method: z.string(),
  pathTemplate: z.string(),
  riskLevel: RiskLevelSchema,
  approvalRequired: z.boolean(),
  agentForbidden: z.boolean(),
  contentRisk: RiskLevelSchema.nullable().optional(),
  deprecated: z.boolean().default(false),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

/** Credential material status. The plaintext secret never leaves the broker. */
export const IntegrationCredentialSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  authType: z.enum(AUTH_TYPES),
  maskedSecret: z.string(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'NEEDS_REAUTHORIZATION', 'MISSING']),
  lastRotatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  scopes: z.array(z.string()).optional(),
});

export const RegisterIntegrationSchema = z.object({
  yaml: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const SetCredentialSchema = z.object({
  /** Plaintext secret (API key / bearer token). Stored AES-256-GCM encrypted. */
  secret: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192).optional(),
  tokenEndpoint: z.string().url().optional(),
  clientId: z.string().max(512).optional(),
  clientSecret: z.string().max(512).optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
});

export const ToggleSchema = z.object({
  enabled: z.boolean().optional(),
});

/** The single result shape returned by `governedCall`. */
export const GovernedCallResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('executed'),
    data: z.unknown(),
    auditId: z.string(),
    latencyMs: z.number(),
    httpStatus: z.number(),
    sanitized: z.boolean().default(false),
    injectionSignals: z.array(z.string()).default([]),
  }),
  z.object({
    status: z.literal('pending_approval'),
    approvalId: z.string(),
    auditId: z.string(),
    riskLevel: RiskLevelSchema,
  }),
  z.object({ status: z.literal('denied'), reason: z.string(), auditId: z.string() }),
  z.object({ status: z.literal('failed'), error: z.string(), auditId: z.string() }),
]);

/**
 * Discriminated decision from the risk gate. Kept separate from the execution
 * result so it can be unit-tested and audited without performing I/O.
 */
export const RiskDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), reason: z.string() }),
  z.object({ decision: z.literal('approval'), reason: z.string(), riskLevel: RiskLevelSchema }),
  z.object({ decision: z.literal('deny'), reason: z.string(), riskLevel: RiskLevelSchema }),
]);

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  integration: z.string(),
  capability: z.string(),
  riskLevel: RiskLevelSchema,
});

export const InvokeCapabilitySchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});

export const McpToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const McpJsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type Integration = z.output<typeof IntegrationSchema>;
export type CapabilityRecord = z.output<typeof CapabilityRecordSchema>;
export type IntegrationCredential = z.output<typeof IntegrationCredentialSchema>;
export type RegisterIntegrationInput = z.output<typeof RegisterIntegrationSchema>;
export type SetCredentialInput = z.output<typeof SetCredentialSchema>;
export type GovernedCallResult = z.output<typeof GovernedCallResultSchema>;
export type RiskDecision = z.output<typeof RiskDecisionSchema>;
export type McpTool = z.output<typeof McpToolSchema>;
export type McpJsonRpcRequest = z.output<typeof McpJsonRpcRequestSchema>;
export type { RiskLevel } from '../constants.js';

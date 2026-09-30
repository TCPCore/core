import { z } from 'zod';
import { AUDIT_ACTIONS } from '../constants.js';
import { ActorTypeSchema } from './user.js';

// `ActorTypeSchema` is owned by `./user.ts` and re-exported here for the audit
// shape's convenience only via import, never as a second definition.
export { ActorTypeSchema };
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);

/**
 * NIST SP 800-53 AU-3 audit record.
 *
 * AU-3 requires: what type of event occurred, when, where, source, outcome,
 * and the identity of any entities involved. The column set below maps onto
 * those requirements and is deliberately domain-agnostic — nothing named after
 * a ticket, client or comment is allowed to be a first-class column. Such
 * detail belongs in `diff` / `metadata`.
 */
export const AuditLogSchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string(),
  actorType: ActorTypeSchema,
  /** Which integration the action targeted: "internal", "salesforce", ... */
  targetSystem: z.string(),
  integrationId: z.string().nullable().optional(),
  capabilityName: z.string(),
  /** "ticket:abc123" | "opportunity:006..." | "charge:ch_..." */
  targetResource: z.string().nullable().optional(),
  targetPayload: z.unknown().optional(),
  action: AuditActionSchema,
  diff: z.unknown().optional(),
  metadata: z
    .object({
      model: z.string().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      latencyMs: z.number().optional(),
      approvalId: z.string().optional(),
      httpStatus: z.number().optional(),
      riskLevel: z.string().optional(),
      /** allow | approval | deny — the kernel's own decision, recorded for audit replay. */
      riskDecision: z.string().optional(),
      /** True when the response was rewritten by the prompt-injection sanitiser. */
      sanitized: z.boolean().optional(),
      injectionSignals: z.array(z.string()).optional(),
      ip: z.string().optional(),
      requestId: z.string().optional(),
      compliance: z.string().optional(),
      error: z.string().optional(),
    })
    .catchall(z.unknown())
    .optional(),
  createdAt: z.string(),
});

export const AuditQuerySchema = z.object({
  actorType: ActorTypeSchema.optional(),
  targetSystem: z.string().optional(),
  capabilityName: z.string().optional(),
  action: AuditActionSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export type AuditLog = z.output<typeof AuditLogSchema>;
export type AuditQuery = z.output<typeof AuditQuerySchema>;

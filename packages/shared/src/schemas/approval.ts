import { z } from 'zod';
import { APPROVAL_STATUSES, RISK_LEVELS } from '../constants.js';

export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export const ApprovalRiskSchema = z.enum(RISK_LEVELS).exclude(['low']);

/**
 * A proposed (not yet executed) medium/high-risk action.
 *
 * `targetPayload` is the exact argument object the agent proposed. On approval
 * the reviewer's identity — not the agent's — is used for the governed call,
 * which is what makes "medium risk requires a human" meaningful.
 */
export const ApprovalRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  integrationId: z.string().nullable(),
  targetSystem: z.string(),
  capabilityName: z.string(),
  targetPayload: z.unknown(),
  riskLevel: ApprovalRiskSchema,
  status: ApprovalStatusSchema.default('PENDING'),
  reviewedById: z.string().nullable(),
  reviewedByName: z.string().nullable().optional(),
  reviewedAt: z.string().nullable(),
  /** Populated when an approved execution fails. */
  executionError: z.string().nullable().optional(),
  createdAt: z.string(),
});

export const RejectSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export type ApprovalRequest = z.output<typeof ApprovalRequestSchema>;

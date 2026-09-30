import { z } from 'zod';
import { AGENT_RUN_STATUSES, CLIENT_STATUSES, PRIORITIES, TICKET_STATUSES } from '../constants.js';
import { RiskLevelSchema } from './adapter.js';

export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export const PrioritySchema = z.enum(PRIORITIES);
export const ClientStatusSchema = z.enum(CLIENT_STATUSES);

export const ClientSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  status: ClientStatusSchema.default('ACTIVE'),
  ownerId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});

export const CreateClientSchema = z.object({
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  ownerId: z.string().nullable().optional(),
});

export const UpdateClientSchema = CreateClientSchema.partial().extend({
  status: ClientStatusSchema.optional(),
});

export const TicketSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20000),
  status: TicketStatusSchema.default('OPEN'),
  priority: PrioritySchema.default('MEDIUM'),
  assigneeId: z.string().nullable(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
});

export const CreateTicketSchema = z.object({
  clientId: z.string().min(1),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20000),
  priority: PrioritySchema.optional(),
  assigneeId: z.string().nullable().optional(),
});

export const UpdateTicketSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().min(1).max(20000).optional(),
    status: TicketStatusSchema.optional(),
    priority: PrioritySchema.optional(),
    assigneeId: z.string().nullable().optional(),
  })
  .strict();

export const CommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorType: z.enum(['HUMAN', 'AGENT']),
  body: z.string().min(1).max(20000),
  isInternal: z.boolean().default(false),
  isDraft: z.boolean().default(false),
  createdAt: z.string(),
});

export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(20000),
  isInternal: z.boolean().default(false),
});

export const AgentRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  trigger: z.string(),
  status: z.enum(AGENT_RUN_STATUSES),
  steps: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string(),
  costUsd: z.number().nonnegative(),
  spans: z
    .array(
      z.object({
        name: z.string(),
        attributes: z.record(z.string(), z.unknown()).default({}),
        durationMs: z.number().nonnegative(),
        status: z.enum(['OK', 'ERROR']).default('OK'),
      }),
    )
    .default([]),
  reasoningLogs: z.array(z.string()).default([]),
  createdAt: z.string(),
});

export const SystemStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  agentsEnabled: z.boolean(),
  demoMode: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number(),
  integrations: z.number().int(),
  capabilities: z.number().int(),
  mcpTools: z.number().int(),
  pendingApprovals: z.number().int(),
  auditRecords: z.number().int(),
  activeAgents: z.number().int(),
});

export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().max(200).optional(),
  includeDeleted: z.coerce.boolean().default(false),
});

export const DomainStatsSchema = z.object({
  ticketsByStatus: z.record(z.string(), z.number()),
  ticketsByPriority: z.record(z.string(), z.number()),
  clientsTotal: z.number(),
  approvalsPending: z.number(),
  agentRuns24h: z.number(),
  governedCalls24h: z.number(),
  denied24h: z.number(),
});

export const RiskBreakdownSchema = z.object({
  low: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
});

export const RiskLevelSchemaExport = RiskLevelSchema;

export type Client = z.output<typeof ClientSchema>;
export type Ticket = z.output<typeof TicketSchema>;
export type Comment = z.output<typeof CommentSchema>;
export type AgentRun = z.output<typeof AgentRunSchema>;
export type SystemStatus = z.output<typeof SystemStatusSchema>;
export type Pagination = z.output<typeof PaginationSchema>;
export type DomainStats = z.output<typeof DomainStatsSchema>;
export type RiskBreakdown = z.output<typeof RiskBreakdownSchema>;
export type CreateTicketInput = z.output<typeof CreateTicketSchema>;
export type UpdateTicketInput = z.output<typeof UpdateTicketSchema>;
export type CreateClientInput = z.output<typeof CreateClientSchema>;
export type UpdateClientInput = z.output<typeof UpdateClientSchema>;

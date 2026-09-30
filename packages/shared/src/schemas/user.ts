import { z } from 'zod';
import { ACTOR_TYPES, ROLES } from '../constants.js';

// `ActorType` itself is declared in `./constants.ts` and re-exported from there;
// only the Zod validator is defined here to avoid two exports of the same name.
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export const RoleSchema = z.enum(ROLES);

export const EmailSchema = z.string().email().max(320);
export const UserSchema = z.object({
  id: z.string(),
  email: EmailSchema,
  name: z.string().min(1).max(200),
  role: RoleSchema.default('VIEWER'),
  type: ActorTypeSchema.default('HUMAN'),
  avatar: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PublicUserSchema = UserSchema.omit({}).extend({
  /** Never expose the hash; the API strips it rather than trusting callers. */
  passwordHash: z.never().optional(),
});

export type User = z.output<typeof UserSchema>;
export type PublicUser = z.output<typeof PublicUserSchema>;

export const RegisterSchema = z.object({
  email: EmailSchema,
  name: z.string().min(1).max(200),
  password: z.string().min(8, 'password must be at least 8 characters').max(200),
});

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

/** Agents are users with `type: AGENT` plus an `AgentConfig` row. */
export const AgentConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  /** Qualified capability names granted to this agent, e.g. `internal.set_priority`. */
  capabilities: z.array(z.string()),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AgentConfigUpdateSchema = z
  .object({
    model: z.string().min(1).optional(),
    systemPrompt: z.string().min(1).optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type AgentConfigUpdate = z.output<typeof AgentConfigUpdateSchema>;

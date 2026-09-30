import { z } from 'zod';
import { AUTH_SOURCES, AUTH_TYPES, HTTP_METHODS, RISK_LEVELS, SPEC_FORMATS } from '../constants.js';

/**
 * A capability name becomes part of a tool name an LLM must call and part of a
 * URL path segment. Restrict it to a lowercase snake_case identifier so it is
 * safe in both positions without escaping.
 */
export const CapabilityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'capability name must be lowercase snake_case ([a-z][a-z0-9_]*)');

/** Integration names are also used as URL segments and audit `targetSystem`. */
export const IntegrationNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'integration name must be a lowercase slug ([a-z][a-z0-9_-]*)');

export const RiskLevelSchema = z.enum(RISK_LEVELS);
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export const SpecFormatSchema = z.enum(SPEC_FORMATS);

/**
 * JSON Schema (subset) for a `.tcp-adapter.yaml` capability `input` block.
 *
 * Adapters may hand-write a loose JSON-Schema-ish object, so this is
 * intentionally permissive: `type` accepts either a single type name or a
 * union (JSON Schema allows both), and unknown keys are preserved so vendor
 * extensions survive a round-trip through the loader.
 */
export const JsonSchemaTypeSchema = z.union([
  z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']),
  z.array(z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])),
]);

export const JsonSchemaSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      type: JsonSchemaTypeSchema.optional(),
      description: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
      default: z.unknown().optional(),
      format: z.string().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      items: JsonSchemaSchema.optional(),
      properties: z.record(z.string(), JsonSchemaSchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.union([z.boolean(), JsonSchemaSchema]).optional(),
      oneOf: z.array(JsonSchemaSchema).optional(),
      anyOf: z.array(JsonSchemaSchema).optional(),
      allOf: z.array(JsonSchemaSchema).optional(),
      nullable: z.boolean().optional(),
    })
    .catchall(z.unknown()),
);

/**
 * A single declared capability — the unit of governance.
 *
 * `risk`, `approval_required` and `agent_forbidden` are the policy inputs the
 * risk gate reads. `content_risk` marks capabilities whose responses carry
 * untrusted free text (CRM notes, ticket bodies, email bodies) so the kernel
 * knows to prompt-injection-scan the payload before it reaches an LLM.
 */
export const CapabilitySchema = z
  .object({
    name: CapabilityNameSchema,
    method: HttpMethodSchema,
    path: z.string().min(1).startsWith('/', 'capability path must start with "/"'),
    description: z.string().min(1).max(2000),
    risk: RiskLevelSchema,
    approval_required: z.boolean().default(false),
    agent_forbidden: z.boolean().default(false),
    /**
     * Marks responses as untrusted free text. Set by `content-analyzer` during
     * generation and by hand for known chatty endpoints.
     */
    content_risk: RiskLevelSchema.optional(),
    /** Set by the merge algorithm when a capability disappears from the source spec. */
    deprecated: z.boolean().default(false),
    input: JsonSchemaSchema.default({}),
    output: JsonSchemaSchema.optional(),
    /** Included when the capability targets a sub-host or absolute URL. */
    base_url: z.string().optional(),
  })
  .strict();

export const AuthConfigSchema = z
  .object({
    type: z.enum(AUTH_TYPES),
    /** Header to carry the credential. Defaults per auth type when omitted. */
    header: z.string().optional(),
    /** Prefix before the credential value, e.g. `Bearer`. */
    prefix: z.string().optional(),
    token_endpoint: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
    source: z.enum(AUTH_SOURCES).default('credential_store'),
  })
  .strict()
  .superRefine((auth, ctx) => {
    if (auth.type === 'oauth2' && !auth.token_endpoint) {
      ctx.addIssue({
        code: 'custom',
        path: ['token_endpoint'],
        message: 'auth.token_endpoint is required when auth.type is "oauth2"',
      });
    }
  });

/**
 * The `.tcp-adapter.yaml` document. This is the product's public contract —
 * everything else (generator, CLI validator, kernel loader, docs) is derived
 * from this schema.
 */
export const AdapterSchema = z
  .object({
    name: IntegrationNameSchema,
    display_name: z.string().min(1),
    base_url: z.string().url('base_url must be an absolute URL'),
    auth: AuthConfigSchema,
    capabilities: z
      .array(CapabilitySchema)
      .min(1, 'an adapter must declare at least one capability'),
    /** Free-form metadata preserved on round-trip. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((adapter, ctx) => {
    const seen = new Map<string, number>();
    adapter.capabilities.forEach((cap, index) => {
      const first = seen.get(cap.name);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'name'],
          message: `duplicate capability name "${cap.name}" (first declared at index ${first})`,
        });
      } else {
        seen.set(cap.name, index);
      }
    });
  });

/** A capability name qualified by its integration: `salesforce.get_opportunity`. */
export const QualifiedCapabilityNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/,
    'expected "<integration>.<capability>" (e.g. salesforce.get_opportunity)',
  );

export type CapabilityInput = z.input<typeof CapabilitySchema>;
export type CapabilityConfig = z.output<typeof CapabilitySchema>;
export type AuthConfig = z.output<typeof AuthConfigSchema>;
export type AdapterInput = z.input<typeof AdapterSchema>;
export type AdapterConfig = z.output<typeof AdapterSchema>;
export type JsonSchema = Record<string, unknown>;

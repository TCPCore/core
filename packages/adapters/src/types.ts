import type {
  AdapterConfig,
  HttpMethod,
  JsonSchema,
  RiskBreakdown,
  RiskLevel,
  SpecFormat,
} from '@tcpcore1/shared';

/** A parameter as extracted from a spec, normalised across formats. */
export interface NormalizedParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: JsonSchema;
  description?: string;
}

/**
 * A single API operation, normalised away from its source format. Everything
 * downstream (risk inference, schema mapping, emission) works only on this
 * shape, which is what lets OpenAPI, Swagger 2.0, Postman and HAR share one
 * pipeline.
 */
export interface NormalizedOperation {
  /** Stable capability name candidate, derived from operationId or method+path. */
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: NormalizedParameter[];
  requestBody?: JsonSchema;
  responses: Record<string, JsonSchema>;
  /** Set when the source declared this operation as deprecated. */
  deprecated?: boolean;
  /** True when the operation has no security requirement (public endpoint). */
  anonymous?: boolean;
}

export interface NormalizedSpec {
  source: string;
  format: SpecFormat;
  title: string;
  version: string;
  description?: string;
  baseUrl: string;
  operations: NormalizedOperation[];
  /** Non-fatal problems worth surfacing to the user. */
  warnings: string[];
}

export interface RiskDecision {
  level: RiskLevel;
  approvalRequired: boolean;
  agentForbidden: boolean;
  /** Human-readable rationale, emitted as YAML comments. */
  reason: string;
  /** Stable rule ids that fired, e.g. `HTTP_METHOD_DELETE`. */
  rulesTriggered: string[];
  /**
   * Suggested conditional-risk expression when the input schema carries a
   * numeric amount-like field, e.g. `amount > 1000 => high`.
   */
  conditionalHint?: string;
}

export interface ContentRiskDecision {
  level: RiskLevel | undefined;
  reason: string;
}

export interface GeneratedCapability {
  name: string;
  description: string;
  method: HttpMethod;
  pathTemplate: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  agentForbidden: boolean;
  contentRisk?: RiskLevel;
  deprecated: boolean;
  /** JSON Schema object for the capability input. */
  input: JsonSchema;
  output?: JsonSchema;
  tags: string[];
  notes: string[];
}

export interface GeneratedAdapter {
  name: string;
  displayName: string;
  baseUrl: string;
  authType: AdapterConfig['auth']['type'];
  authHeader?: string;
  authPrefix?: string;
  tokenEndpoint?: string;
  scopes?: string[];
  capabilities: GeneratedCapability[];
  warnings: string[];
}

export interface GenerateOptions {
  from?: SpecFormat;
  baseUrl?: string;
  authType?: AdapterConfig['auth']['type'];
  minRisk?: RiskLevel;
  maxRisk?: RiskLevel;
  includeTags?: string[];
  excludeTags?: string[];
  /** Regenerate against an existing adapter, preserving human risk overrides. */
  merge?: AdapterConfig;
  /** Cap on the number of capabilities emitted (safety valve for huge specs). */
  limit?: number;
  /** Timeout for remote spec fetches, ms. */
  timeoutMs?: number;
  /** Allow plaintext http spec URLs (off by default). */
  allowInsecureSpecUrl?: boolean;
  /**
   * Override the source string recorded in the generated header and warnings.
   *
   * Needed when the caller has already read the file: the generator would
   * otherwise see only the document text and report it as `<inline>`, losing the
   * provenance that makes a generated adapter traceable.
   */
  sourceLabel?: string;
}

export interface MergeDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
  /** Capabilities whose human-assigned risk fields were preserved. */
  preserved: string[];
}

export interface GenerateResult {
  yaml: string;
  adapter: GeneratedAdapter;
  capabilityCount: number;
  riskBreakdown: RiskBreakdown;
  diff?: MergeDiff;
  warnings: string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; adapter: AdapterConfig; warnings: string[] }
  | { ok: false; errors: ValidationIssue[]; warnings: string[] };

export interface LoadOptions {
  source?: string;
}

export type { RiskBreakdown, RiskLevel, SpecFormat, AdapterConfig, JsonSchema };

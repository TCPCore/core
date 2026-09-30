/**
 * @tcpcore1/adapters — the `.tcp-adapter.yaml` format.
 *
 * Public API, in the order downstream packages depend on it:
 *
 *   loadAdapter / validateAdapter  — the format contract (used by the kernel
 *                                    CLI and by CI to gate community PRs)
 *   generateAdapter                — OpenAPI/Swagger/Postman/HAR → adapter YAML
 *   listBuiltinAdapters / loadBuiltinAdapters — the first-party adapter set
 *
 * `AdapterSchema` in `@tcpcore1/shared` is the single source of truth for validity;
 * nothing here re-implements it.
 */

export {
  loadAdapter,
  loadFromString,
  validateAdapter,
  hasAgentReachableCapabilities,
} from './validator.js';

export {
  findAdaptersRoot,
  listBuiltinAdapters,
  listCommunityAdapters,
  loadAdapterFile,
  loadBuiltinAdapters,
  loadCommunityAdapters,
  type BuiltinAdapterFile,
} from './loader.js';

export {
  generateAdapter,
  toAdapterConfig,
  validateEmittedYaml,
  type GenerateOptions,
  type GenerateResult,
  type GeneratedAdapter,
  type GeneratedCapability,
  type MergeDiff,
} from './generator/index.js';

export {
  parseSpec,
  parseSpecText,
  loadSpecText,
  detectFormat,
  SpecParseError,
} from './generator/parser.js';

export {
  extractCapabilities,
  slugify,
  toCapabilityName,
  uniqueName,
} from './generator/extractor.js';

export { inferRisk, findAmountField, RISK_RULES } from './generator/risk-analyzer.js';

export { analyzeContentRisk } from './generator/content-analyzer.js';

export {
  cleanSchema,
  toInputSchema,
  toOutputSchema,
  AUTH_HEADER_NAMES,
} from './generator/schema-mapper.js';

export { emitYaml, emitTemplate, groupByTag, type EmitMeta } from './generator/emitter.js';

export { mergeAdapters, type MergeOutcome } from './generator/merge.js';

export { sanitizeAdapter, redactString, type SanitizeReport } from './generator/sanitizer.js';

export { SAMPLE_SPECS, getSampleSpec, type SampleSpec } from './generator/sample-specs.js';

export type {
  NormalizedOperation,
  NormalizedParameter,
  NormalizedSpec,
  RiskDecision,
  ContentRiskDecision,
  ValidationIssue,
  ValidationResult,
  LoadOptions,
  RiskBreakdown,
  RiskLevel,
  SpecFormat,
  AdapterConfig,
  JsonSchema,
} from './types.js';

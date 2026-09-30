import {
  AdapterSchema,
  RISK_ORDER,
  type CapabilityConfig,
  type RiskBreakdown,
} from '@tcpcore1/shared';
import { parse as parseYaml } from 'yaml';
import { extractCapabilities, slugify } from './extractor.js';
import { emitYaml } from './emitter.js';
import { mergeAdapters } from './merge.js';
import { parseSpec } from './parser.js';
import { sanitizeAdapter } from './sanitizer.js';
import type { GenerateOptions, GenerateResult, GeneratedAdapter } from '../types.js';

export type {
  GenerateOptions,
  GenerateResult,
  GeneratedAdapter,
  GeneratedCapability,
  MergeDiff,
} from '../types.js';

const DEFAULT_LIMIT = 300;

/**
 * `generateAdapter` — the product-defining function.
 *
 * Pipeline: parse → extract → filter → merge → sanitize → emit → self-validate.
 *
 * The final self-validation step is deliberate. It means the generator can never
 * hand back YAML that the kernel would reject at load time; if the pipeline has
 * a bug, the failure surfaces here, in the tool the developer is already
 * running, rather than in production.
 */
export async function generateAdapter(
  input: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const spec = await parseSpec(input, {
    from: options.from ?? 'auto',
    timeoutMs: options.timeoutMs,
    allowInsecureSpecUrl: options.allowInsecureSpecUrl,
  });

  // Callers that already read the file pass the original path so the generated
  // header records real provenance rather than `<inline>`.
  if (options.sourceLabel) spec.source = options.sourceLabel;

  let capabilities: GeneratedAdapter['capabilities'] = extractCapabilities(spec);
  const warnings: string[] = [...spec.warnings];

  // ------------------------------------------------------------- filtering
  if (options.includeTags && options.includeTags.length > 0) {
    const include = new Set(options.includeTags);
    const before = capabilities.length;
    capabilities = capabilities.filter((capability) =>
      capability.tags.some((tag) => include.has(tag)),
    );
    warnings.push(`Tag filter: kept ${capabilities.length} of ${before} operations.`);
  }

  if (options.excludeTags && options.excludeTags.length > 0) {
    const exclude = new Set(options.excludeTags);
    const before = capabilities.length;
    capabilities = capabilities.filter(
      (capability) => !capability.tags.some((tag) => exclude.has(tag)),
    );
    warnings.push(`Tag filter: removed ${before - capabilities.length} operations.`);
  }

  if (options.minRisk) {
    const floor = RISK_ORDER[options.minRisk];
    capabilities = capabilities.filter((c) => RISK_ORDER[c.riskLevel] >= floor);
  }

  if (options.maxRisk) {
    const ceiling = RISK_ORDER[options.maxRisk];
    capabilities = capabilities.filter((c) => RISK_ORDER[c.riskLevel] <= ceiling);
  }

  if (capabilities.length === 0) {
    throw new Error(
      'No capabilities remained after filtering. Check --min-risk / --max-risk / tag filters, ' +
        'or whether the spec declares any operations.',
    );
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (capabilities.length > limit) {
    warnings.push(
      `Spec produced ${capabilities.length} capabilities; truncated to the first ${limit}. ` +
        'Use --include-tags or --max-risk to select a smaller, deliberate surface. ' +
        '(Exposing everything is exactly the MCP scaling problem TCPcore exists to avoid.)',
    );
    capabilities = capabilities.slice(0, limit);
  }

  // ------------------------------------------------------------- assembling
  let adapter: GeneratedAdapter = {
    name: slugify(spec.title) || 'generated-adapter',
    displayName: spec.title,
    baseUrl: options.baseUrl ?? spec.baseUrl,
    authType: options.authType ?? inferAuthType(spec),
    capabilities,
    warnings,
  };

  // A capability name must satisfy the shared schema.
  adapter.capabilities = adapter.capabilities.map((capability) => ({
    ...capability,
    name: normalizeCapabilityName(capability.name),
  }));

  // --------------------------------------------------------------- merging
  let diff: GenerateResult['diff'];
  if (options.merge) {
    const outcome = mergeAdapters(options.merge, adapter);
    adapter = outcome.merged;
    diff = outcome.diff;

    if (diff.preserved.length > 0) {
      adapter.warnings.push(
        `Preserved human risk overrides on ${diff.preserved.length} capability(ies): ${diff.preserved.join(' | ')}`,
      );
    }
    if (diff.removed.length > 0) {
      adapter.warnings.push(
        `Marked ${diff.removed.length} capability(ies) deprecated (present in the old adapter, absent from the spec): ${diff.removed.join(', ')}`,
      );
    }
    if (diff.added.length > 0) {
      adapter.warnings.push(
        `Added ${diff.added.length} new capability(ies): ${diff.added.join(', ')}`,
      );
    }
  }

  // ------------------------------------------------------------ sanitizing
  const sanitized = sanitizeAdapter(adapter);
  adapter = sanitized.adapter;

  // --------------------------------------------------------------- emitting
  const yaml = emitYaml(adapter, {
    source: spec.source,
    version: '0.1.0',
    regenerated: Boolean(options.merge),
  });

  // -------------------------------------------------- self-validation gate
  const validated = validateEmittedYaml(yaml);
  if (!validated.ok) {
    throw new Error(
      `Internal error: the generator produced YAML that the adapter schema rejects. ` +
        `This is a bug in tcpctl, please report it.\n${validated.errors.join('\n')}`,
    );
  }

  const riskBreakdown: RiskBreakdown = {
    low: adapter.capabilities.filter((c) => c.riskLevel === 'low').length,
    medium: adapter.capabilities.filter((c) => c.riskLevel === 'medium').length,
    high: adapter.capabilities.filter((c) => c.riskLevel === 'high').length,
  };

  return {
    yaml,
    adapter,
    capabilityCount: adapter.capabilities.length,
    riskBreakdown,
    ...(diff ? { diff } : {}),
    warnings: adapter.warnings,
  };
}

/**
 * Re-parse and validate the emitted YAML.
 *
 * Round-tripping through the schema is the cheapest possible guarantee that the
 * generator and the kernel agree on what a valid adapter is.
 */
export function validateEmittedYaml(yaml: string): { ok: true } | { ok: false; errors: string[] } {
  const result = AdapterSchema.safeParse(parseYaml(yaml));

  if (result.success) return { ok: true };

  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `  ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    ),
  };
}

/** Capability names must match `^[a-z][a-z0-9_]*$`. */
function normalizeCapabilityName(name: string): string {
  const slug = slugify(name);
  if (/^[a-z][a-z0-9_]*$/.test(slug)) return slug;
  const repaired = slug.replace(/^[^a-z]+/, '');
  return /^[a-z][a-z0-9_]*$/.test(repaired) ? repaired : `capability_${repaired || 'unnamed'}`;
}

/** Prefer the security scheme declared in the spec. */
function inferAuthType(spec: {
  operations: Array<{ anonymous?: boolean }>;
}): GeneratedAdapter['authType'] {
  const privateOperations = spec.operations.filter((op) => !op.anonymous);
  // If every operation is explicitly anonymous the API likely needs no auth.
  if (spec.operations.length > 0 && privateOperations.length === 0) return 'none';
  return 'bearer';
}

/**
 * Convert a generated adapter into an `AdapterConfig`-shaped object without
 * re-parsing YAML. Used by the Studio UI and by tests.
 */
export function toAdapterConfig(adapter: GeneratedAdapter): {
  name: string;
  display_name: string;
  base_url: string;
  auth: Record<string, unknown>;
  capabilities: CapabilityConfig[];
} {
  return {
    name: adapter.name,
    display_name: adapter.displayName,
    base_url: adapter.baseUrl,
    auth: {
      type: adapter.authType,
      ...(adapter.authHeader ? { header: adapter.authHeader } : {}),
      ...(adapter.authPrefix ? { prefix: adapter.authPrefix } : {}),
      ...(adapter.tokenEndpoint ? { token_endpoint: adapter.tokenEndpoint } : {}),
      ...(adapter.scopes ? { scopes: adapter.scopes } : {}),
    },
    capabilities: adapter.capabilities as unknown as CapabilityConfig[],
  };
}

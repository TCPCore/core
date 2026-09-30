import type { GeneratedCapability, NormalizedOperation, NormalizedSpec } from '../types.js';
import { analyzeContentRisk } from './content-analyzer.js';
import { findAmountField, inferRisk } from './risk-analyzer.js';
import { toInputSchema, toOutputSchema } from './schema-mapper.js';

/**
 * Turn normalised operations into capabilities.
 *
 * Two responsibilities matter here:
 *
 *  1. **Naming.** Capability names appear in MCP tool names, URL path segments,
 *     audit rows and agent grant lists, so they must be stable, unique, and
 *     lowercase snake_case. Stability matters because a renamed capability
 *     breaks every agent grant that referenced it — so naming is deterministic
 *     from the operation, never random, and collisions are disambiguated with a
 *     numeric suffix rather than by dropping the operation.
 *
 *  2. **Risk.** Each capability gets a risk level from `inferRisk`, a
 *     content-risk flag from `analyzeContentRisk`, and a human-readable set of
 *     notes that the emitter writes into the YAML as comments.
 */

/** camelCase / kebab-case / spaces / dots → snake_case. */
export function slugify(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

/**
 * Ensure a name satisfies the adapter schema: `^[a-z][a-z0-9_]*$`.
 * Falls back to a derived name when slugification produces something unusable
 * (e.g. an operationId of purely non-ASCII characters).
 */
export function toCapabilityName(raw: string, fallback: string): string {
  const slug = slugify(raw);
  if (/^[a-z][a-z0-9_]*$/.test(slug)) return slug;

  const fallbackSlug = slugify(fallback);
  if (/^[a-z][a-z0-9_]*$/.test(fallbackSlug)) return fallbackSlug;

  return `operation_${slug.replace(/^[^a-z]+/, '') || 'unnamed'}`;
}

/** Disambiguate a name that has already been used. */
export function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function extractCapabilities(spec: NormalizedSpec): GeneratedCapability[] {
  const used = new Set<string>();
  const capabilities: GeneratedCapability[] = [];

  for (const operation of spec.operations) {
    const baseName = toCapabilityName(operation.id, `${operation.method}_${operation.path}`);
    const name = uniqueName(baseName, used);

    const risk = inferRisk(operation);
    const content = analyzeContentRisk(operation);
    const { schema: input, notes: schemaNotes } = toInputSchema(operation);
    const output = toOutputSchema(operation);

    const notes: string[] = [
      `Source: ${operation.method} ${operation.path}`,
      `Risk: ${risk.reason}`,
      `Rules: ${risk.rulesTriggered.join(', ')}`,
    ];

    if (content.level) notes.push(`Content risk: ${content.reason}`);
    if (risk.conditionalHint) notes.push(`Suggestion: ${risk.conditionalHint}`);
    notes.push(...schemaNotes);

    if (operation.deprecated) {
      notes.push('Marked deprecated in the source specification.');
    }

    if (operation.anonymous) {
      notes.push(
        'This operation declares no security requirement in the source spec; it may be public.',
      );
    }

    const amountField = findAmountField(operation);
    if (amountField && !risk.conditionalHint) {
      notes.push(
        `Numeric amount-like field "${amountField}" is present; consider a conditional risk rule.`,
      );
    }

    capabilities.push({
      name,
      description:
        operation.summary || operation.description || `${operation.method} ${operation.path}`,
      method: operation.method,
      pathTemplate: operation.path,
      riskLevel: risk.level,
      approvalRequired: risk.approvalRequired,
      agentForbidden: risk.agentForbidden,
      ...(content.level ? { contentRisk: content.level } : {}),
      deprecated: operation.deprecated === true,
      input,
      ...(output ? { output } : {}),
      tags: operation.tags,
      notes,
    });
  }

  return capabilities;
}

export type { NormalizedOperation };

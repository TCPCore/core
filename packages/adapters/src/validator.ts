import { AdapterSchema, type AdapterConfig } from '@tcpcore1/shared';
import { parse as parseYaml } from 'yaml';
import type { LoadOptions, ValidationIssue, ValidationResult } from './types.js';

/**
 * Adapter validation.
 *
 * Two layers, and both matter:
 *
 *  1. **Schema validity** — the document matches `AdapterSchema` from
 *     `@tcpcore1/shared`. This is what makes the format machine-checkable in CI.
 *
 *  2. **Policy consistency** — the declared risk fields make sense together.
 *     A schema cannot express "an operation that deletes things must be marked
 *     agent_forbidden", but that relationship is exactly where an adapter author
 *     makes a mistake that hands an agent a destructive capability. These are
 *     errors, not warnings, because the file is policy.
 */

/**
 * Validation options are the loader options: no extra knobs are needed, and an
 * empty interface would be structurally identical to its supertype.
 */
export type ValidateOptions = LoadOptions;

/**
 * Capability names that read as destructive.
 *
 * Note the `[^a-z0-9]` separators rather than `\b`: an underscore is a word
 * character, so `\bdelete\b` would not match `delete_account` — which is
 * exactly the name an author would use for the dangerous operation.
 */
const DESTRUCTIVE_HINT =
  /(^|[^a-z0-9])(delete|destroy|purge|drop|wipe|erase|terminate|revoke|deactivate|disable|ban|suspend|close_account|uninstall|shutdown|truncate)($|[^a-z0-9])/i;

/** Capability names that read as money movement. Same separator reasoning. */
const MONEY_HINT =
  /(^|[^a-z0-9])(refund|charge|payment|payout|transfer|withdraw|disburse|remit|credit|debit|invoice)($|[^a-z0-9])/i;

export function validateAdapter(raw: string, options: ValidateOptions = {}): ValidationResult {
  const source = options.source ?? '<inline>';
  const warnings: string[] = [];

  // ------------------------------------------------------------ parse step
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '(document)', message: `not valid YAML: ${(error as Error).message}` }],
      warnings,
    };
  }

  if (document === null || document === undefined) {
    return {
      ok: false,
      errors: [{ path: '(document)', message: `${source} is empty` }],
      warnings,
    };
  }

  // ----------------------------------------------------------- schema step
  const parsed = AdapterSchema.safeParse(document);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
      })),
      warnings,
    };
  }

  const adapter: AdapterConfig = parsed.data;
  const errors: ValidationIssue[] = [];

  // ---------------------------------------------------------- policy step
  const seenNames = new Set<string>();

  for (const capability of adapter.capabilities) {
    const where = `capabilities.${capability.name}`;

    if (seenNames.has(capability.name)) {
      errors.push({ path: where, message: 'duplicate capability name' });
    }
    seenNames.add(capability.name);

    // A capability that cannot be executed by anyone is dead weight, but an
    // agent_forbidden capability with an explicit approval requirement is a
    // contradiction an author almost always created by accident.
    if (capability.agent_forbidden && capability.approval_required) {
      errors.push({
        path: where,
        message:
          'agent_forbidden and approval_required are mutually exclusive: an agent cannot propose an action it is forbidden from performing.',
      });
    }

    const destructiveInName = DESTRUCTIVE_HINT.test(capability.name);
    const destructivePath = DESTRUCTIVE_HINT.test(capability.path);
    const destructive = capability.method === 'DELETE' || destructiveInName || destructivePath;

    if (destructive && !capability.agent_forbidden) {
      errors.push({
        path: where,
        message:
          'destructive operation (DELETE or a destructive verb in the name/path) must set agent_forbidden: true. ' +
          'If this really is safe for an agent, rename the capability so the intent is explicit.',
      });
    }

    if (destructive && capability.risk !== 'high') {
      errors.push({
        path: where,
        message: `destructive operation must declare risk: high (found "${capability.risk}")`,
      });
    }

    if (
      (MONEY_HINT.test(capability.name) || MONEY_HINT.test(capability.path)) &&
      capability.method !== 'GET' &&
      capability.method !== 'HEAD' &&
      capability.risk === 'low'
    ) {
      errors.push({
        path: where,
        message:
          'money-moving operation must not be risk: low. Use risk: medium with approval_required, or risk: high.',
      });
    }

    // Read-only methods that require approval are usually a copy/paste slip,
    // but they are legitimate for genuinely sensitive reads, so this is a warning.
    if (capability.method === 'GET' && capability.approval_required) {
      warnings.push(
        `${where}: GET with approval_required: true. Legitimate for sensitive reads, but confirm this is intended — ` +
          'every call will wait for a human.',
      );
    }

    if (capability.method === 'GET' && capability.agent_forbidden) {
      warnings.push(
        `${where}: GET is marked agent_forbidden. Agents will not see this tool at all; confirm that is intended.`,
      );
    }

    // content_risk on a capability that appears to return machine data.
    if (capability.content_risk && capability.method !== 'GET' && capability.method !== 'HEAD') {
      warnings.push(
        `${where}: content_risk is set on a ${capability.method}. content_risk applies to responses an agent reads; ` +
          'confirm the response really carries third-party text.',
      );
    }
  }

  if (adapter.auth.type === 'jwt' && adapter.auth.source === 'credential_store') {
    warnings.push(
      'auth.type: jwt with source: credential_store requires a stored service token. ' +
        "Use source: agent_token to forward the calling agent's own identity.",
    );
  }

  if (adapter.auth.type === 'none') {
    warnings.push(
      'auth.type: none. Every call will be made unauthenticated — confirm this API is genuinely public.',
    );
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return { ok: true, adapter, warnings };
}

/**
 * Load and validate an adapter, throwing on failure.
 *
 * The kernel has its own copy of the strict-load path (`parseAdapterYaml`) so it
 * does not depend on this package; both use the same `AdapterSchema`, so they
 * cannot disagree about validity. This one adds the friendlier diagnostics the
 * CLI and the generator want.
 */
export function loadAdapter(raw: string, options: LoadOptions = {}): AdapterConfig {
  const result = validateAdapter(raw, options);

  if (!result.ok) {
    const source = options.source ?? '<inline>';
    const detail = result.errors.map((error) => `  ${error.path}: ${error.message}`).join('\n');
    throw new Error(`Adapter ${source} failed validation:\n${detail}`);
  }

  return result.adapter;
}

/** Load without touching disk — used by the generator's self-check. */
export function loadFromString(raw: string, options: LoadOptions = {}): AdapterConfig {
  return loadAdapter(raw, options);
}

/** True when the adapter declares at least one capability an agent may call. */
export function hasAgentReachableCapabilities(adapter: AdapterConfig): boolean {
  return adapter.capabilities.some(
    (capability) => !capability.agent_forbidden && capability.risk !== 'high',
  );
}

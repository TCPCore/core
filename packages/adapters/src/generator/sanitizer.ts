import type { JsonSchema } from '@tcpcore1/shared';
import type { GeneratedAdapter, GeneratedCapability } from '../types.js';

/**
 * Secret redaction for generated adapters.
 *
 * Specs routinely ship with live-looking example values: `example: sk_live_…`,
 * an AWS key in a description, a JWT in a sample header. Running the generator
 * must never turn "paste your OpenAPI spec" into "commit your API keys", so
 * every string that leaves this package passes through here first.
 *
 * Redaction is applied to the whole serialised adapter rather than field by
 * field, because secrets hide in `description`, `enum` and `default` just as
 * easily as in `example`.
 */

/** Patterns that indicate a real credential, not a placeholder. */
const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'stripe_live', pattern: /sk_live_[A-Za-z0-9]{16,}/g },
  { id: 'stripe_test', pattern: /sk_test_[A-Za-z0-9]{16,}/g },
  { id: 'stripe_restricted', pattern: /rk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'aws_access_key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { id: 'aws_secret_hint', pattern: /aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{40}/gi },
  { id: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'bearer_literal', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    id: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { id: 'uri_credentials', pattern: /:\/\/[^/\s:@]{3,}:[^/\s@]{6,}@/g },
  { id: 'basic_auth', pattern: /Basic\s+[A-Za-z0-9+/]{20,}={0,2}/g },
];

const REDACTED = '[REDACTED]';

/** Field names that indicate a value is a credential placeholder-by-caution. */
const SECRET_FIELD_NAMES = new Set([
  'password',
  'passwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'auth_token',
  'private_key',
  'token',
]);

/** Hosts that indicate a non-production server in `servers[].url`. */
const NON_PRODUCTION_HOST =
  /(^|\.)(localhost|local|staging|stage|test|testing|dev|development|sandbox|preprod|pre-prod|internal|int|uat|qa)(\.|:|$)/i;

export interface SanitizeReport {
  adapter: GeneratedAdapter;
  redactions: string[];
  warnings: string[];
}

/** Redact secrets in a single string. Exported for tests and for the CLI. */
export function redactString(input: string): { value: string; hits: string[] } {
  let value = input;
  const hits: string[] = [];

  for (const { id, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex: these are /g regexes shared across calls.
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      hits.push(id);
      pattern.lastIndex = 0;
      value = value.replace(pattern, REDACTED);
    }
  }

  return { value, hits };
}

/** Recursively redact a JSON Schema-ish value. */
function redactSchema(schema: JsonSchema, path: string, hits: Set<string>): JsonSchema {
  const out: JsonSchema = {};

  for (const [key, raw] of Object.entries(schema)) {
    // A field literally named `secret`/`password` with a string default or
    // example is a credential by intent.
    if (
      (key === 'default' || key === 'example' || key === 'examples') &&
      raw !== undefined &&
      Object.keys(schema).some((k) => SECRET_FIELD_NAMES.has(k))
    ) {
      out[key] = REDACTED;
      hits.add('credential_field');
      continue;
    }

    if (typeof raw === 'string') {
      const { value, hits: found } = redactString(raw);
      out[key] = value;
      for (const hit of found) hits.add(hit);
      continue;
    }

    if (Array.isArray(raw)) {
      out[key] = raw.map((item, index) => {
        if (typeof item === 'string') {
          const { value, hits: found } = redactString(item);
          for (const hit of found) hits.add(hit);
          return value;
        }
        if (item && typeof item === 'object') {
          return redactSchema(item as JsonSchema, `${path}.${key}[${index}]`, hits);
        }
        return item;
      });
      continue;
    }

    if (raw && typeof raw === 'object') {
      out[key] = redactSchema(raw as JsonSchema, `${path}.${key}`, hits);
      continue;
    }

    out[key] = raw;
  }

  return out;
}

/**
 * Sanitize a generated adapter before it is written to disk.
 *
 * Also warns when the base URL points at a non-production host, because
 * generating an adapter against `staging.example.com` and shipping it is a
 * common and quiet mistake.
 */
export function sanitizeAdapter(adapter: GeneratedAdapter): SanitizeReport {
  const hits = new Set<string>();
  const warnings: string[] = [];

  // Base URL: warn on non-production hosts, redact embedded credentials.
  let baseUrl = adapter.baseUrl;
  const baseUrlRedaction = redactString(baseUrl);
  if (baseUrlRedaction.hits.length > 0) {
    baseUrl = baseUrlRedaction.value;
    for (const hit of baseUrlRedaction.hits) hits.add(hit);
  }

  try {
    const parsed = new URL(baseUrl);
    if (NON_PRODUCTION_HOST.test(parsed.hostname)) {
      warnings.push(
        `base_url points at a non-production host ("${parsed.hostname}"). ` +
          'Confirm this is intentional before committing the adapter.',
      );
    }
  } catch {
    if (baseUrl) warnings.push(`base_url "${baseUrl}" is not an absolute URL; set --base-url.`);
  }

  const capabilities: GeneratedCapability[] = adapter.capabilities.map((capability) => {
    const notes = [...capability.notes];

    const description = redactString(capability.description);
    if (description.hits.length > 0) {
      for (const hit of description.hits) hits.add(hit);
      notes.push('Redacted a credential-shaped value from this description.');
    }

    const input = redactSchema(capability.input, capability.name, hits);
    const output = capability.output
      ? redactSchema(capability.output, capability.name, hits)
      : undefined;

    return {
      ...capability,
      description: description.value,
      input,
      ...(output ? { output } : {}),
      notes,
    };
  });

  if (hits.size > 0) {
    warnings.push(
      `Redacted credential-shaped values (${[...hits].join(', ')}). ` +
        'Verify the adapter does not need those values and that no real secret was ever read into your shell history.',
    );
  }

  return {
    adapter: { ...adapter, baseUrl, capabilities, warnings: [...adapter.warnings, ...warnings] },
    redactions: [...hits],
    warnings,
  };
}

export { SECRET_PATTERNS, NON_PRODUCTION_HOST };

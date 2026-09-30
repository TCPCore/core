/**
 * Minimal, dependency-free JSON Schema validation for capability inputs.
 *
 * Why not Ajv: the kernel is the MIT-licensed core and must stay small and
 * auditable. Adapter `input` blocks are a deliberately restricted JSON Schema
 * subset, so a focused validator is both sufficient and easier to reason about.
 *
 * Security relevance: capability arguments are attacker-influenced (an LLM can
 * emit anything, and an external MCP client chooses them). They are validated
 * *before* any outbound call, so a schema of `{"type":"string","enum":[...]}`
 * is an allowlist, not a hint.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidateOptions {
  /**
   * Coerce JSON-shaped strings/numbers into the declared primitive type.
   * Enabled for query/path params (which arrive as strings) but never for a
   * JSON request body, where coercion would mask a client bug.
   */
  coerce?: boolean;
  /** Reject properties not declared in the schema. Default true. */
  strict?: boolean;
}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function declaredTypes(schema: Record<string, unknown>): string[] {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a string into the schema's declared primitive where lossless.
 * Returns `undefined` when no safe coercion exists.
 */
function coerceValue(value: unknown, types: string[]): unknown {
  if (typeof value !== 'string' || value === '') return undefined;
  if (types.includes('integer') && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (types.includes('number') && /^-?\d+(\.\d+)?$/.test(value)) return Number.parseFloat(value);
  if (types.includes('boolean')) {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (types.includes('array') || types.includes('object')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) || isPlainObject(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Validate `value` against `schema`, returning a (possibly coerced) copy.
 *
 * Never mutates the input. Unknown keys are dropped when `strict` is set, which
 * is what stops an agent from smuggling extra fields into the proxied request.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown> | null | undefined,
  value: unknown,
  options: ValidateOptions = {},
): { ok: boolean; value: unknown; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  if (!schema || Object.keys(schema).length === 0) {
    // No declared schema: pass through but only as a plain object.
    if (value === undefined) return { ok: true, value: {}, issues };
    if (!isPlainObject(value)) {
      return { ok: false, value, issues: [{ path: '', message: 'expected an object' }] };
    }
    return { ok: true, value, issues };
  }

  const walk = (
    node: Record<string, unknown>,
    val: unknown,
    path: string,
    coerce: boolean,
  ): unknown => {
    const types = declaredTypes(node);

    // Nullable / explicit null.
    if (val === null || val === undefined) {
      const nullable = types.includes('null') || node.nullable === true;
      if (nullable || val === null) return val;
      if (node.default !== undefined) return node.default;
      return val;
    }

    // `val` is already known non-null here, but an explicit annotation keeps the
    // mutable binding assignable from the coercion branch below.
    let current: unknown = val;

    // Type check + optional coercion.
    if (types.length > 0 && !types.some((t) => TYPE_CHECKS[t]?.(current))) {
      const coerced = coerce ? coerceValue(current, types) : undefined;
      if (coerced !== undefined && types.some((t) => TYPE_CHECKS[t]?.(coerced))) {
        current = coerced;
      } else {
        issues.push({
          path: path || '(root)',
          message: `expected ${types.join(' | ')}, received ${Array.isArray(current) ? 'array' : typeof current}`,
        });
        return current;
      }
    }

    // enum allowlist.
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const allowed = node.enum;
      if (!allowed.some((candidate) => candidate === current)) {
        issues.push({
          path: path || '(root)',
          message: `must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`,
        });
        return current;
      }
    }

    if (typeof current === 'number') {
      if (typeof node.minimum === 'number' && current < node.minimum) {
        issues.push({ path: path || '(root)', message: `must be >= ${node.minimum}` });
      }
      if (typeof node.maximum === 'number' && current > node.maximum) {
        issues.push({ path: path || '(root)', message: `must be <= ${node.maximum}` });
      }
    }

    if (typeof current === 'string') {
      if (typeof node.minLength === 'number' && current.length < node.minLength) {
        issues.push({
          path: path || '(root)',
          message: `must be at least ${node.minLength} characters`,
        });
      }
      if (typeof node.maxLength === 'number' && current.length > node.maxLength) {
        issues.push({
          path: path || '(root)',
          message: `must be at most ${node.maxLength} characters`,
        });
      }
      if (typeof node.pattern === 'string') {
        try {
          if (!new RegExp(node.pattern).test(current)) {
            issues.push({ path: path || '(root)', message: `must match /${node.pattern}/` });
          }
        } catch {
          // An invalid pattern in an adapter must not crash the kernel; the
          // adapter validator rejects it at load time instead.
        }
      }
    }

    if (Array.isArray(current)) {
      const itemSchema = isPlainObject(node.items) ? node.items : undefined;
      if (itemSchema) {
        current = current.map((item, index) => walk(itemSchema, item, `${path}[${index}]`, false));
      }
      return current;
    }

    if (isPlainObject(current)) {
      // oneOf/anyOf: accept if any branch validates; keep the first success.
      const branches = [node.oneOf, node.anyOf].find(
        (b): b is Record<string, unknown>[] => Array.isArray(b) && b.length > 0,
      );
      if (branches) {
        for (const branch of branches) {
          const attempt = validateAgainstSchema(branch, current, {
            coerce: false,
            strict: options.strict,
          });
          if (attempt.ok) return attempt.value;
        }
        issues.push({
          path: path || '(root)',
          message: 'does not match any allowed schema variant',
        });
        return current;
      }

      const properties = isPlainObject(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((r): r is string => typeof r === 'string')
        : [];

      for (const key of required) {
        if (current[key] === undefined) {
          // A property with a schema default satisfies "required".
          const propSchema = isPlainObject(properties[key]) ? properties[key] : undefined;
          if (propSchema && propSchema.default !== undefined) {
            current[key] = propSchema.default;
          } else {
            issues.push({
              path: path ? `${path}.${key}` : key,
              message: 'is required',
            });
          }
        }
      }

      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(current)) {
        const propSchema = isPlainObject(properties[key]) ? properties[key] : undefined;
        if (propSchema) {
          const next = walk(propSchema, raw, path ? `${path}.${key}` : key, coerce);
          if (next !== undefined) out[key] = next;
        } else if (
          node.additionalProperties === false ||
          (options.strict && Object.keys(properties).length > 0)
        ) {
          // Dropped: undeclared field. Silently removing (rather than failing)
          // keeps generated adapters usable while still denying the target API
          // any field the adapter author did not declare.
          continue;
        } else {
          out[key] = raw;
        }
      }

      // Apply defaults for absent declared properties.
      for (const [key, propSchema] of Object.entries(properties)) {
        if (
          out[key] === undefined &&
          isPlainObject(propSchema) &&
          propSchema.default !== undefined
        ) {
          out[key] = propSchema.default;
        }
      }

      return out;
    }

    return current;
  };

  const result = walk(schema, value, '', options.coerce ?? false);
  return { ok: issues.length === 0, value: result, issues };
}

/** Render issues as a single human-readable string for audit `metadata.error`. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}

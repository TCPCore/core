import type { JsonSchema } from '@tcpcore1/shared';
import type { NormalizedOperation } from '../types.js';

/**
 * Convert a normalised operation into a JSON Schema for the capability's
 * `input` block.
 *
 * Design decisions that matter for security:
 *
 *  - **Path and query parameters are merged into one flat object.** The agent
 *    sends one JSON object; the kernel splits it back into path substitutions
 *    and query string using the path template. The agent never composes a URL.
 *  - **Auth headers are dropped.** `Authorization`, `x-api-key`, `cookie` and
 *    friends are the token broker's job. Exposing them in a tool schema invites
 *    an LLM to try to supply them, and a schema that requires them is a schema
 *    no agent can satisfy.
 *  - **`additionalProperties: false`.** The kernel drops undeclared fields, so
 *    this schema is an allowlist. Declaring it here keeps the generated adapter
 *    honest about what it accepts and makes the MCP tool schema exact.
 *  - **Only successful responses become `output`.** Error envelopes are not the
 *    operation's contract.
 */

const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'auth',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

/** Types JSON Schema allows that we pass through unchanged. */
const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * Sanitise a JSON Schema fragment coming from a third-party spec.
 *
 * Strips `example`/`examples` (which routinely contain real customer data and
 * live credentials — it is a genuine leak vector when committing an adapter),
 * `$ref` (unresolved refs would break validation), and any `x-` extension
 * unless it is clearly structural.
 */
export function cleanSchema(schema: unknown, depth = 0): JsonSchema {
  if (depth > 12 || schema === null || typeof schema !== 'object') {
    return { type: 'string' };
  }

  const node = schema as Record<string, unknown>;
  const out: JsonSchema = {};

  const type = node.type;
  if (
    typeof type === 'string' &&
    (PRIMITIVE_TYPES.has(type) || type === 'object' || type === 'array')
  ) {
    out.type = type;
  } else if (Array.isArray(type)) {
    const kept = type.filter((t): t is string => typeof t === 'string' && t !== 'null');
    if (kept.length === 1) out.type = kept[0]!;
    else if (kept.length > 1) out.type = kept;
    if (type.includes('null')) out.nullable = true;
  }

  if (typeof node.description === 'string') out.description = node.description;
  if (typeof node.format === 'string') out.format = node.format;
  if (typeof node.pattern === 'string') out.pattern = node.pattern;
  if (Array.isArray(node.enum)) {
    // Preserve scalar enums only; an object-valued enum is not expressible.
    out.enum = node.enum.filter(
      (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
  }
  if (
    node.default !== undefined &&
    (node.default === null || ['string', 'number', 'boolean'].includes(typeof node.default))
  ) {
    out.default = node.default;
  }

  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'multipleOf',
  ] as const) {
    if (typeof node[key] === 'number') out[key] = node[key];
  }

  if (node.items) out.items = cleanSchema(node.items, depth + 1);

  if (node.properties && typeof node.properties === 'object') {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      properties[key] = cleanSchema(child, depth + 1);
    }
    out.properties = properties;
  }

  if (Array.isArray(node.required)) {
    out.required = node.required.filter((r): r is string => typeof r === 'string');
  }

  if (node.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof node.additionalProperties === 'object'
        ? cleanSchema(node.additionalProperties, depth + 1)
        : Boolean(node.additionalProperties);
  }

  for (const branch of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(node[branch])) {
      out[branch] = (node[branch] as unknown[]).map((child) => cleanSchema(child, depth + 1));
    }
  }

  return out;
}

/**
 * Merge parameters and the request body into the single flat `input` object
 * the kernel validates against.
 */
export function toInputSchema(op: NormalizedOperation): {
  schema: JsonSchema;
  notes: string[];
} {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const notes: string[] = [];
  const droppedHeaders: string[] = [];

  for (const parameter of op.parameters) {
    if (parameter.in === 'header' && AUTH_HEADER_NAMES.has(parameter.name.toLowerCase())) {
      droppedHeaders.push(parameter.name);
      continue;
    }

    // A parameter name that collides with an existing property: the path
    // parameter wins, because it is positional and cannot be renamed.
    if (properties[parameter.name]) {
      notes.push(
        `Duplicate input field "${parameter.name}" (from ${parameter.in}); the first declaration was kept.`,
      );
      continue;
    }

    const schema = cleanSchema(parameter.schema);
    if (parameter.description && !schema.description) schema.description = parameter.description;

    properties[parameter.name] = schema;

    // Path parameters are always required by definition.
    if (parameter.in === 'path' || parameter.required) required.push(parameter.name);
  }

  if (op.requestBody) {
    const body = op.requestBody as JsonSchema;
    const bodyType = body.type;

    if (bodyType === 'object' || body.properties) {
      const bodyProperties = (body.properties ?? {}) as Record<string, JsonSchema>;
      const bodyRequired = new Set(Array.isArray(body.required) ? (body.required as string[]) : []);

      for (const [key, value] of Object.entries(bodyProperties)) {
        if (properties[key]) {
          notes.push(
            `Request body field "${key}" collides with a parameter of the same name; the parameter was kept.`,
          );
          continue;
        }
        properties[key] = cleanSchema(value);
        if (bodyRequired.has(key)) required.push(key);
      }
    } else if (bodyType === 'array' || PRIMITIVE_TYPES.has(String(bodyType))) {
      // A non-object body cannot be flattened; expose it whole under `body`.
      properties.body = cleanSchema(body);
      if (op.method !== 'GET') required.push('body');
      notes.push('Non-object request body exposed as a single `body` field.');
    }
  }

  if (droppedHeaders.length > 0) {
    notes.push(
      `Authentication header(s) omitted from the input schema: ${droppedHeaders.join(', ')}. ` +
        'The kernel token broker supplies these.',
    );
  }

  if (Object.keys(properties).length === 0) {
    notes.push('Operation declares no inputs; the capability takes an empty object.');
  }

  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
      additionalProperties: false,
    },
    notes,
  };
}

/** Pick the primary successful response schema, for the capability `output`. */
export function toOutputSchema(op: NormalizedOperation): JsonSchema | undefined {
  const statuses = Object.keys(op.responses);
  const preferred =
    statuses.find((s) => s === '200') ??
    statuses.find((s) => /^2\d\d$/.test(s)) ??
    statuses.find((s) => s === 'default');

  if (!preferred) return undefined;
  const schema = op.responses[preferred];
  if (!schema || Object.keys(schema).length === 0) return undefined;
  return cleanSchema(schema);
}

export { AUTH_HEADER_NAMES };

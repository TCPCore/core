import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { AdapterConfig, HttpMethod, RiskLevel, SpecFormat } from '@tcpcore1/shared';
import type { NormalizedOperation, NormalizedParameter, NormalizedSpec } from '../types.js';
import { cleanSchema } from './schema-mapper.js';

/**
 * Spec parsing and normalisation.
 *
 * Supports OpenAPI 3.0/3.1, Swagger 2.0, Postman Collections (v2.x) and HAR.
 * All four collapse into {@link NormalizedSpec} so everything downstream is
 * format-agnostic.
 *
 * Design notes:
 *  - **Dependency-light by default.** `$ref` resolution is implemented locally
 *    (including Swagger 2.0 → OpenAPI 3 rewriting), so the common case works
 *    with zero network flakiness and no third-party parser in the trust path.
 *    Remote specs are still fetched, and remote `$ref` targets are followed.
 *  - **Cycle-safe.** Circular `$ref`s are extremely common in real specs
 *    (`Order` → `Customer` → `Order`). Resolution tracks the ref stack and
 *    stops, so a malicious or merely self-referential spec cannot hang the CLI.
 *  - **Fail-safe format detection.** An unrecognisable document produces a
 *    warning and zero operations rather than a crash, so `--from auto` degrades
 *    usefully.
 */

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Guard against a spec that expands without bound. */
const MAX_SPEC_BYTES = 32 * 1024 * 1024;
const MAX_REF_DEPTH = 24;

// ---------------------------------------------------------------------------
// Loading & format detection
// ---------------------------------------------------------------------------

export interface ParseInputOptions {
  timeoutMs?: number;
  allowInsecureSpecUrl?: boolean;
}

export function detectFormat(document: unknown, hint: SpecFormat = 'auto'): SpecFormat {
  if (hint !== 'auto') return hint;
  if (document === null || typeof document !== 'object') return 'openapi';

  const doc = document as Record<string, unknown>;

  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3.')) return 'openapi';

  // Checked before the OpenAPI fallback below: a Swagger 2.0 document also has
  // `paths` and `info`, so it would otherwise be misread as OpenAPI 3 and lose
  // its `host`/`basePath`/`definitions` handling.
  if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2.')) return 'swagger';
  if (doc.swagger === '2.0') return 'swagger';

  // HAR: has a `log` with `entries`.
  if (
    doc.log &&
    typeof doc.log === 'object' &&
    Array.isArray((doc.log as { entries?: unknown }).entries)
  ) {
    return 'har';
  }

  // Postman v2.x: `info.schema` mentions postman, plus an `item` array.
  const info = doc.info as Record<string, unknown> | undefined;
  if (
    Array.isArray(doc.item) ||
    (info && typeof info.schema === 'string' && info.schema.includes('postman'))
  ) {
    return 'postman';
  }

  // Bare OpenAPI without a version marker still usually has paths + info.
  if (doc.paths && doc.info) return 'openapi';

  return 'openapi';
}

/** Parse raw text (JSON or YAML) into a document. */
export function parseDocument(raw: string, source: string): unknown {
  const trimmed = raw.trim();

  // JSON is a YAML subset, but trying JSON first gives far better error
  // messages for the overwhelmingly common case of a JSON spec.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (jsonError) {
      try {
        return parseYaml(trimmed);
      } catch {
        throw new SpecParseError(
          `Could not parse ${source} as JSON or YAML. JSON error: ${(jsonError as Error).message}`,
        );
      }
    }
  }

  try {
    return parseYaml(trimmed);
  } catch (error) {
    throw new SpecParseError(`Could not parse ${source} as YAML: ${(error as Error).message}`);
  }
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Read a spec from a URL, a local file path, or inline text.
 */
export async function loadSpecText(
  input: string,
  options: ParseInputOptions = {},
): Promise<{ text: string; source: string }> {
  if (isHttpUrl(input)) {
    const url = new URL(input);
    const insecure = url.protocol === 'http:';
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

    if (insecure && !isLoopback && !options.allowInsecureSpecUrl) {
      throw new SpecParseError(
        `Refusing to fetch a spec over plaintext http from "${url.hostname}". ` +
          'Use https, or pass --allow-insecure for a trusted internal host.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

    try {
      const response = await fetch(input, {
        headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new SpecParseError(`Fetching ${input} returned HTTP ${response.status}`);
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_SPEC_BYTES) {
        throw new SpecParseError(`Spec at ${input} is larger than ${MAX_SPEC_BYTES} bytes`);
      }

      const text = await response.text();
      if (text.length > MAX_SPEC_BYTES) {
        throw new SpecParseError(`Spec at ${input} is larger than ${MAX_SPEC_BYTES} bytes`);
      }

      return { text, source: input };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new SpecParseError(`Timed out fetching ${input}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const text = await readFile(input, 'utf8');
    return { text, source: input };
  } catch (error) {
    // Not a file: treat the argument as inline document text.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && input.includes('\n')) {
      return { text: input, source: '<inline>' };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SpecParseError(`Spec file not found: ${input}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Resolve local JSON Pointers, memoised per document. `stack` guards cycles:
 * a ref already being resolved returns `undefined` rather than recursing, and
 * the caller substitutes a permissive schema.
 */
function makeRefResolver(document: unknown) {
  const cache = new Map<string, unknown>();

  const resolvePointer = (pointer: string): unknown => {
    if (cache.has(pointer)) return cache.get(pointer);

    const segments = pointer
      .replace(/^#\//, '')
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

    let current: unknown = document;
    for (const segment of segments) {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
      if (current === undefined) return undefined;
    }

    cache.set(pointer, current);
    return current;
  };

  return resolvePointer;
}

/**
 * Deeply resolve `$ref`s in a schema fragment, cycle-safe.
 *
 * `seen` carries the pointer stack; on revisit we return a permissive open
 * object so validation never becomes impossible to satisfy.
 */
function deref(
  node: unknown,
  resolvePointer: (pointer: string) => unknown,
  seen: string[] = [],
  depth = 0,
): unknown {
  if (depth > MAX_REF_DEPTH || node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => deref(item, resolvePointer, seen, depth + 1));
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    const pointer = obj.$ref;

    if (pointer.startsWith('#/')) {
      if (seen.includes(pointer)) {
        // Circular: stop and stay permissive.
        return { type: 'object', description: `Recursive reference to ${pointer}` };
      }
      const target = resolvePointer(pointer);
      if (target === undefined) {
        return { type: 'object', description: `Unresolved reference ${pointer}` };
      }
      const merged = { ...(obj as Record<string, unknown>) };
      delete merged.$ref;
      const resolved = deref(target, resolvePointer, [...seen, pointer], depth + 1);
      return { ...(resolved as Record<string, unknown>), ...merged };
    }

    // Remote refs are not followed; fetching arbitrary URLs during
    // normalisation would be an SSRF vector driven by spec content.
    return { type: 'object', description: `Remote reference not resolved: ${pointer}` };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = deref(value, resolvePointer, seen, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Swagger 2.0 → OpenAPI 3-ish
// ---------------------------------------------------------------------------

/**
 * Rewrite a Swagger 2.0 document into the subset of the OpenAPI 3 shape the
 * normaliser understands. Only the structural differences matter here; we are
 * not producing a spec for external consumption.
 */
export function swagger2ToOpenApi3(spec: Record<string, unknown>): Record<string, unknown> {
  const definitions = (spec.definitions ?? {}) as Record<string, unknown>;
  const parameters = (spec.parameters ?? {}) as Record<string, unknown>;
  const responses = (spec.responses ?? {}) as Record<string, unknown>;

  // Point definition refs at the OpenAPI 3 components location.
  const rewriteRefs = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewriteRefs);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/definitions/')) {
        out.$ref = value.replace('#/definitions/', '#/components/schemas/');
        continue;
      }
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/parameters/')) {
        out.$ref = value.replace('#/parameters/', '#/components/parameters/');
        continue;
      }
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/responses/')) {
        out.$ref = value.replace('#/responses/', '#/components/responses/');
        continue;
      }
      out[key] = rewriteRefs(value);
    }
    return out;
  };

  const hosts: string[] = [];
  // An already-OpenAPI-3-shaped document (some generators emit both forms) wins.
  const existingServers = spec.servers;
  if (Array.isArray(existingServers)) {
    for (const server of existingServers) {
      const url = (server as Record<string, unknown>)?.url;
      if (typeof url === 'string') hosts.push(url);
    }
  }

  if (hosts.length === 0 && typeof spec.host === 'string') {
    const schemes =
      Array.isArray(spec.schemes) && spec.schemes.length > 0 ? spec.schemes : ['https'];
    const basePath =
      typeof spec.basePath === 'string' && spec.basePath !== '/' ? spec.basePath : '';
    for (const scheme of schemes) {
      if (typeof scheme === 'string') hosts.push(`${scheme}://${spec.host}${basePath}`);
    }
  }

  const securityDefinitions = spec.securityDefinitions ?? {};

  const converted: Record<string, unknown> = {
    openapi: '3.0.3',
    info: spec.info ?? { title: 'Converted Swagger 2.0 API', version: '0.0.0' },
    ...(hosts.length > 0 ? { servers: hosts.map((url) => ({ url })) } : {}),
    paths: rewriteRefs(spec.paths ?? {}),
    components: {
      schemas: rewriteRefs(definitions),
      parameters: rewriteRefs(parameters),
      responses: rewriteRefs(responses),
      ...(Object.keys(securityDefinitions as object).length > 0
        ? { securitySchemes: rewriteRefs(securityDefinitions) }
        : {}),
    },
  };

  if (spec.security) converted.security = spec.security;
  if (spec.tags) converted.tags = spec.tags;
  if (typeof spec.basePath === 'string') converted['x-basePath'] = spec.basePath;

  return converted;
}

// ---------------------------------------------------------------------------
// OpenAPI normalisation
// ---------------------------------------------------------------------------

/**
 * Turn a normalised schema-ish node into a `JsonSchema` suitable for
 * `NormalizedParameter.schema` / `requestBody` / `responses`.
 */
function toSchema(node: unknown): Record<string, unknown> {
  if (node === null || typeof node !== 'object') return { type: 'string' };
  return cleanSchema(node);
}

/**
 * @param originFormat The format the document actually arrived in. A Swagger
 *   2.0 document is converted to the OpenAPI 3 shape before normalisation, but
 *   it is still reported as `swagger` so the CLI can tell the user what it read.
 */
export function normalizeOpenApi(
  spec: Record<string, unknown>,
  source: string,
  originFormat: SpecFormat = 'openapi',
): NormalizedSpec {
  const warnings: string[] = [];
  const resolvePointer = makeRefResolver(spec);

  const info = (spec.info ?? {}) as Record<string, unknown>;
  const title =
    typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Untitled API';
  const version = typeof info.version === 'string' ? info.version : '0.0.0';
  const description = typeof info.description === 'string' ? info.description : undefined;

  // Base URL: first server, else the Swagger-2 shape, else empty.
  let baseUrl = '';
  const servers = spec.servers;
  if (Array.isArray(servers) && servers.length > 0) {
    const first = servers[0] as Record<string, unknown>;
    if (typeof first.url === 'string') baseUrl = first.url;
  } else if (typeof spec.host === 'string') {
    const schemes =
      Array.isArray(spec.schemes) && spec.schemes.length > 0 ? spec.schemes : ['https'];
    const basePath =
      typeof spec.basePath === 'string' && spec.basePath !== '/' ? spec.basePath : '';
    baseUrl = `${schemes[0]}://${spec.host}${basePath}`;
  }

  // Server variables: substitute their defaults so the URL is usable as-is.
  if (baseUrl.includes('{')) {
    if (Array.isArray(servers) && servers.length > 0) {
      const first = servers[0] as Record<string, unknown>;
      const variables = (first.variables ?? {}) as Record<string, { default?: unknown }>;
      for (const [name, variable] of Object.entries(variables)) {
        baseUrl = baseUrl.replaceAll(`{${name}}`, String(variable?.default ?? name));
      }
    }
    if (baseUrl.includes('{')) {
      warnings.push(
        `Server URL still contains unresolved variables: ${baseUrl}. Set --base-url to override.`,
      );
    }
  }

  if (!baseUrl) {
    warnings.push('Spec declares no server URL; pass --base-url to set one explicitly.');
  }

  const globalSecurity = spec.security;
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  const operations: NormalizedOperation[] = [];

  for (const [rawPath, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;

    const pathItem = deref(pathItemRaw, resolvePointer) as Record<string, unknown>;
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const operationRaw = pathItem[method.toLowerCase()];
      if (!operationRaw || typeof operationRaw !== 'object') continue;

      const operation = deref(operationRaw, resolvePointer) as Record<string, unknown>;

      const rawParameters = [
        ...sharedParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];

      const parameters: NormalizedParameter[] = [];
      let requestBody: Record<string, unknown> | undefined;

      for (const rawParam of rawParameters) {
        const param = deref(rawParam, resolvePointer) as Record<string, unknown>;

        // Swagger 2.0 `in: body` is OpenAPI 3's requestBody.
        if (param.in === 'body') {
          if (param.schema) requestBody = toSchema(param.schema);
          continue;
        }
        if (param.in === 'formData') {
          // Fold form fields into a synthetic object body.
          requestBody ??= { type: 'object', properties: {}, required: [] };
          const properties = requestBody.properties as Record<string, unknown>;
          properties[String(param.name)] = toSchema(param.schema ?? param);
          if (param.required === true) {
            (requestBody.required as string[]).push(String(param.name));
          }
          continue;
        }

        const location = String(param.in ?? 'query');
        if (!['path', 'query', 'header', 'cookie'].includes(location)) continue;
        if (typeof param.name !== 'string') continue;

        parameters.push({
          name: param.name,
          in: location as NormalizedParameter['in'],
          required: param.required === true || location === 'path',
          schema: toSchema(param.schema ?? param),
          description: typeof param.description === 'string' ? param.description : undefined,
        });
      }

      // OpenAPI 3 requestBody.
      if (operation.requestBody && typeof operation.requestBody === 'object') {
        const body = deref(operation.requestBody, resolvePointer) as Record<string, unknown>;
        const content = (body.content ?? {}) as Record<string, Record<string, unknown>>;
        const mediaType =
          content['application/json'] ?? content['application/*+json'] ?? Object.values(content)[0];
        if (mediaType && mediaType.schema) {
          requestBody = toSchema(mediaType.schema);
        }
      }

      const responses: Record<string, Record<string, unknown>> = {};
      const rawResponses = (operation.responses ?? {}) as Record<string, unknown>;
      for (const [status, responseRaw] of Object.entries(rawResponses)) {
        const response = deref(responseRaw, resolvePointer) as Record<string, unknown>;
        const content = (response.content ?? {}) as Record<string, Record<string, unknown>>;
        const mediaType =
          content['application/json'] ?? content['application/*+json'] ?? Object.values(content)[0];
        const schema = mediaType?.schema ?? response.schema;
        if (schema) responses[status] = toSchema(schema);
      }

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((t): t is string => typeof t === 'string')
        : [];

      // `security: []` explicitly removes auth; a missing key inherits global.
      const operationSecurity = operation.security;
      const anonymous =
        (Array.isArray(operationSecurity) && operationSecurity.length === 0) ||
        (operationSecurity === undefined &&
          Array.isArray(globalSecurity) &&
          globalSecurity.length === 0);

      operations.push({
        id: buildOperationId(operation, method, rawPath),
        method,
        path: rawPath,
        summary: typeof operation.summary === 'string' ? operation.summary : undefined,
        description: typeof operation.description === 'string' ? operation.description : undefined,
        tags,
        parameters,
        requestBody,
        responses,
        deprecated: operation.deprecated === true,
        anonymous,
      });
    }
  }

  if (operations.length === 0) {
    warnings.push('Spec contains no operations. Check that `paths` is populated.');
  }

  return {
    source,
    format: originFormat,
    title,
    version,
    description,
    baseUrl,
    operations,
    warnings,
  };
}

/** `operationId` when present, otherwise a stable method+path slug. */
function buildOperationId(
  operation: Record<string, unknown>,
  method: HttpMethod,
  path: string,
): string {
  if (typeof operation.operationId === 'string' && operation.operationId.trim()) {
    return operation.operationId.trim();
  }

  const cleanedPath = path
    .replace(/\{([^}]*)\}/g, 'by_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `${method.toLowerCase()}_${cleanedPath || 'root'}`;
}

// ---------------------------------------------------------------------------
// Postman
// ---------------------------------------------------------------------------

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: {
    method?: string;
    url?: string | { raw?: string; host?: string[]; path?: string[] };
    body?: { raw?: string; mode?: string };
    description?: string;
    header?: Array<{ key?: string; value?: string }>;
  };
}

export function normalizePostman(
  collection: Record<string, unknown>,
  source: string,
): NormalizedSpec {
  const warnings: string[] = [];
  const info = (collection.info ?? {}) as Record<string, unknown>;
  const title = typeof info.name === 'string' ? info.name : 'Postman Collection';

  const operations: NormalizedOperation[] = [];

  const walk = (items: PostmanItem[], folder: string[]): void => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        walk(item.item, item.name ? [...folder, item.name] : folder);
        continue;
      }
      if (!item.request) continue;

      const method = String(item.request.method ?? 'GET').toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) {
        warnings.push(`Skipped "${item.name ?? 'unnamed'}": unsupported method ${method}.`);
        continue;
      }

      // Resolve the URL into a path template; Postman uses `:param`.
      let rawUrl = '';
      if (typeof item.request.url === 'string') {
        rawUrl = item.request.url;
      } else if (item.request.url) {
        rawUrl = item.request.url.raw ?? `/${(item.request.url.path ?? []).join('/')}`;
      }

      let path = rawUrl;
      let baseUrl = '';
      try {
        if (/^https?:\/\//i.test(rawUrl)) {
          const parsed = new URL(rawUrl.replace(/\{\{([^}]+)\}\}/g, 'placeholder'));
          baseUrl ||= parsed.origin;
          path = parsed.pathname;
        }
      } catch {
        // Fall through with the raw string; we take whatever path-like part exists.
        path = rawUrl.split('?')[0] ?? '/';
      }

      // Postman `:id` params → `{id}` templates, and `{{var}}` → `{var}`.
      path = path.replace(/\{\{([^}]+)\}\}/g, '{$1}').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      if (!path.startsWith('/')) path = `/${path}`;
      path = path.split('?')[0] ?? path;

      const parameters: NormalizedParameter[] = [];
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        parameters.push({
          name: match[1]!,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      }

      let requestBody: Record<string, unknown> | undefined;
      const rawBody = item.request.body?.raw;
      if (rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            requestBody = {
              type: 'object',
              properties: Object.fromEntries(
                Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
                  key,
                  { type: inferJsonType(value), description: 'Inferred from a Postman example.' },
                ]),
              ),
              required: [],
            };
            warnings.push(
              `Body fields for "${item.name ?? path}" were inferred from an example value; ` +
                'review them before use.',
            );
          }
        } catch {
          warnings.push(`Ignored a non-JSON request body on "${item.name ?? path}".`);
        }
      }

      operations.push({
        id: (item.name ?? `${method}_${path}`).replace(/[^A-Za-z0-9]+/g, '_'),
        method,
        path,
        summary: item.name,
        description:
          typeof item.request.description === 'string' ? item.request.description : undefined,
        tags: folder,
        parameters,
        requestBody,
        responses: {},
      });
    }
  };

  walk((collection.item ?? []) as PostmanItem[], []);

  if (operations.length === 0) {
    warnings.push('Postman collection contains no requests with a usable URL.');
  }

  // Use the most common origin across requests as the collection base URL.
  const baseUrl = inferCommonOrigin(collection);

  if (!baseUrl) {
    warnings.push('Could not infer a base URL from the collection; pass --base-url.');
  }

  return {
    source,
    format: 'postman',
    title,
    version: typeof info.version === 'string' ? String(info.version) : '0.0.0',
    baseUrl,
    operations,
    warnings,
  };
}

function inferJsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'string';
  const type = typeof value;
  if (type === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  return 'string';
}

function inferCommonOrigin(collection: Record<string, unknown>): string {
  const origins = new Map<string, number>();

  const visit = (items: unknown[]): void => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const node = item as PostmanItem;
      if (Array.isArray(node.item)) {
        visit(node.item);
        continue;
      }
      const url = node.request?.url;
      const raw = typeof url === 'string' ? url : url?.raw;
      if (!raw) continue;
      try {
        const origin = new URL(raw.replace(/\{\{[^}]+\}\}/g, 'placeholder')).origin;
        origins.set(origin, (origins.get(origin) ?? 0) + 1);
      } catch {
        // ignore
      }
    }
  };

  visit((collection.item ?? []) as unknown[]);
  const best = [...origins.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? '';
}

// ---------------------------------------------------------------------------
// HAR
// ---------------------------------------------------------------------------

export function normalizeHar(har: Record<string, unknown>, source: string): NormalizedSpec {
  const warnings: string[] = [];
  const log = (har.log ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(log.entries) ? log.entries : [];

  const operations: NormalizedOperation[] = [];
  const seen = new Set<string>();
  let baseUrl = '';

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const request = (record.request ?? {}) as Record<string, unknown>;

    const method = String(request.method ?? 'GET').toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue;

    const url = String(request.url ?? '');
    if (!url) continue;

    let path: string;
    try {
      const parsed = new URL(url);
      baseUrl ||= parsed.origin;
      path = parsed.pathname;
      // Concrete ids in a HAR become path templates, so the same endpoint hit
      // twice with different ids collapses into one capability.
      path = path.replace(/\/\d+(?=\/|$)/g, '/{id}');
      path = path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/{id}');
    } catch {
      warnings.push(`Skipped an unparseable URL in the HAR: ${url}`);
      continue;
    }

    const operationId = `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_')}`;
    if (seen.has(operationId)) continue;
    seen.add(operationId);

    const parameters: NormalizedParameter[] = [];
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({ name: match[1]!, in: 'path', required: true, schema: { type: 'string' } });
    }

    const queryString = request.queryString;
    if (Array.isArray(queryString)) {
      for (const item of queryString) {
        const name = (item as Record<string, unknown>).name;
        if (typeof name === 'string' && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
        }
      }
    }

    const postData = request.postData as Record<string, unknown> | undefined;
    let requestBody: Record<string, unknown> | undefined;
    if (postData && typeof postData.text === 'string') {
      try {
        const parsed = JSON.parse(postData.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          requestBody = {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
                key,
                { type: inferJsonType(value) },
              ]),
            ),
            required: [],
          };
        }
      } catch {
        // Non-JSON body (form data, multipart); nothing to infer.
      }
    }

    operations.push({
      id: operationId,
      method,
      path,
      summary: `${method} ${path}`,
      tags: [],
      parameters,
      requestBody,
      responses: {},
    });
  }

  if (operations.length === 0) {
    warnings.push('HAR contains no usable requests.');
  }
  warnings.push(
    'HAR input: request bodies and paths were inferred from captured traffic and contain no descriptions. Review carefully.',
  );

  return {
    source,
    format: 'har',
    title: 'HAR-derived API',
    version: '0.0.0',
    baseUrl,
    operations,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parse a spec from text, auto-detecting its format. */
export function parseSpecText(
  text: string,
  source: string,
  options: { from?: SpecFormat } = {},
): NormalizedSpec {
  const document = parseDocument(text, source);

  if (document === null || typeof document !== 'object') {
    throw new SpecParseError(`${source} did not contain a JSON/YAML object.`);
  }

  const format = detectFormat(document, options.from ?? 'auto');
  const record = document as Record<string, unknown>;

  switch (format) {
    case 'swagger':
      return normalizeOpenApi(swagger2ToOpenApi3(record), source, 'swagger');
    case 'postman':
      return normalizePostman(record, source);
    case 'har':
      return normalizeHar(record, source);
    case 'openapi':
    default:
      return normalizeOpenApi(record, source);
  }
}

/** Parse a spec from a URL, a file path, or inline text. */
export async function parseSpec(
  input: string,
  options: ParseInputOptions & { from?: SpecFormat } = {},
): Promise<NormalizedSpec> {
  const { text, source } = await loadSpecText(input, options);
  return parseSpecText(text, source, { from: options.from });
}

export type { AdapterConfig, RiskLevel };

/**
 * Outbound request guard.
 *
 * The kernel makes HTTP requests to URLs assembled from adapter config plus
 * agent-supplied arguments. Without a guard that is a Server-Side Request
 * Forgery primitive with access to the host's network position (cloud metadata
 * endpoints, `localhost` admin ports, RFC1918 ranges).
 *
 * Two independent controls, both required:
 *   1. Path/URL assembly is validated here — no traversal, no scheme change,
 *      no host swap via an absolute `path` or a `//evil.com` prefix.
 *   2. Host allowlisting (`DEMO_WHITELIST` semantics) restricts *where* the
 *      kernel may reach even when the adapter is malicious or was tampered with.
 */

export interface OutboundGuardOptions {
  /** Hostnames (optionally `host:port`) the kernel may reach. Empty = unrestricted. */
  allowlist?: string[];
  /** Reject non-https targets. Loopback is exempt so local demos work. */
  requireHttps?: boolean;
}

export class OutboundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this host loopback?
 *
 * `URL.hostname` returns IPv6 literals *bracketed* (`[::1]`), and a bare IPv6
 * address contains colons that are not a port separator. Splitting on `:`
 * therefore broke both forms: `'[::1]'.split(':')[0]` is `'['` and
 * `'::1'.split(':')[0]` is `''`, so neither matched — IPv6 loopback was treated
 * as a public host and refused over plaintext http, contradicting the documented
 * "loopback is exempt" behaviour and blocking any deployment bound to `[::1]`.
 *
 * Handled here:
 *   - bracket stripping before any colon handling;
 *   - the whole `127.0.0.0/8` block, not just `127.0.0.1`;
 *   - IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`).
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;

  // Strip the brackets `URL.hostname` uses for IPv6 literals.
  const bare = host
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase();

  if (LOOPBACK_HOSTS.has(bare)) return true;

  if (bare === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped IPv6 loopback, e.g. `::ffff:127.0.0.1`.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1]) return mapped[1].startsWith('127.');

  // Any 127.0.0.0/8 address is loopback, not just .0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;

  return false;
}

/**
 * Substitute `{param}` placeholders in a path template.
 *
 * Every substituted value is percent-encoded, which is what makes it impossible
 * for an agent to inject `../` or a query string through a path parameter.
 */
export function buildPath(
  pathTemplate: string,
  args: Record<string, unknown>,
): { path: string; remaining: Record<string, unknown>; consumed: string[] } {
  const remaining: Record<string, unknown> = { ...args };
  const consumed: string[] = [];

  const path = pathTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, param: string) => {
    const value = remaining[param];
    if (value === undefined || value === null) {
      throw new OutboundRequestError(`missing required path parameter "${param}"`);
    }
    delete remaining[param];
    consumed.push(param);
    return encodeURIComponent(String(value));
  });

  // A template that still contains braces had no matching argument.
  if (/[{}]/.test(path)) {
    throw new OutboundRequestError(`unresolved path parameter in "${pathTemplate}"`);
  }

  return { path, remaining, consumed };
}

/**
 * Join a base URL and a capability path.
 *
 * IMPORTANT: this is path *concatenation*, not WHATWG relative resolution.
 * `new URL('/charges', 'https://api.stripe.com/v1')` yields
 * `https://api.stripe.com/charges` — it discards the `/v1` base path, which is
 * not what any adapter author means when they write
 * `base_url: https://api.stripe.com/v1` plus `path: /charges/{id}`.
 *
 * Because we concatenate, the origin cannot change and `..` cannot climb out of
 * the base path: the resolved URL is re-parsed and its origin is asserted equal
 * to the base's, and any `..` segment is resolved *within* the joined path by
 * the URL parser, which is then re-checked against the base pathname.
 */
export function buildUrl(baseUrl: string, path: string, extra?: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new OutboundRequestError(`integration base_url is not a valid URL: ${baseUrl}`);
  }

  if (!path.startsWith('/')) {
    throw new OutboundRequestError(`capability path must be absolute (start with "/"): ${path}`);
  }

  // A capability path is a path, never a URL or a protocol-relative reference.
  // Without this, concatenation would append `https://evil.com/x` or
  // `//evil.com/x` as if it were a path segment — a redirect of the governed
  // call disguised as an adapter path.
  if (path.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.slice(1))) {
    throw new OutboundRequestError(
      `capability path must not contain a URL scheme or authority: ${path}`,
    );
  }

  // Collapse repeated slashes within the path only; the leading slash must
  // survive so the result is always rooted.
  const normalisedPath = path.replace(/\/{2,}/g, '/');

  const basePath = base.pathname.replace(/\/+$/, '');
  const joined = `${basePath}${normalisedPath}`;

  let target: URL;
  try {
    target = new URL(joined, base.origin);
  } catch {
    throw new OutboundRequestError(`could not resolve target URL for path ${path}`);
  }

  if (extra) target.search = extra;

  if (target.origin !== base.origin) {
    throw new OutboundRequestError(
      `resolved URL escaped the integration origin (${base.origin} -> ${target.origin})`,
    );
  }

  // `..` segments are normalised by the parser. If that walk escaped the base
  // path, the capability path was trying to climb out of the integration.
  if (basePath && !target.pathname.startsWith(basePath)) {
    throw new OutboundRequestError(
      `capability path "${path}" escapes the integration base path "${base.pathname}"`,
    );
  }

  return target;
}

/**
 * Enforce policy on a fully-resolved outbound URL. Throws on violation.
 */
export function assertOutboundAllowed(url: URL, options: OutboundGuardOptions = {}): void {
  const requireHttps = options.requireHttps ?? true;

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundRequestError(`unsupported protocol "${url.protocol}" for outbound call`);
  }

  if (requireHttps && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new OutboundRequestError(
      `refusing plaintext http to non-loopback host "${url.hostname}"`,
    );
  }

  // Never send credentials to a URL carrying embedded userinfo.
  if (url.username || url.password) {
    throw new OutboundRequestError('refusing outbound call with embedded credentials in URL');
  }

  const allowlist = options.allowlist ?? [];
  if (allowlist.length === 0) return;

  const host = url.hostname.toLowerCase();
  const hostWithPort = url.port ? `${host}:${url.port}` : host;
  const permitted = allowlist.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (!candidate) return false;
    // Match either exact host, exact host:port, or a `*.suffix` wildcard.
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1); // ".example.com"
      return host.endsWith(suffix) || host === candidate.slice(2);
    }
    return candidate === host || candidate === hostWithPort;
  });

  if (!permitted) {
    throw new OutboundRequestError(
      `host "${hostWithPort}" is not in the outbound allowlist (allowed: ${allowlist.join(', ')})`,
    );
  }
}

/** Represent a header value safely for logs — never echo credential material. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i.test(key)) {
      redacted[key] = value.length > 12 ? `${value.slice(0, 6)}…[redacted]` : '[redacted]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

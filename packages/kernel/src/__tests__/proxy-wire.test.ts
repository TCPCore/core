import { describe, expect, it } from 'vitest';
import { GovernedProxy } from '../proxy.js';
import type { Actor, KernelCapabilityRecord, AuditSink } from '../types.js';

/**
 * Wire-level regression tests for `GovernedProxy`.
 *
 * `fetchImpl` is injectable, so these assert on the request that would actually
 * leave the process — the URL, the body and the headers — rather than trusting
 * the implementation to have assembled them correctly.
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function capability(overrides: Partial<KernelCapabilityRecord> = {}): KernelCapabilityRecord {
  return {
    id: 'cap_1',
    integrationId: 'int_1',
    integrationName: 'test',
    name: 'post_comment',
    fullName: 'test.post_comment',
    description: 'post a comment',
    method: 'POST',
    pathTemplate: '/tickets/{ticketId}/comments',
    riskLevel: 'low',
    approvalRequired: false,
    agentForbidden: false,
    contentRisk: null,
    deprecated: false,
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['ticketId', 'body'],
      additionalProperties: false,
    },
    outputSchema: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const actor: Actor = { id: 'agent_abc123', name: 'Agent', type: 'AGENT', capabilities: ['*'] };

function makeProxy(
  capture: Captured[],
  opts: { forwardActorHeaders?: boolean; fetchImpl?: typeof fetch; requireHttps?: boolean } = {},
): GovernedProxy {
  // `AuditSink` is a single method: `record`. This fake previously also declared a
  // `query` member, which the interface does not have — harmless at runtime, and a
  // type error the moment the typecheck runner is enabled. The cast is deliberate:
  // the proxy only ever calls `record`, and constructing a full `AuditLog` here
  // would test the audit row shape rather than the proxy's wire behaviour.
  const auditor = {
    record: async () => ({ id: 'audit_1' }),
  } as unknown as AuditSink;

  const fetchImpl =
    opts.fetchImpl ??
    (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key] = String(value);
      }
      capture.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        headers,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

  return new GovernedProxy({
    auditor,
    tokenBroker: {
      getAuthHeader: async () => ({ headers: {}, mechanism: 'none', refreshed: false }),
    },
    requireHttps: opts.requireHttps ?? false,
    fetchImpl,
  });
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int_1',
    name: 'test',
    baseUrl: 'http://127.0.0.1:9',
    authType: 'none',
    ...overrides,
  };
}

describe('GovernedProxy — path parameters must not be duplicated into the body', () => {
  it('sends only non-path arguments in a POST body', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    await proxy.call({
      integration: integration(),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'hello' },
      actor,
    });

    expect(captured).toHaveLength(1);
    const sent = captured[0]!;

    // The path parameter appears in the path...
    expect(sent.url).toBe('http://127.0.0.1:9/tickets/T-1/comments');
    // ...and must NOT appear again in the body.
    expect(sent.body).toBeDefined();
    expect(JSON.parse(sent.body!)).toEqual({ body: 'hello' });
    expect(sent.body).not.toContain('T-1');
  });

  it('encodes a path parameter so it cannot escape the path', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    await proxy.call({
      integration: integration(),
      capability: capability(),
      args: { ticketId: '../../admin', body: 'x' },
      actor,
    });

    const sent = captured[0]!;
    expect(sent.url).not.toContain('../');
    expect(sent.url).toContain('..%2F..%2Fadmin');
  });

  it('still puts all arguments in the query string for GET', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    await proxy.call({
      integration: integration(),
      capability: capability({
        method: 'GET',
        pathTemplate: '/tickets/{ticketId}',
        inputSchema: {
          type: 'object',
          properties: { ticketId: { type: 'string' }, expand: { type: 'string' } },
          required: ['ticketId'],
          additionalProperties: false,
        },
      }),
      args: { ticketId: 'T-9', expand: 'comments' },
      actor,
    });

    const sent = captured[0]!;
    expect(sent.url).toBe('http://127.0.0.1:9/tickets/T-9?expand=comments');
    expect(sent.body).toBeUndefined();
  });
});

describe('GovernedProxy — actor identity headers are opt-in', () => {
  it('does not leak actor headers to a third-party integration', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    await proxy.call({
      integration: integration({ name: 'salesforce', baseUrl: 'http://127.0.0.1:9' }),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'x' },
      actor,
    });

    const headers = captured[0]!.headers;
    expect(headers['x-tcpcore-actor-id']).toBeUndefined();
    expect(headers['x-tcpcore-actor-type']).toBeUndefined();
    expect(headers['x-tcpcore-on-behalf-of']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('agent_abc123');
  });

  it('forwards actor headers when the integration opts in', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    await proxy.call({
      integration: integration({ forwardActorHeaders: true }),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'x' },
      actor,
    });

    const headers = captured[0]!.headers;
    expect(headers['x-tcpcore-actor-id']).toBe('agent_abc123');
    expect(headers['x-tcpcore-actor-type']).toBe('AGENT');
  });
});

describe('GovernedProxy — policy denials are not reported as failures', () => {
  it('returns denied (403-shaped) when the SSRF guard refuses the target', async () => {
    const captured: Captured[] = [];
    // requireHttps on: plaintext http to a public host is refused by the guard.
    const proxy = makeProxy(captured, { requireHttps: true });
    const result = await proxy.call({
      integration: integration({ baseUrl: 'http://93.184.216.34' }),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'x' },
      actor,
    });

    expect(captured).toHaveLength(0);
    expect(result.status).toBe('denied');
    expect(result).toMatchObject({ reason: expect.stringContaining('plaintext http') });
    expect(result.auditId).toBe('audit_1');
  });

  it('returns denied when arguments fail the declared schema', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured);

    const result = await proxy.call({
      integration: integration(),
      capability: capability(),
      args: { ticketId: 'T-1' }, // `body` is required
      actor,
    });

    expect(captured).toHaveLength(0);
    expect(result.status).toBe('denied');
    expect(result).toMatchObject({ reason: expect.stringContaining('input validation failed') });
  });

  it('still returns failed for a genuine transport error', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured, {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const result = await proxy.call({
      integration: integration(),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'x' },
      actor,
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ error: expect.stringContaining('target call failed') });
  });
});

describe('GovernedProxy — a redirect is never followed', () => {
  it('refuses a 302 and reports it as a failure', async () => {
    const captured: Captured[] = [];
    const proxy = makeProxy(captured, {
      fetchImpl: (async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example.com/' },
        })) as unknown as typeof fetch,
    });

    const result = await proxy.call({
      integration: integration(),
      capability: capability(),
      args: { ticketId: 'T-1', body: 'x' },
      actor,
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ error: expect.stringContaining('redirect') });
  });
});

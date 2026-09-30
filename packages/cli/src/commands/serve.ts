import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Kernel, MemoryStore, newId } from '@tcpcore1/kernel';
import type { Actor } from '@tcpcore1/kernel';
import { loadAdapterFile } from '@tcpcore1/adapters';
import pc from 'picocolors';
import { flagBoolean, flagNumber, flagString, type ParsedArgv } from '../lib/commands.js';
import { symbols, write, writeErr } from '../lib/output.js';

/**
 * `tcpctl serve` — run the governance kernel locally against adapter files.
 *
 * Uses {@link MemoryStore}, so no database is required. That is the whole point:
 * a developer can go from "here is an OpenAPI spec" to "here is a governed,
 * MCP-callable surface" without provisioning anything.
 *
 * The HTTP surface mirrors `apps/api` so a Cursor/Claude Desktop config written
 * against this server keeps working after a deploy.
 */
export async function runServe(parsed: ParsedArgv): Promise<number> {
  if (parsed.positionals.length === 0) {
    writeErr(
      `${symbols.fail} No adapter files given. Usage: ${pc.bold('tcpctl serve <files...>')}`,
    );
    return 1;
  }

  const port = flagNumber(parsed, '--port', 8080);
  const allowlist = (flagString(parsed, '--allow-host') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const kernel = new Kernel({
    store: new MemoryStore(),
    requireHttps: !flagBoolean(parsed, '--allow-http'),
    outboundHostAllowlist: allowlist,
    sanitizeAllResponses: flagBoolean(parsed, '--sanitize-all'),
  });

  await kernel.start();

  // ------------------------------------------------------------ load adapters
  let loaded = 0;
  const failures: Array<{ file: string; error: string }> = [];

  for (const file of parsed.positionals) {
    try {
      const adapter = await loadAdapterFile(file);
      const result = await kernel.registerAdapter(adapter, { enabled: true });
      loaded += 1;
      write(
        `${symbols.ok} ${adapter.name} ${pc.dim(`(${result.capabilities.length} capabilit${result.capabilities.length === 1 ? 'y' : 'ies'}, auth: ${adapter.auth.type})`)}`,
      );
    } catch (error) {
      failures.push({ file, error: (error as Error).message });
      writeErr(`${symbols.fail} ${file}`);
      writeErr(`    ${(error as Error).message}`);
    }
  }

  if (loaded === 0) {
    writeErr('');
    writeErr(`${symbols.fail} No adapters loaded; nothing to serve.`);
    return 1;
  }

  // ------------------------------------------------------------------- router
  const app = new Hono();

  /**
   * Local development actors. `serve` is a development tool with no user store,
   * so identity is chosen by the request rather than authenticated. This is
   * stated in the startup banner and is deliberately not a pattern the API
   * follows.
   */
  const actorFromRequest = (c: {
    req: {
      query: (key: string) => string | undefined;
      header: (key: string) => string | undefined;
    };
  }): Actor => {
    const asAgent = c.req.query('as') !== 'human';
    const name = c.req.header('x-tcpcore-actor-name') ?? (asAgent ? 'local-agent' : 'local-human');

    // A local agent is granted every loaded capability so the developer can
    // exercise the risk gate; the gate still blocks high risk and agent_forbidden.
    const grants = asAgent
      ? kernel.registry.listCapabilities().map((capability) => capability.fullName)
      : [];

    return {
      id: asAgent ? 'agent_local' : 'user_local',
      name,
      type: asAgent ? 'AGENT' : 'HUMAN',
      capabilities: grants,
    };
  };

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      mode: 'tcpctl serve',
      agentsEnabled: kernel.isAgentsEnabled(),
      integrations: kernel.registry.stats().integrations,
      capabilities: kernel.registry.stats().capabilities,
    }),
  );

  app.get('/api/system/status', async (c) => {
    const status = await kernel.status();
    return c.json({ ...status, activeAgents: 0, demoMode: false });
  });

  app.get('/api/integrations', (c) => c.json({ integrations: kernel.registry.listIntegrations() }));

  app.get('/api/capabilities', (c) =>
    c.json({ capabilities: kernel.registry.listCapabilities({ includeDeprecated: true }) }),
  );

  /** The single governed entry point. */
  app.post('/api/capabilities/:name/invoke', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const requestId = newId('req');

    let body: { args?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const result = await kernel.invoke(name, body?.args ?? {}, actorFromRequest(c), { requestId });

    const status =
      result.status === 'executed'
        ? 200
        : result.status === 'pending_approval'
          ? 202
          : result.status === 'denied'
            ? 403
            : 400;

    return c.json({ ...result, requestId }, status as 200);
  });

  app.get('/api/approvals', async (c) => c.json({ items: await kernel.approvals.list('PENDING') }));

  app.get('/api/audit-log', async (c) => {
    const query = c.req.query();
    const result = await kernel.queryAudit({
      actorType: query.actorType as 'HUMAN' | 'AGENT' | undefined,
      targetSystem: query.targetSystem,
      capabilityName: query.capabilityName,
      search: query.search,
      limit: Number(query.limit ?? 50),
      page: Number(query.page ?? 1),
    });
    return c.json(result);
  });

  app.get('/api/mcp/manifest', (c) => c.json(kernel.mcpManifest()));
  app.get('/api/mcp/tools', (c) => {
    const tools = kernel.mcpTools();
    return c.json({ tools, count: tools.length });
  });

  /**
   * JSON-RPC 2.0 MCP endpoint, so a real MCP client (Cursor, Claude Desktop) can
   * connect. The manifest alone is not a transport.
   */
  app.post('/api/mcp', async (c) => {
    let request: {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      request = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const id = request.id ?? null;

    if (request.method === 'initialize') {
      return c.json({ jsonrpc: '2.0', id, result: kernel.mcpServerInfo() });
    }

    if (request.method === 'tools/list') {
      return c.json({ jsonrpc: '2.0', id, result: { tools: kernel.mcpTools() } });
    }

    if (request.method === 'tools/call') {
      const params = request.params ?? {};
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      if (!name) {
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'tools/call requires a "name"' },
        });
      }

      const result = await kernel.invoke(name, args, actorFromRequest(c));

      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: result.status === 'denied' || result.status === 'failed',
        },
      });
    }

    if (request.method === 'notifications/initialized') {
      return c.body(null, 204);
    }

    return c.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
  });

  // ------------------------------------------------------------------- listen
  const server = serve({ fetch: app.fetch, port }, (info) => {
    write('');
    write(`${pc.bold('TCPcore kernel')} listening on ${pc.cyan(`http://localhost:${info.port}`)}`);
    write('');
    write(`  ${pc.dim('MCP manifest')}   GET  /api/mcp/manifest`);
    write(`  ${pc.dim('MCP JSON-RPC')}   POST /api/mcp`);
    write(`  ${pc.dim('Tool call')}      POST /api/mcp/tools/call`);
    write(`  ${pc.dim('Capabilities')}   GET  /api/capabilities`);
    write(`  ${pc.dim('Invoke')}         POST /api/capabilities/:name/invoke`);
    write(`  ${pc.dim('Audit')}          GET  /api/audit-log`);
    write('');
    write(`  ${pc.dim('MCP tools exposed:')} ${kernel.mcpTools().length}`);
    write(
      pc.yellow(
        '  Development mode: identity comes from ?as=agent|human, not authentication. ' +
          'Do not expose this port publicly.',
      ),
    );
    write('');
  });

  // Keep the process alive and shut down cleanly.
  const shutdown = () => {
    write('');
    write(`${symbols.info} Shutting down.`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise<number>(() => {
    // Resolves only on shutdown; `serve` is a foreground command.
  });
}

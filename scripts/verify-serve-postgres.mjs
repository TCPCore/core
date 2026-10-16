/**
 * End-to-end proof of `tcpctl serve --store postgres` against a real server.
 *
 * The store-level proof is `verify-postgres-store.mjs`. This one proves the wiring:
 * that the CLI actually selects the Postgres store, binds the tenant it was told
 * to, writes rows under that tenant, and leaves its in-memory default alone.
 *
 * Run from the repository root, after `pnpm build`:
 *
 *   node scripts/verify-serve-postgres.mjs
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

const REPO_ROOT = process.cwd();
const TEST_SERVICES =
  process.env.TCPCORE_TEST_SERVICES ??
  join(process.env.LOCALAPPDATA ?? os.homedir(), 'tcpcore-test-services');

const PORT = Number(process.env.PGPORT ?? 54329);
const USER = process.env.PGUSER ?? 'postgres';
const PASSWORD = process.env.PGPASSWORD ?? 'tcpcore_demo_pw';
const DATABASE = process.env.PGDATABASE ?? 'tcpcore_demo';
const HOST = '127.0.0.1';
const SERVE_PORT = 8099;
const TENANT = 'tenant_cli_proof';

const DATA_DIR = join(os.tmpdir(), 'tcpcore-pg-cli-verify-data');
const CONNECTION_STRING = `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`;

const line = (char = '=') => console.log(char.repeat(78));
const step = (message) => console.log(`\n--- ${message}`);

function resolveFromTestServices(specifier) {
  return createRequire(join(TEST_SERVICES, 'package.json')).resolve(specifier);
}

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the CLI, capturing output via a log file (no piped stdio). */
function runCli(args, env, logName) {
  const logPath = join(os.tmpdir(), logName);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'), ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, out, err, logPath });
    });
  });
}

async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVE_PORT}/health`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(400);
  }
  return false;
}

const ADAPTER = 'adapters/builtin/internal.yaml';

async function main() {
  line();
  console.log('tcpctl serve --store postgres verification');
  line();
  console.log(`repo          : ${REPO_ROOT}`);
  console.log(`adapter       : ${ADAPTER}`);
  console.log(`connect       : ${HOST}:${PORT}/${DATABASE}`);
  console.log(`serve port    : ${SERVE_PORT}`);
  console.log(`tenant        : ${TENANT}`);

  const { default: EmbeddedPostgres } = await import(
    pathToFileURL(resolveFromTestServices('embedded-postgres')).href
  );
  const pgModule = await import(pathToFileURL(resolveFromTestServices('pg')).href);
  const { Pool } = pgModule.default ?? pgModule;

  // ------------------------------------------------------------------- boot
  step('1. Boot the database and apply the schema');
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const cluster = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    authMethod: 'password',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });

  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase(DATABASE);
  console.log(`  cluster up on ${PORT}, database "${DATABASE}" created`);

  const admin = new Pool({ connectionString: CONNECTION_STRING, max: 2 });
  const kernelModule = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/kernel/dist/index.js')).href
  );
  await kernelModule.createPostgresSchema({ query: (t, v) => admin.query(t, v) });
  console.log('  schema applied');

  const countRows = async (table, tenantId) => {
    const result = await admin.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0].n;
  };

  // -------------------------------------------------- the default is untouched
  step('2. Memory mode is still the default and needs no database');
  // Deliberately pointed at a port with nothing on it: if any code path tried to
  // reach a database without --store postgres, this would fail.
  const memoryServer = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'),
      'serve',
      ADAPTER,
      '--port',
      String(SERVE_PORT),
      '--allow-http',
      '--allow-host',
      'localhost,127.0.0.1',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nothing' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let memoryLog = '';
  memoryServer.stdout.on('data', (chunk) => {
    memoryLog += chunk;
  });
  memoryServer.stderr.on('data', (chunk) => {
    memoryLog += chunk;
  });

  try {
    const healthy = await waitForHealth();
    check('memory mode responds on /health with no reachable database', healthy);
    check(
      'banner reports in-memory storage',
      /Storage\s+in-memory/.test(memoryLog),
      memoryLog
        .split('\n')
        .find((l) => l.includes('Storage'))
        ?.trim(),
    );
    const audit = await get(`http://127.0.0.1:${SERVE_PORT}/api/audit-log?limit=5`);
    check(
      'memory mode serves the audit endpoint',
      audit.status === 200,
      `total=${audit.body?.total}`,
    );
  } finally {
    memoryServer.kill();
    await sleep(1200);
  }

  // ------------------------------------------------------------ postgres mode
  step('3. Start tcpctl serve --store postgres');
  const server = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'),
      'serve',
      ADAPTER,
      '--port',
      String(SERVE_PORT),
      '--store',
      'postgres',
      '--database-url',
      CONNECTION_STRING,
      '--tenant-id',
      TENANT,
      '--allow-http',
      '--allow-host',
      'localhost,127.0.0.1',
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });

  try {
    const healthy = await waitForHealth();
    console.log(serverLog.trimEnd());
    check('the Postgres-backed server came up', healthy);
    check(
      'banner reports postgres storage and the bound tenant',
      /Storage\s+postgres \(tenant tenant_cli_proof\)/.test(serverLog),
      serverLog
        .split('\n')
        .find((l) => l.includes('Storage'))
        ?.trim(),
    );

    check(
      'integrations were persisted under the bound tenant',
      (await countRows('kernel_integrations', TENANT)) > 0,
      `rows=${await countRows('kernel_integrations', TENANT)}`,
    );
    check(
      'capabilities were persisted under the bound tenant',
      (await countRows('kernel_capabilities', TENANT)) > 0,
      `rows=${await countRows('kernel_capabilities', TENANT)}`,
    );

    // NOTE on the audit trail and adapter registration.
    //
    // `serve` registers adapters through `Kernel.registerAdapter`, which persists
    // the integration and its capabilities and writes NO audit row. Only
    // `registerAdapterYaml` records a REGISTER action. That is pre-existing
    // behaviour, confirmed against the published 0.1.0 tarball, and this change
    // leaves it alone. The audit trail is therefore populated by governed
    // activity rather than by startup, and step 4 drives a real invocation to
    // produce one.
    check(
      'adapter registration writes no audit row (pre-existing behaviour, unchanged)',
      (await countRows('kernel_audit_log', TENANT)) === 0,
      `rows=${await countRows('kernel_audit_log', TENANT)}`,
    );

    // Nothing may land under a different tenant: this is the structural claim.
    const otherTenants = await admin.query(
      `SELECT DISTINCT tenant_id FROM kernel_integrations WHERE tenant_id <> $1`,
      [TENANT],
    );
    check(
      'no rows were written under any other tenant',
      otherTenants.rowCount === 0,
      otherTenants.rows.map((r) => r.tenant_id).join(', ') || 'none',
    );

    // ------------------------------------------------------------- HTTP reads
    step('4. Produce real governance activity, then read it back over HTTP');
    const health = await get(`http://127.0.0.1:${SERVE_PORT}/health`);
    check('GET /health', health.status === 200, JSON.stringify(health.body));

    const integrations = await get(`http://127.0.0.1:${SERVE_PORT}/api/integrations`);
    check(
      'GET /api/integrations returns the persisted integration',
      integrations.status === 200 && integrations.body.integrations.length > 0,
      `count=${integrations.body?.integrations?.length}`,
    );

    // A low-risk capability invoked by an agent holding the grant. The target host
    // is not running, so the governed call fails at the network, which is fine:
    // the audit row is written on the way through, which is the point.
    const invokeResponse = await fetch(
      `http://127.0.0.1:${SERVE_PORT}/api/capabilities/internal.list_tickets/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: { limit: 5 } }),
      },
    );
    const invokeBody = await invokeResponse.json();
    console.log(
      `  [detail] list_tickets -> status=${invokeBody.status} reason=${invokeBody.reason ?? invokeBody.error ?? '-'}`,
    );
    check(
      'POST /api/capabilities/internal.list_tickets/invoke returns a governed result',
      ['failed', 'executed'].includes(invokeBody.status),
      `status=${invokeBody.status} auditId=${invokeBody.auditId}`,
    );
    check(
      'the governed call carried a real audit id',
      Boolean(invokeBody.auditId),
      invokeBody.auditId,
    );

    // An agent may never close a ticket: a policy denial, which is also audited.
    const deniedResponse = await fetch(
      `http://127.0.0.1:${SERVE_PORT}/api/capabilities/internal.close_ticket/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: { ticketId: 'T-1', status: 'CLOSED' } }),
      },
    );
    const deniedBody = await deniedResponse.json();
    check(
      'a high-risk, agent_forbidden capability is denied',
      deniedBody.status === 'denied' && deniedResponse.status === 403,
      `status=${deniedBody.status} http=${deniedResponse.status}`,
    );

    check(
      'the audit rows were written to PostgreSQL under the bound tenant',
      (await countRows('kernel_audit_log', TENANT)) >= 2,
      `rows=${await countRows('kernel_audit_log', TENANT)}`,
    );

    const audit = await get(`http://127.0.0.1:${SERVE_PORT}/api/audit-log?limit=10`);
    check(
      'GET /api/audit-log reads the persisted audit trail',
      audit.status === 200 && audit.body.total > 0,
      `total=${audit.body?.total}`,
    );

    const status = await get(`http://127.0.0.1:${SERVE_PORT}/api/system/status`);
    check(
      'GET /api/system/status counts the persisted audit records',
      status.status === 200 && status.body.auditRecords > 0,
      `auditRecords=${status.body?.auditRecords}`,
    );

    const searched = await get(`http://127.0.0.1:${SERVE_PORT}/api/audit-log?search=list_tickets`);
    check(
      'the audit search predicate runs in SQL',
      searched.status === 200 && searched.body.total > 0,
      `total=${searched.body?.total}`,
    );
  } finally {
    server.kill();
    await sleep(1200);
  }

  // --------------------------------------------- restart reads what was written
  step('5. A restart sees the state the first run persisted');
  const restarted = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'),
      'serve',
      ADAPTER,
      '--port',
      String(SERVE_PORT),
      '--store',
      'postgres',
      '--database-url',
      CONNECTION_STRING,
      '--tenant-id',
      TENANT,
      '--allow-http',
      '--allow-host',
      'localhost,127.0.0.1',
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let restartLog = '';
  restarted.stdout.on('data', (c) => {
    restartLog += c;
  });
  restarted.stderr.on('data', (c) => {
    restartLog += c;
  });

  try {
    const healthy = await waitForHealth();
    // The capture earns its place only in the case it was written for. When the server does not come
    // up, the reason is in the child's stderr and nowhere else, so it is quoted into the failure
    // rather than accumulated and dropped.
    check(
      'the restarted server came up',
      healthy,
      healthy ? '' : `output=${restartLog.slice(-1200).trim()}`,
    );
    const status = await get(`http://127.0.0.1:${SERVE_PORT}/api/system/status`);
    check(
      'the audit trail survived the restart',
      status.status === 200 && status.body.auditRecords > 0,
      `auditRecords=${status.body?.auditRecords}`,
    );
  } finally {
    restarted.kill();
    await sleep(1200);
  }

  // ------------------------------------------------- cross-tenant through the CLI
  step('6. A serve process bound to a different tenant sees none of it');
  // Same database, same adapters, same process code. Only --tenant-id differs.
  // Invoking the same capability must produce an audit trail the first tenant
  // cannot see, and the first tenant must not be visible to this one.
  const OTHER_TENANT = 'tenant_cli_other';
  const otherServer = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'),
      'serve',
      ADAPTER,
      '--port',
      String(SERVE_PORT),
      '--store',
      'postgres',
      '--database-url',
      CONNECTION_STRING,
      '--tenant-id',
      OTHER_TENANT,
      '--allow-http',
      '--allow-host',
      'localhost,127.0.0.1',
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let otherLog = '';
  otherServer.stdout.on('data', (c) => {
    otherLog += c;
  });
  otherServer.stderr.on('data', (c) => {
    otherLog += c;
  });

  try {
    const healthy = await waitForHealth();
    check(
      'the second tenant server came up',
      healthy,
      healthy ? '' : `output=${otherLog.slice(-1200).trim()}`,
    );

    const beforeOther = await get(`http://127.0.0.1:${SERVE_PORT}/api/audit-log?limit=10`);
    check(
      'tenant_cli_other starts with an empty audit trail',
      beforeOther.status === 200 && beforeOther.body.total === 0,
      `total=${beforeOther.body?.total}`,
    );

    const otherInvoke = await fetch(
      `http://127.0.0.1:${SERVE_PORT}/api/capabilities/internal.list_tickets/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: { limit: 5 } }),
      },
    );
    await otherInvoke.json();

    check(
      'the second tenant writes its own audit row',
      (await countRows('kernel_audit_log', OTHER_TENANT)) > 0,
      `rows=${await countRows('kernel_audit_log', OTHER_TENANT)}`,
    );

    const otherAudit = await get(`http://127.0.0.1:${SERVE_PORT}/api/audit-log?limit=50`);
    check(
      'the second tenant sees only its own audit rows',
      otherAudit.status === 200 && otherAudit.body.total === 1,
      `total=${otherAudit.body?.total}`,
    );

    const firstTenantRows = await admin.query(
      `SELECT COUNT(*)::int AS n FROM kernel_audit_log WHERE tenant_id = $1`,
      [TENANT],
    );
    check(
      'the first tenant audit rows are untouched',
      firstTenantRows.rows[0].n >= 2,
      `rows=${firstTenantRows.rows[0].n}`,
    );

    // Now go back to the first tenant in a fresh process and confirm it cannot see
    // the second tenant's row either. Isolation has to hold in both directions.
    const firstAgain = spawn(
      process.execPath,
      [
        join(REPO_ROOT, 'packages/cli/bin/tcpctl.js'),
        'serve',
        ADAPTER,
        '--port',
        String(SERVE_PORT + 1),
        '--store',
        'postgres',
        '--database-url',
        CONNECTION_STRING,
        '--tenant-id',
        TENANT,
        '--allow-http',
        '--allow-host',
        'localhost,127.0.0.1',
      ],
      { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const deadline = Date.now() + 30_000;
      let up = false;
      while (Date.now() < deadline && !up) {
        try {
          up = (await fetch(`http://127.0.0.1:${SERVE_PORT + 1}/health`)).ok;
        } catch {
          await sleep(400);
        }
      }
      check('the first tenant server came back up', up);
      const firstAudit = await get(`http://127.0.0.1:${SERVE_PORT + 1}/api/audit-log?limit=50`);
      check(
        'the first tenant still sees only its own rows, not the second tenant row',
        firstAudit.status === 200 && firstAudit.body.total >= 2,
        `total=${firstAudit.body?.total}`,
      );
      // Its own rows are exactly the ones it wrote, so the count must not include
      // the other tenant's single row.
      const baseline = firstTenantRows.rows[0].n;
      check(
        'the first tenant row count equals what it wrote itself',
        firstAudit.body.total === baseline,
        `served=${firstAudit.body.total} stored=${baseline}`,
      );
    } finally {
      firstAgain.kill();
      await sleep(1200);
    }
  } finally {
    otherServer.kill();
    await sleep(1200);
  }

  // ------------------------------------------------------ failure is explicit
  step('7. A bad database URL fails at startup, not at request time');
  const badRun = await runCli(
    [
      'serve',
      ADAPTER,
      '--port',
      String(SERVE_PORT),
      '--store',
      'postgres',
      '--database-url',
      'postgres://nobody:nobody@127.0.0.1:1/nothing',
    ],
    {},
    'cli-bad-db.log',
  );
  check('exit code is non-zero', badRun.code !== 0, `code=${badRun.code}`);
  check(
    'the error names the problem and suggests the schema',
    /Could not use PostgreSQL/.test(badRun.out + badRun.err) &&
      /schema/.test(badRun.out + badRun.err),
    (badRun.out + badRun.err).trim().split('\n').slice(0, 3).join(' | '),
  );

  step('8. Omitting --database-url is a usage error');
  const noUrl = await runCli(
    ['serve', ADAPTER, '--store', 'postgres'],
    { DATABASE_URL: '' },
    'cli-no-url.log',
  );
  check('exit code is non-zero', noUrl.code !== 0, `code=${noUrl.code}`);
  check(
    'the error says --database-url is required',
    /requires --database-url/.test(noUrl.out + noUrl.err),
    (noUrl.out + noUrl.err).trim().split('\n')[0],
  );

  await admin.end();

  line();
  console.log(
    failures === 0 ? 'RESULT: all CLI checks passed' : `RESULT: ${failures} CHECK(S) FAILED`,
  );
  line();

  await cluster.stop().catch(() => {});
  await sleep(1500);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
  console.log(
    `data directory cleanup: ${existsSync(DATA_DIR) ? 'left in place (in use)' : 'removed'}`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nVERIFICATION ERROR:', error);
  process.exit(1);
});

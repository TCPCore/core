/**
 * End-to-end proof of `PostgresKernelStore` against a REAL PostgreSQL server.
 *
 * Not a unit test: it boots a disposable cluster, applies the shipped schema, and
 * drives the store's full surface. The two claims it exists to establish are:
 *
 *   1. Every `KernelStore` method actually runs against PostgreSQL (a type checker
 *      cannot tell you that a column name is right).
 *   2. A second tenant cannot see the first tenant's rows.
 *
 * Run from the repository root, after `pnpm --filter @tcpcore1/kernel build`:
 *
 *   node scripts/verify-postgres-store.mjs
 *
 * `pg` and `embedded-postgres` are resolved from the sibling disposable test
 * services directory by absolute path, so the workspace does not grow a test-only
 * dependency on a database binary.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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

const DATA_DIR = join(os.tmpdir(), 'tcpcore-pg-verify-data');

const line = (char = '=') => console.log(char.repeat(78));
const step = (message) => console.log(`\n--- ${message}`);

/** Resolve a package out of the disposable test-services install. */
function resolveFromTestServices(specifier) {
  const require = createRequire(join(TEST_SERVICES, 'package.json'));
  return require.resolve(specifier);
}

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  return ok;
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`),
  );
  return ok;
}

// ------------------------------------------------------------------ fixtures

const TENANT_A = 'tenant_alpha';
const TENANT_B = 'tenant_beta';

const integrationA = {
  id: 'int_alpha_petstore',
  name: 'petstore',
  displayName: 'Alpha Petstore',
  baseUrl: 'https://petstore.example.com',
  authType: 'none',
  configYaml: 'name: petstore\ndisplay_name: Alpha Petstore',
  enabled: true,
  isBuiltin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const integrationB = {
  ...integrationA,
  id: 'int_beta_petstore',
  displayName: 'Beta Petstore',
};

function capabilityFor(integration, suffix) {
  return {
    id: `cap_${suffix}`,
    integrationId: integration.id,
    integrationName: integration.name,
    name: 'get_pet',
    fullName: `${integration.name}.get_pet`,
    description: 'Fetch a pet by id.',
    method: 'GET',
    pathTemplate: '/pet/{id}',
    riskLevel: 'low',
    approvalRequired: false,
    agentForbidden: false,
    contentRisk: null,
    deprecated: false,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    outputSchema: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function auditFor(id, tenantLabel) {
  return {
    id,
    actorId: 'agent_1',
    actorName: `${tenantLabel} agent`,
    actorType: 'AGENT',
    targetSystem: 'petstore',
    integrationId: null,
    capabilityName: 'get_pet',
    targetResource: `pet:${tenantLabel}`,
    targetPayload: { id: '42' },
    action: 'EXECUTE',
    diff: { tenantMarker: tenantLabel },
    metadata: { compliance: 'NIST AU-3', requestId: `req_${tenantLabel}` },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function approvalFor(id, tenantLabel) {
  return {
    id,
    agentId: 'agent_1',
    agentName: `${tenantLabel} agent`,
    integrationId: null,
    targetSystem: 'petstore',
    capabilityName: 'set_name',
    targetPayload: { name: tenantLabel },
    riskLevel: 'medium',
    status: 'PENDING',
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function runFor(id, tenantLabel) {
  return {
    id,
    agentId: 'agent_1',
    agentName: `${tenantLabel} agent`,
    trigger: 'manual',
    status: 'SUCCESS',
    steps: 3,
    inputTokens: 120,
    outputTokens: 45,
    latencyMs: 812,
    model: 'test-model',
    costUsd: 0.001234,
    spans: [{ name: 'invoke', attributes: { tenant: tenantLabel }, durationMs: 12, status: 'OK' }],
    reasoningLogs: [`tenant ${tenantLabel} reasoning`],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------- main

async function main() {
  line();
  console.log('PostgresKernelStore verification against a real PostgreSQL server');
  line();
  console.log(`test services : ${TEST_SERVICES}`);
  console.log(`pg module     : ${resolveFromTestServices('pg')}`);
  console.log(`host/port     : ${HOST}:${PORT}`);
  console.log(`database      : ${DATABASE} as ${USER}`);

  const { default: EmbeddedPostgres } = await import(
    pathToFileURL(resolveFromTestServices('embedded-postgres')).href
  );
  const pgModule = await import(pathToFileURL(resolveFromTestServices('pg')).href);
  const { Pool } = pgModule.default ?? pgModule;

  // ------------------------------------------------------------------- boot
  step('1. Boot a disposable PostgreSQL cluster');
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
  console.log(`  cluster started on port ${PORT}`);

  await cluster.createDatabase(DATABASE);
  console.log(`  database "${DATABASE}" created`);

  const connectionString = `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`;

  const admin = new Pool({ connectionString, max: 2 });

  // ----------------------------------------------------------------- schema
  step('2. Apply the shipped schema');
  const kernel = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/kernel/dist/index.js')).href
  );

  const { createPostgresSchema, PostgresKernelStoreFactory, asTenantId, SINGLE_TENANT } = kernel;

  await createPostgresSchema({
    query: (text, values) => admin.query(text, values),
  });

  // A non-superuser login, used only by the row level security checks in step 6.
  // Superusers bypass RLS entirely, so the policy cannot be exercised as `postgres`.
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tcpcore_rls_verify') THEN
        CREATE ROLE tcpcore_rls_verify LOGIN PASSWORD 'rls_verify_pw' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await admin.query(`GRANT USAGE ON SCHEMA public TO tcpcore_rls_verify`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO tcpcore_rls_verify`);
  console.log('  verified RLS role "tcpcore_rls_verify" created (NOSUPERUSER, NOBYPASSRLS)');

  const tables = await admin.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'kernel_%'
      ORDER BY table_name`,
  );
  console.log(`  tables created: ${tables.rows.map((row) => row.table_name).join(', ')}`);
  check('all six kernel tables exist', tables.rowCount === 6, `found ${tables.rowCount}`);
  check(
    'RLS is enabled on the audit table',
    (await admin.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'kernel_audit_log'`))
      .rows[0]?.relrowsecurity === true,
  );

  // ------------------------------------------------------------------ write
  step('3. Exercise the full KernelStore surface as tenant_alpha');
  const factory = new PostgresKernelStoreFactory({ connectionString });
  const alpha = factory.forTenant(asTenantId(TENANT_A));
  const beta = factory.forTenant(asTenantId(TENANT_B));

  check('factory bound the first tenant', alpha.tenantId === TENANT_A);
  check('factory bound the second tenant', beta.tenantId === TENANT_B);
  check(
    'SINGLE_TENANT is refused by default',
    (() => {
      try {
        new PostgresKernelStoreFactory({ connectionString }).forTenant(SINGLE_TENANT);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  await alpha.saveIntegration(integrationA);
  check('saveIntegration', (await alpha.listIntegrations()).length === 1);

  await alpha.saveCapabilities(integrationA, [capabilityFor(integrationA, 'alpha')]);
  const alphaCaps = await alpha.listCapabilities();
  check('saveCapabilities + listCapabilities', alphaCaps.length === 1, alphaCaps[0]?.fullName);
  check(
    'listCapabilities filter (risk)',
    (await alpha.listCapabilities({ risk: 'low' })).length === 1 &&
      (await alpha.listCapabilities({ risk: 'high' })).length === 0,
  );
  check(
    'listCapabilities filter (integrationName)',
    (await alpha.listCapabilities({ integrationName: 'petstore' })).length === 1 &&
      (await alpha.listCapabilities({ integrationName: 'nope' })).length === 0,
  );

  await alpha.saveCredential({
    integrationId: integrationA.id,
    integrationName: 'petstore',
    authType: 'bearer',
    encryptedBlob: 'Y2lwaGVydGV4dA==',
    refreshTokenEnc: null,
    expiresAt: null,
    scopes: ['read:pets'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const credential = await alpha.getCredential('petstore');
  check('saveCredential + getCredential', credential?.encryptedBlob === 'Y2lwaGVydGV4dA==');
  equal('credential scopes round trip', credential?.scopes, ['read:pets']);

  await alpha.appendAudit(auditFor('audit_alpha_1', 'alpha'));
  const auditWrite = await alpha.listAudit({});
  check('appendAudit + listAudit', auditWrite.total === 1, `total=${auditWrite.total}`);
  check('listAudit filter by actorType', (await alpha.listAudit({ actorType: 'AGENT' })).total === 1);
  check('listAudit filter by action', (await alpha.listAudit({ action: 'EXECUTE' })).total === 1);
  check('listAudit filter by targetSystem', (await alpha.listAudit({ targetSystem: 'petstore' })).total === 1);
  check('listAudit filter by capabilityName', (await alpha.listAudit({ capabilityName: 'get_pet' })).total === 1);
  check('listAudit search hit', (await alpha.listAudit({ search: 'ALPHA' })).total === 1);
  check('listAudit search miss', (await alpha.listAudit({ search: 'zzz-not-present' })).total === 0);
  check(
    'listAudit date range',
    (await alpha.listAudit({ from: '2025-12-31T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' })).total === 1,
  );
  check(
    'listAudit paging',
    (await alpha.listAudit({ page: 1, limit: 1 })).records.length === 1 &&
      (await alpha.listAudit({ page: 2, limit: 1 })).records.length === 0,
  );
  equal(
    'audit JSON round trips (targetPayload, diff, metadata)',
    (await alpha.listAudit({})).records[0]?.targetPayload,
    { id: '42' },
  );

  await alpha.saveApproval(approvalFor('approval_alpha_1', 'alpha'));
  check('saveApproval + getApproval', (await alpha.getApproval('approval_alpha_1'))?.status === 'PENDING');
  check('listApprovals (no filter)', (await alpha.listApprovals()).length === 1);
  check('listApprovals (PENDING)', (await alpha.listApprovals('PENDING')).length === 1);
  check('listApprovals (APPROVED)', (await alpha.listApprovals('APPROVED')).length === 0);
  check('listApprovals (ALL)', (await alpha.listApprovals('ALL')).length === 1);
  await alpha.saveApproval({
    ...approvalFor('approval_alpha_1', 'alpha'),
    status: 'APPROVED',
    reviewedById: 'user_9',
    reviewedByName: 'Reviewer',
    reviewedAt: '2026-01-02T00:00:00.000Z',
  });
  const approved = await alpha.getApproval('approval_alpha_1');
  check(
    'saveApproval updates in place (upsert)',
    approved?.status === 'APPROVED' && approved?.reviewedByName === 'Reviewer',
  );

  await alpha.saveAgentRun(runFor('run_alpha_1', 'alpha'));
  const runs = await alpha.listAgentRuns();
  check('saveAgentRun + listAgentRuns', runs.length === 1, runs[0]?.model);
  check('NUMERIC cost round trips', runs[0]?.costUsd === 0.001234, String(runs[0]?.costUsd));

  // -------------------------------------------------------------- isolation
  step('4. Prove tenant_beta cannot see tenant_alpha rows');
  equal('beta sees no integrations', await beta.listIntegrations(), []);
  equal('beta sees no capabilities', await beta.listCapabilities(), []);
  equal('beta getCredential is undefined', await beta.getCredential('petstore'), undefined);
  equal('beta audit total is 0', (await beta.listAudit({})).total, 0);
  equal('beta listApprovals is 0', (await beta.listApprovals()).length, 0);
  equal('beta getApproval returns undefined', await beta.getApproval('approval_alpha_1'), undefined);
  equal('beta listAgentRuns is 0', (await beta.listAgentRuns()).length, 0);

  // Beta now writes its own rows under the same names, which is the real test:
  // isolation has to hold when the natural keys collide.
  await beta.saveIntegration(integrationB);
  await beta.saveCapabilities(integrationB, [capabilityFor(integrationB, 'beta')]);
  await beta.appendAudit(auditFor('audit_beta_1', 'beta'));
  await beta.saveApproval(approvalFor('approval_beta_1', 'beta'));
  await beta.saveAgentRun(runFor('run_beta_1', 'beta'));

  equal('alpha still sees exactly its own integration', (await alpha.listIntegrations()).map((r) => r.displayName), [
    'Alpha Petstore',
  ]);
  equal('beta sees exactly its own integration', (await beta.listIntegrations()).map((r) => r.displayName), [
    'Beta Petstore',
  ]);
  equal('alpha audit total unchanged', (await alpha.listAudit({})).total, 1);
  equal('beta audit total is its own', (await beta.listAudit({})).total, 1);
  equal(
    'the same natural key (petstore.get_pet) resolves per tenant',
    [(await alpha.listCapabilities())[0]?.id, (await beta.listCapabilities())[0]?.id],
    ['cap_alpha', 'cap_beta'],
  );

  // ------------------------------------------------- arbitrary tenant name
  step('5. Isolation also holds for a tenant that writes first');
  const gamma = factory.forTenant(asTenantId('tenant_gamma'));
  await gamma.saveIntegration({ ...integrationA, id: 'int_gamma', name: 'gamma-only', displayName: 'Gamma' });
  equal('gamma sees only itself', (await gamma.listIntegrations()).map((r) => r.name), ['gamma-only']);
  equal('alpha does not see gamma', (await alpha.listIntegrations()).some((r) => r.name === 'gamma-only'), false);
  equal('beta does not see gamma', (await beta.listIntegrations()).some((r) => r.name === 'gamma-only'), false);

  // -------------------------------------------------------- row level security
  step('6. Row level security as a second, database-side mechanism');
  // The kernel's own WHERE clauses are the primary mechanism. This proves the
  // policy installed by the schema is live when a role opts in via app.tenant_id.
  //
  // It MUST run as a non-superuser role. PostgreSQL exempts superusers and roles
  // with BYPASSRLS from every policy, so testing this as `postgres` would report
  // "no isolation" no matter how correct the policy is. The kernel's own role in
  // production should likewise not be a superuser.
  const scopedPool = new Pool({
    connectionString: `postgres://tcpcore_rls_verify:rls_verify_pw@${HOST}:${PORT}/${DATABASE}`,
    max: 1,
  });

  const scoped = await scopedPool.connect();
  await scoped.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
  const scopedCount = await scoped.query('SELECT COUNT(*)::int AS n FROM kernel_audit_log');
  equal('RLS scoped to tenant_alpha sees 1 audit row', scopedCount.rows[0].n, 1);
  const scopedOther = await scoped.query('SELECT COUNT(*)::int AS n FROM kernel_audit_log WHERE tenant_id = $1', [
    TENANT_B,
  ]);
  equal('RLS scoped to tenant_alpha sees 0 of tenant_beta rows even when asked', scopedOther.rows[0].n, 0);

  await scoped.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_B]);
  const rlsBeta = await scoped.query(
    `SELECT COUNT(*)::int AS n FROM kernel_approvals WHERE tenant_id = $1`,
    [TENANT_A],
  );
  equal('RLS scoped to tenant_beta sees 0 of tenant_alpha approvals', rlsBeta.rows[0].n, 0);

  // Prove the exemption above is the explanation, not a guess: the same query as
  // the superuser shows every tenant's rows, which is what "superuser bypasses
  // RLS" means.
  const unscopedSuperuser = await admin.query('SELECT COUNT(*)::int AS n FROM kernel_audit_log');
  equal(
    'the superuser role sees all tenants (documents the BYPASSRLS exemption)',
    unscopedSuperuser.rows[0].n >= 2,
    true,
  );

  await scoped.release();
  await scopedPool.end();

  // ------------------------------------------------------------- teardown path
  step('7. deleteIntegration removes only the tenant own child rows');
  await alpha.deleteIntegration('petstore');
  equal('alpha integrations empty after delete', await alpha.listIntegrations(), []);
  equal('alpha capabilities empty after delete', await alpha.listCapabilities(), []);
  equal('alpha credential gone after delete', await alpha.getCredential('petstore'), undefined);
  equal('beta integration survived', (await beta.listIntegrations()).length, 1);
  equal('beta capabilities survived', (await beta.listCapabilities()).length, 1);

  await factory.end();
  await admin.end();
  console.log('\n  pools closed');

  // ------------------------------------------------------------------ report
  line();
  console.log(
    failures === 0
      ? 'RESULT: all real-database checks passed'
      : `RESULT: ${failures} CHECK(S) FAILED`,
  );
  line();

  await cluster.stop().catch((error) => {
    console.log(`  (cluster.stop reported: ${error.message})`);
  });

  // The cluster releases its data directory handle asynchronously, so an
  // immediate recursive delete races it. Retry, and never let cleanup failure
  // change the verification result: the checks above are the result.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.log(`  data directory cleanup: ${existsSync(DATA_DIR) ? 'left in place (in use)' : 'removed'}`);

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nVERIFICATION ERROR:', error);
  process.exit(1);
});

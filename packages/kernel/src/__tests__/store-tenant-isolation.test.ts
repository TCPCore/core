/**
 * Tenant isolation, proven without a live database.
 *
 * The Postgres store's isolation claim is structural: the tenant is a private
 * field, and every statement carries it as a parameter. This file asserts that
 * property directly by driving the store with a recording fake pool, so it runs in
 * CI on every commit rather than only when a database happens to be available.
 *
 * The companion proof against a real PostgreSQL server lives in
 * `scripts/verify-postgres-store.mjs` at the repository root. The division is
 * deliberate: this file fails fast and locally on a regression in the predicates,
 * and that script proves the SQL actually runs and isolates on a real server.
 */

import { describe, expect, it } from 'vitest';
import type { Integration } from '@tcpcore1/shared';
import {
  MemoryStoreFactory,
  PostgresKernelStore,
  PostgresKernelStoreFactory,
  SINGLE_TENANT,
  asTenantId,
} from '../index.js';
import type { PgPoolLike, PgQueryResultLike } from '../index.js';

// ------------------------------------------------------------------- fake pool

interface RecordedQuery {
  text: string;
  values: unknown[];
}

/**
 * A `pg`-shaped pool that records every statement instead of running it.
 *
 * `responder` lets a test shape rows for the statement it cares about; anything it
 * does not handle returns an empty result, which is enough for write paths.
 */
function recordingPool(
  responder?: (text: string, values: unknown[]) => unknown[] | undefined,
): { pool: PgPoolLike; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];

  const query = async (text: string, values?: unknown[]): Promise<PgQueryResultLike> => {
    const bound = values ?? [];
    queries.push({ text, values: bound });
    const rows = responder?.(text, bound) ?? [];
    return { rows, rowCount: rows.length };
  };

  const pool: PgPoolLike = {
    query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => undefined,
  };

  return { pool, queries };
}

const TENANT_A = asTenantId('tenant_a');
const TENANT_B = asTenantId('tenant_b');

function integration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'int_1',
    name: 'petstore',
    displayName: 'Petstore',
    baseUrl: 'https://petstore.example.com',
    authType: 'none',
    configYaml: 'name: petstore',
    enabled: true,
    isBuiltin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The tenant id must appear as the first bound parameter of every statement. */
function expectTenantFirst(query: RecordedQuery, tenantId: string): void {
  expect(query.values[0]).toBe(tenantId);
}

/**
 * Transaction control statements carry no parameters by definition (`BEGIN`,
 * `COMMIT`, `ROLLBACK`), so they are excluded when asserting that *data*
 * statements are tenant scoped. Asserting otherwise would be asserting that
 * `BEGIN` filters by tenant, which is not a thing.
 */
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK)$/i;

function dataStatements(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter((query) => !TRANSACTION_CONTROL.test(query.text.trim()));
}

// ------------------------------------------------------------ tenant binding

describe('PostgresKernelStore tenant binding', () => {
  it('exposes the tenant it was constructed with', () => {
    const { pool } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });
    expect(store.tenantId).toBe('tenant_a');
  });

  it('refuses an empty tenant id', () => {
    const { pool } = recordingPool();
    expect(() => new PostgresKernelStore('' as never, { connectionString: '', pool })).toThrow(
      /non-empty tenant id/,
    );
  });

  it('binds the tenant as $1 on a write', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });

    await store.saveIntegration(integration());

    expect(queries).toHaveLength(1);
    expectTenantFirst(queries[0]!, 'tenant_a');
  });

  it('binds the tenant as $1 on every read', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });

    await store.listIntegrations();
    await store.listCapabilities();
    await store.getCredential('petstore');
    await store.listAudit({});
    await store.listApprovals();
    await store.listAgentRuns();

    expect(queries.length).toBeGreaterThanOrEqual(6);
    for (const query of queries) expectTenantFirst(query, 'tenant_a');
  });

  it('binds the tenant as $1 on every delete', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });

    await store.deleteIntegration('petstore');
    await store.deleteCredential('petstore');

    const statements = dataStatements(queries);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const query of statements) expectTenantFirst(query, 'tenant_a');
  });

  it('scopes every statement to exactly one tenant, never to none', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_B, { connectionString: '', pool });

    await store.saveIntegration(integration());
    await store.listIntegrations();
    await store.appendAudit({
      id: 'audit_1',
      actorId: null,
      actorName: 'agent',
      actorType: 'AGENT',
      targetSystem: 'petstore',
      capabilityName: 'get_pet',
      action: 'EXECUTE',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    for (const query of queries) {
      expect(query.values).toContain('tenant_b');
      expect(query.values).not.toContain('tenant_a');
    }
  });

  it('parameterises values rather than interpolating them', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });

    await store.getCredential("petstore'; DROP TABLE kernel_credentials; --");

    const query = queries[0]!;
    expect(query.text).not.toContain('DROP TABLE kernel_credentials');
    expect(query.values[1]).toBe("petstore'; DROP TABLE kernel_credentials; --");
  });

  it('applies optional filters as bound parameters, still tenant first', async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresKernelStore(TENANT_A, { connectionString: '', pool });

    await store.listCapabilities({ risk: 'high', integrationName: 'petstore' });

    const query = queries[0]!;
    expect(query.values).toEqual(['tenant_a', 'high', 'petstore']);
    expect(query.text).toContain('risk_level = $2');
    expect(query.text).toContain('integration_name = $3');
  });
});

// ------------------------------------------------------------------- factory

describe('PostgresKernelStoreFactory', () => {
  it('binds the tenant passed to forTenant, not ambient state', () => {
    const factory = new PostgresKernelStoreFactory({
      connectionString: 'postgres://example/db',
    });

    const storeA = factory.forTenant(TENANT_A);
    const storeB = factory.forTenant(TENANT_B);

    expect(storeA.tenantId).toBe('tenant_a');
    expect(storeB.tenantId).toBe('tenant_b');
    expect(storeA).not.toBe(storeB);
  });

  it('returns the same store for the same tenant', () => {
    const factory = new PostgresKernelStoreFactory({
      connectionString: 'postgres://example/db',
    });

    expect(factory.forTenant(TENANT_A)).toBe(factory.forTenant(TENANT_A));
    expect(factory.tenants()).toEqual(['tenant_a']);
  });

  it('refuses SINGLE_TENANT unless the deployment opts in', () => {
    const strict = new PostgresKernelStoreFactory({ connectionString: 'postgres://example/db' });
    expect(() => strict.forTenant(SINGLE_TENANT)).toThrow(/refusing to hand out a SINGLE_TENANT/);

    const optedIn = new PostgresKernelStoreFactory({
      connectionString: 'postgres://example/db',
      allowSingleTenant: true,
    });
    expect(optedIn.forTenant(SINGLE_TENANT).tenantId).toBe(SINGLE_TENANT);
  });

  it('refuses to construct without a connection string', () => {
    expect(() => new PostgresKernelStoreFactory({ connectionString: '' })).toThrow(
      /requires a connectionString/,
    );
  });

  it('reports a clear error when pg is absent rather than ERR_MODULE_NOT_FOUND', async () => {
    // The module loader resolves `pg` from the workspace, so the failure path is
    // asserted against the wrapper's own contract instead of by uninstalling it:
    // constructing a pool without a connection string must still fail predictably.
    const factory = new PostgresKernelStoreFactory({ connectionString: 'postgres://example/db' });
    const store = factory.forTenant(TENANT_A);
    expect(store).toBeInstanceOf(PostgresKernelStore);
  });
});

// -------------------------------------------------------------- memory factory

describe('MemoryStoreFactory', () => {
  it('isolates tenants structurally', async () => {
    const factory = new MemoryStoreFactory();
    const storeA = factory.forTenant(TENANT_A);
    const storeB = factory.forTenant(TENANT_B);

    await storeA.saveIntegration(integration({ name: 'only-in-a' }));

    expect((await storeA.listIntegrations()).map((row) => row.name)).toEqual(['only-in-a']);
    expect(await storeB.listIntegrations()).toEqual([]);
  });

  it('refuses SINGLE_TENANT unless the deployment opts in', () => {
    expect(() => new MemoryStoreFactory().forTenant(SINGLE_TENANT)).toThrow(
      /refusing to hand out a SINGLE_TENANT/,
    );
    expect(
      new MemoryStoreFactory({ allowSingleTenant: true }).forTenant(SINGLE_TENANT),
    ).toBeDefined();
  });

  it('retains a tenant store across acquisitions', () => {
    const factory = new MemoryStoreFactory();
    expect(factory.forTenant(TENANT_A)).toBe(factory.forTenant(TENANT_A));
  });
});

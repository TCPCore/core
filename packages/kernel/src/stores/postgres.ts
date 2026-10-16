/**
 * PostgreSQL-backed `KernelStore`, using `pg` (node-postgres).
 *
 * This is the implementation that makes the free tier usable: `MemoryStore` is a
 * demo, and an audit trail you lose on every deploy is not an audit trail.
 *
 * ## Tenant isolation
 *
 * The tenant is a constructor argument, captured in a private field, and prepended
 * to the parameters of every statement in this file. It is never read from ambient
 * state, never a method argument, and never defaulted. A caller holding a store
 * cannot ask it for another tenant's rows, because no method accepts a tenant.
 *
 * Two further properties back that up:
 *
 *   - Every statement is parameterised (`$1`, `$2`, ...) with no string
 *     interpolation of values, so no bound value can alter a predicate.
 *   - `createPostgresSchema()` makes the tenant part of every primary key and of
 *     every foreign key, so a cross-tenant row is rejected by the database even if
 *     application code were wrong.
 *
 * `SINGLE_TENANT` is accepted by the CLI, which genuinely has one tenant. The
 * Postgres factory refuses it unless `allowSingleTenant` is set, so a multi-tenant
 * deployment cannot reach it by accident.
 *
 * ## Loading
 *
 * `pg` is an optional peer dependency. It is imported inside a function rather
 * than at module scope, so `import { MemoryStore } from '@tcpcore1/kernel'` does
 * not require `pg` to be installed and a host that never touches Postgres never
 * pays for it. Reaching this module without `pg` present fails with an actionable
 * message rather than `ERR_MODULE_NOT_FOUND`.
 */

import type { ApprovalRequest, AuditLog, Integration } from '@tcpcore1/shared';
import type {
  AuditQueryInput,
  KernelAgentRun,
  KernelCapabilityRecord,
  KernelStore,
  KernelStoreFactory,
  StoredCredential,
  TenantId,
} from '../types.js';
import { SINGLE_TENANT } from '../types.js';
import {
  POSTGRES_KERNEL_RLS_SQL,
  POSTGRES_KERNEL_SCHEMA_SQL,
  POSTGRES_KERNEL_TABLES,
} from './postgres-schema.js';

export { POSTGRES_KERNEL_RLS_SQL, POSTGRES_KERNEL_SCHEMA_SQL, POSTGRES_KERNEL_TABLES };

// --------------------------------------------------------------------- loading

/**
 * The slice of `pg` this file uses, declared structurally.
 *
 * Declared here rather than imported from `pg` so the kernel's build does not
 * depend on `@types/pg` being installed: a project that consumes the kernel
 * without Postgres must still be able to resolve `@tcpcore1/kernel`'s types.
 */
export interface PgQueryResultLike {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
}

export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release(): void }>;
  end(): Promise<void>;
}

export interface PgModuleLike {
  Pool: new (config: { connectionString: string; max?: number }) => PgPoolLike;
}

let cachedPg: PgModuleLike | undefined;

/**
 * Resolve `pg`, once per process.
 *
 * A dynamic import rather than a static one so the dependency stays genuinely
 * optional: Node resolves it only when a Postgres store is actually constructed.
 */
async function loadPg(): Promise<PgModuleLike> {
  if (cachedPg) return cachedPg;

  let loaded: unknown;
  try {
    loaded = await import('pg');
  } catch (error) {
    throw new Error(
      'PostgresKernelStore requires the "pg" package, which is an optional peer ' +
        'dependency of @tcpcore1/kernel. Install it with: npm install pg@^8\n' +
        `Underlying error: ${(error as Error).message}`,
    );
  }

  const module = loaded as { default?: unknown } & Record<string, unknown>;
  const candidate = (module.default ?? module) as Partial<PgModuleLike>;

  if (typeof candidate.Pool !== 'function') {
    throw new Error('PostgresKernelStore: the installed "pg" package exposes no Pool constructor.');
  }

  cachedPg = candidate as PgModuleLike;
  return cachedPg;
}

// ---------------------------------------------------------------- row mapping

type Row = Record<string, unknown>;

const asString = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);
const asStringOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const asBoolean = (value: unknown): boolean => value === true || value === 't' || value === 'true';

/** `pg` returns `timestamptz` as a `Date`; the shared contract is an ISO string. */
function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * JSONB comes back already parsed. The one case that needs care is a value that
 * was written as JSON `null`, which must round trip as `undefined` in the optional
 * positions of the shared schemas rather than as a present-but-null field.
 */
function asJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return value as T;
}

/** `JSON.stringify` of a JSONB parameter, with `undefined` written as JSON null. */
function jsonParam(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function mapIntegration(row: Row): Integration {
  return {
    id: asString(row.id),
    name: asString(row.name),
    displayName: asString(row.display_name),
    baseUrl: asString(row.base_url),
    authType: asString(row.auth_type) as Integration['authType'],
    configYaml: asString(row.config_yaml),
    enabled: asBoolean(row.enabled),
    isBuiltin: asBoolean(row.is_builtin),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapCapability(row: Row): KernelCapabilityRecord {
  return {
    id: asString(row.id),
    integrationId: asString(row.integration_id),
    integrationName: asString(row.integration_name),
    name: asString(row.name),
    fullName: asString(row.full_name),
    description: asString(row.description),
    method: asString(row.method) as KernelCapabilityRecord['method'],
    pathTemplate: asString(row.path_template),
    riskLevel: asString(row.risk_level) as KernelCapabilityRecord['riskLevel'],
    approvalRequired: asBoolean(row.approval_required),
    agentForbidden: asBoolean(row.agent_forbidden),
    contentRisk:
      (asStringOrNull(row.content_risk) as KernelCapabilityRecord['contentRisk']) ?? null,
    deprecated: asBoolean(row.deprecated),
    inputSchema: (asJson<Record<string, unknown>>(row.input_schema) ?? {}) as Record<
      string,
      unknown
    >,
    outputSchema: (asJson<Record<string, unknown>>(row.output_schema) ?? null) as Record<
      string,
      unknown
    > | null,
    createdAt: asIso(row.created_at),
    updatedAt: asStringOrNull(row.updated_at) ?? undefined,
  };
}

function mapCredential(row: Row): StoredCredential {
  return {
    integrationId: asString(row.integration_id),
    integrationName: asString(row.integration_name),
    authType: asString(row.auth_type) as StoredCredential['authType'],
    encryptedBlob: asString(row.encrypted_blob),
    refreshTokenEnc: asStringOrNull(row.refresh_token_enc),
    expiresAt: asIsoOrNull(row.expires_at),
    scopes: (asJson<string[]>(row.scopes) ?? null) as string[] | null,
    updatedAt: asIso(row.updated_at),
  };
}

function mapAudit(row: Row): AuditLog {
  return {
    id: asString(row.id),
    actorId: asStringOrNull(row.actor_id),
    actorName: asString(row.actor_name),
    actorType: asString(row.actor_type) as AuditLog['actorType'],
    targetSystem: asString(row.target_system),
    integrationId: asStringOrNull(row.integration_id),
    capabilityName: asString(row.capability_name),
    targetResource: asStringOrNull(row.target_resource),
    targetPayload: asJson<unknown>(row.target_payload),
    action: asString(row.action) as AuditLog['action'],
    diff: asJson<unknown>(row.diff),
    metadata: asJson<AuditLog['metadata']>(row.metadata),
    createdAt: asIso(row.created_at),
  };
}

function mapApproval(row: Row): ApprovalRequest {
  return {
    id: asString(row.id),
    agentId: asString(row.agent_id),
    agentName: asString(row.agent_name),
    integrationId: asStringOrNull(row.integration_id),
    targetSystem: asString(row.target_system),
    capabilityName: asString(row.capability_name),
    targetPayload: asJson<unknown>(row.target_payload),
    // The queue only stores medium/high, and the shared schema excludes `low`, so
    // widening here is safe and keeps the column a plain string.
    riskLevel: (asString(row.risk_level) === 'high'
      ? 'high'
      : 'medium') as ApprovalRequest['riskLevel'],
    status: asString(row.status) as ApprovalRequest['status'],
    reviewedById: asStringOrNull(row.reviewed_by_id),
    reviewedByName: asStringOrNull(row.reviewed_by_name),
    reviewedAt: asIsoOrNull(row.reviewed_at),
    executionError: asStringOrNull(row.execution_error),
    createdAt: asIso(row.created_at),
  };
}

function mapAgentRun(row: Row): KernelAgentRun {
  return {
    id: asString(row.id),
    agentId: asString(row.agent_id),
    agentName: asString(row.agent_name),
    trigger: asString(row.trigger),
    status: asString(row.status) as KernelAgentRun['status'],
    steps: Number(row.steps ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    model: asString(row.model),
    // NUMERIC arrives as a string; Number() is safe at this precision (6 dp).
    costUsd: Number(row.cost_usd ?? 0),
    spans: (asJson<KernelAgentRun['spans']>(row.spans) ?? []) as KernelAgentRun['spans'],
    reasoningLogs: (asJson<string[]>(row.reasoning) ?? []) as string[],
    createdAt: asIso(row.created_at),
  };
}

// --------------------------------------------------------------------- options

export interface PostgresKernelStoreOptions {
  /** A `postgres://` connection string. */
  connectionString: string;
  /** Maximum pool size. Defaults to `pg`'s own default (10). */
  max?: number;
  /**
   * An existing pool to borrow instead of creating one.
   *
   * A host that already runs a pool (a server, a worker) should pass it: the pool
   * is the expensive object, and it is tenant agnostic here because the tenant is a
   * query parameter rather than session state. When set, `connectionString` is
   * ignored and `factory.end()` does not close a pool it did not open.
   */
  pool?: PgPoolLike;
}

/** Wrap whatever `pg` gives back in the shape the `#query` helpers expect. */
function normaliseResult(result: PgQueryResultLike): { rows: Row[]; rowCount: number } {
  return {
    rows: (result.rows ?? []) as Row[],
    rowCount: result.rowCount ?? result.rows?.length ?? 0,
  };
}

// ---------------------------------------------------------------------- store

/**
 * A `KernelStore` for exactly one tenant.
 *
 * Construct through {@link PostgresKernelStoreFactory} unless you are writing a
 * single-tenant tool and are willing to say so by passing `SINGLE_TENANT`.
 */
export class PostgresKernelStore implements KernelStore {
  readonly #tenantId: TenantId;

  /** Every statement in this class is executed with this tenant as `$1`. */
  get tenantId(): TenantId {
    return this.#tenantId;
  }

  #pool: PgPoolLike | undefined;
  #ownsPool = false;
  readonly #connectionString: string;
  readonly #max: number | undefined;

  constructor(tenantId: TenantId, options: PostgresKernelStoreOptions) {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new Error('PostgresKernelStore requires a non-empty tenant id');
    }
    if (!options.connectionString && !options.pool) {
      throw new Error('PostgresKernelStore requires a connectionString or an existing pool');
    }

    this.#tenantId = tenantId;
    this.#connectionString = options.connectionString;
    this.#max = options.max;

    if (options.pool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    }
  }

  /** Lazily create the pool, so constructing a store performs no I/O. */
  async #getPool(): Promise<PgPoolLike> {
    if (this.#pool) return this.#pool;

    const pg = await loadPg();
    const config: { connectionString: string; max?: number } = {
      connectionString: this.#connectionString,
    };
    if (this.#max !== undefined) config.max = this.#max;

    this.#pool = new pg.Pool(config);
    this.#ownsPool = true;
    return this.#pool;
  }

  /**
   * Run one statement, already tenant scoped by the caller.
   *
   * Private and deliberately boring: there is no public query surface on this
   * class, so a host cannot run an unscoped statement through the store it was
   * handed.
   */
  async #query(sql: string, params: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    const pool = await this.#getPool();
    return normaliseResult(await pool.query(sql, params));
  }

  /** Run several statements in one transaction, all tenant scoped by the caller. */
  async #transaction<T>(run: (client: PgClientLike) => Promise<T>): Promise<T> {
    const pool = await this.#getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN', []);
      const result = await run({
        query: (text: string, values?: unknown[]) => client.query(text, values),
      });
      await client.query('COMMIT', []);
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK', []);
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Release the pool, when this store opened it. Safe to call more than once. */
  async end(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool && this.#ownsPool) {
      this.#ownsPool = false;
      await pool.end();
    }
  }

  // ------------------------------------------------------------- integrations

  async saveIntegration(integration: Integration): Promise<void> {
    await this.#query(
      `INSERT INTO kernel_integrations (
         tenant_id, name, id, display_name, base_url, auth_type, config_yaml,
         enabled, is_builtin, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         id           = EXCLUDED.id,
         display_name = EXCLUDED.display_name,
         base_url     = EXCLUDED.base_url,
         auth_type    = EXCLUDED.auth_type,
         config_yaml  = EXCLUDED.config_yaml,
         enabled      = EXCLUDED.enabled,
         is_builtin   = EXCLUDED.is_builtin,
         updated_at   = EXCLUDED.updated_at`,
      [
        this.#tenantId,
        integration.name,
        integration.id,
        integration.displayName,
        integration.baseUrl,
        integration.authType,
        integration.configYaml,
        integration.enabled,
        integration.isBuiltin,
        integration.createdAt,
        integration.updatedAt,
      ],
    );
  }

  async deleteIntegration(name: string): Promise<void> {
    // Capabilities and credentials cascade through the composite foreign keys, but
    // the deletes are issued explicitly as well so the store does not depend on a
    // DDL detail to remove a tenant's own rows.
    await this.#transaction(async (client) => {
      await client.query(
        `DELETE FROM kernel_capabilities
          WHERE tenant_id = $1
            AND integration_id IN (
              SELECT id FROM kernel_integrations WHERE tenant_id = $1 AND name = $2
            )`,
        [this.#tenantId, name],
      );
      await client.query(
        `DELETE FROM kernel_credentials WHERE tenant_id = $1 AND integration_name = $2`,
        [this.#tenantId, name],
      );
      await client.query(`DELETE FROM kernel_integrations WHERE tenant_id = $1 AND name = $2`, [
        this.#tenantId,
        name,
      ]);
    });
  }

  async listIntegrations(): Promise<Integration[]> {
    const { rows } = await this.#query(
      `SELECT * FROM kernel_integrations WHERE tenant_id = $1 ORDER BY name ASC`,
      [this.#tenantId],
    );
    return rows.map(mapIntegration);
  }

  // ------------------------------------------------------------- capabilities

  async saveCapabilities(
    integration: Integration,
    capabilities: KernelCapabilityRecord[],
  ): Promise<void> {
    // Replace the set for this integration, keeping other integrations intact. The
    // delete and the inserts share a transaction so a reader never observes the
    // integration with no capabilities.
    await this.#transaction(async (client) => {
      await client.query(
        `DELETE FROM kernel_capabilities WHERE tenant_id = $1 AND integration_id = $2`,
        [this.#tenantId, integration.id],
      );

      for (const capability of capabilities) {
        await client.query(
          `INSERT INTO kernel_capabilities (
             tenant_id, full_name, id, integration_id, integration_name, name,
             description, method, path_template, risk_level, approval_required,
             agent_forbidden, content_risk, deprecated, input_schema, output_schema,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15::jsonb, $16::jsonb, $17, $18
           )
           ON CONFLICT (tenant_id, full_name) DO UPDATE SET
             id                = EXCLUDED.id,
             integration_id    = EXCLUDED.integration_id,
             integration_name  = EXCLUDED.integration_name,
             name              = EXCLUDED.name,
             description       = EXCLUDED.description,
             method            = EXCLUDED.method,
             path_template     = EXCLUDED.path_template,
             risk_level        = EXCLUDED.risk_level,
             approval_required = EXCLUDED.approval_required,
             agent_forbidden   = EXCLUDED.agent_forbidden,
             content_risk      = EXCLUDED.content_risk,
             deprecated        = EXCLUDED.deprecated,
             input_schema      = EXCLUDED.input_schema,
             output_schema     = EXCLUDED.output_schema,
             updated_at        = EXCLUDED.updated_at`,
          [
            this.#tenantId,
            capability.fullName,
            capability.id,
            integration.id,
            capability.integrationName,
            capability.name,
            capability.description,
            capability.method,
            capability.pathTemplate,
            capability.riskLevel,
            capability.approvalRequired,
            capability.agentForbidden,
            capability.contentRisk,
            capability.deprecated,
            jsonParam(capability.inputSchema),
            capability.outputSchema === null || capability.outputSchema === undefined
              ? null
              : jsonParam(capability.outputSchema),
            capability.createdAt,
            capability.updatedAt ?? null,
          ],
        );
      }
    });
  }

  async listCapabilities(filter?: {
    risk?: KernelCapabilityRecord['riskLevel'];
    integrationName?: string;
  }): Promise<KernelCapabilityRecord[]> {
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [this.#tenantId];

    if (filter?.risk) {
      params.push(filter.risk);
      conditions.push(`risk_level = $${params.length}`);
    }
    if (filter?.integrationName) {
      params.push(filter.integrationName);
      conditions.push(`integration_name = $${params.length}`);
    }

    const { rows } = await this.#query(
      `SELECT * FROM kernel_capabilities
        WHERE ${conditions.join(' AND ')}
        ORDER BY full_name ASC`,
      params,
    );
    return rows.map(mapCapability);
  }

  // -------------------------------------------------------------- credentials

  async saveCredential(credential: StoredCredential): Promise<void> {
    await this.#query(
      `INSERT INTO kernel_credentials (
         tenant_id, integration_name, integration_id, auth_type, encrypted_blob,
         refresh_token_enc, expires_at, scopes, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (tenant_id, integration_name) DO UPDATE SET
         integration_id    = EXCLUDED.integration_id,
         auth_type         = EXCLUDED.auth_type,
         encrypted_blob    = EXCLUDED.encrypted_blob,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at        = EXCLUDED.expires_at,
         scopes            = EXCLUDED.scopes,
         updated_at        = EXCLUDED.updated_at`,
      [
        this.#tenantId,
        credential.integrationName,
        credential.integrationId,
        credential.authType,
        credential.encryptedBlob,
        credential.refreshTokenEnc,
        credential.expiresAt,
        credential.scopes === null || credential.scopes === undefined
          ? null
          : jsonParam(credential.scopes),
        credential.updatedAt,
      ],
    );
  }

  async getCredential(integrationName: string): Promise<StoredCredential | undefined> {
    const { rows } = await this.#query(
      `SELECT * FROM kernel_credentials WHERE tenant_id = $1 AND integration_name = $2`,
      [this.#tenantId, integrationName],
    );
    const row = rows[0];
    return row ? mapCredential(row) : undefined;
  }

  async deleteCredential(integrationName: string): Promise<void> {
    await this.#query(
      `DELETE FROM kernel_credentials WHERE tenant_id = $1 AND integration_name = $2`,
      [this.#tenantId, integrationName],
    );
  }

  // -------------------------------------------------------------------- audit

  async appendAudit(record: AuditLog): Promise<void> {
    await this.#query(
      `INSERT INTO kernel_audit_log (
         tenant_id, id, actor_id, actor_name, actor_type, target_system,
         integration_id, capability_name, target_resource, target_payload,
         action, diff, metadata, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14
       )
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        this.#tenantId,
        record.id,
        record.actorId,
        record.actorName,
        record.actorType,
        record.targetSystem,
        record.integrationId ?? null,
        record.capabilityName,
        record.targetResource ?? null,
        record.targetPayload === undefined ? null : jsonParam(record.targetPayload),
        record.action,
        record.diff === undefined ? null : jsonParam(record.diff),
        record.metadata === undefined ? null : jsonParam(record.metadata),
        record.createdAt,
      ],
    );
  }

  async listAudit(query: AuditQueryInput): Promise<{ records: AuditLog[]; total: number }> {
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [this.#tenantId];

    const add = (column: string, value: unknown): void => {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    };

    if (query.actorType) add('actor_type', query.actorType);
    if (query.targetSystem) add('target_system', query.targetSystem);
    if (query.capabilityName) add('capability_name', query.capabilityName);
    if (query.action) add('action', query.action);

    if (query.from) {
      params.push(query.from);
      conditions.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`created_at <= $${params.length}::timestamptz`);
    }

    if (query.search) {
      // Mirrors the in-memory store's free-text search: the same five fields,
      // case-insensitively, with the sanitised `search` bound as one parameter.
      params.push(`%${query.search.toLowerCase()}%`);
      const at = params.length;
      conditions.push(
        `(LOWER(actor_name) LIKE $${at}
          OR LOWER(capability_name) LIKE $${at}
          OR LOWER(target_system) LIKE $${at}
          OR LOWER(COALESCE(target_resource, '')) LIKE $${at}
          OR LOWER(action) LIKE $${at})`,
      );
    }

    const where = conditions.join(' AND ');

    const counted = await this.#query(
      `SELECT COUNT(*)::int AS total FROM kernel_audit_log WHERE ${where}`,
      params,
    );
    const total = Number(counted.rows[0]?.total ?? 0);

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const offset = (page - 1) * limit;

    const pageParams = [...params, limit, offset];
    const { rows } = await this.#query(
      `SELECT * FROM kernel_audit_log
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );

    return { records: rows.map(mapAudit), total };
  }

  // ---------------------------------------------------------------- approvals

  async saveApproval(approval: ApprovalRequest): Promise<void> {
    await this.#query(
      `INSERT INTO kernel_approvals (
         tenant_id, id, agent_id, agent_name, integration_id, target_system,
         capability_name, target_payload, risk_level, status, reviewed_by_id,
         reviewed_by_name, reviewed_at, execution_error, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         agent_id         = EXCLUDED.agent_id,
         agent_name       = EXCLUDED.agent_name,
         integration_id   = EXCLUDED.integration_id,
         target_system    = EXCLUDED.target_system,
         capability_name  = EXCLUDED.capability_name,
         target_payload   = EXCLUDED.target_payload,
         risk_level       = EXCLUDED.risk_level,
         status           = EXCLUDED.status,
         reviewed_by_id   = EXCLUDED.reviewed_by_id,
         reviewed_by_name = EXCLUDED.reviewed_by_name,
         reviewed_at      = EXCLUDED.reviewed_at,
         execution_error  = EXCLUDED.execution_error`,
      [
        this.#tenantId,
        approval.id,
        approval.agentId,
        approval.agentName,
        approval.integrationId,
        approval.targetSystem,
        approval.capabilityName,
        approval.targetPayload === undefined ? null : jsonParam(approval.targetPayload),
        approval.riskLevel,
        approval.status,
        approval.reviewedById,
        approval.reviewedByName ?? null,
        approval.reviewedAt,
        approval.executionError ?? null,
        approval.createdAt,
      ],
    );
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const { rows } = await this.#query(
      `SELECT * FROM kernel_approvals WHERE tenant_id = $1 AND id = $2`,
      [this.#tenantId, id],
    );
    const row = rows[0];
    return row ? mapApproval(row) : undefined;
  }

  async listApprovals(status?: string): Promise<ApprovalRequest[]> {
    const filtered = status !== undefined && status !== 'ALL';
    const { rows } = await this.#query(
      filtered
        ? `SELECT * FROM kernel_approvals
            WHERE tenant_id = $1 AND status = $2
            ORDER BY created_at DESC, id DESC`
        : `SELECT * FROM kernel_approvals
            WHERE tenant_id = $1
            ORDER BY created_at DESC, id DESC`,
      filtered ? [this.#tenantId, status] : [this.#tenantId],
    );
    return rows.map(mapApproval);
  }

  // --------------------------------------------------------------- agent runs

  async saveAgentRun(run: KernelAgentRun): Promise<void> {
    await this.#query(
      `INSERT INTO kernel_agent_runs (
         tenant_id, id, agent_id, agent_name, trigger, status, steps,
         input_tokens, output_tokens, latency_ms, model, cost_usd, spans,
         reasoning, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15
       )
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        this.#tenantId,
        run.id,
        run.agentId,
        run.agentName,
        run.trigger,
        run.status,
        run.steps,
        run.inputTokens,
        run.outputTokens,
        run.latencyMs,
        run.model,
        run.costUsd,
        jsonParam(run.spans),
        jsonParam(run.reasoningLogs),
        run.createdAt,
      ],
    );
  }

  async listAgentRuns(limit = 100): Promise<KernelAgentRun[]> {
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const { rows } = await this.#query(
      `SELECT * FROM kernel_agent_runs
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [this.#tenantId, bounded],
    );
    return rows.map(mapAgentRun);
  }
}

// -------------------------------------------------------------------- factory

export interface PostgresKernelStoreFactoryOptions {
  connectionString: string;
  max?: number;
  /** See {@link MemoryStoreFactoryOptions.allowSingleTenant}. Defaults to `false`. */
  readonly allowSingleTenant?: boolean;
}

/**
 * Binds a tenant once and hands out stores that cannot escape it.
 *
 * The tenant is a parameter rather than ambient context on purpose. Ambient
 * context on the hot path beneath every governed call fails three ways: it
 * interleaves under concurrency, it is invisible coupling (the store cannot be
 * used from a worker or a CLI without a context provider), and it fails silently,
 * because an unset tenant makes `WHERE tenant_id = ...` match nothing, so the
 * caller sees an empty result rather than an error.
 *
 * One pool is shared by every tenant. The commercial Prisma implementation cannot
 * do that, because Prisma binds tenant state to the client; here the tenant is a
 * query parameter, so a per-tenant pool would buy nothing and cost a connection
 * pool per tenant.
 */
export class PostgresKernelStoreFactory implements KernelStoreFactory {
  readonly #options: PostgresKernelStoreFactoryOptions;
  readonly #stores = new Map<TenantId, PostgresKernelStore>();
  readonly #allowSingleTenant: boolean;
  #pool: PgPoolLike | undefined;

  constructor(options: PostgresKernelStoreFactoryOptions) {
    if (!options.connectionString) {
      throw new Error('PostgresKernelStoreFactory requires a connectionString');
    }
    this.#options = options;
    this.#allowSingleTenant = options.allowSingleTenant ?? false;
  }

  forTenant(tenantId: TenantId): PostgresKernelStore {
    if (tenantId === SINGLE_TENANT && !this.#allowSingleTenant) {
      throw new Error(
        'PostgresKernelStoreFactory: refusing to hand out a SINGLE_TENANT store. ' +
          'Pass { allowSingleTenant: true } if this deployment genuinely has one tenant.',
      );
    }
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new Error('PostgresKernelStoreFactory.forTenant requires a non-empty tenant id');
    }

    const existing = this.#stores.get(tenantId);
    if (existing) return existing;

    const created = new PostgresKernelStore(tenantId, {
      connectionString: this.#options.connectionString,
      max: this.#options.max,
    });
    this.#stores.set(tenantId, created);
    return created;
  }

  /** The tenants this factory has handed out stores for. */
  tenants(): TenantId[] {
    return [...this.#stores.keys()];
  }

  /** Close the connections held by every store this factory created. */
  async end(): Promise<void> {
    const stores = [...this.#stores.values()];
    this.#stores.clear();
    await Promise.all(stores.map((store) => store.end()));
    if (this.#pool) {
      const pool = this.#pool;
      this.#pool = undefined;
      await pool.end();
    }
  }
}

/** Convenience constructor for a single-tenant process, such as the CLI. */
export function createPostgresKernelStore(
  tenantId: TenantId,
  options: PostgresKernelStoreOptions,
): PostgresKernelStore {
  return new PostgresKernelStore(tenantId, options);
}

// --------------------------------------------------------------------- schema

/**
 * Apply the schema this store requires.
 *
 * Not called automatically. Creating tables is a deployment decision, and a store
 * that ran DDL on first use would do it with whatever privileges the runtime role
 * happens to hold.
 *
 * ```ts
 * import { Pool } from 'pg';
 * import { createPostgresSchema } from '@tcpcore1/kernel';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await createPostgresSchema(pool);
 * await pool.end();
 * ```
 */
export async function createPostgresSchema(client: PgClientLike): Promise<void> {
  await client.query(POSTGRES_KERNEL_SCHEMA_SQL, []);
  await client.query(POSTGRES_KERNEL_RLS_SQL, []);
}

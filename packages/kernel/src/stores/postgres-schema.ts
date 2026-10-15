/**
 * The PostgreSQL schema {@link PostgresKernelStore} requires.
 *
 * ## Why this is a `.sql` file and not a generator
 *
 * A self-hoster has to review and run this before the kernel can store anything.
 * A migration tool would be one more thing to install and would hide the part
 * that matters, which is the tenant predicate. Plain SQL is runnable with `psql`
 * or with the exported `createPostgresSchema()` helper, and it is reviewable by
 * whoever owns the database.
 *
 * ## Tenant isolation is a constraint, not a convention
 *
 * Every table's `PRIMARY KEY` begins with `tenant_id`, and every foreign key is
 * composite including `tenant_id`. That is deliberate, and it is the difference
 * between isolation you can audit and isolation you have to remember:
 *
 *   - A row cannot be identified without naming its tenant, so two tenants may
 *     hold the same integration name, capability full name or audit id without
 *     colliding.
 *   - `capabilities` and `credentials` cannot reference an `integrations` row
 *     belonging to a different tenant, because the referenced key includes the
 *     tenant. A cross-tenant row is rejected by the database, not by the driver.
 *
 * The application adds `WHERE tenant_id = $1` to every statement as well. Two
 * independent mechanisms, because the cost of being wrong is one tenant reading
 * another tenant's audit trail.
 *
 * ## Row level security is applied but deliberately NOT forced
 *
 * `docs/THREAT-MODEL.md` treats a missing tenant predicate as an in-scope threat.
 * `createPostgresSchema()` enables row level security and installs a policy on
 * every table, so the predicate is enforced by PostgreSQL the moment the
 * connecting role sets `app.tenant_id` (see the notes in `postgres.ts`). It is not
 * `FORCE`d, because the kernel's own `WHERE` clauses are the primary mechanism and
 * the schema has to stay usable by a role that has not opted in.
 */
export const POSTGRES_KERNEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kernel_integrations (
  tenant_id     TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  id            TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  base_url      TEXT        NOT NULL,
  auth_type     TEXT        NOT NULL,
  config_yaml   TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  is_builtin    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, name),
  CONSTRAINT kernel_integrations_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel_capabilities (
  tenant_id          TEXT        NOT NULL,
  full_name          TEXT        NOT NULL,
  id                 TEXT        NOT NULL,
  integration_id     TEXT        NOT NULL,
  integration_name   TEXT        NOT NULL,
  name               TEXT        NOT NULL,
  description        TEXT        NOT NULL,
  method             TEXT        NOT NULL,
  path_template      TEXT        NOT NULL,
  risk_level         TEXT        NOT NULL,
  approval_required  BOOLEAN     NOT NULL DEFAULT FALSE,
  agent_forbidden    BOOLEAN     NOT NULL DEFAULT FALSE,
  content_risk       TEXT,
  deprecated         BOOLEAN     NOT NULL DEFAULT FALSE,
  input_schema       JSONB       NOT NULL,
  output_schema      JSONB,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, full_name),
  CONSTRAINT kernel_capabilities_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT kernel_capabilities_integration_fkey
    FOREIGN KEY (tenant_id, integration_id)
    REFERENCES kernel_integrations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS kernel_capabilities_by_integration
  ON kernel_capabilities (tenant_id, integration_name);

CREATE TABLE IF NOT EXISTS kernel_credentials (
  tenant_id         TEXT        NOT NULL,
  integration_name  TEXT        NOT NULL,
  integration_id    TEXT        NOT NULL,
  auth_type         TEXT        NOT NULL,
  encrypted_blob    TEXT        NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ,
  scopes            JSONB,
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, integration_name),
  CONSTRAINT kernel_credentials_integration_fkey
    FOREIGN KEY (tenant_id, integration_id)
    REFERENCES kernel_integrations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kernel_audit_log (
  tenant_id        TEXT        NOT NULL,
  id               TEXT        NOT NULL,
  actor_id         TEXT,
  actor_name       TEXT        NOT NULL,
  actor_type       TEXT        NOT NULL,
  target_system    TEXT        NOT NULL,
  integration_id   TEXT,
  capability_name  TEXT        NOT NULL,
  target_resource  TEXT,
  target_payload   JSONB,
  action           TEXT        NOT NULL,
  diff             JSONB,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS kernel_audit_log_recent
  ON kernel_audit_log (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kernel_approvals (
  tenant_id        TEXT        NOT NULL,
  id               TEXT        NOT NULL,
  agent_id         TEXT        NOT NULL,
  agent_name       TEXT        NOT NULL,
  integration_id   TEXT,
  target_system    TEXT        NOT NULL,
  capability_name  TEXT        NOT NULL,
  target_payload   JSONB,
  risk_level       TEXT        NOT NULL,
  status           TEXT        NOT NULL,
  reviewed_by_id   TEXT,
  reviewed_by_name TEXT,
  reviewed_at      TIMESTAMPTZ,
  execution_error  TEXT,
  created_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS kernel_approvals_recent
  ON kernel_approvals (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kernel_agent_runs (
  tenant_id       TEXT        NOT NULL,
  id              TEXT        NOT NULL,
  agent_id        TEXT        NOT NULL,
  agent_name      TEXT        NOT NULL,
  trigger         TEXT        NOT NULL,
  status          TEXT        NOT NULL,
  steps           INTEGER     NOT NULL DEFAULT 0,
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  latency_ms      INTEGER     NOT NULL DEFAULT 0,
  model           TEXT        NOT NULL,
  cost_usd        NUMERIC(14,6) NOT NULL DEFAULT 0,
  spans           JSONB       NOT NULL,
  reasoning       JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS kernel_agent_runs_recent
  ON kernel_agent_runs (tenant_id, created_at DESC, id DESC);
`;

/** The tables the store owns, in dependency order (children first). */
export const POSTGRES_KERNEL_TABLES = [
  'kernel_agent_runs',
  'kernel_approvals',
  'kernel_audit_log',
  'kernel_credentials',
  'kernel_capabilities',
  'kernel_integrations',
] as const;

/**
 * Row level security, applied as defence in depth.
 *
 * The policy calls `kernel_tenant_matches(tenant_id)`, which reads the
 * `app.tenant_id` session setting. That indirection exists for one reason:
 * `current_setting('app.tenant_id', true)` returns SQL NULL when the setting is
 * absent, and `tenant_id = NULL` is neither true nor false, so a naive policy
 * silently **denies every row**. That would turn a defence-in-depth measure into
 * "the store returns nothing and nobody knows why".
 *
 * `kernel_tenant_matches` therefore returns `TRUE` when the setting is absent
 * (unscoped role: the application's own `WHERE` clauses are the mechanism, and it
 * behaves exactly as it did before RLS was enabled) and an exact comparison when
 * the setting is present (scoped role: PostgreSQL enforces isolation itself).
 *
 * A host that wants the database to enforce isolation connects as a role that
 * sets `app.tenant_id` on checkout and exposes no other path to these tables.
 */
export const POSTGRES_KERNEL_RLS_SQL = `
CREATE OR REPLACE FUNCTION kernel_tenant_matches(row_tenant_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN current_setting('app.tenant_id', true) IS NULL THEN TRUE
    ELSE row_tenant_id = current_setting('app.tenant_id', true)
  END;
$$;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'kernel_integrations',
    'kernel_capabilities',
    'kernel_credentials',
    'kernel_audit_log',
    'kernel_approvals',
    'kernel_agent_runs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_tenant_isolation', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (kernel_tenant_matches(tenant_id))',
      target || '_tenant_isolation',
      target
    );
  END LOOP;
END
$$;
`;

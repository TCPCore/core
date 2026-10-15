# @tcpcore1/kernel

**The TCPcore governance kernel.** The layer between your agents and any API:
agent identity, a risk gate, a human approval queue, credential brokering, a
prompt-injection sanitiser, and a NIST AU-3 audit trail.

MIT licensed. Domain-agnostic. No database required, and PostgreSQL supported when
you want one.

```bash
npm install @tcpcore1/kernel
```

---

## Why this exists

Vendor MCP servers are maximalist: they expose every endpoint, so an agent gets a
tool catalogue with hundreds of entries. Tokens burn, latency climbs, and the
attack surface grows with every tool you did not need.

Meanwhile agent identity is mostly absent. Agents are anonymous callers - no
role, no audit trail, no permission model. When something goes wrong you cannot
answer _which agent did this, on whose authority, and was it allowed?_

The kernel is the missing layer. It is **not** an agent framework and **not**
another MCP server.

## The one invariant

Every agent-originated call reaches an integration through exactly one function:
`GovernedProxy.call()`. There is no other path. That is what makes the governance
claims true rather than aspirational - the risk gate, audit trail and credential
broker cannot be bypassed, because there is nowhere to bypass them from.

## Install and run

```ts
import { Kernel, MemoryStore, generateKeyHex, normalizeKey } from '@tcpcore1/kernel';

const kernel = new Kernel({
  store: new MemoryStore(), // or your own KernelStore
  encryptionKey: normalizeKey(generateKeyHex()),
  requireHttps: true,
});

await kernel.start();

await kernel.registerAdapterYaml(`
name: petstore
display_name: Petstore
base_url: https://petstore.example.com
auth: { type: none, source: credential_store }
capabilities:
  - name: get_pet
    method: GET
    path: /pet/{id}
    description: Fetch a pet by id.
    risk: low
    input:
      type: object
      properties: { id: { type: string } }
      required: [id]
`);

const result = await kernel.invoke(
  'petstore.get_pet',
  { id: '42' },
  { id: 'agent_1', name: 'Triage', type: 'AGENT', capabilities: ['petstore.get_pet'] },
);

// { status: 'executed', data: {...}, auditId: 'audit_...', latencyMs: 41 }
```

That is the whole governance path. No HTTP server, no database, no API key.

## The risk model

Declared per capability in the adapter. The gate is a **pure function** - no
I/O - so the policy is exhaustively testable.

| Declared                                    | Agent behaviour                                  | Use it for                                |
| ------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `risk: low`                                 | Executes immediately                             | Reads, reversible updates                 |
| `risk: medium` or `approval_required: true` | Enqueued; a human approves the **exact payload** | Writes that reach customers or move money |
| `risk: high`                                | Blocked for agents; a human executes             | Irreversible or high-impact actions       |
| `agent_forbidden: true`                     | Not exposed to agents at all                     | Deletes, purges, account wipes            |

Bypass conditions and the decision that produced them come back on the result, so
a caller maps them to HTTP status codes without a `try`/`catch` around policy.

**Agents with no grants can do nothing.** An absent capabilities list is treated
exactly like an empty one - fail closed. A capability is only reachable if it was
granted by exact name, `integration.*` or `*`.

`content_risk` is orthogonal: it marks capabilities whose _responses_ carry
third-party free text (a CRM note, a ticket body), so the payload is scanned and
neutralised before an agent reads it. No other MCP server makes that distinction.

## What each module owns

| Module            | Responsibility                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `Kernel`          | Composition root and the two entry points: `invoke()` and `executeApproval()`                           |
| `Registry`        | Adapter loading, YAML parsing, capability resolution                                                    |
| `RiskGate`        | The policy. Pure, synchronous, no I/O                                                                   |
| `ApprovalQueue`   | Proposal and human decision. Never executes anything itself                                             |
| `GovernedProxy`   | The single execution path: validate → SSRF-guard → credential → call → sanitise → audit                 |
| `TokenBroker`     | Credential resolution; AES-256-GCM at rest, injected at call time                                       |
| `Auditor`         | Append-only NIST AU-3 records, with secret redaction                                                    |
| `sanitizePayload` | Prompt-injection detection and neutralisation                                                           |
| `buildMcpTools`   | Declared capabilities → a minimal MCP tool list                                                         |
| `ssrf-guard`      | Outbound request authorisation: path encoding, origin assertion, plaintext-http refusal, host allowlist |

## Security posture

These are implemented, not aspirational:

- **Validation runs before the gate.** A malformed proposal is never queued, so a
  human is never asked to approve a payload that fails its own schema.
- **Only an `APPROVED` request can execute.** Not `PENDING`. The human-in-the-loop
  guarantee does not depend on every caller remembering to approve first.
- **Credentials are never held by the agent** and never written to an audit row.
  `redactForAudit` strips secret-shaped values and sensitive key names, including
  inside `metadata`.
- **SSRF is treated as a real threat.** Path parameters are percent-encoded,
  the resolved origin is asserted equal to the integration's, plaintext HTTP to a
  non-loopback host is refused, redirects are never followed, and userinfo in a
  URL is rejected.
- **Prompt-injection detection runs on the original phrasing**, before
  neutralisation, so neutralising cannot hide a genuine signal.
- **Actor identity headers are opt-in per integration.** They are not leaked to
  third-party SaaS by default, because that would fingerprint every request and
  expose internal agent ids.

## Two entry points, deliberately

```ts
// Agent-reachable. Never throws for a policy outcome.
const result = await kernel.invoke(name, args, actor);

// Human-authorised execution. Runs as the *reviewer*, never the proposing agent,
// and refuses anything not in APPROVED state.
const { result } = await kernel.executeApproval(approvalId, reviewer);
```

Policy outcomes are **values**, not exceptions: `executed`, `pending_approval`,
`denied`, `failed`. Every terminal branch returns a resolvable `auditId` - the
only exceptions are an unregistered or ambiguous capability name, where there is
no target to attribute a row to.

## Storage

`KernelStore` is the persistence boundary. The kernel never talks to Prisma (or
any ORM) directly, which is what makes it testable and self-hostable:

- `MemoryStore` ships in the box: no database at all, and the default for `tcpctl serve`.
- `PostgresKernelStore` ships in the box too, and is what you want the moment
  governance state has to survive a restart. See "Connecting PostgreSQL" below.
- A Prisma-backed store is what `apps/api` injects.

### Connecting PostgreSQL

`pg` (node-postgres) is an **optional peer dependency**. `MemoryStore` users never
install it, and the kernel never loads it unless a Postgres store is constructed.

Install the driver, apply the schema once, then get a tenant-bound store from the
factory:

```bash
npm install pg@^8
```

```ts
import { Pool } from 'pg';
import {
  Kernel,
  PostgresKernelStoreFactory,
  asTenantId,
  createPostgresSchema,
} from '@tcpcore1/kernel';

const connectionString = process.env.DATABASE_URL!;

// Once, at deploy time. Plain SQL, so you can also run it with psql.
const setupPool = new Pool({ connectionString });
await createPostgresSchema(setupPool);
await setupPool.end();

// Per process. The tenant is bound here, and nowhere else.
const storeFactory = new PostgresKernelStoreFactory({ connectionString });

const kernel = new Kernel({
  store: storeFactory.forTenant(asTenantId('acme')),
  encryptionKey: normalizeKey(generateKeyHex()),
  requireHttps: true,
});

await kernel.start();
```

Tables created: `kernel_integrations`, `kernel_capabilities`, `kernel_credentials`,
`kernel_audit_log`, `kernel_approvals`, `kernel_agent_runs`. The DDL is exported as
`POSTGRES_KERNEL_SCHEMA_SQL` if you would rather review or own the migration
yourself. The store does not create tables on first use, because that would run
DDL with whatever privileges the runtime role happens to hold.

#### A store is bound to one tenant for its lifetime

`forTenant()` takes the tenant as a required argument and returns a store that has
already captured it. No method on `KernelStore` accepts a tenant, and none defaults
to one. The tenant is taken from the factory, never from ambient state.

That is deliberate. Ambient context on the hot path beneath every governed call
fails three ways: it interleaves under concurrency, it is invisible coupling (the
store cannot be used from a worker or a CLI without a context provider), and it
fails silently, because an unset tenant makes `WHERE tenant_id = ...` match nothing,
so the caller sees an empty result rather than an error.

Isolation is structural rather than a convention you have to remember:

- Every statement in `PostgresKernelStore` carries the bound tenant as a parameter.
- `tenant_id` is the first column of every primary key and of every foreign key, so
  two tenants can hold the same integration name or capability name without
  colliding, and a capability cannot reference another tenant's integration.
- The schema enables row level security with a policy that compares against
  `app.tenant_id`. It is defence in depth, and it defers to the application's own
  predicate when the setting is absent, so it cannot silently return nothing.

`SINGLE_TENANT` is accepted only when the factory is constructed with
`{ allowSingleTenant: true }`. A single-tenant self-host says so explicitly; a
multi-tenant deployment cannot reach the sentinel by accident.

### Migrating from 0.1.x to 0.2.0

`0.1.x` had nowhere to bind a tenant, so a store was passed straight to the kernel.
`0.2.0` adds the factory, and `tcpctl serve` gained `--store postgres`. The
in-memory path is unchanged, so an existing single-process deployment that does not
want a database needs no code change at all.

Old call shape (`0.1.x`), unchanged and still supported:

```ts
import { Kernel, MemoryStore } from '@tcpcore1/kernel';

const kernel = new Kernel({
  store: new MemoryStore(),
  requireHttps: true,
});
```

New call shape (`0.2.0`), tenant bound at the factory, database optional but durable:

```ts
import { Kernel, PostgresKernelStoreFactory, asTenantId } from '@tcpcore1/kernel';

const factory = new PostgresKernelStoreFactory({
  connectionString: process.env.DATABASE_URL!,
});

const kernel = new Kernel({
  // The tenant is decided here, once, not by each query.
  store: factory.forTenant(asTenantId(process.env.TCPCORE_TENANT_ID ?? '__single__')),
  requireHttps: true,
});

// On shutdown, so the pool is closed rather than left for the server to reap.
await factory.end();
```

Or from the command line, with the in-memory default untouched:

```bash
# unchanged: no database required
tcpctl serve adapters/builtin/*.yaml

# new: governance state survives a restart
tcpctl serve adapters/builtin/*.yaml --store postgres --database-url postgres://user:pw@localhost:5432/tcpcore
```

## MCP

```ts
kernel.mcpTools(); // minimal tool list, derived from what you declared
kernel.mcpManifest(); // legacy manifest for a console
kernel.mcpServerInfo(); // the `initialize` result an MCP client expects
```

High-risk and `agent_forbidden` capabilities are never listed. Tool descriptions
carry the risk note, because the description is the only place an agent learns
about risk - the kernel enforces it regardless.

## What this package does not do

- **No HTTP server.** That is `apps/api` or `tcpctl serve`.
- **No tenant management.** The kernel binds a tenant and isolates rows
  structurally, which is what a store needs. Creating, naming, suspending or
  billing tenants, and SSO above them, are commercial phases and are not installed
  by this package. Nothing here depends on them, imports them, or is disabled
  without them.
- **No agent framework.** It governs calls; it does not decide what to call.

## Testing

```bash
pnpm --filter @tcpcore1/kernel build
pnpm vitest run packages/kernel
```

The suite covers the invariants above, including regression tests that fail if
`executeApproval` ever accepts a non-`APPROVED` request, if a bare agent regains
access, or if a denial branch stops returning an audit id.

Two suites cover storage specifically:

- `src/__tests__/store-tenant-isolation.test.ts` drives a recording pool and fails
  if any statement loses its tenant parameter. It needs no database, so it runs on
  every commit.
- `scripts/verify-postgres-store.mjs` proves the same claims against a real
  PostgreSQL server: it boots a disposable cluster, applies the schema, exercises
  every `KernelStore` method, and asserts that a second tenant cannot read the
  first tenant's rows.

```bash
node scripts/verify-postgres-store.mjs
```

## License

MIT. See [LICENSE](./LICENSE). Every package in the repository ships its own copy.

The kernel is MIT on purpose: the goal is ubiquity, and you can drop it into a
proprietary platform without a second thought. A commercial cloud layer exists
separately and is additive - it cannot disable the risk gate, approvals, audit
trail, sanitiser or MCP surface, and a test asserts that in every licence state.

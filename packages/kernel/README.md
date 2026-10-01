# @tcpcore1/kernel

**The TCPcore governance kernel.** The layer between your agents and any API:
agent identity, a risk gate, a human approval queue, credential brokering, a
prompt-injection sanitiser, and a NIST AU-3 audit trail.

MIT licensed. Domain-agnostic. No database required.

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

- `MemoryStore` ships in the box - no database at all.
- A Prisma-backed store is what `apps/api` injects.
- `tcpctl serve` uses the in-memory store so the CLI runs with no database.

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
- **No multi-tenancy, SSO or billing.** Those are commercial phases and are not
  installed by this package. Nothing in this package depends on them, imports
  them, or is disabled without them.
- **No agent framework.** It governs calls; it does not decide what to call.

## Testing

```bash
pnpm --filter @tcpcore1/kernel build
pnpm vitest run packages/kernel
```

The suite covers the invariants above, including regression tests that fail if
`executeApproval` ever accepts a non-`APPROVED` request, if a bare agent regains
access, or if a denial branch stops returning an audit id.

## License

MIT. See [LICENSE](./LICENSE). Every package in the repository ships its own copy.

The kernel is MIT on purpose: the goal is ubiquity, and you can drop it into a
proprietary platform without a second thought. A commercial cloud layer exists
separately and is additive - it cannot disable the risk gate, approvals, audit
trail, sanitiser or MCP surface, and a test asserts that in every licence state.

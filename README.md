<div align="center">

# TCPcore

**Put a governance boundary between your agents and every API they can reach.**

Declared capabilities only. Risk-tiered execution. Human approval for anything
consequential. Credential brokering, so no agent ever holds a key. And a complete
audit trail of every call, every decision, and every denial.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/TCPCore/core/actions/workflows/ci.yml/badge.svg)](https://github.com/TCPCore/core/actions/workflows/ci.yml)
[![npm: @tcpcore1/kernel](https://img.shields.io/npm/v/@tcpcore1/kernel?label=%40tcpcore1%2Fkernel)](https://www.npmjs.com/package/@tcpcore1/kernel)
[![npm: @tcpcore1/cli](https://img.shields.io/npm/v/@tcpcore1/cli?label=%40tcpcore1%2Fcli)](https://www.npmjs.com/package/@tcpcore1/cli)

[Quickstart](#quickstart) · [Adapter format](#the-adapter-format) · [Risk model](#the-risk-model) · [Packages](#packages) · [Contributing](#contributing)

</div>

---

## The problem

Vendor-provided MCP servers are maximalist by design. They expose everything, so
an agent receives a tool catalogue with dozens or hundreds of entries. Tokens
burn, latency climbs, and the attack surface for prompt injection or privilege
escalation grows with every tool you did not need.

At the same time, agent identity is largely absent. Most platforms treat agents
as anonymous callers: no role, no audit trail, no permission model. When
something goes wrong you cannot answer _"which agent did this, on whose
authority, and was it allowed?"_

TCPcore is the missing layer. Not an agent framework. Not another MCP server. A
governance kernel between your agents and any API.

## What you get

| Concern                      | How TCPcore handles it                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Tool discovery**           | Compiles your declared capabilities into a minimal MCP tool list — only what you declared                             |
| **Agent identity**           | Every agent is a first-class actor with a role, a scoped credential and a name in the audit log                       |
| **Permissions**              | Risk tiers: `low` runs immediately, `medium` goes to a human approval queue, `high` and `agent_forbidden` are blocked |
| **Audit trail**              | Every call logged with actor, capability, target, payload, outcome and latency (NIST SP 800-53 AU-3)                  |
| **Approvals**                | Medium-risk actions are _proposed_, never executed. A human approves the exact payload                                |
| **Credential brokering**     | The agent never holds a vendor key. Tokens are AES-256-GCM encrypted at rest and injected at call time                |
| **Prompt-injection defence** | Responses carrying third-party text are scanned, and detected injection is flagged and labelled as untrusted before an agent reads them |
| **Schema validation**        | Arguments are validated against the declared schema _before_ any outbound call                                        |
| **Kill switches**            | Global, per-integration and per-agent                                                                                 |

The kernel is domain-agnostic: it knows about integrations, capabilities, actors
and audit records — not tickets or clients.

In one sentence: **TCPcore puts a governance boundary between your agents and
every API they can reach. Declared capabilities only. Risk-tiered execution.
Human approval for anything consequential. Credential brokering so no agent ever
holds a key. And a complete audit trail of every call, every decision, and every
denial.**

Every clause in that sentence is a thing the code does on the only path an agent
has to an integration, and each one is covered by a test.

## The one invariant

Every agent-originated call reaches an integration through exactly one function.
There is no other path. That is what makes the governance claims true rather than
aspirational — the risk gate, audit trail and credential broker cannot be
bypassed, because there is nowhere to bypass them from.

## What TCPcore governs, and what it does not

This boundary is the product. Stating it plainly is more useful than a broader
claim would be.

```
┌─────────────────────────────────────────────────────┐
│  The agent's runtime                                │
│  ─────────────────                                  │
│  Reasoning, memory, tool selection, and any other   │
│  network path — NOT governed by TCPcore             │
│                                                     │
│   ┌─────────────────────────────────────────────┐   │
│   │  TCPcore                                    │   │
│   │  Every call to a declared integration:      │   │
│   │    · validated against its schema           │   │
│   │    · risk-gated                             │   │
│   │    · credential-brokered                    │   │
│   │    · response-sanitised                     │   │
│   │    · audit-logged                           │   │
│   │                                             │   │
│   │  This is what TCPcore governs.              │   │
│   └─────────────────────────────────────────────┘   │
│                                                     │
│  Everything else is out of scope.                   │
└─────────────────────────────────────────────────────┘
```

| In scope | Out of scope |
|---|---|
| Calls an agent makes to a **declared** integration | The agent's reasoning, planning or memory |
| Whether such a call is permitted, queued or refused | Network paths that do not go through the kernel |
| Validation of arguments before any I/O | The contents of a model's context window |
| Injection patterns in **responses from declared integrations** | Injection that arrives by any other route |
| Who called, what they asked for, what was decided | Whether the agent *behaves* well in general |

**TCPcore does not prevent prompt injection, and does not claim to.** It detects
instruction-shaped content in responses from declared integrations, reports what
it found, and labels that content untrusted. A determined injection can still
influence an agent. What changes is that the influence is *visible*, and that
whatever the agent decides next still has to pass the risk gate to reach a
declared API.

In one sentence:

> TCPcore governs every call an agent makes to a declared API. It cannot govern
> the agent's reasoning, and it does not try. What it can do is make sure that
> whatever the agent decides, the call either stays within declared bounds, goes
> to a human, or is refused — and that every outcome is recorded.

A kernel that claimed to control an agent's reasoning would be describing a
sandbox, not a governance layer. This one is deliberately scoped, which is why
its guarantees are small enough to be true and specific enough to be tested.

## Install

```bash
npm install @tcpcore1/kernel      # the kernel
npm install @tcpcore1/cli         # or the CLI, which bundles everything
```

Nothing to provision. No database, no Redis, no account.

## Quickstart

### Generate a governed adapter from any spec

```bash
npx @tcpcore1/cli generate https://petstore.swagger.io/v2/swagger.json -o petstore.yaml
```

Check what it produced:

```bash
npx @tcpcore1/cli validate petstore.yaml
```

The integration name comes from the spec's `title`, snake_cased, and each
`operationId` is snake_cased into a capability. A spec titled _Swagger Petstore_
with `getPetById`, `addPet` and `getInventory` produces integration
`swagger_petstore` and capabilities `get_pet_by_id`, `add_pet`, `get_inventory` —
so the full names are `swagger_petstore.get_pet_by_id` and so on. **Run
`validate` to see the names your own spec produced**; they follow from the spec
rather than from a convention you have to guess.

### Serve it over MCP

```bash
npx @tcpcore1/cli serve petstore.yaml --port 8080
```

`http://localhost:8080/api/mcp/tools` then lists a governed, minimal tool
surface, and `/api/mcp` speaks JSON-RPC 2.0, which is the transport MCP clients
use.

### Watch the governance model decide

```bash
# medium risk -> returns pending_approval and an approval id.
# Nothing is sent to the target API, and no credential is needed to see this:
# the risk gate decides before the proxy is ever reached.
npx @tcpcore1/cli invoke swagger_petstore.add_pet \
  --adapter petstore.yaml \
  --args '{"name":"Rex","status":"available"}'
```

```bash
# low risk -> would execute immediately, but this one reaches the real target,
# so it needs a credential for the integration. Without one it fails at
# credential resolution — which is itself the guarantee: the agent never holds
# the key.
npx @tcpcore1/cli invoke swagger_petstore.get_inventory \
  --adapter petstore.yaml --args '{}'
```

The gate is the interesting part, and it needs no credential to observe: the tool
list, the risk tiers, the approval queue and the audit trail all work before any
upstream call is possible.

### Use it as a library

```ts
import { Kernel, MemoryStore } from '@tcpcore1/kernel';
import { loadAdapterFile } from '@tcpcore1/adapters';

const kernel = new Kernel({ store: new MemoryStore() });
await kernel.start();
await kernel.registerAdapter(await loadAdapterFile('./petstore.yaml'), { enabled: true });

// Every call goes through one governed path.
const result = await kernel.invoke(
  'swagger_petstore.get_pet_by_id',
  { petId: '1' },
  {
    id: 'agent-1',
    type: 'AGENT',
    role: 'viewer',
    capabilities: ['swagger_petstore.get_pet_by_id'],
  },
  { requestId: 'req-1' },
);

console.log(result.status); // 'executed' | 'pending_approval' | 'denied' | 'failed'
```

`MemoryStore` keeps state in the process, so the audit trail and approval queue
are cleared on restart. Storage is an injectable port — swapping in a durable
backend changes nothing else in the kernel.

## The adapter format

One file per integration. This is the entire public contract:

```yaml
name: salesforce
display_name: Salesforce Sales Cloud
base_url: https://your-instance.salesforce.com/services/data/v60.0
auth:
  type: oauth2
  token_endpoint: https://login.salesforce.com/services/oauth2/token
  scopes: [api, refresh_token]

capabilities:
  - name: get_opportunity
    method: GET
    path: /sobjects/Opportunity/{id}
    description: Retrieve an opportunity, including its stage and amount.
    risk: low
    content_risk: medium # response carries third-party text
    input:
      type: object
      properties:
        id: { type: string, description: 'Salesforce opportunity ID' }
      required: [id]

  - name: update_opportunity_stage
    method: PATCH
    path: /sobjects/Opportunity/{id}
    description: Move an opportunity to a new pipeline stage.
    risk: medium
    approval_required: true # a human approves the exact payload
    input:
      type: object
      properties:
        id: { type: string }
        stage:
          type: string
          enum: [Prospecting, Qualification, Proposal, Negotiation, Closed Won, Closed Lost]
      required: [id, stage]

  - name: delete_opportunity
    method: DELETE
    path: /sobjects/Opportunity/{id}
    description: Permanently delete an opportunity. Irreversible.
    risk: high
    agent_forbidden: true # agents cannot even propose this
    input:
      type: object
      properties:
        id: { type: string }
      required: [id]
```

Generate one from any spec instead of hand-writing it:

```bash
npx @tcpcore1/cli generate ./openapi.json -o my-service.yaml
npx @tcpcore1/cli generate https://api.example.com/openapi.json -o my-service.yaml
npx @tcpcore1/cli generate ./postman.json --from postman -o my-service.yaml
```

The generator infers a risk level per operation, writes its reasoning as YAML
comments, and redacts credential-shaped values. **You still review it** — this
file is the policy the kernel enforces.

Regenerating is safe. `--merge` refreshes the mechanical fields from the spec
while preserving every risk level, `approval_required` and `agent_forbidden`
value a human set, and marks disappeared capabilities `deprecated` rather than
deleting them:

```bash
npx @tcpcore1/cli generate ./openapi.json --merge my-service.yaml -o my-service.yaml
```

## The risk model

| Declared                                   | Agent behaviour                              | Use it for                                |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------- |
| `risk: low`                                | Executes immediately                         | Reads, reversible updates                 |
| `risk: medium` + `approval_required: true` | Enqueued; a human approves the exact payload | Writes that reach customers or move money |
| `risk: high`                               | Blocked for agents; a human executes         | Irreversible or high-impact actions       |
| `agent_forbidden: true`                    | Not exposed to agents at all                 | Deletes, purges, account wipes            |

Humans are never subject to `agent_forbidden` or `risk: high` — those flags
describe what _agents_ may do. Human access is governed by RBAC.

`content_risk` is orthogonal: it marks capabilities whose _responses_ carry
third-party free text, so the kernel scans the payload and reports what it found
before an agent can read it:

```json
{
  "status": "executed",
  "sanitized": true,
  "injectionSignals": ["instruction_override@body", "system_prompt_exfiltration@body"]
}
```

The payload is **flagged rather than deleted** — an operator usually needs to see
what arrived, and silently stripping text loses evidence.

## Packages

| Package                                     | What it is                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`@tcpcore1/kernel`](./packages/kernel)     | Registry, risk gate, governed proxy, token broker, audit trail, approval queue, MCP surface, injection sanitiser |
| [`@tcpcore1/adapters`](./packages/adapters) | The adapter format — loader, validator, and the OpenAPI/Swagger/Postman/HAR generator                            |
| [`@tcpcore1/cli`](./packages/cli)           | `tcpctl` — init, generate, validate, serve, invoke                                                               |
| [`@tcpcore1/shared`](./packages/shared)     | Zod schemas, TypeScript types and constants                                                                      |

Adapters live in [`adapters/builtin`](./adapters/builtin) (internal reference,
Salesforce, Stripe, HubSpot) and [`adapters/community`](./adapters/community).
See the [adapter gallery](./adapters/community/README.md).

## Security posture

Implemented, not aspirational:

1. **No agent can reach an integration without passing through one governed path.**
2. **No credential ever appears in a response body or an audit row.**
3. **Validation runs before the risk gate**, so a malformed proposal is never
   queued for a human to approve.
4. **Only an `APPROVED` request can execute** — not `PENDING`. The
   human-in-the-loop guarantee does not depend on every caller behaving.
5. **An agent with no grants can do nothing.** An absent capabilities list is
   treated exactly like an empty one: fail closed.
6. **The risk gate is a pure function with no I/O**, so the policy is
   exhaustively testable.

## Documentation

| Guide                                             | What it covers                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [Kernel](./packages/kernel/README.md)             | What each module owns, the one invariant, storage, MCP, security posture |
| [Adapter format](./packages/adapters/README.md)   | The file format, the loader and validator, and the generator             |
| [CLI](./packages/cli/README.md)                   | Every `tcpctl` command, with examples                                    |
| [Schemas](./packages/shared/README.md)            | The Zod schemas and TypeScript types                                     |
| [Adapter gallery](./adapters/community/README.md) | Community-contributed adapters and how to add one                        |
| [Threat model](./docs/THREAT-MODEL.md)            | What is defended, by which control, and what is out of scope             |
| [Contributing](./CONTRIBUTING.md)                 | Ten-minute guide to contributing an adapter                              |
| [Security](./SECURITY.md)                         | Disclosure process and response targets                                  |
| [Changelog](./CHANGELOG.md)                       | Release history                                                          |

## Contributing

The highest-impact contribution is a community adapter. It takes about ten
minutes and makes a SaaS agent-ready for everyone:

```bash
npx @tcpcore1/cli generate https://api.example.com/openapi.json \
  -o adapters/community/example.yaml
# review every risk level by hand, then:
npx @tcpcore1/cli validate adapters/community/example.yaml
```

Open a PR; CI validates the format automatically and a maintainer reviews the
risk assignments. Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md)
for the disclosure process, and [docs/THREAT-MODEL.md](./docs/THREAT-MODEL.md) for
what the kernel does and does not defend against.

## Development

```bash
pnpm install
pnpm build        # all four packages, in dependency order
pnpm test
pnpm check        # build + lint + format + test, what CI runs
```

## Licence

MIT, everywhere. See [LICENSE](./LICENSE); every package ships its own copy.

The kernel and the adapter format are MIT on purpose: the goal is ubiquity. You
can drop `@tcpcore1/kernel` into a proprietary platform without a second thought.

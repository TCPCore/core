<div align="center">

# TCPcore

**Turn any API into a governed, agent-callable surface — in minutes.**

Declare your capabilities in YAML. Get agent identity, permissions, a human
approval queue, and a NIST AU-3 audit trail for free. Expose exactly the tools an
agent needs, and nothing else.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/TCPCore/core/actions/workflows/ci.yml/badge.svg)](https://github.com/TCPCore/core/actions/workflows/ci.yml)
[![npm: @tcpcore1/kernel](https://img.shields.io/npm/v/@tcpcore1/kernel?label=%40tcpcore1%2Fkernel)](https://www.npmjs.com/package/@tcpcore1/kernel)
[![npm: @tcpcore1/cli](https://img.shields.io/npm/v/@tcpcore1/cli?label=%40tcpcore1%2Fcli)](https://www.npmjs.com/package/@tcpcore1/cli)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Adapter format](#the-adapter-format) · [Risk model](#the-risk-model) · [Docker](#run-it-locally) · [Docs](https://docs.tcpcore.dev)

<!--
  Deploy button — replace RAILWAY_TEMPLATE_CODE once the public template exists.
  [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/tcpcore?referralCode=RAILWAY_TEMPLATE_CODE)
-->

</div>

---

## The problem

Vendor-provided MCP servers are maximalist by design. They expose everything, so
an agent receives a tool catalogue with dozens or hundreds of entries. Tokens
burn, latency climbs, and the attack surface for prompt injection or privilege
escalation grows with every tool you did not need.

At the same time, agent identity is largely absent. Most platforms treat agents
as anonymous callers: no role, no audit trail, no permission model. When
something goes wrong you cannot answer "which agent did this, on whose authority,
and was it allowed?"

TCPcore is the missing layer. Not an agent framework. Not another MCP server. A
thin governance kernel between your agents and any API.

## What you get

| Concern                      | How TCPcore handles it                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Tool discovery**           | Compiles your declared capabilities into a minimal MCP tool list — only what you declared                                      |
| **Agent identity**           | Every agent is a first-class actor with a role, a scoped credential and a name in the audit log                                |
| **Permissions**              | Risk tiers: `low` runs free, `medium` goes to a human approval queue, `high` and `agent_forbidden` are blocked                 |
| **Audit trail**              | Every call logged with actor, capability, target, payload, outcome and latency (NIST SP 800-53 AU-3)                           |
| **Approvals**                | Medium-risk actions are _proposed_, never executed. A human approves the exact payload, and the execution runs as the reviewer |
| **Credential brokering**     | The agent never holds a vendor key. Tokens are AES-256-GCM encrypted at rest and injected at call time                         |
| **Prompt-injection defence** | Responses that carry third-party text are scanned and neutralised before an agent reads them                                   |
| **Schema validation**        | Arguments are validated against the declared schema _before_ any outbound call                                                 |
| **Kill switches**            | Global, per-integration and per-agent. Mute a misbehaving adapter without touching agents                                      |

The kernel is domain-agnostic: it knows about integrations, capabilities, actors
and audit records — not tickets or clients. The ticket manager shipped in this
repo is the _reference adapter_, not the product.

## Quickstart

**Try it with no database and no API key:**

```bash
git clone https://github.com/TCPCore/core
cd tcpcore
pnpm install
pnpm --filter @tcpcore1/shared build && pnpm --filter @tcpcore1/kernel build && pnpm --filter @tcpcore1/adapters build && pnpm --filter @tcpcore1/cli build

# Turns an OpenAPI spec into a governed adapter, with a risk level per operation
node packages/cli/bin/tcpctl.js generate https://petstore.swagger.io/v2/swagger.json -o petstore.yaml

# Review the risk levels, then run the kernel against it
node packages/cli/bin/tcpctl.js validate petstore.yaml
node packages/cli/bin/tcpctl.js serve petstore.yaml --port 8080
```

`http://localhost:8080/api/mcp/tools` now lists a governed, minimal tool surface.
Point Cursor or Claude Desktop at `http://localhost:8080/api/mcp` and the agent
sees only the capabilities you declared.

**See the governance model decide, without writing any code:**

Capability names come from the spec, so the generated adapter prefixes them with
the API title and snake_cases the operation — `petstore.getPetById` in a spec
becomes `swagger_petstore.get_pet_by_id`. Check the names your adapter actually
produced:

```bash
node packages/cli/bin/tcpctl.js validate petstore.yaml   # lists warnings per capability
```

```bash
# medium risk -> returns pending_approval and an approval id.
# Nothing is sent to the target API, and no credential is needed to see this:
# the risk gate decides before the proxy is ever reached.
node packages/cli/bin/tcpctl.js invoke swagger_petstore.add_pet \
  --adapter petstore.yaml \
  --args '{"name":"Rex","photoUrls":["https://example.com/rex.jpg"]}'

# low risk -> executes immediately. This one reaches the real target, so it
# needs a credential stored for the integration (`tcpctl serve` has an
# integrations API for that). Without one it fails at credential resolution —
# which is itself the guarantee: the agent never holds the key.
node packages/cli/bin/tcpctl.js invoke swagger_petstore.get_inventory \
  --adapter petstore.yaml --args '{}'
```

## Run it locally

The full stack — API, governance kernel, worker, admin console, PostgreSQL and
Redis — comes up with one command:

```bash
git clone https://github.com/TCPCore/core
cd tcpcore
cp .env.example .env

# Generate the three required secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TCPCORE_CREDENTIAL_KEY

# Paste each value into .env, then:
docker compose up -d
open http://localhost:3000
```

The API runs `prisma migrate deploy` on start, so a fresh clone with an empty
volume comes up with the schema applied.

For the seeded sandbox — mock Salesforce, Stripe and HubSpot backends, demo
accounts, no outbound network access:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d
# then sign in with admin@demo.tcpcore.dev / demo1234
```

## How it works

```
                       ┌──────────────────────────────────┐
   Triage  ─┐          │     TCPcore Governance Kernel     │
   Draft     │         │  ──────────────────────────────   │
   Summarizer├────────▶│  identity · capability registry   │
   External  │  /capabilities/:name/invoke               │
   MCP agent ┘  /api/mcp/tools/call                     │
                       │  risk gate   low → run            │
                       │              med → approval queue │
                       │              high → 403           │
                       │  ──────────────────────────────   │
                       │  governedCall (the only way out)  │
                       │  token broker · audit · sanitizer │
                       └───────────────┬──────────────────┘
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
   internal       salesforce        stripe         hubspot     any OpenAPI
   (tickets)       adapter          adapter        adapter      adapter
```

Every agent-originated call — internal or external — passes through one of two
entry points, and both call `governedCall`. There is no other path to an
integration. That invariant is what makes the governance claims true.

Read the full design in the [architecture docs](https://docs.tcpcore.dev/concepts/governance-kernel).

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
tcpctl generate ./openapi.json -o my-service.yaml
tcpctl generate https://api.example.com/openapi.json -o my-service.yaml
tcpctl generate ./postman.json --from postman -o my-service.yaml
```

The generator infers a risk level per operation, writes the reasoning as YAML
comments, and redacts credential-shaped values. **You still review it** — this
file is the policy the kernel enforces.

Regenerating is safe. `--merge` refreshes the mechanical fields from the spec
while preserving every risk level, `approval_required` and `agent_forbidden`
value a human set, and marks disappeared capabilities `deprecated` instead of
deleting them:

```bash
tcpctl generate ./openapi.json --merge my-service.yaml -o my-service.yaml
```

## The risk model

| Declared                                   | Agent behaviour                              | Use it for                                |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------- |
| `risk: low`                                | Executes immediately                         | Reads, reversible updates                 |
| `risk: medium` + `approval_required: true` | Enqueued; a human approves the exact payload | Writes that reach customers or move money |
| `risk: high`                               | Blocked for agents; a human executes         | Irreversible or high-impact actions       |
| `agent_forbidden: true`                    | Not exposed to agents at all                 | Deletes, purges, account wipes            |

Humans are never subject to `agent_forbidden` or `risk: high` — those flags
describe what _agents_ may do. Human access is governed by RBAC on the domain
routes.

`content_risk` is orthogonal: it marks capabilities whose _responses_ carry
third-party free text, so the kernel prompt-injection-scans the payload before an
agent can read it. No other MCP server makes this distinction today.

## Packages

| Package                                     | What it is                                                                                                           | License |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| [`@tcpcore1/kernel`](./packages/kernel)     | The governance kernel — registry, risk gate, proxy, token broker, audit, approvals, MCP surface, injection sanitiser | MIT     |
| [`@tcpcore1/adapters`](./packages/adapters) | The adapter format — loader, validator, and the OpenAPI/Swagger/Postman/HAR generator                                | MIT     |
| [`@tcpcore1/cli`](./packages/cli)           | `tcpctl` — init, generate, validate, serve, invoke                                                                   | MIT     |
| [`@tcpcore1/shared`](./packages/shared)     | Zod schemas, TypeScript types and constants                                                                          | MIT     |
| [`apps/api`](./apps/api)                    | Hono HTTP API, domain routes, agent runtime, BullMQ worker                                                           | MIT     |
| [`apps/web`](./apps/web)                    | React admin console (Studio)                                                                                         | MIT     |
| [`apps/demo`](./apps/demo)                  | Mock SaaS backends, seeding, sandbox guard                                                                           | MIT     |
| [`apps/docs`](./apps/docs)                  | Astro Starlight documentation site                                                                                   | MIT     |

Adapters themselves live in [`adapters/builtin`](./adapters/builtin) and
[`adapters/community`](./adapters/community). See the
[adapter gallery](./adapters/community/README.md).

## Licensing

MIT, everywhere. See [LICENSE](./LICENSE); every package ships its own copy.

The kernel and the adapter format are MIT on purpose: the goal is ubiquity. You
can drop `@tcpcore1/kernel` into a proprietary platform without a second thought.

A managed cloud offering — SSO/SAML, cross-tenant audit aggregation, advanced
token-cost analytics, and a hosted adapter registry — is planned and will be
commercial. The self-hosted product in this repository is not crippled to create
that upsell; it is the whole governance layer.

That commercial layer now exists in outline under [`cloud/`](./cloud/), built as
six independently deployable phases. It is additive by construction: no phase can
disable the risk gate, approval queue, audit trail, prompt-injection sanitiser or
MCP surface, and a test asserts exactly that across every licence state including
expired. Start with [`cloud/PHASE-ARCHITECTURE.md`](./cloud/PHASE-ARCHITECTURE.md)
for the design, and [`cloud/VERIFICATION.md`](./cloud/VERIFICATION.md) to check
the claim yourself.

Nothing in `cloud/` is installed by this repository's build. The kernel below is
complete without it.

## Documentation

| Guide                                                           | What it covers                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Architecture](./docs/ARCHITECTURE.md)                          | Every package, module and design decision, with the reasoning                                 |
| [Deployment](./docs/DEPLOYMENT.md)                              | Docker locally, Railway one-click, the public demo, production hardening, troubleshooting     |
| [Licensing](./docs/LICENSING.md)                                | What MIT permits, how it is wired into every package, the commercial line                     |
| [Verification](./docs/VERIFICATION.md)                          | Seven stages of commands to independently check every claim, and what is _not_ verified       |
| [Commercial layer](./cloud/README.md)                           | The six phases: sponsorship, licensing, multi-tenancy, billing, aggregation, adapter registry |
| [Phase architecture](./cloud/PHASE-ARCHITECTURE.md)             | Where the MIT/commercial boundary sits, and why each phase deploys separately                 |
| [Commercial verification](./cloud/VERIFICATION.md)              | How to independently confirm the governance guarantee holds                                   |
| [Build contract](./docs/internal/BUILD-CONTRACT.md)             | The frozen interfaces: ports, env vars, routes, package exports                               |
| [Audit & remediation](./docs/internal/AUDIT-AND-REMEDIATION.md) | What was wrong in the prototype, and how each flaw was fixed                                  |
| [Completion report](./docs/internal/COMPLETION-REPORT.md)       | What was verified by execution, and what still needs Docker                                   |
| [Docs site](./apps/docs)                                        | The public documentation (Astro Starlight, 24 pages)                                          |

## Contributing

The highest-impact contribution is a community adapter. It takes about ten
minutes and makes a SaaS agent-ready for everyone:

```bash
pnpm tcpctl generate https://api.example.com/openapi.json \
  -o adapters/community/example.yaml
# review every risk level by hand, then:
pnpm tcpctl validate adapters/community/example.yaml
```

Open a PR; CI validates the format automatically and a maintainer reviews the
risk assignments. Full guide in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md)
for the disclosure process and our response targets.

Two invariants we hold ourselves to, and test for:

1. **No agent can reach an integration without passing through `governedCall`.**
2. **No credential ever appears in a response body or an audit row.**

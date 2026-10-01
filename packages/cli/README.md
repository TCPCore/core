# @tcpcore1/cli

**`tcpctl`** - turn any API into a governed, agent-callable surface from the
terminal. No database, no API key, no code.

MIT licensed.

```bash
npm install -g @tcpcore1/cli
# or, without installing:
npx @tcpcore1/cli --help
```

---

## Commands

| Command    | What it does                                                           |
| ---------- | ---------------------------------------------------------------------- |
| `init`     | Scaffold a new adapter with the fields you must fill in                |
| `generate` | Turn an OpenAPI / Swagger / Postman / HAR spec into a governed adapter |
| `validate` | Check one or more adapters, with a warning per capability              |
| `serve`    | Run the governance kernel locally as an HTTP + MCP server              |
| `invoke`   | Call a capability through the full governance path                     |
| `manifest` | Export the command surface as JSON, for tooling                        |

## Try it in two minutes

```bash
# 1. Turn the public Petstore spec into a governed adapter
tcpctl generate https://petstore.swagger.io/v2/swagger.json -o petstore.yaml
#    ✓ 20 capabilities - 8 low · 9 medium · 3 high

# 2. Read the risk levels it inferred. This is the part you review by hand.
tcpctl validate petstore.yaml

# 3. Watch the governance model decide - no credential, no database, no key
tcpctl invoke swagger_petstore.add_pet --adapter petstore.yaml \
  --args '{"name":"Rex","photoUrls":["https://example.com/rex.jpg"]}'
```

Step 3 prints:

```
ℹ swagger_petstore.add_pet (POST /pet, medium risk)
ℹ Acting as AGENT "cli-agent"

⚠ pending_approval - the risk gate enqueued this for a human.

  approvalId: appr_8534ca4b-...
  riskLevel:  medium

Nothing was sent to the target API. A human must approve the exact payload before it executes.
```

That is the whole product in one command: a mutating operation was **proposed**,
not executed, and nothing left the machine.

> **Capability names come from the spec.** The generated adapter prefixes each
> name with the API title and snake_cases the operation, so `getPetById` becomes
> `swagger_petstore.get_pet_by_id`. Run `tcpctl validate` to see the names your
> adapter actually produced, or pass an unambiguous suffix and let the CLI list
> the candidates.

## Run a kernel locally

```bash
tcpctl serve petstore.yaml --port 8080
```

Serves the governed surface over HTTP:

- `GET  /api/mcp/tools` - the minimal tool list an agent sees
- `POST /api/mcp/tools/call` - invoke a capability
- `GET  /api/audit-log` - the NIST AU-3 trail

Point Cursor or Claude Desktop at `http://localhost:8080/api/mcp` and the agent
sees **only** the capabilities you declared. High-risk and `agent_forbidden`
operations are not listed at all.

`serve` uses an in-memory store, so it runs with no database. Integrations that
need a credential are configured through its HTTP API - which is the point: the
agent never holds the vendor key, the kernel injects it at call time.

## Invoke

```bash
tcpctl invoke <capability> --adapter <file> --args '<json>'
tcpctl invoke <capability> --adapter a.yaml --adapter b.yaml --args '{}'
```

Exit codes are meaningful, so it composes in a script:

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | The call executed, or was queued for approval |
| `1`  | Denied, failed, or a validation error         |
| `2`  | Usage error - bad flags or arguments          |

`denied` (policy) is distinguished from `failed` (technical), so a wrapper script
can tell "you may not" from "the network broke".

## Generate

```bash
tcpctl generate ./openapi.json  -o my-service.yaml
tcpctl generate https://api.example.com/openapi.json -o my-service.yaml
tcpctl generate ./postman.json --from postman -o my-service.yaml
tcpctl generate ./recording.har --from har     -o my-service.yaml
```

Formats: OpenAPI 3, Swagger 2, Postman collections and HAR recordings. The
generator infers a risk level per operation, writes its reasoning into the file
as comments, and redacts credential-shaped values.

**Regenerating is safe.** `--merge` refreshes the mechanical fields while
preserving every risk level a human set, and marks vanished capabilities
`deprecated` rather than deleting them:

```bash
tcpctl generate ./openapi.json --merge my-service.yaml -o my-service.yaml
```

## Validate

```bash
tcpctl validate my-service.yaml
tcpctl validate adapters/builtin/*.yaml     # CI: checks every adapter
```

Reports a warning per capability - missing descriptions, suspicious risk
assignments, `content_risk` on a capability that looks like it returns
third-party text. Exits non-zero on an invalid adapter, so it drops straight into
CI.

## Programmatic use

```ts
import { main } from '@tcpcore1/cli';

const exitCode = await main(['validate', 'my-service.yaml']);
```

## License

MIT. See [LICENSE](./LICENSE).

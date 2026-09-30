# @tcpcore1/adapters

**The adapter format, and the generator that writes it.**

An adapter is one YAML file that declares how an API is exposed to agents: which
operations exist, which are reachable, and how risky each one is. This package
loads, validates and generates them.

MIT licensed. Zero runtime dependencies beyond `yaml`.

```bash
npm install @tcpcore1/adapters
```

---

## Why a file, not code

The adapter is the **policy the kernel enforces**. You review it, diff it, and
put it in version control. Generating one from an OpenAPI spec gets you 90% of
the way in seconds; the remaining 10% — the risk levels — is a human decision,
and the generator writes its reasoning into the file as comments so the review is
about judgement rather than markup.

## Generate one

```bash
tcpctl generate ./openapi.json -o my-service.yaml
tcpctl generate https://api.example.com/openapi.json -o my-service.yaml
tcpctl generate ./postman.json   --from postman   -o my-service.yaml
tcpctl generate ./recording.har  --from har       -o my-service.yaml
```

Output looks like this — note the inferred risk and the reasoning comment:

```yaml
name: petstore
display_name: Swagger Petstore
base_url: https://petstore.example.com
auth:
  type: bearer
  source: credential_store

capabilities:
  - name: get_pet_by_id
    method: GET
    path: /pet/{petId}
    description: Find pet by ID
    risk: low
    input:
      type: object
      properties:
        petId: { type: integer, format: int64 }
      required: [petId]

  # POST /pet — MEDIUM RISK
  # Risk: Mutating method POST. Requires human approval.
  # Rules: HTTP_METHOD_MUTATION
  # A HUMAN MUST APPROVE each invocation before it reaches the target.
  - name: add_pet
    method: POST
    path: /pet
    description: Add a new pet to the store
    risk: medium
    approval_required: true
```

**Regenerating is safe.** `--merge` refreshes the mechanical fields from the spec
while preserving every `risk`, `approval_required` and `agent_forbidden` value a
human set, and marks capabilities that disappeared from the spec as `deprecated`
instead of deleting them:

```bash
tcpctl generate ./openapi.json --merge my-service.yaml -o my-service.yaml
```

That is what makes the workflow usable: your risk review survives the next spec
update.

## Programmatic use

```ts
import {
  loadAdapter, // read + validate a file
  loadFromString, // validate YAML text
  validateAdapter, // validate an object
  parseSpec, // OpenAPI / Swagger / Postman / HAR → a normalised spec
  emitYaml, // spec → adapter YAML
  mergeAdapters, // refresh without losing human decisions
  sanitizeAdapter, // strip credential-shaped values
} from '@tcpcore1/adapters';

const adapter = await loadAdapter('./my-service.yaml');
```

## What is enforced

`validateAdapter` rejects an adapter that would be unsafe or unusable, including:

- A capability whose `path` is not absolute, or that carries a URL scheme —
  the kernel concatenates paths, and this is where a redirect gets caught.
- Missing `description`, since it is the only place an agent learns about risk.
- A `risk` value outside `low | medium | high`.
- Inconsistent `approval_required` on a high-risk capability, which is a
  contradiction an author almost never means.
- `auth.type: jwt` with a source that cannot supply a token.

`hasAgentReachableCapabilities` answers the question an operator actually asks
when an agent reports an empty tool list.

## Credential hygiene

`sanitizeAdapter` / `redactString` strip credential-shaped values before an
adapter is written, so a spec with an example API key in it does not become a
committed secret. **This is a safety net, not a licence to paste secrets into a
spec** — review the output.

## The format

| Field                            | Notes                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| `name`                           | `^[a-z][a-z0-9_-]*$`; the first half of every qualified capability name     |
| `base_url`                       | The integration's origin. The kernel asserts the resolved URL stays on it   |
| `auth.type`                      | `none`, `bearer`, `api_key`, `oauth2`, `jwt`                                |
| `auth.source`                    | `credential_store`, or `agent_token` to pass the caller's own token through |
| `capabilities[].risk`            | `low` executes, `medium` queues for a human, `high` blocks agents           |
| `capabilities[].agent_forbidden` | Not exposed to agents at all                                                |
| `capabilities[].content_risk`    | Marks responses carrying third-party text, so they are injection-scanned    |
| `capabilities[].input`           | JSON Schema. Validated **before** any outbound call                         |

## Built-in and community adapters

Adapters for Salesforce, Stripe, HubSpot and an internal reference service live in
`adapters/builtin`. Community-contributed ones live in `adapters/community`.

Generating one takes about ten minutes and makes a SaaS agent-ready for everyone:

```bash
tcpctl generate https://api.example.com/openapi.json \
  -o adapters/community/example.yaml
tcpctl validate adapters/community/example.yaml
```

Review every risk level by hand, then open a PR. CI validates the format; a
maintainer reviews the risk assignments.

## License

MIT. See [LICENSE](./LICENSE).

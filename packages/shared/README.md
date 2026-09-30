# @tcpcore1/shared

**Zod schemas, TypeScript types and constants shared across TCPcore.**

The single definition of every wire shape — adapters, capabilities, approvals,
audit records, integrations, actors and domain objects. If two packages disagree
about a shape, the bug is here.

MIT licensed.

```bash
npm install @tcpcore1/shared
```

---

## What is in it

| Module                | Contents                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants`           | `RISK_LEVELS`, `ACTOR_TYPES`, `AUDIT_ACTIONS`, `GOVERNED_CALL_STATUSES`, `APPROVAL_STATUSES`, `AUTH_TYPES`, `MCP_PROTOCOL_VERSION`, and the kernel's internal header names |
| `schemas/adapter`     | The adapter format: integrations, capabilities, auth, input schemas                                                                                                        |
| `schemas/integration` | `Integration`, `IntegrationCredential`, and the single `GovernedCallResult` shape                                                                                          |
| `schemas/approval`    | `ApprovalRequest` and its status machine                                                                                                                                   |
| `schemas/audit`       | `AuditLog` — the NIST AU-3 record                                                                                                                                          |
| `schemas/domain`      | Tickets, clients, comments                                                                                                                                                 |
| `schemas/user`        | Actors, roles, login and registration payloads                                                                                                                             |

## Why the result type is a discriminated union

`GovernedCallResult` is deliberately **not** one interface with optional fields.
It is a union on `status`, so narrowing gives the caller the right payload shape
without a cast — and an invalid combination (`denied` with no reason, `failed`
with no error) is unrepresentable rather than merely discouraged:

```ts
import { GovernedCallResultSchema } from '@tcpcore1/shared';

type Result = z.infer<typeof GovernedCallResultSchema>;

// status: 'executed'         -> data, latencyMs, httpStatus, sanitized, injectionSignals
// status: 'pending_approval' -> approvalId, riskLevel
// status: 'denied'           -> reason
// status: 'failed'           -> error
```

Every variant carries an `auditId`.

## Risk levels are ordered, and the order is data

```ts
import { RISK_ORDER, RISK_LEVELS } from '@tcpcore1/shared';

RISK_ORDER.low; // 0
RISK_ORDER.high; // 2
```

Exposed as data rather than hard-coded comparisons so that "is this at least
medium?" has exactly one implementation across the kernel, the registry and the
console.

## Validate anything, anywhere

Every schema is a Zod schema first and a TypeScript type second, so the same
definition validates incoming JSON, a YAML adapter, or a webhook body:

```ts
import { AdapterConfigSchema } from '@tcpcore1/shared';

const parsed = AdapterConfigSchema.safeParse(yamlObject);
if (!parsed.success) {
  // parsed.error.issues — field-level, ready to show a human
}
```

## The header-name constants matter

`ACTOR_ID_HEADER`, `ACTOR_TYPE_HEADER` and `ON_BEHALF_OF_HEADER` are exported from
here rather than spelled inline at each use site. The kernel sets them only for
integrations that opt in, and the internal reference adapter reads them — two
places that must agree on the exact string.

## License

MIT. See [LICENSE](./LICENSE).

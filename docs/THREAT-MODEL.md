# Threat model

This page states the threat model plainly. A security page that claims more than
the code implements is worse than no page at all, so the out-of-scope section is
as important as the controls.

## Assets

| Asset                          | Why it matters                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Stored integration credentials | An `api_key` or `oauth2` credential is direct access to a vendor system, bypassing every governance decision the kernel makes. |
| The audit trail                | It is the evidence of what agents did. If it can be edited, every downstream claim is unverifiable.                            |
| The human approval decision    | If approval can be forged or bypassed, the medium-risk tier is decorative.                                                     |
| The agent capability grant     | An agent's authority is its grant list. Widening it silently widens what the system permits.                                   |
| The host's network position    | The kernel makes outbound requests to URLs assembled from adapter config, so it is an SSRF primitive unless constrained.       |
| The agent's context            | Whatever the kernel returns to an agent becomes instructions the agent may follow.                                             |

## Adversaries

- **A malicious or compromised adapter file.** Adapter YAML is configuration with
  real power: it names a base URL, a path template and an auth strategy. If it is
  wrong or hostile, the kernel could be pointed at the wrong host or given a path
  that escapes the intended endpoint.
- **A prompt-injected agent.** An agent reading third-party text â€” a CRM note, a
  support ticket, an issue body â€” may be driven to attempt actions the operator
  never intended.
- **A compromised or stale agent token.** Agent identities are JWTs signed with
  the same key as human tokens. A leaked token is a leaked identity until it
  expires.
- **An external MCP client.** Anything that can reach `POST /api/mcp` with a
  valid access token can enumerate and call the exposed tools.
- **A curious demo user.** The public sandbox is deliberately open to anonymous
  traffic and has a fixed, documented password.

## Controls

### The risk gate

`packages/kernel/src/risk-gate.ts` decides what an agent may do, before any
network I/O. It checks the agent's grant list, then `agent_forbidden`, then
`risk: high`, then `risk: medium` or `approval_required`. A denial is written to
the audit trail with action `DENY` and a reason string. Humans bypass the
agent-oriented flags by design; human access is governed by role-based
middleware on the domain routes.

### SSRF and outbound request control

`packages/kernel/src/ssrf-guard.ts` addresses the most underrated risk in a
system like this: an agent-influenced URL. Path parameters are percent-encoded on
substitution, so `../` and query injection through a path parameter are
impossible. A template that still contains an unresolved parameter is rejected. A
resolved URL whose origin differs from the integration's `base_url` origin is
rejected. Plaintext `http:` is refused for any non-loopback host. URLs carrying
embedded userinfo are refused. Redirects are never followed â€” a 3xx is an error,
because following one would escape the allowlist. Responses are streamed with a
hard 2 MiB cap, and calls time out after 20 seconds by default.

An optional host allowlist provides defence in depth against a tampered adapter.
In demo mode it is mandatory: `DEMO_WHITELIST` names the only hosts the sandbox
may reach, so a malicious adapter cannot turn the public instance into a network
pivot.

### Credential handling

`packages/kernel/src/token-broker.ts` is the only component that ever holds a
plaintext credential, and only for the duration of one call. Secrets are stored
AES-256-GCM encrypted in `IntegrationCredential.encryptedBlob`, keyed by
`TCPCORE_CREDENTIAL_KEY`. The broker returns _headers_, never tokens. OAuth2
refresh persists the rotated refresh token, because most providers invalidate the
previous one â€” a failed write-back would break the integration on the next call.
`describeCredential()` exposes only a masked value and a status.

### Audit integrity

`packages/kernel/src/audit.ts` has no update and no delete method, and the
persistence model grants neither. `redactForAudit()` strips secret-shaped strings
and redacts the values of sensitive-named keys **before** the row is written, and
caps depth and array length so a pathological payload cannot become a denial of
service. Full response bodies are not stored â€” a CRM response is full of customer
PII, so `diff` keeps only a bounded shape summary.

### Prompt-injection sanitisation

`packages/kernel/src/sanitize.ts` detects instruction-shaped content, records
why, neutralises role delimiters and forged tool markup, strips invisible
characters, and labels untrusted payloads. Its limitations are the important
part: it is a detector with a known-regex shape, not a classifier.

### Input validation before I/O

`packages/kernel/src/schema-validate.ts` validates every argument object against
the capability's declared `input` schema, strictly and without coercion, before
the URL is built. A malformed call never reaches the target and is audited with
action `DENY`.

### MCP surface filtering

`packages/kernel/src/mcp-surface.ts` never lists a capability that is
`agent_forbidden`, `risk: high` or `deprecated`. An agent cannot be talked into
calling a tool it was never shown.

### Header spoofing defence

`packages/kernel/src/proxy.ts` sets `x-tcpcore-actor-id`, `x-tcpcore-actor-type`
and `x-tcpcore-on-behalf-of` on outbound calls as advisory metadata, and never
forwards inbound copies of those names. A caller cannot forge an identity onward
to the internal integration.

### Authorisation and rate limiting

Role-based middleware governs the domain routes (`ADMIN`, `AGENT`, `VIEWER`).
Login is limited to 5 attempts per 15 minutes per IP, and demo-mode capability
invocation to 30 per minute per IP. Webhooks are HMAC-verified on
`POST /api/webhooks/:event`.

### The kill switch

`AGENTS_ENABLED=false`, or `POST /api/system/toggle-agents`, stops every
agent-originated call while leaving human access intact. The toggle writes an
audit row with action `UPDATE` and `targetResource: system:AGENTS_ENABLED`, so
its use is as visible as any agent action.

## Threat to control

| Threat                                               | Primary control                                                                              | Residual risk                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Hostile adapter points at an unintended host         | Origin check in `buildUrl`, optional host allowlist, mandatory `DEMO_WHITELIST` in demo mode | An operator who allows a host is trusting it; the kernel cannot judge intent.                         |
| Hostile adapter path escapes the endpoint            | Percent-encoded substitution, unresolved-parameter rejection                                 | None identified for path parameters; a misdeclared template is still a misdeclaration.                |
| Prompt injection drives an agent to a harmful action | Sanitiser plus the capability boundary and the approval queue                                | Novel phrasings can evade detection. The boundary is what actually contains the blast radius.         |
| Agent attempts a destructive operation               | `agent_forbidden` and `risk: high` are hard blocks before I/O                                | An operator who sets `risk: low` on a destructive call has removed the control.                       |
| Agent exceeds its intended scope                     | `AgentConfig.capabilities` grant check, evaluated before risk                                | A grant of `*` or `integration.*` is broad by construction.                                           |
| Stolen access or agent token                         | Short-lived access tokens (15 min), single-use rotated refresh tokens                        | A token is valid until it expires; there is no per-request revocation list in 0.1.x.                  |
| Credential disclosure through an audit row           | `redactForAudit()` before persistence                                                        | Redaction is pattern-based; a novel secret format could slip through.                                 |
| Credential disclosure through a response body        | The broker returns headers, not tokens; API responses strip `passwordHash`                   | None identified.                                                                                      |
| Credential theft at rest                             | AES-256-GCM with an operator-supplied 32-byte key                                            | The key is an environment variable. Anyone with the environment and the database has the credentials. |
| Audit tampering                                      | No application-level update or delete path exists                                            | A database administrator can modify rows directly.                                                    |
| Excessive or abusive invocation                      | Login and demo-invocation rate limits; the agent kill switch                                 | Broadly unlimited for authenticated non-demo callers in 0.1.x.                                        |
| Network discovery from the kernel host               | Host allowlist, loopback-only plaintext exemption                                            | With an empty allowlist and a hostile adapter, the kernel can reach what the host can reach.          |

## Out of scope

These are not implemented in 0.1.x, and the documentation says so rather than
implying otherwise:

- **No audit hash chain and no write-once storage.** Append-only is a property of
  the application API, not of the storage engine.
- **No SIEM export.** Audit rows are queryable; shipping them anywhere is an
  operator task.
- **No SAML or OIDC SSO.** Authentication is local accounts plus JWT.
- **No multi-tenant isolation.** One deployment is one trust domain.
- **No KMS or HSM integration.** The credential key is an environment variable.
- **No per-capability rate limiting** beyond the demo limiter.
- **No data-residency or retention controls.** Deleting a row deletes it.
- **No sandboxing of the target system.** The kernel decides what it sends; it
  cannot police what a vendor API does with it.

## What the operator still owns

- **Key management.** Generate `TCPCORE_CREDENTIAL_KEY` from a real source of
  randomness, store it in a secret manager, and have a rotation plan. Losing it
  makes every stored credential unreadable.
- **Network policy.** Run the kernel where it can only reach the hosts it needs,
  and use the outbound allowlist in production as well as in the demo.
- **Adapter review.** The risk levels in an adapter are the policy. Nobody else
  reviews them.
- **Secret rotation** at the vendor, which the kernel cannot do for you.
- **Exposure.** Put authentication in front of anything public, and keep the
  demo instance separate from any instance holding real credentials.

## The three invariants

1. **No agent can bypass the governed execution path.** The only two
   agent-reachable entry points â€” `POST /api/capabilities/:name/invoke` and the
   MCP surfaces â€” both call `kernel.invoke()`, which calls the proxy. There is no
   third path.
2. **No secret ever appears in a response body.** The broker returns headers, the
   audit layer redacts before persistence, and API responses strip `passwordHash`
   explicitly.
3. **No high-risk capability is ever executed by an agent.** `agent_forbidden`
   and `risk: high` are hard blocks, evaluated before any network I/O.

If any of those three stops being true, the rest of this page should be read as
fiction. They are the properties worth testing first.

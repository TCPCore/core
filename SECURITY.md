# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Email **29535497+cptlight@users.noreply.github.com** with:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- the affected component (kernel, adapters, CLI, or adapter format),
- the version, and how you are running it.

If you would prefer to encrypt, ask for our PGP key in a first plain email.

### What to expect

| Stage                           | Target                         |
| ------------------------------- | ------------------------------ |
| Acknowledgement                 | within 48 hours                |
| Initial assessment and severity | within 5 days                  |
| Fix for critical issues         | within 7 days                  |
| Fix for high issues             | within 30 days                 |
| Public disclosure               | coordinated, after a fix ships |

We will credit you in the release notes unless you ask us not to.

## In scope

- The governance kernel (`packages/kernel`) — risk-gate bypass, audit
  tampering, credential exposure, prompt-injection bypass.
- The adapter format and generator (`packages/adapters`) — a way to make the
  generator emit an adapter that grants more access than it appears to.
- The CLI (`packages/cli`) — code execution, path traversal, credential leakage
  into output or shell history.
- The API (`apps/api`) — authentication bypass, privilege escalation, IDOR, SSRF
  via an adapter's `base_url`, tenant isolation.
- Deployment artifacts — a default that exposes a credential or an unnecessary
  network surface.

## Out of scope

- Vulnerabilities in a **target API** that an adapter points at. Report those to
  the vendor. (If TCPcore fails to _contain_ the consequences, that is in scope.)
- Findings that require an operator to have already set a secret to a publicly
  known value.
- Missing hardening headers on the docs site.
- Denial of service through sheer request volume against your own deployment.
- Reports produced solely by an automated scanner with no demonstrated impact.

## Design commitments

These are properties we intend to hold, and will treat a violation of as a bug:

1. **No agent can reach an integration without passing through `governedCall`.**
   There are exactly two agent-facing entry points, and both enforce the risk gate
   and write an audit row.

2. **No credential is ever returned in a response body, written to an audit row,
   or emitted in a log.** Credentials are AES-256-GCM encrypted at rest and
   decrypted only inside the token broker, for the duration of one call.

3. **A high-risk or `agent_forbidden` capability is never executed by an agent.**
   These are hard blocks in the risk gate, not warnings.

4. **An approved action executes as the reviewer, never as the proposing agent.**
   Otherwise "a human approved it" would mean nothing.

5. **Unclassified input fails closed.** An unrecognised HTTP method, an
   unparseable schema, or an unknown capability defaults to denial or approval,
   never to silent execution.

6. **Demo mode cannot reach the internet.** With `DEMO_MODE=true`, the kernel
   refuses outbound calls to any host not on `DEMO_WHITELIST`.

## Hardening checklist for operators

If you are self-hosting TCPcore, these are the things that matter most:

- [ ] `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `TCPCORE_CREDENTIAL_KEY` are
      randomly generated, at least 32 bytes, distinct, and stored in a secret
      manager — not in a committed `.env`.
- [ ] `TCPCORE_CREDENTIAL_KEY` is backed up separately. Losing it means every
      stored integration credential must be re-entered; leaking it exposes them.
- [ ] `CORS_ORIGIN` is an explicit origin, not `*`.
- [ ] The API is behind TLS. The kernel refuses plaintext `http` to non-loopback
      hosts, but defense in depth is cheap.
- [ ] PostgreSQL and Redis are not published to the public internet.
- [ ] `DEMO_MODE` is off in production. It seeds known credentials and relaxes
      the outbound guard.
- [ ] The admin console is not reachable by unauthenticated users, and `VIEWER`
      accounts are read-only by design — verify your reverse proxy agrees.
- [ ] Rate limits are in place in front of `/api/auth/*`. TCPcore ships a login
      limiter, but an edge limiter is better.
- [ ] Audit rows are shipped to append-only storage. The API treats them as
      append-only, and there is deliberately no update or delete endpoint, but a
      database administrator can still alter them.
- [ ] You have reviewed every adapter's risk levels yourself. An adapter is
      policy, and a community adapter is someone else's policy.

## Threat model

The full threat model — including prompt injection, confused-deputy risks, and
the SSRF surface created by adapter-declared base URLs — is in
[docs/THREAT-MODEL.md](./docs/THREAT-MODEL.md). It states what is defended, which
control implements each defence, and what is deliberately out of scope.

# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`@tcpcore1/kernel`** (MIT) — the governance kernel:
  - Capability registry with a durable store boundary (`KernelStore`), so the
    kernel runs against Prisma in the API and in-memory under `tcpctl serve`.
  - `RiskGate` with a pure, exhaustively tested policy: `agent_forbidden` and
    `risk: high` are hard blocks for agents; `risk: medium` and
    `approval_required` route to the human queue; `deprecated` and unclassified
    operations fail safe. Humans bypass the agent-oriented flags by design.
  - `GovernedProxy` (`governedCall`) — the single execution path. Validates
    arguments against the declared schema before any I/O, rejects redirects,
    enforces a response size cap and a request timeout, and audits success and
    failure alike.
  - `TokenBroker` with real AES-256-GCM credential storage and OAuth2 refresh
    that persists rotated refresh tokens.
  - `sanitize.ts` — prompt-injection detection and neutralisation for
    agent-visible payloads: instruction-override, system-prompt exfiltration,
    role reassignment, forged tool-call markup, credential harvesting, approval
    bypass, plus zero-width/bidi character stripping.
  - `ssrf-guard.ts` — URL assembly that cannot escape an integration's origin,
    percent-encoded path substitution, host allowlisting, and refusal to follow
    redirects or send credentials to a URL with embedded userinfo.
  - NIST SP 800-53 AU-3 audit recording with recursive secret redaction.
  - Per-integration, per-capability and global kill switches.
  - MCP surface generator (tools are only what was declared) plus JSON-RPC 2.0
    transport for real clients.
- **`@tcpcore1/adapters`** (MIT) — the adapter format and the generator:
  - `AdapterSchema` validation for `.tcp-adapter.yaml` with policy-consistency
    checks (a destructive operation must be `agent_forbidden`; money movement may
    not be `risk: low`).
  - OpenAPI 3.x, Swagger 2.0, Postman and HAR normalisation into one shape, with
    cycle-safe `$ref` resolution.
  - Risk inference as documented ordered rules, emitting the rationale as YAML
    comments.
  - Content-risk analysis: detects responses carrying third-party free text and
    flags them for prompt-injection scanning.
  - YAML emitter that preserves inline reasoning, and a secret sanitiser that
    redacts credential-shaped values and warns on non-production base URLs.
  - `mergeAdapters` — regeneration that preserves human risk overrides and marks
    vanished capabilities `deprecated` rather than deleting them.
- **`@tcpcore1/cli`** (MIT) — `tcpctl init | generate | validate | serve | invoke | manifest`,
  with a command surface exportable as JSON so the docs reference is generated
  rather than hand-written.
- **`apps/api`** — Hono HTTP API, Prisma data model, real JWT authentication with
  bcrypt password hashing and refresh-token rotation, per-route RBAC, rate
  limiting, HMAC-verified webhooks, `/health` and `/ready`, a BullMQ worker, and
  a provider-agnostic agent runtime that falls back to deterministic heuristics
  so the product works with no LLM key at all.
- **`apps/web`** — React admin console with the ten documented tabs, role-aware
  rendering for ADMIN / AGENT / VIEWER, and accessibility fixes.
- **`apps/demo`** — mock Salesforce, Stripe and HubSpot backends, idempotent
  seeding, a nightly reset, and a sandbox guard that refuses outbound calls to
  any host outside `DEMO_WHITELIST`.
- **Deployment** — `Dockerfile.api`, `Dockerfile.web`, `docker-compose.yml`,
  `docker-compose.dev.yml`, `docker-compose.demo.yml`, `railway.json`,
  `render.yaml`.
- **Repository hygiene** — MIT `LICENSE` at the root and in every package,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates,
  ESLint and Prettier configuration, and four GitHub Actions workflows.

### Changed

- The repository is a pnpm monorepo (`apps/*`, `packages/*`) matching the
  documented architecture, replacing the single-file prototype.
- The ticket manager is now the _reference adapter_ rather than the product; the
  governance kernel is a standalone, domain-agnostic package.
- Adapters moved to `adapters/builtin` and `adapters/community`, and are
  validated in CI.

### Removed

- The prototype's authentication, which defaulted to an administrator when no
  `Authorization` header was present and treated any unrecognised token as
  admin. Authentication is now required on every non-public route.
- The prototype's in-memory-only persistence, hardcoded credentials, and the
  direct-to-domain agent path that bypassed the risk gate.

### Security

- Adapter-declared `base_url` values are now subject to an origin check, a host
  allowlist and a plaintext-HTTP restriction, closing an SSRF vector.
- Capability arguments are validated against the declared schema _before_ the
  outbound call, and undeclared fields are dropped rather than forwarded.
- Integration credentials are encrypted with AES-256-GCM; the token broker is the
  only component that handles plaintext.
- Agent-visible responses are scanned for prompt-injection content.
- Redirects are no longer followed on governed calls.

## [0.1.0] - 2026-01-01

Initial release.

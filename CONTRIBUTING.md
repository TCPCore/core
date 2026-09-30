# Contributing to TCPcore

Thanks for being here. The highest-impact contribution is a community adapter —
it takes about ten minutes and makes a SaaS agent-ready for everybody. Code,
docs and bug reports are all welcome too.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

| Contribution                            | Effort  | Impact                                    |
| --------------------------------------- | ------- | ----------------------------------------- |
| Add a community adapter                 | ~10 min | Every TCPcore user gains that integration |
| Add a capability to an existing adapter | ~5 min  | Small diffs, same workflow                |
| Report a bug                            | 2 min   | Please include reproduction steps         |
| Improve the docs                        | varies  | The docs are the adoption surface         |
| Kernel / CLI / API code                 | varies  | Read the invariants below first           |

## Adding a community adapter

This is the workflow the whole project is designed around.

1. **Fork and clone**, then install:

   ```bash
   pnpm install
   pnpm --filter @tcpcore1/shared build
   pnpm --filter @tcpcore1/adapters build
   pnpm --filter @tcpcore1/cli build
   ```

2. **Find the vendor's OpenAPI spec.** Almost every API has one. If it is at a
   URL, pass the URL directly.

3. **Generate a starting point:**

   ```bash
   pnpm tcpctl generate https://api.example.com/openapi.json \
     -o adapters/community/example.yaml
   ```

4. **Review every risk level by hand.** This is the part CI cannot do for you,
   and it is the part that matters. The generator's inference is a suggestion;
   the value you commit is the policy that will be enforced.

   - `risk: low` — read-only, or a change that is trivially reversible.
   - `risk: medium` with `approval_required: true` — any write a human should see
     before it happens. Reaching a customer, moving money, sending a message.
   - `risk: high` with `agent_forbidden: true` — irreversible. Deletes, purges,
     account wipes, revocations.

   Also delete the capabilities nobody needs. Exposing an agent surface of five
   deliberate tools instead of the vendor's two hundred endpoints is the entire
   point of the project.

   Set `content_risk` on anything whose response contains text written by a third
   party — ticket bodies, CRM notes, chat messages, email. That is what tells the
   kernel to prompt-injection-scan the payload before an agent reads it.

5. **Validate:**

   ```bash
   pnpm tcpctl validate adapters/community/example.yaml
   ```

   This is the same check CI runs. It catches schema errors and policy
   contradictions — a destructive operation not marked `agent_forbidden`, a
   money-moving operation marked `risk: low`, a capability that is both
   `agent_forbidden` and `approval_required`.

6. **Add a row** to `adapters/community/README.md` with the adapter name, a
   one-line description, the capability count and a link to the vendor's API docs.

7. **Open a PR.** CI validates the YAML automatically. A maintainer reviews the
   risk assignments — that review is the only gate, and it is usually fast.

Secrets: never commit a real API key, and never include production response data
in an adapter. The generator redacts credential-shaped strings, but it cannot
know what you pasted into a description.

## Adding a capability to an existing adapter

Same workflow, smaller diff. Keep the existing ordering stable so the diff shows
only the new capability.

## Writing code

```bash
pnpm lint        # ESLint (flat config)
pnpm format      # Prettier
pnpm typecheck   # tsc across every package
pnpm test        # Vitest
pnpm build       # builds packages then apps, in dependency order
```

All four must pass. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `chore:`), which is what makes the generated changelog readable.

### The invariants

These are load-bearing. A PR that breaks one will be asked to change, whatever
else it improves:

1. **The kernel is domain-agnostic.** `packages/kernel` must not import from
   `apps/*`, and must not learn about tickets, clients or comments. If a feature
   needs a domain concept, it belongs in an app or an adapter. Configuration that
   has to change per domain goes in the adapter, not in a kernel branch.

2. **`governedCall` is the only way out.** Every path that reaches an integration
   from an agent goes through the risk gate and the proxy. If you add a route
   that lets an agent call an integration directly, you have removed the
   governance.

3. **No secret in a response, a log, or an audit row.** The token broker returns
   headers, never tokens. `redactForAudit` scans audit payloads. Never add a
   `console.log` of a credential, and never add a field that echoes one back.

4. **Fail closed.** An unrecognised method, an unparseable schema, a missing
   credential — every one of those must deny or error, never silently allow. The
   risk gate's default for anything unclassified is `medium`, not `low`.

5. **`AdapterSchema` in `packages/shared` is the only definition of a valid
   adapter.** Do not re-implement validation anywhere else; import it.

### Adding a dependency

The kernel and the adapter format are meant to be small and auditable. A new
dependency in `packages/kernel` or `packages/adapters` needs a justification in
the PR description. Prefer the standard library.

## Reporting bugs

Use the issue templates in `.github/ISSUE_TEMPLATE/`. A useful report includes:

- the TCPcore version (`pnpm tcpctl --version`, or the image tag),
- the adapter file with secrets removed,
- exact reproduction steps,
- expected versus actual behaviour,
- how you are running it (Docker, Railway, local).

## Security

See [SECURITY.md](./SECURITY.md). Do not file public issues for vulnerabilities.

## Repository layout

```
apps/
  api/          HTTP API: kernel host + domain routes + agent runtime
  web/          React admin console
  demo/         Mock SaaS backends, seeding, sandbox guard
  docs/         Astro Starlight documentation site
packages/
  kernel/       Governance core (domain-agnostic, MIT)
  adapters/     Adapter format: loader, validator, generator (MIT)
  shared/       Zod schemas and types shared front and back (MIT)
  cli/          tcpctl (MIT)
adapters/
  builtin/      First-party adapters (internal, salesforce, stripe, hubspot)
  community/    Community-contributed adapters
```

`docs/internal/BUILD-CONTRACT.md` is the frozen interface contract between the
packages. Change it in the same PR as any change to a port, an env var, a route
or a package export.

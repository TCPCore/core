# Community Adapters

Adapters contributed by the community. Each file is a `.tcp-adapter.yaml`
specification, validated automatically by CI on every pull request
(`.github/workflows/adapter-validate.yml`).

| Adapter   | Description                                 | Capabilities | Source                                         |
| --------- | ------------------------------------------- | ------------ | ---------------------------------------------- |
| GitHub    | Issues, repositories and review workflow    | 6            | https://docs.github.com/en/rest                |
| PagerDuty | Incidents and escalation policies           | 4            | https://developer.pagerduty.com/api-reference/ |
| Slack     | Channels, message history and notifications | 5            | https://api.slack.com/methods                  |
| Zendesk   | Support tickets                             | 5            | https://developer.zendesk.com/api-reference/   |

## Risk conventions in this directory

Every adapter in here follows the same three-tier convention, and reviewers hold
contributions to it:

- **`risk: low`** - read-only. Executes immediately when an agent calls it.
- **`risk: medium`** with **`approval_required: true`** - any write that a human
  should see before it happens (posting a message, creating a ticket, issuing a
  refund). The kernel enqueues these and a human approves the exact payload.
- **`risk: high`** with **`agent_forbidden: true`** - destructive or
  irreversible. Agents are blocked outright; a human executes it.

`content_risk` is set on capabilities whose responses contain free text written
by third parties (issue bodies, ticket descriptions, Slack messages). The kernel
prompt-injection-scans those responses before an agent sees them.

## Adding yours

1. Generate a starting point:

   ```bash
   pnpm tcpctl generate https://api.example.com/openapi.json \
     -o adapters/community/example.yaml
   ```

2. Review every inferred risk level by hand. The generator is a starting point,
   not an authority - the risk you assign is the policy that will be enforced.

3. Validate:

   ```bash
   pnpm tcpctl validate adapters/community/example.yaml
   ```

4. Add a row to the table above and open a pull request. CI validates the YAML;
   a maintainer reviews the risk assignments.

See [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-community-adapter).

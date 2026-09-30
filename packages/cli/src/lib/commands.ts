export interface FlagSpec {
  name: string;
  aliases?: string[];
  type: 'string' | 'boolean' | 'number';
  description: string;
  default?: string | boolean;
  required?: boolean;
}

export interface CommandSpec {
  /** The command name as typed: `tcpctl generate`. */
  name: string;
  summary: string;
  description: string;
  usage: string;
  /** Positional argument description, if the command takes one. */
  positional?: { name: string; description: string; required?: boolean; variadic?: boolean };
  flags: FlagSpec[];
  examples: string[];
}

/**
 * The command surface, declared as data.
 *
 * Two reasons this is a table rather than scattered option parsing:
 *
 *  1. `tcpctl manifest --format json` is the contract the docs site builds its
 *     CLI reference from (spec: the reference page must be generated, not
 *     hand-written). Keeping the definitions here means the help text and the
 *     published reference cannot drift.
 *  2. Help output is generated from the same source, so adding a flag in one
 *     place documents it everywhere.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: 'init',
    summary: 'Scaffold a new .tcp-adapter.yaml',
    description:
      'Writes a minimal, valid adapter with a single low-risk capability. Start here, then add one capability per action you want an agent to be able to take.',
    usage:
      'tcpctl init [--output adapter.yaml] [--name my-service] [--base-url https://api.example.com]',
    flags: [
      {
        name: '--output',
        aliases: ['-o'],
        type: 'string',
        description: 'Where to write the adapter file.',
        default: 'adapter.yaml',
      },
      { name: '--name', type: 'string', description: 'Adapter name (lowercase slug).' },
      { name: '--base-url', type: 'string', description: 'Base URL of the target API.' },
      {
        name: '--force',
        type: 'boolean',
        description: 'Overwrite the output file if it already exists.',
        default: false,
      },
    ],
    examples: [
      'tcpctl init',
      'tcpctl init -o adapters/community/acme.yaml --name acme --base-url https://api.acme.com',
    ],
  },
  {
    name: 'generate',
    summary: 'Generate a governed adapter from an API spec',
    description:
      'Parses OpenAPI 3.x, Swagger 2.0, a Postman collection or a HAR file and emits a commented .tcp-adapter.yaml with an inferred risk level for every operation. Always review the risk levels before deploying: this file is policy.',
    usage:
      'tcpctl generate <spec> [-o out.yaml] [--from auto|openapi|swagger|postman|har] [--merge existing.yaml] [--dry-run]',
    positional: {
      name: 'spec',
      description: 'Path to a spec file, an http(s) URL, or inline JSON/YAML.',
      required: true,
    },
    flags: [
      {
        name: '--output',
        aliases: ['-o'],
        type: 'string',
        description: 'Write the YAML here instead of stdout.',
      },
      {
        name: '--from',
        type: 'string',
        description: 'Force the input format instead of auto-detecting.',
        default: 'auto',
      },
      {
        name: '--min-risk',
        type: 'string',
        description: 'Drop capabilities below this risk level.',
      },
      {
        name: '--max-risk',
        type: 'string',
        description: 'Drop capabilities above this risk level.',
      },
      { name: '--include-tags', type: 'string', description: 'Comma-separated tags to keep.' },
      { name: '--exclude-tags', type: 'string', description: 'Comma-separated tags to drop.' },
      { name: '--base-url', type: 'string', description: 'Override the base URL from the spec.' },
      {
        name: '--auth-type',
        type: 'string',
        description: 'Override the auth type (bearer|oauth2|api_key|jwt|none).',
      },
      {
        name: '--merge',
        type: 'string',
        description:
          'Regenerate against an existing adapter, preserving human-assigned risk, approval_required and agent_forbidden.',
      },
      {
        name: '--limit',
        type: 'number',
        description: 'Maximum capabilities to emit.',
        default: '300',
      },
      {
        name: '--dry-run',
        type: 'boolean',
        description: 'Print to stdout without writing.',
        default: false,
      },
      {
        name: '--allow-insecure',
        type: 'boolean',
        description: 'Permit fetching a spec over plaintext http from a non-loopback host.',
        default: false,
      },
    ],
    examples: [
      'tcpctl generate ./openapi.json -o salesforce.yaml',
      'tcpctl generate https://petstore.swagger.io/v2/swagger.json --dry-run',
      'tcpctl generate ./api.json --max-risk medium -o safe.yaml',
      'tcpctl generate ./openapi.json --merge adapters/community/acme.yaml -o adapters/community/acme.yaml',
    ],
  },
  {
    name: 'validate',
    summary: 'Validate one or more adapter files',
    description:
      'Checks schema validity and policy consistency. Exits non-zero if any file is invalid, which is what makes it usable as a CI gate for community adapter pull requests.',
    usage: 'tcpctl validate <files...>',
    positional: {
      name: 'files',
      description: 'Adapter files to validate. Supports globs.',
      required: true,
      variadic: true,
    },
    flags: [
      {
        name: '--json',
        type: 'boolean',
        description: 'Emit machine-readable results.',
        default: false,
      },
      {
        name: '--strict',
        type: 'boolean',
        description: 'Treat warnings as failures.',
        default: false,
      },
    ],
    examples: [
      'tcpctl validate adapters/community/*.yaml',
      'tcpctl validate ./my-adapter.yaml --json',
    ],
  },
  {
    name: 'serve',
    summary: 'Run the governance kernel locally',
    description:
      'Loads the given adapters and serves the kernel HTTP surface: the MCP manifest, tool list and the governed invoke endpoint. Uses in-memory storage, so no database is required.',
    usage: 'tcpctl serve <files...> [--port 8080]',
    positional: {
      name: 'files',
      description: 'Adapter files to load.',
      required: true,
      variadic: true,
    },
    flags: [
      { name: '--port', type: 'number', description: 'Port to listen on.', default: '8080' },
      {
        name: '--allow-host',
        type: 'string',
        description: 'Comma-separated outbound host allowlist. Empty means unrestricted.',
      },
      {
        name: '--allow-http',
        type: 'boolean',
        description: 'Permit plaintext http to non-loopback hosts.',
        default: false,
      },
      {
        name: '--sanitize-all',
        type: 'boolean',
        description: 'Prompt-injection-scan every response, not just content_risk capabilities.',
        default: false,
      },
    ],
    examples: [
      'tcpctl serve adapters/builtin/*.yaml',
      'tcpctl serve ./my-adapter.yaml --port 9090',
    ],
  },
  {
    name: 'invoke',
    summary: 'Invoke a capability through the kernel',
    description:
      'Runs one governed call so you can see the risk decision without writing code. A medium-risk capability returns a pending_approval result rather than executing, which is the gate working as intended.',
    usage: 'tcpctl invoke <integration.capability> [--args \'{"k":"v"}\'] [--as agent|human]',
    positional: {
      name: 'capability',
      description: 'Qualified capability name, e.g. internal.set_priority.',
      required: true,
    },
    flags: [
      {
        name: '--args',
        type: 'string',
        description: 'Arguments as JSON, or k=v,k2=v2.',
        default: '{}',
      },
      {
        name: '--adapter',
        type: 'string',
        description: 'Adapter file to load (repeatable).',
        required: true,
      },
      { name: '--as', type: 'string', description: 'Act as "agent" or "human".', default: 'agent' },
      {
        name: '--grant',
        type: 'string',
        description:
          'Comma-separated capabilities to grant the agent. Defaults to the invoked capability.',
      },
      {
        name: '--pretty',
        type: 'boolean',
        description: 'Pretty-print the result JSON.',
        default: true,
      },
    ],
    examples: [
      'tcpctl invoke internal.set_priority --adapter adapters/builtin/internal.yaml --args ticketId=T-1,priority=HIGH',
      'tcpctl invoke stripe.create_refund --adapter adapters/builtin/stripe.yaml --args \'{"chargeId":"ch_1","amount":100,"reason":"duplicate"}\'',
    ],
  },
  {
    name: 'manifest',
    summary: 'Export the CLI command surface as JSON',
    description:
      'Used by the docs site to generate the CLI reference page. Also useful for shell completion and for checking which flags a version supports.',
    usage: 'tcpctl manifest [--format json|markdown]',
    flags: [
      { name: '--format', type: 'string', description: 'Output format.', default: 'json' },
      { name: '--output', aliases: ['-o'], type: 'string', description: 'Write to a file.' },
    ],
    examples: ['tcpctl manifest', 'tcpctl manifest --format markdown -o docs/cli.md'],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Options bag as produced by `parseArgv`. */
export interface ParsedArgv {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  unknown: string[];
  help: boolean;
  version: boolean;
}

/**
 * A tiny argv parser driven by {@link COMMANDS}.
 *
 * A bespoke parser rather than a framework because the surface is six commands,
 * the dependency budget for the MIT core is deliberately small, and this keeps
 * `--help` output and `manifest` output provably derived from one source.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const result: ParsedArgv = {
    positionals: [],
    flags: {},
    unknown: [],
    help: false,
    version: false,
  };

  let index = 0;

  // Leading globals.
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === '--help' || token === '-h') return { ...result, help: true };
    if (token === '--version' || token === '-v') return { ...result, version: true };
    if (token.startsWith('-')) break;
    result.command = token;
    index += 1;
    break;
  }

  const command = result.command ? findCommand(result.command) : undefined;
  const flagNames = new Set<string>();
  for (const flag of command?.flags ?? []) {
    flagNames.add(flag.name);
    for (const alias of flag.aliases ?? []) flagNames.add(alias);
  }

  const booleanFlags = new Set(
    (command?.flags ?? []).filter((flag) => flag.type === 'boolean').map((flag) => flag.name),
  );

  while (index < argv.length) {
    const token = argv[index]!;
    index += 1;

    if (token === '--help' || token === '-h') return { ...result, help: true };
    if (token === '--version' || token === '-v') return { ...result, version: true };

    if (token.startsWith('--') || (token.startsWith('-') && token.length === 2)) {
      const equalsIndex = token.indexOf('=');
      const rawName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

      const canonical = canonicalFlagName(rawName, command);
      if (!canonical) {
        result.unknown.push(token);
        continue;
      }

      if (booleanFlags.has(canonical)) {
        result.flags[canonical] = inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }

      if (inlineValue !== undefined) {
        result.flags[canonical] = inlineValue;
        continue;
      }

      const next = argv[index];
      if (next === undefined || (next.startsWith('-') && next.length > 1 && !/^-\d/.test(next))) {
        result.flags[canonical] = '';
        continue;
      }
      index += 1;
      result.flags[canonical] = next;
      continue;
    }

    result.positionals.push(token);
  }

  return result;
}

function canonicalFlagName(raw: string, command: CommandSpec | undefined): string | undefined {
  if (!command) return raw;
  for (const flag of command.flags) {
    if (flag.name === raw) return flag.name;
    if ((flag.aliases ?? []).includes(raw)) return flag.name;
  }
  return undefined;
}

export function flagString(
  parsed: ParsedArgv,
  name: string,
  fallback?: string,
): string | undefined {
  const value = parsed.flags[name];
  if (value === undefined) {
    const flag = parsed.command
      ? findCommand(parsed.command)?.flags.find((f) => f.name === name)
      : undefined;
    return flag?.default !== undefined ? String(flag.default) : fallback;
  }
  return typeof value === 'string' ? value : String(value);
}

export function flagBoolean(parsed: ParsedArgv, name: string, fallback = false): boolean {
  const value = parsed.flags[name];
  if (value === undefined) {
    const flag = parsed.command
      ? findCommand(parsed.command)?.flags.find((f) => f.name === name)
      : undefined;
    return typeof flag?.default === 'boolean' ? flag.default : fallback;
  }
  return value === true || value === 'true';
}

export function flagNumber(parsed: ParsedArgv, name: string, fallback: number): number {
  const value = flagString(parsed, name);
  if (value === undefined || value === '') return fallback;
  const parsedNumber = Number(value);
  return Number.isFinite(parsedNumber) ? parsedNumber : fallback;
}

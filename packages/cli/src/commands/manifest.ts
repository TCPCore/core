import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { COMMANDS, flagString, type ParsedArgv } from '../lib/commands.js';
import { symbols, table, write, writeErr } from '../lib/output.js';
import { cliVersion } from '../lib/resolve.js';

/**
 * `tcpctl manifest` — export the command surface.
 *
 * The docs site's CLI reference page is generated from this output rather than
 * written by hand, so a flag can never be documented incorrectly for a release.
 */
export function runManifest(parsed: ParsedArgv): number {
  const format = flagString(parsed, '--format', 'json');
  const output = flagString(parsed, '--output');

  if (format !== 'json' && format !== 'markdown') {
    writeErr(`${symbols.fail} --format must be "json" or "markdown".`);
    return 1;
  }

  const payload = {
    name: 'tcpctl',
    version: cliVersion(),
    description: 'TCPcore adapter and kernel CLI.',
    commands: COMMANDS.map((command) => ({
      name: command.name,
      summary: command.summary,
      description: command.description,
      usage: command.usage,
      positional: command.positional ?? null,
      flags: command.flags,
      examples: command.examples,
    })),
  };

  const rendered = format === 'json' ? JSON.stringify(payload, null, 2) : renderMarkdown(payload);

  if (output) {
    writeFileSync(resolve(output), rendered, 'utf8');
    write(`${symbols.ok} Wrote ${pc.bold(output)}`);
    return 0;
  }

  write(rendered);
  return 0;
}

interface ManifestPayload {
  name: string;
  version: string;
  description: string;
  commands: Array<{
    name: string;
    summary: string;
    description: string;
    usage: string;
    positional: {
      name: string;
      description: string;
      required?: boolean;
      variadic?: boolean;
    } | null;
    flags: Array<{
      name: string;
      aliases?: string[];
      type: string;
      description: string;
      default?: string | boolean;
    }>;
    examples: string[];
  }>;
}

function renderMarkdown(payload: ManifestPayload): string {
  const lines: string[] = [
    `# ${payload.name} CLI reference`,
    '',
    `Version ${payload.version}. Generated from \`tcpctl manifest\` — do not edit by hand.`,
    '',
    payload.description,
    '',
    '## Commands',
    '',
    table(
      ['Command', 'Summary'],
      payload.commands.map((command) => [`\`tcpctl ${command.name}\``, command.summary]),
    ),
    '',
  ];

  for (const command of payload.commands) {
    lines.push(
      `## tcpctl ${command.name}`,
      '',
      command.description,
      '',
      '```',
      command.usage,
      '```',
      '',
    );

    if (command.positional) {
      lines.push(
        `**Argument — \`${command.positional.name}\`**${command.positional.required ? ' (required)' : ''}: ${command.positional.description}`,
        '',
      );
    }

    if (command.flags.length > 0) {
      lines.push(
        table(
          ['Flag', 'Type', 'Default', 'Description'],
          command.flags.map((flag) => [
            `\`${flag.name}${flag.aliases ? `, ${flag.aliases.join(', ')}` : ''}\``,
            flag.type,
            flag.default === undefined ? '' : `\`${String(flag.default)}\``,
            flag.description,
          ]),
        ),
        '',
      );
    }

    if (command.examples.length > 0) {
      lines.push('**Examples**', '', '```bash', ...command.examples, '```', '');
    }
  }

  return `${lines.join('\n')}\n`;
}

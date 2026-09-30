import pc from 'picocolors';
import { COMMANDS, flagString, flagBoolean, parseArgv } from './lib/commands.js';
import { cliVersion } from './lib/resolve.js';
import { symbols, table, write, writeErr } from './lib/output.js';
import { runInit } from './commands/init.js';
import { runGenerate } from './commands/generate.js';
import { runValidate } from './commands/validate.js';
import { runServe } from './commands/serve.js';
import { runInvoke } from './commands/invoke.js';
import { runManifest } from './commands/manifest.js';

/**
 * `tcpctl` — the TCPcore CLI.
 *
 * The entry point is intentionally thin: it resolves help/version, dispatches to
 * a command module, and maps a thrown error to exit code 1. Every command lives
 * in `./commands/*` and returns an exit code rather than calling `process.exit`,
 * so they stay testable.
 */

const BANNER = `${pc.bold('tcpctl')} ${pc.dim(`v${cliVersion()}`)} — TCPcore adapter & kernel CLI`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgv(argv);

  if (parsed.version) {
    write(cliVersion());
    return 0;
  }

  if (!parsed.command) {
    if (parsed.help) printHelp();
    else {
      printHelp();
      return argv.length === 0 ? 0 : 1;
    }
    return 0;
  }

  // Flag typos are a common source of "why did nothing happen", so refuse them
  // rather than ignoring silently.
  if (parsed.unknown.length > 0) {
    writeErr(`${symbols.fail} Unknown flag(s): ${parsed.unknown.join(', ')}`);
    writeErr(`Run ${pc.bold(`tcpctl ${parsed.command} --help`)} to see the supported flags.`);
    return 1;
  }

  if (parsed.help) {
    printCommandHelp(parsed.command);
    return 0;
  }

  try {
    switch (parsed.command) {
      case 'init':
        return await runInit(parsed);
      case 'generate':
        return await runGenerate(parsed);
      case 'validate':
        return await runValidate(parsed);
      case 'serve':
        return await runServe(parsed);
      case 'invoke':
        return await runInvoke(parsed);
      case 'manifest':
        return runManifest(parsed);
      default:
        writeErr(`${symbols.fail} Unknown command: ${parsed.command}`);
        writeErr(`Run ${pc.bold('tcpctl --help')} to list the available commands.`);
        return 1;
    }
  } catch (error) {
    writeErr(`${symbols.fail} ${(error as Error).message}`);
    if (flagBoolean(parsed, '--debug')) {
      writeErr((error as Error).stack ?? '');
    }
    return 1;
  }
}

function printHelp(): void {
  write(BANNER);
  write('');
  write('Turn any API into a governed, agent-callable surface.');
  write('');
  write(pc.bold('Usage'));
  write('  tcpctl <command> [options]');
  write('');
  write(pc.bold('Commands'));
  write(
    table(
      ['Command', 'Description'],
      COMMANDS.map((command) => [`  ${command.name}`, command.summary]),
    ),
  );
  write('');
  write(pc.bold('Global flags'));
  write(`  -h, --help      Show help for tcpctl or a specific command`);
  write(`  -v, --version   Print the CLI version`);
  write('');
  write(pc.bold('Common flows'));
  write(`  ${pc.dim('# start from a blank adapter')}`);
  write(`  tcpctl init -o my-service.yaml`);
  write('');
  write(`  ${pc.dim('# turn an OpenAPI spec into a governed adapter')}`);
  write(`  tcpctl generate https://api.example.com/openapi.json -o my-service.yaml`);
  write('');
  write(`  ${pc.dim('# check it, then run it locally')}`);
  write(`  tcpctl validate my-service.yaml`);
  write(`  tcpctl serve my-service.yaml --port 8080`);
  write('');
  write(`  ${pc.dim('# see the risk gate decide')}`);
  write(`  tcpctl invoke my-service.list_things --adapter my-service.yaml`);
  write('');
  write(`Docs: ${pc.cyan('https://docs.tcpcore.dev')}`);
}

function printCommandHelp(commandName: string): void {
  const command = COMMANDS.find((entry) => entry.name === commandName);
  if (!command) {
    printHelp();
    return;
  }

  write(`${pc.bold(`tcpctl ${command.name}`)} — ${command.summary}`);
  write('');
  write(command.description);
  write('');
  write(pc.bold('Usage'));
  write(`  ${command.usage}`);

  if (command.positional) {
    write('');
    write(pc.bold('Arguments'));
    write(`  ${command.positional.name}`);
    write(`      ${command.positional.description}`);
  }

  write('');
  write(pc.bold('Flags'));
  write(
    table(
      ['Flag', 'Type', 'Default', 'Description'],
      command.flags.map((flag) => [
        `  ${flag.name}${flag.aliases ? `, ${flag.aliases.join(', ')}` : ''}`,
        flag.type,
        flag.default === undefined ? '' : String(flag.default),
        flag.description,
      ]),
    ),
  );

  if (command.examples.length > 0) {
    write('');
    write(pc.bold('Examples'));
    for (const example of command.examples) write(`  ${example}`);
  }

  write('');
}

// Execute when run directly (`node dist/index.js`, or via the bin shim).
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('tcpctl.js'));

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      writeErr(`${symbols.fail} Unexpected error: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}

export { flagString };

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitTemplate } from '@tcpcore1/adapters';
import pc from 'picocolors';
import { assertInteractive, symbols, write, writeErr } from '../lib/output.js';
import { flagBoolean, flagString, type ParsedArgv } from '../lib/commands.js';

/**
 * `tcpctl init` — scaffold a minimal valid adapter.
 *
 * Refuses to overwrite unless `--force` is passed. Silently clobbering a file
 * that encodes governance policy would be the worst possible default for this
 * particular tool.
 */
export async function runInit(parsed: ParsedArgv): Promise<number> {
  const output = resolve(flagString(parsed, '--output', 'adapter.yaml')!);

  if (existsSync(output) && !flagBoolean(parsed, '--force')) {
    writeErr(
      `${symbols.fail} ${output} already exists. Pass ${pc.bold('--force')} to overwrite, ` +
        'or choose a different path with --output.',
    );
    return 1;
  }

  let name = flagString(parsed, '--name');
  let baseUrl = flagString(parsed, '--base-url');

  // Fall back to prompting, but only when a human is actually there.
  if (!name || !baseUrl) {
    try {
      assertInteractive('tcpctl init without --name/--base-url');
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!name) {
          name =
            (await rl.question(`Adapter name ${pc.dim('(my-service)')}: `)).trim() || 'my-service';
        }
        if (!baseUrl) {
          baseUrl =
            (await rl.question(`Base URL ${pc.dim('(https://api.example.com)')}: `)).trim() ||
            'https://api.example.com';
        }
      } finally {
        rl.close();
      }
    } catch (error) {
      writeErr(`${symbols.fail} ${(error as Error).message}`);
      return 1;
    }
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    writeErr(
      `${symbols.fail} Adapter name "${name}" is invalid. Use a lowercase slug starting with a letter ` +
        '(a-z, 0-9, "-", "_").',
    );
    return 1;
  }

  try {
    // Validate the URL early: a bad base_url is the most common init mistake and
    // the adapter schema would reject it later, less helpfully.
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('must be http or https');
    }
  } catch (error) {
    writeErr(
      `${symbols.fail} --base-url "${baseUrl}" is not a valid URL: ${(error as Error).message}`,
    );
    return 1;
  }

  writeFileSync(output, emitTemplate(name, baseUrl), 'utf8');

  write(`${symbols.ok} Created ${pc.bold(output)}`);
  write('');
  write('Next steps:');
  write(`  1. Add one capability per action an agent may take (see the comments in the file).`);
  write(`  2. ${pc.bold(`tcpctl validate ${output}`)}`);
  write(`  3. ${pc.bold(`tcpctl serve ${output}`)} to try it against the kernel.`);
  write('');
  write(
    pc.dim(
      'Remember: a capability that is not declared is not reachable. That is the point — ' +
        'expose the five tools an agent needs, not the two hundred the vendor ships.',
    ),
  );

  return 0;
}

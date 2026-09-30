#!/usr/bin/env node
/**
 * tcpctl bin shim.
 *
 * Kept tiny on purpose: it only resolves the built entry point and reports a
 * useful error if the package has not been built yet, which is the most common
 * failure mode when running from a fresh clone.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

if (!existsSync(entry)) {
  process.stderr.write(
    [
      'tcpctl is not built yet.',
      '',
      '  pnpm install',
      '  pnpm --filter @tcpcore1/cli build',
      '',
      `Expected: ${entry}`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);

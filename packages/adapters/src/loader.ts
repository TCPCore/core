import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterConfig } from '@tcpcore1/shared';
import { loadAdapter } from './validator.js';
import type { LoadOptions } from './types.js';

/**
 * Adapter loading from disk.
 *
 * The builtin adapters live outside this package (`/adapters/builtin`) because
 * they are data, not code: they ship in the Docker image, get read by both the
 * API and the CLI, and are meant to be edited by hand. Resolving them relative
 * to this file's location means the same lookup works from `src/` under tsx and
 * from `dist/` in a container.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the repo's `adapters/` directory, in priority order.
 *
 * `dist/loader.js` sits two levels below the package root, so `../../adapters`
 * resolves correctly both in the workspace and in the built image.
 */
function adapterRootCandidates(): string[] {
  const fromEnv = process.env.TCPCORE_ADAPTERS_DIR;
  return [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    resolve(HERE, '../../../adapters'), // dist/ -> packages/adapters/ -> packages/ -> repo root
    resolve(HERE, '../../adapters'), // src/ -> packages/adapters/ -> packages/
    resolve(process.cwd(), 'adapters'),
    resolve(process.cwd(), '../adapters'),
    resolve(process.cwd(), '../../adapters'),
  ];
}

/** Resolve the repo's `adapters/` directory, or `undefined` if not found. */
export function findAdaptersRoot(): string | undefined {
  for (const candidate of adapterRootCandidates()) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

export interface BuiltinAdapterFile {
  /** File name without the directory, e.g. `stripe.yaml`. */
  file: string;
  /** Adapter name as declared in the YAML. */
  name: string;
  path: string;
}

/**
 * List the builtin adapter files without loading their contents.
 *
 * Returns an empty list (never throws) when the directory cannot be found, so a
 * mispackaged container degrades to "no builtin adapters" rather than a crash on
 * boot.
 */
export function listBuiltinAdapters(): BuiltinAdapterFile[] {
  const root = findAdaptersRoot();
  if (!root) return [];

  const dir = join(root, 'builtin');
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  } catch {
    return [];
  }

  return files
    .map((file) => ({ file, name: file.replace(/\.ya?ml$/, ''), path: join(dir, file) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** List the community adapter files. Same degradation contract as above. */
export function listCommunityAdapters(): BuiltinAdapterFile[] {
  const root = findAdaptersRoot();
  if (!root) return [];

  const dir = join(root, 'community');
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  } catch {
    return [];
  }

  return files
    .map((file) => ({ file, name: file.replace(/\.ya?ml$/, ''), path: join(dir, file) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read and parse one adapter file. */
export async function loadAdapterFile(
  path: string,
  options: LoadOptions = {},
): Promise<AdapterConfig> {
  const raw = await readFile(path, 'utf8');
  return loadAdapter(raw, { source: options.source ?? path });
}

/**
 * Load every builtin adapter.
 *
 * Rejects with the offending file name if one is invalid, because a broken
 * builtin adapter means the image was built wrong and should fail loudly.
 */
export async function loadBuiltinAdapters(): Promise<
  Array<{ file: string; adapter: AdapterConfig; yaml: string }>
> {
  const files = listBuiltinAdapters();
  const out: Array<{ file: string; adapter: AdapterConfig; yaml: string }> = [];

  for (const entry of files) {
    const yaml = await readFile(entry.path, 'utf8');
    try {
      out.push({ file: entry.file, adapter: loadAdapter(yaml, { source: entry.file }), yaml });
    } catch (error) {
      throw new Error(`Builtin adapter "${entry.file}" is invalid: ${(error as Error).message}`);
    }
  }

  return out;
}

/** Load every community adapter, skipping (and reporting) the invalid ones. */
export async function loadCommunityAdapters(): Promise<
  Array<{ file: string; adapter?: AdapterConfig; error?: string }>
> {
  const files = listCommunityAdapters();
  const out: Array<{ file: string; adapter?: AdapterConfig; error?: string }> = [];

  for (const entry of files) {
    const yaml = await readFile(entry.path, 'utf8');
    try {
      out.push({ file: entry.file, adapter: loadAdapter(yaml, { source: entry.file }) });
    } catch (error) {
      out.push({ file: entry.file, error: (error as Error).message });
    }
  }

  return out;
}

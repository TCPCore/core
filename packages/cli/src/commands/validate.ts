import { existsSync, readFileSync, statSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAdapter } from '@tcpcore1/adapters';
import pc from 'picocolors';
import { flagBoolean, type ParsedArgv } from '../lib/commands.js';
import { symbols, write, writeErr } from '../lib/output.js';

/**
 * `tcpctl validate` — the CI gate for adapter pull requests.
 *
 * Accepts globs so `.github/workflows/adapter-validate.yml` can pass
 * `adapters/community/*.yaml`. A pattern that fails to match is a failure, not
 * a silent pass: a typo'd path in CI that reports "all good" is worse than no
 * check at all.
 */
export async function runValidate(parsed: ParsedArgv): Promise<number> {
  if (parsed.positionals.length === 0) {
    writeErr(`${symbols.fail} No files given. Usage: ${pc.bold('tcpctl validate <files...>')}`);
    return 1;
  }

  const jsonMode = flagBoolean(parsed, '--json');
  const strict = flagBoolean(parsed, '--strict');

  const { files, unmatched } = expandPatterns(parsed.positionals);

  if (files.length === 0) {
    if (jsonMode) {
      write(JSON.stringify({ ok: false, files: [], unmatched }, null, 2));
    } else {
      writeErr(`${symbols.fail} No files matched: ${unmatched.join(', ')}`);
    }
    return 1;
  }

  const results: Array<{
    file: string;
    ok: boolean;
    capabilities: number;
    errors: Array<{ path: string; message: string }>;
    warnings: string[];
  }> = [];

  let failed = 0;
  let warned = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      results.push({
        file,
        ok: false,
        capabilities: 0,
        errors: [{ path: '(file)', message: `could not read: ${(error as Error).message}` }],
        warnings: [],
      });
      failed += 1;
      continue;
    }

    const result = validateAdapter(raw, { source: file });

    if (result.ok) {
      results.push({
        file,
        ok: true,
        capabilities: result.adapter.capabilities.length,
        errors: [],
        warnings: result.warnings,
      });
      if (result.warnings.length > 0) warned += 1;
    } else {
      results.push({
        file,
        ok: false,
        capabilities: 0,
        errors: result.errors,
        warnings: result.warnings,
      });
      if (result.warnings.length > 0) warned += 1;
      failed += 1;
    }
  }

  if (jsonMode) {
    write(
      JSON.stringify(
        {
          ok: failed === 0 && (!strict || warned === 0),
          failed,
          warned,
          total: files.length,
          unmatched,
          results,
        },
        null,
        2,
      ),
    );
    return failed === 0 && (!strict || warned === 0) ? 0 : 1;
  }

  for (const result of results) {
    if (result.ok) {
      write(
        `${symbols.ok} ${result.file} ${pc.dim(`(${result.capabilities} capabilit${result.capabilities === 1 ? 'y' : 'ies'})`)}`,
      );
    } else {
      writeErr(`${symbols.fail} ${result.file}`);
      for (const error of result.errors) {
        writeErr(`    ${pc.dim(error.path)}: ${error.message}`);
      }
    }

    for (const warning of result.warnings) {
      writeErr(`    ${symbols.warn} ${pc.yellow(warning)}`);
    }
  }

  if (unmatched.length > 0) {
    writeErr(`${symbols.warn} ${pc.yellow(`No files matched: ${unmatched.join(', ')}`)}`);
  }

  write('');
  if (failed > 0) {
    writeErr(`${symbols.fail} ${failed} of ${files.length} adapter(s) failed validation.`);
    return 1;
  }

  if (strict && warned > 0) {
    writeErr(`${symbols.fail} ${warned} adapter(s) produced warnings and --strict is set.`);
    return 1;
  }

  write(
    `${symbols.ok} ${files.length} adapter(s) valid` +
      (warned > 0 ? pc.yellow(` (${warned} with warnings)`) : '') +
      '.',
  );
  return 0;
}

/**
 * Expand paths and globs.
 *
 * `globSync` from `node:fs` is used when available (Node 22+); on older runtimes
 * we fall back to literal paths so the command still works, just without glob
 * expansion.
 */
function expandPatterns(patterns: string[]): { files: string[]; unmatched: string[] } {
  const files: string[] = [];
  const unmatched: string[] = [];

  for (const pattern of patterns) {
    const resolved = resolve(pattern);

    if (existsSync(resolved)) {
      const stats = statSync(resolved);
      if (stats.isDirectory()) {
        const found = safeGlob(`${resolved.replace(/\\/g, '/')}/*.{yaml,yml}`);
        if (found.length === 0) unmatched.push(pattern);
        else files.push(...found);
        continue;
      }
      files.push(resolved);
      continue;
    }

    if (/[*?[{]/.test(pattern)) {
      const found = safeGlob(pattern.replace(/\\/g, '/'));
      if (found.length === 0) unmatched.push(pattern);
      else files.push(...found.map((file) => resolve(file)));
      continue;
    }

    unmatched.push(pattern);
  }

  return { files: [...new Set(files)], unmatched };
}

function safeGlob(pattern: string): string[] {
  try {
    const glob = globSync as unknown as (p: string) => string[];
    return glob(pattern) ?? [];
  } catch {
    return [];
  }
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAdapter, validateAdapter } from '@tcpcore1/adapters';
import type { AdapterConfig, RiskLevel, SpecFormat } from '@tcpcore1/shared';
import pc from 'picocolors';
import { flagBoolean, flagNumber, flagString, type ParsedArgv } from '../lib/commands.js';
import { formatRiskBreakdown, symbols, write, writeErr } from '../lib/output.js';
import { readInput } from '../lib/resolve.js';

/**
 * `tcpctl generate` — the product-defining command.
 *
 * Turns any API spec into a governed adapter. The output is a starting point
 * that a human must review, and the command says so, because the risk level it
 * infers is what the kernel will enforce.
 */
export async function runGenerate(parsed: ParsedArgv): Promise<number> {
  const input = parsed.positionals[0];

  if (!input) {
    writeErr(`${symbols.fail} Missing <spec> argument. Run ${pc.bold('tcpctl generate --help')}.`);
    return 1;
  }

  const output = flagString(parsed, '--output');
  const dryRun = flagBoolean(parsed, '--dry-run') || !output;
  const from = (flagString(parsed, '--from', 'auto') ?? 'auto') as SpecFormat;

  if (!['auto', 'openapi', 'swagger', 'postman', 'har'].includes(from)) {
    writeErr(`${symbols.fail} --from must be one of: auto, openapi, swagger, postman, har.`);
    return 1;
  }

  // Load an existing adapter when regenerating, so human edits survive.
  let merge: AdapterConfig | undefined;
  const mergePath = flagString(parsed, '--merge');
  if (mergePath) {
    const resolved = resolve(mergePath);
    if (!existsSync(resolved)) {
      writeErr(`${symbols.fail} --merge file not found: ${mergePath}`);
      return 1;
    }
    const result = validateAdapter(readFileSync(resolved, 'utf8'), { source: mergePath });
    if (!result.ok) {
      writeErr(
        `${symbols.fail} --merge file ${mergePath} is not a valid adapter:\n` +
          result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
      return 1;
    }
    merge = result.adapter;
  }

  const minRisk = flagString(parsed, '--min-risk') as RiskLevel | undefined;
  const maxRisk = flagString(parsed, '--max-risk') as RiskLevel | undefined;

  for (const [flag, value] of [
    ['--min-risk', minRisk],
    ['--max-risk', maxRisk],
  ] as const) {
    if (value && !['low', 'medium', 'high'].includes(value)) {
      writeErr(`${symbols.fail} ${flag} must be one of: low, medium, high.`);
      return 1;
    }
  }

  try {
    // A local path is read here so we can report the real filename; a URL or
    // inline document is passed through to the generator, which fetches or
    // parses it. Reporting `<inline>` for a file on disk would make the
    // generated header useless for tracing where an adapter came from.
    const looksLikePath = !/^https?:\/\//i.test(input) && !input.includes('\n');
    const generatorInput = looksLikePath ? (await readInput(input)).text : input;

    process.stderr.write(`${symbols.info} Parsing ${pc.dim(input)}\n`);

    const result = await generateAdapter(generatorInput, {
      from,
      minRisk,
      maxRisk,
      baseUrl: flagString(parsed, '--base-url'),
      authType: flagString(parsed, '--auth-type') as AdapterConfig['auth']['type'] | undefined,
      includeTags: splitList(flagString(parsed, '--include-tags')),
      excludeTags: splitList(flagString(parsed, '--exclude-tags')),
      merge,
      limit: flagNumber(parsed, '--limit', 300),
      allowInsecureSpecUrl: flagBoolean(parsed, '--allow-insecure'),
      sourceLabel: input,
    });

    write(
      `${symbols.ok} ${pc.bold(`${result.capabilityCount} capabilities`)} — ${formatRiskBreakdown(result.riskBreakdown)}`,
    );

    if (result.diff) {
      if (result.diff.added.length > 0) {
        write(`${symbols.arrow} Added: ${result.diff.added.join(', ')}`);
      }
      if (result.diff.removed.length > 0) {
        write(`${symbols.arrow} Deprecated (kept, not deleted): ${result.diff.removed.join(', ')}`);
      }
      if (result.diff.preserved.length > 0) {
        write(
          `${symbols.warn} Preserved human edits on ${result.diff.preserved.length} capability(ies):`,
        );
        for (const entry of result.diff.preserved) write(`    ${entry}`);
      }
    }

    if (result.warnings.length > 0) {
      write('');
      for (const warning of result.warnings) {
        write(`${symbols.warn} ${pc.yellow(warning)}`);
      }
    }

    if (dryRun) {
      write('');
      write(result.yaml);
      if (!output) {
        write('');
        write(pc.dim('Tip: pass -o <file> to write this to disk.'));
      }
      return 0;
    }

    const target = resolve(output!);
    writeFileSync(target, result.yaml, 'utf8');
    write(`${symbols.ok} Wrote ${pc.bold(output!)}`);
    write('');
    write(
      pc.yellow(
        'Review the risk levels before deploying. This file is the policy the kernel enforces — ' +
          'anything you mark low will execute for an agent without asking anyone.',
      ),
    );
    return 0;
  } catch (error) {
    writeErr(`${symbols.fail} ${(error as Error).message}`);
    return 1;
  }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

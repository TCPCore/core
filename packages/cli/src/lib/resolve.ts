import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read a file, or return inline document text when the path does not exist. */
export async function readInput(pathOrText: string): Promise<{ text: string; source: string }> {
  const candidate = resolve(pathOrText);

  if (existsSync(candidate)) {
    return { text: await readFile(candidate, 'utf8'), source: pathOrText };
  }

  // A multi-line argument is almost certainly an inline document.
  if (
    pathOrText.includes('\n') ||
    pathOrText.trimStart().startsWith('{') ||
    pathOrText.includes('openapi:')
  ) {
    return { text: pathOrText, source: '<inline>' };
  }

  throw new Error(`File not found: ${pathOrText}`);
}

/**
 * Parse `--args '{"k":"v"}'` or `--args k=v,k2=v2`.
 *
 * Two syntaxes because both are natural at a terminal: JSON for nested values,
 * and `k=v` for the common one-off. Invalid JSON falls back to `k=v` parsing so
 * a user who writes `--args ticketId=T-1` is not punished.
 */
export function parseArgs(input: string | undefined): Record<string, unknown> {
  if (!input || input.trim() === '') return {};
  const trimmed = input.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error('--args JSON must be an object');
    } catch (error) {
      throw new Error(`Could not parse --args as JSON: ${(error as Error).message}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const pair of trimmed.split(',')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      throw new Error(`--args entry "${pair}" is missing "=". Use k=v,k2=v2 or a JSON object.`);
    }
    const key = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();

    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

/** Runtime version, read from package.json without importing it as JSON. */
export function cliVersion(): string {
  return process.env.TCPCTL_VERSION ?? '0.1.0';
}

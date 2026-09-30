import pc from 'picocolors';
import type { RiskBreakdown, ValidationIssue } from '@tcpcore1/adapters';

/**
 * Terminal output helpers.
 *
 * Every function respects `NO_COLOR` and non-TTY output because the CLI is used
 * in CI and its output is often piped — colour codes in a log file are noise,
 * and a spinner in a non-TTY is worse than useless.
 */

export const supportsColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

export function write(message = ''): void {
  process.stdout.write(`${message}\n`);
}

export function writeErr(message = ''): void {
  process.stderr.write(`${message}\n`);
}

export const symbols = {
  ok: pc.green('✓'),
  fail: pc.red('✗'),
  warn: pc.yellow('⚠'),
  info: pc.blue('ℹ'),
  arrow: pc.dim('→'),
};

export function heading(text: string): string {
  return pc.bold(text);
}

export function dim(text: string): string {
  return pc.dim(text);
}

/** Colour a risk level consistently wherever it appears. */
export function riskLabel(level: 'low' | 'medium' | 'high'): string {
  switch (level) {
    case 'low':
      return pc.green('low');
    case 'medium':
      return pc.yellow('medium');
    case 'high':
      return pc.red('high');
  }
}

export function formatRiskBreakdown(breakdown: RiskBreakdown): string {
  return (
    `${pc.green(`${breakdown.low} low`)} · ` +
    `${pc.yellow(`${breakdown.medium} medium`)} · ` +
    `${pc.red(`${breakdown.high} high`)}`
  );
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `  ${pc.dim(issue.path)}: ${issue.message}`).join('\n');
}

export function formatWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return warnings.map((warning) => `${symbols.warn} ${pc.yellow(warning)}`).join('\n');
}

/**
 * Render a simple aligned table. Avoids a dependency for the two tables the CLI
 * needs, and keeps output predictable in a terminal.
 */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(stripAnsi(header).length, ...rows.map((row) => stripAnsi(row[index] ?? '').length)),
  );

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell + ' '.repeat(Math.max(0, widths[index]! - stripAnsi(cell).length)))
      .join('  ')
      .trimEnd();

  const separator = widths.map((width) => '─'.repeat(width)).join('  ');

  return [renderRow(headers.map((h) => pc.bold(h))), separator, ...rows.map(renderRow)].join('\n');
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Guard an interactive prompt so piped/CI usage never hangs. */
export function assertInteractive(feature: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `"${feature}" needs an interactive terminal. In CI or a pipe, pass the value as a flag instead.`,
    );
  }
}

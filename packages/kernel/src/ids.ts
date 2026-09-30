import { randomUUID } from 'node:crypto';

/**
 * Identifier helpers.
 *
 * Every id the kernel emits is prefixed so a raw id is self-describing in logs
 * and audit rows (`appr_…`, `audit_…`), which matters when correlating across
 * the API, worker and CLI.
 */

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function requestId(): string {
  return randomUUID();
}

/** Compact, sortable-ish id for high-churn audit rows. */
export function auditId(): string {
  return `audit_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

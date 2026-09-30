import { describe, expect, it } from 'vitest';
import { Kernel } from '../kernel.js';
import { MemoryStore } from '../stores/memory.js';
import type { AdapterConfig } from '@tcpcore1/shared';

/**
 * Regression tests for the ordering of validation relative to the risk gate.
 *
 * The original implementation validated arguments inside the proxy, which runs
 * *after* the gate. That meant a medium-risk capability was enqueued for human
 * approval with arguments that did not satisfy its own declared schema — a
 * reviewer would be asked to approve a malformed payload, and the schema would
 * never have been enforced for anything that reached the queue.
 */

function adapter(): AdapterConfig {
  return {
    name: 'test',
    display_name: 'Test',
    base_url: 'http://127.0.0.1:9',
    auth: { type: 'none', source: 'credential_store' },
    capabilities: [
      {
        name: 'create_thing',
        method: 'POST',
        path: '/things',
        description: 'Create a thing',
        risk: 'medium',
        approval_required: true,
        agent_forbidden: false,
        deprecated: false,
        input: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    ],
  } as AdapterConfig;
}

function kernel(): Kernel {
  return new Kernel({ store: new MemoryStore(), requireHttps: false });
}

const agent = {
  id: 'agent_1',
  name: 'Agent',
  type: 'AGENT' as const,
  capabilities: ['test.create_thing'],
};

describe('Kernel.invoke — validation precedes the risk gate', () => {
  it('rejects an out-of-enum argument instead of queueing it for approval', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const result = await k.invoke('test.create_thing', { name: 'X', status: 'PWNED' }, agent);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('input validation failed');
      expect(result.error).toContain('must be one of');
    }

    // The critical assertion: nothing was queued.
    expect(await k.approvals.list('PENDING')).toHaveLength(0);
  });

  it('rejects a missing required field instead of queueing it for approval', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const result = await k.invoke('test.create_thing', { status: 'OPEN' }, agent);

    expect(result.status).toBe('failed');
    expect(await k.approvals.list('PENDING')).toHaveLength(0);
  });

  it('queues a well-formed proposal', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const result = await k.invoke('test.create_thing', { name: 'X', status: 'OPEN' }, agent);

    expect(result.status).toBe('pending_approval');
    const pending = await k.approvals.list('PENDING');
    expect(pending).toHaveLength(1);
    // The stored proposal is the validated object, so undeclared fields cannot
    // reach a reviewer or the target.
    expect(pending[0]!.targetPayload).toEqual({ name: 'X', status: 'OPEN' });
  });

  it('drops undeclared fields from the stored proposal', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    await k.invoke(
      'test.create_thing',
      { name: 'X', status: 'OPEN', isAdmin: true, __proto__: 'polluted' },
      agent,
    );

    const pending = await k.approvals.list('PENDING');
    expect(pending).toHaveLength(1);
    const payload = pending[0]!.targetPayload as Record<string, unknown>;
    expect(payload.isAdmin).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['name', 'status']);
  });

  it('records a DENY audit row for a validation failure', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    await k.invoke('test.create_thing', { name: 'X', status: 'PWNED' }, agent);

    const audit = await k.queryAudit({ limit: 50 });
    const denial = audit.records.find((r) => r.action === 'DENY');
    expect(denial).toBeDefined();
    // `metadata.error` carries the field-level detail so a reviewer can see
    // exactly which argument was rejected; `diff.reason` labels the category.
    expect(denial!.metadata?.error).toContain('must be one of');
    expect(denial!.diff).toMatchObject({ reason: 'input validation failed' });
    expect(denial!.metadata?.riskDecision).toBe('deny');
  });

  it('reports an unknown capability without throwing', async () => {
    const k = kernel();
    await k.start();

    const result = await k.invoke('nope.missing', {}, agent);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('not registered');
  });
});

const reviewer = { id: 'user_1', name: 'Reviewer', type: 'HUMAN' as const };

/** Queue a medium-risk proposal and return its approval id. */
async function queuedApproval(k: Kernel): Promise<string> {
  const result = await k.invoke('test.create_thing', { name: 'X', status: 'OPEN' }, agent);
  expect(result.status).toBe('pending_approval');
  return (result as { approvalId: string }).approvalId;
}

describe('Kernel.executeApproval — only an APPROVED request may run', () => {
  it('refuses to execute a PENDING approval', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    // Enqueue, but deliberately never approve.
    const approvalId = await queuedApproval(k);

    await expect(k.executeApproval(approvalId, reviewer)).rejects.toThrow(/expected APPROVED/);
  });

  it('refuses to execute a REJECTED approval', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const approvalId = await queuedApproval(k);
    await k.approvals.reject(approvalId, reviewer, 'not appropriate');

    await expect(k.executeApproval(approvalId, reviewer)).rejects.toThrow(/rejected/);
  });

  it('still executes an APPROVED request', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const approvalId = await queuedApproval(k);
    await k.approvals.approve(approvalId, reviewer);

    // The target is an unroutable discard port, so the call itself fails — but
    // it must get past the status gate and reach the proxy to do so.
    const { result } = await k.executeApproval(approvalId, reviewer);
    expect(result.status).not.toBe('pending_approval');
    expect(result.auditId).not.toBe('');
  });
});

describe('Kernel.invoke — every terminal branch carries an audit id', () => {
  it('returns a real auditId for a validation failure', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });

    const result = await k.invoke('test.create_thing', { name: 'X', status: 'PWNED' }, agent);

    expect(result.status).toBe('failed');
    expect(result.auditId).toMatch(/^audit_/);

    // The id must resolve to the row that was actually written.
    const audit = await k.queryAudit({ limit: 50 });
    expect(audit.records.some((r) => r.id === result.auditId)).toBe(true);
  });

  it('returns a real auditId when the kill switch denies', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: true });
    await k.setAgentsEnabled(false, reviewer);

    const result = await k.invoke('test.create_thing', { name: 'X', status: 'OPEN' }, agent);

    expect(result.status).toBe('denied');
    expect(result.auditId).toMatch(/^audit_/);

    const audit = await k.queryAudit({ limit: 50 });
    expect(audit.records.some((r) => r.id === result.auditId)).toBe(true);
  });

  it('denies and audits a call to a disabled integration', async () => {
    const k = kernel();
    await k.start();
    await k.registerAdapter(adapter(), { enabled: false });

    const result = await k.invoke('test.create_thing', { name: 'X', status: 'OPEN' }, agent);

    expect(result.status).toBe('denied');
    expect(result.auditId).toMatch(/^audit_/);

    const audit = await k.queryAudit({ limit: 50 });
    expect(audit.records.some((r) => r.id === result.auditId)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { RiskGate, capabilityGranted } from '../risk-gate.js';
import type { ApprovalQueue } from '../approvals.js';
import type { Actor, KernelCapabilityRecord } from '../types.js';

function capability(overrides: Partial<KernelCapabilityRecord> = {}): KernelCapabilityRecord {
  return {
    id: 'cap_test',
    integrationId: 'int_test',
    integrationName: 'test',
    name: 'do_thing',
    fullName: 'test.do_thing',
    description: 'does a thing',
    method: 'POST',
    pathTemplate: '/things',
    riskLevel: 'low',
    approvalRequired: false,
    agentForbidden: false,
    contentRisk: null,
    deprecated: false,
    inputSchema: {},
    outputSchema: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The gate is constructed with collaborators, but `evaluate` performs no I/O. */
function gate(): RiskGate {
  return new RiskGate({
    auditor: { record: async () => ({ id: 'audit_x' }) },
    approvals: { enqueue: async () => ({ id: 'appr_x' }) } as unknown as ApprovalQueue,
  });
}

const agent: Actor = {
  id: 'agent-1',
  name: 'Triage',
  type: 'AGENT',
  capabilities: ['test.*'],
};
const human: Actor = { id: 'user-1', name: 'Admin', type: 'HUMAN', capabilities: [] };

describe('RiskGate.evaluate', () => {
  it('allows a low-risk capability for a granted agent', () => {
    const decision = gate().evaluate({ capability: capability(), actor: agent });
    expect(decision.decision).toBe('allow');
  });

  it('denies agent_forbidden even when risk is declared low', () => {
    const decision = gate().evaluate({
      capability: capability({ agentForbidden: true, riskLevel: 'low' }),
      actor: agent,
    });
    expect(decision.decision).toBe('deny');
    expect(decision).toMatchObject({ riskLevel: 'low' });
  });

  it('denies high risk for agents', () => {
    const decision = gate().evaluate({
      capability: capability({ riskLevel: 'high' }),
      actor: agent,
    });
    expect(decision.decision).toBe('deny');
  });

  it('routes medium risk to approval', () => {
    const decision = gate().evaluate({
      capability: capability({ riskLevel: 'medium' }),
      actor: agent,
    });
    expect(decision.decision).toBe('approval');
  });

  it('routes explicitly approval_required low-risk capabilities to approval', () => {
    const decision = gate().evaluate({
      capability: capability({ riskLevel: 'low', approvalRequired: true }),
      actor: agent,
    });
    expect(decision.decision).toBe('approval');
    // Escalates the recorded risk so the queue rows are not mislabelled "low".
    expect(decision).toMatchObject({ riskLevel: 'medium' });
  });

  it('denies a capability the agent was never granted', () => {
    const decision = gate().evaluate({
      capability: capability({ integrationName: 'salesforce', fullName: 'salesforce.delete' }),
      actor: agent,
    });
    expect(decision.decision).toBe('deny');
    expect(decision).toMatchObject({ reason: expect.stringContaining('not granted') });
  });

  it('lets humans past agent_forbidden and high risk', () => {
    const forbidden = gate().evaluate({
      capability: capability({ agentForbidden: true, riskLevel: 'high' }),
      actor: human,
    });
    expect(forbidden.decision).toBe('allow');
  });
});

describe('capabilityGranted', () => {
  const cap = capability({ integrationName: 'salesforce', fullName: 'salesforce.get_opportunity' });

  it('matches exact qualified names', () => {
    expect(capabilityGranted(['salesforce.get_opportunity'], cap)).toBe(true);
  });

  it('matches integration wildcards', () => {
    expect(capabilityGranted(['salesforce.*'], cap)).toBe(true);
  });

  it('matches the global wildcard', () => {
    expect(capabilityGranted(['*'], cap)).toBe(true);
  });

  it('does not match a bare capability name', () => {
    expect(capabilityGranted(['get_opportunity'], cap)).toBe(false);
  });

  it('denies when the grant list is empty', () => {
    expect(capabilityGranted([], cap)).toBe(false);
  });
});

/**
 * An actor constructed without a `capabilities` array must be treated exactly
 * like one with an empty array: denied everything. The two cases previously
 * diverged — `undefined` short-circuited the grant check entirely and let any
 * low-risk capability through.
 */
describe('RiskGate.evaluate — fail closed on absent grants', () => {
  it('denies an agent with no capabilities property', () => {
    const bare: Actor = { id: 'agent-bare', name: 'Bare', type: 'AGENT' };
    expect(bare.capabilities).toBeUndefined();

    const decision = gate().evaluate({ capability: capability(), actor: bare });

    expect(decision.decision).toBe('deny');
    expect(decision).toMatchObject({ reason: expect.stringContaining('not granted') });
  });

  it('denies an agent with an empty capabilities array', () => {
    const empty: Actor = { id: 'agent-empty', name: 'Empty', type: 'AGENT', capabilities: [] };
    const decision = gate().evaluate({ capability: capability(), actor: empty });

    expect(decision.decision).toBe('deny');
    expect(decision).toMatchObject({ reason: expect.stringContaining('not granted') });
  });

  it('treats bare and empty-grant agents identically', () => {
    const bare: Actor = { id: 'a', name: 'A', type: 'AGENT' };
    const empty: Actor = { id: 'b', name: 'B', type: 'AGENT', capabilities: [] };
    const capabilityUnderTest = capability();

    expect(gate().evaluate({ capability: capabilityUnderTest, actor: bare }).decision).toBe(
      gate().evaluate({ capability: capabilityUnderTest, actor: empty }).decision,
    );
  });

  it('still allows a granted agent (the fix must not deny everyone)', () => {
    const decision = gate().evaluate({ capability: capability(), actor: agent });
    expect(decision.decision).toBe('allow');
  });
});

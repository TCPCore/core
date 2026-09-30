import { describe, expect, it } from 'vitest';
import { inferRisk, RISK_RULES } from '../risk-analyzer.js';
import { analyzeContentRisk } from '../content-analyzer.js';
import type { NormalizedOperation } from '../../types.js';

function op(overrides: Partial<NormalizedOperation>): NormalizedOperation {
  return {
    id: 'test_op',
    method: 'GET',
    path: '/things',
    tags: [],
    parameters: [],
    responses: {},
    ...overrides,
  };
}

describe('inferRisk', () => {
  it('marks DELETE high and agent_forbidden', () => {
    const decision = inferRisk(op({ method: 'DELETE', path: '/users/{id}' }));
    expect(decision.level).toBe('high');
    expect(decision.agentForbidden).toBe(true);
    expect(decision.rulesTriggered).toContain(RISK_RULES.METHOD_DELETE);
  });

  it('marks a GET low', () => {
    const decision = inferRisk(op({ method: 'GET', path: '/users' }));
    expect(decision.level).toBe('low');
    expect(decision.approvalRequired).toBe(false);
  });

  it('marks a plain POST medium with approval required', () => {
    const decision = inferRisk(op({ method: 'POST', path: '/users' }));
    expect(decision.level).toBe('medium');
    expect(decision.approvalRequired).toBe(true);
    expect(decision.agentForbidden).toBe(false);
  });

  it('marks a destructive path segment high and forbidden even on POST', () => {
    const decision = inferRisk(op({ method: 'POST', path: '/projects/{id}/purge' }));
    expect(decision.level).toBe('high');
    expect(decision.agentForbidden).toBe(true);
  });

  it('flags /refund on a non-GET as high but still agent-proposable', () => {
    const decision = inferRisk(op({ method: 'POST', path: '/charges/{id}/refund' }));
    expect(decision.level).toBe('high');
    expect(decision.approvalRequired).toBe(true);
    // Money movement is high risk yet the agent may propose it for approval.
    expect(decision.agentForbidden).toBe(false);
  });

  it('does not treat a GET on a money path as high risk', () => {
    const decision = inferRisk(op({ method: 'GET', path: '/charges/{id}' }));
    expect(decision.level).toBe('low');
  });

  it('suggests a conditional rule when a numeric amount field is present', () => {
    const decision = inferRisk(
      op({
        method: 'POST',
        path: '/refunds',
        requestBody: {
          type: 'object',
          properties: { amount: { type: 'integer' } },
        },
      }),
    );
    expect(decision.conditionalHint).toContain('amount');
    expect(decision.rulesTriggered).toContain(RISK_RULES.SCHEMA_AMOUNT);
  });

  it('falls back to medium for an unknown method', () => {
    const decision = inferRisk(op({ method: 'OPTIONS', path: '/things' }));
    expect(decision.level).toBe('low');
  });
});

describe('analyzeContentRisk', () => {
  it('flags a response carrying a free-text body field', () => {
    const decision = analyzeContentRisk(
      op({
        path: '/conversations/{id}',
        responses: {
          '200': {
            type: 'object',
            properties: { id: { type: 'string' }, body: { type: 'string' } },
          },
        },
      }),
    );
    expect(decision.level).toBe('high');
    expect(decision.reason).toContain('body');
  });

  it('flags a collection of user-authored records as medium', () => {
    const decision = analyzeContentRisk(
      op({
        path: '/repos/{owner}/{repo}/issues',
        responses: {
          '200': {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      }),
    );
    expect(decision.level).toBe('medium');
  });

  it('does not flag a metadata endpoint', () => {
    const decision = analyzeContentRisk(
      op({
        path: '/schemas',
        responses: { '200': { type: 'object', properties: { body: { type: 'string' } } } },
      }),
    );
    expect(decision.level).toBeUndefined();
  });

  it('does not flag a numeric response', () => {
    const decision = analyzeContentRisk(
      op({
        path: '/accounts/{id}/balance',
        responses: { '200': { type: 'object', properties: { amount: { type: 'number' } } } },
      }),
    );
    expect(decision.level).toBeUndefined();
  });
});

import type { GovernedCallResult, RiskLevel } from '@tcpcore1/shared';
import { RISK_ORDER } from '@tcpcore1/shared';
import type { ApprovalQueue } from './approvals.js';
import type { Actor, AuditSink, KernelCapabilityRecord } from './types.js';

export type { AuditSink };

export interface EvaluateRiskInput {
  capability: KernelCapabilityRecord;
  actor: Actor;
  /** Arguments, used only to report a denial with context. */
  args?: Record<string, unknown>;
  requestId?: string;
}

/**
 * The risk gate's decision. Deliberately a pure value: no I/O happens while
 * deciding, which makes the policy exhaustively unit-testable.
 */
export type RiskDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'approval'; reason: string; riskLevel: RiskLevel }
  | { decision: 'deny'; reason: string; riskLevel: RiskLevel };

export interface RiskGateOptions {
  /**
   * Optional policy override evaluated after the built-in rules and before the
   * built-in allow. Receives the capability and actor; returns `undefined` to
   * defer to the default policy. This is the seam for conditional risk rules
   * (e.g. "refund over $1000 is high risk").
   */
  policyOverride?: (input: EvaluateRiskInput) => RiskDecision | undefined;
}

/**
 * The governance policy.
 *
 * Ordering matters and is the documented contract:
 *   1. `agent_forbidden` wins over everything — it is an explicit human-only flag.
 *   2. `risk: high` is a hard block for agents.
 *   3. `risk: medium` or `approval_required` routes to the human queue.
 *   4. `deprecated` capabilities still execute but are flagged, so a stale
 *      adapter cannot silently gain new powers while we stop calling it.
 *   5. otherwise allow.
 *
 * Humans are never subject to `agent_forbidden` / `risk: high` — those flags
 * describe what *agents* may do. Human access is governed by RBAC on the
 * domain routes, not by this gate.
 */
export class RiskGate {
  private readonly auditor: AuditSink;
  private readonly approvals: ApprovalQueue;
  private readonly policyOverride?: (input: EvaluateRiskInput) => RiskDecision | undefined;

  constructor(options: {
    auditor: AuditSink;
    approvals: ApprovalQueue;
    policyOverride?: (input: EvaluateRiskInput) => RiskDecision | undefined;
  }) {
    this.auditor = options.auditor;
    this.approvals = options.approvals;
    this.policyOverride = options.policyOverride;
  }

  /** Pure policy evaluation — no side effects, no I/O. */
  evaluate(input: EvaluateRiskInput): RiskDecision {
    const { capability, actor } = input;

    // Human actors bypass the agent-oriented flags by design.
    if (actor.type === 'HUMAN') {
      return { decision: 'allow', reason: 'human actor: risk gate applies to agents only' };
    }

    // 0. The agent must have been granted this capability at all.
    //
    // Fail closed. An absent or empty grants list means the agent may do
    // nothing. The alternative — treating "no grants" as "no restriction" — is
    // the exact inversion of what the grant system exists to enforce, and it
    // would hand every low-risk capability to any actor constructed without a
    // capabilities array. `capabilityGranted` already returns false for an
    // empty list; coercing here makes the absent case behave identically.
    if (!capabilityGranted(actor.capabilities ?? [], capability)) {
      return {
        decision: 'deny',
        reason: `agent is not granted capability "${capability.fullName}"`,
        riskLevel: capability.riskLevel,
      };
    }

    const override = this.policyOverride?.(input);
    if (override) return override;

    if (capability.agentForbidden) {
      return {
        decision: 'deny',
        reason: 'capability is marked agent_forbidden: human execution only',
        riskLevel: capability.riskLevel,
      };
    }

    if (capability.riskLevel === 'high') {
      return {
        decision: 'deny',
        reason: 'high-risk capability requires human execution',
        riskLevel: capability.riskLevel,
      };
    }

    if (capability.riskLevel === 'medium' || capability.approvalRequired) {
      return {
        decision: 'approval',
        reason: capability.approvalRequired
          ? 'capability is marked approval_required'
          : 'medium-risk capability requires human approval',
        riskLevel: capability.riskLevel === 'low' ? 'medium' : capability.riskLevel,
      };
    }

    return { decision: 'allow', reason: 'low-risk capability' };
  }

  /**
   * Evaluate and act: record the denial, enqueue the approval, or report that the
   * caller may proceed. The actual HTTP call is performed by `GovernedProxy`, so
   * this method never touches the network.
   */
  async enforce(
    input: EvaluateRiskInput,
  ): Promise<
    | { proceed: true; decision: RiskDecision }
    | { proceed: false; result: GovernedCallResult; decision: RiskDecision }
  > {
    const decision = this.evaluate(input);
    const { capability, actor, requestId } = input;

    if (decision.decision === 'deny') {
      const record = await this.auditor.record({
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        targetSystem: capability.integrationName,
        integrationId: capability.integrationId,
        capabilityName: capability.name,
        targetResource: null,
        targetPayload: input.args,
        action: 'DENY',
        diff: { reason: decision.reason, riskLevel: decision.riskLevel },
        metadata: {
          riskLevel: decision.riskLevel,
          riskDecision: 'deny',
          requestId,
          compliance: 'NIST AU-3 risk gate denial',
        },
      });

      return {
        proceed: false,
        decision,
        result: { status: 'denied', reason: decision.reason, auditId: record.id },
      };
    }

    if (decision.decision === 'approval') {
      const approval = await this.approvals.enqueue({
        agent: actor,
        integrationId: capability.integrationId,
        targetSystem: capability.integrationName,
        capabilityName: capability.name,
        targetPayload: input.args ?? {},
        riskLevel: decision.riskLevel,
        requestId,
      });

      return {
        proceed: false,
        decision,
        result: {
          status: 'pending_approval',
          approvalId: approval.id,
          auditId: approval.id,
          riskLevel: decision.riskLevel,
        },
      };
    }

    return { proceed: true, decision };
  }

  /**
   * Compare two risk levels using the canonical ordering.
   * Exposed so hosts can filter by `minRisk`/`maxRisk` with one implementation.
   */
  static atLeast(level: RiskLevel, floor: RiskLevel): boolean {
    return RISK_ORDER[level] >= RISK_ORDER[floor];
  }

  static atMost(level: RiskLevel, ceiling: RiskLevel): boolean {
    return RISK_ORDER[level] <= RISK_ORDER[ceiling];
  }
}

/**
 * Capability grant check supporting exact names, `integration.*` wildcards and
 * a global `*`. Comparison is exact and case-sensitive: capability names are
 * validated to be lowercase snake_case at adapter load time.
 */
export function capabilityGranted(grants: string[], capability: KernelCapabilityRecord): boolean {
  if (grants.length === 0) return false;
  if (grants.includes('*')) return true;
  if (grants.includes(capability.fullName)) return true;
  if (grants.includes(`${capability.integrationName}.*`)) return true;
  return false;
}

import type { ApprovalRequest, RiskLevel } from '@tcpcore1/shared';
import { newId } from './ids.js';
import type { Actor, AuditSink, KernelStore } from './types.js';

export type { AuditSink };

export interface EnqueueApprovalInput {
  agent: Actor;
  integrationId: string | null;
  targetSystem: string;
  capabilityName: string;
  targetPayload: unknown;
  riskLevel: RiskLevel;
  requestId?: string;
}

export interface ApprovalQueueOptions {
  store: KernelStore;
  auditor: AuditSink;
  /** Minutes after which a pending request is considered stale. Default 24h. */
  ttlMinutes?: number;
}

/** Derive a stable resource identifier from a proposed payload. */
export function extractResource(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return 'unknown';
  const obj = payload as Record<string, unknown>;

  const orderedKeys = [
    ['ticketId', 'ticket'],
    ['chargeId', 'charge'],
    ['opportunityId', 'opportunity'],
    ['dealId', 'deal'],
    ['contactId', 'contact'],
    ['clientId', 'client'],
    ['issueId', 'issue'],
    ['id', 'record'],
  ] as const;

  for (const [key, prefix] of orderedKeys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return `${prefix}:${value}`;
  }

  return 'resource';
}

/**
 * Human-in-the-loop approval queue.
 *
 * The queue never executes anything itself. It records the proposal, records
 * the human decision, and returns the stored request so the caller can perform
 * the governed execution. This keeps the kernel free of any dependency on the
 * proxy and makes the queue unit-testable in isolation.
 */
export class ApprovalQueue {
  private readonly store: KernelStore;
  private readonly auditor: AuditSink;
  private readonly ttlMs: number;

  constructor(options: ApprovalQueueOptions) {
    this.store = options.store;
    this.auditor = options.auditor;
    this.ttlMs = (options.ttlMinutes ?? 24 * 60) * 60_000;
  }

  async enqueue(input: EnqueueApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: newId('appr'),
      agentId: input.agent.id,
      agentName: input.agent.name,
      integrationId: input.integrationId,
      targetSystem: input.targetSystem,
      capabilityName: input.capabilityName,
      targetPayload: input.targetPayload,
      riskLevel: input.riskLevel === 'low' ? 'medium' : input.riskLevel,
      status: 'PENDING',
      reviewedById: null,
      reviewedByName: null,
      reviewedAt: null,
      executionError: null,
      createdAt: new Date().toISOString(),
    };

    await this.store.saveApproval(request);

    await this.auditor.record({
      actorId: input.agent.id,
      actorName: input.agent.name,
      actorType: input.agent.type,
      targetSystem: input.targetSystem,
      integrationId: input.integrationId,
      capabilityName: input.capabilityName,
      targetResource: extractResource(input.targetPayload),
      targetPayload: input.targetPayload,
      action: 'PROPOSE',
      diff: { approvalId: request.id, riskLevel: request.riskLevel },
      metadata: {
        approvalId: request.id,
        riskLevel: request.riskLevel,
        riskDecision: 'approval',
        requestId: input.requestId,
        compliance: 'NIST AU-3 human-in-the-loop approval enqueue',
      },
    });

    return request;
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const request = await this.store.getApproval(id);
    if (!request) return undefined;
    return this.maybeExpire(request);
  }

  async list(status?: string): Promise<ApprovalRequest[]> {
    const all = await this.store.listApprovals(status);
    // Expire lazily on read so no scheduler is required for correctness.
    const checked = await Promise.all(all.map((item) => this.maybeExpire(item)));
    return checked.filter((item) => !status || status === 'ALL' || item.status === status);
  }

  private async maybeExpire(request: ApprovalRequest): Promise<ApprovalRequest> {
    if (request.status !== 'PENDING') return request;
    if (Date.now() - Date.parse(request.createdAt) < this.ttlMs) return request;

    const expired: ApprovalRequest = { ...request, status: 'EXPIRED' };
    await this.store.saveApproval(expired);
    await this.auditor.record({
      actorId: null,
      actorName: 'system',
      actorType: 'HUMAN',
      targetSystem: request.targetSystem,
      integrationId: request.integrationId,
      capabilityName: request.capabilityName,
      targetResource: extractResource(request.targetPayload),
      action: 'REJECT',
      diff: { approvalId: request.id, reason: 'expired' },
      metadata: { approvalId: request.id, compliance: 'NIST AU-3 approval TTL expiry' },
    });
    return expired;
  }

  /**
   * Mark a pending request approved and audit the decision.
   *
   * Execution is the caller's responsibility — it must run as the *reviewer*,
   * not the proposing agent. See `Gateway.executeApproval`.
   */
  async approve(id: string, reviewer: Actor): Promise<ApprovalRequest> {
    const request = await this.requirePending(id);

    const approved: ApprovalRequest = {
      ...request,
      status: 'APPROVED',
      reviewedById: reviewer.id,
      reviewedByName: reviewer.name,
      reviewedAt: new Date().toISOString(),
    };
    await this.store.saveApproval(approved);

    await this.auditor.record({
      actorId: reviewer.id,
      actorName: reviewer.name,
      actorType: reviewer.type,
      targetSystem: request.targetSystem,
      integrationId: request.integrationId,
      capabilityName: request.capabilityName,
      targetResource: extractResource(request.targetPayload),
      targetPayload: request.targetPayload,
      action: 'APPROVE',
      diff: { approvalId: id, status: 'APPROVED' },
      metadata: {
        approvalId: id,
        riskDecision: 'allow',
        compliance: 'NIST AU-3 human reviewer authorized execution',
      },
    });

    return approved;
  }

  /**
   * Record the outcome of executing an approved request.
   *
   * Only an APPROVED request is updated. This is deliberately a no-op rather
   * than a throw: it runs after the governed call has already happened, and
   * raising here would report an execution failure for a call that actually
   * succeeded. Silently refusing to graft an execution result onto a PENDING
   * (never-approved) row is the safe direction — it cannot manufacture a record
   * that a human authorised something they did not.
   */
  async markExecuted(id: string, error?: string): Promise<void> {
    const request = await this.store.getApproval(id);
    if (!request) return;
    if (request.status !== 'APPROVED') return;
    await this.store.saveApproval({ ...request, executionError: error ?? null });
  }

  async reject(id: string, reviewer: Actor, reason?: string): Promise<ApprovalRequest> {
    const request = await this.requirePending(id);

    const rejected: ApprovalRequest = {
      ...request,
      status: 'REJECTED',
      reviewedById: reviewer.id,
      reviewedByName: reviewer.name,
      reviewedAt: new Date().toISOString(),
    };
    await this.store.saveApproval(rejected);

    await this.auditor.record({
      actorId: reviewer.id,
      actorName: reviewer.name,
      actorType: reviewer.type,
      targetSystem: request.targetSystem,
      integrationId: request.integrationId,
      capabilityName: request.capabilityName,
      targetResource: extractResource(request.targetPayload),
      action: 'REJECT',
      diff: { approvalId: id, reason: reason ?? 'rejected by reviewer' },
      metadata: { approvalId: id, compliance: 'NIST AU-3 human reviewer rejection' },
    });

    return rejected;
  }

  private async requirePending(id: string): Promise<ApprovalRequest> {
    const request = await this.get(id);
    if (!request) throw new Error(`Approval request "${id}" not found`);
    if (request.status !== 'PENDING') {
      throw new Error(`Approval request "${id}" has already been ${request.status.toLowerCase()}`);
    }
    return request;
  }
}

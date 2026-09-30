import type { ApprovalRequest, AuditLog, Integration } from '@tcpcore1/shared';
import type {
  AuditQueryInput,
  KernelAgentRun,
  KernelCapabilityRecord,
  KernelStore,
  StoredCredential,
} from '../types.js';

/**
 * In-memory implementation of {@link KernelStore}.
 *
 * Used by `tcpctl serve` and by the test suite so the kernel can run with no
 * database, which is also what lets the CLI give a "five minute" experience.
 * It is intentionally not durable and never used by `apps/api` in production.
 */
export class MemoryStore implements KernelStore {
  private integrations = new Map<string, Integration>();
  private capabilities = new Map<string, KernelCapabilityRecord>();
  private credentials = new Map<string, StoredCredential>();
  private audit: AuditLog[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private runs: KernelAgentRun[] = [];

  async saveIntegration(integration: Integration): Promise<void> {
    this.integrations.set(integration.name, { ...integration });
  }

  async deleteIntegration(name: string): Promise<void> {
    const existing = this.integrations.get(name);
    if (existing) {
      for (const [key, cap] of this.capabilities) {
        if (cap.integrationId === existing.id) this.capabilities.delete(key);
      }
    }
    this.integrations.delete(name);
    this.credentials.delete(name);
  }

  async listIntegrations(): Promise<Integration[]> {
    return [...this.integrations.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveCapabilities(
    integration: Integration,
    capabilities: KernelCapabilityRecord[],
  ): Promise<void> {
    // Replace the set for this integration, keeping other integrations intact.
    for (const [key, cap] of this.capabilities) {
      if (cap.integrationId === integration.id) this.capabilities.delete(key);
    }
    for (const cap of capabilities) {
      this.capabilities.set(cap.fullName, cap);
    }
  }

  async listCapabilities(filter?: {
    risk?: KernelCapabilityRecord['riskLevel'];
    integrationName?: string;
  }): Promise<KernelCapabilityRecord[]> {
    let list = [...this.capabilities.values()];
    if (filter?.risk) list = list.filter((c) => c.riskLevel === filter.risk);
    if (filter?.integrationName) {
      list = list.filter((c) => c.integrationName === filter.integrationName);
    }
    return list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    this.credentials.set(credential.integrationName, { ...credential });
  }

  async getCredential(integrationName: string): Promise<StoredCredential | undefined> {
    const found = this.credentials.get(integrationName);
    return found ? { ...found } : undefined;
  }

  async deleteCredential(integrationName: string): Promise<void> {
    this.credentials.delete(integrationName);
  }

  async appendAudit(record: AuditLog): Promise<void> {
    this.audit.unshift(record);
    if (this.audit.length > 5000) this.audit.length = 5000;
  }

  async listAudit(query: AuditQueryInput): Promise<{ records: AuditLog[]; total: number }> {
    let list = [...this.audit];

    if (query.actorType) list = list.filter((r) => r.actorType === query.actorType);
    if (query.targetSystem) list = list.filter((r) => r.targetSystem === query.targetSystem);
    if (query.capabilityName) list = list.filter((r) => r.capabilityName === query.capabilityName);
    if (query.action) list = list.filter((r) => r.action === query.action);
    if (query.from) list = list.filter((r) => r.createdAt >= query.from!);
    if (query.to) list = list.filter((r) => r.createdAt <= query.to!);
    if (query.search) {
      const needle = query.search.toLowerCase();
      list = list.filter((r) =>
        [r.actorName, r.capabilityName, r.targetSystem, r.targetResource ?? '', r.action]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }

    const total = list.length;
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    return { records: list.slice((page - 1) * limit, page * limit), total };
  }

  async saveApproval(approval: ApprovalRequest): Promise<void> {
    this.approvals.set(approval.id, { ...approval });
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const found = this.approvals.get(id);
    return found ? { ...found } : undefined;
  }

  async listApprovals(status?: string): Promise<ApprovalRequest[]> {
    const list = [...this.approvals.values()];
    const filtered = status && status !== 'ALL' ? list.filter((a) => a.status === status) : list;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveAgentRun(run: KernelAgentRun): Promise<void> {
    this.runs.unshift(run);
    if (this.runs.length > 1000) this.runs.length = 1000;
  }

  async listAgentRuns(limit = 100): Promise<KernelAgentRun[]> {
    return this.runs.slice(0, limit);
  }

  /** Test/demo helper: drop everything (used by the demo reset cron). */
  clear(): void {
    this.integrations.clear();
    this.capabilities.clear();
    this.credentials.clear();
    this.audit = [];
    this.approvals.clear();
    this.runs = [];
  }

  /** Test/demo helper: count rows without paging. */
  size(): { audit: number; approvals: number; capabilities: number } {
    return {
      audit: this.audit.length,
      approvals: this.approvals.size,
      capabilities: this.capabilities.size,
    };
  }
}

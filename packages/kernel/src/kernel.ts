import type { AdapterConfig, GovernedCallResult, Integration } from '@tcpcore1/shared';
import { ApprovalQueue } from './approvals.js';
import { Auditor } from './audit.js';
import { buildMcpServerInfo, buildMcpTools, formatMcpManifest } from './mcp-surface.js';
import { GovernedProxy } from './proxy.js';
import { Registry } from './registry.js';
import { RiskGate, type RiskDecision } from './risk-gate.js';
import { formatIssues, validateAgainstSchema } from './schema-validate.js';
import { TokenBroker } from './token-broker.js';
import type {
  Actor,
  AuditQueryInput,
  KernelAgentRun,
  KernelCapabilityRecord,
  KernelConfig,
  KernelStore,
  RecordAuditInput,
} from './types.js';

/**
 * The result of an agent- or human-originated capability invocation.
 *
 * A discriminated union rather than an interface extending
 * `GovernedCallResult`, so narrowing on `status` gives the caller the right
 * payload shape without a cast.
 */
export type InvokeResult = GovernedCallResult & {
  /** Present whenever the gate produced a decision, for UI/telemetry. */
  decision?: RiskDecision;
  /** The fully-qualified capability that was invoked. */
  capability?: string;
  integration?: string;
};

export interface GatewayOptions extends KernelConfig {
  serverName?: string;
  version?: string;
  /** Extra policy hook evaluated by the risk gate. */
  policyOverride?: (input: {
    capability: KernelCapabilityRecord;
    actor: Actor;
    args?: Record<string, unknown>;
    requestId?: string;
  }) => RiskDecision | undefined;
}

/**
 * The TCPcore governance kernel.
 *
 * This class is the composition root for the MIT-licensed core: it wires the
 * registry, auditor, approval queue, risk gate, token broker and proxy together
 * and exposes exactly two ways in — `invoke()` for a capability call and
 * `executeApproval()` for a human-authorised execution.
 *
 * Domain code (tickets, clients) must never call the integrations directly; it
 * either goes through here or it is not governed.
 */
export class Kernel {
  readonly store: KernelStore;
  readonly registry: Registry;
  readonly auditor: Auditor;
  readonly approvals: ApprovalQueue;
  readonly riskGate: RiskGate;
  readonly tokenBroker: TokenBroker;
  readonly proxy: GovernedProxy;
  readonly version: string;

  private agentsEnabled: boolean;
  private readonly startedAt = Date.now();

  constructor(options: GatewayOptions) {
    this.store = options.store;
    this.version = options.version ?? '0.1.0';
    this.agentsEnabled = options.agentsEnabled ?? true;

    this.auditor = new Auditor({ store: this.store });
    this.approvals = new ApprovalQueue({ store: this.store, auditor: this.auditor });
    this.registry = new Registry({ store: this.store });
    this.tokenBroker = new TokenBroker({
      store: this.store,
      encryptionKey: options.encryptionKey,
    });
    this.proxy = new GovernedProxy({
      auditor: this.auditor,
      tokenBroker: this.tokenBroker,
      outboundHostAllowlist: options.outboundHostAllowlist,
      requireHttps: options.requireHttps,
      timeoutMs: options.callTimeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      sanitizeAllResponses: options.sanitizeAllResponses,
      fetchImpl: options.fetchImpl,
    });
    this.riskGate = new RiskGate({
      auditor: this.auditor,
      approvals: this.approvals,
      policyOverride: options.policyOverride,
    });
  }

  /** Rehydrate persisted integrations and capabilities. Call once at boot. */
  async start(): Promise<{ integrations: number; capabilities: number }> {
    return this.registry.hydrate();
  }

  // ---------------------------------------------------------------- adapters

  async registerAdapter(
    adapter: AdapterConfig,
    options: { enabled?: boolean; isBuiltin?: boolean } = {},
  ) {
    return this.registry.register(adapter, options);
  }

  async registerAdapterYaml(
    yamlText: string,
    options: { source?: string; enabled?: boolean; isBuiltin?: boolean } = {},
  ) {
    const result = await this.registry.registerYaml(yamlText, options);
    await this.auditor.record({
      actorId: null,
      actorName: options.source ?? 'adapter-loader',
      actorType: 'HUMAN',
      targetSystem: result.integration.name,
      integrationId: result.integration.id,
      capabilityName: 'register_adapter',
      targetResource: `integration:${result.integration.name}`,
      targetPayload: { capabilities: result.capabilities.length },
      action: 'REGISTER',
      diff: { name: result.integration.name, capabilities: result.capabilities.map((c) => c.name) },
      metadata: { compliance: 'NIST AU-3 adapter registry provisioning' },
    });
    return result;
  }

  async unregisterAdapter(name: string, actor: Actor): Promise<boolean> {
    const integration = this.registry.getIntegration(name);
    const removed = await this.registry.unregister(name);
    if (removed && integration) {
      await this.auditor.record({
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        targetSystem: name,
        integrationId: integration.id,
        capabilityName: 'unregister_adapter',
        targetResource: `integration:${name}`,
        action: 'DELETE',
        diff: { name },
        metadata: { compliance: 'NIST AU-3 adapter registry removal' },
      });
    }
    return removed;
  }

  async setIntegrationEnabled(
    name: string,
    enabled: boolean | undefined,
    actor: Actor,
  ): Promise<Integration> {
    const integration = await this.registry.setEnabled(name, enabled);
    await this.auditor.record({
      actorId: actor.id,
      actorName: actor.name,
      actorType: actor.type,
      targetSystem: name,
      integrationId: integration.id,
      capabilityName: 'toggle_integration',
      targetResource: `integration:${name}`,
      targetPayload: { enabled: integration.enabled },
      action: 'UPDATE',
      diff: { enabled: integration.enabled },
      metadata: { compliance: 'NIST AU-3 integration kill switch' },
    });
    return integration;
  }

  // ------------------------------------------------------------ capabilities

  /**
   * The one agent-reachable execution entry point.
   *
   * Never throws for policy outcomes: denials, approvals and validation
   * failures come back as typed results so callers map them to HTTP status
   * codes without a try/catch around policy.
   */
  async invoke(
    capabilityName: string,
    args: Record<string, unknown>,
    actor: Actor,
    options: { requestId?: string } = {},
  ): Promise<InvokeResult> {
    const resolved = this.registry.resolve(capabilityName);

    if (!resolved) {
      // No audit row: there is no target system or capability to attribute one
      // to. The failure is still returned to the caller and logged by the API
      // layer, which holds the request context this method does not.
      return {
        status: 'failed',
        error: `capability "${capabilityName}" is not registered`,
        auditId: '',
      };
    }

    if ('ambiguous' in resolved) {
      const names = resolved.ambiguous.map((c) => c.fullName).join(', ');
      // Same rationale as above — there is no single target to audit against.
      return {
        status: 'failed',
        error: `capability name "${capabilityName}" is ambiguous; qualify it as one of: ${names}`,
        auditId: '',
      };
    }

    const { capability, integration } = resolved;

    if (!integration.enabled) {
      const record = await this.auditor.record({
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        targetSystem: integration.name,
        integrationId: integration.id,
        capabilityName: capability.name,
        targetPayload: args,
        action: 'DENY',
        diff: { reason: 'integration disabled' },
        metadata: {
          riskDecision: 'deny',
          requestId: options.requestId,
          compliance: 'NIST AU-3 disabled integration denial',
        },
      });
      return {
        status: 'denied',
        reason: `integration "${integration.name}" is disabled`,
        auditId: record.id,
      };
    }

    if (actor.type === 'AGENT' && !this.agentsEnabled) {
      const record = await this.auditor.record({
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        targetSystem: integration.name,
        integrationId: integration.id,
        capabilityName: capability.name,
        targetPayload: args,
        action: 'DENY',
        diff: { reason: 'agent layer disabled by kill switch' },
        metadata: {
          riskDecision: 'deny',
          requestId: options.requestId,
          compliance: 'NIST AU-3 global kill switch denial',
        },
      });
      return {
        status: 'denied',
        reason: 'the agent layer is disabled by the global kill switch (AGENTS_ENABLED=false)',
        auditId: record.id,
      };
    }

    // Validate *before* the gate, not after.
    //
    // Order matters here. If validation ran inside the proxy (as it originally
    // did), a medium-risk capability would be enqueued for human approval with
    // arguments that do not satisfy its own declared schema — a human would be
    // asked to approve a malformed payload, and the schema would never have been
    // enforced at all for anything that reached the queue. Validating first means
    // a malformed request fails immediately, is never queued, and never reaches
    // a reviewer.
    const validation = validateAgainstSchema(capability.inputSchema, args ?? {}, {
      coerce: false,
      strict: true,
    });

    if (!validation.ok) {
      const detail = formatIssues(validation.issues);
      const record = await this.auditor.record({
        actorId: actor.id,
        actorName: actor.name,
        actorType: actor.type,
        targetSystem: integration.name,
        integrationId: integration.id,
        capabilityName: capability.name,
        targetPayload: args,
        action: 'DENY',
        diff: { reason: 'input validation failed', issues: validation.issues },
        metadata: {
          riskLevel: capability.riskLevel,
          riskDecision: 'deny',
          requestId: options.requestId,
          error: detail,
          compliance: 'NIST AU-3 capability input validation failure',
        },
      });

      return {
        status: 'failed',
        error: `input validation failed for "${capability.fullName}": ${detail}`,
        auditId: record.id,
        decision: {
          decision: 'deny',
          reason: 'input validation failed',
          riskLevel: capability.riskLevel,
        },
        capability: capability.fullName,
        integration: integration.name,
      };
    }

    // Everything downstream — the gate's decision payload, the approval queue's
    // stored proposal, and the proxy's request — uses the validated object, so
    // undeclared fields cannot be smuggled past the schema.
    const validatedArgs = (validation.value ?? {}) as Record<string, unknown>;

    const gate = await this.riskGate.enforce({
      capability,
      actor,
      args: validatedArgs,
      requestId: options.requestId,
    });

    if (!gate.proceed) {
      return {
        ...gate.result,
        decision: gate.decision,
        capability: capability.fullName,
        integration: integration.name,
      };
    }

    const result = await this.proxy.call({
      integration: { ...integration, forwardActorHeaders: integration.isBuiltin },
      capability,
      args: validatedArgs,
      actor,
      requestId: options.requestId,
    });

    return {
      ...result,
      decision: gate.decision,
      capability: capability.fullName,
      integration: integration.name,
    };
  }

  /**
   * Execute a previously approved request.
   *
   * The call runs as the *reviewer*, never as the proposing agent, and is
   * linked to the approval id in the audit trail. That is what makes the
   * human-in-the-loop gate real rather than decorative.
   */
  async executeApproval(
    approvalId: string,
    reviewer: Actor,
    options: { requestId?: string } = {},
  ): Promise<{ approvalId: string; result: GovernedCallResult }> {
    const approval = await this.approvals.get(approvalId);
    if (!approval) throw new Error(`Approval request "${approvalId}" not found`);

    // Only an APPROVED request may be executed.
    //
    // This is a hard gate, not a convenience check. Permitting any other status
    // would let a caller execute a PENDING proposal without a human decision
    // ever being recorded — the human-in-the-loop guarantee would then rest on
    // every caller remembering to call approve() first. The kernel does not
    // trust the caller to have done the right thing.
    if (approval.status !== 'APPROVED') {
      throw new Error(
        `Approval request "${approvalId}" is ${approval.status.toLowerCase()}, expected APPROVED`,
      );
    }

    const resolved = this.registry.resolve(`${approval.targetSystem}.${approval.capabilityName}`);

    if (!resolved || 'ambiguous' in resolved) {
      throw new Error(
        `the capability for approval "${approvalId}" (${approval.targetSystem}.${approval.capabilityName}) is no longer registered`,
      );
    }

    const { capability, integration } = resolved;
    const args = (approval.targetPayload ?? {}) as Record<string, unknown>;

    const result = await this.proxy.call({
      integration: { ...integration, forwardActorHeaders: integration.isBuiltin },
      capability,
      args,
      actor: reviewer,
      requestId: options.requestId,
      approvalId,
    });

    await this.approvals.markExecuted(
      approvalId,
      result.status === 'executed'
        ? undefined
        : 'error' in result
          ? result.error
          : 'execution did not complete',
    );

    return { approvalId, result };
  }

  // -------------------------------------------------------------- kill switch

  isAgentsEnabled(): boolean {
    return this.agentsEnabled;
  }

  async setAgentsEnabled(enabled: boolean, actor: Actor, requestId?: string): Promise<boolean> {
    const previous = this.agentsEnabled;
    this.agentsEnabled = enabled;

    await this.auditor.record({
      actorId: actor.id,
      actorName: actor.name,
      actorType: actor.type,
      targetSystem: 'kernel',
      capabilityName: 'toggle_kill_switch',
      targetResource: 'system:AGENTS_ENABLED',
      targetPayload: { enabled },
      action: 'UPDATE',
      diff: { previous, current: enabled },
      metadata: {
        requestId,
        compliance: 'NIST AU-3 administrative kill switch engagement',
      },
    });

    return this.agentsEnabled;
  }

  // ------------------------------------------------------------------- MCP

  mcpTools() {
    return buildMcpTools(this.registry.listExposedCapabilities(), {
      serverName: this.serverName(),
      version: this.version,
    });
  }

  mcpManifest() {
    return formatMcpManifest(this.registry.listExposedCapabilities(), {
      serverName: this.serverName(),
      version: this.version,
    });
  }

  mcpServerInfo() {
    return buildMcpServerInfo({ serverName: this.serverName(), version: this.version });
  }

  private serverName(): string {
    return 'tcpcore-governance-kernel';
  }

  // ------------------------------------------------------------- audit / runs

  async recordAudit(input: RecordAuditInput) {
    return this.auditor.record(input);
  }

  async queryAudit(query: AuditQueryInput) {
    return this.auditor.query(query);
  }

  async recordAgentRun(run: KernelAgentRun): Promise<void> {
    await this.store.saveAgentRun(run);
  }

  async status(): Promise<{
    status: 'ok' | 'degraded';
    agentsEnabled: boolean;
    version: string;
    uptimeSeconds: number;
    integrations: number;
    capabilities: number;
    mcpTools: number;
    pendingApprovals: number;
    auditRecords: number;
    activeAgents: number;
  }> {
    const stats = this.registry.stats();
    const pending = await this.approvals.list('PENDING');
    const audit = await this.store.listAudit({ page: 1, limit: 1 });

    return {
      status: 'ok',
      agentsEnabled: this.agentsEnabled,
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      integrations: stats.integrations,
      capabilities: stats.capabilities,
      mcpTools: this.mcpTools().length,
      pendingApprovals: pending.length,
      auditRecords: audit.total,
      activeAgents: 0,
    };
  }
}

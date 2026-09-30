import {
  AdapterSchema,
  type AdapterConfig,
  type Integration,
  type RiskLevel,
} from '@tcpcore1/shared';
import { parse as parseYaml } from 'yaml';
import { newId } from './ids.js';
import type { KernelCapabilityRecord, KernelStore } from './types.js';

export class AdapterLoadError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'AdapterLoadError';
    this.issues = issues;
  }
}

/** Flatten Zod issues into `path: message` strings. */
function describeIssues(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> })
    .issues;
  if (!Array.isArray(issues)) return [String(error)];
  return issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

/**
 * Parse and validate a `.tcp-adapter.yaml` document.
 *
 * Kept in the kernel (rather than only in `@tcpcore1/adapters`) so the kernel has no
 * dependency on the generator toolchain. Both call the same Zod schema from
 * `@tcpcore1/shared`, so the two paths cannot disagree about what is valid.
 */
export function parseAdapterYaml(yamlText: string, source = '<inline>'): AdapterConfig {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch (error) {
    throw new AdapterLoadError(
      `Adapter YAML in ${source} is not parseable: ${(error as Error).message}`,
    );
  }

  const parsed = AdapterSchema.safeParse(document);
  if (!parsed.success) {
    throw new AdapterLoadError(
      `Adapter in ${source} failed validation`,
      describeIssues(parsed.error),
    );
  }

  return parsed.data;
}

export interface RegistryOptions {
  store: KernelStore;
  /** Default enabled state for newly registered integrations. */
  defaultEnabled?: boolean;
}

/**
 * Runtime integration + capability index.
 *
 * The registry is the read model for the whole kernel: the risk gate, the proxy
 * and the MCP surface all resolve capabilities through it. It keeps a hot
 * in-memory index and mirrors writes to {@link KernelStore} so a restart
 * rehydrates instead of losing registrations.
 */
export class Registry {
  private readonly store: KernelStore;
  private readonly defaultEnabled: boolean;

  private integrations = new Map<string, Integration>();
  private capabilities = new Map<string, KernelCapabilityRecord>();

  constructor(options: RegistryOptions) {
    this.store = options.store;
    this.defaultEnabled = options.defaultEnabled ?? true;
  }

  /** Load persisted integrations into memory. Call once at boot. */
  async hydrate(): Promise<{ integrations: number; capabilities: number }> {
    const integrations = await this.store.listIntegrations();
    this.integrations.clear();
    this.capabilities.clear();

    for (const integration of integrations) {
      this.integrations.set(integration.name, integration);
    }

    for (const cap of await this.store.listCapabilities()) {
      this.capabilities.set(cap.fullName, cap);
    }

    return { integrations: this.integrations.size, capabilities: this.capabilities.size };
  }

  /**
   * Register (or replace) an adapter from parsed config. Idempotent: re-running
   * with the same name replaces the capability set rather than duplicating it.
   */
  async register(adapter: AdapterConfig, options: { enabled?: boolean; isBuiltin?: boolean } = {}) {
    const enabled = options.enabled ?? this.defaultEnabled;
    const now = new Date().toISOString();
    const existing = this.integrations.get(adapter.name);

    const integration: Integration = {
      id: existing?.id ?? `int_${adapter.name}`,
      name: adapter.name,
      displayName: adapter.display_name,
      baseUrl: adapter.base_url,
      authType: adapter.auth.type,
      configYaml: '',
      enabled,
      isBuiltin: options.isBuiltin ?? existing?.isBuiltin ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const capabilities: KernelCapabilityRecord[] = adapter.capabilities.map((cap) => ({
      id: `cap_${adapter.name}_${cap.name}`,
      integrationId: integration.id,
      integrationName: adapter.name,
      name: cap.name,
      fullName: `${adapter.name}.${cap.name}`,
      description: cap.description,
      method: cap.method,
      pathTemplate: cap.path,
      riskLevel: cap.risk,
      approvalRequired: cap.approval_required,
      agentForbidden: cap.agent_forbidden,
      contentRisk: cap.content_risk ?? null,
      deprecated: cap.deprecated,
      inputSchema: cap.input,
      outputSchema: cap.output ?? null,
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.saveIntegration(integration);
    await this.store.saveCapabilities(integration, capabilities);

    this.integrations.set(integration.name, integration);
    // Replace this integration's capability slice.
    for (const [key, cap] of this.capabilities) {
      if (cap.integrationId === integration.id) this.capabilities.delete(key);
    }
    for (const cap of capabilities) this.capabilities.set(cap.fullName, cap);

    return { integration, capabilities };
  }

  /** Convenience wrapper: register straight from YAML text. */
  async registerYaml(
    yamlText: string,
    options: { source?: string; enabled?: boolean; isBuiltin?: boolean } = {},
  ) {
    const adapter = parseAdapterYaml(yamlText, options.source ?? '<inline>');
    const result = await this.register(adapter, options);
    // Persist the exact source so the Integrations UI can show what was uploaded.
    await this.store.saveIntegration({ ...result.integration, configYaml: yamlText });
    this.integrations.set(result.integration.name, { ...result.integration, configYaml: yamlText });
    return result;
  }

  async unregister(name: string): Promise<boolean> {
    const integration = this.integrations.get(name);
    if (!integration) return false;

    await this.store.deleteIntegration(name);
    this.integrations.delete(name);
    for (const [key, cap] of this.capabilities) {
      if (cap.integrationId === integration.id) this.capabilities.delete(key);
    }
    return true;
  }

  async setEnabled(name: string, enabled?: boolean): Promise<Integration> {
    const integration = this.integrations.get(name);
    if (!integration) throw new AdapterLoadError(`Integration "${name}" is not registered`);

    integration.enabled = enabled === undefined ? !integration.enabled : enabled;
    integration.updatedAt = new Date().toISOString();
    await this.store.saveIntegration(integration);
    return integration;
  }

  getIntegration(name: string): Integration | undefined {
    return this.integrations.get(name);
  }

  listIntegrations(): Integration[] {
    return [...this.integrations.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve a capability by `integration.name` (preferred) or by bare name.
   *
   * Bare-name lookup is a convenience for the internal reference adapter, and
   * only succeeds when unambiguous — ambiguity must never silently pick one.
   */
  getCapability(nameOrQualified: string): KernelCapabilityRecord | undefined {
    if (this.capabilities.has(nameOrQualified)) return this.capabilities.get(nameOrQualified);

    const matches = [...this.capabilities.values()].filter((c) => c.name === nameOrQualified);
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  /** All matches for a bare name, so callers can report ambiguity. */
  findCapabilitiesByName(name: string): KernelCapabilityRecord[] {
    return [...this.capabilities.values()].filter((c) => c.name === name);
  }

  resolve(
    nameOrQualified: string,
  ):
    | { capability: KernelCapabilityRecord; integration: Integration }
    | { ambiguous: KernelCapabilityRecord[] }
    | undefined {
    const capability = this.getCapability(nameOrQualified);
    if (capability) {
      const integration = this.integrations.get(capability.integrationName);
      if (!integration) return undefined;
      return { capability, integration };
    }

    const candidates = this.findCapabilitiesByName(nameOrQualified);
    if (candidates.length > 1) return { ambiguous: candidates };
    return undefined;
  }

  listCapabilities(filter?: {
    risk?: RiskLevel;
    integrationName?: string;
    includeDeprecated?: boolean;
  }): KernelCapabilityRecord[] {
    let list = [...this.capabilities.values()];
    if (filter?.risk) list = list.filter((c) => c.riskLevel === filter.risk);
    if (filter?.integrationName)
      list = list.filter((c) => c.integrationName === filter.integrationName);
    if (!filter?.includeDeprecated) list = list.filter((c) => !c.deprecated);
    return list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /** Capabilities on enabled integrations only — the externally visible surface. */
  listExposedCapabilities(): KernelCapabilityRecord[] {
    const enabled = new Set(
      this.listIntegrations()
        .filter((i) => i.enabled)
        .map((i) => i.name),
    );
    return this.listCapabilities().filter((c) => enabled.has(c.integrationName));
  }

  stats(): { integrations: number; capabilities: number; enabledIntegrations: number } {
    return {
      integrations: this.integrations.size,
      capabilities: this.capabilities.size,
      enabledIntegrations: this.listIntegrations().filter((i) => i.enabled).length,
    };
  }
}

/** Generate a stable capability id without the registry (used by the CLI). */
export function capabilityId(integrationName: string, capabilityName: string): string {
  return `cap_${integrationName}_${capabilityName}`;
}

export { newId };

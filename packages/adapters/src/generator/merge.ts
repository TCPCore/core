import type { AdapterConfig, CapabilityConfig } from '@tcpcore1/shared';
import type { GeneratedAdapter, GeneratedCapability, MergeDiff } from '../types.js';

/**
 * Merge a freshly generated adapter with an existing, human-reviewed one.
 *
 * This is what makes regeneration safe. Without it, re-running the generator
 * after a vendor updates their spec would silently reset every risk level a
 * human had carefully assigned — turning a governance tool into a way to
 * accidentally grant agents new powers.
 *
 * Rules (the documented contract):
 *  - Match capabilities by name.
 *  - Present in both: take the fresh `method`, `path`, `description`, `input`,
 *    `output`; **preserve** the human's `risk`, `approval_required`,
 *    `agent_forbidden` and `content_risk`.
 *  - Only in the fresh spec: add it.
 *  - Only in the existing adapter: keep it and set `deprecated: true`. It is
 *    never deleted, because a human may still need to reason about it and an
 *    agent may still hold a grant that references it.
 */

export interface MergeOutcome {
  merged: GeneratedAdapter;
  diff: MergeDiff;
}

function toGenerated(existing: CapabilityConfig): GeneratedCapability {
  return {
    name: existing.name,
    description: existing.description,
    method: existing.method,
    pathTemplate: existing.path,
    riskLevel: existing.risk,
    approvalRequired: existing.approval_required,
    agentForbidden: existing.agent_forbidden,
    ...(existing.content_risk ? { contentRisk: existing.content_risk } : {}),
    deprecated: existing.deprecated,
    input: existing.input,
    ...(existing.output ? { output: existing.output } : {}),
    tags: [],
    notes: [
      'Carried over from the existing adapter: this capability is not present in the source spec.',
    ],
  };
}

export function mergeAdapters(existing: AdapterConfig, fresh: GeneratedAdapter): MergeOutcome {
  const existingByName = new Map(existing.capabilities.map((c) => [c.name, c]));
  const freshNames = new Set(fresh.capabilities.map((c) => c.name));

  const merged: GeneratedCapability[] = [];
  const diff: MergeDiff = { added: [], removed: [], unchanged: [], preserved: [] };

  for (const capability of fresh.capabilities) {
    const previous = existingByName.get(capability.name);

    if (!previous) {
      diff.added.push(capability.name);
      merged.push(capability);
      continue;
    }

    // Refresh the mechanical fields; keep the human's policy fields.
    const refreshed: GeneratedCapability = {
      ...capability,
      riskLevel: previous.risk,
      approvalRequired: previous.approval_required,
      agentForbidden: previous.agent_forbidden,
      contentRisk: previous.content_risk ?? capability.contentRisk,
      deprecated: capability.deprecated,
    };

    const preservedFields: string[] = [];
    if (previous.risk !== capability.riskLevel) {
      preservedFields.push(
        `risk (generator suggested ${capability.riskLevel}, kept ${previous.risk})`,
      );
    }
    if (previous.approval_required !== capability.approvalRequired) {
      preservedFields.push(
        `approval_required (generator suggested ${capability.approvalRequired}, kept ${previous.approval_required})`,
      );
    }
    if (previous.agent_forbidden !== capability.agentForbidden) {
      preservedFields.push(
        `agent_forbidden (generator suggested ${capability.agentForbidden}, kept ${previous.agent_forbidden})`,
      );
    }
    if (previous.content_risk !== capability.contentRisk) {
      preservedFields.push(
        `content_risk (generator suggested ${capability.contentRisk ?? 'none'}, kept ${previous.content_risk ?? 'none'})`,
      );
    }

    if (preservedFields.length > 0) {
      diff.preserved.push(`${capability.name}: ${preservedFields.join('; ')}`);
      refreshed.notes = [
        ...refreshed.notes,
        `PRESERVED human edits on regeneration — ${preservedFields.join('; ')}`,
      ];
    } else {
      diff.unchanged.push(capability.name);
    }

    // Surface a changed description so a reviewer notices the API changed.
    if (previous.description !== capability.description) {
      refreshed.notes = [
        ...refreshed.notes,
        `Description changed since the last generation (was: "${previous.description}")`,
      ];
    }

    merged.push(refreshed);
  }

  for (const previous of existing.capabilities) {
    if (freshNames.has(previous.name)) continue;

    diff.removed.push(previous.name);
    const carried = toGenerated(previous);
    carried.deprecated = true;
    carried.notes = [
      ...carried.notes,
      'Marked deprecated. It is retained, not deleted, so existing agent grants keep resolving.',
    ];
    merged.push(carried);
  }

  return {
    merged: { ...fresh, capabilities: merged },
    diff,
  };
}

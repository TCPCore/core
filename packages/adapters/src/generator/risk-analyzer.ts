import type { NormalizedOperation, RiskDecision } from '../types.js';

/**
 * Risk inference — the single most consequential heuristic in the product.
 *
 * The rule order below is a deliberate policy, not a bag of heuristics, and it
 * is the documented contract (see `docs/concepts/risk-model`). Ordering matters:
 * a destructive verb in the path outranks the HTTP method, and a method that
 * cannot mutate outranks a suspicious-looking path segment.
 *
 *  1. DELETE method                       → high + agent_forbidden
 *  2. destructive verb in path            → high + agent_forbidden
 *  3. money-moving verb on a non-GET      → high (human approval, agents allowed)
 *  4. mutating method OR write verb       → medium + approval_required
 *  5. GET / HEAD / OPTIONS                → low
 *  6. anything else                       → medium
 *
 * Every decision carries a rationale and the rule ids that fired, which the
 * emitter writes into the YAML as comments. A reviewer must be able to see
 * *why* the generator picked a risk level, because they are about to be
 * responsible for it.
 */

/** Rule ids, exported so tests and the UI can assert on them. */
export const RISK_RULES = {
  METHOD_DELETE: 'HTTP_METHOD_DELETE',
  PATH_DESTRUCTIVE: 'PATH_DESTRUCTIVE_KEYWORD',
  MONEY_MOVEMENT: 'MONEY_MOVEMENT_MUTATION',
  METHOD_MUTATION: 'HTTP_METHOD_MUTATION',
  WRITE_VERB: 'PATH_WRITE_VERB',
  METHOD_READONLY: 'HTTP_METHOD_READONLY',
  FALLBACK: 'FALLBACK_MEDIUM',
  SCHEMA_AMOUNT: 'SCHEMA_AMOUNT_FIELD',
} as const;

/**
 * Irreversible or destructive actions. These are blocked to agents outright.
 * Matched against the path only (not the description), so prose in a summary
 * cannot accidentally drive policy.
 */
const DESTRUCTIVE_PATH =
  /\b(delete|destroy|purge|drop|wipe|erase|terminate|revoke|deactivate|disable|ban|suspend|reset_mfa|transfer_ownership|close_account|uninstall|shutdown|unlink|expel|truncate)\b/i;

/**
 * Actions that move money or change entitlements. Human approval is mandatory,
 * but agents may *propose* them.
 */
const MONEY_PATH =
  /\b(refund|charge|payment|payout|transfer|withdraw|credit|debit|invoice|settle|disburse|remit|topup|top_up)\b/i;

/** Ordinary writes. Medium risk with approval. */
const WRITE_PATH =
  /\b(create|update|patch|edit|modify|set|add|send|publish|post|put|notify|email|invite|assign|upload|import|enable|activate|approve|schedule|resume|start|retry|merge|move|cancel|archive|close|resolve|reopen)\b/i;

/** Fields whose numeric value is worth flagging for conditional risk rules. */
const AMOUNT_FIELDS = [
  'amount',
  'total',
  'price',
  'quantity',
  'value',
  'sum',
  'cost',
  'credit',
  'debit',
  'refund_amount',
  'amount_cents',
];

function pathOf(op: NormalizedOperation): string {
  // Normalise separators so `/charges/{id}/refund` and `/charges/:id/refund`
  // and `/charges/{id}/refund/` all match identically.
  return op.path.replace(/[:{][^}/]+}?/g, '{}');
}

/**
 * Look for a numeric, amount-like field in the operation's input schema.
 * Used only to annotate the output with a conditional-risk hint.
 */
export function findAmountField(op: NormalizedOperation): string | undefined {
  const candidates: Array<[string, unknown]> = [];

  const body = op.requestBody;
  if (body && typeof body === 'object') {
    const properties = (body as { properties?: Record<string, unknown> }).properties;
    if (properties) {
      for (const [key, value] of Object.entries(properties)) candidates.push([key, value]);
    }
  }

  for (const param of op.parameters) {
    candidates.push([param.name, param.schema]);
  }

  for (const [key, schema] of candidates) {
    const lower = key.toLowerCase();
    if (!AMOUNT_FIELDS.includes(lower)) continue;
    const type = (schema as { type?: unknown })?.type;
    if (type === 'number' || type === 'integer') return key;
  }

  return undefined;
}

export function inferRisk(op: NormalizedOperation): RiskDecision {
  const path = pathOf(op);
  const rules: string[] = [];

  // Rule 1: DELETE can never be undone.
  if (op.method === 'DELETE') {
    rules.push(RISK_RULES.METHOD_DELETE);
    return {
      level: 'high',
      approvalRequired: false,
      agentForbidden: true,
      reason: 'HTTP DELETE is irreversible. Blocked to agents; a human must execute it.',
      rulesTriggered: rules,
    };
  }

  // Rule 2: destructive verb anywhere in the path.
  const destructiveMatch = DESTRUCTIVE_PATH.exec(path);
  if (destructiveMatch) {
    rules.push(RISK_RULES.PATH_DESTRUCTIVE);
    return {
      level: 'high',
      approvalRequired: false,
      agentForbidden: true,
      reason: `Destructive verb "${destructiveMatch[0]}" in the path. Blocked to agents; a human must execute it.`,
      rulesTriggered: rules,
    };
  }

  // Rule 3: money movement by a non-read method.
  if (op.method !== 'GET' && op.method !== 'HEAD' && op.method !== 'OPTIONS') {
    const moneyMatch = MONEY_PATH.exec(path);
    if (moneyMatch) {
      rules.push(RISK_RULES.MONEY_MOVEMENT);
      const amountField = findAmountField(op);
      return {
        level: 'high',
        approvalRequired: true,
        agentForbidden: false,
        reason: `Money-moving operation "${moneyMatch[0]}" (${op.method}). High risk: requires explicit human approval before execution.`,
        rulesTriggered: amountField ? [...rules, RISK_RULES.SCHEMA_AMOUNT] : rules,
        conditionalHint: amountField
          ? `Consider a conditional rule: \`${amountField} > 1000 => high, else low\` for small-value operations.`
          : undefined,
      };
    }
  }

  // Rule 4: ordinary mutation.
  if (op.method === 'POST' || op.method === 'PUT' || op.method === 'PATCH') {
    rules.push(RISK_RULES.METHOD_MUTATION);
    const writeMatch = WRITE_PATH.exec(path);
    if (writeMatch) rules.push(RISK_RULES.WRITE_VERB);

    const amountField = findAmountField(op);
    if (amountField) rules.push(RISK_RULES.SCHEMA_AMOUNT);

    return {
      level: 'medium',
      approvalRequired: true,
      agentForbidden: false,
      reason: writeMatch
        ? `Mutating method ${op.method} with write verb "${writeMatch[0]}". Reversible change: requires human approval.`
        : `Mutating method ${op.method}. Requires human approval.`,
      rulesTriggered: rules,
      conditionalHint: amountField
        ? `This operation takes a numeric \`${amountField}\`. Consider a conditional risk rule so small values execute without approval.`
        : undefined,
    };
  }

  // Rule 5: read-only.
  if (op.method === 'GET' || op.method === 'HEAD' || op.method === 'OPTIONS') {
    rules.push(RISK_RULES.METHOD_READONLY);
    return {
      level: 'low',
      approvalRequired: false,
      agentForbidden: false,
      reason: `${op.method} is read-only and idempotent. Executes immediately.`,
      rulesTriggered: rules,
    };
  }

  // Rule 6: unknown/rare method — fail safe, not open.
  rules.push(RISK_RULES.FALLBACK);
  return {
    level: 'medium',
    approvalRequired: true,
    agentForbidden: false,
    reason: `Method ${op.method} is not classified as read-only. Failing safe: requires human approval.`,
    rulesTriggered: rules,
  };
}

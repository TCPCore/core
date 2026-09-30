import type { ContentRiskDecision, NormalizedOperation } from '../types.js';

/**
 * Content risk analysis: does this operation return free text written by a
 * third party?
 *
 * This is the input to the kernel's prompt-injection defence. A capability that
 * returns a ticket body, a CRM note, an email, or a chat message is a channel
 * an attacker can write into, and the kernel must know to scan it before an
 * agent reads it. No other MCP server makes this distinction, which is part of
 * why it matters.
 *
 * The heuristic is deliberately conservative in the safe direction: when a
 * response *might* carry free text we mark it, because a false positive costs
 * one cheap regex scan while a false negative costs a compromised agent.
 */

/** Field names that reliably indicate attacker-writable prose. */
const FREE_TEXT_FIELDS = [
  'body',
  'text',
  'message',
  'description',
  'notes',
  'note',
  'comment',
  'comments',
  'content',
  'summary',
  'details',
  'details_text',
  'reason',
  'subject',
  'title',
  'html',
  'html_body',
  'plain_text',
  'raw',
  'payload',
  'snippet',
  'excerpt',
  'memo',
  'internal_notes',
  'additional_info',
  'customer_message',
  'reply',
  'email_body',
  'bio',
  'about',
  'instructions',
];

/**
 * Collections of user-authored records. A list endpoint returning issues or
 * messages is high content risk even when the field names are not visible in
 * the spec, because the records themselves carry prose.
 */
const PROSE_COLLECTION_PATH =
  /\b(messages?|comments?|notes?|emails?|issues?|tickets?|conversations?|posts?|reviews?|articles?|docs?|documents?|threads?|chats?|feedback|inbox|mentions?|activities|timeline|history|logs?)\b/i;

/** Endpoints whose payloads are templates or schemas, not live prose. */
const NEGATIVE_PATH =
  /\b(schema|schemas|openapi|swagger|metadata|types|enums|status|categories|tags|labels|permissions|scopes|capabilities|health|version|metrics|stats|count)\b/i;

/** Cap how deep we walk a response schema. */
const MAX_DEPTH = 8;

interface WalkResult {
  fields: string[];
  collection: boolean;
}

function walkSchema(schema: unknown, path: string, depth: number, found: WalkResult): void {
  if (depth > MAX_DEPTH || schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;

  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      if (FREE_TEXT_FIELDS.includes(key.toLowerCase())) {
        found.fields.push(path ? `${path}.${key}` : key);
      }
      walkSchema(child, path ? `${path}.${key}` : key, depth + 1, found);
    }
  }

  if (node.items) {
    found.collection = true;
    walkSchema(node.items, `${path}[]`, depth + 1, found);
  }

  for (const branch of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = node[branch];
    if (Array.isArray(list)) {
      for (const child of list) walkSchema(child, path, depth + 1, found);
    }
  }

  const additional = node.additionalProperties;
  if (additional && typeof additional === 'object') {
    walkSchema(additional, `${path}.*`, depth + 1, found);
  }
}

export function analyzeContentRisk(op: NormalizedOperation): ContentRiskDecision {
  if (NEGATIVE_PATH.test(op.path)) {
    return { level: undefined, reason: 'Metadata-style endpoint; no third-party prose expected.' };
  }

  const found: WalkResult = { fields: [], collection: false };

  for (const [status, schema] of Object.entries(op.responses)) {
    // Only successful responses reach an agent.
    if (!/^2\d\d$/.test(status) && status !== 'default') continue;
    walkSchema(schema, '', 0, found);

    // A response that is a bare array of free-text strings.
    const node = schema as Record<string, unknown> | undefined;
    if (node && node.type === 'array') {
      const items = node.items as Record<string, unknown> | undefined;
      if (items && items.type === 'string') found.fields.push('[]');
    }
  }

  if (found.fields.length > 0) {
    const unique = [...new Set(found.fields)].slice(0, 6);
    return {
      level: 'high',
      reason: `Response contains third-party prose field(s): ${unique.join(', ')}. Scanned for prompt injection before an agent sees it.`,
    };
  }

  if (found.collection && PROSE_COLLECTION_PATH.test(op.path)) {
    return {
      level: 'medium',
      reason:
        'Response is a collection of user-authored records; contents are untrusted text. Scanned for prompt injection.',
    };
  }

  if (PROSE_COLLECTION_PATH.test(op.path) && (op.method === 'GET' || op.method === 'HEAD')) {
    return {
      level: 'medium',
      reason:
        'Read of user-authored records; response may contain untrusted prose. Scanned for prompt injection.',
    };
  }

  return { level: undefined, reason: 'No untrusted free text detected in the response schema.' };
}

import { describe, expect, it } from 'vitest';
import { validateAdapter, loadAdapter, hasAgentReachableCapabilities } from '../validator.js';

const VALID = `name: acme
display_name: Acme API
base_url: https://api.acme.example.com
auth:
  type: bearer
  header: Authorization
capabilities:
  - name: list_widgets
    method: GET
    path: /widgets
    description: List widgets
    risk: low
    input:
      type: object
      properties:
        limit: { type: integer }
`;

function withCapability(capability: string): string {
  return `name: acme
display_name: Acme API
base_url: https://api.acme.example.com
auth:
  type: bearer
capabilities:
${capability}
`;
}

describe('validateAdapter', () => {
  it('accepts a well-formed adapter', () => {
    const result = validateAdapter(VALID, { source: 'acme.yaml' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.adapter.capabilities).toHaveLength(1);
  });

  it('rejects invalid YAML', () => {
    const result = validateAdapter('name: [unclosed', { source: 'broken.yaml' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.message).toContain('not valid YAML');
  });

  it('rejects an empty document', () => {
    const result = validateAdapter('', { source: 'empty.yaml' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.message).toContain('empty');
  });

  it('rejects a missing required field', () => {
    const result = validateAdapter('name: acme\ndisplay_name: Acme\n', { source: 'x.yaml' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain('base_url');
      expect(paths).toContain('auth');
    }
  });

  it('rejects a relative base_url', () => {
    const result = validateAdapter(
      'name: a\ndisplay_name: A\nbase_url: /relative\nauth: { type: none }\ncapabilities:\n  - name: x\n    method: GET\n    path: /x\n    description: x\n    risk: low\n',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a capability name that is not lowercase snake_case', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: ListWidgets\n    method: GET\n    path: /w\n    description: w\n    risk: low\n',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate capability name', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: list_widgets\n    method: GET\n    path: /w\n    description: w\n    risk: low\n' +
          '  - name: list_widgets\n    method: GET\n    path: /w2\n    description: w\n    risk: low\n',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a capability path that is not absolute', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: list_widgets\n    method: GET\n    path: widgets\n    description: w\n    risk: low\n',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('requires a token_endpoint for oauth2', () => {
    const result = validateAdapter(
      `name: acme
display_name: Acme
base_url: https://api.acme.example.com
auth:
  type: oauth2
capabilities:
  - name: list_widgets
    method: GET
    path: /widgets
    description: w
    risk: low
`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('token_endpoint'))).toBe(true);
    }
  });

  it('rejects an adapter with no capabilities', () => {
    const result = validateAdapter(
      'name: acme\ndisplay_name: Acme\nbase_url: https://api.acme.example.com\nauth: { type: none }\ncapabilities: []\n',
    );
    expect(result.ok).toBe(false);
  });

  // --- policy consistency: this is where an author hands an agent a weapon ---

  it('rejects a destructive capability that is not agent_forbidden', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: delete_widget\n    method: POST\n    path: /widgets/{id}/delete\n    description: d\n    risk: high\n',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('agent_forbidden'))).toBe(true);
    }
  });

  it('rejects a DELETE that is not agent_forbidden', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: remove_widget\n    method: DELETE\n    path: /widgets/{id}\n    description: d\n    risk: high\n    agent_forbidden: false\n',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a destructive capability marked low risk', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: purge_widget\n    method: POST\n    path: /widgets/purge\n    description: d\n    risk: low\n    agent_forbidden: true\n',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects agent_forbidden combined with approval_required', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: delete_widget\n    method: DELETE\n    path: /widgets/{id}\n    description: d\n    risk: high\n    agent_forbidden: true\n    approval_required: true\n',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('mutually exclusive'))).toBe(true);
    }
  });

  it('rejects money movement marked low risk', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: create_refund\n    method: POST\n    path: /refunds\n    description: r\n    risk: low\n',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('money-moving'))).toBe(true);
    }
  });

  it('accepts money movement at medium risk with approval', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: create_refund\n    method: POST\n    path: /refunds\n    description: r\n    risk: medium\n    approval_required: true\n',
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('warns rather than errors when a GET requires approval', () => {
    const result = validateAdapter(
      withCapability(
        '  - name: audit_log\n    method: GET\n    path: /audit\n    description: a\n    risk: low\n    approval_required: true\n',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.warnings.some((w) => w.includes('GET with approval_required'))).toBe(true);
  });

  it('warns when auth is none', () => {
    const result = validateAdapter(
      'name: acme\ndisplay_name: Acme\nbase_url: https://api.acme.example.com\nauth: { type: none }\ncapabilities:\n  - name: list_widgets\n    method: GET\n    path: /w\n    description: w\n    risk: low\n',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes('unauthenticated'))).toBe(true);
  });
});

describe('loadAdapter', () => {
  it('throws with the offending paths when invalid', () => {
    expect(() => loadAdapter('name: acme\n', { source: 'bad.yaml' })).toThrow(
      /bad\.yaml failed validation/,
    );
  });

  it('returns the parsed config when valid', () => {
    const adapter = loadAdapter(VALID, { source: 'acme.yaml' });
    expect(adapter.name).toBe('acme');
    expect(adapter.auth.type).toBe('bearer');
  });
});

describe('hasAgentReachableCapabilities', () => {
  it('is true when at least one capability is not forbidden or high risk', () => {
    const adapter = loadAdapter(VALID);
    expect(hasAgentReachableCapabilities(adapter)).toBe(true);
  });

  it('is false when every capability is high risk or forbidden', () => {
    const adapter = loadAdapter(
      withCapability(
        '  - name: delete_widget\n    method: DELETE\n    path: /w/{id}\n    description: d\n    risk: high\n    agent_forbidden: true\n',
      ),
    );
    expect(hasAgentReachableCapabilities(adapter)).toBe(false);
  });
});

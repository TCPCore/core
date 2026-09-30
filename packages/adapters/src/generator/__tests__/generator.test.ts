import { describe, expect, it } from 'vitest';
import { parseSpecText, swagger2ToOpenApi3, SpecParseError } from '../parser.js';
import { validateAdapter } from '../../validator.js';
import { generateAdapter } from '../index.js';
import { SAMPLE_SPECS } from '../sample-specs.js';

describe('format detection', () => {
  it('detects and parses OpenAPI 3', () => {
    const spec = parseSpecText(SAMPLE_SPECS.find((s) => s.id === 'petstore')!.content, 'petstore');
    expect(spec.format).toBe('openapi');
    expect(spec.baseUrl).toBe('https://petstore.example.com/api/v3');
    expect(spec.operations.length).toBeGreaterThan(4);
  });

  it('converts and parses Swagger 2.0', () => {
    const spec = parseSpecText(SAMPLE_SPECS.find((s) => s.id === 'swagger2')!.content, 'legacy');
    expect(spec.format).toBe('swagger');
    expect(spec.baseUrl).toBe('https://legacy-crm.example.com/api/v2');
    expect(spec.operations.map((o) => o.id)).toContain('listContacts');
  });

  it('resolves a Swagger 2.0 body parameter into requestBody', () => {
    const spec = parseSpecText(SAMPLE_SPECS.find((s) => s.id === 'swagger2')!.content, 'legacy');
    const create = spec.operations.find((o) => o.id === 'createContact')!;
    expect(create.requestBody).toBeDefined();
    expect(
      (create.requestBody as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty('fullName');
  });

  it('throws a typed error for an unparseable document', () => {
    expect(() => parseSpecText('{ not json', 'broken')).toThrow(SpecParseError);
  });
});

describe('swagger2ToOpenApi3', () => {
  it('rewrites definition refs to components/schemas', () => {
    const converted = swagger2ToOpenApi3({
      swagger: '2.0',
      host: 'example.com',
      basePath: '/v1',
      paths: { '/a': { get: { responses: { 200: { schema: { $ref: '#/definitions/A' } } } } } },
      definitions: { A: { type: 'object' } },
    }) as Record<string, unknown>;

    const paths = JSON.stringify(converted.paths);
    expect(paths).toContain('#/components/schemas/A');
    expect(paths).not.toContain('#/definitions/A');
    expect((converted.servers as Array<{ url: string }>)[0]!.url).toBe('https://example.com/v1');
  });
});

describe('generateAdapter', () => {
  it('produces YAML that the adapter validator accepts', async () => {
    const petstore = SAMPLE_SPECS.find((s) => s.id === 'petstore')!;
    const result = await generateAdapter(petstore.content, { from: 'openapi' });

    const validation = validateAdapter(result.yaml, { source: 'generated' });
    if (!validation.ok) {
      throw new Error(
        `generated YAML failed validation:\n${validation.errors
          .map((e) => `${e.path}: ${e.message}`)
          .join('\n')}\n\n${result.yaml}`,
      );
    }
    expect(validation.ok).toBe(true);
  });

  it('never generates a destructive capability that agents can call', async () => {
    const infra = SAMPLE_SPECS.find((s) => s.id === 'infra')!;
    const result = await generateAdapter(infra.content, { from: 'openapi' });

    for (const capability of result.adapter.capabilities) {
      if (capability.method === 'DELETE') {
        expect(capability.agentForbidden).toBe(true);
        expect(capability.riskLevel).toBe('high');
      }
    }
  });

  it('reports a risk breakdown that sums to the capability count', async () => {
    const petstore = SAMPLE_SPECS.find((s) => s.id === 'petstore')!;
    const result = await generateAdapter(petstore.content, { from: 'openapi' });
    const { low, medium, high } = result.riskBreakdown;
    expect(low + medium + high).toBe(result.capabilityCount);
  });

  it('honours --max-risk', async () => {
    const petstore = SAMPLE_SPECS.find((s) => s.id === 'petstore')!;
    const result = await generateAdapter(petstore.content, { from: 'openapi', maxRisk: 'low' });
    expect(result.adapter.capabilities.every((c) => c.riskLevel === 'low')).toBe(true);
    expect(result.adapter.capabilities.length).toBeGreaterThan(0);
  });

  it('preserves human risk overrides when merging', async () => {
    const petstore = SAMPLE_SPECS.find((s) => s.id === 'petstore')!;
    const first = await generateAdapter(petstore.content, { from: 'openapi' });

    // Simulate a human downgrading a capability and forbidding another.
    const { parse } = await import('yaml');
    const existing = parse(first.yaml) as {
      capabilities: Array<Record<string, unknown>>;
    };
    const target = existing.capabilities.find((c) => c.risk === 'high')!;
    target.risk = 'low';
    target.agent_forbidden = false;

    const second = await generateAdapter(petstore.content, {
      from: 'openapi',
      merge: existing as never,
    });

    const merged = second.adapter.capabilities.find((c) => c.name === target.name)!;
    expect(merged.riskLevel).toBe('low');
    expect(merged.agentForbidden).toBe(false);
    expect(second.diff?.preserved.some((entry) => entry.startsWith(String(target.name)))).toBe(
      true,
    );
  });

  it('marks a capability deprecated rather than deleting it when it disappears', async () => {
    const petstore = SAMPLE_SPECS.find((s) => s.id === 'petstore')!;
    const first = await generateAdapter(petstore.content, { from: 'openapi' });

    const { parse } = await import('yaml');
    const existing = parse(first.yaml) as {
      capabilities: Array<Record<string, unknown>>;
    };
    existing.capabilities.push({
      name: 'an_operation_that_vanished',
      method: 'GET',
      path: '/gone',
      description: 'no longer in the spec',
      risk: 'low',
      approval_required: false,
      agent_forbidden: false,
      deprecated: false,
      input: { type: 'object', properties: {} },
    });

    const second = await generateAdapter(petstore.content, {
      from: 'openapi',
      merge: existing as never,
    });

    const carried = second.adapter.capabilities.find(
      (c) => c.name === 'an_operation_that_vanished',
    );
    expect(carried).toBeDefined();
    expect(carried!.deprecated).toBe(true);
    expect(second.diff?.removed).toContain('an_operation_that_vanished');
  });

  it('redacts credential-shaped values from the output', async () => {
    // Assembled at runtime rather than written as one literal.
    //
    // The value has to be genuinely credential-shaped for this test to prove
    // anything — the sanitiser matches on shape. But a contiguous token in the
    // source trips GitHub push protection (it is indistinguishable from a real
    // key), which would block the push for a fixture that is obviously fake.
    // Concatenation keeps the assertion real and the source clean.
    const leaky = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');

    const spec = `openapi: 3.0.3
info: { title: Leaky, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /keys:
    get:
      operationId: listKeys
      summary: "Lists keys. Example key: ${leaky}"
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  key:
                    type: string
                    example: ${leaky}
`;
    const result = await generateAdapter(spec, { from: 'openapi' });
    // The value really was present in the input, so the sanitiser had
    // something to remove.
    expect(spec).toContain(leaky);
    expect(result.yaml).not.toContain(leaky);
    expect(result.yaml).toContain('[REDACTED]');
  });

  it('flags content_risk on free-text responses', async () => {
    const inbox = SAMPLE_SPECS.find((s) => s.id === 'inbox')!;
    const result = await generateAdapter(inbox.content, { from: 'openapi' });
    const withContentRisk = result.adapter.capabilities.filter((c) => c.contentRisk);
    expect(withContentRisk.length).toBeGreaterThan(0);
  });
});

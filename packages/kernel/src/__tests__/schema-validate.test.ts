import { describe, expect, it } from 'vitest';
import { validateAgainstSchema } from '../schema-validate.js';

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      ticketId: { type: 'string' },
      priority: { type: 'string', enum: ['LOW', 'HIGH'] },
      amount: { type: 'number', minimum: 1, maximum: 100 },
    },
    required: ['ticketId'],
    additionalProperties: false,
  };

  it('accepts a valid payload', () => {
    const result = validateAgainstSchema(schema, { ticketId: 'T-1', priority: 'LOW', amount: 5 });
    expect(result.ok).toBe(true);
  });

  it('reports a missing required property', () => {
    const result = validateAgainstSchema(schema, { priority: 'LOW' });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ path: 'ticketId', message: 'is required' });
  });

  it('rejects a value outside the enum', () => {
    const result = validateAgainstSchema(schema, { ticketId: 'T-1', priority: 'URGENT' });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('must be one of');
  });

  it('enforces numeric bounds', () => {
    expect(validateAgainstSchema(schema, { ticketId: 'T-1', amount: 0 }).ok).toBe(false);
    expect(validateAgainstSchema(schema, { ticketId: 'T-1', amount: 101 }).ok).toBe(false);
  });

  it('drops undeclared properties so they cannot be smuggled to the target', () => {
    const result = validateAgainstSchema(schema, { ticketId: 'T-1', admin: true });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ ticketId: 'T-1' });
  });

  it('applies declared defaults', () => {
    const result = validateAgainstSchema(
      { type: 'object', properties: { limit: { type: 'integer', default: 20 } } },
      {},
    );
    expect(result.value).toEqual({ limit: 20 });
  });

  it('coerces only when explicitly requested', () => {
    const strict = validateAgainstSchema(schema, { ticketId: 5 });
    expect(strict.ok).toBe(false);

    const loose = validateAgainstSchema(
      { type: 'object', properties: { n: { type: 'integer' } } },
      { n: '7' },
      { coerce: true },
    );
    expect(loose.ok).toBe(true);
    expect(loose.value).toEqual({ n: 7 });
  });

  it('accepts any object when no schema is declared', () => {
    expect(validateAgainstSchema({}, { anything: 1 }).ok).toBe(true);
    expect(validateAgainstSchema(null, 'not-an-object').ok).toBe(false);
  });
});

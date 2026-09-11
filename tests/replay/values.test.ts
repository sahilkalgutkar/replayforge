import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  coerceOutput,
  deepSubstitute,
  resolveSecrets,
  resolveValue,
  substituteTemplate,
  validateInputs,
} from '../../src/replay/values.js';
import type { OutputSpec, ParamSpec } from '../../src/artifact/schema.js';

const bindings = { variables: { baseUrl: 'http://localhost:4310' }, secrets: { core_password: 'pw' } };

describe('templates', () => {
  it('fills from inputs and from tenant binding variables alike', () => {
    expect(
      substituteTemplate('{{baseUrl}}/content/member/{{memberNumber}}', { memberNumber: '10021' }, bindings),
    ).toBe('http://localhost:4310/content/member/10021');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(substituteTemplate('{{ baseUrl }}/x', {}, bindings)).toBe('http://localhost:4310/x');
  });

  it('names the reference it cannot fill', () => {
    expect(() => substituteTemplate('{{tenantHost}}/x', {}, bindings)).toThrow(/tenantHost/);
  });

  it('substitutes deep inside a target without touching numbers or nulls', () => {
    const target = {
      description: 'the row for {{memberNumber}}',
      primary: { name: { mode: 'equals', value: '{{memberNumber}}' }, ordinal: 0, extra: null },
    };
    expect(deepSubstitute(target, { memberNumber: '10021' }, bindings)).toEqual({
      description: 'the row for 10021',
      primary: { name: { mode: 'equals', value: '10021' }, ordinal: 0, extra: null },
    });
  });

  it('substitutes through arrays and repeated calls stay correct', () => {
    const value = ['{{memberNumber}}', '{{memberNumber}}', 'plain'];
    expect(deepSubstitute(value, { memberNumber: '7' }, bindings)).toEqual(['7', '7', 'plain']);
    expect(deepSubstitute(value, { memberNumber: '7' }, bindings)).toEqual(['7', '7', 'plain']);
  });
});

describe('value sources', () => {
  it('returns a literal untouched, even one that looks like a template', () => {
    expect(resolveValue({ kind: 'literal', value: '{{notAReference}}' }, {}, bindings)).toBe(
      '{{notAReference}}',
    );
  });

  it('reads a parameter and complains when it is missing', () => {
    expect(resolveValue({ kind: 'param', name: 'memberNumber' }, { memberNumber: 10021 }, bindings)).toBe('10021');
    expect(() => resolveValue({ kind: 'param', name: 'ghost' }, {}, bindings)).toThrow(/was not supplied/);
  });

  it('reads a secret and complains when the environment lacks it', () => {
    expect(resolveValue({ kind: 'secret', ref: 'core_password' }, {}, bindings)).toBe('pw');
    expect(() => resolveValue({ kind: 'secret', ref: 'other' }, {}, bindings)).toThrow(/not available/);
  });
});

describe('transforms', () => {
  it('leaves a value alone without a transform, and collapses whitespace with trim', () => {
    expect(applyTransform('  a   b ')).toBe('  a   b ');
    expect(applyTransform('  a   b ', { kind: 'trim' })).toBe('a b');
  });

  it('turns a formatted currency string into a number', () => {
    expect(applyTransform('$4,182.55', { kind: 'currencyToNumber' })).toBe(4182.55);
    expect(applyTransform('-$12.00', { kind: 'currencyToNumber' })).toBe(-12);
    // A cell that declined to answer must not become a balance of zero.
    expect(() => applyTransform('n/a', { kind: 'currencyToNumber' })).toThrow(/could not read a number/);
    expect(() => applyTransform('—', { kind: 'currencyToNumber' })).toThrow(/could not read a number/);
  });

  it('captures a group and complains when the pattern matches nothing', () => {
    expect(
      applyTransform('CONF-SAV02-10021', { kind: 'regexCapture', pattern: 'CONF-(\\S+)', group: 1 }),
    ).toBe('SAV02-10021');
    expect(() =>
      applyTransform('nothing here', { kind: 'regexCapture', pattern: 'CONF-(\\S+)', group: 1 }),
    ).toThrow(/captured nothing/);
  });
});

describe('input validation', () => {
  const specs: ParamSpec[] = [
    {
      name: 'memberNumber',
      type: 'string',
      required: true,
      description: 'x',
      sensitivity: 'internal',
      pattern: '^[0-9]{4,10}$',
    },
    { name: 'amount', type: 'number', required: false, description: 'x', sensitivity: 'internal' },
    { name: 'confirm', type: 'boolean', required: false, description: 'x', sensitivity: 'internal' },
    {
      name: 'product',
      type: 'enum',
      enumValues: ['SAV02', 'CD12'],
      required: false,
      description: 'x',
      sensitivity: 'internal',
    },
  ];

  it('accepts and types a valid set of arguments', () => {
    const result = validateInputs(specs, {
      memberNumber: '10021',
      amount: '25.50',
      confirm: 'true',
      product: 'CD12',
    });
    expect(result).toEqual({
      ok: true,
      values: { memberNumber: '10021', amount: 25.5, confirm: true, product: 'CD12' },
    });
  });

  it('requires what the contract says is required, and allows omitting the rest', () => {
    expect(validateInputs(specs, {})).toMatchObject({ ok: false });
    expect(validateInputs(specs, { memberNumber: '10021' })).toMatchObject({ ok: true });
  });

  it('treats an empty string as absent', () => {
    const result = validateInputs(specs, { memberNumber: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('required');
  });

  it('rejects a value that fails the declared pattern', () => {
    const result = validateInputs(specs, { memberNumber: 'abcd' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('pattern');
  });

  it('rejects a non-number, a non-boolean and a value outside the enum', () => {
    const bad = validateInputs(specs, {
      memberNumber: '10021',
      amount: 'lots',
      confirm: 'maybe',
      product: 'SAV99',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((i) => i.name)).toEqual(['amount', 'confirm', 'product']);
    }
  });

  it('rejects an argument the contract does not declare', () => {
    const result = validateInputs(specs, { memberNumber: '10021', sneaky: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('not a parameter');
  });
});

describe('output coercion', () => {
  const spec = (overrides: Partial<OutputSpec> = {}): OutputSpec => ({
    name: 'savingsBalance',
    type: 'number',
    description: 'x',
    sensitivity: 'internal',
    from: 'savingsBalance',
    required: true,
    ...overrides,
  });

  it('passes a number straight through and parses a formatted one', () => {
    expect(coerceOutput(spec(), 4182.55)).toEqual({ ok: true, value: 4182.55 });
    expect(coerceOutput(spec(), '$4,182.55')).toEqual({ ok: true, value: 4182.55 });
  });

  it('reports a number output that read something unparseable', () => {
    const result = coerceOutput(spec(), 'unavailable');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('declared number');
    expect(coerceOutput(spec(), '—')).toMatchObject({ ok: false });
  });

  it('reports a required output nothing produced, and tolerates an optional one', () => {
    expect(coerceOutput(spec(), undefined)).toMatchObject({ ok: false });
    expect(coerceOutput(spec({ required: false }), undefined)).toEqual({ ok: true, value: '' });
  });

  it('stringifies and booleanises according to the declared type', () => {
    expect(coerceOutput(spec({ type: 'string' }), 4182.55)).toEqual({ ok: true, value: '4182.55' });
    expect(coerceOutput(spec({ type: 'boolean' }), 'yes')).toEqual({ ok: true, value: true });
  });
});

describe('secret resolution', () => {
  it('reads declared secrets from the environment', () => {
    const result = resolveSecrets([{ ref: 'pw', envVar: 'X_PW' }], { X_PW: 'hunter2' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: true, secrets: { pw: 'hunter2' } });
  });

  it('names every missing one, including an empty variable', () => {
    const result = resolveSecrets(
      [
        { ref: 'user', envVar: 'X_USER' },
        { ref: 'pw', envVar: 'X_PW' },
      ],
      { X_USER: '' } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(['user (X_USER)', 'pw (X_PW)']);
  });
});

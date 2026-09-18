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
  it('fills from inputs and tenant variables alike', () => {
    expect(substituteTemplate('{{baseUrl}}/content/member/{{memberNumber}}', { memberNumber: '10021' }, bindings)).toBe(
      'http://localhost:4310/content/member/10021',
    );
    expect(substituteTemplate('{{ baseUrl }}/x', {}, bindings)).toBe('http://localhost:4310/x');
  });

  it('names a reference it can’t fill', () => {
    expect(() => substituteTemplate('{{tenantHost}}/x', {}, bindings)).toThrow(/tenantHost/);
  });

  it('fills references deep inside a target, and gives the same answer twice', () => {
    const target = {
      description: 'the row for {{memberNumber}}',
      primary: { name: { mode: 'equals', value: '{{memberNumber}}' }, ordinal: 0, extra: null },
    };
    const expected = {
      description: 'the row for 10021',
      primary: { name: { mode: 'equals', value: '10021' }, ordinal: 0, extra: null },
    };
    expect(deepSubstitute(target, { memberNumber: '10021' }, bindings)).toEqual(expected);
    expect(deepSubstitute(['{{memberNumber}}', 'plain'], { memberNumber: '7' }, bindings)).toEqual(['7', 'plain']);
    expect(deepSubstitute(['{{memberNumber}}', 'plain'], { memberNumber: '7' }, bindings)).toEqual(['7', 'plain']);
  });
});

describe('value sources', () => {
  it('keeps a literal as it is, even one that looks like a template', () => {
    expect(resolveValue({ kind: 'literal', value: '{{notAReference}}' }, {}, bindings)).toBe('{{notAReference}}');
  });

  it('reads params and secrets, and complains when either is missing', () => {
    expect(resolveValue({ kind: 'param', name: 'memberNumber' }, { memberNumber: 10021 }, bindings)).toBe('10021');
    expect(() => resolveValue({ kind: 'param', name: 'ghost' }, {}, bindings)).toThrow(/not supplied/);
    expect(resolveValue({ kind: 'secret', ref: 'core_password' }, {}, bindings)).toBe('pw');
    expect(() => resolveValue({ kind: 'secret', ref: 'other' }, {}, bindings)).toThrow(/isn't available/);
  });
});

describe('transforms', () => {
  it('trims, and leaves a value alone without a transform', () => {
    expect(applyTransform('  a   b ')).toBe('  a   b ');
    expect(applyTransform('  a   b ', { kind: 'trim' })).toBe('a b');
  });

  it('turns a formatted amount into a number, but never turns "n/a" into zero', () => {
    expect(applyTransform('$4,182.55', { kind: 'currencyToNumber' })).toBe(4182.55);
    expect(applyTransform('-$12.00', { kind: 'currencyToNumber' })).toBe(-12);
    expect(() => applyTransform('n/a', { kind: 'currencyToNumber' })).toThrow(/couldn't read a number/);
    expect(() => applyTransform('—', { kind: 'currencyToNumber' })).toThrow(/couldn't read a number/);
  });

  it('captures a group, and complains when it finds nothing', () => {
    expect(applyTransform('CONF-SAV02-10021', { kind: 'regexCapture', pattern: 'CONF-(\\S+)', group: 1 })).toBe(
      'SAV02-10021',
    );
    expect(() => applyTransform('nothing', { kind: 'regexCapture', pattern: 'CONF-(\\S+)', group: 1 })).toThrow(
      /captured nothing/,
    );
  });
});

describe('checking arguments', () => {
  const specs: ParamSpec[] = [
    { name: 'memberNumber', type: 'string', required: true, description: 'x', sensitivity: 'internal', pattern: '^[0-9]{4,10}$' },
    { name: 'amount', type: 'number', required: false, description: 'x', sensitivity: 'internal' },
    { name: 'confirm', type: 'boolean', required: false, description: 'x', sensitivity: 'internal' },
    { name: 'product', type: 'enum', enumValues: ['SAV02', 'CD12'], required: false, description: 'x', sensitivity: 'internal' },
  ];

  it('accepts and types valid arguments', () => {
    expect(validateInputs(specs, { memberNumber: '10021', amount: '25.50', confirm: 'true', product: 'CD12' })).toEqual({
      ok: true,
      values: { memberNumber: '10021', amount: 25.5, confirm: true, product: 'CD12' },
    });
  });

  it('insists on required ones, treating an empty string as missing', () => {
    expect(validateInputs(specs, {})).toMatchObject({ ok: false });
    const blank = validateInputs(specs, { memberNumber: '' });
    expect(blank.ok === false && blank.issues[0]?.message).toContain('required');
    expect(validateInputs(specs, { memberNumber: '10021' })).toMatchObject({ ok: true });
  });

  it('rejects bad values of every type, and the pattern', () => {
    const bad = validateInputs(specs, { memberNumber: '10021', amount: 'lots', confirm: 'maybe', product: 'SAV99' });
    expect(bad.ok === false && bad.issues.map((issue) => issue.name)).toEqual(['amount', 'confirm', 'product']);
    const pattern = validateInputs(specs, { memberNumber: 'abcd' });
    expect(pattern.ok === false && pattern.issues[0]?.message).toContain('pattern');
  });

  it('rejects an argument the capability doesn’t take', () => {
    const extra = validateInputs(specs, { memberNumber: '10021', sneaky: 'x' });
    expect(extra.ok === false && extra.issues[0]?.message).toContain("isn't a parameter");
  });
});

describe('typing outputs', () => {
  const spec = (overrides: Partial<OutputSpec> = {}): OutputSpec => ({
    name: 'savingsBalance',
    type: 'number',
    description: 'x',
    sensitivity: 'internal',
    from: 'savingsBalance',
    required: true,
    ...overrides,
  });

  it('passes numbers through and parses formatted ones', () => {
    expect(coerceOutput(spec(), 4182.55)).toEqual({ ok: true, value: 4182.55 });
    expect(coerceOutput(spec(), '$4,182.55')).toEqual({ ok: true, value: 4182.55 });
  });

  it('refuses to call something a number when it isn’t one', () => {
    expect(coerceOutput(spec(), 'unavailable')).toMatchObject({ ok: false });
    expect(coerceOutput(spec(), '—')).toMatchObject({ ok: false });
  });

  it('handles missing required and optional outputs', () => {
    expect(coerceOutput(spec(), undefined)).toMatchObject({ ok: false });
    expect(coerceOutput(spec({ required: false }), undefined)).toEqual({ ok: true, value: '' });
  });

  it('stringifies and booleanises by declared type', () => {
    expect(coerceOutput(spec({ type: 'string' }), 4182.55)).toEqual({ ok: true, value: '4182.55' });
    expect(coerceOutput(spec({ type: 'boolean' }), 'yes')).toEqual({ ok: true, value: true });
  });
});

describe('secrets', () => {
  it('reads declared secrets and names every missing one', () => {
    expect(resolveSecrets([{ ref: 'pw', envVar: 'X_PW' }], { X_PW: 'hunter2' } as NodeJS.ProcessEnv)).toEqual({
      ok: true,
      secrets: { pw: 'hunter2' },
    });
    const missing = resolveSecrets(
      [
        { ref: 'user', envVar: 'X_USER' },
        { ref: 'pw', envVar: 'X_PW' },
      ],
      { X_USER: '' } as NodeJS.ProcessEnv,
    );
    expect(missing.ok === false && missing.missing).toEqual(['user (X_USER)', 'pw (X_PW)']);
  });
});

import { describe, expect, it } from 'vitest';
import { Allowlist, normaliseOrigin, routeMatches } from '../../src/policy/allowlist.js';
import { classifyAction, exceeds, maxRisk } from '../../src/policy/risk.js';
import { PolicyEngine } from '../../src/policy/engine.js';
import { Redactor } from '../../src/policy/redactor.js';
import { node } from '../helpers/nodes.js';
import type { Action } from '../../src/artifact/schema.js';

const allowlist = {
  origins: ['http://localhost:4310'],
  routes: ['/', '/login', '/console', '/content/**'],
  actions: ['navigate', 'click', 'type', 'read'],
};

const target = (description: string) => ({ description, primary: {} });
const click: Action = { kind: 'click', target: target('a button') };
const type: Action = { kind: 'type', target: target('a field'), value: { kind: 'literal', value: 'x' } };
const read: Action = { kind: 'read', target: target('a cell'), into: 'x', from: 'text' };

describe('route patterns', () => {
  it('matches literal, wildcard, named and rest segments', () => {
    expect(routeMatches('/content/member-search', '/content/member-search')).toBe(true);
    expect(routeMatches('/content/*', '/content/home')).toBe(true);
    expect(routeMatches('/content/*', '/content/member/10021')).toBe(false);
    expect(routeMatches('/content/**', '/content/member/10021/accounts')).toBe(true);
    expect(routeMatches('/content/member/:id', '/content/member/10021')).toBe(true);
    expect(routeMatches('/', '/')).toBe(true);
    expect(routeMatches('/login', '/')).toBe(false);
  });

  it('normalises an origin from a full URL', () => {
    expect(normaliseOrigin('http://localhost:4310/console?x=1')).toBe('http://localhost:4310');
    expect(normaliseOrigin('not a url/')).toBe('not a url');
  });
});

describe('allowlist', () => {
  const list = new Allowlist(allowlist);

  it('allows a listed action and refuses others', () => {
    expect(list.checkAction('click').allowed).toBe(true);
    const denied = list.checkAction('setChecked');
    expect(denied.allowed === false && denied.reason).toContain("isn't in the allowed list");
  });

  it('allows a listed origin and route', () => {
    expect(list.checkLocation('http://localhost:4310/content/member/10021/accounts').allowed).toBe(true);
  });

  it('refuses lookalike origins instead of suffix-matching them', () => {
    const bank = new Allowlist({ ...allowlist, origins: ['https://bank.com'] });
    expect(bank.checkLocation('https://bank.com.evil.net/login').allowed).toBe(false);
    expect(bank.checkLocation('https://evilbank.com/login').allowed).toBe(false);
    expect(bank.checkLocation('https://bank.com/login').allowed).toBe(true);
  });

  it('refuses an allowed origin on an unlisted path, and anything that isn’t a URL', () => {
    const denied = list.checkLocation('http://localhost:4310/admin/export');
    expect(denied.allowed === false && denied.reason).toContain('matches no allowed route');
    expect(list.checkLocation('javascript:alert(1)').allowed).toBe(false);
  });

  it('allows any path when no routes are configured', () => {
    expect(new Allowlist({ ...allowlist, routes: [] }).checkLocation('http://localhost:4310/x/y').allowed).toBe(true);
  });
});

describe('risk', () => {
  it('treats reads, waits and navigation as safe, and typing as sensitive', () => {
    expect(classifyAction(read)).toBe('safe');
    expect(classifyAction({ kind: 'waitFor', assertion: { kind: 'urlMatches', pattern: '/' }, timeoutMs: 10 })).toBe('safe');
    expect(classifyAction({ kind: 'navigate', url: { kind: 'literal', value: 'http://x/' } })).toBe('safe');
    expect(classifyAction(type)).toBe('sensitive');
    expect(classifyAction({ kind: 'setChecked', target: target('box'), checked: true })).toBe('sensitive');
  });

  it('treats Enter as a submit but other keys as navigation', () => {
    expect(classifyAction({ kind: 'pressKey', key: 'Enter' })).toBe('sensitive');
    expect(classifyAction({ kind: 'pressKey', key: 'Tab' })).toBe('safe');
  });

  it('reads a click’s risk off what the control says', () => {
    expect(classifyAction(click, node({ role: 'button', name: 'Post Account' }))).toBe('irreversible');
    expect(classifyAction(click, node({ role: 'button', name: 'Void Transaction' }))).toBe('irreversible');
    expect(classifyAction(click, node({ role: 'button', name: 'Transfer Funds' }))).toBe('irreversible');
    expect(classifyAction(click, node({ role: 'link', name: 'Accounts' }))).toBe('safe');
    expect(classifyAction(click, node({ role: 'button', name: 'Acknowledge' }))).toBe('safe');
  });

  it('errs upward for a click it can’t read', () => {
    expect(classifyAction(click)).toBe('sensitive');
    expect(classifyAction(click, node({ role: 'button', name: '' }))).toBe('sensitive');
    expect(classifyAction(click, node({ role: 'button', name: 'Recalculate Ledger' }))).toBe('sensitive');
  });

  it('orders the levels', () => {
    expect(maxRisk('safe', 'irreversible')).toBe('irreversible');
    expect(maxRisk('sensitive', 'safe')).toBe('sensitive');
    expect(exceeds('irreversible', 'sensitive')).toBe(true);
    expect(exceeds('sensitive', 'sensitive')).toBe(false);
  });
});

describe('policy engine', () => {
  const engine = new PolicyEngine({ allowlist, maxRiskWithoutApproval: 'sensitive' });

  it('allows a safe action inside the allowlist', () => {
    expect(
      engine.evaluate({ mode: 'replay', action: click, node: node({ role: 'link', name: 'Accounts' }), approvalState: 'approved' }),
    ).toMatchObject({ verdict: 'allow' });
  });

  it('blocks an action kind that isn’t allowed, before anything else', () => {
    expect(
      engine.evaluate({ mode: 'replay', action: { kind: 'setChecked', target: target('box'), checked: true } }),
    ).toMatchObject({ verdict: 'block', rule: 'allowlist.action' });
  });

  it('blocks navigation off the allowed origin', () => {
    expect(
      engine.evaluate({
        mode: 'discovery',
        action: { kind: 'navigate', url: { kind: 'literal', value: 'https://example.com/' } },
        targetUrl: 'https://example.com/',
      }),
    ).toMatchObject({ verdict: 'block', rule: 'allowlist.origin' });
  });

  it('uses the stricter of recorded and live risk', () => {
    const renamed = {
      mode: 'replay' as const,
      action: click,
      declaredRisk: 'safe' as const,
      node: node({ role: 'button', name: 'Post Account' }),
      approvalState: 'approved' as const,
    };
    expect(engine.effectiveRisk(renamed)).toBe('irreversible');
    expect(engine.evaluate(renamed)).toMatchObject({ verdict: 'needs_approval', rule: 'risk.ceiling' });
    expect(
      engine.effectiveRisk({
        mode: 'replay',
        action: click,
        declaredRisk: 'irreversible',
        node: node({ role: 'link', name: 'Accounts' }),
      }),
    ).toBe('irreversible');
  });

  it('lets an explicit confirmation clear the ceiling', () => {
    expect(
      engine.evaluate({
        mode: 'replay',
        action: click,
        node: node({ role: 'button', name: 'Post Account' }),
        approvalState: 'approved',
        riskyConfirmed: true,
      }),
    ).toMatchObject({ verdict: 'allow', risk: 'irreversible' });
  });

  it('won’t run a draft’s writing steps unattended, but will run its reads', () => {
    expect(engine.evaluate({ mode: 'replay', action: type, approvalState: 'draft' })).toMatchObject({
      verdict: 'needs_approval',
      rule: 'approval.draft',
    });
    expect(engine.evaluate({ mode: 'replay', action: read, approvalState: 'draft' })).toMatchObject({
      verdict: 'allow',
    });
  });

  it('exempts discovery from the draft rule', () => {
    expect(engine.evaluate({ mode: 'discovery', action: type })).toMatchObject({ verdict: 'allow' });
  });

  it('blocks a revoked capability outright', () => {
    expect(engine.evaluate({ mode: 'replay', action: read, approvalState: 'revoked' })).toMatchObject({
      verdict: 'block',
      rule: 'approval.revoked',
    });
  });

  it('catches the app wandering off-limits after a step', () => {
    expect(engine.checkObservedLocation('http://localhost:4310/content/home')).toMatchObject({ verdict: 'allow' });
    expect(engine.checkObservedLocation('https://phish.example/login')).toMatchObject({ verdict: 'block' });
  });
});

describe('redaction', () => {
  it('masks a known secret by name, but not one too short to mask safely', () => {
    expect(new Redactor({ secrets: { core_password: 'demo-pass-01' } }).redact('typed demo-pass-01 in')).toBe(
      'typed «secret:core_password» in',
    );
    expect(new Redactor({ secrets: { pin: '12' } }).redact('the 12 members')).toBe('the 12 members');
  });

  it('masks SSNs and email addresses', () => {
    expect(new Redactor().redact('SSN 412-55-9087 for teller@bank.example')).toBe('SSN «ssn» for «email»');
  });

  it('masks a real card number but not a lookalike reference', () => {
    const redactor = new Redactor();
    expect(redactor.redact('card 4111 1111 1111 1111 ok')).toBe('card «card» ok');
    expect(redactor.redact('ref 1234 5678 9012 3456 ok')).toContain('1234 5678 9012 3456');
  });

  it('masks long bare numbers but keeps currency and member numbers readable', () => {
    const redactor = new Redactor();
    expect(redactor.redact('acct 987654321098')).toBe('acct «digits»');
    expect(redactor.redact('balance $4,182.55')).toBe('balance $4,182.55');
    expect(redactor.redact('member 10021')).toBe('member 10021');
  });

  it('masks personal argument values and extra patterns', () => {
    expect(new Redactor({ piiValues: { memberName: 'Dolores Vance' } }).redact('record for Dolores Vance')).toBe(
      'record for «pii:memberName»',
    );
    expect(
      new Redactor({ extraPatterns: [{ label: 'routing', pattern: /\bRT-\d{4}\b/ }] }).redact('RT-1234 and RT-5678'),
    ).toBe('«routing» and «routing»');
  });

  it('walks nested values without touching non-strings', () => {
    expect(
      new Redactor({ secrets: { pw: 'hunter22' } }).redactDeep({ a: 'hunter22', b: [1, { c: 'hunter22' }], d: null, e: true }),
    ).toEqual({ a: '«secret:pw»', b: [1, { c: '«secret:pw»' }], d: null, e: true });
  });

  it('redacts every text field of an observation', () => {
    const observation = {
      observationId: 'o',
      capturedAt: 'now',
      url: 'http://localhost/',
      title: 't',
      frames: [],
      text: 'SSN 412-55-9087',
      screenFingerprint: 'f',
      nodes: [
        node({
          role: 'cell',
          name: '412-55-9087',
          value: '412-55-9087',
          text: '412-55-9087',
          nearbyText: '412-55-9087',
          table: { rowIndex: 1, columnIndex: 1, rowHeader: '412-55-9087', columnHeader: 'SSN' },
        }),
        node({ role: 'button', name: 'Search' }),
      ],
    };
    const clean = new Redactor().redactObservation(observation);
    expect(clean.text).toBe('SSN «ssn»');
    expect(clean.nodes[0]).toMatchObject({
      name: '«ssn»',
      value: '«ssn»',
      text: '«ssn»',
      nearbyText: '«ssn»',
      table: { rowHeader: '«ssn»', columnHeader: 'SSN' },
    });
    expect(clean.nodes[1]).toEqual(observation.nodes[1]);
  });
});

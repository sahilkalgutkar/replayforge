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

const target = (description: string): { description: string; primary: Record<string, never> } => ({
  description,
  primary: {},
});

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

  it('normalises an origin from a full URL or leaves a bare one alone', () => {
    expect(normaliseOrigin('http://localhost:4310/console?x=1')).toBe('http://localhost:4310');
    expect(normaliseOrigin('not a url/')).toBe('not a url');
  });
});

describe('allowlist', () => {
  const list = new Allowlist(allowlist);

  it('permits an allowed action and refuses an unlisted one', () => {
    expect(list.checkAction('click').allowed).toBe(true);
    const denied = list.checkAction('setChecked');
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toContain('not in the allowed action list');
  });

  it('permits an allowed origin and route', () => {
    expect(list.checkLocation('http://localhost:4310/content/member/10021/accounts').allowed).toBe(true);
  });

  it('refuses a lookalike origin rather than suffix-matching it', () => {
    const evil = new Allowlist({ ...allowlist, origins: ['https://bank.com'] });
    expect(evil.checkLocation('https://bank.com.evil.net/login').allowed).toBe(false);
    expect(evil.checkLocation('https://evilbank.com/login').allowed).toBe(false);
    expect(evil.checkLocation('https://bank.com/login').allowed).toBe(true);
  });

  it('refuses an allowed origin on an unlisted path', () => {
    const denied = list.checkLocation('http://localhost:4310/admin/export');
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toContain('matches no allowed route');
  });

  it('allows any path when no routes are configured', () => {
    const open = new Allowlist({ ...allowlist, routes: [] });
    expect(open.checkLocation('http://localhost:4310/anything/at/all').allowed).toBe(true);
  });

  it('refuses something that is not a URL at all', () => {
    expect(list.checkLocation('javascript:alert(1)').allowed).toBe(false);
  });
});

describe('risk classification', () => {
  const click = (): Action => ({ kind: 'click', target: target('a button') });

  it('treats reads, waits and navigation as safe', () => {
    expect(classifyAction({ kind: 'read', target: target('cell'), into: 'x', from: 'text' })).toBe('safe');
    expect(classifyAction({ kind: 'waitFor', assertion: { kind: 'urlMatches', pattern: '/' }, timeoutMs: 10 })).toBe('safe');
    expect(classifyAction({ kind: 'navigate', url: { kind: 'literal', value: 'http://x/' } })).toBe('safe');
  });

  it('treats typing and selecting as sensitive', () => {
    expect(
      classifyAction({ kind: 'type', target: target('field'), value: { kind: 'literal', value: 'x' } }),
    ).toBe('sensitive');
    expect(classifyAction({ kind: 'setChecked', target: target('box'), checked: true })).toBe('sensitive');
  });

  it('treats Enter as a submission but other keys as navigation', () => {
    expect(classifyAction({ kind: 'pressKey', key: 'Enter' })).toBe('sensitive');
    expect(classifyAction({ kind: 'pressKey', key: 'Tab' })).toBe('safe');
  });

  it('reads a click’s risk off what the control calls itself', () => {
    expect(classifyAction(click(), node({ role: 'button', name: 'Post Account' }))).toBe('irreversible');
    expect(classifyAction(click(), node({ role: 'button', name: 'Void Transaction' }))).toBe('irreversible');
    expect(classifyAction(click(), node({ role: 'button', name: 'Transfer Funds' }))).toBe('irreversible');
    expect(classifyAction(click(), node({ role: 'link', name: 'Accounts' }))).toBe('safe');
    expect(classifyAction(click(), node({ role: 'button', name: 'Acknowledge' }))).toBe('safe');
  });

  it('errs upward for a click it cannot read', () => {
    expect(classifyAction(click())).toBe('sensitive');
    expect(classifyAction(click(), node({ role: 'button', name: '' }))).toBe('sensitive');
    expect(classifyAction(click(), node({ role: 'button', name: 'Recalculate Ledger' }))).toBe('sensitive');
  });

  it('orders risk levels', () => {
    expect(maxRisk('safe', 'irreversible')).toBe('irreversible');
    expect(maxRisk('sensitive', 'safe')).toBe('sensitive');
    expect(exceeds('irreversible', 'sensitive')).toBe(true);
    expect(exceeds('sensitive', 'sensitive')).toBe(false);
  });
});

describe('policy engine', () => {
  const engine = new PolicyEngine({ allowlist, maxRiskWithoutApproval: 'sensitive' });
  const click: Action = { kind: 'click', target: target('a button') };

  it('allows a safe action inside the allowlist', () => {
    const decision = engine.evaluate({
      mode: 'replay',
      action: click,
      node: node({ role: 'link', name: 'Accounts' }),
      approvalState: 'approved',
    });
    expect(decision.verdict).toBe('allow');
  });

  it('blocks an action kind the allowlist omits, before anything else', () => {
    const decision = engine.evaluate({
      mode: 'replay',
      action: { kind: 'setChecked', target: target('box'), checked: true },
    });
    expect(decision).toMatchObject({ verdict: 'block', rule: 'allowlist.action' });
  });

  it('blocks navigation off the allowed origin', () => {
    const decision = engine.evaluate({
      mode: 'discovery',
      action: { kind: 'navigate', url: { kind: 'literal', value: 'https://example.com/' } },
      targetUrl: 'https://example.com/',
    });
    expect(decision).toMatchObject({ verdict: 'block', rule: 'allowlist.origin' });
  });

  it('takes the stricter of the recorded risk and what the live control says', () => {
    const context = {
      mode: 'replay' as const,
      action: click,
      declaredRisk: 'safe' as const,
      node: node({ role: 'button', name: 'Post Account' }),
      approvalState: 'approved' as const,
    };
    expect(engine.effectiveRisk(context)).toBe('irreversible');
    expect(engine.evaluate(context)).toMatchObject({ verdict: 'needs_approval', rule: 'risk.ceiling' });
  });

  it('takes the recorded risk when the live control looks harmless', () => {
    expect(
      engine.effectiveRisk({
        mode: 'replay',
        action: click,
        declaredRisk: 'irreversible',
        node: node({ role: 'link', name: 'Accounts' }),
      }),
    ).toBe('irreversible');
  });

  it('lets an explicit per-invocation confirmation clear the ceiling', () => {
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

  it('will not replay a draft capability’s writing steps unattended', () => {
    const decision = engine.evaluate({
      mode: 'replay',
      action: { kind: 'type', target: target('field'), value: { kind: 'literal', value: 'x' } },
      approvalState: 'draft',
    });
    expect(decision).toMatchObject({ verdict: 'needs_approval', rule: 'approval.draft' });
  });

  it('still replays a draft capability’s safe steps', () => {
    expect(
      engine.evaluate({
        mode: 'replay',
        action: { kind: 'read', target: target('cell'), into: 'x', from: 'text' },
        approvalState: 'draft',
      }),
    ).toMatchObject({ verdict: 'allow' });
  });

  it('exempts discovery from the approval rule, since discovery is what creates the approval', () => {
    expect(
      engine.evaluate({
        mode: 'discovery',
        action: { kind: 'type', target: target('field'), value: { kind: 'literal', value: 'x' } },
      }),
    ).toMatchObject({ verdict: 'allow' });
  });

  it('blocks a revoked capability outright', () => {
    expect(
      engine.evaluate({
        mode: 'replay',
        action: { kind: 'read', target: target('cell'), into: 'x', from: 'text' },
        approvalState: 'revoked',
      }),
    ).toMatchObject({ verdict: 'block', rule: 'approval.revoked' });
  });

  it('catches the app navigating itself somewhere off-limits after a step', () => {
    expect(engine.checkObservedLocation('http://localhost:4310/content/home')).toMatchObject({
      verdict: 'allow',
    });
    expect(engine.checkObservedLocation('https://phish.example/login')).toMatchObject({
      verdict: 'block',
    });
  });
});

describe('redaction', () => {
  it('masks a known secret value by its reference name', () => {
    const redactor = new Redactor({ secrets: { core_password: 'demo-pass-01' } });
    expect(redactor.redact('typed demo-pass-01 into the field')).toBe(
      'typed «secret:core_password» into the field',
    );
  });

  it('ignores a secret too short to mask safely', () => {
    const redactor = new Redactor({ secrets: { pin: '12' } });
    expect(redactor.redact('the 12 members')).toBe('the 12 members');
  });

  it('masks social security numbers and email addresses', () => {
    const redactor = new Redactor();
    expect(redactor.redact('SSN 412-55-9087 for teller@bank.example')).toBe(
      'SSN «ssn» for «email»',
    );
  });

  it('masks a payment card number but leaves a similar-length non-card alone', () => {
    const redactor = new Redactor();
    expect(redactor.redact('card 4111 1111 1111 1111 ok')).toBe('card «card» ok');
    expect(redactor.redact('ref 1234 5678 9012 3456 ok')).toContain('1234 5678 9012 3456');
  });

  it('masks a long bare digit run but leaves a formatted currency amount readable', () => {
    const redactor = new Redactor();
    expect(redactor.redact('acct 987654321098')).toBe('acct «digits»');
    expect(redactor.redact('balance $4,182.55')).toBe('balance $4,182.55');
    expect(redactor.redact('member 10021')).toBe('member 10021');
  });

  it('masks a PII parameter value the contract declared', () => {
    const redactor = new Redactor({ piiValues: { memberName: 'Dolores Vance' } });
    expect(redactor.redact('opened record for Dolores Vance')).toBe(
      'opened record for «pii:memberName»',
    );
  });

  it('applies caller-supplied extra patterns', () => {
    const redactor = new Redactor({
      extraPatterns: [{ label: 'routing', pattern: /\bRT-\d{4}\b/ }],
    });
    expect(redactor.redact('RT-1234 and RT-5678')).toBe('«routing» and «routing»');
  });

  it('walks nested structures without disturbing non-strings', () => {
    const redactor = new Redactor({ secrets: { pw: 'hunter22' } });
    expect(
      redactor.redactDeep({ a: 'hunter22', b: [1, { c: 'hunter22' }], d: null, e: true }),
    ).toEqual({ a: '«secret:pw»', b: [1, { c: '«secret:pw»' }], d: null, e: true });
  });

  it('redacts every text-bearing field of an observation', () => {
    const redactor = new Redactor();
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
      ],
    };
    const clean = redactor.redactObservation(observation);
    expect(clean.text).toBe('SSN «ssn»');
    expect(clean.nodes[0]).toMatchObject({
      name: '«ssn»',
      value: '«ssn»',
      text: '«ssn»',
      nearbyText: '«ssn»',
      table: { rowHeader: '«ssn»', columnHeader: 'SSN' },
    });
  });

  it('leaves a node with no optional text fields structurally unchanged', () => {
    const redactor = new Redactor();
    const plain = node({ role: 'button', name: 'Search' });
    const observation = {
      observationId: 'o',
      capturedAt: 'now',
      url: 'http://localhost/',
      title: '',
      frames: [],
      text: '',
      screenFingerprint: 'f',
      nodes: [plain],
    };
    expect(redactor.redactObservation(observation).nodes[0]).toEqual(plain);
  });
});

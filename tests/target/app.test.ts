import { afterEach, describe, expect, it } from 'vitest';
import { findMember, searchMembers } from '../../src/target/data.js';
import { profileFor } from '../../src/target/profiles.js';
import { arm, consume, isInjectionMode, type Injections } from '../../src/target/session.js';
import { signOn, startTarget, type TargetHarness } from '../helpers/target-server.js';

const running: TargetHarness[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.close()));
});

async function boot(tenantId = 'base'): Promise<TargetHarness> {
  const t = await startTarget({ tenantId, slowMs: 40 });
  running.push(t);
  return t;
}

async function searchFor(t: TargetHarness, query: string): Promise<string> {
  const form = await (await t.get('/content/member-search')).text();
  const res = await t.post('/content/member-search', { [t.fieldNameFrom(form, 'q')]: query });
  return res.text();
}

describe('sign on', () => {
  it('rejects bad credentials', async () => {
    const t = await boot();
    const page = await (await t.get('/')).text();
    const res = await t.post('/login', {
      [t.fieldNameFrom(page, 'user')]: 'teller01',
      [t.fieldNameFrom(page, 'pass')]: 'wrong',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign on failed');
    expect((await t.get('/console')).status).toBe(302);
  });

  it('signs on and serves the frameset', async () => {
    const t = await boot();
    await signOn(t);
    const body = await (await t.get('/console')).text();
    expect(body).toContain('<frameset');
    expect(body).toContain('name="mainFrame"');
    expect(await (await t.get('/content/home')).text()).toContain('Signed on as teller01');
  });

  it('generates different field names for different sessions', async () => {
    const a = await boot();
    const b = await boot();
    const nameA = a.fieldNameFrom(await (await a.get('/')).text(), 'user');
    const nameB = b.fieldNameFrom(await (await b.get('/')).text(), 'user');
    expect(nameA).not.toBe(nameB);
  });

  it('drops the session on sign off', async () => {
    const t = await boot();
    await signOn(t);
    expect((await t.get('/logout')).status).toBe(302);
    expect((await t.get('/nav')).status).toBe(401);
  });

  it('does not share sessions between tenants', async () => {
    const base = await boot('base');
    const northbay = await boot('northbay');
    await signOn(base);
    const res = await fetch(`${northbay.baseUrl}/console`, {
      headers: { cookie: base.cookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });
});

describe('member search and records', () => {
  it('asks for a value when the search is blank', async () => {
    const t = await boot();
    await signOn(t);
    expect(await searchFor(t, '  ')).toContain('Enter a member number to search');
  });

  it('finds a member and shows their savings balance', async () => {
    const t = await boot();
    await signOn(t);
    expect(await searchFor(t, '10021')).toContain('Dolores Vance');
    const accounts = await (await t.get('/content/member/10021/accounts')).text();
    expect(accounts).toContain('Regular Savings');
    expect(accounts).toContain('$4,182.55');
  });

  it('reports no records for an unknown number', async () => {
    const t = await boot();
    await signOn(t);
    expect(await searchFor(t, '99999')).toContain('No records found');
    expect(await (await t.get('/content/member/99999')).text()).toContain('No records found');
    expect(await (await t.get('/content/member/99999/accounts')).text()).toContain('No records found');
  });

  it('denies access to a restricted record', async () => {
    const t = await boot();
    await signOn(t);
    const res = await t.get('/content/member/10024');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Access denied');
  });

  it('serves the static screens', async () => {
    const t = await boot();
    await signOn(t);
    expect((await t.get('/img/spacer.gif')).status).toBe(200);
    expect(await (await t.get('/content/transactions')).text()).toContain('Transactions');
    expect(await (await t.get('/content/reports')).text()).toContain('No scheduled reports');
  });
});

describe('fault injection', () => {
  it('expires the session', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'session-timeout' });
    const res = await t.get('/content/home');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Your session has expired');
  });

  it('returns a server error once and then recovers', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'server-error' });
    expect((await t.get('/content/home')).status).toBe(500);
    expect((await t.get('/content/home')).status).toBe(200);
  });

  it('shows an interstitial that returns to the requested screen', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'interstitial' });
    const body = await (await t.get('/content/member-search')).text();
    expect(body).toContain('System Notice');
    expect(body).toContain('action="/content/member-search"');
  });

  it('hides a member that does exist', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'record-not-found' });
    expect(await searchFor(t, '10021')).toContain('No records found');
  });

  it('denies an otherwise readable record', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'permission-denied' });
    expect((await t.get('/content/member/10021/accounts')).status).toBe(403);
  });

  it('slows a request down', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'slow' });
    const started = Date.now();
    await t.get('/content/home');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('honours a count and can be cleared', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'server-error', count: '2' });
    expect((await t.get('/content/home')).status).toBe(500);
    await t.post('/_test/clear', {});
    expect((await t.get('/content/home')).status).toBe(200);
  });

  it('arms a fault for every session with scope=global', async () => {
    const t = await boot();
    await signOn(t);
    // Armed without the signed-in session's cookie, like a plain curl call.
    const armed = await fetch(`${t.baseUrl}/_test/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'mode=server-error&scope=global',
    });
    expect(await armed.json()).toMatchObject({ armed: 'server-error', scope: 'global' });
    expect((await t.get('/content/home')).status).toBe(500);
  });

  it('rejects an unknown mode and falls back to a count of one', async () => {
    const t = await boot();
    expect((await t.post('/_test/inject', { mode: 'teleport' })).status).toBe(400);
    const res = await t.post('/_test/inject', { mode: 'slow', count: 'lots' });
    expect(await res.json()).toMatchObject({ count: 1 });
  });
});

describe('open sub-account flow', () => {
  async function openForm(t: TargetHarness): Promise<(values: Record<string, string>) => Promise<string>> {
    await signOn(t);
    const form = await (await t.get('/content/member/10021/new-subaccount')).text();
    return async (values) => {
      const named = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [t.fieldNameFrom(form, k), v]),
      );
      return (await t.post('/content/member/10021/new-subaccount', named)).text();
    };
  }

  it('validates the form', async () => {
    const t = await boot();
    const submit = await openForm(t);
    expect(await submit({ product: '', nickname: 'H', deposit: '100' })).toContain('Product Code is required');
    expect(await submit({ product: 'SAV02', nickname: '', deposit: '100' })).toContain('Nickname is required');
    expect(await submit({ product: 'SAV02', nickname: 'H', deposit: 'abc' })).toContain('must be a number');
    expect(await submit({ product: 'SAV02', nickname: 'H', deposit: '' })).toContain('must be a number');
    expect(await submit({ product: 'SAV02', nickname: 'H', deposit: '10' })).toContain('at least $25.00');
  });

  it('shows an injected validation error', async () => {
    const t = await boot();
    const submit = await openForm(t);
    await t.post('/_test/inject', { mode: 'validation-error' });
    expect(await submit({ product: 'SAV02', nickname: 'Holiday', deposit: '100' })).toContain(
      'not available for this membership tier',
    );
  });

  it('reviews and posts the account', async () => {
    const t = await boot();
    const submit = await openForm(t);
    const review = await submit({ product: 'SAV02', nickname: 'Holiday Club', deposit: '100.00' });
    expect(review).toContain('Post Account');
    const token = review.match(/name="token" value="([^"]+)"/)?.[1] ?? '';
    const confirmed = await (await t.post('/content/member/10021/new-subaccount/confirm', { token })).text();
    expect(confirmed).toContain('Sub-account opened');
    expect(confirmed).toContain('SAV02-10021');
  });

  it('errors on an unknown draft token or member', async () => {
    const t = await boot();
    await signOn(t);
    expect((await t.post('/content/member/10021/new-subaccount/confirm', { token: 'nope' })).status).toBe(500);
    expect(await (await t.get('/content/member/99999/new-subaccount')).text()).toContain('No records found');
    expect(await (await t.post('/content/member/99999/new-subaccount', {})).text()).toContain('No records found');
  });

  it('needs the extra acknowledgement on the variant tenant', async () => {
    const t = await boot('northbay');
    const submit = await openForm(t);
    const review = await submit({ product: 'SAV03', nickname: 'Vacation', deposit: '50' });
    expect(review).toContain('BSA policy');
    const token = review.match(/name="token" value="([^"]+)"/)?.[1] ?? '';
    const denied = await (await t.post('/content/member/10021/new-subaccount/confirm', { token })).text();
    expect(denied).toContain('must acknowledge');
    const ok = await (await t.post('/content/member/10021/new-subaccount/confirm', { token, ack: '1' })).text();
    expect(ok).toContain('Sub-account opened');
  });
});

describe('tenant variant', () => {
  it('renames the member field and reorders the menu', async () => {
    const t = await boot('northbay');
    await signOn(t);
    expect(await (await t.get('/content/member-search')).text()).toContain('Customer ID');
    const nav = await (await t.get('/nav')).text();
    expect(nav.indexOf('Reports')).toBeLessThan(nav.indexOf('Customer Search'));
  });
});

describe('helpers', () => {
  it('finds members by number or name', () => {
    expect(findMember(' 10022 ')?.name).toBe('Marcus Ifill');
    expect(findMember('55555')).toBeUndefined();
    expect(searchMembers('raman').map((m) => m.memberNumber)).toEqual(['10023']);
    expect(searchMembers('   ')).toEqual([]);
  });

  it('rejects an unknown tenant', () => {
    expect(profileFor('base').productId).toBe('meridian-core');
    expect(() => profileFor('nope')).toThrow(/unknown tenant profile/);
  });

  it('counts down armed faults', () => {
    const injections: Injections = new Map();
    expect(consume(injections, 'slow')).toBe(false);
    arm(injections, 'slow', 2);
    expect(consume(injections, 'slow')).toBe(true);
    expect(consume(injections, 'slow')).toBe(true);
    expect(consume(injections, 'slow')).toBe(false);
    expect(isInjectionMode('slow')).toBe(true);
    expect(isInjectionMode('teleport')).toBe(false);
  });
});

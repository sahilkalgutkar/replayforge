import { afterEach, describe, expect, it } from 'vitest';
import { signOn, startTarget, type TargetHarness } from '../helpers/target-server.js';
import { findMember, searchMembers } from '../../src/target/data.js';
import { profileFor } from '../../src/target/profiles.js';
import { isInjectionMode } from '../../src/target/session.js';

let harness: TargetHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function boot(tenantId = 'base'): Promise<TargetHarness> {
  harness = await startTarget({ tenantId, slowMs: 40 });
  return harness;
}

describe('sign on', () => {
  it('rejects wrong credentials and keeps the session signed out', async () => {
    const t = await boot();
    const page = await (await t.get('/')).text();
    const res = await t.post('/login', {
      [t.fieldNameFrom(page, 'user')]: 'teller01',
      [t.fieldNameFrom(page, 'pass')]: 'wrong',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign on failed');

    const console_ = await t.get('/console');
    expect(console_.status).toBe(302);
  });

  it('signs on and serves the frameset', async () => {
    const t = await boot();
    await signOn(t);
    const body = await (await t.get('/console')).text();
    expect(body).toContain('<frameset');
    expect(body).toContain('name="mainFrame"');
  });

  it('scrambles field names per session so a recorded selector cannot survive', async () => {
    const a = await startTarget();
    const b = await startTarget();
    try {
      const nameA = a.fieldNameFrom(await (await a.get('/')).text(), 'user');
      const nameB = b.fieldNameFrom(await (await b.get('/')).text(), 'user');
      expect(nameA).not.toBe(nameB);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('drops the session on sign off', async () => {
    const t = await boot();
    await signOn(t);
    expect((await t.get('/logout')).status).toBe(302);
    expect((await t.get('/nav')).status).toBe(401);
  });
});

describe('member search', () => {
  it('asks for a value when the query is blank', async () => {
    const t = await boot();
    await signOn(t);
    const form = await (await t.get('/content/member-search')).text();
    const body = await (
      await t.post('/content/member-search', { [t.fieldNameFrom(form, 'q')]: '  ' })
    ).text();
    expect(body).toContain('Enter a member number to search');
  });

  it('returns a hit and reaches the savings balance', async () => {
    const t = await boot();
    await signOn(t);
    const form = await (await t.get('/content/member-search')).text();
    const results = await (
      await t.post('/content/member-search', { [t.fieldNameFrom(form, 'q')]: '10021' })
    ).text();
    expect(results).toContain('Dolores Vance');

    const accounts = await (await t.get('/content/member/10021/accounts')).text();
    expect(accounts).toContain('Regular Savings');
    expect(accounts).toContain('$4,182.55');
  });

  it('reports no records for an unknown number', async () => {
    const t = await boot();
    await signOn(t);
    const form = await (await t.get('/content/member-search')).text();
    const body = await (
      await t.post('/content/member-search', { [t.fieldNameFrom(form, 'q')]: '99999' })
    ).text();
    expect(body).toContain('No records found');
  });

  it('shows no records when a member id is not in the core', async () => {
    const t = await boot();
    await signOn(t);
    expect(await (await t.get('/content/member/99999')).text()).toContain('No records found');
    expect(await (await t.get('/content/member/99999/accounts')).text()).toContain('No records found');
  });

  it('denies a restricted record without an injected fault', async () => {
    const t = await boot();
    await signOn(t);
    const res = await t.get('/content/member/10024');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Access denied');
  });
});

describe('injected faults', () => {
  it('expires the session', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'session-timeout' });
    const res = await t.get('/content/home');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Your session has expired');
  });

  it('returns a server error once, then recovers', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'server-error' });
    expect((await t.get('/content/home')).status).toBe(500);
    expect((await t.get('/content/home')).status).toBe(200);
  });

  it('interposes an interstitial that returns to the requested screen', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'interstitial' });
    const body = await (await t.get('/content/member-search')).text();
    expect(body).toContain('System Notice');
    expect(body).toContain('action="/content/member-search"');
  });

  it('forces a not-found result for a member that does exist', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'record-not-found' });
    const form = await (await t.get('/content/member-search')).text();
    const body = await (
      await t.post('/content/member-search', { [t.fieldNameFrom(form, 'q')]: '10021' })
    ).text();
    expect(body).toContain('No records found');
  });

  it('denies permission on an otherwise readable record', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'permission-denied' });
    expect((await t.get('/content/member/10021/accounts')).status).toBe(403);
  });

  it('stalls a screen when slowness is armed', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'slow' });
    const started = Date.now();
    await t.get('/content/home');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('honours a repeat count and can be cleared', async () => {
    const t = await boot();
    await signOn(t);
    await t.post('/_test/inject', { mode: 'server-error', count: '2' });
    expect((await t.get('/content/home')).status).toBe(500);
    await t.post('/_test/clear', {});
    expect((await t.get('/content/home')).status).toBe(200);
  });

  it('rejects an unknown mode', async () => {
    const t = await boot();
    const res = await t.post('/_test/inject', { mode: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

describe('sub-account flow', () => {
  async function openForm(t: TargetHarness): Promise<string> {
    await signOn(t);
    return (await t.get('/content/member/10021/new-subaccount')).text();
  }

  it('rejects an empty product code', async () => {
    const t = await boot();
    const form = await openForm(t);
    const body = await (
      await t.post('/content/member/10021/new-subaccount', {
        [t.fieldNameFrom(form, 'product')]: '',
        [t.fieldNameFrom(form, 'nickname')]: 'Holiday',
        [t.fieldNameFrom(form, 'deposit')]: '100',
      })
    ).text();
    expect(body).toContain('Product Code is required');
  });

  it('rejects a missing nickname, a non-numeric deposit, and a deposit under the minimum', async () => {
    const t = await boot();
    const form = await openForm(t);
    const field = (l: string) => t.fieldNameFrom(form, l);
    const submit = (values: Record<string, string>) =>
      t.post('/content/member/10021/new-subaccount', values).then((r) => r.text());

    expect(
      await submit({ [field('product')]: 'SAV02', [field('nickname')]: '', [field('deposit')]: '100' }),
    ).toContain('Nickname is required');
    expect(
      await submit({ [field('product')]: 'SAV02', [field('nickname')]: 'H', [field('deposit')]: 'abc' }),
    ).toContain('must be a number');
    expect(
      await submit({ [field('product')]: 'SAV02', [field('nickname')]: 'H', [field('deposit')]: '10' }),
    ).toContain('at least $25.00');
  });

  it('surfaces an injected business validation error', async () => {
    const t = await boot();
    const form = await openForm(t);
    await t.post('/_test/inject', { mode: 'validation-error' });
    const body = await (
      await t.post('/content/member/10021/new-subaccount', {
        [t.fieldNameFrom(form, 'product')]: 'SAV02',
        [t.fieldNameFrom(form, 'nickname')]: 'Holiday',
        [t.fieldNameFrom(form, 'deposit')]: '100',
      })
    ).text();
    expect(body).toContain('not available for this membership tier');
  });

  it('reaches review and posts the account', async () => {
    const t = await boot();
    const form = await openForm(t);
    const review = await (
      await t.post('/content/member/10021/new-subaccount', {
        [t.fieldNameFrom(form, 'product')]: 'SAV02',
        [t.fieldNameFrom(form, 'nickname')]: 'Holiday Club',
        [t.fieldNameFrom(form, 'deposit')]: '100.00',
      })
    ).text();
    expect(review).toContain('Post Account');
    const token = review.match(/name="token" value="([^"]+)"/)?.[1] ?? '';
    const confirmed = await (
      await t.post('/content/member/10021/new-subaccount/confirm', { token })
    ).text();
    expect(confirmed).toContain('Sub-account opened');
    expect(confirmed).toContain('SAV02-10021');
  });

  it('errors on an unknown draft token', async () => {
    const t = await boot();
    await signOn(t);
    const res = await t.post('/content/member/10021/new-subaccount/confirm', { token: 'nope' });
    expect(res.status).toBe(500);
  });

  it('shows no records when opening a sub-account for an unknown member', async () => {
    const t = await boot();
    await signOn(t);
    expect(await (await t.get('/content/member/99999/new-subaccount')).text()).toContain(
      'No records found',
    );
    expect(
      await (await t.post('/content/member/99999/new-subaccount', {})).text(),
    ).toContain('No records found');
  });

  it('requires the variant tenant extra acknowledgement before posting', async () => {
    const t = await boot('northbay');
    const form = await openForm(t);
    const review = await (
      await t.post('/content/member/10021/new-subaccount', {
        [t.fieldNameFrom(form, 'product')]: 'SAV03',
        [t.fieldNameFrom(form, 'nickname')]: 'Vacation',
        [t.fieldNameFrom(form, 'deposit')]: '50',
      })
    ).text();
    const token = review.match(/name="token" value="([^"]+)"/)?.[1] ?? '';
    expect(review).toContain('BSA policy');

    const denied = await (
      await t.post('/content/member/10021/new-subaccount/confirm', { token })
    ).text();
    expect(denied).toContain('must acknowledge');

    const ok = await (
      await t.post('/content/member/10021/new-subaccount/confirm', { token, ack: '1' })
    ).text();
    expect(ok).toContain('Sub-account opened');
  });
});

describe('tenant variant chrome', () => {
  it('renames the member field and reorders the menu', async () => {
    const t = await boot('northbay');
    await signOn(t);
    expect(await (await t.get('/content/member-search')).text()).toContain('Customer ID');
    const nav = await (await t.get('/nav')).text();
    expect(nav.indexOf('Reports')).toBeLessThan(nav.indexOf('Customer Search'));
  });

  it('serves the static frame chrome and stub screens', async () => {
    const t = await boot();
    await signOn(t);
    expect((await t.get('/img/spacer.gif')).status).toBe(200);
    expect(await (await t.get('/content/transactions')).text()).toContain('Transactions');
    expect(await (await t.get('/content/reports')).text()).toContain('No scheduled reports');
    expect(await (await t.get('/content/home')).text()).toContain('Signed on as teller01');
  });
});

describe('fixtures and profiles', () => {
  it('looks members up by number and by name fragment', () => {
    expect(findMember(' 10022 ')?.name).toBe('Marcus Ifill');
    expect(findMember('55555')).toBeUndefined();
    expect(searchMembers('raman').map((m) => m.memberNumber)).toEqual(['10023']);
    expect(searchMembers('   ')).toEqual([]);
  });

  it('rejects an unknown tenant loudly', () => {
    expect(profileFor('base').productId).toBe('meridian-core');
    expect(() => profileFor('nope')).toThrow(/unknown tenant profile/);
  });

  it('validates injection mode names', () => {
    expect(isInjectionMode('slow')).toBe(true);
    expect(isInjectionMode('teleport')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { resolveTarget } from '../../src/surface/resolve.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { act, byName, byNearby, signOnInBrowser } from '../helpers/browser-flow.js';

let target: TargetHarness;
let surface: BrowserSurface;

beforeEach(async () => {
  target = await startTarget({ slowMs: 50 });
  surface = await BrowserSurface.launch({ targetId: 'test' });
});

afterEach(async () => {
  await surface.dispose();
  await target.close();
});

describe('perception', () => {
  it('infers a label for an input the markup never named', async () => {
    await surface.perform({ kind: 'navigate', url: `${target.baseUrl}/` });
    const observation = await surface.observe();
    const field = observation.nodes.find((n) => n.nearbyText === 'User ID');
    expect(field?.role).toBe('textbox');
    expect(field?.name).toBe('');
  });

  it('flattens a frameset into frame-qualified nodes', async () => {
    const observation = await signOnInBrowser(surface, target.baseUrl);
    expect(observation.frames.map((f) => f.path.join('/')).sort()).toEqual([
      '',
      'mainFrame',
      'navFrame',
    ]);
    const navLink = observation.nodes.find(
      (n) => n.role === 'link' && n.name === 'Member Search',
    );
    expect(navLink?.framePath).toEqual(['navFrame']);
  });

  it('waits for a form submission to land before reporting the screen', async () => {
    await signOnInBrowser(surface, target.baseUrl);
    await act(surface, byName('link', 'Member Search'), (ref) => ({ kind: 'click', ref }));
    await act(surface, byNearby('textbox', 'Member Number'), (ref) => ({
      kind: 'fill',
      ref,
      text: '10021',
    }));
    const results = await act(surface, byName('button', 'Search'), (ref) => ({ kind: 'click', ref }));
    expect(results.text).toContain('Dolores Vance');
  });

  it('addresses a grid cell by row key and column header', async () => {
    await signOnInBrowser(surface, target.baseUrl);
    await surface.perform({ kind: 'navigate', url: `${target.baseUrl}/content/member/10021/accounts` });
    const observation = await surface.observe();
    const resolution = resolveTarget(
      {
        description: 'current balance of the Regular Savings row',
        primary: {
          role: 'cell',
          inTable: {
            rowContains: { mode: 'equals', value: 'Regular Savings' },
            column: 'Current Balance',
          },
        },
      },
      observation,
    );
    expect(resolution.ok && resolution.node.text).toBe('$4,182.55');
  });

  it('reports the most severe status across the frames making up a screen', async () => {
    await signOnInBrowser(surface, target.baseUrl);
    await act(surface, byName('link', 'Member Search'), (ref) => ({ kind: 'click', ref }));
    await act(surface, byNearby('textbox', 'Member Number'), (ref) => ({
      kind: 'fill',
      ref,
      text: '10024',
    }));
    await act(surface, byName('button', 'Search'), (ref) => ({ kind: 'click', ref }));
    const denied = await act(surface, byName('link', '10024'), (ref) => ({ kind: 'click', ref }));
    // The frameset shell answered 200; the content frame inside it answered 403.
    expect(denied.httpStatus).toBe(403);
    expect(denied.text).toContain('Access denied');
  });

  it('changes the fingerprint between two different screens', async () => {
    const home = await signOnInBrowser(surface, target.baseUrl);
    const search = await act(surface, byName('link', 'Member Search'), (ref) => ({
      kind: 'click',
      ref,
    }));
    expect(search.screenFingerprint).not.toBe(home.screenFingerprint);
  });
});

describe('acting', () => {
  it('selects an option by its visible label and checks a box', async () => {
    await signOnInBrowser(surface, target.baseUrl);
    await surface.perform({
      kind: 'navigate',
      url: `${target.baseUrl}/content/member/10021/new-subaccount`,
    });
    const after = await act(surface, byNearby('combobox', 'Product Code'), (ref) => ({
      kind: 'select',
      ref,
      value: 'SAV02 Holiday Club',
    }));
    const product = after.nodes.find((n) => n.role === 'combobox');
    expect(product?.value).toBe('SAV02 Holiday Club');
  });

  it('submits with a key press', async () => {
    await signOnInBrowser(surface, target.baseUrl);
    await act(surface, byName('link', 'Member Search'), (ref) => ({ kind: 'click', ref }));
    const observation = await act(surface, byNearby('textbox', 'Member Number'), (ref) => ({
      kind: 'fill',
      ref,
      text: '10022',
    }));
    const field = resolveTarget(byNearby('textbox', 'Member Number'), observation);
    expect(field.ok).toBe(true);
    if (field.ok) await surface.perform({ kind: 'press', ref: field.node.ref, key: 'Enter' });
    const results = await surface.observe();
    expect(results.text).toContain('Marcus Ifill');
  });

  it('refuses a ref from a frame that no longer exists', async () => {
    await surface.perform({ kind: 'navigate', url: `${target.baseUrl}/` });
    await surface.observe();
    await expect(surface.perform({ kind: 'click', ref: 'ghostFrame::3' })).rejects.toThrow(
      /no live frame/,
    );
  });

  it('waits on demand and reports its location', async () => {
    await surface.perform({ kind: 'navigate', url: `${target.baseUrl}/` });
    await surface.perform({ kind: 'waitForIdle', timeoutMs: 500 });
    expect(await surface.location()).toContain('/');
    expect((await surface.screenshot()).byteLength).toBeGreaterThan(0);
  });

  it('is safe to dispose twice', async () => {
    await surface.dispose();
    await expect(surface.dispose()).resolves.toBeUndefined();
  });
});

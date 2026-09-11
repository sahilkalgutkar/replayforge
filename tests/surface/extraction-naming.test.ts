import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import type { UiNode } from '../../src/surface/types.js';

/**
 * The extractor in src/surface/browser/extract.ts is stringified into the page
 * and runs in the browser, so Node's v8 coverage provider cannot instrument it
 * and it is excluded from the coverage report in vitest.config.ts. These tests
 * are what actually verify it:
 * one case per naming strategy it implements, asserted through the same
 * observe() the replay engine uses.
 */

let surface: BrowserSurface;

beforeEach(async () => {
  surface = await BrowserSurface.launch({ targetId: 'naming' });
});

afterEach(async () => {
  await surface.dispose();
});

async function nodesFor(body: string): Promise<readonly UiNode[]> {
  await surface.perform({
    kind: 'navigate',
    url: `data:text/html,${encodeURIComponent(`<html><body>${body}</body></html>`)}`,
  });
  return (await surface.observe()).nodes;
}

const find = (nodes: readonly UiNode[], role: string, predicate: (n: UiNode) => boolean) =>
  nodes.find((n) => n.role === role && predicate(n));

describe('accessible name strategies', () => {
  it('prefers aria-label', async () => {
    const nodes = await nodesFor('<input aria-label="Member Number" title="ignored">');
    expect(find(nodes, 'textbox', () => true)?.name).toBe('Member Number');
  });

  it('follows aria-labelledby across several ids', async () => {
    const nodes = await nodesFor(
      '<span id="a">Opening</span><span id="b">Deposit</span><input aria-labelledby="a b">',
    );
    expect(find(nodes, 'textbox', () => true)?.name).toBe('Opening Deposit');
  });

  it('uses the value of a submit button', async () => {
    const nodes = await nodesFor('<input type="submit" value="Post Account">');
    expect(find(nodes, 'button', () => true)?.name).toBe('Post Account');
  });

  it('uses the alt text of an image button', async () => {
    const nodes = await nodesFor('<input type="image" alt="Search" src="/x.gif">');
    expect(find(nodes, 'button', () => true)?.name).toBe('Search');
  });

  it('follows label[for] and strips the trailing colon', async () => {
    const nodes = await nodesFor('<label for="q">Member Number:</label><input id="q">');
    expect(find(nodes, 'textbox', () => true)?.name).toBe('Member Number');
  });

  it('falls back to a wrapping label', async () => {
    const nodes = await nodesFor('<label>Nickname <input></label>');
    expect(find(nodes, 'textbox', () => true)?.name).toBe('Nickname');
  });

  it('falls back to the title attribute', async () => {
    const nodes = await nodesFor('<input title="Opening Deposit">');
    expect(find(nodes, 'textbox', () => true)?.name).toBe('Opening Deposit');
  });

  it('names links and headings from their text', async () => {
    const nodes = await nodesFor('<h2>Review</h2><a href="/x">Accounts</a>');
    expect(find(nodes, 'heading', () => true)?.name).toBe('Review');
    expect(find(nodes, 'link', () => true)?.name).toBe('Accounts');
  });

  it('honours an explicit role attribute', async () => {
    const nodes = await nodesFor('<div role="alert">Session expired</div>');
    expect(find(nodes, 'alert', () => true)?.name).toBe('');
  });
});

describe('nearby-text inference', () => {
  it('reads the previous cell in the same row', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Member Number</td><td><input></td></tr></table>',
    );
    expect(find(nodes, 'textbox', () => true)?.nearbyText).toBe('Member Number');
  });

  it('skips an empty previous cell to reach the labelled one', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Nickname</td><td></td><td><input></td></tr></table>',
    );
    expect(find(nodes, 'textbox', () => true)?.nearbyText).toBe('Nickname');
  });

  it('falls back to the column header when the row has no label cell', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Amount</td></tr><tr><td><input></td></tr></table>',
    );
    expect(find(nodes, 'textbox', () => true)?.nearbyText).toBe('Amount');
  });

  it('reads preceding text when there is no table at all', async () => {
    const nodes = await nodesFor('<div>Opening Deposit: <input></div>');
    expect(find(nodes, 'textbox', () => true)?.nearbyText).toBe('Opening Deposit');
  });

  it('infers a label for a checkbox as well as a text field', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Acknowledged</td><td><input type="checkbox"></td></tr></table>',
    );
    expect(find(nodes, 'checkbox', () => true)?.nearbyText).toBe('Acknowledged');
  });

  it('does not spend inference on a control that already has a name', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Ignore me</td><td><input aria-label="Real Name"></td></tr></table>',
    );
    const field = find(nodes, 'textbox', () => true);
    expect(field?.name).toBe('Real Name');
    expect(field?.nearbyText).toBeUndefined();
  });
});

describe('values, state and structure', () => {
  it('reports checkbox state as a value', async () => {
    const nodes = await nodesFor('<input type="checkbox" checked aria-label="Ack">');
    expect(find(nodes, 'checkbox', () => true)?.value).toBe('checked');
  });

  it('reports the selected option label of a combobox', async () => {
    const nodes = await nodesFor(
      '<select aria-label="Product"><option>SAV02 Holiday</option><option selected>CD12 Certificate</option></select>',
    );
    expect(find(nodes, 'combobox', () => true)?.value).toBe('CD12 Certificate');
  });

  it('reports textarea content', async () => {
    const nodes = await nodesFor('<textarea aria-label="Memo">note text</textarea>');
    expect(find(nodes, 'textbox', () => true)?.value).toBe('note text');
  });

  it('marks a disabled control as not enabled', async () => {
    const nodes = await nodesFor('<button disabled>Post</button>');
    expect(find(nodes, 'button', () => true)?.enabled).toBe(false);
  });

  it('omits hidden inputs and display:none subtrees entirely', async () => {
    const nodes = await nodesFor(
      '<input type="hidden" name="token" value="x"><div style="display:none"><button>Ghost</button></div><button>Real</button>',
    );
    expect(nodes.filter((n) => n.role === 'button').map((n) => n.name)).toEqual(['Real']);
    expect(nodes.some((n) => n.value === 'x')).toBe(false);
  });

  it('emits only leaf cells, not the layout tables wrapping them', async () => {
    const nodes = await nodesFor(
      '<table><tr><td><table><tr><td>Inner</td></tr></table></td></tr></table>',
    );
    expect(nodes.filter((n) => n.role === 'cell').map((n) => n.name)).toEqual(['Inner']);
  });

  it('records row and column coordinates with header text', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Type</td><td>Balance</td></tr><tr><td>Regular Savings</td><td>$4,182.55</td></tr></table>',
    );
    const cell = find(nodes, 'cell', (n) => n.name === '$4,182.55');
    expect(cell?.table).toEqual({
      rowIndex: 1,
      columnIndex: 1,
      columnHeader: 'Balance',
      rowHeader: 'Regular Savings',
    });
  });

  it('treats a collapsed cell that still has text as present', async () => {
    const nodes = await nodesFor(
      '<table style="width:0"><tr><td style="width:0;height:0">Ref CORE-500</td></tr></table>',
    );
    expect(nodes.some((n) => n.name === 'Ref CORE-500')).toBe(true);
  });

  it('drops refs from the previous observation so a stale handle cannot resolve', async () => {
    const first = await nodesFor('<button>One</button>');
    const second = await surface.observe();
    expect(second.nodes.map((n) => n.ref)).toEqual(first.map((n) => n.ref));
    await expect(surface.perform({ kind: 'click', ref: 'gone::9' })).rejects.toThrow();
  });
});

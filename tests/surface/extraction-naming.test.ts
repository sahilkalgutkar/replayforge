import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import type { UiNode } from '../../src/surface/types.js';

// The extractor runs inside the page, so coverage tooling in Node can't see it.
// These are what actually check it: one case per naming rule it implements,
// asserted through the same observe() everything else uses.

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

const of = (nodes: readonly UiNode[], role: string): UiNode | undefined =>
  nodes.find((n) => n.role === role);

describe('working out a control’s name', () => {
  it('prefers aria-label', async () => {
    expect(of(await nodesFor('<input aria-label="Member Number" title="ignored">'), 'textbox')?.name).toBe(
      'Member Number',
    );
  });

  it('follows aria-labelledby across several ids', async () => {
    const nodes = await nodesFor('<span id="a">Opening</span><span id="b">Deposit</span><input aria-labelledby="a b">');
    expect(of(nodes, 'textbox')?.name).toBe('Opening Deposit');
  });

  it('uses the value of a submit button and the alt of an image button', async () => {
    expect(of(await nodesFor('<input type="submit" value="Post Account">'), 'button')?.name).toBe('Post Account');
    expect(of(await nodesFor('<input type="image" alt="Search" src="/x.gif">'), 'button')?.name).toBe('Search');
  });

  it('follows a label and drops the trailing colon', async () => {
    expect(of(await nodesFor('<label for="q">Member Number:</label><input id="q">'), 'textbox')?.name).toBe(
      'Member Number',
    );
    expect(of(await nodesFor('<label>Nickname <input></label>'), 'textbox')?.name).toBe('Nickname');
  });

  it('falls back to the title attribute', async () => {
    expect(of(await nodesFor('<input title="Opening Deposit">'), 'textbox')?.name).toBe('Opening Deposit');
  });

  it('names links and headings from their text', async () => {
    const nodes = await nodesFor('<h2>Review</h2><a href="/x">Accounts</a>');
    expect(of(nodes, 'heading')?.name).toBe('Review');
    expect(of(nodes, 'link')?.name).toBe('Accounts');
  });

  it('honours an explicit role attribute', async () => {
    expect(of(await nodesFor('<div role="alert">Session expired</div>'), 'alert')?.name).toBe('');
  });
});

describe('inferring a label from the layout', () => {
  it('reads the previous cell in the row', async () => {
    const nodes = await nodesFor('<table><tr><td>Member Number</td><td><input></td></tr></table>');
    expect(of(nodes, 'textbox')?.nearbyText).toBe('Member Number');
  });

  it('skips an empty cell to reach the labelled one', async () => {
    const nodes = await nodesFor('<table><tr><td>Nickname</td><td></td><td><input></td></tr></table>');
    expect(of(nodes, 'textbox')?.nearbyText).toBe('Nickname');
  });

  it('falls back to the column header when the row has no label cell', async () => {
    const nodes = await nodesFor('<table><tr><td>Amount</td></tr><tr><td><input></td></tr></table>');
    expect(of(nodes, 'textbox')?.nearbyText).toBe('Amount');
  });

  it('reads preceding text when there is no table', async () => {
    expect(of(await nodesFor('<div>Opening Deposit: <input></div>'), 'textbox')?.nearbyText).toBe(
      'Opening Deposit',
    );
  });

  it('works for a checkbox too', async () => {
    const nodes = await nodesFor('<table><tr><td>Acknowledged</td><td><input type="checkbox"></td></tr></table>');
    expect(of(nodes, 'checkbox')?.nearbyText).toBe('Acknowledged');
  });

  it('skips the inference when the control already has a name', async () => {
    const nodes = await nodesFor('<table><tr><td>Ignore me</td><td><input aria-label="Real Name"></td></tr></table>');
    expect(of(nodes, 'textbox')?.name).toBe('Real Name');
    expect(of(nodes, 'textbox')?.nearbyText).toBeUndefined();
  });
});

describe('values, state and structure', () => {
  it('reports checkbox state, the selected option and textarea content', async () => {
    expect(of(await nodesFor('<input type="checkbox" checked aria-label="Ack">'), 'checkbox')?.value).toBe('checked');
    const select = await nodesFor(
      '<select aria-label="Product"><option>SAV02 Holiday</option><option selected>CD12 Certificate</option></select>',
    );
    expect(of(select, 'combobox')?.value).toBe('CD12 Certificate');
    expect(of(await nodesFor('<textarea aria-label="Memo">note text</textarea>'), 'textbox')?.value).toBe('note text');
  });

  it('marks a disabled control as not enabled', async () => {
    expect(of(await nodesFor('<button disabled>Post</button>'), 'button')?.enabled).toBe(false);
  });

  it('leaves out hidden inputs and anything inside a hidden container', async () => {
    const nodes = await nodesFor(
      '<input type="hidden" name="token" value="x"><div style="display:none"><button>Ghost</button></div><button>Real</button>',
    );
    expect(nodes.filter((n) => n.role === 'button').map((n) => n.name)).toEqual(['Real']);
    expect(nodes.some((n) => n.value === 'x')).toBe(false);
  });

  it('emits leaf cells, not the layout tables wrapping them', async () => {
    const nodes = await nodesFor('<table><tr><td><table><tr><td>Inner</td></tr></table></td></tr></table>');
    expect(nodes.filter((n) => n.role === 'cell').map((n) => n.name)).toEqual(['Inner']);
  });

  it('records row and column coordinates with their header text', async () => {
    const nodes = await nodesFor(
      '<table><tr><td>Type</td><td>Balance</td></tr><tr><td>Regular Savings</td><td>$4,182.55</td></tr></table>',
    );
    expect(nodes.find((n) => n.name === '$4,182.55')?.table).toEqual({
      rowIndex: 1,
      columnIndex: 1,
      columnHeader: 'Balance',
      rowHeader: 'Regular Savings',
    });
  });

  it('keeps a collapsed cell that still has text', async () => {
    const nodes = await nodesFor(
      '<table style="width:0"><tr><td style="width:0;height:0">Ref CORE-500</td></tr></table>',
    );
    expect(nodes.some((n) => n.name === 'Ref CORE-500')).toBe(true);
  });

  it('drops refs from the previous observation', async () => {
    const first = await nodesFor('<button>One</button>');
    const second = await surface.observe();
    expect(second.nodes.map((n) => n.ref)).toEqual(first.map((n) => n.ref));
    await expect(surface.perform({ kind: 'click', ref: 'gone::9' })).rejects.toThrow();
  });
});

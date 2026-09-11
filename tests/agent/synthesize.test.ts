import { describe, expect, it } from 'vitest';
import {
  canonicalisePath,
  deriveCheckpoint,
  deriveTarget,
  type DiscoveredInput,
} from '../../src/agent/synthesize.js';
import { renderScreen } from '../../src/agent/prompt.js';
import { Redactor } from '../../src/policy/redactor.js';
import { fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from '../helpers/nodes.js';
import type { Observation, UiNode } from '../../src/surface/types.js';

function screen(nodes: UiNode[], overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'o',
    capturedAt: '2026-01-01T00:00:00.000Z',
    url: 'http://app.test/content/member/10021/accounts',
    title: '',
    frames: [{ path: [], url: 'http://app.test/x' }],
    nodes,
    text: '',
    screenFingerprint: fingerprintNodes(nodes),
    ...overrides,
  };
}

const memberNumber: DiscoveredInput = {
  name: 'memberNumber',
  type: 'string',
  description: 'x',
  sensitivity: 'internal',
  value: '10021',
};

describe('target derivation', () => {
  it('prefers an accessible name for a control it will act on', () => {
    const button = node({ role: 'button', name: 'Search', framePath: ['mainFrame'] });
    const target = deriveTarget(button, screen([button]), [], 'the search button');
    expect(target.primary).toEqual({
      role: 'button',
      name: { mode: 'equals', value: 'Search' },
      framePath: ['mainFrame'],
    });
  });

  it('replaces a name that came from an argument with its parameter reference', () => {
    const link = node({ role: 'link', name: '10021' });
    const target = deriveTarget(link, screen([link]), [memberNumber], 'the result row');
    expect(target.primary.name?.value).toBe('{{memberNumber}}');
  });

  it('refuses to target an extraction by the value it is reading', () => {
    const balance = node({
      role: 'cell',
      name: '$4,182.55',
      text: '$4,182.55',
      table: { rowIndex: 1, columnIndex: 3, rowHeader: 'Regular Savings', columnHeader: 'Current Balance' },
    });
    const target = deriveTarget(balance, screen([balance]), [], 'the balance', 'read');
    expect(target.primary.inTable).toEqual({
      rowContains: { mode: 'equals', value: 'Regular Savings' },
      column: 'Current Balance',
    });
    expect(target.primary.name).toBeUndefined();
  });

  it('uses an inferred label when the markup named nothing', () => {
    const field = node({ role: 'textbox', editable: true, nearbyText: 'Member Number' });
    const target = deriveTarget(field, screen([field]), [], 'the member number field');
    expect(target.primary).toMatchObject({
      role: 'textbox',
      editable: true,
      nearbyText: { mode: 'equals', value: 'Member Number' },
    });
  });

  it('records a fallback ladder when more than one matcher identifies the control', () => {
    const cell = node({
      role: 'cell',
      name: 'Open',
      text: 'Open',
      table: { rowIndex: 1, columnIndex: 2, rowHeader: 'Regular Savings', columnHeader: 'Status' },
    });
    const target = deriveTarget(cell, screen([cell]), [], 'the status cell');
    expect(target.fallbacks?.length).toBeGreaterThan(0);
    expect(target.fallbacks?.length).toBeLessThanOrEqual(2);
  });

  it('ignores a row key that came from a layout table rather than a data grid', () => {
    const link = node({
      role: 'link',
      name: 'Back to search',
      table: {
        rowIndex: 0,
        columnIndex: 0,
        rowHeader:
          'Member 10021 Dolores Vance Profile Accounts Account Type Account Number Status Current Balance',
      },
    });
    const target = deriveTarget(link, screen([link]), [], 'the back link');
    const usesTable = [target.primary, ...(target.fallbacks ?? [])].some((m) => m.inTable);
    expect(usesTable).toBe(false);
  });

  it('falls back to position, and says so, when nothing identifies the control', () => {
    const a = node({ role: 'cell', name: '' });
    const b = node({ role: 'cell', name: '' });
    const target = deriveTarget(b, screen([a, b]), [], 'the second blank cell');
    expect(target.primary.ordinal).toBe(1);
    expect(target.description).toContain('least durable targeting');
  });
});

describe('checkpoint derivation', () => {
  it('prefers a newly present control named after the caller’s argument', () => {
    const before = screen([node({ role: 'button', name: 'Search' })]);
    const after = screen([
      node({ role: 'button', name: 'Search' }),
      node({ role: 'link', name: '10021' }),
      node({ role: 'link', name: 'Back to search' }),
    ]);
    expect(deriveCheckpoint(before, after, [memberNumber])).toEqual({
      kind: 'textPresent',
      text: { mode: 'contains', value: '{{memberNumber}}' },
    });
  });

  it('falls back to any newly present labelled control', () => {
    const before = screen([]);
    const after = screen([node({ role: 'link', name: 'Member Search' })]);
    expect(deriveCheckpoint(before, after, [])).toEqual({
      kind: 'textPresent',
      text: { mode: 'contains', value: 'Member Search' },
    });
  });

  it('falls back to a newly present table label', () => {
    const before = screen([]);
    const after = screen([node({ role: 'columnheader', name: 'Current Balance' })]);
    expect(deriveCheckpoint(before, after, [])?.kind).toBe('textPresent');
  });

  it('falls back to the new location when the screen gained nothing named', () => {
    const before = screen([], { url: 'http://app.test/a' });
    const after = screen([], { url: 'http://app.test/content/member/10021/accounts' });
    const checkpoint = deriveCheckpoint(before, after, [memberNumber]);
    expect(checkpoint?.kind).toBe('urlMatches');
    expect(checkpoint).toMatchObject({ pattern: expect.stringContaining('[^/]+') });
  });

  it('produces nothing when typing into a field changed nothing observable', () => {
    const field = node({ role: 'textbox', editable: true, nearbyText: 'Member Number' });
    expect(deriveCheckpoint(screen([field]), screen([field]), [])).toBeUndefined();
  });
});

describe('route canonicalisation', () => {
  it('replaces an argument and any long identifier with a wildcard', () => {
    expect(canonicalisePath('/content/member/10021/accounts', [memberNumber])).toBe(
      '/content/member/*/accounts',
    );
    expect(canonicalisePath('/content/member/98765/accounts', [])).toBe('/content/member/*/accounts');
  });

  it('leaves ordinary path segments alone', () => {
    expect(canonicalisePath('/content/member-search', [])).toBe('/content/member-search');
    expect(canonicalisePath('/', [])).toBe('/');
  });
});

describe('screen rendering', () => {
  const redactor = new Redactor();

  it('shows an inferred label for a control the markup never named', () => {
    const rendered = renderScreen(
      screen([node({ role: 'textbox', editable: true, nearbyText: 'Member Number' })]),
      redactor,
    );
    expect(rendered.text).toContain('textbox (labelled "Member Number")');
  });

  it('shows grid coordinates so one row can be told from another', () => {
    const rendered = renderScreen(
      screen([
        node({
          role: 'cell',
          name: '$4,182.55',
          text: '$4,182.55',
          table: { rowIndex: 1, columnIndex: 3, rowHeader: 'Regular Savings', columnHeader: 'Current Balance' },
        }),
      ]),
      redactor,
    );
    expect(rendered.text).toContain('[row "Regular Savings", column "Current Balance"]');
  });

  it('falls back to a column index when the grid has no header text', () => {
    const rendered = renderScreen(
      screen([node({ role: 'cell', name: 'x', text: 'x', table: { rowIndex: 1, columnIndex: 2, rowHeader: 'Row' } })]),
      redactor,
    );
    expect(rendered.text).toContain('[row "Row", column 2]');
  });

  it('marks a disabled control and shows a field’s current value', () => {
    const rendered = renderScreen(
      screen([
        node({ role: 'button', name: 'Post', enabled: false }),
        node({ role: 'textbox', editable: true, nearbyText: 'Nickname', value: 'Holiday' }),
      ]),
      redactor,
    );
    expect(rendered.text).toContain('[disabled]');
    expect(rendered.text).toContain('value="Holiday"');
  });

  it('qualifies a control with its frame', () => {
    const rendered = renderScreen(
      screen([node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] })]),
      redactor,
    );
    expect(rendered.text).toContain('navFrame: link "Member Search"');
  });

  it('redacts personal data before the model ever sees the screen', () => {
    const rendered = renderScreen(
      screen([node({ role: 'cell', name: '412-55-9087', text: '412-55-9087' })], {
        text: 'SSN 412-55-9087',
      }),
      redactor,
    );
    expect(rendered.text).not.toContain('412-55-9087');
    expect(rendered.text).toContain('«ssn»');
  });

  it('caps the listing and says how much it left out', () => {
    const many = Array.from({ length: 12 }, (_, i) => node({ role: 'button', name: `B${i}` }));
    const rendered = renderScreen(screen(many), redactor, 5);
    expect(rendered.controls).toHaveLength(5);
    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain('7 more not listed');
  });

  it('reports an http status when the screen carried one', () => {
    const rendered = renderScreen(screen([], { httpStatus: 403 }), redactor);
    expect(rendered.text).toContain('HTTP status: 403');
  });
});

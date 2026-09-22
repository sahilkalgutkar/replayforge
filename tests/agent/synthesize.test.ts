import { describe, expect, it } from 'vitest';
import {
  HTTP_ERROR_OUTCOME,
  canonicalisePath,
  deriveCheckpoint,
  deriveTarget,
  parameteriseText,
  type DiscoveredInput,
} from '../../src/agent/synthesize.js';
import { fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from '../helpers/nodes.js';
import type { Observation, UiNode } from '../../src/surface/types.js';

function screen(nodes: UiNode[], url = 'http://app.test/content/member/10021/accounts'): Observation {
  return {
    observationId: 'o',
    capturedAt: 'now',
    url,
    title: '',
    frames: [{ path: [], url }],
    nodes,
    text: '',
    screenFingerprint: fingerprintNodes(nodes),
  };
}

const memberNumber: DiscoveredInput = {
  name: 'memberNumber',
  type: 'string',
  description: 'x',
  sensitivity: 'internal',
  value: '10021',
};

describe('working out a target', () => {
  it('prefers the accessible name for a control that gets acted on', () => {
    const button = node({ role: 'button', name: 'Search', framePath: ['mainFrame'] });
    expect(deriveTarget(button, screen([button]), [], 'search').primary).toEqual({
      role: 'button',
      name: { mode: 'equals', value: 'Search' },
      framePath: ['mainFrame'],
    });
  });

  it('turns an argument value into its parameter', () => {
    const link = node({ role: 'link', name: '10021' });
    expect(deriveTarget(link, screen([link]), [memberNumber], 'result row').primary.name?.value).toBe(
      '{{memberNumber}}',
    );
  });

  it('targets a value it reads by row and column, not by the value itself', () => {
    const balance = node({
      role: 'cell',
      name: '$4,182.55',
      text: '$4,182.55',
      table: { rowIndex: 1, columnIndex: 3, rowHeader: 'Regular Savings', columnHeader: 'Current Balance' },
    });
    const target = deriveTarget(balance, screen([balance]), [], 'balance', 'read');
    expect(target.primary.inTable).toEqual({
      rowContains: { mode: 'equals', value: 'Regular Savings' },
      column: 'Current Balance',
    });
    expect(target.primary.name).toBeUndefined();
    expect(target.fallbacks?.length).toBeGreaterThan(0);
  });

  it('uses the nearby label for an unnamed input', () => {
    const field = node({ role: 'textbox', editable: true, nearbyText: 'Member Number' });
    expect(deriveTarget(field, screen([field]), [], 'member number').primary).toMatchObject({
      editable: true,
      nearbyText: { mode: 'equals', value: 'Member Number' },
    });
  });

  it('ignores a row key that came from a layout table', () => {
    const link = node({
      role: 'link',
      name: 'Back to search',
      table: { rowIndex: 0, columnIndex: 0, rowHeader: 'Member 10021 Dolores Vance Profile Accounts '.repeat(3) },
    });
    const target = deriveTarget(link, screen([link]), [], 'back link');
    expect([target.primary, ...(target.fallbacks ?? [])].some((m) => m.inTable)).toBe(false);
  });

  it('falls back to position when nothing else identifies the control, and says so', () => {
    const a = node({ role: 'cell', name: '' });
    const b = node({ role: 'cell', name: '' });
    const target = deriveTarget(b, screen([a, b]), [], 'the second blank cell');
    expect(target.primary.ordinal).toBe(1);
    expect(target.description).toContain('worth reviewing');
  });
});

describe('working out a check', () => {
  it('prefers a new control named after an argument', () => {
    const before = screen([node({ role: 'button', name: 'Search' })]);
    const after = screen([node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10021' })]);
    expect(deriveCheckpoint(before, after, [memberNumber])).toEqual({
      kind: 'textPresent',
      text: { mode: 'contains', value: '{{memberNumber}}' },
    });
  });

  it('falls back to any new labelled control, then a new table label, then the url', () => {
    expect(deriveCheckpoint(screen([]), screen([node({ role: 'link', name: 'Member Search' })]), [])).toMatchObject({
      text: { value: 'Member Search' },
    });
    expect(deriveCheckpoint(screen([]), screen([node({ role: 'columnheader', name: 'Current Balance' })]), [])?.kind).toBe(
      'textPresent',
    );
    const moved = deriveCheckpoint(screen([], 'http://app.test/a'), screen([]), [memberNumber]);
    expect(moved?.kind).toBe('urlMatches');
  });

  it('finds nothing when only a field’s value changed', () => {
    const field = node({ role: 'textbox', editable: true, nearbyText: 'Member Number' });
    expect(deriveCheckpoint(screen([field]), screen([field]), [])).toBeUndefined();
  });
});

describe('generalising', () => {
  it('turns argument values and long ids in paths into wildcards', () => {
    expect(canonicalisePath('/content/member/10021/accounts', [memberNumber])).toBe('/content/member/*/accounts');
    expect(canonicalisePath('/content/member/98765/accounts', [])).toBe('/content/member/*/accounts');
    expect(canonicalisePath('/content/member-search', [])).toBe('/content/member-search');
  });

  it('parameterises whole-word argument values in prose, not fragments or short values', () => {
    expect(parameteriseText('Open the record for member 10021.', [memberNumber])).toBe(
      'Open the record for member {{memberNumber}}.',
    );
    expect(parameteriseText('Reference 100210 stays.', [memberNumber])).toBe('Reference 100210 stays.');
    expect(parameteriseText('Tab 2 of 2', [{ ...memberNumber, value: '2' }])).toBe('Tab 2 of 2');
  });

  it('adds the HTTP error outcome to every flow, needing a person', () => {
    expect(HTTP_ERROR_OUTCOME.disposition).toBe('needs_human');
    expect(HTTP_ERROR_OUTCOME.when.statuses).toEqual([401, 403, 500, 502, 503]);
  });
});

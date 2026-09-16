import { describe, expect, it } from 'vitest';
import {
  candidatesFor,
  describeFailure,
  matchesText,
  resolveTarget,
} from '../../src/surface/resolve.js';
import { node } from '../helpers/nodes.js';
import type { Observation, TargetSpec } from '../../src/surface/types.js';

function screen(nodes: ReturnType<typeof node>[]): Observation {
  return {
    observationId: 'obs',
    capturedAt: '2026-01-01T00:00:00.000Z',
    url: 'http://localhost/console',
    title: 'test',
    frames: [],
    nodes,
    text: '',
    screenFingerprint: 'ffff',
  };
}

describe('text matching', () => {
  it('collapses whitespace before comparing', () => {
    expect(matchesText({ mode: 'equals', value: 'Member Number' }, '  Member   Number \n')).toBe(true);
  });

  it('ignores case unless asked not to', () => {
    expect(matchesText({ mode: 'equals', value: 'search' }, 'Search')).toBe(true);
    expect(matchesText({ mode: 'equals', value: 'search', caseSensitive: true }, 'Search')).toBe(false);
  });

  it('supports contains, startsWith and regex', () => {
    expect(matchesText({ mode: 'contains', value: 'cord' }, 'No records found')).toBe(true);
    expect(matchesText({ mode: 'startsWith', value: 'No rec' }, 'No records found')).toBe(true);
    expect(matchesText({ mode: 'regex', value: '^\\$[\\d,.]+$' }, '$4,182.55')).toBe(true);
    expect(matchesText({ mode: 'regex', value: '^\\d+$' }, '$4,182.55')).toBe(false);
  });

  it('never matches something that isn’t there', () => {
    expect(matchesText({ mode: 'contains', value: 'x' }, undefined)).toBe(false);
  });
});

describe('resolving a target', () => {
  const searchBox = node({
    role: 'textbox',
    editable: true,
    nearbyText: 'Member Number',
    framePath: ['mainFrame'],
  });
  const searchButton = node({ role: 'button', name: 'Search', framePath: ['mainFrame'] });
  const navLink = node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] });

  it('finds an unlabelled control through the text next to it', () => {
    const spec: TargetSpec = {
      description: 'member number field',
      primary: { role: 'textbox', editable: true, nearbyText: { mode: 'equals', value: 'Member Number' } },
    };
    const result = resolveTarget(spec, screen([searchBox, searchButton, navLink]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.ref).toBe(searchBox.ref);
      expect(result.rung).toBe('primary');
      expect(result.matchCount).toBe(1);
    }
  });

  it('fails rather than guessing when two controls match', () => {
    const spec: TargetSpec = {
      description: 'accounts tab',
      primary: { role: 'link', name: { mode: 'equals', value: 'Accounts' } },
    };
    const result = resolveTarget(spec, screen([node({ role: 'link', name: 'Accounts' }), node({ role: 'link', name: 'Accounts' })]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('ambiguous');
    expect(describeFailure(spec, result)).toContain('matched 2 controls');
  });

  it('takes a declared ordinal when several matches are expected', () => {
    const first = node({ role: 'link', name: 'Open' });
    const second = node({ role: 'link', name: 'Open' });
    const result = resolveTarget(
      { description: 'second open link', primary: { role: 'link', name: { mode: 'equals', value: 'Open' }, ordinal: 1 } },
      screen([first, second]),
    );
    expect(result.ok && result.node.ref).toBe(second.ref);
  });

  it('fails when the ordinal points past the matches', () => {
    const result = resolveTarget(
      { description: 'fourth open link', primary: { role: 'link', name: { mode: 'equals', value: 'Open' }, ordinal: 3 } },
      screen([node({ role: 'link', name: 'Open' })]),
    );
    expect(result.ok).toBe(false);
  });

  it('falls through to the next rung and says which one won', () => {
    const spec: TargetSpec = {
      description: 'search button',
      primary: { role: 'button', name: { mode: 'equals', value: 'Find' } },
      fallbacks: [{ role: 'button', name: { mode: 'equals', value: 'Search' } }],
    };
    const result = resolveTarget(spec, screen([searchButton]));
    expect(result.ok && result.rung).toBe('fallback:0');
  });

  it('counts the rungs it tried when nothing matches', () => {
    const spec: TargetSpec = {
      description: 'post button',
      primary: { role: 'button', name: { mode: 'equals', value: 'Post' } },
      fallbacks: [{ role: 'button', name: { mode: 'equals', value: 'Submit' } }],
    };
    const result = resolveTarget(spec, screen([searchButton]));
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.reason === 'not_found') expect(result.failure.triedRungs).toBe(2);
    expect(describeFailure(spec, result)).toContain('2 targeting rung');
  });

  it('scopes matches to a frame', () => {
    const spec: TargetSpec = {
      description: 'member search in the main frame',
      primary: { role: 'link', name: { mode: 'equals', value: 'Member Search' }, framePath: ['mainFrame'] },
    };
    expect(resolveTarget(spec, screen([navLink])).ok).toBe(false);
  });

  it('ignores hidden nodes', () => {
    const spec: TargetSpec = {
      description: 'search',
      primary: { role: 'button', name: { mode: 'equals', value: 'Search' } },
    };
    expect(resolveTarget(spec, screen([node({ role: 'button', name: 'Search', visible: false })])).ok).toBe(false);
    expect(describeFailure(spec, resolveTarget(spec, screen([searchButton])))).toBe('');
  });
});

describe('addressing a table', () => {
  const balance = node({
    role: 'cell',
    name: '$4,182.55',
    text: '$4,182.55',
    table: { rowIndex: 1, columnIndex: 3, columnHeader: 'Current Balance', rowHeader: 'Regular Savings' },
  });
  const status = node({
    role: 'cell',
    name: 'Open',
    table: { rowIndex: 1, columnIndex: 2, columnHeader: 'Status', rowHeader: 'Regular Savings' },
  });

  it('finds a cell by row key and column header', () => {
    const result = resolveTarget(
      {
        description: 'savings balance',
        primary: {
          role: 'cell',
          inTable: { rowContains: { mode: 'equals', value: 'Regular Savings' }, column: 'Current Balance' },
        },
      },
      screen([balance, status]),
    );
    expect(result.ok && result.node.text).toBe('$4,182.55');
  });

  it('accepts a column index when the table has no usable header', () => {
    const result = resolveTarget(
      {
        description: 'third column',
        primary: {
          role: 'cell',
          inTable: { rowContains: { mode: 'contains', value: 'Savings' }, column: 2 },
        },
      },
      screen([balance, status]),
    );
    expect(result.ok && result.node.name).toBe('Open');
  });

  it('does not match a node outside a table, or the wrong row', () => {
    expect(
      candidatesFor({ inTable: { rowContains: { mode: 'contains', value: 'Savings' }, column: 0 } }, [
        node({ role: 'cell', name: '$1.00' }),
      ]),
    ).toHaveLength(0);
    expect(
      candidatesFor(
        { inTable: { rowContains: { mode: 'equals', value: 'Money Market' }, column: 'Current Balance' } },
        [balance],
      ),
    ).toHaveLength(0);
  });
});

describe('matching on value, text and editability', () => {
  it('matches a control’s current value and a node’s raw text', () => {
    expect(
      candidatesFor({ value: { mode: 'equals', value: '10021' } }, [
        node({ role: 'textbox', editable: true, value: '10021' }),
      ]),
    ).toHaveLength(1);
    expect(
      candidatesFor({ text: { mode: 'contains', value: 'No records found' } }, [
        node({ role: 'cell', text: 'No records found for "99999".' }),
      ]),
    ).toHaveLength(1);
  });

  it('separates editable controls from read-only ones', () => {
    expect(candidatesFor({ editable: true }, [node({ role: 'cell', name: 'Balance' })])).toHaveLength(0);
  });
});

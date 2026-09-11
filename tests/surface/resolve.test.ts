import { describe, expect, it } from 'vitest';
import { candidatesFor, describeFailure, matchesText, resolveTarget } from '../../src/surface/resolve.js';
import { node } from '../helpers/nodes.js';
import type { Observation, TargetSpec } from '../../src/surface/types.js';

function observationOf(nodes: ReturnType<typeof node>[]): Observation {
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

  it('is case-insensitive unless asked otherwise', () => {
    expect(matchesText({ mode: 'equals', value: 'search' }, 'Search')).toBe(true);
    expect(matchesText({ mode: 'equals', value: 'search', caseSensitive: true }, 'Search')).toBe(false);
  });

  it('supports contains, startsWith and regex', () => {
    expect(matchesText({ mode: 'contains', value: 'cord' }, 'No records found')).toBe(true);
    expect(matchesText({ mode: 'startsWith', value: 'No rec' }, 'No records found')).toBe(true);
    expect(matchesText({ mode: 'regex', value: '^\\$[\\d,.]+$' }, '$4,182.55')).toBe(true);
    expect(matchesText({ mode: 'regex', value: '^\\d+$' }, '$4,182.55')).toBe(false);
  });

  it('never matches an absent candidate', () => {
    expect(matchesText({ mode: 'contains', value: 'x' }, undefined)).toBe(false);
  });
});

describe('resolveTarget', () => {
  const searchBox = node({ role: 'textbox', editable: true, nearbyText: 'Member Number', framePath: ['mainFrame'] });
  const searchButton = node({ role: 'button', name: 'Search', framePath: ['mainFrame'] });
  const navLink = node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] });

  it('resolves an unlabelled control through its inferred nearby text', () => {
    const spec: TargetSpec = {
      description: 'member number field',
      primary: {
        role: 'textbox',
        editable: true,
        nearbyText: { mode: 'equals', value: 'Member Number' },
      },
    };
    const result = resolveTarget(spec, observationOf([searchBox, searchButton, navLink]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.ref).toBe(searchBox.ref);
      expect(result.rung).toBe('primary');
      expect(result.matchCount).toBe(1);
    }
  });

  it('refuses to guess when a matcher is ambiguous', () => {
    const a = node({ role: 'link', name: 'Accounts' });
    const b = node({ role: 'link', name: 'Accounts' });
    const result = resolveTarget(
      { description: 'accounts tab', primary: { role: 'link', name: { mode: 'equals', value: 'Accounts' } } },
      observationOf([a, b]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('ambiguous');
      expect(describeFailure({ description: 'accounts tab', primary: {} }, result)).toContain(
        'matched 2 controls',
      );
    }
  });

  it('takes a declared ordinal when several matches are legitimate', () => {
    const a = node({ role: 'link', name: 'Open' });
    const b = node({ role: 'link', name: 'Open' });
    const result = resolveTarget(
      {
        description: 'second open link',
        primary: { role: 'link', name: { mode: 'equals', value: 'Open' }, ordinal: 1 },
      },
      observationOf([a, b]),
    );
    expect(result.ok && result.node.ref).toBe(b.ref);
  });

  it('reports an ambiguity when the ordinal points past the matches', () => {
    const a = node({ role: 'link', name: 'Open' });
    const result = resolveTarget(
      { description: 'fourth open link', primary: { role: 'link', name: { mode: 'equals', value: 'Open' }, ordinal: 3 } },
      observationOf([a]),
    );
    expect(result.ok).toBe(false);
  });

  it('falls through to the next rung and says which one won', () => {
    const spec: TargetSpec = {
      description: 'search button',
      primary: { role: 'button', name: { mode: 'equals', value: 'Find' } },
      fallbacks: [{ role: 'button', name: { mode: 'equals', value: 'Search' } }],
    };
    const result = resolveTarget(spec, observationOf([searchButton]));
    expect(result.ok && result.rung).toBe('fallback:0');
  });

  it('fails with not_found and counts the rungs it tried', () => {
    const spec: TargetSpec = {
      description: 'post button',
      primary: { role: 'button', name: { mode: 'equals', value: 'Post' } },
      fallbacks: [{ role: 'button', name: { mode: 'equals', value: 'Submit' } }],
    };
    const result = resolveTarget(spec, observationOf([searchButton]));
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.reason === 'not_found') {
      expect(result.failure.triedRungs).toBe(2);
    }
    expect(describeFailure(spec, result)).toContain('2 targeting rung');
  });

  it('scopes matches to a frame path', () => {
    const spec: TargetSpec = {
      description: 'member search in the nav frame',
      primary: { role: 'link', name: { mode: 'equals', value: 'Member Search' }, framePath: ['mainFrame'] },
    };
    expect(resolveTarget(spec, observationOf([navLink])).ok).toBe(false);
  });

  it('ignores invisible nodes', () => {
    const hidden = node({ role: 'button', name: 'Search', visible: false });
    expect(
      resolveTarget(
        { description: 'search', primary: { role: 'button', name: { mode: 'equals', value: 'Search' } } },
        observationOf([hidden]),
      ).ok,
    ).toBe(false);
  });

  it('returns an empty description for a successful resolution', () => {
    const result = resolveTarget(
      { description: 'search', primary: { role: 'button', name: { mode: 'equals', value: 'Search' } } },
      observationOf([searchButton]),
    );
    expect(describeFailure({ description: 'search', primary: {} }, result)).toBe('');
  });
});

describe('table addressing', () => {
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
      observationOf([balance, status]),
    );
    expect(result.ok && result.node.text).toBe('$4,182.55');
  });

  it('accepts a numeric column when the table has no usable header', () => {
    const result = resolveTarget(
      {
        description: 'third column',
        primary: {
          role: 'cell',
          inTable: { rowContains: { mode: 'contains', value: 'Savings' }, column: 2 },
        },
      },
      observationOf([balance, status]),
    );
    expect(result.ok && result.node.name).toBe('Open');
  });

  it('does not match a node that is not in a table', () => {
    const loose = node({ role: 'cell', name: '$1.00' });
    expect(
      candidatesFor(
        { inTable: { rowContains: { mode: 'contains', value: 'Savings' }, column: 0 } },
        [loose],
      ),
    ).toHaveLength(0);
  });

  it('does not match when the row key differs', () => {
    expect(
      candidatesFor(
        { inTable: { rowContains: { mode: 'equals', value: 'Money Market' }, column: 'Current Balance' } },
        [balance],
      ),
    ).toHaveLength(0);
  });
});

describe('value and text constraints', () => {
  it('matches on a control value and on raw text', () => {
    const filled = node({ role: 'textbox', editable: true, value: '10021' });
    expect(candidatesFor({ value: { mode: 'equals', value: '10021' } }, [filled])).toHaveLength(1);
    const banner = node({ role: 'cell', text: 'No records found for "99999".' });
    expect(candidatesFor({ text: { mode: 'contains', value: 'No records found' } }, [banner])).toHaveLength(1);
  });

  it('separates editable controls from read-only ones', () => {
    const readOnly = node({ role: 'cell', name: 'Balance' });
    expect(candidatesFor({ editable: true }, [readOnly])).toHaveLength(0);
  });
});

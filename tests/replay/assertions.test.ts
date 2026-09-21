import { describe, expect, it } from 'vitest';
import { describeAssertion, evaluateAssertion } from '../../src/replay/assertions.js';
import { node } from '../helpers/nodes.js';
import type { Observation } from '../../src/surface/types.js';
import type { Assertion } from '../../src/artifact/schema.js';

function screen(overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'o',
    capturedAt: '2026-01-01T00:00:00.000Z',
    url: 'http://localhost:4310/console',
    title: 'Console',
    frames: [
      { path: [], url: 'http://localhost:4310/console' },
      { path: ['mainFrame'], url: 'http://localhost:4310/content/member/10021/accounts' },
    ],
    nodes: [
      node({ role: 'button', name: 'Search', framePath: ['mainFrame'] }),
      node({ role: 'cell', name: 'Current Balance', text: 'Current Balance', framePath: ['mainFrame'] }),
      node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] }),
    ],
    text: 'Regular Savings',
    screenFingerprint: 'abc',
    ...overrides,
  };
}

const searchButton: Assertion = {
  kind: 'targetPresent',
  target: { description: 'the Search button', primary: { role: 'button', name: { mode: 'equals', value: 'Search' } } },
};

describe('evaluating checks', () => {
  it('finds a present target and says which rung matched', () => {
    const result = evaluateAssertion(searchButton, screen());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('rung primary');
  });

  it('handles absent targets both ways', () => {
    const empty = screen({ nodes: [] });
    expect(evaluateAssertion(searchButton, empty).ok).toBe(false);
    expect(evaluateAssertion({ kind: 'targetAbsent', target: searchButton.target }, empty).ok).toBe(true);
    expect(evaluateAssertion({ kind: 'targetAbsent', target: searchButton.target }, screen()).detail).toContain(
      'still there',
    );
  });

  it('counts a button label as being on screen even though the page text leaves it out', () => {
    const signOn = screen({ text: '', nodes: [node({ role: 'button', name: 'Sign On' })] });
    expect(evaluateAssertion({ kind: 'textPresent', text: { mode: 'contains', value: 'Sign On' } }, signOn).ok).toBe(true);
  });

  it('scopes text to a frame, and checks for absent text', () => {
    const inMain: Assertion = { kind: 'textPresent', text: { mode: 'contains', value: 'Member Search' }, framePath: ['mainFrame'] };
    expect(evaluateAssertion(inMain, screen()).ok).toBe(false);
    expect(evaluateAssertion({ ...inMain, framePath: ['navFrame'] }, screen()).ok).toBe(true);
    const noExpiry: Assertion = { kind: 'textAbsent', text: { mode: 'contains', value: 'expired' } };
    expect(evaluateAssertion(noExpiry, screen()).ok).toBe(true);
    expect(evaluateAssertion(noExpiry, screen({ text: 'Your session has expired' })).ok).toBe(false);
  });

  it('checks http status, and says so when there is none', () => {
    const forbidden: Assertion = { kind: 'httpStatusIn', statuses: [403] };
    expect(evaluateAssertion(forbidden, screen({ httpStatus: 403 })).ok).toBe(true);
    expect(evaluateAssertion(forbidden, screen()).detail).toContain('unknown');
  });

  it('matches a url in any frame', () => {
    expect(evaluateAssertion({ kind: 'urlMatches', pattern: '/content/member/\\d+/accounts' }, screen()).ok).toBe(true);
    const miss = evaluateAssertion({ kind: 'urlMatches', pattern: '/nowhere' }, screen());
    expect(miss.ok).toBe(false);
    expect(miss.detail).toContain('no frame url matches');
  });

  it('combines checks with all, any and not', () => {
    const both: Assertion = {
      kind: 'all',
      of: [
        { kind: 'textPresent', text: { mode: 'contains', value: 'Regular Savings' } },
        { kind: 'textPresent', text: { mode: 'contains', value: 'Money Market' } },
      ],
    };
    expect(evaluateAssertion(both, screen()).detail).toContain('first unmet');
    expect(evaluateAssertion({ kind: 'any', of: both.of }, screen()).detail).toContain('met by');
    expect(
      evaluateAssertion({ kind: 'any', of: [{ kind: 'textPresent', text: { mode: 'contains', value: 'x9x' } }] }, screen())
        .detail,
    ).toContain('none of 1');
    expect(evaluateAssertion({ kind: 'not', of: searchButton }, screen()).ok).toBe(false);
    expect(evaluateAssertion({ kind: 'all', of: [] }, screen()).ok).toBe(true);
  });
});

describe('describing checks', () => {
  it('renders every kind in one line', () => {
    expect(describeAssertion(searchButton)).toBe('the Search button is present');
    expect(describeAssertion({ kind: 'targetAbsent', target: searchButton.target })).toContain('is gone');
    expect(describeAssertion({ kind: 'textPresent', text: { mode: 'contains', value: 'x' } })).toBe('text contains "x"');
    expect(describeAssertion({ kind: 'textAbsent', text: { mode: 'equals', value: 'x' } })).toContain('no text');
    expect(describeAssertion({ kind: 'httpStatusIn', statuses: [403, 500] })).toBe('http status in [403, 500]');
    expect(describeAssertion({ kind: 'urlMatches', pattern: '/x' })).toBe('url matching //x/');
    expect(describeAssertion({ kind: 'all', of: [searchButton] })).toContain('all of');
    expect(describeAssertion({ kind: 'any', of: [searchButton] })).toContain('any of');
    expect(describeAssertion({ kind: 'not', of: searchButton })).toContain('not (');
  });
});

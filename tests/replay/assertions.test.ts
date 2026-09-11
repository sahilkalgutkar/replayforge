import { describe, expect, it } from 'vitest';
import { describeAssertion, evaluateAssertion } from '../../src/replay/assertions.js';
import { node } from '../helpers/nodes.js';
import type { Observation } from '../../src/surface/types.js';
import type { Assertion } from '../../src/artifact/schema.js';

function observation(overrides: Partial<Observation> = {}): Observation {
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
  target: {
    description: 'the Search button',
    primary: { role: 'button', name: { mode: 'equals', value: 'Search' } },
  },
};

describe('assertion evaluation', () => {
  it('finds a present target and says which rung matched', () => {
    const result = evaluateAssertion(searchButton, observation());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('rung primary');
  });

  it('reports an absent target as a miss, and the inverse as a hit', () => {
    const gone = observation({ nodes: [] });
    expect(evaluateAssertion(searchButton, gone).ok).toBe(false);
    expect(evaluateAssertion({ kind: 'targetAbsent', target: searchButton.target }, gone).ok).toBe(true);
    expect(evaluateAssertion({ kind: 'targetAbsent', target: searchButton.target }, observation()).detail).toContain(
      'expected to be gone',
    );
  });

  it('sees a control label that the document’s rendered text omits', () => {
    // innerText does not include the value of a submit button, but a person
    // looking at the screen would say the word is on it.
    const screen = observation({ text: '', nodes: [node({ role: 'button', name: 'Sign On' })] });
    expect(
      evaluateAssertion({ kind: 'textPresent', text: { mode: 'contains', value: 'Sign On' } }, screen).ok,
    ).toBe(true);
  });

  it('scopes a text assertion to a frame', () => {
    const inMain: Assertion = {
      kind: 'textPresent',
      text: { mode: 'contains', value: 'Member Search' },
      framePath: ['mainFrame'],
    };
    expect(evaluateAssertion(inMain, observation()).ok).toBe(false);
    expect(
      evaluateAssertion({ ...inMain, framePath: ['navFrame'] }, observation()).ok,
    ).toBe(true);
  });

  it('checks for absent text', () => {
    const assertion: Assertion = { kind: 'textAbsent', text: { mode: 'contains', value: 'expired' } };
    expect(evaluateAssertion(assertion, observation()).ok).toBe(true);
    expect(
      evaluateAssertion(assertion, observation({ text: 'Your session has expired' })).ok,
    ).toBe(false);
  });

  it('checks the http status and says what it saw', () => {
    const assertion: Assertion = { kind: 'httpStatusIn', statuses: [403] };
    expect(evaluateAssertion(assertion, observation({ httpStatus: 403 })).ok).toBe(true);
    expect(evaluateAssertion(assertion, observation()).detail).toContain('unknown');
  });

  it('matches a url in any frame, not only the top one', () => {
    const assertion: Assertion = { kind: 'urlMatches', pattern: '/content/member/\\d+/accounts' };
    expect(evaluateAssertion(assertion, observation()).ok).toBe(true);
    const miss = evaluateAssertion({ kind: 'urlMatches', pattern: '/nowhere' }, observation());
    expect(miss.ok).toBe(false);
    expect(miss.detail).toContain('no frame url matches');
  });

  it('names the first unmet condition of an all', () => {
    const assertion: Assertion = {
      kind: 'all',
      of: [
        { kind: 'textPresent', text: { mode: 'contains', value: 'Regular Savings' } },
        { kind: 'textPresent', text: { mode: 'contains', value: 'Money Market' } },
      ],
    };
    const result = evaluateAssertion(assertion, observation());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('first unmet');
    expect(result.detail).toContain('Money Market');
  });

  it('names which condition satisfied an any, and lists them all when none did', () => {
    const met: Assertion = {
      kind: 'any',
      of: [
        { kind: 'textPresent', text: { mode: 'contains', value: 'Money Market' } },
        { kind: 'textPresent', text: { mode: 'contains', value: 'Regular Savings' } },
      ],
    };
    expect(evaluateAssertion(met, observation()).detail).toContain('met by');
    const unmet: Assertion = {
      kind: 'any',
      of: [{ kind: 'textPresent', text: { mode: 'contains', value: 'Nowhere' } }],
    };
    expect(evaluateAssertion(unmet, observation()).detail).toContain('none of 1 conditions');
  });

  it('inverts with not', () => {
    expect(evaluateAssertion({ kind: 'not', of: searchButton }, observation()).ok).toBe(false);
    expect(evaluateAssertion({ kind: 'not', of: searchButton }, observation({ nodes: [] })).ok).toBe(true);
  });

  it('passes an all with no conditions, which is what an empty precondition list means', () => {
    expect(evaluateAssertion({ kind: 'all', of: [] }, observation()).ok).toBe(true);
  });
});

describe('assertion descriptions', () => {
  it('renders every assertion kind in one line', () => {
    expect(describeAssertion(searchButton)).toBe('the Search button is present');
    expect(describeAssertion({ kind: 'targetAbsent', target: searchButton.target })).toContain('is gone');
    expect(describeAssertion({ kind: 'textPresent', text: { mode: 'contains', value: 'x' } })).toBe(
      'text contains "x"',
    );
    expect(describeAssertion({ kind: 'textAbsent', text: { mode: 'equals', value: 'x' } })).toContain('no text');
    expect(describeAssertion({ kind: 'httpStatusIn', statuses: [403, 500] })).toBe('http status in [403, 500]');
    expect(describeAssertion({ kind: 'urlMatches', pattern: '/x' })).toBe('url matching //x/');
    expect(describeAssertion({ kind: 'all', of: [searchButton] })).toContain('all of');
    expect(describeAssertion({ kind: 'any', of: [searchButton] })).toContain('any of');
    expect(describeAssertion({ kind: 'not', of: searchButton })).toContain('not (');
  });
});

import { describe, expect, it } from 'vitest';
import { compareFingerprints, fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from '../helpers/nodes.js';
import type { Observation } from '../../src/surface/types.js';

const screen = [
  node({ role: 'button', name: 'Search' }),
  node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] }),
  node({ role: 'cell', name: 'Member Number' }),
];

function observationOf(nodes: ReturnType<typeof node>[]): Observation {
  return {
    observationId: 'obs',
    capturedAt: '2026-01-01T00:00:00.000Z',
    url: 'http://localhost/',
    title: '',
    frames: [],
    nodes,
    text: '',
    screenFingerprint: fingerprintNodes(nodes),
  };
}

describe('screen fingerprint', () => {
  it('ignores node order', () => {
    expect(fingerprintNodes(screen)).toBe(fingerprintNodes([...screen].reverse()));
  });

  it('ignores values, so typing into a field does not change the screen', () => {
    const typed = [...screen, node({ role: 'textbox', name: '', value: '10021' })];
    const empty = [...screen, node({ role: 'textbox', name: '', value: '' })];
    expect(fingerprintNodes(typed)).toBe(fingerprintNodes(empty));
  });

  it('ignores data cells, so a different record is still the same screen', () => {
    const withData = [...screen, node({ role: 'cell', name: '$4,182.55' })];
    expect(fingerprintNodes(withData)).toBe(fingerprintNodes(screen));
  });

  it('changes when a named control is renamed', () => {
    const renamed = [
      node({ role: 'button', name: 'Find' }),
      node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] }),
      node({ role: 'cell', name: 'Member Number' }),
    ];
    expect(fingerprintNodes(renamed)).not.toBe(fingerprintNodes(screen));
  });

  it('changes when a control moves to a different frame', () => {
    const moved = [node({ role: 'button', name: 'Search', framePath: ['mainFrame'] })];
    expect(fingerprintNodes(moved)).not.toBe(fingerprintNodes([node({ role: 'button', name: 'Search' })]));
  });
});

describe('drift report', () => {
  it('confirms a match and names nothing', () => {
    const observation = observationOf(screen);
    const report = compareFingerprints(observation.screenFingerprint, observation);
    expect(report.matches).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('names the controls a drifted screen is missing and the ones it gained', () => {
    const observation = observationOf([node({ role: 'button', name: 'Find' })]);
    const report = compareFingerprints('an-older-fingerprint', observation, ['Search']);
    expect(report.matches).toBe(false);
    expect(report.missing).toEqual(['Search']);
    expect(report.added).toEqual(['find']);
  });

  it('lists nothing as added when the recording declared no expected controls', () => {
    const observation = observationOf(screen);
    expect(compareFingerprints('other', observation).added).toEqual([]);
  });
});

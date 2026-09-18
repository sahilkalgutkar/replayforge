import { describe, expect, it } from 'vitest';
import { compareFingerprints, fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from '../helpers/nodes.js';
import type { Observation } from '../../src/surface/types.js';

const chrome = [
  node({ role: 'button', name: 'Search' }),
  node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] }),
  node({ role: 'cell', name: 'Member Number' }),
];

function screen(nodes: ReturnType<typeof node>[]): Observation {
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
    expect(fingerprintNodes(chrome)).toBe(fingerprintNodes([...chrome].reverse()));
  });

  it('ignores values, so typing into a field is still the same screen', () => {
    const typed = [...chrome, node({ role: 'textbox', name: '', value: '10021' })];
    const empty = [...chrome, node({ role: 'textbox', name: '', value: '' })];
    expect(fingerprintNodes(typed)).toBe(fingerprintNodes(empty));
  });

  it('ignores data cells, so a different record is still the same screen', () => {
    expect(fingerprintNodes([...chrome, node({ role: 'cell', name: '$4,182.55' })])).toBe(
      fingerprintNodes(chrome),
    );
  });

  it('treats a results screen for two different members as one screen', () => {
    const forOne = [node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10021' })];
    const forAnother = [node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10022' })];
    expect(fingerprintNodes(forOne, ['10021'])).toBe(fingerprintNodes(forAnother, ['10022']));
  });

  it('changes when a control is renamed or moves frame', () => {
    expect(fingerprintNodes([node({ role: 'button', name: 'Find' })])).not.toBe(
      fingerprintNodes([node({ role: 'button', name: 'Search' })]),
    );
    expect(fingerprintNodes([node({ role: 'button', name: 'Search', framePath: ['mainFrame'] })])).not.toBe(
      fingerprintNodes([node({ role: 'button', name: 'Search' })]),
    );
  });
});

describe('drift report', () => {
  it('reports a match and names nothing', () => {
    const observation = screen(chrome);
    const report = compareFingerprints(observation.screenFingerprint, observation);
    expect(report.matches).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.added).toEqual([]);
  });

  it('names the control a renamed screen lost and the one it gained', () => {
    const report = compareFingerprints(
      fingerprintNodes([node({ role: 'link', name: 'Member Search' })]),
      screen([node({ role: 'link', name: 'Customer Search' })]),
      ['Member Search'],
    );
    expect(report.matches).toBe(false);
    expect(report.missing).toEqual(['Member Search']);
    expect(report.added).toEqual(['customer search']);
  });

  it('does not treat an argument value as a gained control', () => {
    const report = compareFingerprints(
      fingerprintNodes([node({ role: 'button', name: 'Search' })]),
      screen([node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10022' })]),
      ['Search'],
      ['10022'],
    );
    expect(report.matches).toBe(true);
    expect(report.added).toEqual([]);
  });
});

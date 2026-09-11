import { describe, expect, it } from 'vitest';
import { compareFingerprints, fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from '../helpers/nodes.js';
import type { Observation } from '../../src/surface/types.js';

const obs = (nodes: ReturnType<typeof node>[]): Observation => ({
  observationId: 'o', capturedAt: 'now', url: 'http://x/', title: '', frames: [],
  nodes, text: '', screenFingerprint: fingerprintNodes(nodes),
});

describe('drift still fires when a build genuinely differs', () => {
  it('treats a results screen for two different members as the same screen', () => {
    const a = [node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10021' })];
    const b = [node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10022' })];
    expect(fingerprintNodes(a, ['10021'])).toBe(fingerprintNodes(b, ['10022']));
  });

  it('still reports a renamed control as drift', () => {
    const recorded = fingerprintNodes([node({ role: 'link', name: 'Member Search' })], ['10021']);
    const report = compareFingerprints(
      recorded,
      obs([node({ role: 'link', name: 'Customer Search' })]),
      ['Member Search'],
      ['10021'],
    );
    expect(report.matches).toBe(false);
    expect(report.missing).toEqual(['Member Search']);
    expect(report.added).toEqual(['customer search']);
  });

  it('does not list an argument value as a gained control', () => {
    const recorded = fingerprintNodes([node({ role: 'button', name: 'Search' })], []);
    const report = compareFingerprints(
      recorded,
      obs([node({ role: 'button', name: 'Search' }), node({ role: 'link', name: '10022' })]),
      ['Search'],
      ['10022'],
    );
    expect(report.matches).toBe(true);
    expect(report.added).toEqual([]);
  });
});

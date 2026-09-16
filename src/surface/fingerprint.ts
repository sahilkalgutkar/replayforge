import { createHash } from 'node:crypto';
import type { Observation, UiNode } from './types.js';

// A digest of which named controls a screen has. Blind to values and ordering,
// so typing into a field or opening a different record doesn't change it, but
// renaming a field or dropping a button does.

export function fingerprintNodes(
  nodes: readonly UiNode[],
  /**
   * Values that are data rather than chrome, usually the arguments a flow was
   * given. A results screen for one member and the same screen for another are
   * the same screen, and a fingerprint that disagrees is just noise.
   */
  volatile: readonly string[] = [],
): string {
  const ignore = new Set(volatile.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const tokens = nodes
    .filter((node) => node.visible && node.name !== '' && node.role !== 'cell')
    .filter((node) => !ignore.has(node.name.trim().toLowerCase()))
    .map((node) => `${node.framePath.join('/')}|${node.role}|${node.name.toLowerCase()}`)
    .sort();
  return createHash('sha256').update(tokens.join('\n')).digest('hex').slice(0, 16);
}

export interface DriftReport {
  readonly matches: boolean;
  readonly expected: string;
  readonly observed: string;
  /** Named controls the recording had that this screen doesn't. */
  readonly missing: readonly string[];
  /** Named controls this screen has that the recording didn't. */
  readonly added: readonly string[];
}

export function compareFingerprints(
  expected: string,
  observation: Observation,
  expectedControls: readonly string[] = [],
  volatile: readonly string[] = [],
): DriftReport {
  // Recomputed rather than read off the observation, which knows nothing about
  // which values are this run's arguments.
  const observed = fingerprintNodes(observation.nodes, volatile);
  const ignore = new Set(volatile.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const present = new Set(
    observation.nodes
      .filter((node) => node.visible && node.name !== '')
      .map((node) => node.name.toLowerCase()),
  );
  const missing = expectedControls.filter(
    (name) => !present.has(name.toLowerCase()) && !ignore.has(name.trim().toLowerCase()),
  );
  const added: string[] = [];
  if (expectedControls.length > 0) {
    const wanted = new Set(expectedControls.map((name) => name.toLowerCase()));
    for (const name of present) if (!wanted.has(name) && !ignore.has(name)) added.push(name);
  }
  return { matches: expected === observed, expected, observed, missing, added };
}

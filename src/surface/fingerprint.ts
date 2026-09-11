import { createHash } from 'node:crypto';
import type { Observation, UiNode } from './types.js';

/**
 * A structural digest of a screen: which named controls, in which roles, in
 * which frames. Deliberately blind to values, ordering and layout, so entering
 * a member number or landing on a different record does not change it, but
 * renaming a field or dropping a button does.
 *
 * Replay compares the fingerprint it observes against the one recorded for that
 * step. A mismatch does not fail the run on its own — the checkpoint decides
 * that — but it is the signal that says "this tenant's build of the app is not
 * the one this capability was recorded against", which is the difference
 * between a debuggable drift report and a mystery.
 */
export function fingerprintNodes(
  nodes: readonly UiNode[],
  /**
   * Values that are data rather than chrome — the caller's arguments, and
   * whatever the screen is showing because of them. A search results screen for
   * member 10021 and one for member 10022 are the *same screen*, and a
   * fingerprint that disagrees turns the drift signal into noise.
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
  /** Named controls the recording had that this screen does not. */
  readonly missing: readonly string[];
  /** Named controls this screen has that the recording did not. */
  readonly added: readonly string[];
}

export function compareFingerprints(
  expected: string,
  observation: Observation,
  expectedControls: readonly string[] = [],
  volatile: readonly string[] = [],
): DriftReport {
  // Recomputed rather than read off the observation, because the observation's
  // own fingerprint knows nothing about which values are this invocation's
  // arguments.
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
    const wanted = new Set(expectedControls.map((n) => n.toLowerCase()));
    for (const name of present) if (!wanted.has(name) && !ignore.has(name)) added.push(name);
  }
  return { matches: expected === observed, expected, observed, missing, added };
}

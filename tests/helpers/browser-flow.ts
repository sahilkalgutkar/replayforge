import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { resolveTarget } from '../../src/surface/resolve.js';
import type { Observation, TargetSpec } from '../../src/surface/types.js';

/**
 * Small helpers so integration tests can drive the demo app the same way the
 * replay engine does — by semantic target, never by selector.
 */

export async function act(
  surface: BrowserSurface,
  spec: TargetSpec,
  make: (ref: string) => Parameters<BrowserSurface['perform']>[0],
): Promise<Observation> {
  const observation = await surface.observe();
  const resolution = resolveTarget(spec, observation);
  if (!resolution.ok) {
    throw new Error(`could not resolve ${spec.description}: ${JSON.stringify(resolution.failure)}`);
  }
  await surface.perform(make(resolution.node.ref));
  return surface.observe();
}

export const byNearby = (role: string, label: string): TargetSpec => ({
  description: `${role} labelled ${label}`,
  primary: { role, nearbyText: { mode: 'equals', value: label } },
});

export const byName = (role: string, name: string): TargetSpec => ({
  description: `${role} named ${name}`,
  primary: { role, name: { mode: 'equals', value: name } },
});

export async function signOnInBrowser(surface: BrowserSurface, baseUrl: string): Promise<Observation> {
  await surface.perform({ kind: 'navigate', url: `${baseUrl}/` });
  await act(surface, byNearby('textbox', 'User ID'), (ref) => ({ kind: 'fill', ref, text: 'teller01' }));
  await act(surface, byNearby('textbox', 'Password'), (ref) => ({
    kind: 'fill',
    ref,
    text: 'demo-pass-01',
  }));
  return act(surface, byName('button', 'Sign On'), (ref) => ({ kind: 'click', ref }));
}

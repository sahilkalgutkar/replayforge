import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import { resolveForTenant } from '../../src/artifact/overrides.js';
import { validateArtifact } from '../../src/artifact/validate.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';

/**
 * Two institutions on the same vendor product. `northbay` runs the same code as
 * `base` with a different configuration: the member field is called Customer
 * ID, the menu item is Customer Search, and the menu is ordered differently.
 *
 * This is the case that keying capabilities on the product rather than the
 * tenant exists for. A capability recorded once has to either work as-is, or
 * fail in a way that names what differs — and be specialisable with a patch
 * small enough for a person to review in one sitting.
 */

let variant: TargetHarness;
let surface: BrowserSurface;
let evidenceRoot: string;

const ENV = {
  MERIDIAN_USERNAME: 'teller01',
  MERIDIAN_PASSWORD: 'demo-pass-01',
} as NodeJS.ProcessEnv;

beforeEach(async () => {
  variant = await startTarget({ tenantId: 'northbay' });
  surface = await BrowserSurface.launch({ targetId: 'northbay' });
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-tenant-'));
});

afterEach(async () => {
  await surface.dispose();
  await variant.close();
  await rm(evidenceRoot, { recursive: true, force: true });
});

/** The whole specialisation: two re-targeted controls and one tightened checkpoint. */
const NORTHBAY = {
  northbay: {
    tenantId: 'northbay',
    note: 'Northbay calls members customers and reorders the menu. Same product, same flow.',
    steps: {
      open_search: {
        note: 'Menu item renamed from Member Search; its checkpoint named the old field label.',
        target: {
          description: 'the customer search item in the menu frame',
          primary: {
            role: 'link',
            name: { mode: 'equals' as const, value: 'Customer Search' },
            framePath: ['navFrame'],
          },
        },
        checkpoint: {
          kind: 'targetPresent' as const,
          target: {
            description: 'the customer id entry field on the search screen',
            primary: {
              role: 'textbox',
              editable: true,
              nearbyText: { mode: 'contains' as const, value: 'Customer ID' },
              framePath: ['mainFrame'],
            },
          },
        },
      },
      enter_member_number: {
        note: 'Field label renamed from Member Number.',
        target: {
          description: 'the customer id field, identified by the label in the cell to its left',
          primary: {
            role: 'textbox',
            editable: true,
            nearbyText: { mode: 'contains' as const, value: 'Customer ID' },
            framePath: ['mainFrame'],
          },
        },
      },
    },
    extraSteps: [],
  },
};

const approved = (tenantOverrides = {}): CapabilityArtifact =>
  sampleArtifact({
    approval: { state: 'approved', approvedBy: 'ops@example', approvedAt: '2026-09-09T00:00:00.000Z' },
    tenantOverrides,
  });

const run = (artifact: CapabilityArtifact, tenantId: string) =>
  replay({
    artifact,
    inputs: { memberNumber: '10021' },
    surface,
    evidenceRoot,
    tenantId,
    variables: { baseUrl: variant.baseUrl },
    env: ENV,
    screenshots: 'never',
  });

describe('one capability across two tenants', () => {
  it('degrades rather than breaking, and the checkpoint catches what the fallback could not', async () => {
    const result = await run(approved(), 'base');

    if (result.status !== 'failed') throw new Error(summariseResult(result));
    // The recorded target was `link "Member Search"`, which does not exist
    // here. Its fallback rung — a link whose name contains "Search" in the menu
    // frame — matched "Customer Search", so the run reached the right screen.
    // What it could not absorb is the renamed field, and the step's checkpoint
    // is what says so.
    expect(result.error.category).toBe('checkpoint_failed');
    expect(result.error.stepId).toBe('open_search');
    expect(result.error.expected).toContain('member number entry field');
    expect(result.trace.steps.find((s) => s.stepId === 'open_search')?.status).toBe('failed');
  });

  it('runs on the variant once the per-tenant patch is applied', async () => {
    const result = await run(approved(NORTHBAY), 'northbay');

    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs).toEqual({
      memberName: 'Dolores Vance',
      savingsBalance: 4182.55,
      savingsAccountNumber: 'S0001-10021',
    });
  });

  it('still runs on the tenant it was recorded against', async () => {
    const base = await startTarget({ tenantId: 'base' });
    const baseSurface = await BrowserSurface.launch({ targetId: 'base' });
    try {
      const result = await replay({
        artifact: approved(NORTHBAY),
        inputs: { memberNumber: '10021' },
        surface: baseSurface,
        evidenceRoot,
        tenantId: 'base',
        variables: { baseUrl: base.baseUrl },
        env: ENV,
        screenshots: 'never',
      });
      expect(result.status).toBe('success');
    } finally {
      await baseSurface.dispose();
      await base.close();
    }
  });

  it('keeps the contract identical across tenants, so a caller sees one capability', () => {
    const artifact = approved(NORTHBAY);
    const base = resolveForTenant(artifact, 'base');
    const northbay = resolveForTenant(artifact, 'northbay');

    expect(northbay.artifact.inputs).toEqual(base.artifact.inputs);
    expect(northbay.artifact.outputs).toEqual(base.artifact.outputs);
    expect(northbay.artifact.outcomes).toEqual(base.artifact.outcomes);
    expect(northbay.artifact.policy).toEqual(base.artifact.policy);
  });

  it('names the steps a tenant specialised, so a run log says what was different', () => {
    const resolved = resolveForTenant(approved(NORTHBAY), 'northbay');
    expect(resolved.patchedSteps).toEqual(['open_search', 'enter_member_number']);
    expect(resolved.skippedSteps).toEqual([]);
    expect(resolved.insertedSteps).toEqual([]);
  });

  it('keeps the specialised artifact coherent', () => {
    expect(validateArtifact(approved(NORTHBAY)).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

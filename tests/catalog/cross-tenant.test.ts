import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import { resolveForTenant } from '../../src/artifact/overrides.js';
import { validateArtifact } from '../../src/artifact/validate.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import { TEST_ENV } from '../helpers/replay-harness.js';

// Two institutions on the same product. Northbay calls members customers,
// renames the field and reorders the menu. One capability recorded on the base
// tenant has to either work there or fail in a way that says what's different,
// and be fixable with a small patch.

let variant: TargetHarness;
let surface: BrowserSurface;
let evidenceRoot: string;

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

const customerIdField = {
  role: 'textbox',
  editable: true,
  nearbyText: { mode: 'contains' as const, value: 'Customer ID' },
  framePath: ['mainFrame'],
};

const NORTHBAY = {
  northbay: {
    tenantId: 'northbay',
    note: 'Northbay calls members customers and reorders the menu. Same product, same flow.',
    steps: {
      open_search: {
        note: 'Menu item renamed; its check looked for the old field label.',
        target: {
          description: 'the customer search item in the menu frame',
          primary: { role: 'link', name: { mode: 'equals' as const, value: 'Customer Search' }, framePath: ['navFrame'] },
        },
        checkpoint: { kind: 'targetPresent' as const, target: { description: 'the customer id field', primary: customerIdField } },
      },
      enter_member_number: {
        note: 'Field label renamed.',
        target: { description: 'the customer id field', primary: customerIdField },
      },
    },
    extraSteps: [],
  },
};

const approved = (tenantOverrides = {}): CapabilityArtifact =>
  sampleArtifact({ approval: { state: 'approved', approvedBy: 'ops@example' }, tenantOverrides });

const run = (artifact: CapabilityArtifact, tenantId: string) =>
  replay({
    artifact,
    inputs: { memberNumber: '10021' },
    surface,
    evidenceRoot,
    tenantId,
    variables: { baseUrl: variant.baseUrl },
    env: TEST_ENV,
    screenshots: 'never',
  });

describe('one capability, two tenants', () => {
  it('degrades rather than breaking: the fallback copes with the menu, the check catches the field', async () => {
    const result = await run(approved(), 'base');
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    // `link "Member Search"` isn't there, but the fallback (a menu link containing
    // "Search") finds "Customer Search". The renamed field is what it can't
    // absorb, and the step's check says so.
    expect(result.error.category).toBe('checkpoint_failed');
    expect(result.error.stepId).toBe('open_search');
    expect(result.error.expected).toContain('member number entry field');
  });

  it('runs once the small per-tenant patch is applied', async () => {
    const result = await run(approved(NORTHBAY), 'northbay');
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs.savingsBalance).toBe(4182.55);
  });

  it('keeps the contract identical, so a caller sees one capability', () => {
    const artifact = approved(NORTHBAY);
    const base = resolveForTenant(artifact, 'base').artifact;
    const northbay = resolveForTenant(artifact, 'northbay');
    expect(northbay.artifact.inputs).toEqual(base.inputs);
    expect(northbay.artifact.outputs).toEqual(base.outputs);
    expect(northbay.artifact.outcomes).toEqual(base.outcomes);
    expect(northbay.patchedSteps).toEqual(['open_search', 'enter_member_number']);
    expect(validateArtifact(artifact).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

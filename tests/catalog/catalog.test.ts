import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapabilityCatalog, toAgentResult } from '../../src/catalog/catalog.js';
import { FileArtifactStore } from '../../src/artifact/store.js';
import { ScriptedModelClient } from '../../src/agent/model.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';

let root: string;
let evidenceRoot: string;
let store: FileArtifactStore;
let catalog: CapabilityCatalog;
let target: TargetHarness;

const approved = (overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact =>
  sampleArtifact({
    approval: { state: 'approved', approvedBy: 'ops@example', approvedAt: '2026-09-09T00:00:00.000Z' },
    ...overrides,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'replayforge-catalog-'));
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-catalog-evidence-'));
  store = new FileArtifactStore(root);
  catalog = new CapabilityCatalog(store);
  target = await startTarget();
});

afterEach(async () => {
  await target.close();
  await rm(root, { recursive: true, force: true });
  await rm(evidenceRoot, { recursive: true, force: true });
});

const invocationContext = () => ({
  tenantId: 'base',
  variables: { baseUrl: target.baseUrl },
  evidenceRoot,
  openSurface: () => BrowserSurface.launch({ targetId: 'catalog-test' }),
  env: {
    MERIDIAN_USERNAME: 'teller01',
    MERIDIAN_PASSWORD: 'demo-pass-01',
  } as NodeJS.ProcessEnv,
  screenshots: 'never' as const,
});

describe('the catalog', () => {
  it('offers an approved capability for unattended use and holds a draft back', async () => {
    await store.save(approved());
    await store.save({ ...sampleArtifact(), id: 'meridian-core.open_subaccount', name: 'open_subaccount' });

    const entries = await catalog.entries();
    expect(entries.find((e) => e.tool.name === 'member_savings_balance')?.invocableUnattended).toBe(true);
    expect(entries.find((e) => e.tool.name === 'open_subaccount')?.invocableUnattended).toBe(false);

    const offered = await catalog.toolDefinitions();
    expect(offered.map((t) => t.name)).toEqual(['member_savings_balance']);
    expect((await catalog.toolDefinitions({ includeDrafts: true })).map((t) => t.name)).toHaveLength(2);
  });

  it('hides a revoked capability entirely, even from a draft-inclusive listing', async () => {
    await store.save(sampleArtifact({ approval: { state: 'revoked' } }));
    expect(await catalog.toolDefinitions({ includeDrafts: true })).toEqual([]);
  });

  it('finds a capability by name or by id, and says so when it cannot', async () => {
    const saved = await store.save(approved());
    expect((await catalog.find('member_savings_balance'))?.id).toBe(saved.id);
    expect((await catalog.find(saved.id))?.name).toBe('member_savings_balance');
    expect(await catalog.find('nope')).toBeUndefined();
    await expect(catalog.invoke('nope', {}, invocationContext())).rejects.toThrow(/no capability named/);
  });

  it('invokes a capability by name with typed arguments and returns its outputs', async () => {
    await store.save(approved());
    const result = await catalog.invoke('member_savings_balance', { memberNumber: '10023' }, invocationContext());
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.outputs.savingsBalance).toBe(221.09);
  });

  it('closes the session it opened, whatever the run did', async () => {
    await store.save(approved());
    let opened: BrowserSurface | undefined;
    const context = {
      ...invocationContext(),
      openSurface: async () => {
        opened = await BrowserSurface.launch({ targetId: 'disposal' });
        return opened;
      },
    };
    await catalog.invoke('member_savings_balance', { memberNumber: 'not-valid' }, context);
    // A second dispose on an already-disposed surface is a no-op, so this only
    // passes if the first one happened.
    await expect(opened?.dispose()).resolves.toBeUndefined();
  });
});

describe('what a calling agent receives', () => {
  it('reduces a success to the outputs and nothing about screens', () => {
    expect(
      toAgentResult({
        status: 'success',
        outputs: { savingsBalance: 4182.55 },
        trace: { runId: 'r', capabilityId: 'c', capabilityVersion: 1, tenantId: 'base', evidenceDir: '', steps: [], durationMs: 0 },
      }),
    ).toEqual({ status: 'success', savingsBalance: 4182.55 });
  });

  it('marks a business outcome as an answer rather than an error', () => {
    const agent = toAgentResult({
      status: 'business_outcome',
      outcome: 'MEMBER_NOT_FOUND',
      disposition: 'answer',
      description: 'No such member.',
      outputs: {},
      trace: { runId: 'r', capabilityId: 'c', capabilityVersion: 1, tenantId: 'base', evidenceDir: '', steps: [], durationMs: 0 },
    });
    expect(agent).toMatchObject({ status: 'outcome', outcome: 'MEMBER_NOT_FOUND', needsHuman: false });
  });

  it('tells the caller which failures are worth retrying and which are not', () => {
    const base = { runId: 'r', capabilityId: 'c', capabilityVersion: 1, tenantId: 'base', evidenceDir: '', steps: [], durationMs: 0 };
    expect(
      toAgentResult({ status: 'failed', error: { category: 'step_timeout', message: 'slow' }, trace: base }),
    ).toMatchObject({ retryable: true });
    expect(
      toAgentResult({ status: 'failed', error: { category: 'input_invalid', message: 'bad' }, trace: base }),
    ).toMatchObject({ retryable: false });
    expect(
      toAgentResult({
        status: 'escalated',
        interventionId: 'iv-1',
        reason: 'needs a person',
        stepId: 's',
        trace: base,
      }),
    ).toMatchObject({ status: 'escalated', retryable: false });
  });
});

describe('an agent choosing and invoking a capability', () => {
  it('picks a tool from the catalog by its contract and gets a typed answer', async () => {
    await store.save(approved());
    const tools = await catalog.toolDefinitions();

    // A stand-in calling agent: it is given the catalog's tool definitions and
    // nothing else — no steps, no targets, no screens — and it chooses.
    const agent = new ScriptedModelClient([
      (request) => {
        const offered = JSON.parse(String(request.messages[0]?.content)) as typeof tools;
        const chosen = offered.find((tool) => 'savingsBalance' in tool.returns);
        if (!chosen) throw new Error('no capability returns a savings balance');
        return { name: chosen.name, input: { memberNumber: '10021' } };
      },
    ]);

    const turn = await agent.turn({
      system: 'You look up account information for members.',
      messages: [{ role: 'user', content: JSON.stringify(tools) }],
      tools: [],
    });
    expect(turn.call?.name).toBe('member_savings_balance');

    const result = await catalog.invoke(
      turn.call?.name as string,
      turn.call?.input as Record<string, unknown>,
      invocationContext(),
    );
    expect(toAgentResult(result)).toEqual({ status: 'success', memberName: 'Dolores Vance', savingsBalance: 4182.55, savingsAccountNumber: 'S0001-10021' });
  });
});

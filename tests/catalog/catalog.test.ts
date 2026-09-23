import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapabilityCatalog, toAgentResult } from '../../src/catalog/catalog.js';
import { FileArtifactStore } from '../../src/artifact/store.js';
import { ScriptedModelClient } from '../../src/agent/model.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import type { ReplayTrace } from '../../src/replay/result.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import { TEST_ENV } from '../helpers/replay-harness.js';

let root: string;
let evidenceRoot: string;
let store: FileArtifactStore;
let catalog: CapabilityCatalog;
let target: TargetHarness;

const approved = (overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact =>
  sampleArtifact({ approval: { state: 'approved', approvedBy: 'ops@example' }, ...overrides });

const trace: ReplayTrace = { runId: 'r', capabilityId: 'c', capabilityVersion: 1, tenantId: 'base', evidenceDir: '', steps: [], durationMs: 0 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'replayforge-catalog-'));
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-catalog-runs-'));
  store = new FileArtifactStore(root);
  catalog = new CapabilityCatalog(store);
  target = await startTarget();
});

afterEach(async () => {
  await target.close();
  await rm(root, { recursive: true, force: true });
  await rm(evidenceRoot, { recursive: true, force: true });
});

const context = () => ({
  tenantId: 'base',
  variables: { baseUrl: target.baseUrl },
  evidenceRoot,
  openSurface: () => BrowserSurface.launch({ targetId: 'catalog' }),
  env: TEST_ENV,
  screenshots: 'never' as const,
});

describe('the catalog', () => {
  it('offers approved capabilities, holds back drafts, and hides revoked ones', async () => {
    await store.save(approved());
    await store.save({ ...sampleArtifact(), id: 'meridian-core.draft_one', name: 'draft_one' });
    await store.save({ ...sampleArtifact({ approval: { state: 'revoked' } }), id: 'meridian-core.gone', name: 'gone' });
    expect((await catalog.toolDefinitions()).map((t) => t.name)).toEqual(['member_savings_balance']);
    expect((await catalog.toolDefinitions({ includeDrafts: true })).map((t) => t.name)).toEqual([
      'draft_one',
      'member_savings_balance',
    ]);
  });

  it('finds by name or id, and complains about an unknown one', async () => {
    const saved = await store.save(approved());
    expect((await catalog.find(saved.id))?.name).toBe('member_savings_balance');
    await expect(catalog.invoke('nope', {}, context())).rejects.toThrow(/no capability called/);
  });
});

describe('an agent calling a capability', () => {
  it('chooses a tool by its contract, calls it by name, and gets a typed answer', async () => {
    await store.save(approved());
    const tools = await catalog.toolDefinitions();
    // A stand-in agent that sees only the tool definitions.
    const agent = new ScriptedModelClient([
      (request) => {
        const offered = JSON.parse(request.messages[0]?.content ?? '[]') as typeof tools;
        const chosen = offered.find((tool) => 'savingsBalance' in tool.returns);
        if (!chosen) throw new Error('nothing returns a savings balance');
        return { name: chosen.name, input: { memberNumber: '10023' } };
      },
    ]);
    const turn = await agent.turn({ system: '', tools: [], messages: [{ role: 'user', content: JSON.stringify(tools) }] });
    const result = await catalog.invoke(turn.call?.name ?? '', turn.call?.input ?? {}, context());
    expect(toAgentResult(result)).toEqual({
      status: 'success',
      memberName: 'Priya Raman',
      savingsBalance: 221.09,
      savingsAccountNumber: 'S0003-10023',
    });
  });

  it('gets "no such member" back as an outcome rather than an error', async () => {
    await store.save(approved());
    const result = await catalog.invoke('member_savings_balance', { memberNumber: '99999' }, context());
    expect(toAgentResult(result)).toMatchObject({ status: 'outcome', outcome: 'MEMBER_NOT_FOUND', needsHuman: false });
  });
});

describe('what the agent is told', () => {
  it('says which failures are worth retrying', () => {
    expect(toAgentResult({ status: 'failed', error: { category: 'step_timeout', message: 'slow' }, trace })).toMatchObject({ retryable: true });
    expect(toAgentResult({ status: 'failed', error: { category: 'input_invalid', message: 'bad' }, trace })).toMatchObject({ retryable: false });
    expect(toAgentResult({ status: 'escalated', interventionId: 'iv', reason: 'person', stepId: 's', trace })).toMatchObject({
      status: 'escalated',
      retryable: false,
    });
  });
});

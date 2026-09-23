import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, type DiscoverOptions } from '../../src/agent/discover.js';
import { ScriptedModelClient, type ModelClient, type ScriptEntry } from '../../src/agent/model.js';
import { validateArtifact } from '../../src/artifact/validate.js';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import type { Surface } from '../../src/surface/types.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { controlNumber } from '../helpers/discovery-script.js';
import { FakeSurface, button } from '../helpers/fake-surface.js';
import { TEST_ENV } from '../helpers/replay-harness.js';

let target: TargetHarness;
let surface: BrowserSurface;
let evidenceRoot: string;

beforeEach(async () => {
  target = await startTarget();
  surface = await BrowserSurface.launch({ targetId: 'discovery-test' });
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-discovery-'));
});

afterEach(async () => {
  await surface.dispose();
  await target.close();
  await rm(evidenceRoot, { recursive: true, force: true });
});

const step = (pattern: RegExp, tool: string, extra: Record<string, unknown>): ScriptEntry => (r) => ({
  name: tool,
  input: { control: controlNumber(r, pattern), ...extra },
});

/** What a model does for the savings-balance goal, then the probe answer. */
function balanceScript(probePhrase = 'No records found for "99999".'): ScriptEntry[] {
  return [
    step(/labelled "User ID"/, 'type_text', { text: '{{core_username}}', intent: 'Type the user id.' }),
    step(/labelled "Password"/, 'type_text', { text: '{{core_password}}', intent: 'Type the password.' }),
    step(/button "Sign On"/, 'click', { intent: 'Sign on.' }),
    step(/link "Member Search"/, 'click', { intent: 'Open member search.' }),
    step(/labelled "Member Number"/, 'type_text', { text: '10021', intent: 'Type member number 10021.' }),
    step(/button "Search"/, 'click', { intent: 'Run the search.' }),
    step(/link "10021"/, 'click', { intent: 'Open the record for member 10021.' }),
    step(/link "Accounts"/, 'click', { intent: 'Open the accounts tab.' }),
    step(/row "Regular Savings", column "Current Balance"/, 'read_value', {
      key: 'savingsBalance',
      value_type: 'number',
      description: 'Regular Savings balance.',
      intent: 'Read the Regular Savings balance.',
    }),
    step(/row "Regular Savings", column "Account Number"/, 'read_value', {
      key: 'savingsAccountNumber',
      value_type: 'string',
      description: 'Regular Savings account number.',
      intent: 'Read the Regular Savings account number.',
    }),
    {
      name: 'finish',
      input: {
        summary: 'Looked up member 10021 and read their Regular Savings balance and account number.',
        outcomes: [
          { name: 'Member not found', description: 'No member has that number.', disposition: 'answer' },
          { name: 'Access denied', description: 'Not entitled to the record.', disposition: 'needs_human' },
        ],
      },
    },
    {
      name: 'name_outcome',
      input: {
        name: 'MEMBER_NOT_FOUND',
        description: 'the screen says so',
        when_text_contains: probePhrase,
        disposition: 'answer',
      },
    },
  ];
}

function options(model: ModelClient, overrides: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    goal: 'Look up member 10021 and read their Regular Savings balance and account number.',
    appDescription: 'Meridian Core, a credit union servicing console.',
    capabilityId: 'meridian-core.member_savings_balance',
    name: 'member_savings_balance',
    title: 'Look up a member’s regular savings balance',
    productId: 'meridian-core',
    tenantId: 'base',
    entryUrl: `${target.baseUrl}/`,
    bindings: { baseUrl: target.baseUrl },
    inputs: [
      {
        name: 'memberNumber',
        type: 'string',
        description: 'The member number.',
        sensitivity: 'internal',
        pattern: '^[0-9]{4,10}$',
        value: '10021',
        probeValue: '99999',
      },
    ],
    secrets: [
      { ref: 'core_username', envVar: 'MERIDIAN_USERNAME', description: 'User id.', placeholder: '{{core_username}}', value: 'teller01' },
      { ref: 'core_password', envVar: 'MERIDIAN_PASSWORD', description: 'Password.', placeholder: '{{core_password}}', value: 'demo-pass-01' },
    ],
    surface,
    model,
    evidenceRoot,
    screenshots: 'never',
    ...overrides,
  };
}

async function discovered() {
  const result = await discover(options(new ScriptedModelClient(balanceScript())));
  if (result.status !== 'discovered') throw new Error(`${result.status}: ${result.reason}`);
  return result;
}

describe('recording a capability', () => {
  it('produces a coherent capability with no selectors or credentials in it', async () => {
    const { artifact } = await discovered();
    expect(validateArtifact(artifact).filter((i) => i.severity === 'error')).toEqual([]);
    const file = JSON.stringify(artifact);
    expect(file).not.toMatch(/ctl00/);
    expect(file).not.toContain('demo-pass-01');
    expect(file).not.toContain('teller01');
  });

  it('turns typed credentials into secrets and the typed argument into a parameter', async () => {
    const { artifact } = await discovered();
    const types = artifact.steps.filter((s) => s.action.kind === 'type').map((s) => s.action.kind === 'type' && s.action.value);
    expect(types).toEqual([
      { kind: 'secret', ref: 'core_username' },
      { kind: 'secret', ref: 'core_password' },
      { kind: 'param', name: 'memberNumber' },
    ]);
    // The model describes what it just did, example member included. An agent
    // reading the tool description shouldn't think it's about member 10021.
    expect(artifact.description).toBe('Looked up member {{memberNumber}} and read their Regular Savings balance and account number.');
  });

  it('targets the result row by the searched value and reads the grid by row and column', async () => {
    const { artifact } = await discovered();
    const open = artifact.steps.find((s) => s.intent.startsWith('Open the record'));
    expect(open?.action.kind === 'click' && open.action.target.primary.name?.value).toBe('{{memberNumber}}');
    expect(open?.intent).toBe('Open the record for member {{memberNumber}}.');
    const balance = artifact.steps.find((s) => s.action.kind === 'read' && s.action.into === 'savingsBalance');
    expect(balance?.action.kind === 'read' && balance.action.target.primary.inTable).toEqual({
      rowContains: { mode: 'equals', value: 'Regular Savings' },
      column: 'Current Balance',
    });
    expect(artifact.outputs.find((o) => o.name === 'savingsBalance')?.type).toBe('number');
  });

  it('checks that typing landed, without writing a credential into the check', async () => {
    const { artifact } = await discovered();
    const checks = artifact.steps
      .filter((s) => s.action.kind === 'type')
      .map((s) => (s.checkpoint?.kind === 'targetPresent' ? s.checkpoint.target.primary.value : undefined));
    expect(checks).toEqual([
      { mode: 'regex', value: '.+' },
      { mode: 'regex', value: '.+' },
      { mode: 'equals', value: '{{memberNumber}}' },
    ]);
  });

  it('generalises the routes it visited', async () => {
    const { artifact } = await discovered();
    expect(artifact.policy.allowedRoutes).toContain('/content/member/*/accounts');
    expect(artifact.policy.allowedRoutes).not.toContain('/content/member/10021/accounts');
  });

  it('probes for the not-found screen and detects it by the app’s own wording', async () => {
    const { artifact, trace } = await discovered();
    const notFound = artifact.outcomes.find((o) => o.name === 'MEMBER_NOT_FOUND');
    expect(notFound?.when).toEqual({
      kind: 'textPresent',
      text: { mode: 'contains', value: 'No records found for "{{memberNumber}}".' },
    });
    // The model's own earlier description wins over the one it gave at the probe.
    expect(notFound?.description).toBe('No member has that number.');
    expect(artifact.outcomes.at(-1)?.name).toBe('HTTP_ERROR');
    const log = await readFile(join(trace.evidenceDir, 'run.jsonl'), 'utf8');
    expect(log).toContain('probe.outcome_added');
    expect(log).toContain('outcome.needs_detection');
  });

  it('rejects a probe phrase that isn’t actually on the screen', async () => {
    const result = await discover(options(new ScriptedModelClient(balanceScript('Record does not exist'))));
    if (result.status !== 'discovered') throw new Error(result.status);
    expect(result.artifact.outcomes.map((o) => o.name)).toEqual(['HTTP_ERROR']);
    expect(await readFile(join(result.trace.evidenceDir, 'run.jsonl'), 'utf8')).toContain('probe.rejected');
  });

  it('shows the model its own placeholder in a filled credential field', async () => {
    const model = new ScriptedModelClient(balanceScript());
    await discover(options(model));
    const second = model.requests[1]?.messages[0]?.content ?? '';
    expect(second).toContain('value="{{core_username}}"');
    expect(second).not.toContain('«secret');
    expect(second).toContain('Typed "{{core_username}}" into the textbox labelled "User ID"');
  });
});

describe('the recorded capability replays', () => {
  it('returns the right answer for another member in a fresh browser', async () => {
    const { artifact } = await discovered();
    const fresh = await BrowserSurface.launch({ targetId: 'fresh' });
    try {
      const result = await replay({
        artifact,
        inputs: { memberNumber: '10022' },
        surface: fresh,
        evidenceRoot,
        variables: { baseUrl: target.baseUrl },
        env: TEST_ENV,
        screenshots: 'never',
        riskyConfirmed: true,
      });
      if (result.status !== 'success') throw new Error(summariseResult(result));
      expect(result.outputs).toEqual({ savingsBalance: 58004.12, savingsAccountNumber: 'S0002-10022' });
      expect(result.trace.steps.every((s) => s.rung === undefined || s.rung === 'primary')).toBe(true);
    } finally {
      await fresh.dispose();
    }
  });

  it('answers MEMBER_NOT_FOUND for a member it never saw', async () => {
    const { artifact } = await discovered();
    const fresh = await BrowserSurface.launch({ targetId: 'fresh' });
    try {
      const result = await replay({
        artifact,
        inputs: { memberNumber: '88888' },
        surface: fresh,
        evidenceRoot,
        variables: { baseUrl: target.baseUrl },
        env: TEST_ENV,
        screenshots: 'never',
        riskyConfirmed: true,
      });
      expect(result.status === 'business_outcome' && result.outcome).toBe('MEMBER_NOT_FOUND');
    } finally {
      await fresh.dispose();
    }
  });
});

describe('keeping the loop on track', () => {
  const fake = (): FakeSurface =>
    new FakeSurface(
      {
        start: {
          name: 'start',
          url: 'http://app.test/start',
          nodes: [button('Post Account'), { ...button('Sign On') }],
          text: 'Review',
        },
      },
      'start',
    );

  const fakeOptions = (model: ModelClient, surfaceOverride: Surface, extra: Partial<DiscoverOptions> = {}) =>
    options(model, { surface: surfaceOverride, entryUrl: 'http://app.test/start', bindings: {}, inputs: [], secrets: [], ...extra });

  it('refuses an irreversible control and tells the model why', async () => {
    const model = new ScriptedModelClient([
      { name: 'click', input: { control: 1, intent: 'Post it.' } },
      { name: 'give_up', input: { reason: 'blocked' } },
    ]);
    const result = await discover(fakeOptions(model, fake()));
    expect(result.status).toBe('gave_up');
    expect(model.requests[1]?.messages[0]?.content).toContain('irreversible');
  });

  it('stops a model that keeps repeating the same step', async () => {
    const same = { name: 'click', input: { control: 2, intent: 'Sign on.' } };
    const result = await discover(fakeOptions(new ScriptedModelClient([same, same, same, same]), fake()));
    expect(result.status === 'failed' && result.reason).toContain('kept repeating');
  });

  it('tells the model when it gets a control wrong or leaves out the intent', async () => {
    const model = new ScriptedModelClient([
      { name: 'click', input: { control: 99, intent: 'Nothing there.' } },
      { name: 'click', input: { control: 2 } },
      { name: 'type_text', input: { control: 2, text: 'x', intent: 'Type into a button.' } },
      { name: 'teleport', input: { intent: 'No such tool.' } },
      { name: 'give_up', input: { reason: 'done' } },
    ]);
    await discover(fakeOptions(model, fake()));
    const results = model.requests.map((r) => r.messages[0]?.content ?? '');
    expect(results[1]).toContain('there is no control 99');
    expect(results[2]).toContain('needs an intent');
    expect(results[3]).toContain("can't be typed into");
    expect(results[4]).toContain('no tool called "teleport"');
  });

  it('won’t finish before doing anything', async () => {
    const model = new ScriptedModelClient([
      { name: 'finish', input: { summary: 'nothing', outcomes: [] } },
      { name: 'give_up', input: { reason: 'fine' } },
    ]);
    await discover(fakeOptions(model, fake()));
    expect(model.requests[1]?.messages[0]?.content).toContain('Nothing has been done yet');
  });

  it('gives up on a model that stops answering with actions', async () => {
    const silent: ModelClient = { modelId: 'silent', turn: async () => ({ raw: 'thinking...' }) };
    const result = await discover(fakeOptions(silent, fake()));
    expect(result.status === 'failed' && result.reason).toContain('stopped choosing actions');
  });

  it('stops at the step budget', async () => {
    const model = new ScriptedModelClient([
      { name: 'click', input: { control: 2, intent: 'a' } },
      { name: 'click', input: { control: 1, intent: 'b' } },
    ]);
    const result = await discover(fakeOptions(model, fake(), { maxSteps: 2, allowIrreversible: true }));
    expect(result.status === 'failed' && result.reason).toContain('used all 2 steps');
  });
});

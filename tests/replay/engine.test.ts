import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startReplayHarness, type ReplayHarness } from '../helpers/replay-harness.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import { isAnswer, summariseResult } from '../../src/replay/result.js';
import type { CapabilityArtifact, Step } from '../../src/artifact/schema.js';

// Replays against the real demo app in a real browser.

let harness: ReplayHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const approved = (overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact =>
  sampleArtifact({
    approval: { state: 'approved', approvedBy: 'ops@example', approvedAt: '2026-09-17T00:00:00.000Z' },
    ...overrides,
  });

/** The sample flow with one step swapped out. */
function withStep(id: string, change: (step: Step) => Step, extra: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return approved({ steps: sampleArtifact().steps.map((step) => (step.id === id ? change(step) : step)), ...extra });
}

const clickNothing = (description: string, name: string) => (step: Step): Step => ({
  ...step,
  action: {
    kind: 'click',
    target: { description, primary: { role: 'link', name: { mode: 'equals', value: name } } },
  },
  retries: { max: 0, backoffMs: 0 },
});

describe('the happy path', () => {
  it('replays the flow and returns typed outputs', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run();
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs).toEqual({
      memberName: 'Dolores Vance',
      savingsBalance: 4182.55,
      savingsAccountNumber: 'S0001-10021',
    });
    expect(isAnswer(result)).toBe(true);
    expect(result.trace.steps).toHaveLength(12);
    expect(result.trace.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('takes different arguments and gets different answers', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '10022' } });
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs.savingsBalance).toBe(58004.12);
    expect(result.outputs.memberName).toBe('Marcus Ifill');
  });

  it('takes the same steps and gets the same outputs on a second run', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const first = await harness.run();
    const second = await harness.run();
    if (first.status !== 'success' || second.status !== 'success') throw new Error('expected success twice');
    expect(second.outputs).toEqual(first.outputs);
    expect(second.trace.steps.map((s) => s.stepId)).toEqual(first.trace.steps.map((s) => s.stepId));
  });
});

describe('expected outcomes', () => {
  it('returns MEMBER_NOT_FOUND as an answer, not a failure', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '99999' } });
    if (result.status !== 'business_outcome') throw new Error(summariseResult(result));
    expect(result.outcome).toBe('MEMBER_NOT_FOUND');
    expect(result.disposition).toBe('answer');
    expect(isAnswer(result)).toBe(true);
  });

  it('catches the same outcome injected for a member who does exist', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('record-not-found');
    const result = await harness.run();
    expect(result.status === 'business_outcome' && result.outcome).toBe('MEMBER_NOT_FOUND');
  });

  it('escalates the outcomes that need a person', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const denied = await harness.run({ inputs: { memberNumber: '10024' } });
    expect(denied.status === 'escalated' && denied.reason).toContain('ACCESS_DENIED');

    await harness.inject('session-timeout', 2);
    const expired = await harness.run();
    expect(expired.status === 'escalated' && expired.reason).toContain('SESSION_EXPIRED');

    await harness.inject('server-error');
    const down = await harness.run();
    expect(down.status === 'escalated' && down.reason).toContain('CORE_UNAVAILABLE');
  });
});

describe('things a run may shrug off', () => {
  it('dismisses a known notice and carries on', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('interstitial');
    const result = await harness.run();
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.trace.steps.flatMap((s) => s.guardsFired)).toContain('dismiss-system-notice');
  });

  it('stops dismissing once the guard hits its cap', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('interstitial', 9);
    const result = await harness.run();
    expect(result.status === 'failed' && result.error.category).toBe('checkpoint_failed');
  });

  it('rides out a slow screen', async () => {
    harness = await startReplayHarness({ artifact: approved(), slowMs: 300 });
    await harness.inject('slow');
    expect((await harness.run()).status).toBe('success');
  });
});

describe('hard failures', () => {
  it('names the step, the expectation and what was on screen when a target is missing', async () => {
    harness = await startReplayHarness({
      artifact: withStep('open_search', clickNothing('a menu item this build does not have', 'Wire Transfers')),
    });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('target_unresolvable');
    expect(result.error.stepId).toBe('open_search');
    expect(result.error.message).toContain('a menu item this build does not have');
    expect(result.error.url).toBeDefined();
    expect(result.error.observed).toBeTruthy();
  });

  it('refuses to guess between several matching controls', async () => {
    harness = await startReplayHarness({
      artifact: withStep('open_search', (step) => ({
        ...step,
        action: {
          kind: 'click',
          target: { description: 'any link in the menu', primary: { role: 'link', framePath: ['navFrame'] } },
        },
      })),
    });
    const result = await harness.run();
    expect(result.status === 'failed' && result.error.category).toBe('target_ambiguous');
  });

  it('rejects bad or unexpected arguments before touching the app', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const bad = await harness.run({ inputs: { memberNumber: 'not-a-number' } });
    expect(bad.status === 'failed' && bad.error.category).toBe('input_invalid');
    expect(bad.trace.steps).toHaveLength(0);
    const extra = await harness.run({ inputs: { memberNumber: '10021', sneaky: 'x' } });
    expect(extra.status === 'failed' && extra.error.message).toContain("isn't a parameter");
  });

  it('stops when a credential is missing from the environment', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ env: {} as NodeJS.ProcessEnv });
    expect(result.status === 'failed' && result.error.category).toBe('configuration');
    expect(result.status === 'failed' && result.error.message).toContain('MERIDIAN_PASSWORD');
  });

  it('refuses a flow longer than its own step budget', async () => {
    harness = await startReplayHarness({ artifact: approved({ policy: { ...sampleArtifact().policy, maxSteps: 3 } }) });
    const result = await harness.run();
    expect(result.status === 'failed' && result.error.category).toBe('budget_exceeded');
  });
});

describe('guardrails', () => {
  it('won’t run a draft’s writing steps unattended', async () => {
    harness = await startReplayHarness({ artifact: sampleArtifact() });
    const result = await harness.run();
    if (result.status !== 'escalated') throw new Error(summariseResult(result));
    expect(result.reason).toContain('draft');
    expect(result.stepId).toBe('enter_user');
  });

  it('runs a draft when the caller confirms it', async () => {
    harness = await startReplayHarness({ artifact: sampleArtifact() });
    expect((await harness.run({ riskyConfirmed: true })).status).toBe('success');
  });

  it('blocks a step that goes off the allowed origin', async () => {
    harness = await startReplayHarness({
      artifact: withStep('open_console', (step) => ({
        ...step,
        action: { kind: 'navigate', url: { kind: 'literal', value: 'https://example.com/' } },
      })),
    });
    const result = await harness.run();
    expect(result.status === 'failed' && result.error.category).toBe('policy_blocked');
    expect(result.status === 'failed' && result.error.message).toContain('example.com');
  });

  it('blocks an action the capability’s policy leaves out', async () => {
    harness = await startReplayHarness({
      artifact: approved({
        policy: { ...sampleArtifact().policy, allowedActions: ['navigate', 'click', 'read', 'waitFor', 'pressKey'] },
      }),
    });
    const result = await harness.run();
    expect(result.status === 'failed' && result.error.category).toBe('policy_blocked');
    expect(result.status === 'failed' && result.error.message).toContain('"type"');
  });
});

describe('the run log', () => {
  it('writes an ordered log and a result file, with the password redacted', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run();
    const log = await readFile(join(result.trace.evidenceDir, 'run.jsonl'), 'utf8');
    const events = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.finished');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(log).not.toContain('demo-pass-01');
    expect(log).toContain('«secret:core_password»');
    const written = JSON.parse(await readFile(join(result.trace.evidenceDir, 'result.json'), 'utf8')) as { status: string };
    expect(written.status).toBe('success');
  });

  it('saves a screenshot when a step fails', async () => {
    harness = await startReplayHarness({
      artifact: withStep('open_search', clickNothing('a control that isn’t on this screen', 'Nowhere')),
    });
    const result = await harness.run({ screenshots: 'on-failure' });
    expect(result.status === 'failed' && result.error.screenshot).toMatch(/failure-open_search\.png$/);
  });
});

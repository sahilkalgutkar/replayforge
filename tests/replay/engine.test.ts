import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startReplayHarness, type ReplayHarness } from '../helpers/replay-harness.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import { summariseResult, isAnswer } from '../../src/replay/result.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';

let harness: ReplayHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Approved, since most of these exercise the production path rather than the gate. */
const approved = (overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact =>
  sampleArtifact({
    approval: { state: 'approved', approvedBy: 'ops@example', approvedAt: '2026-09-09T00:00:00.000Z' },
    ...overrides,
  });

describe('the happy path', () => {
  it('replays the recorded flow and returns typed outputs', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run();

    expect(summariseResult(result)).toContain('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.outputs).toEqual({
      memberName: 'Dolores Vance',
      savingsBalance: 4182.55,
      savingsAccountNumber: 'S0001-10021',
    });
    expect(isAnswer(result)).toBe(true);
  });

  it('parameterises the run, so a different member returns different values', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '10022' } });
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs.savingsBalance).toBe(58004.12);
    expect(result.outputs.memberName).toBe('Marcus Ifill');
  });

  it('records every step it took, with the targeting rung that resolved it', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run();
    expect(result.trace.steps).toHaveLength(12);
    expect(result.trace.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(result.trace.steps.find((s) => s.stepId === 'open_search')?.rung).toBe('primary');
  });

  it('produces the same steps and outputs on a second run', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const first = await harness.run();
    const second = await harness.run();
    if (first.status !== 'success' || second.status !== 'success') throw new Error('expected success');
    expect(second.outputs).toEqual(first.outputs);
    expect(second.trace.steps.map((s) => s.stepId)).toEqual(first.trace.steps.map((s) => s.stepId));
  });
});

describe('expected business outcomes', () => {
  it('returns MEMBER_NOT_FOUND as an answer rather than a failure', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '99999' } });

    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') throw new Error('expected an outcome');
    expect(result.outcome).toBe('MEMBER_NOT_FOUND');
    expect(result.disposition).toBe('answer');
    expect(isAnswer(result)).toBe(true);
  });

  it('detects an outcome injected mid-flow for a member that does exist', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('record-not-found');
    const result = await harness.run();
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') throw new Error('expected an outcome');
    expect(result.outcome).toBe('MEMBER_NOT_FOUND');
  });

  it('treats a permission denial as an outcome that needs a person', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '10024' } });
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') throw new Error('expected escalation');
    expect(result.reason).toContain('ACCESS_DENIED');
  });

  it('treats a session timeout as an outcome that needs a person', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('session-timeout', 2);
    const result = await harness.run();
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') throw new Error('expected escalation');
    expect(result.reason).toContain('SESSION_EXPIRED');
  });

  it('treats a core error page as an outcome that needs a person', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('server-error');
    const result = await harness.run();
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') throw new Error('expected escalation');
    expect(result.reason).toContain('CORE_UNAVAILABLE');
  });
});

describe('recoverable conditions', () => {
  it('dismisses a known interstitial and carries on', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('interstitial');
    const result = await harness.run();

    if (result.status !== 'success') throw new Error(summariseResult(result));
    const fired = result.trace.steps.flatMap((s) => s.guardsFired);
    expect(fired).toContain('dismiss-system-notice');
  });

  it('stops firing a guard once it hits its cap', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    await harness.inject('interstitial', 9);
    const result = await harness.run();
    // The notice keeps coming back; the guard is bounded, so the run fails
    // rather than looping on Acknowledge forever.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.category).toBe('checkpoint_failed');
  });

  it('rides out a slow screen through the step retry budget', async () => {
    harness = await startReplayHarness({ artifact: approved(), slowMs: 300 });
    await harness.inject('slow');
    const result = await harness.run();
    expect(result.status).toBe('success');
  });
});

describe('hard failures', () => {
  it('names the step, the expectation and the observation when a target vanishes', async () => {
    const broken = approved({
      steps: sampleArtifact().steps.map((s) =>
        s.id === 'open_search'
          ? {
              ...s,
              action: {
                kind: 'click' as const,
                target: {
                  description: 'a menu item that does not exist in this build',
                  primary: { role: 'link', name: { mode: 'equals' as const, value: 'Wire Transfers' } },
                },
              },
            }
          : s,
      ),
    });
    harness = await startReplayHarness({ artifact: broken });
    const result = await harness.run();

    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('target_unresolvable');
    expect(result.error.stepId).toBe('open_search');
    expect(result.error.message).toContain('a menu item that does not exist');
    expect(result.error.url).toBeDefined();
    expect(result.error.observed).toBeTruthy();
  });

  it('refuses to guess when a target matches several controls', async () => {
    const ambiguous = approved({
      steps: sampleArtifact().steps.map((s) =>
        s.id === 'open_search'
          ? {
              ...s,
              action: {
                kind: 'click' as const,
                target: {
                  description: 'any link in the menu frame',
                  primary: { role: 'link', framePath: ['navFrame'] },
                },
              },
            }
          : s,
      ),
    });
    harness = await startReplayHarness({ artifact: ambiguous });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('target_ambiguous');
    expect(result.error.message).toContain('declares no ordinal');
  });

  it('rejects bad arguments before touching the application', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: 'not-a-number' } });
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.category).toBe('input_invalid');
    expect(result.trace.steps).toHaveLength(0);
  });

  it('rejects an argument the contract does not declare', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ inputs: { memberNumber: '10021', sneaky: 'x' } });
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.message).toContain('not a parameter this capability declares');
  });

  it('stops when a credential this environment does not have is required', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run({ env: {} as NodeJS.ProcessEnv });
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.category).toBe('configuration');
    expect(result.error.message).toContain('MERIDIAN_PASSWORD');
  });

  it('refuses a capability whose step count exceeds its own budget', async () => {
    harness = await startReplayHarness({
      artifact: approved({ policy: { ...sampleArtifact().policy, maxSteps: 3 } }),
    });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.category).toBe('budget_exceeded');
  });

  it('reports a declared output that no screen produced', async () => {
    const base = sampleArtifact();
    const artifact = approved({
      steps: base.steps.map((s) =>
        s.id === 'read_savings_balance'
          ? {
              ...s,
              action: {
                ...s.action,
                target: {
                  description: 'the balance of an account type this member does not hold',
                  primary: {
                    role: 'cell' as const,
                    framePath: ['mainFrame'],
                    inTable: {
                      rowContains: { mode: 'equals' as const, value: 'Money Market' },
                      column: 'Current Balance',
                    },
                  },
                },
              },
              retries: { max: 0, backoffMs: 0 },
            }
          : s,
      ),
    });
    harness = await startReplayHarness({ artifact });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('target_unresolvable');
    expect(result.error.stepId).toBe('read_savings_balance');
  });
});

describe('guardrails during replay', () => {
  it('will not run a draft capability’s writing steps unattended', async () => {
    harness = await startReplayHarness({ artifact: sampleArtifact() });
    const result = await harness.run();
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') throw new Error('expected escalation');
    expect(result.reason).toContain('draft');
    expect(result.stepId).toBe('enter_user');
  });

  it('runs a draft capability when the caller confirms the risk explicitly', async () => {
    harness = await startReplayHarness({ artifact: sampleArtifact() });
    const result = await harness.run({ riskyConfirmed: true });
    expect(result.status).toBe('success');
  });

  it('blocks a step that navigates off the allowed origin', async () => {
    const base = sampleArtifact();
    const artifact = approved({
      steps: base.steps.map((s) =>
        s.id === 'open_console'
          ? { ...s, action: { kind: 'navigate' as const, url: { kind: 'literal' as const, value: 'https://example.com/' } } }
          : s,
      ),
    });
    harness = await startReplayHarness({ artifact });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('policy_blocked');
    expect(result.error.message).toContain('example.com');
  });

  it('blocks an action kind the capability policy omits', async () => {
    const artifact = approved({
      policy: {
        ...sampleArtifact().policy,
        allowedActions: ['navigate', 'click', 'read', 'waitFor', 'pressKey'],
      },
    });
    harness = await startReplayHarness({ artifact });
    const result = await harness.run();
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('policy_blocked');
    expect(result.error.message).toContain('"type"');
  });
});

describe('evidence', () => {
  it('writes an ordered, redacted trail plus a result file', async () => {
    harness = await startReplayHarness({ artifact: approved() });
    const result = await harness.run();
    const dir = result.trace.evidenceDir;

    const log = await readFile(join(dir, 'run.jsonl'), 'utf8');
    const events = log.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.finished');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // The service password was typed into the app but must not be in the trail.
    expect(log).not.toContain('demo-pass-01');
    expect(log).toContain('«secret:core_password»');

    const written = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { status: string };
    expect(written.status).toBe('success');
  });

  it('captures a screenshot when a step fails', async () => {
    const broken = approved({
      steps: sampleArtifact().steps.map((s) =>
        s.id === 'open_search'
          ? {
              ...s,
              action: {
                kind: 'click' as const,
                target: {
                  description: 'a control that is not on this screen',
                  primary: { role: 'link', name: { mode: 'equals' as const, value: 'Nowhere' } },
                },
              },
              retries: { max: 0, backoffMs: 0 },
            }
          : s,
      ),
    });
    harness = await startReplayHarness({ artifact: broken });
    const result = await harness.run({ screenshots: 'on-failure' });
    if (result.status !== 'failed') throw new Error('expected failure');
    expect(result.error.screenshot).toMatch(/failure-open_search\.png$/);
  });
});

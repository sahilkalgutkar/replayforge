import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import { UnattendedEscalationPort, type EscalationPort, type InterventionOutcome, type InterventionRequest } from '../../src/replay/escalation-port.js';
import { capabilityArtifactSchema, type CapabilityArtifact } from '../../src/artifact/schema.js';
import { FakeSurface, button, cell, type Screen } from '../helpers/fake-surface.js';

let evidenceRoot: string;

beforeEach(async () => {
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-edge-'));
});

afterEach(async () => {
  await rm(evidenceRoot, { recursive: true, force: true });
});

const SCREENS: Record<string, Screen> = {
  start: { name: 'start', url: 'http://app.test/start', nodes: [button('Go')], text: 'Start screen' },
  done: {
    name: 'done',
    url: 'http://app.test/done',
    nodes: [cell('All done'), button('Go')],
    text: 'All done',
  },
  notice: {
    name: 'notice',
    url: 'http://app.test/start',
    nodes: [button('Acknowledge'), button('Go')],
    text: 'System Notice',
  },
  offsite: { name: 'offsite', url: 'https://elsewhere.test/x', nodes: [cell('All done')], text: 'All done' },
};

/** A one-step capability: click Go, expect to land on "All done". */
function capability(overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return capabilityArtifactSchema.parse({
    schemaVersion: 1,
    id: 'test.one_step',
    version: 1,
    name: 'one_step',
    title: 'One step',
    description: 'Clicks Go and checks it landed.',
    app: {
      productId: 'test-product',
      surface: 'browser',
      entryUrl: 'http://app.test/start',
      bindingVariables: [],
      recordedOnTenant: 'base',
    },
    inputs: [],
    outputs: [],
    secrets: [],
    preconditions: [],
    steps: [
      {
        id: 'go',
        intent: 'Click the Go button.',
        action: {
          kind: 'click',
          target: {
            description: 'the Go button',
            primary: { role: 'button', name: { mode: 'equals', value: 'Go' } },
          },
        },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'All done' } },
        retries: { max: 0, backoffMs: 0 },
      },
    ],
    outcomes: [],
    successCheckpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'All done' } },
    policy: {
      allowedOrigins: ['http://app.test'],
      allowedRoutes: [],
      allowedActions: ['click', 'navigate', 'read', 'type', 'waitFor'],
      maxRiskWithoutApproval: 'safe',
      maxSteps: 10,
      maxDurationMs: 60_000,
    },
    approval: { state: 'approved', approvedBy: 'ops@example' },
    stability: { runs: 0, successes: 0, fallbackResolutions: 0 },
    tenantOverrides: {},
    provenance: {
      discoveredAt: '2026-09-09T00:00:00.000Z',
      discoveryRunId: 'fixture',
      model: 'fixture',
      promptVersion: 'fixture',
      humanEdits: [],
    },
    ...overrides,
  });
}

const goTransition = [{ when: (p: { kind: string }) => p.kind === 'click', to: 'done' }];

function surfaceFor(start = 'start'): FakeSurface {
  return new FakeSurface(SCREENS, start, goTransition);
}

class ScriptedOperator implements EscalationPort {
  readonly seen: InterventionRequest[] = [];
  constructor(
    private readonly outcome: InterventionOutcome,
    private readonly onRaise?: () => void,
  ) {}

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    this.seen.push(request);
    this.onRaise?.();
    return this.outcome;
  }
}

describe('surface failures', () => {
  it('reports a surface that throws mid-action as a surface error', async () => {
    const surface = surfaceFor();
    surface.throwOnNextPerform = 'the frame was detached';
    const result = await replay({ artifact: capability(), inputs: {}, surface, evidenceRoot });
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('surface_error');
    expect(result.error.message).toContain('detached');
  });

  it('gives up on a step that never settles, naming its own timeout', async () => {
    const surface = surfaceFor();
    surface.hangOnNextPerform = true;
    const artifact = capability({
      steps: capability().steps.map((s) => ({ ...s, timeoutMs: 60 })),
    });
    const result = await replay({ artifact, inputs: {}, surface, evidenceRoot });
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('step_timeout');
    expect(result.error.message).toContain('timed out after 60ms');
  });

  it('stops when the app navigates itself off the allowed surface', async () => {
    const surface = new FakeSurface(SCREENS, 'start', [
      { when: (p) => p.kind === 'click', to: 'offsite' },
    ]);
    const result = await replay({ artifact: capability(), inputs: {}, surface, evidenceRoot });
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('policy_blocked');
    expect(result.error.message).toContain('left the allowed surface');
  });

  it('runs out of wall-clock budget rather than running forever', async () => {
    const surface = surfaceFor();
    let clock = 0;
    const result = await replay({
      artifact: capability({ policy: { ...capability().policy, maxDurationMs: 5 } }),
      inputs: {},
      surface,
      evidenceRoot,
      now: () => (clock += 100),
    });
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.category).toBe('budget_exceeded');
  });
});

describe('preconditions', () => {
  it('refuses to start when the session is not where the capability expects', async () => {
    const artifact = capability({
      preconditions: [{ kind: 'textPresent', text: { mode: 'contains', value: 'Signed on' } }],
    });
    const result = await replay({ artifact, inputs: {}, surface: surfaceFor(), evidenceRoot });
    if (result.status !== 'failed') throw new Error(summariseResult(result));
    expect(result.error.message).toContain('precondition not met');
  });
});

describe('guards', () => {
  it('waits and re-observes', async () => {
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        guards: [
          {
            name: 'wait-out-the-notice',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'System Notice' } },
            then: { kind: 'wait', ms: 1 },
            maxFirings: 1,
          },
        ],
      })),
    });
    const surface = new FakeSurface(SCREENS, 'notice', [
      { when: (p) => p.kind === 'click', to: 'done' },
    ]);
    const result = await replay({ artifact, inputs: {}, surface, evidenceRoot });
    expect(result.status).toBe('success');
  });

  it('reloads the screen', async () => {
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        guards: [
          {
            name: 'reload-the-screen',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'System Notice' } },
            then: { kind: 'reload' },
            maxFirings: 1,
          },
        ],
      })),
    });
    const surface = new FakeSurface(SCREENS, 'notice', [
      { when: (p) => p.kind === 'click', to: 'done' },
    ]);
    const result = await replay({ artifact, inputs: {}, surface, evidenceRoot });
    expect(result.status).toBe('success');
    expect(surface.performed.some((p) => p.kind === 'navigate')).toBe(true);
  });

  it('does nothing when the condition it was written for has already cleared', async () => {
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        guards: [
          {
            name: 'dismiss-a-notice-that-is-not-there',
            // Fires on every screen, but its control only exists on the notice.
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'Start' } },
            then: {
              kind: 'click',
              target: {
                description: 'the Acknowledge button',
                primary: { role: 'button', name: { mode: 'equals', value: 'Acknowledge' } },
              },
            },
            maxFirings: 1,
          },
        ],
      })),
    });
    const surface = surfaceFor();
    const result = await replay({ artifact, inputs: {}, surface, evidenceRoot });
    expect(result.status).toBe('success');
  });
});

describe('drift', () => {
  it('reports a screen that no longer matches the recording without failing the run', async () => {
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        expectedFingerprint: 'a-fingerprint-from-an-older-build',
        expectedControls: ['Print Statement'],
      })),
    });
    const result = await replay({ artifact, inputs: {}, surface: surfaceFor(), evidenceRoot });
    expect(result.status).toBe('success');
    const step = result.trace.steps[0];
    expect(step?.drift?.missing).toEqual(['Print Statement']);
    expect(step?.drift?.expected).toBe('a-fingerprint-from-an-older-build');
  });
});

describe('escalation', () => {
  const draft = () => capability({ approval: { state: 'draft' } });

  it('carries the context an operator needs to act', async () => {
    const operator = new ScriptedOperator({ resolution: 'abort', note: 'not my call' });
    const artifact = draft();
    await replay({
      artifact: capabilityArtifactSchema.parse({
        ...artifact,
        steps: artifact.steps.map((s) => ({ ...s, risk: 'irreversible' })),
      }),
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
      screenshots: 'always',
    });

    const request = operator.seen[0];
    expect(request?.capabilityName).toBe('one_step');
    expect(request?.stepIntent).toBe('Click the Go button.');
    expect(request?.reason).toBe('needs_approval');
    expect(request?.location).toBe('http://app.test/start');
    expect(request?.screenshot).toBeDefined();
    expect(request?.screenText).toContain('Start screen');
  });

  it('treats the operator handing control back as approval for this invocation', async () => {
    const artifact = draft();
    const risky = capabilityArtifactSchema.parse({
      ...artifact,
      steps: artifact.steps.map((s) => ({ ...s, risk: 'sensitive' })),
    });
    let approved = false;
    const operator = new ScriptedOperator({ resolution: 'resume', humanActions: 2 }, () => {
      approved = true;
    });
    const result = await replay({
      artifact: risky,
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
      // The operator's sign-off stands in for the confirmation on resume.
      riskyConfirmed: false,
    });
    expect(approved).toBe(true);
    // The operator looked at the step and handed the session back, so the run
    // proceeds. Escalating the same step to the same person again would be the
    // only alternative, and it is not a useful one.
    expect(result.status).toBe('success');
    expect(operator.seen).toHaveLength(1);
  });

  it('stops when the operator declines instead of resuming', async () => {
    const artifact = draft();
    const risky = capabilityArtifactSchema.parse({
      ...artifact,
      steps: artifact.steps.map((s) => ({ ...s, risk: 'sensitive' })),
    });
    const operator = new ScriptedOperator({ resolution: 'abort', note: 'not authorised' });
    const result = await replay({
      artifact: risky,
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
    });
    expect(result.status).toBe('escalated');
  });

  it('escalates a target it cannot resolve when the step asks for a person', async () => {
    const operator = new ScriptedOperator({ resolution: 'abort' });
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        onFailure: 'escalate',
        action: {
          kind: 'click',
          target: {
            description: 'a button that is not on this screen',
            primary: { role: 'button', name: { mode: 'equals', value: 'Nowhere' } },
          },
        },
      })),
    });
    const result = await replay({
      artifact,
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
    });
    expect(result.status).toBe('escalated');
    expect(operator.seen[0]?.reason).toBe('target_unresolvable');
  });

  it('escalates a failed checkpoint when the step asks for a person', async () => {
    const operator = new ScriptedOperator({ resolution: 'abort' });
    const artifact = capability({
      steps: capability().steps.map((s) => ({
        ...s,
        onFailure: 'escalate',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Never appears' } },
      })),
    });
    const result = await replay({
      artifact,
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
    });
    expect(result.status).toBe('escalated');
    expect(operator.seen[0]?.reason).toBe('checkpoint_failed');
  });

  it('carries on when an operator actually clears a needs-human outcome', async () => {
    const artifact = capability({
      outcomes: [
        {
          name: 'SESSION_EXPIRED',
          description: 'The console signed us out.',
          when: { kind: 'textPresent', text: { mode: 'contains', value: 'Signed out' } },
          terminal: true,
          disposition: 'needs_human',
        },
      ],
    });
    const screens = {
      ...SCREENS,
      expired: { name: 'expired', url: 'http://app.test/start', nodes: [button('Go')], text: 'Signed out' },
    };
    const surface = new FakeSurface(screens, 'expired', goTransition);
    // The operator signs back in on the same live session, which is what makes
    // the condition go away.
    const operator = new ScriptedOperator({ resolution: 'resume', note: 'signed back in' }, () =>
      surface.goTo('start'),
    );

    const result = await replay({ artifact, inputs: {}, surface, evidenceRoot, escalation: operator });
    expect(result.status).toBe('success');
    expect(operator.seen[0]?.reason).toBe('business_outcome_needs_human');
  });

  it('does not loop when an operator resumes without clearing the condition', async () => {
    const artifact = capability({
      outcomes: [
        {
          name: 'SESSION_EXPIRED',
          description: 'The console signed us out.',
          when: { kind: 'textPresent', text: { mode: 'contains', value: 'Start screen' } },
          terminal: true,
          disposition: 'needs_human',
        },
      ],
    });
    const operator = new ScriptedOperator({ resolution: 'resume' });
    const result = await replay({
      artifact,
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: operator,
    });
    expect(result.status).toBe('escalated');
    expect(operator.seen).toHaveLength(1);
  });

  it('ends as escalated when no operator surface is attached', async () => {
    const port = new UnattendedEscalationPort();
    const artifact = draft();
    const result = await replay({
      artifact: capabilityArtifactSchema.parse({
        ...artifact,
        steps: artifact.steps.map((s) => ({ ...s, risk: 'irreversible' })),
      }),
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
      escalation: port,
    });
    expect(result.status).toBe('escalated');
    expect(port.requests()).toHaveLength(1);
    expect(summariseResult(result)).toContain('escalated at step go');
  });
});

describe('result summaries', () => {
  it('renders each status in one readable line', async () => {
    const success = await replay({
      artifact: capability(),
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
    });
    expect(summariseResult(success)).toBe('success — ');

    const failed = await replay({
      artifact: capability({
        steps: capability().steps.map((s) => ({
          ...s,
          checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Never' } },
        })),
      }),
      inputs: {},
      surface: surfaceFor(),
      evidenceRoot,
    });
    expect(summariseResult(failed)).toContain('failed [checkpoint_failed] at step go');
  });
});

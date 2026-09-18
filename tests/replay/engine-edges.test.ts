import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import {
  UnattendedEscalationPort,
  type EscalationPort,
  type InterventionOutcome,
  type InterventionRequest,
} from '../../src/replay/escalation-port.js';
import { capabilityArtifactSchema, type CapabilityArtifact, type Step } from '../../src/artifact/schema.js';
import { FakeSurface, button, cell, type Screen, type Transition } from '../helpers/fake-surface.js';

let evidenceRoot: string;

beforeEach(async () => {
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-edge-'));
});

afterEach(async () => {
  await rm(evidenceRoot, { recursive: true, force: true });
});

const SCREENS: Record<string, Screen> = {
  start: { name: 'start', url: 'http://app.test/start', nodes: [button('Go')], text: 'Start screen' },
  done: { name: 'done', url: 'http://app.test/done', nodes: [cell('All done'), button('Go')], text: 'All done' },
  notice: { name: 'notice', url: 'http://app.test/start', nodes: [button('Acknowledge'), button('Go')], text: 'System Notice' },
  offsite: { name: 'offsite', url: 'https://elsewhere.test/x', nodes: [cell('All done')], text: 'All done' },
  expired: { name: 'expired', url: 'http://app.test/start', nodes: [button('Go')], text: 'Signed out' },
};

const goToDone: Transition[] = [{ when: (p) => p.kind === 'click', to: 'done' }];

/** One step: click Go, expect "All done". */
function capability(overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return capabilityArtifactSchema.parse({
    schemaVersion: 1,
    id: 'test.one_step',
    version: 1,
    name: 'one_step',
    title: 'One step',
    description: 'Clicks Go and checks it landed.',
    app: { productId: 'test', surface: 'browser', entryUrl: 'http://app.test/start', recordedOnTenant: 'base' },
    steps: [
      {
        id: 'go',
        intent: 'Click the Go button.',
        action: {
          kind: 'click',
          target: { description: 'the Go button', primary: { role: 'button', name: { mode: 'equals', value: 'Go' } } },
        },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'All done' } },
        retries: { max: 0, backoffMs: 0 },
      },
    ],
    successCheckpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'All done' } },
    policy: {
      allowedOrigins: ['http://app.test'],
      allowedActions: ['click', 'navigate', 'read', 'type', 'waitFor'],
      maxRiskWithoutApproval: 'safe',
    },
    approval: { state: 'approved', approvedBy: 'ops@example' },
    provenance: { discoveredAt: '2026-09-17T00:00:00.000Z', discoveryRunId: 'x', model: 'x', promptVersion: 'x' },
    ...overrides,
  });
}

const stepsWith = (change: Partial<Step> | ((step: Step) => Step)): Step[] =>
  capability().steps.map((step) => (typeof change === 'function' ? change(step) : { ...step, ...change }));

const run = (artifact: CapabilityArtifact, surface: FakeSurface, extra: Partial<Parameters<typeof replay>[0]> = {}) =>
  replay({ artifact, inputs: {}, surface, evidenceRoot, ...extra });

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

describe('surface trouble', () => {
  it('reports a surface that throws mid-action', async () => {
    const surface = new FakeSurface(SCREENS, 'start', goToDone);
    surface.throwOnNextPerform = 'the frame was detached';
    const result = await run(capability(), surface);
    expect(result.status === 'failed' && result.error.category).toBe('surface_error');
  });

  it('gives up on a step that never finishes', async () => {
    const surface = new FakeSurface(SCREENS, 'start', goToDone);
    surface.hangOnNextPerform = true;
    const result = await run(capability({ steps: stepsWith({ timeoutMs: 60 }) }), surface);
    expect(result.status === 'failed' && result.error.category).toBe('step_timeout');
    expect(result.status === 'failed' && result.error.message).toContain('timed out after 60ms');
  });

  it('stops when the app wanders off the allowed origin', async () => {
    const surface = new FakeSurface(SCREENS, 'start', [{ when: (p) => p.kind === 'click', to: 'offsite' }]);
    const result = await run(capability(), surface);
    expect(result.status === 'failed' && result.error.category).toBe('policy_blocked');
  });

  it('stops when the wall-clock budget runs out', async () => {
    let clock = 0;
    const result = await run(
      capability({ policy: { ...capability().policy, maxDurationMs: 5 } }),
      new FakeSurface(SCREENS, 'start', goToDone),
      { now: () => (clock += 100) },
    );
    expect(result.status === 'failed' && result.error.category).toBe('budget_exceeded');
  });

  it('refuses to start when a precondition isn’t met', async () => {
    const result = await run(
      capability({ preconditions: [{ kind: 'textPresent', text: { mode: 'contains', value: 'Signed on' } }] }),
      new FakeSurface(SCREENS, 'start', goToDone),
    );
    expect(result.status === 'failed' && result.error.message).toContain('precondition not met');
  });
});

describe('guards', () => {
  const guarded = (then: Step['guards'][number]['then']) =>
    capability({
      steps: stepsWith((step) => ({
        ...step,
        guards: [
          {
            name: 'deal-with-notice',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'System Notice' } },
            then,
            maxFirings: 1,
          },
        ],
      })),
    });

  it('can wait and look again', async () => {
    const surface = new FakeSurface(SCREENS, 'notice', goToDone);
    expect((await run(guarded({ kind: 'wait', ms: 1 }), surface)).status).toBe('success');
  });

  it('can reload the screen', async () => {
    const surface = new FakeSurface(SCREENS, 'notice', goToDone);
    expect((await run(guarded({ kind: 'reload' }), surface)).status).toBe('success');
    expect(surface.performed.some((p) => p.kind === 'navigate')).toBe(true);
  });

  it('does nothing when the control it wants isn’t there', async () => {
    const surface = new FakeSurface(SCREENS, 'notice', goToDone);
    const result = await run(
      guarded({
        kind: 'click',
        target: { description: 'a Close button', primary: { role: 'button', name: { mode: 'equals', value: 'Close' } } },
      }),
      surface,
    );
    expect(result.status).toBe('success');
  });
});

describe('drift', () => {
  it('reports a changed screen without failing the run', async () => {
    const result = await run(
      capability({ steps: stepsWith({ expectedFingerprint: 'from-an-older-build', expectedControls: ['Print Statement'] }) }),
      new FakeSurface(SCREENS, 'start', goToDone),
    );
    expect(result.status).toBe('success');
    expect(result.trace.steps[0]?.drift?.missing).toEqual(['Print Statement']);
  });
});

describe('escalation', () => {
  const risky = (): CapabilityArtifact =>
    capability({ approval: { state: 'draft' }, steps: stepsWith({ risk: 'sensitive' }) });

  it('sends the person enough to act on', async () => {
    const operator = new ScriptedOperator({ resolution: 'abort' });
    await run(risky(), new FakeSurface(SCREENS, 'start', goToDone), { escalation: operator, screenshots: 'always' });
    const request = operator.seen[0];
    expect(request?.capabilityName).toBe('one_step');
    expect(request?.stepIntent).toBe('Click the Go button.');
    expect(request?.reason).toBe('needs_approval');
    expect(request?.location).toBe('http://app.test/start');
    expect(request?.screenshot).toBeDefined();
    expect(request?.screenText).toContain('Start screen');
  });

  it('treats a hand-back as approval for this call', async () => {
    const operator = new ScriptedOperator({ resolution: 'resume', operator: 'dana@ops' });
    const result = await run(risky(), new FakeSurface(SCREENS, 'start', goToDone), { escalation: operator });
    expect(result.status).toBe('success');
    expect(operator.seen).toHaveLength(1);
  });

  it('stops when the person declines', async () => {
    const operator = new ScriptedOperator({ resolution: 'abort', note: 'not authorised' });
    expect((await run(risky(), new FakeSurface(SCREENS, 'start', goToDone), { escalation: operator })).status).toBe(
      'escalated',
    );
  });

  it('escalates a missing target or a failed check when the step asks for a person', async () => {
    const lost = new ScriptedOperator({ resolution: 'abort' });
    await run(
      capability({
        steps: stepsWith((step) => ({
          ...step,
          onFailure: 'escalate',
          action: {
            kind: 'click',
            target: { description: 'Nowhere', primary: { role: 'button', name: { mode: 'equals', value: 'Nowhere' } } },
          },
        })),
      }),
      new FakeSurface(SCREENS, 'start', goToDone),
      { escalation: lost },
    );
    expect(lost.seen[0]?.reason).toBe('target_unresolvable');

    const unchecked = new ScriptedOperator({ resolution: 'abort' });
    await run(
      capability({
        steps: stepsWith({
          onFailure: 'escalate',
          checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Never appears' } },
        }),
      }),
      new FakeSurface(SCREENS, 'start', goToDone),
      { escalation: unchecked },
    );
    expect(unchecked.seen[0]?.reason).toBe('checkpoint_failed');
  });

  it('carries on when a person actually clears a needs-human outcome', async () => {
    const surface = new FakeSurface(SCREENS, 'expired', goToDone);
    const operator = new ScriptedOperator({ resolution: 'resume', note: 'signed back in' }, () => surface.goTo('start'));
    const result = await run(
      capability({
        outcomes: [
          {
            name: 'SESSION_EXPIRED',
            description: 'Signed out.',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'Signed out' } },
            disposition: 'needs_human',
          },
        ],
      }),
      surface,
      { escalation: operator },
    );
    expect(result.status).toBe('success');
  });

  it('doesn’t loop when a person resumes without fixing anything', async () => {
    const operator = new ScriptedOperator({ resolution: 'resume' });
    const result = await run(
      capability({
        outcomes: [
          {
            name: 'SESSION_EXPIRED',
            description: 'Signed out.',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'Start screen' } },
            disposition: 'needs_human',
          },
        ],
      }),
      new FakeSurface(SCREENS, 'start', goToDone),
      { escalation: operator },
    );
    expect(result.status).toBe('escalated');
    expect(operator.seen).toHaveLength(1);
  });

  it('ends as escalated when nobody is attached', async () => {
    const port = new UnattendedEscalationPort();
    const result = await run(risky(), new FakeSurface(SCREENS, 'start', goToDone), { escalation: port });
    expect(result.status).toBe('escalated');
    expect(port.requests()).toHaveLength(1);
    expect(summariseResult(result)).toContain('escalated at go');
  });
});

describe('summaries', () => {
  it('renders each status in a line', async () => {
    expect(summariseResult(await run(capability(), new FakeSurface(SCREENS, 'start', goToDone)))).toBe('success: ');
    const failed = await run(
      capability({ steps: stepsWith({ checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Never' } } }) }),
      new FakeSurface(SCREENS, 'start', goToDone),
    );
    expect(summariseResult(failed)).toContain('failed [checkpoint_failed] at go');
  });
});

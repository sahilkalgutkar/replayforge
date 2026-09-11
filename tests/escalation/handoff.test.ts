import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperatorConsole } from '../../src/escalation/console.js';
import { InterventionQueue } from '../../src/escalation/queue.js';
import { ControlLeaseError, LeasedSurface, SessionControl } from '../../src/escalation/lease.js';
import { replay } from '../../src/replay/engine.js';
import { summariseResult, type ReplayResult } from '../../src/replay/result.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { resolveTarget } from '../../src/surface/resolve.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';

let target: TargetHarness;
let surface: BrowserSurface;
let console_: Server;
let consoleUrl: string;
let control: SessionControl;
let queue: InterventionQueue;
let evidenceRoot: string;

beforeEach(async () => {
  target = await startTarget();
  surface = await BrowserSurface.launch({ targetId: 'handoff' });
  control = new SessionControl('handoff-session');
  queue = new InterventionQueue(control);
  const app = createOperatorConsole({ queue, control, surface, operator: 'dana@ops' });
  console_ = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  consoleUrl = `http://127.0.0.1:${(console_.address() as AddressInfo).port}`;
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-handoff-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => console_.close(() => resolve()));
  await surface.dispose();
  await target.close();
  await rm(evidenceRoot, { recursive: true, force: true });
});

const get = async (path: string): Promise<Response> => fetch(`${consoleUrl}${path}`);
const post = async (path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${consoleUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function waitForOpenIntervention(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = (await (await get('/api/interventions')).json()) as {
      interventions: { request: { id: string }; state: string }[];
    };
    const open = body.interventions.find((i) => i.state === 'open');
    if (open) return open.request.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no intervention was raised');
}

describe('escalation and live-session handoff', () => {
  it('stops, hands the live session to a person, and resumes on the same session', async () => {
    // A draft capability. Signing on types into a field, which is a sensitive
    // step, and a draft may not take one unattended.
    const artifact = sampleArtifact();
    const leased = new LeasedSurface(surface, control);

    const running: Promise<ReplayResult> = replay({
      artifact,
      inputs: { memberNumber: '10021' },
      surface: leased,
      evidenceRoot,
      variables: { baseUrl: target.baseUrl },
      env: {
        MERIDIAN_USERNAME: 'teller01',
        MERIDIAN_PASSWORD: 'demo-pass-01',
      } as NodeJS.ProcessEnv,
      escalation: queue,
      screenshots: 'never',
    });

    const id = await waitForOpenIntervention();

    // The request carries enough to act on without reading the code.
    const detail = queue.get(id)?.request;
    expect(detail?.capabilityName).toBe('member_savings_balance');
    expect(detail?.reason).toBe('needs_approval');
    expect(detail?.stepIntent).toContain('service user id');
    expect(detail?.location).toContain(target.baseUrl);

    // The console renders the live page as an image.
    const shot = await get(`/interventions/${id}/screen.png`);
    expect(shot.headers.get('content-type')).toContain('image/png');
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // Before taking control, the operator may not drive the session.
    expect((await post(`/interventions/${id}/act`, { kind: 'key', key: 'Tab' })).status).toBe(409);

    expect((await post(`/interventions/${id}/take`, { operator: 'dana@ops' })).status).toBe(200);
    expect(control.holder).toBe('human');

    // And now the automation may not, which is the other half of the lease.
    await expect(leased.perform({ kind: 'press', key: 'Tab' })).rejects.toThrow(ControlLeaseError);

    // The operator types into the same live page the run was looking at.
    const observation = await surface.observe();
    const field = resolveTarget(
      {
        description: 'the user id field',
        primary: { role: 'textbox', nearbyText: { mode: 'equals', value: 'User ID' } },
      },
      observation,
    );
    if (!field.ok) throw new Error('the operator could not find the user id field');
    const bounds = field.node.bounds as { x: number; y: number; width: number; height: number };
    const viewport = await surface.viewport();
    await post(`/interventions/${id}/act`, {
      kind: 'click',
      x: (bounds.x + bounds.width / 2) / viewport.width,
      y: (bounds.y + bounds.height / 2) / viewport.height,
    });
    await post(`/interventions/${id}/act`, { kind: 'type', text: 'operator-was-here' });

    // Proof it is the same session, not a fresh one: the run's own view of the
    // page shows what the person just typed.
    const afterTyping = await surface.observe();
    expect(afterTyping.nodes.some((n) => n.value === 'operator-was-here')).toBe(true);

    await post(`/interventions/${id}/act`, { kind: 'note', text: 'reviewed the sign-on screen' });

    const state = (await (await get(`/interventions/${id}/state`)).json()) as {
      actions: { kind: string; detail: string }[];
    };
    expect(state.actions.map((a) => a.kind)).toEqual(['click', 'type', 'note']);
    // What was typed is not in the trail — an operator signing in types a
    // credential, and this must not be where it ends up.
    expect(JSON.stringify(state.actions)).not.toContain('operator-was-here');

    expect((await post(`/interventions/${id}/resume`, { note: 'looks right' })).status).toBe(200);
    expect(control.holder).toBe('agent');

    const result = await running;
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs.savingsBalance).toBe(4182.55);

    // The handoff is in the evidence, not a gap in it.
    const log = await readFile(join(result.trace.evidenceDir, 'run.jsonl'), 'utf8');
    expect(log).toContain('escalation.raised');
    expect(log).toContain('escalation.resolved');
    expect(log).toContain('approval.granted_by_operator');
    expect(log).toContain('dana@ops');
    expect(log).toContain('reviewed the sign-on screen');
    expect(log).not.toContain('operator-was-here');

    // And the control ledger says who held the session, when, and why.
    expect(control.history().map((e) => e.holder)).toEqual(['agent', 'human', 'agent']);
  }, 90_000);

  it('ends the run as escalated when the operator aborts', async () => {
    const running: Promise<ReplayResult> = replay({
      artifact: sampleArtifact(),
      inputs: { memberNumber: '10021' },
      surface: new LeasedSurface(surface, control),
      evidenceRoot,
      variables: { baseUrl: target.baseUrl },
      env: {
        MERIDIAN_USERNAME: 'teller01',
        MERIDIAN_PASSWORD: 'demo-pass-01',
      } as NodeJS.ProcessEnv,
      escalation: queue,
      screenshots: 'never',
    });

    const id = await waitForOpenIntervention();
    await post(`/interventions/${id}/take`, { operator: 'dana@ops' });
    await post(`/interventions/${id}/abort`, { note: 'not authorised for this member' });

    const result = await running;
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') throw new Error('expected escalation');
    expect(result.interventionId).toBe(id);
    expect(control.holder).toBe('agent');
  }, 90_000);

  it('serves an operator index that lists the open request', async () => {
    const running = replay({
      artifact: sampleArtifact(),
      inputs: { memberNumber: '10021' },
      surface: new LeasedSurface(surface, control),
      evidenceRoot,
      variables: { baseUrl: target.baseUrl },
      env: {
        MERIDIAN_USERNAME: 'teller01',
        MERIDIAN_PASSWORD: 'demo-pass-01',
      } as NodeJS.ProcessEnv,
      escalation: queue,
      screenshots: 'never',
    });
    const id = await waitForOpenIntervention();

    const index = await (await get('/')).text();
    expect(index).toContain('member_savings_balance');
    expect(index).toContain('agent has control');

    const page = await (await get(`/interventions/${id}`)).text();
    expect(page).toContain('Take control');
    expect(page).toContain('Hand back and resume');
    expect(page).toContain('service user id');

    expect((await get('/interventions/does-not-exist')).status).toBe(404);
    expect((await get('/interventions/does-not-exist/state')).status).toBe(404);

    await post(`/interventions/${id}/abort`, {});
    await running;
  }, 90_000);
});

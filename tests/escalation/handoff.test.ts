import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { TEST_ENV } from '../helpers/replay-harness.js';

let target: TargetHarness;
let surface: BrowserSurface;
let server: Server;
let consoleUrl: string;
let control: SessionControl;
let queue: InterventionQueue;
let evidenceRoot: string;

beforeEach(async () => {
  target = await startTarget();
  surface = await BrowserSurface.launch({ targetId: 'handoff' });
  control = new SessionControl('handoff');
  queue = new InterventionQueue(control);
  const app = createOperatorConsole({ queue, control, surface, operator: 'dana@ops' });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  consoleUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-handoff-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await surface.dispose();
  await target.close();
  await rm(evidenceRoot, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${consoleUrl}${path}`);
const post = (path: string, body: unknown = {}) =>
  fetch(`${consoleUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function startRun(): Promise<ReplayResult> {
  // A draft: typing the user id is a sensitive step, so it stops for a person.
  return replay({
    artifact: sampleArtifact(),
    inputs: { memberNumber: '10021' },
    surface: new LeasedSurface(surface, control),
    evidenceRoot,
    variables: { baseUrl: target.baseUrl },
    env: TEST_ENV,
    escalation: queue,
    screenshots: 'never',
  });
}

async function openRequest(): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const open = queue.list().find((r) => r.state === 'open');
    if (open) return open.request.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no intervention was raised');
}

describe('handing the live session to a person', () => {
  it('stops, lets a person drive the same session, and carries on after hand-back', async () => {
    const running = startRun();
    const id = await openRequest();

    const request = queue.get(id)?.request;
    expect(request?.reason).toBe('needs_approval');
    expect(request?.stepIntent).toContain('service user id');
    expect(request?.location).toContain(target.baseUrl);

    const shot = await get(`/interventions/${id}/screen.png`);
    expect(shot.headers.get('content-type')).toContain('image/png');

    // Nobody has taken it yet, so nobody may drive.
    expect((await post(`/interventions/${id}/act`, { kind: 'key', key: 'Tab' })).status).toBe(409);
    expect((await post(`/interventions/${id}/take`, { operator: 'dana@ops' })).status).toBe(200);
    expect(control.holder).toBe('human');
    // And now the run may not.
    await expect(new LeasedSurface(surface, control).perform({ kind: 'press', key: 'Tab' })).rejects.toThrow(ControlLeaseError);

    const field = resolveTarget(
      { description: 'user id', primary: { role: 'textbox', nearbyText: { mode: 'equals', value: 'User ID' } } },
      await surface.observe(),
    );
    if (!field.ok) throw new Error('user id field not found');
    const box = field.node.bounds as { x: number; y: number; width: number; height: number };
    const { width, height } = await surface.viewport();
    await post(`/interventions/${id}/act`, { kind: 'click', x: (box.x + box.width / 2) / width, y: (box.y + box.height / 2) / height });
    await post(`/interventions/${id}/act`, { kind: 'type', text: 'person-was-here' });

    // Same session, not a new one: the run's own view shows what the person typed.
    expect((await surface.observe()).nodes.some((n) => n.value === 'person-was-here')).toBe(true);

    await post(`/interventions/${id}/act`, { kind: 'note', text: 'checked the sign-on screen' });
    const state = (await (await get(`/interventions/${id}/state`)).json()) as { actions: { kind: string }[] };
    expect(state.actions.map((a) => a.kind)).toEqual(['click', 'type', 'note']);
    expect(JSON.stringify(state.actions)).not.toContain('person-was-here');

    expect((await post(`/interventions/${id}/resume`, { note: 'fine' })).status).toBe(200);
    const result = await running;
    if (result.status !== 'success') throw new Error(summariseResult(result));
    expect(result.outputs.savingsBalance).toBe(4182.55);

    const log = await readFile(join(result.trace.evidenceDir, 'run.jsonl'), 'utf8');
    expect(log).toContain('escalation.raised');
    expect(log).toContain('approval.granted_by_operator');
    expect(log).toContain('dana@ops');
    expect(log).toContain('checked the sign-on screen');
    expect(log).not.toContain('person-was-here');
    expect(control.history().map((e) => e.holder)).toEqual(['agent', 'human', 'agent']);
  });

  it('ends the run as escalated when the person stops it', async () => {
    const running = startRun();
    const id = await openRequest();
    await post(`/interventions/${id}/take`);
    await post(`/interventions/${id}/abort`, { note: 'not for this member' });
    const result = await running;
    expect(result.status === 'escalated' && result.interventionId).toBe(id);
  });

  it('serves the index and the request page, and 404s unknown ones', async () => {
    const running = startRun();
    const id = await openRequest();
    expect(await (await get('/')).text()).toContain('member_savings_balance');
    const page = await (await get(`/interventions/${id}`)).text();
    expect(page).toContain('Take control');
    expect(page).toContain('Hand back and carry on');
    expect((await (await get('/api/interventions')).json()) as { holder: string }).toMatchObject({ holder: 'agent' });
    expect((await get('/interventions/nope')).status).toBe(404);
    expect((await get('/interventions/nope/state')).status).toBe(404);
    expect((await post('/interventions/nope/take')).status).toBe(409);
    expect((await post('/interventions/nope/resume')).status).toBe(409);
    expect((await post('/interventions/nope/abort')).status).toBe(409);
    await post(`/interventions/${id}/take`);
    expect((await post(`/interventions/${id}/act`, { kind: 'dance' })).status).toBe(400);
    await post(`/interventions/${id}/abort`);
    await running;
  });
});

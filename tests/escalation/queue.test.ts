import { describe, expect, it, vi } from 'vitest';
import { InterventionQueue } from '../../src/escalation/queue.js';
import { ControlLeaseError, LeasedSurface, SessionControl } from '../../src/escalation/lease.js';
import type { InterventionRequest } from '../../src/replay/escalation-port.js';
import { FakeSurface, button } from '../helpers/fake-surface.js';

function request(id = 'iv-1'): InterventionRequest {
  return {
    id,
    runId: 'run-1',
    capabilityId: 'meridian-core.member_savings_balance',
    capabilityName: 'member_savings_balance',
    tenantId: 'base',
    stepId: 'sign_on',
    stepIntent: 'Submit the sign-on form.',
    reason: 'needs_approval',
    detail: 'this step is sensitive',
    risk: 'sensitive',
    location: 'http://app.test/',
    screenText: 'Sign On',
    raisedAt: '2026-09-09T00:00:00.000Z',
  };
}

const surface = (): FakeSurface =>
  new FakeSurface(
    { only: { name: 'only', url: 'http://app.test/', nodes: [button('Go')] } },
    'only',
  );

describe('the control lease', () => {
  it('starts with the agent holding the session', () => {
    const control = new SessionControl('s');
    expect(control.holder).toBe('agent');
    expect(() => control.assert('agent')).not.toThrow();
    expect(() => control.assert('human')).toThrow(ControlLeaseError);
  });

  it('records who took control, when and why', () => {
    const control = new SessionControl('s');
    control.transferToHuman('dana@ops', 'sign-on needs approval');
    control.returnToAgent('dana@ops', 'resumed');
    expect(control.history().map((e) => `${e.holder}:${e.by}`)).toEqual([
      'agent:system',
      'human:dana@ops',
      'agent:dana@ops',
    ]);
    expect(control.history()[1]?.reason).toContain('needs approval');
  });

  it('locks the automation out of a session a person holds, but not out of watching', async () => {
    const control = new SessionControl('s');
    const leased = new LeasedSurface(surface(), control);
    await expect(leased.perform({ kind: 'press', key: 'Tab' })).resolves.toBeUndefined();

    control.transferToHuman('dana@ops', 'taking a look');
    await expect(leased.perform({ kind: 'press', key: 'Tab' })).rejects.toThrow(
      /human holds control/,
    );
    // Observing is not driving; the run needs to see what the person did.
    await expect(leased.observe()).resolves.toBeDefined();
    await expect(leased.screenshot()).resolves.toBeDefined();
    expect(await leased.location()).toBe('http://app.test/');
  });

  it('passes the inner surface’s identity and disposal through', async () => {
    const inner = surface();
    const leased = new LeasedSurface(inner, new SessionControl('s'));
    expect(leased.kind).toBe(inner.kind);
    expect(leased.targetId).toBe(inner.targetId);
    await expect(leased.dispose()).resolves.toBeUndefined();
  });
});

describe('the intervention queue', () => {
  it('blocks the run until someone resolves the request', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const settled = vi.fn();
    const waiting = queue.raise(request()).then(settled);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    queue.take('iv-1', 'dana@ops');
    queue.resume('iv-1', 'done');
    await waiting;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'resume', note: 'done', operator: 'dana@ops' }),
    );
  });

  it('moves control when an operator takes the session and back when they resume', async () => {
    const control = new SessionControl('s');
    const queue = new InterventionQueue(control);
    void queue.raise(request());

    queue.take('iv-1', 'dana@ops');
    expect(control.holder).toBe('human');
    queue.resume('iv-1');
    expect(control.holder).toBe('agent');
  });

  it('returns control on abort as well as on resume', async () => {
    const control = new SessionControl('s');
    const queue = new InterventionQueue(control);
    const waiting = queue.raise(request());
    queue.take('iv-1', 'dana@ops');
    queue.abort('iv-1', 'not authorised');
    expect(control.holder).toBe('agent');
    expect(await waiting).toMatchObject({ resolution: 'abort', note: 'not authorised' });
  });

  it('records what the operator did while holding the session', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const waiting = queue.raise(request());
    queue.take('iv-1', 'dana@ops');
    queue.record('iv-1', { at: 'now', kind: 'click', detail: 'clicked at 10,20' });
    const outcome = queue.resume('iv-1');
    expect(outcome).toMatchObject({ humanActions: 1 });
    await waiting;
    expect(queue.get('iv-1')?.actions).toHaveLength(1);
  });

  it('refuses to record actions for a request nobody has taken', () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    void queue.raise(request());
    expect(() => queue.record('iv-1', { at: 'now', kind: 'click', detail: 'x' })).toThrow(
      /not held by an operator/,
    );
  });

  it('refuses to take a request that is already resolved', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const waiting = queue.raise(request());
    queue.abort('iv-1');
    await waiting;
    expect(() => queue.take('iv-1', 'dana@ops')).toThrow(/already resolved/);
  });

  it('complains about an id it has never seen', () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    expect(() => queue.take('nope', 'dana@ops')).toThrow(/no intervention with id/);
    expect(queue.get('nope')).toBeUndefined();
  });

  it('ignores a second resolution rather than settling twice', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const waiting = queue.raise(request());
    queue.take('iv-1', 'dana@ops');
    queue.resume('iv-1', 'first');
    queue.abort('iv-1', 'second');
    expect(await waiting).toMatchObject({ resolution: 'resume', note: 'first' });
  });

  it('lets the run stop waiting without cancelling the request', async () => {
    const queue = new InterventionQueue(new SessionControl('s'), { waitMs: 30 });
    const outcome = await queue.raise(request());
    expect(outcome.resolution).toBe('unavailable');
    expect(outcome.note).toContain('remains open');
    // The request is still there for whoever eventually looks at the queue.
    expect(queue.get('iv-1')?.state).toBe('open');
    expect(queue.list()).toHaveLength(1);
  });
});

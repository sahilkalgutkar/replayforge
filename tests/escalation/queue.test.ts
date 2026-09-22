import { describe, expect, it, vi } from 'vitest';
import { InterventionQueue } from '../../src/escalation/queue.js';
import { ControlLeaseError, LeasedSurface, SessionControl } from '../../src/escalation/lease.js';
import type { InterventionRequest } from '../../src/replay/escalation-port.js';
import { FakeSurface, button } from '../helpers/fake-surface.js';

const request = (id = 'iv-1'): InterventionRequest => ({
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
  raisedAt: '2026-09-22T00:00:00.000Z',
});

const surface = () => new FakeSurface({ only: { name: 'only', url: 'http://app.test/', nodes: [button('Go')] } }, 'only');

describe('the control lease', () => {
  it('starts with the run in control and records every change', () => {
    const control = new SessionControl('s');
    expect(control.holder).toBe('agent');
    expect(() => control.assert('human')).toThrow(ControlLeaseError);
    control.transferToHuman('dana@ops', 'needs approval');
    control.returnToAgent('dana@ops', 'done');
    expect(control.history().map((e) => `${e.holder}:${e.by}`)).toEqual(['agent:system', 'human:dana@ops', 'agent:dana@ops']);
  });

  it('locks the run out while a person has the session, but still lets it watch', async () => {
    const control = new SessionControl('s');
    const leased = new LeasedSurface(surface(), control);
    await expect(leased.perform({ kind: 'press', key: 'Tab' })).resolves.toBeUndefined();
    control.transferToHuman('dana@ops', 'looking');
    await expect(leased.perform({ kind: 'press', key: 'Tab' })).rejects.toThrow(/human has control/);
    await expect(leased.observe()).resolves.toBeDefined();
    await expect(leased.screenshot()).resolves.toBeDefined();
    expect(await leased.location()).toBe('http://app.test/');
    expect(leased.kind).toBe('browser');
    await expect(leased.dispose()).resolves.toBeUndefined();
  });
});

describe('the intervention queue', () => {
  it('holds the run until someone resolves it, moving control both ways', async () => {
    const control = new SessionControl('s');
    const queue = new InterventionQueue(control);
    const settled = vi.fn();
    const waiting = queue.raise(request()).then(settled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    queue.take('iv-1', 'dana@ops');
    expect(control.holder).toBe('human');
    queue.record('iv-1', { at: 'now', kind: 'note', detail: 'checked it' });
    queue.resume('iv-1', 'fine');
    expect(control.holder).toBe('agent');
    await waiting;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'resume', note: 'fine', operator: 'dana@ops', humanActions: 1 }),
    );
  });

  it('hands control back on abort too', async () => {
    const control = new SessionControl('s');
    const queue = new InterventionQueue(control);
    const waiting = queue.raise(request());
    queue.take('iv-1', 'dana@ops');
    queue.abort('iv-1', 'not authorised');
    expect(control.holder).toBe('agent');
    expect(await waiting).toMatchObject({ resolution: 'abort', note: 'not authorised' });
  });

  it('refuses actions nobody is holding, taking a resolved request, and unknown ids', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const waiting = queue.raise(request());
    expect(() => queue.record('iv-1', { at: 'now', kind: 'click', detail: 'x' })).toThrow(/isn't held/);
    queue.abort('iv-1');
    await waiting;
    expect(() => queue.take('iv-1', 'dana@ops')).toThrow(/already resolved/);
    expect(() => queue.take('nope', 'dana@ops')).toThrow(/no intervention/);
    expect(queue.get('nope')).toBeUndefined();
  });

  it('settles only once', async () => {
    const queue = new InterventionQueue(new SessionControl('s'));
    const waiting = queue.raise(request());
    queue.take('iv-1', 'dana@ops');
    queue.resume('iv-1', 'first');
    queue.abort('iv-1', 'second');
    expect(await waiting).toMatchObject({ resolution: 'resume', note: 'first' });
  });

  it('lets the run stop waiting while the request stays open', async () => {
    const queue = new InterventionQueue(new SessionControl('s'), { waitMs: 30 });
    const outcome = await queue.raise(request());
    expect(outcome.resolution).toBe('unavailable');
    expect(queue.get('iv-1')?.state).toBe('open');
    expect(queue.list()).toHaveLength(1);
  });
});

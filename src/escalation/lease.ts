import type { Observation, Primitive, Surface } from '../surface/types.js';

// Who is driving the session. During a handoff the run and the person both have
// hold of the same live browser, so without an explicit holder nothing stops a
// retry from clicking while someone is halfway through typing. This makes
// acting out of turn an error instead of a race.

export type ControlHolder = 'agent' | 'human';

export interface ControlEvent {
  readonly at: string;
  readonly holder: ControlHolder;
  readonly by: string;
  readonly reason: string;
}

export class ControlLeaseError extends Error {
  constructor(attempted: ControlHolder, holder: ControlHolder) {
    super(`${attempted} tried to act while ${holder} has control of the session`);
    this.name = 'ControlLeaseError';
  }
}

export class SessionControl {
  private current: ControlHolder = 'agent';
  private readonly log: ControlEvent[] = [
    { at: new Date().toISOString(), holder: 'agent', by: 'system', reason: 'session opened' },
  ];

  constructor(readonly sessionId: string) {}

  get holder(): ControlHolder {
    return this.current;
  }

  history(): readonly ControlEvent[] {
    return this.log;
  }

  transferToHuman(by: string, reason: string): void {
    this.current = 'human';
    this.log.push({ at: new Date().toISOString(), holder: 'human', by, reason });
  }

  returnToAgent(by: string, reason: string): void {
    this.current = 'agent';
    this.log.push({ at: new Date().toISOString(), holder: 'agent', by, reason });
  }

  assert(holder: ControlHolder): void {
    if (this.current !== holder) throw new ControlLeaseError(holder, this.current);
  }
}

/**
 * Stops the run acting while a person has the session. Watching is still
 * allowed, since the run has to see what the person did in order to carry on.
 */
export class LeasedSurface implements Surface {
  readonly kind: Surface['kind'];
  readonly targetId: string;

  constructor(
    private readonly inner: Surface,
    private readonly control: SessionControl,
  ) {
    this.kind = inner.kind;
    this.targetId = inner.targetId;
  }

  async observe(): Promise<Observation> {
    return this.inner.observe();
  }

  async perform(primitive: Primitive): Promise<void> {
    this.control.assert('agent');
    return this.inner.perform(primitive);
  }

  async screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }

  async location(): Promise<string> {
    return this.inner.location();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

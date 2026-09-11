import type { Observation, Primitive, Surface } from '../surface/types.js';

/**
 * Who is driving the session.
 *
 * A handoff is not "the automation pauses and hopes". Both the agent and the
 * operator hold references to the same live browser context, so without an
 * explicit holder there is nothing stopping a retry timer from clicking while a
 * person is halfway through typing. The lease makes the question answerable at
 * any instant, and makes acting out of turn an error rather than a race.
 *
 * It is deliberately not a mutex. A mutex says "wait"; this says "you are not
 * the one in control", which is the thing an automated caller needs to be told.
 */

export type ControlHolder = 'agent' | 'human';

export interface ControlEvent {
  readonly at: string;
  readonly holder: ControlHolder;
  readonly by: string;
  readonly reason: string;
}

export class ControlLeaseError extends Error {
  constructor(attempted: ControlHolder, holder: ControlHolder) {
    super(
      `${attempted} tried to act on this session while ${holder} holds control; the run must wait for control to be handed back`,
    );
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

  transferToHuman(operator: string, reason: string): void {
    this.current = 'human';
    this.log.push({ at: new Date().toISOString(), holder: 'human', by: operator, reason });
  }

  returnToAgent(operator: string, reason: string): void {
    this.current = 'agent';
    this.log.push({ at: new Date().toISOString(), holder: 'agent', by: operator, reason });
  }

  assert(holder: ControlHolder): void {
    if (this.current !== holder) throw new ControlLeaseError(holder, this.current);
  }
}

/**
 * Wraps a surface so the automation cannot act while a person holds control.
 * Observation stays open to both sides on purpose — watching is not driving,
 * and the run needs to see what the operator did in order to resume from it.
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

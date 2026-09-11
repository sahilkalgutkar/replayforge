import type { Observation, Primitive, Surface, UiNode } from '../../src/surface/types.js';
import { fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from './nodes.js';

/**
 * A scripted Surface.
 *
 * The browser-backed integration tests prove the engine works against a real
 * application. This one exists to reach the paths a real application will not
 * produce on demand — a frame that hangs, a surface that throws mid-action, an
 * operator who resumes a run — without waiting on a browser to do it.
 */
export interface Screen {
  readonly name: string;
  readonly url: string;
  readonly nodes: readonly UiNode[];
  readonly text?: string;
  readonly httpStatus?: number;
  readonly fingerprint?: string;
}

export interface Transition {
  readonly when: (primitive: Primitive) => boolean;
  readonly to: string;
}

export class FakeSurface implements Surface {
  readonly kind = 'browser' as const;
  readonly targetId = 'fake';
  readonly performed: Primitive[] = [];
  observations = 0;

  private current: string;
  /** Set to make the next perform throw, to exercise the surface_error path. */
  throwOnNextPerform: string | undefined;
  /** Set to make the next perform never settle, to exercise the timeout path. */
  hangOnNextPerform = false;

  constructor(
    private readonly screens: Readonly<Record<string, Screen>>,
    start: string,
    private readonly transitions: readonly Transition[] = [],
  ) {
    this.current = start;
  }

  goTo(screen: string): void {
    this.current = screen;
  }

  get screenName(): string {
    return this.current;
  }

  async observe(): Promise<Observation> {
    this.observations += 1;
    const screen = this.screens[this.current];
    if (!screen) throw new Error(`fake surface has no screen "${this.current}"`);
    return {
      observationId: `obs-${this.observations}`,
      capturedAt: new Date().toISOString(),
      url: screen.url,
      title: screen.name,
      frames: [{ path: [], url: screen.url }],
      nodes: screen.nodes,
      text: screen.text ?? '',
      screenFingerprint: screen.fingerprint ?? fingerprintNodes(screen.nodes),
      ...(screen.httpStatus === undefined ? {} : { httpStatus: screen.httpStatus }),
    };
  }

  async perform(primitive: Primitive): Promise<void> {
    if (this.hangOnNextPerform) {
      this.hangOnNextPerform = false;
      await new Promise(() => undefined);
    }
    if (this.throwOnNextPerform !== undefined) {
      const message = this.throwOnNextPerform;
      this.throwOnNextPerform = undefined;
      throw new Error(message);
    }
    this.performed.push(primitive);
    const transition = this.transitions.find((t) => t.when(primitive));
    if (transition) this.current = transition.to;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }

  async location(): Promise<string> {
    return this.screens[this.current]?.url ?? '';
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

export const button = (name: string): UiNode => node({ role: 'button', name });
export const textbox = (label: string): UiNode =>
  node({ role: 'textbox', editable: true, nearbyText: label });
export const cell = (text: string): UiNode => node({ role: 'cell', name: text, text });

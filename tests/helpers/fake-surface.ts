import type { Observation, Primitive, Surface, UiNode } from '../../src/surface/types.js';
import { fingerprintNodes } from '../../src/surface/fingerprint.js';
import { node } from './nodes.js';

// A scripted surface for the cases a real app won't produce on demand: a step
// that hangs, a surface that throws, a person resuming a run.

export interface Screen {
  readonly name: string;
  readonly url: string;
  readonly nodes: readonly UiNode[];
  readonly text?: string;
  readonly httpStatus?: number;
}

export interface Transition {
  readonly when: (primitive: Primitive) => boolean;
  readonly to: string;
}

export class FakeSurface implements Surface {
  readonly kind = 'browser' as const;
  readonly targetId = 'fake';
  readonly performed: Primitive[] = [];
  throwOnNextPerform: string | undefined;
  hangOnNextPerform = false;
  private current: string;

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

  async observe(): Promise<Observation> {
    const screen = this.screens[this.current];
    if (!screen) throw new Error(`no screen "${this.current}"`);
    return {
      observationId: `obs-${this.performed.length}`,
      capturedAt: new Date().toISOString(),
      url: screen.url,
      title: screen.name,
      frames: [{ path: [], url: screen.url }],
      nodes: screen.nodes,
      text: screen.text ?? '',
      screenFingerprint: fingerprintNodes(screen.nodes),
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

  async dispose(): Promise<void> {}
}

export const button = (name: string): UiNode => node({ role: 'button', name });
export const cell = (text: string): UiNode => node({ role: 'cell', name: text, text });

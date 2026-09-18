import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redactor } from '../policy/redactor.js';

// The log for one run. Events are appended as they happen, so a run that gets
// killed still leaves everything up to the point it stopped, which is the run
// you most want the log for.
//
// Everything goes through the redactor first. Screenshots are the exception
// and can't be fixed that way: a capture of a member's record contains the
// record. So they default to failures only.

export type ScreenshotPolicy = 'always' | 'on-failure' | 'never';

export interface RunEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export class RunRecorder {
  private seq = 0;
  private readonly events: RunEvent[] = [];

  private constructor(
    readonly runId: string,
    readonly directory: string,
    private readonly redactor: Redactor,
    private readonly screenshots: ScreenshotPolicy,
  ) {}

  static async open(
    root: string,
    runId: string,
    redactor: Redactor,
    screenshots: ScreenshotPolicy = 'on-failure',
  ): Promise<RunRecorder> {
    const directory = join(root, runId);
    await mkdir(directory, { recursive: true });
    return new RunRecorder(runId, directory, redactor, screenshots);
  }

  async event(type: string, payload: Record<string, unknown> = {}): Promise<RunEvent> {
    this.seq += 1;
    const event: RunEvent = {
      seq: this.seq,
      at: new Date().toISOString(),
      type,
      ...this.redactor.redactDeep(payload),
    };
    this.events.push(event);
    await appendFile(join(this.directory, 'run.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  /** Saves a screenshot if the policy allows it for this kind of moment. */
  async screenshot(
    name: string,
    capture: () => Promise<Buffer>,
    reason: 'step' | 'failure' | 'escalation',
  ): Promise<string | undefined> {
    if (this.screenshots === 'never') return undefined;
    if (this.screenshots === 'on-failure' && reason === 'step') return undefined;
    const file = `${String(this.seq).padStart(3, '0')}-${name}.png`;
    await writeFile(join(this.directory, file), await capture());
    await this.event('evidence.screenshot', { file, reason });
    return file;
  }

  async writeJson(name: string, value: unknown): Promise<string> {
    const file = `${name}.json`;
    await writeFile(
      join(this.directory, file),
      `${JSON.stringify(this.redactor.redactDeep(value), null, 2)}\n`,
      'utf8',
    );
    return file;
  }

  history(): readonly RunEvent[] {
    return this.events;
  }
}

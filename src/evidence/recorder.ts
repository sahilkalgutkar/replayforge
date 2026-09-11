import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redactor } from '../policy/redactor.js';

/**
 * The evidence trail for one run.
 *
 * Every event is appended to a JSON Lines file as it happens, so a run that
 * crashes or is killed still leaves everything up to the moment it stopped —
 * which is the run whose evidence matters most.
 *
 * Everything written passes through the redactor first. Screenshots are the
 * exception and cannot be fixed by redaction: a capture of a member record
 * contains the record. So captures default to failure-only, the setting is
 * explicit rather than implied, and the trade-off is stated where an operator
 * configuring it will read it.
 */

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

  /**
   * Writes a screenshot when the policy allows it. `reason` distinguishes a
   * routine step capture from a failure capture, since the default policy keeps
   * only the latter.
   */
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

  /** In-memory copy of everything written, for assertions and for the CLI. */
  history(): readonly RunEvent[] {
    return this.events;
  }
}

import type {
  EscalationPort,
  HumanAction,
  InterventionOutcome,
  InterventionRequest,
} from '../replay/escalation-port.js';
import { SessionControl } from './lease.js';

/**
 * Open intervention requests, and the promise each blocked run is waiting on.
 *
 * The run does not poll and does not time itself out by default: a step that
 * needed a person is not made safe by giving up on the person. The caller can
 * set a wait, and when it lapses the request stays open — the run ends as
 * escalated with an intervention id someone can still act on, rather than the
 * request evaporating with the process.
 */

export type InterventionState = 'open' | 'held' | 'resolved';

export interface InterventionRecord {
  readonly request: InterventionRequest;
  state: InterventionState;
  operator?: string;
  readonly actions: HumanAction[];
  readonly resolution?: InterventionOutcome['resolution'];
}

interface Pending extends InterventionRecord {
  settle: (outcome: InterventionOutcome) => void;
  settled: boolean;
}

export interface InterventionQueueOptions {
  /** How long a run waits for a person before continuing as escalated. */
  readonly waitMs?: number;
}

export class InterventionQueue implements EscalationPort {
  private readonly records = new Map<string, Pending>();
  private readonly waitMs: number;

  constructor(
    readonly control: SessionControl,
    options: InterventionQueueOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 0;
  }

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    let settle!: (outcome: InterventionOutcome) => void;
    const decided = new Promise<InterventionOutcome>((resolve) => {
      settle = resolve;
    });

    const record: Pending = {
      request,
      state: 'open',
      actions: [],
      settle: (outcome) => {
        if (record.settled) return;
        record.settled = true;
        record.state = 'resolved';
        settle(outcome);
      },
      settled: false,
    };
    this.records.set(request.id, record);

    if (this.waitMs <= 0) return decided;

    const timeout = new Promise<InterventionOutcome>((resolve) => {
      setTimeout(() => {
        // The request is not cancelled — it stays open for an operator. Only
        // this run stops waiting.
        resolve({
          resolution: 'unavailable',
          note: `no operator took this request within ${this.waitMs}ms; it remains open as ${request.id}`,
        });
      }, this.waitMs).unref?.();
    });

    return Promise.race([decided, timeout]);
  }

  list(): readonly InterventionRecord[] {
    return [...this.records.values()].map(({ settle: _settle, settled: _settled, ...rest }) => rest);
  }

  get(id: string): InterventionRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const { settle: _settle, settled: _settled, ...rest } = record;
    return rest;
  }

  /** An operator takes the session. Control moves; the automation is locked out. */
  take(id: string, operator: string): InterventionRecord {
    const record = this.require(id);
    if (record.state === 'resolved') throw new Error(`intervention ${id} is already resolved`);
    record.state = 'held';
    record.operator = operator;
    this.control.transferToHuman(operator, `intervention ${id}: ${record.request.detail}`);
    return record;
  }

  record(id: string, action: HumanAction): void {
    const record = this.require(id);
    if (record.state !== 'held') {
      throw new Error(`intervention ${id} is not held by an operator, so it cannot record actions`);
    }
    record.actions.push(action);
  }

  /** Hands control back and unblocks the run. */
  resume(id: string, note?: string): InterventionOutcome {
    const record = this.require(id);
    const operator = record.operator ?? 'unknown operator';
    if (record.state === 'held') this.control.returnToAgent(operator, `intervention ${id} resumed`);
    const outcome: InterventionOutcome = {
      resolution: 'resume',
      ...(note ? { note } : {}),
      humanActions: record.actions.length,
      actions: [...record.actions],
      operator,
    };
    record.settle(outcome);
    return outcome;
  }

  abort(id: string, note?: string): InterventionOutcome {
    const record = this.require(id);
    const operator = record.operator ?? 'unknown operator';
    if (record.state === 'held') this.control.returnToAgent(operator, `intervention ${id} aborted`);
    const outcome: InterventionOutcome = { resolution: 'abort', ...(note ? { note } : {}) };
    record.settle(outcome);
    return outcome;
  }

  private require(id: string): Pending {
    const record = this.records.get(id);
    if (!record) throw new Error(`no intervention with id ${id}`);
    return record;
  }
}

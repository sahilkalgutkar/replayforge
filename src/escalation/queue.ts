import type {
  EscalationPort,
  HumanAction,
  InterventionOutcome,
  InterventionRequest,
} from '../replay/escalation-port.js';
import type { SessionControl } from './lease.js';

// Open requests for a person, and the run waiting on each one.
//
// A run doesn't give up on the person by default. It can be given a wait, and
// when that runs out the request stays open with an id someone can still pick
// up; only the run stops waiting.

export type InterventionState = 'open' | 'held' | 'resolved';

export interface InterventionRecord {
  readonly request: InterventionRequest;
  state: InterventionState;
  operator?: string;
  readonly actions: HumanAction[];
}

interface Pending extends InterventionRecord {
  settle: (outcome: InterventionOutcome) => void;
  settled: boolean;
}

export class InterventionQueue implements EscalationPort {
  private readonly records = new Map<string, Pending>();

  constructor(
    readonly control: SessionControl,
    private readonly options: { readonly waitMs?: number } = {},
  ) {}

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    let resolve!: (outcome: InterventionOutcome) => void;
    const decided = new Promise<InterventionOutcome>((r) => {
      resolve = r;
    });
    const record: Pending = {
      request,
      state: 'open',
      actions: [],
      settled: false,
      settle: (outcome) => {
        if (record.settled) return;
        record.settled = true;
        record.state = 'resolved';
        resolve(outcome);
      },
    };
    this.records.set(request.id, record);

    const waitMs = this.options.waitMs ?? 0;
    if (waitMs <= 0) return decided;
    const timeout = new Promise<InterventionOutcome>((r) => {
      setTimeout(
        () => r({ resolution: 'unavailable', note: `nobody picked this up within ${waitMs}ms; it's still open as ${request.id}` }),
        waitMs,
      ).unref?.();
    });
    return Promise.race([decided, timeout]);
  }

  list(): readonly InterventionRecord[] {
    return [...this.records.values()].map(({ settle: _s, settled: _d, ...record }) => record);
  }

  get(id: string): InterventionRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const { settle: _s, settled: _d, ...rest } = record;
    return rest;
  }

  /** A person takes the session. The run is locked out until they hand it back. */
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
    if (record.state !== 'held') throw new Error(`intervention ${id} isn't held by anyone, so nothing can be recorded`);
    record.actions.push(action);
  }

  resume(id: string, note?: string): InterventionOutcome {
    const record = this.require(id);
    const operator = record.operator ?? 'unknown';
    if (record.state === 'held') this.control.returnToAgent(operator, `intervention ${id} resumed`);
    const outcome: InterventionOutcome = {
      resolution: 'resume',
      ...(note ? { note } : {}),
      operator,
      humanActions: record.actions.length,
      actions: [...record.actions],
    };
    record.settle(outcome);
    return outcome;
  }

  abort(id: string, note?: string): InterventionOutcome {
    const record = this.require(id);
    if (record.state === 'held') this.control.returnToAgent(record.operator ?? 'unknown', `intervention ${id} aborted`);
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

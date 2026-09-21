import type { Risk } from '../artifact/schema.js';

// Where the engine hands off when a run can't safely carry on. The engine knows
// when to stop and how to resume; it doesn't know about queues or consoles or
// who's on shift, so that sits behind this interface.

export type InterventionReason =
  | 'needs_approval'
  | 'target_unresolvable'
  | 'checkpoint_failed'
  | 'business_outcome_needs_human';

export interface InterventionRequest {
  readonly id: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly tenantId: string;
  readonly stepId: string;
  readonly stepIntent: string;
  readonly reason: InterventionReason;
  readonly detail: string;
  readonly risk: Risk;
  /** Where the live session is right now. */
  readonly location: string;
  readonly screenshot?: string;
  /** Redacted text of the screen the run stopped on. */
  readonly screenText: string;
  readonly raisedAt: string;
}

/** Something a person did while holding the session. */
export interface HumanAction {
  readonly at: string;
  readonly kind: 'click' | 'type' | 'key' | 'note';
  readonly detail: string;
}

export type InterventionOutcome =
  | {
      readonly resolution: 'resume';
      readonly note?: string;
      readonly operator?: string;
      readonly humanActions?: number;
      readonly actions?: readonly HumanAction[];
    }
  | { readonly resolution: 'abort'; readonly note?: string }
  | { readonly resolution: 'unavailable'; readonly note?: string };

export interface EscalationPort {
  raise(request: InterventionRequest): Promise<InterventionOutcome>;
}

/**
 * The default when nothing is attached: note the request and stop. Carrying on
 * past a step that needed a person must never be what happens by default.
 */
export class UnattendedEscalationPort implements EscalationPort {
  private readonly raised: InterventionRequest[] = [];

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    this.raised.push(request);
    return { resolution: 'unavailable', note: 'nobody is attached to handle this run' };
  }

  requests(): readonly InterventionRequest[] {
    return this.raised;
  }
}

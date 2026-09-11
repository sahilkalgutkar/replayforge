import type { Risk } from '../artifact/schema.js';

/**
 * The seam between "the run cannot safely continue" and "a person takes over".
 *
 * The replay engine knows how to detect stuck and how to resume; it knows
 * nothing about queues, consoles or who is on shift. Keeping that behind a port
 * is what lets the same engine escalate to a console in development, to a
 * ticketing system in production, and to a stub in tests.
 */

export type InterventionReason =
  | 'needs_approval'
  | 'target_unresolvable'
  | 'checkpoint_failed'
  | 'business_outcome_needs_human'
  | 'policy_blocked';

export interface InterventionRequest {
  readonly id: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly tenantId: string;
  readonly stepId: string;
  /** Plain-language description of what the automation was trying to do. */
  readonly stepIntent: string;
  readonly reason: InterventionReason;
  readonly detail: string;
  readonly risk: Risk;
  /** Where the live session currently is, so the operator lands in the right place. */
  readonly location: string;
  readonly screenshot?: string;
  /** Redacted text of the screen that stopped the run. */
  readonly screenText: string;
  readonly raisedAt: string;
}

/** What a person did while holding the session, for the audit trail. */
export interface HumanAction {
  readonly at: string;
  readonly kind: 'click' | 'type' | 'key' | 'note';
  readonly detail: string;
}

export type InterventionOutcome =
  /** The human finished their part; the engine re-observes and carries on. */
  | {
      readonly resolution: 'resume';
      readonly note?: string;
      readonly humanActions?: number;
      readonly actions?: readonly HumanAction[];
      readonly operator?: string;
    }
  /** The human decided the run should stop. */
  | { readonly resolution: 'abort'; readonly note?: string }
  /** Nobody is available; the run ends as escalated and the request stays open. */
  | { readonly resolution: 'unavailable'; readonly note?: string };

export interface EscalationPort {
  raise(request: InterventionRequest): Promise<InterventionOutcome>;
}

/**
 * The default when no operator surface is wired up. It records the request and
 * stops. Silently continuing past a step that needed a person is the one
 * behaviour that must never be the default.
 */
export class UnattendedEscalationPort implements EscalationPort {
  private readonly raised: InterventionRequest[] = [];

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    this.raised.push(request);
    return { resolution: 'unavailable', note: 'no operator surface is attached to this run' };
  }

  requests(): readonly InterventionRequest[] {
    return this.raised;
  }
}

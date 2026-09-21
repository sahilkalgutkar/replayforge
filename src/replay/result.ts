import type { Risk } from '../artifact/schema.js';
import type { ExtractedValue } from './values.js';

// What a replay hands back. Four statuses, because merging any two of them makes
// the caller behave badly: treat "no such member" as a failure and it retries a
// lookup that can't succeed; treat an escalation as a failure and it retries
// something a person is already dealing with.

export type FailureCategory =
  | 'input_invalid'
  | 'configuration'
  | 'target_unresolvable'
  | 'target_ambiguous'
  | 'checkpoint_failed'
  | 'policy_blocked'
  | 'step_timeout'
  | 'budget_exceeded'
  | 'output_invalid'
  | 'surface_error';

export interface ReplayError {
  readonly category: FailureCategory;
  readonly message: string;
  readonly stepId?: string;
  readonly stepIntent?: string;
  /** What the flow said should be true here. */
  readonly expected?: string;
  /** What the screen actually showed. */
  readonly observed?: string;
  readonly screenshot?: string;
  readonly url?: string;
}

export interface StepReport {
  readonly stepId: string;
  readonly intent: string;
  readonly status: 'ok' | 'skipped' | 'failed' | 'escalated';
  readonly risk: Risk;
  /** Which targeting rung found the control. Anything but primary is drift. */
  readonly rung?: string;
  readonly attempts: number;
  readonly guardsFired: readonly string[];
  readonly durationMs: number;
  readonly drift?: {
    readonly expected: string;
    readonly observed: string;
    readonly missing: readonly string[];
  };
}

export interface ReplayTrace {
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly tenantId: string;
  readonly evidenceDir: string;
  readonly steps: readonly StepReport[];
  readonly durationMs: number;
}

export type ReplayResult =
  | { readonly status: 'success'; readonly outputs: Readonly<Record<string, ExtractedValue>>; readonly trace: ReplayTrace }
  | {
      readonly status: 'business_outcome';
      readonly outcome: string;
      readonly disposition: 'answer' | 'needs_human';
      readonly description: string;
      readonly outputs: Readonly<Record<string, ExtractedValue>>;
      readonly trace: ReplayTrace;
    }
  | {
      readonly status: 'escalated';
      readonly interventionId: string;
      readonly reason: string;
      readonly stepId: string;
      readonly trace: ReplayTrace;
    }
  | { readonly status: 'failed'; readonly error: ReplayError; readonly trace: ReplayTrace };

/** True when the caller got an answer, whether or not it was the happy path. */
export function isAnswer(result: ReplayResult): boolean {
  return result.status === 'success' || (result.status === 'business_outcome' && result.disposition === 'answer');
}

export function summariseResult(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return `success: ${Object.entries(result.outputs)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ')}`;
    case 'business_outcome':
      return `${result.outcome} (${result.disposition}): ${result.description}`;
    case 'escalated':
      return `escalated at ${result.stepId}: ${result.reason} (intervention ${result.interventionId})`;
    case 'failed':
      return `failed [${result.error.category}] at ${result.error.stepId ?? 'start'}: ${result.error.message}`;
  }
}

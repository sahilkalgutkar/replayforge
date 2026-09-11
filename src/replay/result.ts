import type { Risk } from '../artifact/schema.js';
import type { ExtractedValue } from './values.js';

/**
 * The result contract a calling agent programs against.
 *
 * The four statuses exist because collapsing any two of them produces a caller
 * that behaves badly. Merge `business_outcome` into `failed` and an agent
 * retries a lookup for a member who genuinely does not exist. Merge `escalated`
 * into `failed` and it retries something a person is already holding. Merge it
 * into `success` and it reports a balance nobody read.
 */

export type FailureCategory =
  /** The caller's arguments do not satisfy the contract. Nothing was touched. */
  | 'input_invalid'
  /** A declared secret or binding is not present in this environment. */
  | 'configuration'
  /** No control on the screen matched the recorded target, on any rung. */
  | 'target_unresolvable'
  /** The target matched several controls and the artifact names no ordinal. */
  | 'target_ambiguous'
  /** The step ran but the screen it should have produced never appeared. */
  | 'checkpoint_failed'
  /** The guardrails refused the action. */
  | 'policy_blocked'
  /** The step exceeded its own time budget. */
  | 'step_timeout'
  /** The run exceeded the capability's step or duration budget. */
  | 'budget_exceeded'
  /** A declared output was never produced, or could not be typed. */
  | 'output_invalid'
  /** The surface itself failed — the browser died, the frame vanished. */
  | 'surface_error';

export interface ReplayError {
  readonly category: FailureCategory;
  readonly message: string;
  readonly stepId?: string;
  readonly stepIntent?: string;
  /** What the artifact said should be true here. */
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
  /** Which targeting rung resolved the control. A fallback here is drift. */
  readonly rung?: string;
  readonly attempts: number;
  readonly guardsFired: readonly string[];
  readonly durationMs: number;
  /** Set when the screen no longer matches the one the step was recorded on. */
  readonly drift?: { readonly expected: string; readonly observed: string; readonly missing: readonly string[] };
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
  | {
      readonly status: 'success';
      readonly outputs: Readonly<Record<string, ExtractedValue>>;
      readonly trace: ReplayTrace;
    }
  | {
      readonly status: 'business_outcome';
      readonly outcome: string;
      readonly disposition: 'answer' | 'needs_human';
      readonly description: string;
      /** Whatever was read before the outcome fired. Often empty, sometimes useful. */
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
  | {
      readonly status: 'failed';
      readonly error: ReplayError;
      readonly trace: ReplayTrace;
    };

/** True when the caller got an answer, whether or not it was the happy path. */
export function isAnswer(result: ReplayResult): boolean {
  return (
    result.status === 'success' ||
    (result.status === 'business_outcome' && result.disposition === 'answer')
  );
}

export function summariseResult(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return `success — ${Object.entries(result.outputs)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')}`;
    case 'business_outcome':
      return `${result.outcome} (${result.disposition}) — ${result.description}`;
    case 'escalated':
      return `escalated at step ${result.stepId} — ${result.reason} (intervention ${result.interventionId})`;
    case 'failed':
      return `failed [${result.error.category}] at step ${result.error.stepId ?? '—'}: ${result.error.message}`;
  }
}

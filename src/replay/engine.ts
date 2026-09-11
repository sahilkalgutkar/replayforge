import { randomUUID } from 'node:crypto';
import type {
  Assertion,
  CapabilityArtifact,
  Guard,
  OutcomeSpec,
  Risk,
  Step,
} from '../artifact/schema.js';
import { resolveForTenant } from '../artifact/overrides.js';
import { RunRecorder, type ScreenshotPolicy } from '../evidence/recorder.js';
import { PolicyEngine } from '../policy/engine.js';
import { Redactor } from '../policy/redactor.js';
import { compareFingerprints } from '../surface/fingerprint.js';
import { describeFailure, resolveTarget } from '../surface/resolve.js';
import type { Observation, Surface, TargetSpec, UiNode } from '../surface/types.js';
import { describeAssertion, evaluateAssertion } from './assertions.js';
import {
  UnattendedEscalationPort,
  type EscalationPort,
  type InterventionOutcome,
  type InterventionReason,
  type InterventionRequest,
} from './escalation-port.js';
import type { FailureCategory, ReplayError, ReplayResult, ReplayTrace, StepReport } from './result.js';
import {
  applyTransform,
  coerceOutput,
  resolveSecrets,
  resolveValue,
  deepSubstitute,
  substituteTemplate,
  validateInputs,
  type ExtractedValue,
  type RunBindings,
} from './values.js';

/**
 * Deterministic replay: the path an AI agent triggers in production.
 *
 * No model is consulted for any decision here. Every branch the run can take is
 * something the artifact declared — a target, a checkpoint, a guard, an
 * outcome — which is what makes the same inputs produce the same steps every
 * time, and what makes a failure explainable by pointing at a line of the
 * artifact rather than at a transcript.
 *
 * The engine distinguishes three things that a less careful design collapses:
 *
 * - **Expected business outcomes** are declared in the artifact and detected
 *   after every observation. "No such member" ends the run with an answer.
 * - **Recoverable conditions** are guards and retries, both bounded. A known
 *   interstitial gets dismissed; a slow screen gets re-observed after a backoff.
 * - **Hard failures** stop and report which step, what was expected, what was
 *   observed, and where the screen was, with a capture attached.
 *
 * Anything that needs a person is a fourth thing again, and goes out through the
 * escalation port rather than being forced into one of the three.
 */

export interface ReplayOptions {
  readonly artifact: CapabilityArtifact;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly surface: Surface;
  readonly evidenceRoot: string;
  readonly tenantId?: string;
  /** Per-tenant deployment values, e.g. `baseUrl`. */
  readonly variables?: Readonly<Record<string, string>>;
  readonly runId?: string;
  readonly escalation?: EscalationPort;
  readonly screenshots?: ScreenshotPolicy;
  /** A person authorised this invocation's risky steps up front. */
  readonly riskyConfirmed?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  return new ReplayRun(options).execute();
}

class ReplayRun {
  private readonly artifact: CapabilityArtifact;
  private readonly surface: Surface;
  private readonly runId: string;
  private readonly tenantId: string;
  private readonly escalation: EscalationPort;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly steps: StepReport[] = [];
  private readonly extracted: Record<string, ExtractedValue> = {};
  private readonly guardFirings = new Map<string, number>();

  private recorder!: RunRecorder;
  private redactor!: Redactor;
  private policy!: PolicyEngine;
  private bindings!: RunBindings;
  private params: Record<string, ExtractedValue> = {};
  private effectiveSteps: readonly Step[] = [];
  private outcomeSpecs: readonly OutcomeSpec[] = [];
  private successCheckpoint!: Assertion;
  private preconditions: readonly Assertion[] = [];

  /**
   * Fills the caller's arguments into a step's targeting and assertions. Value
   * sources are left alone: `resolveValue` distinguishes a recorded literal
   * from a parameter on purpose, and a blanket substitution would erase that.
   */
  private materialise(step: Step): Step {
    const action = deepSubstitute(
      'target' in step.action ? { ...step.action, target: step.action.target } : step.action,
      this.params,
      this.bindings,
    ) as Step['action'];
    // Restore the untouched value source, which deepSubstitute must not see.
    const restored =
      'value' in step.action && 'value' in action
        ? ({ ...action, value: step.action.value } as Step['action'])
        : action;
    const url =
      step.action.kind === 'navigate' && restored.kind === 'navigate'
        ? ({ ...restored, url: step.action.url } as Step['action'])
        : restored;
    return {
      ...step,
      action: url,
      ...(step.checkpoint
        ? { checkpoint: deepSubstitute(step.checkpoint, this.params, this.bindings) }
        : {}),
      guards: step.guards.map((guard) => deepSubstitute(guard, this.params, this.bindings)),
    };
  }

  constructor(private readonly options: ReplayOptions) {
    this.artifact = options.artifact;
    this.surface = options.surface;
    this.runId = options.runId ?? `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.tenantId = options.tenantId ?? options.artifact.app.recordedOnTenant;
    this.escalation = options.escalation ?? new UnattendedEscalationPort();
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  async execute(): Promise<ReplayResult> {
    const setup = await this.prepare();
    if (setup) return setup;

    try {
      return await this.runSteps();
    } catch (error) {
      return this.fail({
        category: 'surface_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- setup ---------------------------------------------------------------

  /** Everything that can be checked without touching the app is checked here. */
  private async prepare(): Promise<ReplayResult | undefined> {
    const validated = validateInputs(this.artifact.inputs, this.options.inputs);
    const secrets = resolveSecrets(this.artifact.secrets, this.options.env ?? process.env);

    const piiValues: Record<string, string> = {};
    if (validated.ok) {
      for (const spec of this.artifact.inputs) {
        const value = validated.values[spec.name];
        if (spec.sensitivity === 'pii' && value !== undefined) piiValues[spec.name] = String(value);
      }
    }
    this.redactor = new Redactor({
      secrets: secrets.ok ? secrets.secrets : {},
      piiValues,
    });
    this.recorder = await RunRecorder.open(
      this.options.evidenceRoot,
      this.runId,
      this.redactor,
      this.options.screenshots,
    );

    if (!validated.ok) {
      await this.recorder.event('run.rejected', { issues: validated.issues });
      return this.fail({
        category: 'input_invalid',
        message: validated.issues.map((i) => `${i.name} ${i.message}`).join('; '),
      });
    }
    if (!secrets.ok) {
      await this.recorder.event('run.rejected', { missingSecrets: secrets.missing });
      return this.fail({
        category: 'configuration',
        message: `missing credentials for this environment: ${secrets.missing.join(', ')}`,
      });
    }

    this.params = validated.values;
    this.bindings = { variables: this.options.variables ?? {}, secrets: secrets.secrets };

    const resolved = resolveForTenant(this.artifact, this.tenantId);
    // Targets and assertions may reference the caller's arguments; fill them in
    // once, up front, so nothing downstream has to know about templates.
    this.effectiveSteps = resolved.artifact.steps.map((step) => this.materialise(step));
    this.outcomeSpecs = this.artifact.outcomes.map((outcome) => ({
      ...outcome,
      when: deepSubstitute(outcome.when, this.params, this.bindings),
    }));
    this.successCheckpoint = deepSubstitute(
      this.artifact.successCheckpoint,
      this.params,
      this.bindings,
    );
    this.preconditions = this.artifact.preconditions.map((assertion) =>
      deepSubstitute(assertion, this.params, this.bindings),
    );

    this.policy = new PolicyEngine({
      allowlist: {
        origins: this.artifact.policy.allowedOrigins.map((origin) =>
          substituteTemplate(origin, this.params, this.bindings),
        ),
        routes: this.artifact.policy.allowedRoutes,
        actions: this.artifact.policy.allowedActions,
      },
      maxRiskWithoutApproval: this.artifact.policy.maxRiskWithoutApproval,
    });

    await this.recorder.event('run.started', {
      runId: this.runId,
      capability: { id: this.artifact.id, version: this.artifact.version, name: this.artifact.name },
      tenantId: this.tenantId,
      approval: this.artifact.approval.state,
      inputs: this.params,
      overrides: {
        patched: resolved.patchedSteps,
        inserted: resolved.insertedSteps,
        skipped: resolved.skippedSteps,
      },
    });
    return undefined;
  }

  // --- main loop -----------------------------------------------------------

  private async runSteps(): Promise<ReplayResult> {
    if (this.effectiveSteps.length > this.artifact.policy.maxSteps) {
      return this.fail({
        category: 'budget_exceeded',
        message: `capability has ${this.effectiveSteps.length} steps but its policy allows ${this.artifact.policy.maxSteps}`,
      });
    }

    let observation = await this.surface.observe();

    for (const precondition of this.preconditions) {
      const result = evaluateAssertion(precondition, observation);
      if (!result.ok) {
        await this.recorder.event('precondition.failed', { detail: result.detail });
        return this.fail({
          category: 'checkpoint_failed',
          message: `precondition not met: ${result.detail}`,
          observed: this.redactor.redact(observation.text.slice(0, 400)),
          url: observation.url,
        });
      }
    }

    for (const step of this.effectiveSteps) {
      if (this.now() - this.startedAt > this.artifact.policy.maxDurationMs) {
        return this.fail({
          category: 'budget_exceeded',
          message: `run exceeded its ${this.artifact.policy.maxDurationMs}ms budget`,
          stepId: step.id,
        });
      }

      const outcome = await this.runStep(step, observation);
      if (outcome.kind === 'terminal') return outcome.result;
      observation = outcome.observation;
    }

    return this.finish(observation);
  }

  private async runStep(
    step: Step,
    incoming: Observation,
  ): Promise<{ kind: 'continue'; observation: Observation } | { kind: 'terminal'; result: ReplayResult }> {
    const startedAt = this.now();
    const maxAttempts = step.retries.max + 1;
    const guardsFired: string[] = [];
    let observation = incoming;
    let escalationsUsed = 0;
    // Tracked separately from `attempt` because a resume rewinds the attempt
    // counter, and reusing the screen the run was looking at before a person
    // touched it is exactly the mistake that makes a handoff pointless.
    let firstPass = true;

    await this.recorder.event('step.started', {
      stepId: step.id,
      intent: step.intent,
      action: step.action.kind,
      declaredRisk: step.risk,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      observation = firstPass ? observation : await this.surface.observe();
      firstPass = false;

      const matched = this.matchOutcome(observation);
      if (matched) {
        const handled = await this.handleOutcome(matched, step, observation, escalationsUsed === 0);
        if (handled.kind === 'terminal') return handled;
        escalationsUsed += 1;
        attempt -= 1;
        continue;
      }

      const guarded = await this.runGuards(step, observation, guardsFired);
      observation = guarded;

      const afterGuards = this.matchOutcome(observation);
      if (afterGuards) {
        const handled = await this.handleOutcome(afterGuards, step, observation, escalationsUsed === 0);
        if (handled.kind === 'terminal') return handled;
        escalationsUsed += 1;
        attempt -= 1;
        continue;
      }

      // Resolve the control this step acts on, when it has one.
      // Drift is measured against the screen this step *acts on*, not the one
      // it produces. Comparing the recorded pre-step fingerprint with the
      // post-step screen would report drift on every step that changes
      // anything, which is every step worth having.
      const drift = this.driftFor(step, observation);

      const targetSpec = targetOf(step);
      let node: UiNode | undefined;
      let rung: string | undefined;
      if (targetSpec) {
        const resolution = resolveTarget(targetSpec, observation);
        if (!resolution.ok) {
          const category: FailureCategory =
            resolution.failure.reason === 'ambiguous' ? 'target_ambiguous' : 'target_unresolvable';
          if (attempt < maxAttempts) {
            await this.recorder.event('step.retrying', {
              stepId: step.id,
              attempt,
              reason: describeFailure(targetSpec, resolution),
            });
            await this.pause(step.retries.backoffMs);
            continue;
          }
          const escalated = await this.maybeEscalate(step, observation, {
            reason: category === 'target_ambiguous' ? 'target_unresolvable' : 'target_unresolvable',
            detail: describeFailure(targetSpec, resolution),
            risk: step.risk,
            allow: step.onFailure === 'escalate' && escalationsUsed === 0,
          });
          if (escalated?.resolution === 'resume') {
            escalationsUsed += 1;
            attempt -= 1;
            continue;
          }
          if (escalated) {
            return {
              kind: 'terminal',
              result: this.escalatedResult(step, describeFailure(targetSpec, resolution)),
            };
          }
          return {
            kind: 'terminal',
            result: await this.failAtStep(step, observation, {
              category,
              message: describeFailure(targetSpec, resolution),
              expected: targetSpec.description,
            }),
          };
        }
        node = resolution.node;
        rung = resolution.rung;
        await this.recorder.event('target.resolved', {
          stepId: step.id,
          rung: resolution.rung,
          matchCount: resolution.matchCount,
          control: { role: node.role, name: node.name, frame: node.framePath.join('/') },
        });
      }

      // Authorise before acting, with the live control in hand.
      const targetUrl =
        step.action.kind === 'navigate'
          ? resolveValue(step.action.url, this.params, this.bindings)
          : undefined;
      const decision = this.policy.evaluate({
        mode: 'replay',
        action: step.action,
        declaredRisk: step.risk,
        node,
        targetUrl,
        approvalState: this.artifact.approval.state,
        riskyConfirmed: this.options.riskyConfirmed === true || this.approvedByOperator,
      });

      if (decision.verdict === 'block') {
        await this.recorder.event('policy.blocked', { stepId: step.id, rule: decision.rule, reason: decision.reason });
        return {
          kind: 'terminal',
          result: await this.failAtStep(step, observation, {
            category: 'policy_blocked',
            message: decision.reason,
            expected: `an action permitted by rule ${decision.rule}`,
          }),
        };
      }

      if (decision.verdict === 'needs_approval') {
        await this.recorder.event('policy.needs_approval', {
          stepId: step.id,
          rule: decision.rule,
          risk: decision.risk,
          reason: decision.reason,
        });
        const outcome = await this.maybeEscalate(step, observation, {
          reason: 'needs_approval',
          detail: decision.reason,
          risk: decision.risk,
          allow: escalationsUsed === 0,
        });
        if (outcome?.resolution === 'resume') {
          this.approvedByOperator = true;
          await this.recorder.event('approval.granted_by_operator', {
            stepId: step.id,
            operator: outcome.operator,
            risk: decision.risk,
          });
          escalationsUsed += 1;
          attempt -= 1;
          continue;
        }
        return { kind: 'terminal', result: this.escalatedResult(step, decision.reason) };
      }

      // Act.
      try {
        await this.withTimeout(this.performStep(step, node, targetUrl), step.timeoutMs, step.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          await this.recorder.event('step.retrying', { stepId: step.id, attempt, reason: message });
          await this.pause(step.retries.backoffMs);
          continue;
        }
        return {
          kind: 'terminal',
          result: await this.failAtStep(step, observation, {
            category: message.includes('timed out') ? 'step_timeout' : 'surface_error',
            message,
          }),
        };
      }

      const after = await this.surface.observe();

      const post = this.matchOutcome(after);
      if (post) {
        const handled = await this.handleOutcome(post, step, after, escalationsUsed === 0);
        if (handled.kind === 'terminal') return handled;
        escalationsUsed += 1;
        attempt -= 1;
        continue;
      }

      const locationCheck = this.policy.checkObservedLocation(after.url);
      if (locationCheck.verdict === 'block') {
        return {
          kind: 'terminal',
          result: await this.failAtStep(step, after, {
            category: 'policy_blocked',
            message: `after this step the session left the allowed surface: ${locationCheck.reason}`,
          }),
        };
      }

      if (step.checkpoint) {
        const check = evaluateAssertion(step.checkpoint, after);
        if (!check.ok) {
          if (attempt < maxAttempts) {
            await this.recorder.event('checkpoint.retrying', { stepId: step.id, attempt, detail: check.detail });
            await this.pause(step.retries.backoffMs);
            observation = after;
            continue;
          }
          const escalated = await this.maybeEscalate(step, after, {
            reason: 'checkpoint_failed',
            detail: check.detail,
            risk: step.risk,
            allow: step.onFailure === 'escalate' && escalationsUsed === 0,
          });
          if (escalated?.resolution === 'resume') {
            escalationsUsed += 1;
            attempt -= 1;
            observation = after;
            continue;
          }
          if (escalated) {
            return { kind: 'terminal', result: this.escalatedResult(step, check.detail) };
          }
          return {
            kind: 'terminal',
            result: await this.failAtStep(step, after, {
              category: 'checkpoint_failed',
              message: check.detail,
              expected: describeAssertion(step.checkpoint),
            }),
          };
        }
        await this.recorder.event('checkpoint.passed', { stepId: step.id, detail: check.detail });
      }

      if (drift) {
        await this.recorder.event('drift.detected', { stepId: step.id, ...drift });
      }

      this.steps.push({
        stepId: step.id,
        intent: step.intent,
        status: 'ok',
        risk: decision.risk,
        ...(rung === undefined ? {} : { rung }),
        attempts: attempt,
        guardsFired,
        durationMs: this.now() - startedAt,
        ...(drift ? { drift } : {}),
      });
      await this.recorder.event('step.finished', { stepId: step.id, attempts: attempt, rung });
      return { kind: 'continue', observation: after };
    }

    // The loop always returns; this satisfies the type checker for the
    // theoretically unreachable case where maxAttempts is exhausted by a
    // `continue` on the final iteration.
    return {
      kind: 'terminal',
      result: await this.failAtStep(step, observation, {
        category: 'checkpoint_failed',
        message: `step "${step.id}" exhausted its ${maxAttempts} attempt(s)`,
      }),
    };
  }

  // --- step mechanics ------------------------------------------------------

  private async performStep(step: Step, node: UiNode | undefined, targetUrl?: string): Promise<void> {
    const { action } = step;
    switch (action.kind) {
      case 'navigate':
        await this.surface.perform({ kind: 'navigate', url: targetUrl as string });
        return;
      case 'click':
        await this.surface.perform({ kind: 'click', ref: requireNode(node, step).ref });
        return;
      case 'type': {
        const value = resolveValue(action.value, this.params, this.bindings);
        await this.surface.perform({ kind: 'fill', ref: requireNode(node, step).ref, text: value });
        await this.recorder.event('action.typed', { stepId: step.id, value });
        return;
      }
      case 'select': {
        const value = resolveValue(action.value, this.params, this.bindings);
        await this.surface.perform({ kind: 'select', ref: requireNode(node, step).ref, value });
        return;
      }
      case 'setChecked':
        await this.surface.perform({
          kind: 'check',
          ref: requireNode(node, step).ref,
          checked: action.checked,
        });
        return;
      case 'pressKey':
        await this.surface.perform({
          kind: 'press',
          key: action.key,
          ...(node ? { ref: node.ref } : {}),
        });
        return;
      case 'waitFor':
        await this.surface.perform({ kind: 'waitForIdle', timeoutMs: action.timeoutMs });
        return;
      case 'read': {
        const source = requireNode(node, step);
        const raw = action.from === 'value' ? source.value : action.from === 'name' ? source.name : source.text;
        if (raw === undefined || raw === '') {
          throw new Error(
            `step "${step.id}" read the ${action.from} of ${action.target.description} and found nothing`,
          );
        }
        const value = applyTransform(raw, action.transform);
        this.extracted[action.into] = value;
        await this.recorder.event('value.extracted', { stepId: step.id, key: action.into, value });
        return;
      }
    }
  }

  private async runGuards(
    step: Step,
    observation: Observation,
    fired: string[],
  ): Promise<Observation> {
    let current = observation;
    for (const guard of step.guards) {
      const key = `${step.id}:${guard.name}`;
      const count = this.guardFirings.get(key) ?? 0;
      if (count >= guard.maxFirings) continue;
      if (!evaluateAssertion(guard.when, current).ok) continue;

      this.guardFirings.set(key, count + 1);
      fired.push(guard.name);
      await this.recorder.event('guard.fired', { stepId: step.id, guard: guard.name, firing: count + 1 });
      current = await this.applyGuard(guard, current);
    }
    return current;
  }

  private async applyGuard(guard: Guard, observation: Observation): Promise<Observation> {
    if (guard.then.kind === 'wait') {
      await this.pause(guard.then.ms);
      return this.surface.observe();
    }
    if (guard.then.kind === 'reload') {
      await this.surface.perform({ kind: 'navigate', url: observation.url });
      return this.surface.observe();
    }
    const resolution = resolveTarget(guard.then.target, observation);
    if (!resolution.ok) {
      // A guard that cannot find its own control is not a failure — the
      // condition it was written for may have already cleared.
      await this.recorder.event('guard.noop', {
        guard: guard.name,
        reason: describeFailure(guard.then.target, resolution),
      });
      return observation;
    }
    await this.surface.perform({ kind: 'click', ref: resolution.node.ref });
    return this.surface.observe();
  }

  private matchOutcome(observation: Observation): { name: string; description: string; disposition: 'answer' | 'needs_human' } | undefined {
    for (const outcome of this.outcomeSpecs) {
      if (evaluateAssertion(outcome.when, observation).ok) {
        return {
          name: outcome.name,
          description: outcome.description,
          disposition: outcome.disposition,
        };
      }
    }
    return undefined;
  }

  /**
   * Compares the screen this step is about to act on against the one it was
   * recorded on. A mismatch does not fail the run — the checkpoint decides
   * that — but it is the signal that says "this build of the app is not the one
   * this capability was recorded against", which is the difference between a
   * debuggable drift report and a mystery.
   */
  private driftFor(step: Step, observation: Observation): StepReport['drift'] {
    if (step.expectedFingerprint === undefined) return undefined;
    const report = compareFingerprints(
      step.expectedFingerprint,
      observation,
      step.expectedControls,
      Object.values(this.params).map(String),
    );
    if (report.matches) return undefined;
    return { expected: report.expected, observed: report.observed, missing: report.missing };
  }

  // --- terminal paths ------------------------------------------------------

  /**
   * A declared outcome fired. `continue` is returned only when a person took
   * the session, cleared the condition and handed it back — a session that was
   * signed out and has been signed back in is a run that can carry on, and
   * reporting SESSION_EXPIRED after the operator fixed it would be a lie.
   */
  private async handleOutcome(
    outcome: { name: string; description: string; disposition: 'answer' | 'needs_human' },
    step: Step,
    observation: Observation,
    escalationAllowed: boolean,
  ): Promise<{ kind: 'terminal'; result: ReplayResult } | { kind: 'continue' }> {
    await this.recorder.event('outcome.matched', {
      stepId: step.id,
      outcome: outcome.name,
      disposition: outcome.disposition,
      url: observation.url,
    });

    if (outcome.disposition === 'needs_human') {
      const handoff = await this.maybeEscalate(step, observation, {
        reason: 'business_outcome_needs_human',
        detail: `${outcome.name}: ${outcome.description}`,
        risk: step.risk,
        allow: escalationAllowed,
      });
      if (handoff?.resolution === 'resume') {
        await this.recorder.event('outcome.cleared_by_human', {
          outcome: outcome.name,
          operator: handoff.operator,
          humanActions: handoff.humanActions,
        });
        return { kind: 'continue' };
      }
      await this.recorder.screenshot(
        `outcome-${outcome.name.toLowerCase()}`,
        () => this.surface.screenshot(),
        'escalation',
      );
      this.steps.push(this.reportFor(step, 'escalated'));
      const escalated = this.escalatedResult(step, `${outcome.name}: ${outcome.description}`);
      await this.recorder.writeJson('result', escalated);
      return { kind: 'terminal', result: escalated };
    }

    this.steps.push(this.reportFor(step, 'skipped'));
    const result: ReplayResult = {
      status: 'business_outcome',
      outcome: outcome.name,
      disposition: outcome.disposition,
      description: outcome.description,
      outputs: { ...this.extracted },
      trace: this.trace(),
    };
    await this.recorder.writeJson('result', result);
    await this.recorder.event('run.finished', { status: 'business_outcome', outcome: outcome.name });
    return { kind: 'terminal', result };
  }

  private async finish(observation: Observation): Promise<ReplayResult> {
    const success = evaluateAssertion(this.successCheckpoint, observation);
    if (!success.ok) {
      return this.fail({
        category: 'checkpoint_failed',
        message: `every step ran but the capability's success condition is not met: ${success.detail}`,
        observed: this.redactor.redact(observation.text.slice(0, 400)),
        url: observation.url,
        screenshot: await this.recorder.screenshot('success-check-failed', () => this.surface.screenshot(), 'failure'),
      });
    }

    const outputs: Record<string, ExtractedValue> = {};
    for (const spec of this.artifact.outputs) {
      const coerced = coerceOutput(spec, this.extracted[spec.from]);
      if (!coerced.ok) {
        return this.fail({ category: 'output_invalid', message: coerced.message });
      }
      outputs[spec.name] = coerced.value;
    }

    const result: ReplayResult = { status: 'success', outputs, trace: this.trace() };
    await this.recorder.writeJson('result', result);
    await this.recorder.event('run.finished', { status: 'success', outputs });
    return result;
  }

  private async maybeEscalate(
    step: Step,
    observation: Observation,
    options: { reason: InterventionReason; detail: string; risk: Risk; allow: boolean },
  ): Promise<InterventionOutcome | undefined> {
    if (!options.allow) return undefined;

    const screenshot = await this.recorder.screenshot(
      `escalation-${step.id}`,
      () => this.surface.screenshot(),
      'escalation',
    );
    const request: InterventionRequest = {
      id: randomUUID(),
      runId: this.runId,
      capabilityId: this.artifact.id,
      capabilityName: this.artifact.name,
      tenantId: this.tenantId,
      stepId: step.id,
      stepIntent: step.intent,
      reason: options.reason,
      detail: options.detail,
      risk: options.risk,
      location: observation.url,
      ...(screenshot ? { screenshot } : {}),
      screenText: this.redactor.redact(observation.text.slice(0, 1200)),
      raisedAt: new Date().toISOString(),
    };
    await this.recorder.event('escalation.raised', {
      interventionId: request.id,
      stepId: step.id,
      reason: options.reason,
      detail: options.detail,
    });

    const outcome = await this.escalation.raise(request);
    await this.recorder.event('escalation.resolved', {
      interventionId: request.id,
      resolution: outcome.resolution,
      note: outcome.note,
      humanActions: 'humanActions' in outcome ? outcome.humanActions : undefined,
      operator: 'operator' in outcome ? outcome.operator : undefined,
      // What the operator did, so the handoff is part of the trail rather than
      // a gap in it.
      actions: 'actions' in outcome ? outcome.actions : undefined,
    });
    this.lastInterventionId = request.id;
    return outcome;
  }

  private lastInterventionId = '';
  /**
   * An operator who took the session, looked at what the run was about to do
   * and handed it back has approved this invocation. Treating the handback as
   * the approval is the only reading that makes sense: the alternative is
   * escalating the same step to the same person on the next attempt.
   */
  private approvedByOperator = false;

  private escalatedResult(step: Step, reason: string): ReplayResult {
    return {
      status: 'escalated',
      interventionId: this.lastInterventionId,
      reason,
      stepId: step.id,
      trace: this.trace(),
    };
  }

  private async failAtStep(
    step: Step,
    observation: Observation,
    error: Omit<ReplayError, 'stepId' | 'stepIntent' | 'url' | 'observed' | 'screenshot'> &
      Partial<ReplayError>,
  ): Promise<ReplayResult> {
    const screenshot = await this.recorder.screenshot(
      `failure-${step.id}`,
      () => this.surface.screenshot(),
      'failure',
    );
    this.steps.push(this.reportFor(step, 'failed'));
    return this.fail({
      ...error,
      stepId: step.id,
      stepIntent: step.intent,
      url: observation.url,
      observed: error.observed ?? this.redactor.redact(observation.text.slice(0, 400)),
      ...(screenshot ? { screenshot } : {}),
    });
  }

  private async fail(error: ReplayError): Promise<ReplayResult> {
    const result: ReplayResult = { status: 'failed', error, trace: this.trace() };
    if (this.recorder) {
      await this.recorder.writeJson('result', result);
      await this.recorder.event('run.finished', { status: 'failed', category: error.category });
    }
    return result;
  }

  private reportFor(step: Step, status: StepReport['status']): StepReport {
    return {
      stepId: step.id,
      intent: step.intent,
      status,
      risk: step.risk,
      attempts: 1,
      guardsFired: [],
      durationMs: 0,
    };
  }

  private trace(): ReplayTrace {
    return {
      runId: this.runId,
      capabilityId: this.artifact.id,
      capabilityVersion: this.artifact.version,
      tenantId: this.tenantId,
      evidenceDir: this.recorder?.directory ?? '',
      steps: this.steps,
      durationMs: this.now() - this.startedAt,
    };
  }

  private async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withTimeout<T>(work: Promise<T>, ms: number, stepId: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`step "${stepId}" timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function targetOf(step: Step): TargetSpec | undefined {
  const { action } = step;
  return 'target' in action ? action.target : undefined;
}

function requireNode(node: UiNode | undefined, step: Step): UiNode {
  if (!node) throw new Error(`step "${step.id}" needs a resolved control but none was provided`);
  return node;
}

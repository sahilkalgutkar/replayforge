import type { Action, Risk } from '../artifact/schema.js';
import type { UiNode } from '../surface/types.js';
import { Allowlist, type AllowlistConfig } from './allowlist.js';
import { classifyAction, exceeds, maxRisk, type RiskVocabulary } from './risk.js';

/**
 * The single place an action is authorised.
 *
 * Discovery and replay both call this, on purpose. Two enforcement paths drift,
 * and the one that ends up wrong is always the one running unattended against
 * production.
 */

export type PolicyDecision =
  | { readonly verdict: 'allow'; readonly risk: Risk }
  | { readonly verdict: 'block'; readonly rule: string; readonly reason: string }
  | {
      readonly verdict: 'needs_approval';
      readonly rule: string;
      readonly reason: string;
      readonly risk: Risk;
    };

export interface PolicyContext {
  readonly mode: 'discovery' | 'replay';
  readonly action: Action;
  /** Risk the artifact recorded for this step, when replaying one. */
  readonly declaredRisk?: Risk;
  /** The control the action resolved to, when it has been resolved yet. */
  readonly node?: UiNode;
  /** Concrete destination for a navigate, after templates are substituted. */
  readonly targetUrl?: string;
  readonly approvalState?: 'draft' | 'approved' | 'revoked';
  /** A human authorised this specific invocation's risky steps. */
  readonly riskyConfirmed?: boolean;
}

export interface PolicyEngineOptions {
  readonly allowlist: AllowlistConfig;
  /** Highest risk that may run without a person in the loop. */
  readonly maxRiskWithoutApproval: Risk;
  readonly vocabulary?: RiskVocabulary;
}

export class PolicyEngine {
  private readonly allowlist: Allowlist;
  private readonly ceiling: Risk;
  private readonly vocabulary: RiskVocabulary | undefined;

  constructor(options: PolicyEngineOptions) {
    this.allowlist = new Allowlist(options.allowlist);
    this.ceiling = options.maxRiskWithoutApproval;
    this.vocabulary = options.vocabulary;
  }

  /**
   * The risk this action actually carries: the stricter of what the artifact
   * recorded and what the live control says about itself. A recording is one
   * model's judgement about one screen on one day; if the button that said
   * "Continue" now says "Post Account", the live read is the one to trust.
   */
  effectiveRisk(context: PolicyContext): Risk {
    const derived = classifyAction(context.action, context.node, this.vocabulary);
    return context.declaredRisk ? maxRisk(context.declaredRisk, derived) : derived;
  }

  evaluate(context: PolicyContext): PolicyDecision {
    const actionCheck = this.allowlist.checkAction(context.action.kind);
    if (!actionCheck.allowed) {
      return { verdict: 'block', rule: 'allowlist.action', reason: actionCheck.reason };
    }

    if (context.targetUrl !== undefined) {
      const locationCheck = this.allowlist.checkLocation(context.targetUrl);
      if (!locationCheck.allowed) {
        return { verdict: 'block', rule: 'allowlist.origin', reason: locationCheck.reason };
      }
    }

    if (context.mode === 'replay' && context.approvalState === 'revoked') {
      return {
        verdict: 'block',
        rule: 'approval.revoked',
        reason: 'this capability’s approval has been revoked, so it may not be replayed',
      };
    }

    const risk = this.effectiveRisk(context);

    if (exceeds(risk, this.ceiling)) {
      if (context.riskyConfirmed === true) return { verdict: 'allow', risk };
      return {
        verdict: 'needs_approval',
        rule: 'risk.ceiling',
        risk,
        reason: `this step is ${risk} and the policy permits up to ${this.ceiling} without a person`,
      };
    }

    // An unapproved capability may read, but may not write unattended. Discovery
    // is exempt: producing the recording is how a capability becomes reviewable
    // in the first place, and it runs with a person watching.
    if (
      context.mode === 'replay' &&
      risk !== 'safe' &&
      context.approvalState !== 'approved' &&
      context.riskyConfirmed !== true
    ) {
      return {
        verdict: 'needs_approval',
        rule: 'approval.draft',
        risk,
        reason: `capability is in draft and this step is ${risk}; a draft may only be replayed for safe steps`,
      };
    }

    return { verdict: 'allow', risk };
  }

  /** Checked after every step: an app can navigate itself somewhere off-limits. */
  checkObservedLocation(url: string): PolicyDecision {
    const check = this.allowlist.checkLocation(url);
    return check.allowed
      ? { verdict: 'allow', risk: 'safe' }
      : { verdict: 'block', rule: 'allowlist.origin', reason: check.reason };
  }
}

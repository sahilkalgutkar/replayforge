import type { Action, Risk } from '../artifact/schema.js';
import type { UiNode } from '../surface/types.js';
import { Allowlist, type AllowlistConfig } from './allowlist.js';
import { classifyAction, exceeds, maxRisk, type RiskVocabulary } from './risk.js';

// The one place an action gets authorised. Discovery and replay both come
// through here, since two separate enforcement paths would drift apart.

export type PolicyDecision =
  | { readonly verdict: 'allow'; readonly risk: Risk }
  | { readonly verdict: 'block'; readonly rule: string; readonly reason: string }
  | { readonly verdict: 'needs_approval'; readonly rule: string; readonly reason: string; readonly risk: Risk };

export interface PolicyContext {
  readonly mode: 'discovery' | 'replay';
  readonly action: Action;
  /** What the artifact recorded for this step, when replaying. */
  readonly declaredRisk?: Risk;
  /** The control the action resolved to. */
  readonly node?: UiNode;
  /** Where a navigate is going, after templates are filled in. */
  readonly targetUrl?: string;
  readonly approvalState?: 'draft' | 'approved' | 'revoked';
  /** A person has OK'd this call's risky steps. */
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

  /** The stricter of what was recorded and what the live control says now. */
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
        reason: 'this capability has been revoked and may not be replayed',
      };
    }

    const risk = this.effectiveRisk(context);

    if (exceeds(risk, this.ceiling)) {
      if (context.riskyConfirmed === true) return { verdict: 'allow', risk };
      return {
        verdict: 'needs_approval',
        rule: 'risk.ceiling',
        risk,
        reason: `this step is ${risk} and the policy allows up to ${this.ceiling} without a person`,
      };
    }

    // A draft may read but not write unattended. Discovery is exempt: recording
    // a flow is how it becomes something anyone can review, and someone is
    // watching when it happens.
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
        reason: `the capability is still a draft and this step is ${risk}; drafts only run safe steps unattended`,
      };
    }

    return { verdict: 'allow', risk };
  }

  /** Checked after every step, since an app can navigate itself somewhere off-limits. */
  checkObservedLocation(url: string): PolicyDecision {
    const check = this.allowlist.checkLocation(url);
    return check.allowed
      ? { verdict: 'allow', risk: 'safe' }
      : { verdict: 'block', rule: 'allowlist.origin', reason: check.reason };
  }
}

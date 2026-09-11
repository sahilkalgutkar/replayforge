import type { Action, Risk } from '../artifact/schema.js';
import type { UiNode } from '../surface/types.js';

/**
 * Risk classification, derived from the action and from what the control it is
 * about to touch calls itself.
 *
 * This is re-derived at replay rather than trusted from the artifact, and the
 * stricter of the two wins. A recorded classification is an assertion made once,
 * by a model, against one screen; if a later build renames "Continue" to "Post
 * Account", the artifact still says `sensitive` and only a fresh look at the
 * live control says otherwise.
 *
 * The vocabulary is configurable because it is domain knowledge, not logic —
 * "post" and "void" are irreversible in a core banking console specifically.
 * The defaults are deliberately broad: over-classifying costs a confirmation
 * prompt, under-classifying costs an unintended funds movement.
 */

export interface RiskVocabulary {
  readonly irreversible: readonly RegExp[];
  readonly navigational: readonly RegExp[];
}

export const DEFAULT_RISK_VOCABULARY: RiskVocabulary = {
  irreversible: [
    /\b(post|submit|confirm|approve|authori[sz]e|transfer|send|pay|disburse)\b/i,
    /\b(delete|remove|purge|void|reverse|close|freeze|revoke|charge[- ]?off)\b/i,
    /\b(open account|new account|issue card|reset password)\b/i,
  ],
  navigational: [
    /^(back|cancel|next|previous|home|search|find|go|continue to results)$/i,
    /^(acknowledge|ok|dismiss|close window|refresh|reload)$/i,
    /^(sign on|log ?in|profile|accounts|details|reports|transactions|menu)$/i,
  ],
};

const ORDER: Record<Risk, number> = { safe: 0, sensitive: 1, irreversible: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function exceeds(risk: Risk, ceiling: Risk): boolean {
  return ORDER[risk] > ORDER[ceiling];
}

/**
 * `node` is the control the action resolved to, when there is one. Without it
 * the classifier has only the action kind, and errs upward.
 */
export function classifyAction(
  action: Action,
  node?: UiNode,
  vocabulary: RiskVocabulary = DEFAULT_RISK_VOCABULARY,
): Risk {
  switch (action.kind) {
    case 'read':
    case 'waitFor':
      return 'safe';
    case 'navigate':
      return 'safe';
    case 'type':
    case 'select':
    case 'setChecked':
      return 'sensitive';
    case 'pressKey':
      return action.key === 'Enter' ? 'sensitive' : 'safe';
    case 'click': {
      const label = [node?.name, node?.value, node?.text].filter(Boolean).join(' ').trim();
      if (label === '') return 'sensitive';
      if (vocabulary.irreversible.some((pattern) => pattern.test(label))) return 'irreversible';
      if (vocabulary.navigational.some((pattern) => pattern.test(label))) return 'safe';
      return 'sensitive';
    }
  }
}

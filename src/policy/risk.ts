import type { Action, Risk } from '../artifact/schema.js';
import type { UiNode } from '../surface/types.js';

// Works out how risky an action is from what it does and what the control it's
// about to touch calls itself.
//
// This runs again at replay rather than trusting what was recorded, because a
// button that said "Continue" when the flow was recorded might say "Post
// Account" now. The word lists lean broad on purpose: getting it wrong one way
// costs a confirmation prompt, the other way costs a funds movement nobody meant.

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

export function classifyAction(
  action: Action,
  node?: UiNode,
  vocabulary: RiskVocabulary = DEFAULT_RISK_VOCABULARY,
): Risk {
  switch (action.kind) {
    case 'read':
    case 'waitFor':
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

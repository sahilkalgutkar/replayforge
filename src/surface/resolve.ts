import type {
  Observation,
  Resolution,
  TargetMatcher,
  TargetSpec,
  TextMatcher,
  UiNode,
} from './types.js';

/**
 * Turns a recorded, surface-agnostic target description into exactly one node
 * of the current observation.
 *
 * Two rules carry the determinism claim:
 *
 * 1. **Ambiguity is a failure, never a coin flip.** If a matcher selects more
 *    than one node and the artifact did not declare an ordinal, resolution
 *    fails with `ambiguous`. Silently taking the first match is how a replay
 *    ends up clicking the wrong row in a grid and reporting success.
 * 2. **Which rung matched is part of the result.** A step that starts
 *    succeeding on a fallback rather than its primary is the earliest signal
 *    that the screen has drifted, so it is recorded per step rather than
 *    discarded.
 */

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function matchesText(matcher: TextMatcher, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const haystack = matcher.caseSensitive ? normalise(candidate) : normalise(candidate).toLowerCase();
  const needle = matcher.caseSensitive ? normalise(matcher.value) : normalise(matcher.value).toLowerCase();
  switch (matcher.mode) {
    case 'equals':
      return haystack === needle;
    case 'contains':
      return haystack.includes(needle);
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'regex':
      return new RegExp(matcher.value, matcher.caseSensitive ? '' : 'i').test(normalise(candidate));
  }
}

function framePathMatches(node: UiNode, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined) return true;
  if (node.framePath.length !== wanted.length) return false;
  return wanted.every((segment, i) => node.framePath[i] === segment);
}

function tableMatches(node: UiNode, matcher: TargetMatcher): boolean {
  const spec = matcher.inTable;
  if (spec === undefined) return true;
  const ctx = node.table;
  if (ctx === undefined) return false;
  if (!matchesText(spec.rowContains, ctx.rowHeader)) return false;
  if (typeof spec.column === 'number') return ctx.columnIndex === spec.column;
  return (
    ctx.columnHeader !== undefined &&
    normalise(ctx.columnHeader).toLowerCase() === normalise(spec.column).toLowerCase()
  );
}

export function matchesNode(matcher: TargetMatcher, node: UiNode): boolean {
  if (!node.visible) return false;
  if (matcher.role !== undefined && matcher.role !== node.role) return false;
  if (matcher.editable !== undefined && matcher.editable !== node.editable) return false;
  if (matcher.name !== undefined && !matchesText(matcher.name, node.name)) return false;
  if (matcher.nearbyText !== undefined && !matchesText(matcher.nearbyText, node.nearbyText)) {
    return false;
  }
  if (matcher.text !== undefined && !matchesText(matcher.text, node.text)) return false;
  if (matcher.value !== undefined && !matchesText(matcher.value, node.value)) return false;
  if (!framePathMatches(node, matcher.framePath)) return false;
  if (!tableMatches(node, matcher)) return false;
  return true;
}

export function candidatesFor(
  matcher: TargetMatcher,
  nodes: readonly UiNode[],
): readonly UiNode[] {
  return nodes.filter((node) => matchesNode(matcher, node));
}

export function resolveTarget(spec: TargetSpec, observation: Observation): Resolution {
  const rungs: Array<{ label: string; matcher: TargetMatcher }> = [
    { label: 'primary', matcher: spec.primary },
    ...(spec.fallbacks ?? []).map((matcher, i) => ({ label: `fallback:${i}`, matcher })),
  ];

  for (const { label, matcher } of rungs) {
    const matches = candidatesFor(matcher, observation.nodes);
    if (matches.length === 0) continue;
    if (matches.length > 1 && matcher.ordinal === undefined) {
      return { ok: false, failure: { reason: 'ambiguous', matchCount: matches.length, rung: label } };
    }
    const node = matches[matcher.ordinal ?? 0];
    if (node === undefined) {
      return { ok: false, failure: { reason: 'ambiguous', matchCount: matches.length, rung: label } };
    }
    return { ok: true, node, rung: label, matchCount: matches.length };
  }

  return { ok: false, failure: { reason: 'not_found', triedRungs: rungs.length } };
}

/** Renders a resolution failure into a line a human can act on. */
export function describeFailure(spec: TargetSpec, resolution: Resolution): string {
  if (resolution.ok) return '';
  const { failure } = resolution;
  if (failure.reason === 'not_found') {
    return `could not find ${spec.description} (tried ${failure.triedRungs} targeting rung(s))`;
  }
  return `${spec.description} matched ${failure.matchCount} controls on rung ${failure.rung}; the artifact declares no ordinal to choose between them`;
}

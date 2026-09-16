import type {
  Observation,
  Resolution,
  TargetMatcher,
  TargetSpec,
  TextMatcher,
  UiNode,
} from './types.js';

// Turns a recorded target into exactly one node of the current screen.
//
// Two rules matter here. An ambiguous match is a failure rather than a guess,
// because quietly taking the first match is how a replay clicks the wrong row
// in a grid and still reports success. And the rung that matched is part of the
// result, so a step that starts winning on a fallback shows up as drift instead
// of passing silently.

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function matchesText(matcher: TextMatcher, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const subject = normalise(candidate);
  const wanted = normalise(matcher.value);
  if (matcher.mode === 'regex') {
    return new RegExp(matcher.value, matcher.caseSensitive ? '' : 'i').test(subject);
  }
  const haystack = matcher.caseSensitive ? subject : subject.toLowerCase();
  const needle = matcher.caseSensitive ? wanted : wanted.toLowerCase();
  switch (matcher.mode) {
    case 'equals':
      return haystack === needle;
    case 'contains':
      return haystack.includes(needle);
    case 'startsWith':
      return haystack.startsWith(needle);
  }
}

function framePathMatches(node: UiNode, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined) return true;
  return (
    node.framePath.length === wanted.length &&
    wanted.every((segment, i) => node.framePath[i] === segment)
  );
}

function tableMatches(node: UiNode, matcher: TargetMatcher): boolean {
  const spec = matcher.inTable;
  if (spec === undefined) return true;
  const table = node.table;
  if (table === undefined) return false;
  if (!matchesText(spec.rowContains, table.rowHeader)) return false;
  if (typeof spec.column === 'number') return table.columnIndex === spec.column;
  return (
    table.columnHeader !== undefined &&
    normalise(table.columnHeader).toLowerCase() === normalise(spec.column).toLowerCase()
  );
}

export function matchesNode(matcher: TargetMatcher, node: UiNode): boolean {
  if (!node.visible) return false;
  if (matcher.role !== undefined && matcher.role !== node.role) return false;
  if (matcher.editable !== undefined && matcher.editable !== node.editable) return false;
  if (matcher.name !== undefined && !matchesText(matcher.name, node.name)) return false;
  if (matcher.nearbyText !== undefined && !matchesText(matcher.nearbyText, node.nearbyText)) return false;
  if (matcher.text !== undefined && !matchesText(matcher.text, node.text)) return false;
  if (matcher.value !== undefined && !matchesText(matcher.value, node.value)) return false;
  if (!framePathMatches(node, matcher.framePath)) return false;
  return tableMatches(node, matcher);
}

export function candidatesFor(matcher: TargetMatcher, nodes: readonly UiNode[]): readonly UiNode[] {
  return nodes.filter((node) => matchesNode(matcher, node));
}

export function resolveTarget(spec: TargetSpec, observation: Observation): Resolution {
  const rungs = [
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

/** Turns a failed resolution into a line someone can act on. */
export function describeFailure(spec: TargetSpec, resolution: Resolution): string {
  if (resolution.ok) return '';
  const { failure } = resolution;
  if (failure.reason === 'not_found') {
    return `could not find ${spec.description} (tried ${failure.triedRungs} targeting rung(s))`;
  }
  return `${spec.description} matched ${failure.matchCount} controls on rung ${failure.rung}, and the flow declares no ordinal to choose between them`;
}

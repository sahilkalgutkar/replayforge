import type {
  Action,
  Assertion,
  CapabilityArtifact,
  Guard,
  ParamSpec,
  Risk,
  SecretSpec,
  Step,
  TargetMatcher,
  TargetSpec,
  ValueSource,
} from '../artifact/schema.js';
import { capabilityArtifactSchema } from '../artifact/schema.js';
import { classifyAction, maxRisk } from '../policy/risk.js';
import { fingerprintNodes } from '../surface/fingerprint.js';
import { resolveTarget } from '../surface/resolve.js';
import type { Observation, UiNode } from '../surface/types.js';

/**
 * Turning a successful discovery run into a capability.
 *
 * This is where the project's central bet lives. The model decided *which*
 * control to act on, looking at the screen. Everything about how that control
 * will be found again — the matcher, the fallback ladder, the ordinal, the
 * checkpoint that proves the step landed, the risk class, the routes the
 * capability is allowed to touch — is derived here, deterministically, from
 * observations that were actually taken.
 *
 * The reason for the split: a model asked to write a locator will write one
 * that works today. Code that can test a candidate matcher against the screen
 * it came from can insist on one that resolves uniquely, and can record what to
 * fall back to. Neither half does the other's job well.
 */

export type DiscoveryToolCall =
  | { readonly tool: 'click'; readonly intent: string; readonly node: UiNode }
  | { readonly tool: 'type_text'; readonly intent: string; readonly node: UiNode; readonly text: string }
  | { readonly tool: 'select_option'; readonly intent: string; readonly node: UiNode; readonly option: string }
  | { readonly tool: 'press_key'; readonly intent: string; readonly key: string; readonly node?: UiNode }
  | {
      readonly tool: 'read_value';
      readonly intent: string;
      readonly node: UiNode;
      readonly key: string;
      readonly valueType: 'string' | 'number';
      readonly description: string;
      readonly raw: string;
    };

export interface DiscoveryStep {
  readonly call: DiscoveryToolCall;
  readonly before: Observation;
  readonly after: Observation;
}

export interface DiscoveredInput extends Omit<ParamSpec, 'required'> {
  /** The concrete value used during discovery, so literals can be parameterised. */
  readonly value: string;
  readonly required?: boolean;
}

export interface DiscoveredSecret extends SecretSpec {
  /** The placeholder the model was given, e.g. `{{core_password}}`. */
  readonly placeholder: string;
  /**
   * The real value, held only for the duration of the run so it can be
   * substituted at the keyboard and masked everywhere else. Neither this nor
   * the placeholder is written into the artifact.
   */
  readonly value: string;
}

export interface OutcomeProposal {
  readonly name: string;
  readonly description: string;
  readonly whenTextContains?: string;
  readonly whenHttpStatus?: readonly number[];
  readonly disposition: 'answer' | 'needs_human';
}

export interface SynthesisRequest {
  readonly capabilityId: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly productId: string;
  readonly productVersion?: string;
  readonly tenantId: string;
  /** Concrete entry URL the run started from. */
  readonly entryUrl: string;
  /** Binding variable name to the concrete value it held, e.g. baseUrl -> origin. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly inputs: readonly DiscoveredInput[];
  readonly secrets: readonly DiscoveredSecret[];
  readonly outcomes: readonly OutcomeProposal[];
  readonly steps: readonly DiscoveryStep[];
  readonly model: string;
  readonly promptVersion: string;
  readonly runId: string;
}

const LABEL_LIKE = /^[\p{L}][\p{L}\p{N} .,'’&/()-]{2,39}$/u;
/**
 * A row key longer than this came from a layout table, not a data grid — the
 * first cell of the row is the whole page. Coordinates built on it are noise.
 */
const MAX_ROW_KEY = 60;
const NOTICE_BUTTON = /^(acknowledge|dismiss|ok|close|continue)$/i;

// --- targeting ------------------------------------------------------------

function textMatcher(value: string, mode: 'equals' | 'contains' = 'equals') {
  return { mode, value } as const;
}

/**
 * Candidate matchers for a control, strongest first. "Strongest" means most
 * likely to still identify this control after the vendor reskins the page:
 * an accessible name beats a table coordinate beats an inferred label beats a
 * positional ordinal, and a positional ordinal is the last resort it sounds
 * like.
 */
function candidateMatchers(node: UiNode, purpose: TargetPurpose): TargetMatcher[] {
  const frame = node.framePath.length > 0 ? { framePath: [...node.framePath] } : {};
  const byName: TargetMatcher[] = [];
  const byCoordinate: TargetMatcher[] = [];
  const byLabel: TargetMatcher[] = [];

  if (node.name !== '') {
    byName.push({ role: node.role, name: textMatcher(node.name), ...frame });
    byName.push({ role: node.role, name: textMatcher(node.name, 'contains'), ...frame });
  }
  const rowKey = node.table?.rowHeader;
  if (rowKey !== undefined && rowKey.length <= MAX_ROW_KEY) {
    if (node.table?.columnHeader !== undefined) {
      byCoordinate.push({
        role: node.role,
        inTable: { rowContains: textMatcher(rowKey), column: node.table.columnHeader },
        ...frame,
      });
    }
    byCoordinate.push({
      role: node.role,
      inTable: { rowContains: textMatcher(rowKey), column: node.table?.columnIndex ?? 0 },
      ...frame,
    });
  }
  if (node.nearbyText !== undefined && node.nearbyText !== '') {
    byLabel.push({
      role: node.role,
      nearbyText: textMatcher(node.nearbyText),
      ...(node.editable ? { editable: true } : {}),
      ...frame,
    });
  }

  // For an extraction the node's name *is* the value being read, so matching on
  // it would pin the capability to the one record it was recorded against —
  // "the cell that says $4,182.55" finds nothing for the next member. Where the
  // grid gives a row key and a column header, that coordinate is the target,
  // and the value is only a last resort.
  return purpose === 'read'
    ? [...byCoordinate, ...byLabel, ...byName]
    : [...byName, ...byCoordinate, ...byLabel];
}

/** Replaces a value that came from an input with its `{{param}}` reference. */
function parameterise(value: string, inputs: readonly DiscoveredInput[]): string {
  const match = inputs.find((input) => input.value === value);
  return match ? `{{${match.name}}}` : value;
}

function parameteriseMatcher(matcher: TargetMatcher, inputs: readonly DiscoveredInput[]): TargetMatcher {
  const patched: TargetMatcher = { ...matcher };
  if (patched.name) {
    const value = parameterise(patched.name.value, inputs);
    if (value !== patched.name.value) {
      return { ...patched, name: { ...patched.name, value } };
    }
  }
  return patched;
}

/** Whether the target will be acted on or read from; it changes what is durable. */
export type TargetPurpose = 'act' | 'read';

export function deriveTarget(
  node: UiNode,
  observation: Observation,
  inputs: readonly DiscoveredInput[],
  describe: string,
  purpose: TargetPurpose = 'act',
): TargetSpec {
  const candidates = candidateMatchers(node, purpose).map((m) => parameteriseMatcher(m, inputs));
  const unique: TargetMatcher[] = [];

  for (const matcher of candidates) {
    // Test each candidate against the screen it came from, with the parameter
    // put back, so "resolves uniquely" is measured rather than assumed.
    const concrete = withConcreteValues(matcher, inputs);
    const resolution = resolveTarget({ description: describe, primary: concrete }, observation);
    if (resolution.ok && resolution.node.ref === node.ref) unique.push(matcher);
  }

  if (unique.length === 0) {
    // Nothing identifies it on its own. Fall back to position among its peers,
    // and say so in the description so a reviewer knows this step is the
    // fragile one.
    const peers = observation.nodes.filter(
      (n) => n.role === node.role && n.framePath.join('/') === node.framePath.join('/'),
    );
    const ordinal = peers.findIndex((n) => n.ref === node.ref);
    return {
      description: `${describe} (identified only by position — control ${ordinal + 1} of ${peers.length} with role ${node.role}; this is the least durable targeting available and is worth reviewing)`,
      primary: {
        role: node.role,
        ...(node.framePath.length > 0 ? { framePath: [...node.framePath] } : {}),
        ordinal: Math.max(ordinal, 0),
      },
    };
  }

  const [primary, ...rest] = unique;
  return {
    description: describe,
    primary: primary as TargetMatcher,
    ...(rest.length > 0 ? { fallbacks: rest.slice(0, 2) } : {}),
  };
}

function withConcreteValues(matcher: TargetMatcher, inputs: readonly DiscoveredInput[]): TargetMatcher {
  if (!matcher.name) return matcher;
  const reference = /^\{\{(.+)\}\}$/.exec(matcher.name.value);
  if (!reference) return matcher;
  const input = inputs.find((i) => i.name === reference[1]);
  return input ? { ...matcher, name: { ...matcher.name, value: input.value } } : matcher;
}

// --- checkpoints ----------------------------------------------------------

function keyOf(node: UiNode): string {
  return `${node.framePath.join('/')}|${node.role}|${node.name}`;
}

/**
 * Derives the condition that proves the step landed, by diffing the screen
 * before the action against the screen after it. A step with no checkpoint is
 * a step that trusts a click worked, so this tries hard before giving up.
 */
export function deriveCheckpoint(
  before: Observation,
  after: Observation,
  inputs: readonly DiscoveredInput[],
): Assertion | undefined {
  const seen = new Set(before.nodes.map(keyOf));
  const fresh = after.nodes.filter((node) => node.name !== '' && !seen.has(keyOf(node)));

  const ranked = [
    // A newly present control whose name is one of the caller's arguments is
    // the strongest checkpoint available: it proves the step landed *and* that
    // it landed on the right record.
    fresh.filter((n) => ['link', 'button', 'heading'].includes(n.role) && inputs.some((i) => i.value === n.name)),
    fresh.filter((n) => ['link', 'button', 'heading'].includes(n.role) && LABEL_LIKE.test(n.name)),
    fresh.filter((n) => ['cell', 'columnheader'].includes(n.role) && LABEL_LIKE.test(n.name)),
  ];

  for (const group of ranked) {
    for (const node of group) {
      const value = parameterise(node.name, inputs);
      const assertion: Assertion = { kind: 'textPresent', text: textMatcher(value, 'contains') };
      return assertion;
    }
  }

  if (before.url !== after.url) {
    return { kind: 'urlMatches', pattern: escapeRegExp(canonicalisePath(new URL(after.url).pathname, inputs)) };
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]+');
}

/** `/content/member/10021/accounts` becomes `/content/member/*​/accounts`. */
export function canonicalisePath(path: string, inputs: readonly DiscoveredInput[]): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      if (inputs.some((input) => input.value === segment)) return '*';
      if (/^\d{3,}$/.test(segment)) return '*';
      return segment;
    })
    .join('/');
}

// --- actions --------------------------------------------------------------

function valueSourceFor(
  raw: string,
  inputs: readonly DiscoveredInput[],
  secrets: readonly DiscoveredSecret[],
): ValueSource {
  const secret = secrets.find((s) => s.placeholder === raw || `{{${s.ref}}}` === raw);
  if (secret) return { kind: 'secret', ref: secret.ref };
  const input = inputs.find((i) => i.value === raw);
  if (input) return { kind: 'param', name: input.name };
  return { kind: 'literal', value: raw };
}

function actionFor(step: DiscoveryStep, request: SynthesisRequest): Action {
  const { call } = step;
  switch (call.tool) {
    case 'click':
      return { kind: 'click', target: deriveTarget(call.node, step.before, request.inputs, call.intent) };
    case 'type_text':
      return {
        kind: 'type',
        target: deriveTarget(call.node, step.before, request.inputs, call.intent),
        value: valueSourceFor(call.text, request.inputs, request.secrets),
      };
    case 'select_option':
      return {
        kind: 'select',
        target: deriveTarget(call.node, step.before, request.inputs, call.intent),
        value: valueSourceFor(call.option, request.inputs, request.secrets),
      };
    case 'press_key':
      return {
        kind: 'pressKey',
        key: call.key,
        ...(call.node
          ? { target: deriveTarget(call.node, step.before, request.inputs, call.intent) }
          : {}),
      };
    case 'read_value':
      return {
        kind: 'read',
        target: deriveTarget(call.node, step.before, request.inputs, call.intent, 'read'),
        into: call.key,
        from: call.node.editable ? 'value' : 'text',
        transform: call.valueType === 'number' ? { kind: 'currencyToNumber' } : { kind: 'trim' },
      };
  }
}

function nodeOf(call: DiscoveryToolCall): UiNode | undefined {
  return 'node' in call ? call.node : undefined;
}

function stepIdFor(call: DiscoveryToolCall, index: number): string {
  const node = nodeOf(call);
  const label = (node?.name || node?.nearbyText || call.tool)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28);
  return `${String(index + 1).padStart(2, '0')}_${label || call.tool}`;
}

// --- guards ---------------------------------------------------------------

/**
 * A notice the discovery run happened to meet and dismiss should not become a
 * mandatory step — it will not be there next time. It becomes a bounded guard
 * on the steps that follow it instead, which is the difference between a
 * capability that breaks when the notice is absent and one that copes either
 * way.
 */
function extractInterstitialGuard(
  steps: readonly DiscoveryStep[],
  request: SynthesisRequest,
): { guard: Guard; atIndex: number } | undefined {
  for (const [index, step] of steps.entries()) {
    const node = nodeOf(step.call);
    if (step.call.tool !== 'click' || !node || !NOTICE_BUTTON.test(node.name)) continue;
    const heading = step.before.nodes.find(
      (n) => ['heading', 'cell'].includes(n.role) && /notice|alert|maintenance|announcement/i.test(n.name),
    );
    if (!heading) continue;
    return {
      atIndex: index,
      guard: {
        name: `dismiss-${heading.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
        when: { kind: 'textPresent', text: textMatcher(heading.name, 'contains') },
        then: { kind: 'click', target: deriveTarget(node, step.before, request.inputs, `the ${node.name} button on the ${heading.name} screen`) },
        maxFirings: 2,
      },
    };
  }
  return undefined;
}

// --- the artifact ---------------------------------------------------------

export function synthesiseArtifact(request: SynthesisRequest): CapabilityArtifact {
  const bindingEntries = Object.entries(request.bindings);
  const templateUrl = (url: string): string =>
    bindingEntries.reduce((acc, [name, value]) => acc.split(value).join(`{{${name}}}`), url);

  // The caller's arguments show up on screen as data. Excluding them is what
  // keeps a fingerprint recorded for one member matching the same screen for
  // another.
  const inputValues = request.inputs.map((input) => input.value);
  const interstitial = extractInterstitialGuard(request.steps, request);
  const bodySteps = request.steps.filter((_, i) => i !== interstitial?.atIndex);

  const steps: Step[] = [
    {
      id: '00_open_entry',
      intent: 'Open the application at its entry point.',
      action: { kind: 'navigate', url: { kind: 'template', template: templateUrl(request.entryUrl) } },
      risk: 'safe',
      guards: [],
      retries: { max: 1, backoffMs: 500 },
      timeoutMs: 15_000,
      onFailure: 'fail',
      expectedControls: [],
      // No expectedFingerprint: the entry step navigates, so the screen it acts
      // on is whatever the browser happened to be showing, which is not part of
      // the application and not worth comparing.
      ...(request.steps[0] ? { checkpoint: firstScreenCheckpoint(request.steps[0].before) } : {}),
    },
    ...bodySteps.map((step, index) => {
      const action = actionFor(step, request);
      const node = nodeOf(step.call);
      const risk = classifyAction(action, node);
      const checkpoint = deriveCheckpoint(step.before, step.after, request.inputs);
      return {
        id: stepIdFor(step.call, index + 1),
        intent: step.call.intent,
        action,
        risk,
        guards:
          interstitial && index >= interstitial.atIndex - 1 ? [interstitial.guard] : [],
        timeoutMs: 15_000,
        retries: { max: 1, backoffMs: 500 },
        onFailure: 'fail' as const,
        expectedFingerprint: fingerprintNodes(step.before.nodes, inputValues),
        expectedControls: namedControls(step.before, inputValues),
        ...(checkpoint ? { checkpoint } : {}),
      };
    }),
  ];

  const reads = bodySteps.filter(
    (s): s is DiscoveryStep & { call: Extract<DiscoveryToolCall, { tool: 'read_value' }> } =>
      s.call.tool === 'read_value',
  );

  const outputs = reads.map((step) => ({
    name: step.call.key,
    type: step.call.valueType,
    description: step.call.description,
    sensitivity: looksPersonal(step.call.raw) ? ('pii' as const) : ('internal' as const),
    from: step.call.key,
    required: true,
  }));

  const successCheckpoint: Assertion =
    reads.length > 0
      ? {
          kind: 'all',
          of: reads.map((step) => ({
            kind: 'targetPresent' as const,
            target: deriveTarget(step.call.node, step.before, request.inputs, step.call.intent, 'read'),
          })),
        }
      : (steps.at(-1)?.checkpoint ?? { kind: 'urlMatches', pattern: '.' });

  const observed = [...request.steps.flatMap((s) => [s.before, s.after])];
  const routes = new Set<string>(['/']);
  for (const observation of observed) {
    for (const url of [observation.url, ...observation.frames.map((f) => f.url)]) {
      try {
        routes.add(canonicalisePath(new URL(url).pathname, request.inputs));
      } catch {
        /* a frame with no navigable url */
      }
    }
  }

  const actionKinds = new Set<string>(['navigate', 'waitFor', ...steps.map((s) => s.action.kind)]);
  const observedRisk = steps.reduce<Risk>((worst, step) => maxRisk(worst, step.risk), 'safe');

  return capabilityArtifactSchema.parse({
    schemaVersion: 1,
    id: request.capabilityId,
    version: 1,
    name: request.name,
    title: request.title,
    description: request.summary,
    app: {
      productId: request.productId,
      ...(request.productVersion ? { productVersion: request.productVersion } : {}),
      surface: 'browser',
      entryUrl: templateUrl(request.entryUrl),
      bindingVariables: Object.keys(request.bindings),
      recordedOnTenant: request.tenantId,
    },
    inputs: request.inputs.map(({ value: _value, ...spec }) => ({ ...spec, required: spec.required ?? true })),
    outputs,
    secrets: request.secrets.map(({ placeholder: _placeholder, value: _value, ...spec }) => spec),
    preconditions: [],
    steps,
    outcomes: request.outcomes
      .map((proposal) => ({
        name: proposal.name,
        description: proposal.description,
        when: outcomeAssertion(proposal),
        terminal: true,
        disposition: proposal.disposition,
      }))
      .filter((outcome) => outcome.when !== undefined),
    successCheckpoint,
    policy: {
      allowedOrigins: [templateUrl(new URL(request.entryUrl).origin)],
      allowedRoutes: [...routes].sort(),
      allowedActions: [...actionKinds].sort(),
      // Irreversible steps always need a person, whatever the recording did.
      maxRiskWithoutApproval: observedRisk === 'irreversible' ? 'sensitive' : observedRisk,
      maxSteps: steps.length + 8,
      maxDurationMs: 180_000,
    },
    approval: { state: 'draft' },
    stability: { runs: 0, successes: 0, fallbackResolutions: 0 },
    tenantOverrides: {},
    provenance: {
      discoveredAt: new Date().toISOString(),
      discoveryRunId: request.runId,
      model: request.model,
      promptVersion: request.promptVersion,
      humanEdits: [],
    },
  });
}

function outcomeAssertion(proposal: OutcomeProposal): Assertion | undefined {
  const parts: Assertion[] = [];
  if (proposal.whenTextContains && proposal.whenTextContains.trim() !== '') {
    parts.push({ kind: 'textPresent', text: textMatcher(proposal.whenTextContains.trim(), 'contains') });
  }
  if (proposal.whenHttpStatus && proposal.whenHttpStatus.length > 0) {
    parts.push({ kind: 'httpStatusIn', statuses: [...proposal.whenHttpStatus] });
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? (parts[0] as Assertion) : { kind: 'any', of: parts };
}

function firstScreenCheckpoint(observation: Observation): Assertion | undefined {
  const anchor = observation.nodes.find(
    (n) => ['button', 'link', 'heading'].includes(n.role) && LABEL_LIKE.test(n.name),
  );
  return anchor ? { kind: 'textPresent', text: textMatcher(anchor.name, 'contains') } : undefined;
}

function namedControls(observation: Observation, volatile: readonly string[] = []): string[] {
  const ignore = new Set(volatile.map((value) => value.trim().toLowerCase()));
  return [
    ...new Set(
      observation.nodes
        .filter((n) => ['button', 'link', 'heading', 'columnheader'].includes(n.role) && n.name !== '')
        .filter((n) => !ignore.has(n.name.trim().toLowerCase()))
        .map((n) => n.name),
    ),
  ].slice(0, 25);
}

/** Conservative: a value with two capitalised words and no digits reads as a name. */
function looksPersonal(value: string): boolean {
  return /^\p{Lu}\p{L}+(?: \p{Lu}\p{L}+)+$/u.test(value.trim());
}

import {
  capabilityArtifactSchema,
  type Action,
  type Assertion,
  type CapabilityArtifact,
  type Guard,
  type ParamSpec,
  type Risk,
  type SecretSpec,
  type Step,
  type TargetMatcher,
  type TargetSpec,
  type ValueSource,
} from '../artifact/schema.js';
import { classifyAction, maxRisk } from '../policy/risk.js';
import { fingerprintNodes } from '../surface/fingerprint.js';
import { resolveTarget } from '../surface/resolve.js';
import type { Observation, UiNode } from '../surface/types.js';

// Turns a successful discovery run into a capability.
//
// The model decided which control to act on. Everything about how that control
// gets found again - the matcher, the fallbacks, the check that the step landed,
// the risk, the allowed routes - is worked out here from screens that were
// actually seen. Each candidate matcher is tested against the screen it came
// from, so "matches exactly one control" is measured rather than hoped for.

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
  /** The value used during discovery, so it can be turned back into a parameter. */
  readonly value: string;
  /**
   * A value that shouldn't exist, like a member number nobody has. Discovery
   * replays the flow with it afterwards to see how the app reports that.
   */
  readonly probeValue?: string;
  readonly required?: boolean;
}

export interface DiscoveredSecret extends SecretSpec {
  /** Placeholder the model typed, e.g. `{{core_password}}`. */
  readonly placeholder: string;
  /** The real value, held only for this run. Never written anywhere. */
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
  readonly entryUrl: string;
  /** Tenant variable name to the value it had in this run, e.g. baseUrl. */
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
const NOTICE_BUTTON = /^(acknowledge|dismiss|ok|close|continue)$/i;
// A row key this long came from a layout table, not a data grid.
const MAX_ROW_KEY = 60;

function textMatcher(value: string, mode: 'equals' | 'contains' = 'equals') {
  return { mode, value } as const;
}

// --- targets --------------------------------------------------------------

/** Whether a target will be acted on or read from; it changes what's durable. */
export type TargetPurpose = 'act' | 'read';

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
  if (node.nearbyText) {
    byLabel.push({
      role: node.role,
      nearbyText: textMatcher(node.nearbyText),
      ...(node.editable ? { editable: true } : {}),
      ...frame,
    });
  }

  // When reading, the node's name *is* the value, so matching on it would only
  // ever find the record it was recorded against. The row and column are the
  // target; the value is a last resort.
  return purpose === 'read' ? [...byCoordinate, ...byLabel, ...byName] : [...byName, ...byCoordinate, ...byLabel];
}

/**
 * Swaps argument values inside prose for their `{{name}}`, so a step described
 * as "open the record for member 10021" says the right member on every replay.
 */
export function parameteriseText(text: string, inputs: readonly DiscoveredInput[]): string {
  return inputs
    .filter((input) => input.value.length >= 3)
    .reduce(
      (acc, input) =>
        acc.replace(new RegExp(`\\b${input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), `{{${input.name}}}`),
      text,
    );
}

function parameterise(value: string, inputs: readonly DiscoveredInput[]): string {
  const input = inputs.find((i) => i.value === value);
  return input ? `{{${input.name}}}` : value;
}

function withConcreteValue(matcher: TargetMatcher, inputs: readonly DiscoveredInput[]): TargetMatcher {
  const reference = matcher.name ? /^\{\{(.+)\}\}$/.exec(matcher.name.value) : null;
  const input = reference ? inputs.find((i) => i.name === reference[1]) : undefined;
  return input && matcher.name ? { ...matcher, name: { ...matcher.name, value: input.value } } : matcher;
}

export function deriveTarget(
  node: UiNode,
  observation: Observation,
  inputs: readonly DiscoveredInput[],
  description: string,
  purpose: TargetPurpose = 'act',
): TargetSpec {
  const candidates = candidateMatchers(node, purpose).map((matcher) =>
    matcher.name ? { ...matcher, name: { ...matcher.name, value: parameterise(matcher.name.value, inputs) } } : matcher,
  );

  const unique = candidates.filter((matcher) => {
    const resolution = resolveTarget({ description, primary: withConcreteValue(matcher, inputs) }, observation);
    return resolution.ok && resolution.node.ref === node.ref;
  });

  if (unique.length === 0) {
    const peers = observation.nodes.filter(
      (n) => n.role === node.role && n.framePath.join('/') === node.framePath.join('/'),
    );
    const ordinal = Math.max(peers.findIndex((n) => n.ref === node.ref), 0);
    return {
      description: `${description} (found only by position, control ${ordinal + 1} of ${peers.length}; the weakest kind of target, worth reviewing)`,
      primary: {
        role: node.role,
        ...(node.framePath.length > 0 ? { framePath: [...node.framePath] } : {}),
        ordinal,
      },
    };
  }

  const [primary, ...rest] = unique;
  return {
    description,
    primary: primary as TargetMatcher,
    ...(rest.length > 0 ? { fallbacks: rest.slice(0, 2) } : {}),
  };
}

// --- checks ---------------------------------------------------------------

const keyOf = (node: UiNode): string => `${node.framePath.join('/')}|${node.role}|${node.name}`;

/**
 * Proves a step landed by comparing the screen before and after it, preferring
 * a newly visible control named after one of the arguments: that shows the step
 * landed on the right record, not just somewhere.
 */
export function deriveCheckpoint(
  before: Observation,
  after: Observation,
  inputs: readonly DiscoveredInput[],
): Assertion | undefined {
  const seen = new Set(before.nodes.map(keyOf));
  const fresh = after.nodes.filter((node) => node.name !== '' && !seen.has(keyOf(node)));
  const controls = ['link', 'button', 'heading'];

  const ranked = [
    fresh.filter((n) => controls.includes(n.role) && inputs.some((i) => i.value === n.name)),
    fresh.filter((n) => controls.includes(n.role) && LABEL_LIKE.test(n.name)),
    fresh.filter((n) => ['cell', 'columnheader'].includes(n.role) && LABEL_LIKE.test(n.name)),
  ];
  for (const group of ranked) {
    const first = group[0];
    if (first) return { kind: 'textPresent', text: textMatcher(parameterise(first.name, inputs), 'contains') };
  }

  if (before.url !== after.url) {
    const path = canonicalisePath(new URL(after.url).pathname, inputs);
    return { kind: 'urlMatches', pattern: path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') };
  }
  return undefined;
}

/** `/content/member/10021/accounts` becomes `/content/member/*` + `/accounts`. */
export function canonicalisePath(path: string, inputs: readonly DiscoveredInput[]): string {
  return path
    .split('/')
    .map((segment) => (segment !== '' && (inputs.some((i) => i.value === segment) || /^\d{3,}$/.test(segment)) ? '*' : segment))
    .join('/');
}

// --- actions --------------------------------------------------------------

function valueSourceFor(
  raw: string,
  inputs: readonly DiscoveredInput[],
  secrets: readonly DiscoveredSecret[],
): ValueSource {
  const secret = secrets.find((s) => s.placeholder === raw);
  if (secret) return { kind: 'secret', ref: secret.ref };
  const input = inputs.find((i) => i.value === raw);
  if (input) return { kind: 'param', name: input.name };
  return { kind: 'literal', value: raw };
}

function actionFor(step: DiscoveryStep, request: SynthesisRequest): Action {
  const { call, before } = step;
  const described = parameteriseText(call.intent, request.inputs);
  const target = (node: UiNode, purpose: TargetPurpose = 'act') =>
    deriveTarget(node, before, request.inputs, described, purpose);
  switch (call.tool) {
    case 'click':
      return { kind: 'click', target: target(call.node) };
    case 'type_text':
      return { kind: 'type', target: target(call.node), value: valueSourceFor(call.text, request.inputs, request.secrets) };
    case 'select_option':
      return {
        kind: 'select',
        target: target(call.node),
        value: valueSourceFor(call.option, request.inputs, request.secrets),
      };
    case 'press_key':
      return { kind: 'pressKey', key: call.key, ...(call.node ? { target: target(call.node) } : {}) };
    case 'read_value':
      return {
        kind: 'read',
        target: target(call.node, 'read'),
        into: call.key,
        from: call.node.editable ? 'value' : 'text',
        transform: call.valueType === 'number' ? { kind: 'currencyToNumber' } : { kind: 'trim' },
      };
  }
}

function nodeOf(call: DiscoveryToolCall): UiNode | undefined {
  return 'node' in call ? call.node : undefined;
}

function stepIdFor(call: DiscoveryToolCall, index: number, inputs: readonly DiscoveredInput[]): string {
  const node = nodeOf(call);
  const shown = node?.name || node?.nearbyText || call.tool;
  const raw =
    call.tool === 'read_value'
      ? `read_${call.key}`
      : (inputs.find((input) => input.value === shown)?.name ?? shown);
  const label = raw
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28);
  return `${String(index).padStart(2, '0')}_${label || call.tool}`;
}

function namedControls(observation: Observation, volatile: readonly string[]): string[] {
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

// A notice the run happened to meet and dismiss shouldn't become a required
// step, because it won't be there next time. It becomes a capped guard on the
// steps that follow instead.
function interstitialGuard(
  steps: readonly DiscoveryStep[],
  request: SynthesisRequest,
): { guard: Guard; index: number } | undefined {
  for (const [index, step] of steps.entries()) {
    const node = nodeOf(step.call);
    if (step.call.tool !== 'click' || !node || !NOTICE_BUTTON.test(node.name)) continue;
    const heading = step.before.nodes.find(
      (n) => ['heading', 'cell'].includes(n.role) && /notice|alert|maintenance|announcement/i.test(n.name),
    );
    if (!heading) continue;
    return {
      index,
      guard: {
        name: `dismiss-${heading.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
        when: { kind: 'textPresent', text: textMatcher(heading.name, 'contains') },
        then: {
          kind: 'click',
          target: deriveTarget(node, step.before, request.inputs, `the ${node.name} button on the notice`),
        },
        maxFirings: 2,
      },
    };
  }
  return undefined;
}

/**
 * Typing changes nothing on screen except the field, so the before/after diff
 * finds no check. The field holding the value is the check: the exact argument
 * for a parameter, and just "not empty" for a credential, which can't appear in
 * the file.
 */
function typedValueCheck(action: Action, request: SynthesisRequest): Assertion | undefined {
  if (action.kind !== 'type') return undefined;
  const value =
    action.value.kind === 'param'
      ? textMatcher(`{{${action.value.name}}}`)
      : action.value.kind === 'secret'
        ? { mode: 'regex' as const, value: '.+' }
        : action.value.kind === 'literal'
          ? textMatcher(parameterise(action.value.value, request.inputs))
          : undefined;
  if (!value) return undefined;
  return {
    kind: 'targetPresent',
    target: {
      description: `${action.target.description}, now holding the typed value`,
      primary: { ...action.target.primary, value },
    },
  };
}

function outcomeAssertion(proposal: OutcomeProposal): Assertion | undefined {
  const parts: Assertion[] = [];
  if (proposal.whenTextContains?.trim()) {
    parts.push({ kind: 'textPresent', text: textMatcher(proposal.whenTextContains.trim(), 'contains') });
  }
  if (proposal.whenHttpStatus && proposal.whenHttpStatus.length > 0) {
    parts.push({ kind: 'httpStatusIn', statuses: [...proposal.whenHttpStatus] });
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? (parts[0] as Assertion) : { kind: 'any', of: parts };
}

/**
 * Added to every capability by the recorder rather than the model. A screen
 * answered with an HTTP error means the flow is somewhere it shouldn't carry on
 * from, whatever the page says. It only helps when the app uses status codes;
 * plenty of old apps answer 200 with an error page, and those need wording.
 */
export const HTTP_ERROR_OUTCOME = {
  name: 'HTTP_ERROR',
  description:
    'The application answered a screen with an HTTP error status (401, 403 or 5xx), such as a signed-out session, a permission denial or a server fault. Added to every recorded flow.',
  when: { kind: 'httpStatusIn' as const, statuses: [401, 403, 500, 502, 503] },
  terminal: true,
  disposition: 'needs_human' as const,
};

/** Two capitalised words and no digits reads like a person's name. */
function looksPersonal(value: string): boolean {
  return /^\p{Lu}\p{L}+(?: \p{Lu}\p{L}+)+$/u.test(value.trim());
}

// --- the artifact ---------------------------------------------------------

export function synthesiseArtifact(request: SynthesisRequest): CapabilityArtifact {
  const bindingEntries = Object.entries(request.bindings);
  const templateUrl = (url: string): string =>
    bindingEntries.reduce((acc, [name, value]) => acc.split(value).join(`{{${name}}}`), url);
  const inputValues = request.inputs.map((input) => input.value);

  const notice = interstitialGuard(request.steps, request);
  const kept = request.steps.filter((_, i) => i !== notice?.index);
  const firstScreen = request.steps[0]?.before;
  const firstAnchor = firstScreen?.nodes.find((n) => ['button', 'link', 'heading'].includes(n.role) && LABEL_LIKE.test(n.name));

  const steps: Step[] = [
    {
      id: '00_open',
      intent: 'Open the application at its entry point.',
      action: { kind: 'navigate', url: { kind: 'template', template: templateUrl(request.entryUrl) } },
      risk: 'safe',
      guards: [],
      timeoutMs: 15_000,
      retries: { max: 1, backoffMs: 500 },
      onFailure: 'fail',
      // No fingerprint: this step navigates, so the screen it starts from is
      // whatever the browser had open.
      expectedControls: [],
      ...(firstAnchor ? { checkpoint: { kind: 'textPresent', text: textMatcher(firstAnchor.name, 'contains') } } : {}),
    },
    ...kept.map((step, i) => {
      const action = actionFor(step, request);
      const checkpoint =
        deriveCheckpoint(step.before, step.after, request.inputs) ?? typedValueCheck(action, request);
      return {
        id: stepIdFor(step.call, i + 1, request.inputs),
        intent: parameteriseText(step.call.intent, request.inputs),
        action,
        risk: classifyAction(action, nodeOf(step.call)),
        guards: notice && i >= notice.index - 1 ? [notice.guard] : [],
        timeoutMs: 15_000,
        retries: { max: 1, backoffMs: 500 },
        onFailure: 'fail' as const,
        expectedFingerprint: fingerprintNodes(step.before.nodes, inputValues),
        expectedControls: namedControls(step.before, inputValues),
        ...(checkpoint ? { checkpoint } : {}),
      };
    }),
  ];

  const reads = kept.filter(
    (s): s is DiscoveryStep & { call: Extract<DiscoveryToolCall, { tool: 'read_value' }> } =>
      s.call.tool === 'read_value',
  );

  const routes = new Set<string>(['/']);
  for (const observation of request.steps.flatMap((s) => [s.before, s.after])) {
    for (const url of [observation.url, ...observation.frames.map((f) => f.url)]) {
      try {
        routes.add(canonicalisePath(new URL(url).pathname, request.inputs));
      } catch {
        // a frame without a navigable url
      }
    }
  }

  const worst = steps.reduce<Risk>((acc, step) => maxRisk(acc, step.risk), 'safe');

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
    inputs: request.inputs.map(({ value: _value, probeValue: _probe, ...spec }) => ({
      ...spec,
      required: spec.required ?? true,
    })),
    outputs: reads.map((step) => ({
      name: step.call.key,
      type: step.call.valueType,
      description: step.call.description,
      sensitivity: looksPersonal(step.call.raw) ? 'pii' : 'internal',
      from: step.call.key,
      required: true,
    })),
    secrets: request.secrets.map(({ placeholder: _p, value: _v, ...spec }) => spec),
    preconditions: [],
    steps,
    outcomes: [
      ...request.outcomes
        .map((proposal) => ({
          name: proposal.name,
          description: parameteriseText(proposal.description, request.inputs),
          when: outcomeAssertion(proposal),
          terminal: true,
          disposition: proposal.disposition,
        }))
        .filter((outcome) => outcome.when !== undefined && outcome.name !== HTTP_ERROR_OUTCOME.name),
      // Last, so a more specific declared outcome matches first.
      HTTP_ERROR_OUTCOME,
    ],
    successCheckpoint:
      reads.length > 0
        ? {
            kind: 'all',
            of: reads.map((step) => ({
              kind: 'targetPresent' as const,
              target: deriveTarget(
                step.call.node,
                step.before,
                request.inputs,
                parameteriseText(step.call.intent, request.inputs),
                'read',
              ),
            })),
          }
        : (steps.at(-1)?.checkpoint ?? { kind: 'urlMatches', pattern: '.' }),
    policy: {
      allowedOrigins: [templateUrl(new URL(request.entryUrl).origin)],
      allowedRoutes: [...routes].sort(),
      allowedActions: [...new Set(['navigate', 'waitFor', ...steps.map((s) => s.action.kind)])].sort(),
      // Irreversible steps always need a person, whatever the recording did.
      maxRiskWithoutApproval: worst === 'irreversible' ? 'sensitive' : worst,
      maxSteps: steps.length + 8,
      maxDurationMs: 180_000,
    },
    approval: { state: 'draft' },
    provenance: {
      discoveredAt: new Date().toISOString(),
      discoveryRunId: request.runId,
      model: request.model,
      promptVersion: request.promptVersion,
    },
  });
}

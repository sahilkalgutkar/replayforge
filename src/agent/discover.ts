import { randomUUID } from 'node:crypto';
import { capabilityArtifactSchema, type Action, type CapabilityArtifact, type OutcomeSpec } from '../artifact/schema.js';
import { RunRecorder, type ScreenshotPolicy } from '../evidence/recorder.js';
import { PolicyEngine } from '../policy/engine.js';
import { Redactor } from '../policy/redactor.js';
import { replay } from '../replay/engine.js';
import { UnattendedEscalationPort, type EscalationPort } from '../replay/escalation-port.js';
import type { Observation, Primitive, Surface, UiNode } from '../surface/types.js';
import type { ModelClient } from './model.js';
import { buildSystemPrompt, PROMPT_VERSION, renderScreen } from './prompt.js';
import { DISCOVERY_TOOLS, OUTCOME_TOOL } from './tools.js';
import {
  HTTP_ERROR_OUTCOME,
  parameteriseText,
  synthesiseArtifact,
  type DiscoveredInput,
  type DiscoveredSecret,
  type DiscoveryStep,
  type DiscoveryToolCall,
  type OutcomeProposal,
} from './synthesize.js';

// The discovery loop: look at the screen, ask the model what to do, do it, until
// the goal is met.
//
// Each turn sends the goal, a short list of steps already taken, the result of
// the last one and the current screen, rather than the whole conversation. On a
// local model the whole conversation outgrows the context window within a few
// screens and the goal falls out of it; this way every turn is about the same
// size no matter how long the flow is.
//
// Policy goes through the same engine replay uses. When it refuses something,
// that goes back to the model as the result of its last step instead of ending
// the run, so it can look for another way.

export interface DiscoverOptions {
  readonly goal: string;
  readonly appDescription: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly title: string;
  readonly productId: string;
  readonly productVersion?: string;
  readonly tenantId: string;
  readonly entryUrl: string;
  readonly bindings: Readonly<Record<string, string>>;
  readonly inputs: readonly DiscoveredInput[];
  readonly secrets: readonly DiscoveredSecret[];
  readonly surface: Surface;
  readonly model: ModelClient;
  readonly evidenceRoot: string;
  readonly runId?: string;
  readonly maxSteps?: number;
  readonly allowIrreversible?: boolean;
  readonly screenshots?: ScreenshotPolicy;
  readonly escalation?: EscalationPort;
}

export interface DiscoveryTrace {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly turns: number;
  readonly steps: readonly { readonly tool: string; readonly intent: string }[];
}

export type DiscoveryResult =
  | { readonly status: 'discovered'; readonly artifact: CapabilityArtifact; readonly trace: DiscoveryTrace }
  | { readonly status: 'gave_up' | 'failed'; readonly reason: string; readonly trace: DiscoveryTrace };

interface PlannedAction {
  readonly intent: string;
  readonly action: Action;
  readonly node?: UiNode;
  readonly primitive: Primitive;
  readonly record: (after: Observation) => DiscoveryToolCall;
  /** Plain description of what happened, fed back as the next turn's result. */
  readonly done: string;
  /** Identifies this action on this control, to spot the model repeating itself. */
  readonly signature: string;
}

// A filled credential field shows as the placeholder the model typed, not the
// redactor's marker. Otherwise it types `{{core_username}}`, sees
// `«secret:core_username»` in the field, decides it's wrong, and types it again
// forever.
function modelView(text: string): string {
  return text.replace(/«secret:([A-Za-z0-9_]+)»/g, '{{$1}}');
}

function describeControl(node: UiNode): string {
  if (node.name) return `the ${node.role} "${node.name}"`;
  if (node.nearbyText) return `the ${node.role} labelled "${node.nearbyText}"`;
  return `the ${node.role}`;
}

function identity(node: UiNode | undefined): string {
  return node ? `${node.framePath.join('/')}|${node.role}|${node.name}|${node.nearbyText ?? ''}` : '-';
}

const MAX_REPEATS = 3;

const placeholder = { description: 'the control the model chose', primary: {} };

export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const runId = options.runId ?? `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const maxSteps = options.maxSteps ?? 25;
  const escalation = options.escalation ?? new UnattendedEscalationPort();
  const redactor = new Redactor({ secrets: Object.fromEntries(options.secrets.map((s) => [s.ref, s.value])) });
  const recorder = await RunRecorder.open(options.evidenceRoot, runId, redactor, options.screenshots ?? 'on-failure');
  const origin = new URL(options.entryUrl).origin;

  const policy = new PolicyEngine({
    allowlist: {
      origins: [origin],
      routes: [],
      actions: ['navigate', 'click', 'type', 'select', 'setChecked', 'pressKey', 'read', 'waitFor'],
    },
    maxRiskWithoutApproval: options.allowIrreversible ? 'irreversible' : 'sensitive',
  });

  const system = buildSystemPrompt({
    goal: options.goal,
    appDescription: options.appDescription,
    inputs: Object.fromEntries(options.inputs.map((i) => [i.name, i.value])),
    secretRefs: options.secrets.map((s) => s.ref),
    allowedOrigin: origin,
    allowIrreversible: options.allowIrreversible ?? false,
    maxSteps,
    tools: DISCOVERY_TOOLS,
  });

  const steps: DiscoveryStep[] = [];
  const history: { tool: string; intent: string }[] = [];
  const trace = (turns: number): DiscoveryTrace => ({ runId, evidenceDir: recorder.directory, turns, steps: history });

  await recorder.event('discovery.started', {
    goal: options.goal,
    model: options.model.modelId,
    promptVersion: PROMPT_VERSION,
    entryUrl: options.entryUrl,
    inputs: Object.fromEntries(options.inputs.map((i) => [i.name, i.value])),
  });
  await options.surface.perform({ kind: 'navigate', url: options.entryUrl });

  let lastResult = 'The application has just been opened.';
  let nudged = false;
  let lastSignature = '';
  let repeats = 0;

  for (let turn = 1; turn <= maxSteps; turn += 1) {
    const observation = await options.surface.observe();
    const screen = renderScreen(observation, redactor);
    await recorder.screenshot(`turn-${turn}`, () => options.surface.screenshot(), 'step');

    const taken =
      history.length === 0 ? '  none yet' : history.map((h, i) => `  ${i + 1}. ${h.tool}: ${h.intent}`).join('\n');
    const decision = await options.model.turn({
      system,
      tools: DISCOVERY_TOOLS,
      messages: [
        {
          role: 'user',
          content: `STEPS TAKEN\n${taken}\n\nLAST RESULT\n${lastResult}\n\nSTEP ${turn} of ${maxSteps}\n${modelView(screen.text)}`,
        },
      ],
    });
    await recorder.event('model.decided', { turn, raw: decision.raw.slice(0, 1000) });

    if (!decision.call) {
      if (nudged) return fail('the model stopped choosing actions', turn);
      nudged = true;
      lastResult = 'Your reply was not a tool call. Reply with one JSON object with a "tool" field.';
      continue;
    }
    nudged = false;
    const { name, input } = decision.call;

    if (name === 'give_up') {
      const reason = String(input.reason ?? 'no reason given');
      const request = {
        id: randomUUID(),
        runId,
        capabilityId: options.capabilityId,
        capabilityName: options.name,
        tenantId: options.tenantId,
        stepId: `turn-${turn}`,
        stepIntent: options.goal,
        reason: 'target_unresolvable' as const,
        detail: reason,
        risk: 'safe' as const,
        location: observation.url,
        screenText: redactor.redact(observation.text.slice(0, 1200)),
        raisedAt: new Date().toISOString(),
      };
      await recorder.event('escalation.raised', { interventionId: request.id, detail: reason });
      const outcome = await escalation.raise(request);
      await recorder.event('escalation.resolved', { interventionId: request.id, resolution: outcome.resolution });
      await recorder.event('discovery.finished', { status: 'gave_up', reason });
      return { status: 'gave_up', reason, trace: trace(turn) };
    }

    if (name === 'finish') {
      if (steps.length === 0) {
        lastResult = 'Nothing has been done yet, so there is nothing to finish. Take the first step.';
        continue;
      }
      const proposals = parseOutcomes(input.outcomes);
      for (const proposal of proposals) {
        if (!proposal.whenTextContains && !(proposal.whenHttpStatus?.length ?? 0)) {
          // Kept in the log for whoever reviews the flow; probing may fill it in.
          await recorder.event('outcome.needs_detection', { outcome: proposal.name, disposition: proposal.disposition });
        }
      }
      const drafted = synthesiseArtifact({
        capabilityId: options.capabilityId,
        name: options.name,
        title: options.title,
        summary: String(input.summary ?? options.goal),
        productId: options.productId,
        ...(options.productVersion ? { productVersion: options.productVersion } : {}),
        tenantId: options.tenantId,
        entryUrl: options.entryUrl,
        bindings: options.bindings,
        inputs: options.inputs,
        secrets: options.secrets,
        outcomes: proposals,
        steps,
        model: options.model.modelId,
        promptVersion: PROMPT_VERSION,
        runId,
      });
      const artifact = await probeOutcomes(drafted, options, recorder, redactor, proposals);
      await recorder.writeJson('artifact', artifact);
      await recorder.event('discovery.finished', {
        status: 'discovered',
        steps: artifact.steps.length,
        outputs: artifact.outputs.map((o) => o.name),
        outcomes: artifact.outcomes.map((o) => o.name),
      });
      return { status: 'discovered', artifact, trace: trace(turn) };
    }

    const planned = plan(name, input, screen.controls, options.secrets);
    if ('error' in planned) {
      lastResult = `That didn't happen: ${planned.error}`;
      await recorder.event('model.corrected', { turn, reason: planned.error });
      continue;
    }

    // Small models at temperature 0 can get stuck repeating one step. Say so
    // plainly, and stop the run if it keeps happening.
    if (planned.signature === lastSignature) {
      repeats += 1;
      await recorder.event('model.repeated', { turn, signature: planned.signature, repeats });
      if (repeats >= MAX_REPEATS) return fail('the model kept repeating the same step', turn);
      lastResult = `You already did exactly that on the previous step, and it worked: ${lastResult.replace(/^Done\. /, '')} Do not repeat it. Take the next step toward the goal.`;
      continue;
    }

    const decisionCheck = policy.evaluate({ mode: 'discovery', action: planned.action, node: planned.node });
    if (decisionCheck.verdict !== 'allow') {
      lastResult =
        decisionCheck.verdict === 'block'
          ? `That isn't allowed: ${decisionCheck.reason}. Find another way or give up.`
          : `That control is ${decisionCheck.risk} and this run may not do ${decisionCheck.risk} things. Find a way that only reads, or give up.`;
      await recorder.event('policy.refused', { turn, rule: decisionCheck.rule, reason: decisionCheck.reason });
      continue;
    }

    try {
      await options.surface.perform(planned.primitive);
    } catch (error) {
      lastResult = `That failed: ${error instanceof Error ? error.message : String(error)}`;
      await recorder.event('action.failed', { turn, message: lastResult });
      continue;
    }

    const after = await options.surface.observe();
    steps.push({ call: planned.record(after), before: observation, after });
    history.push({ tool: name, intent: planned.intent });
    lastSignature = planned.signature;
    repeats = 0;
    lastResult = modelView(redactor.redact(`Done. ${planned.done} The screen is now ${after.url}.`));
    await recorder.event('action.performed', {
      turn,
      tool: name,
      intent: planned.intent,
      control: planned.node ? { role: planned.node.role, name: planned.node.name } : undefined,
      url: after.url,
    });
  }

  await recorder.screenshot('out-of-steps', () => options.surface.screenshot(), 'failure');
  return fail(`used all ${maxSteps} steps without finishing`, maxSteps);

  async function fail(reason: string, turns: number): Promise<DiscoveryResult> {
    await recorder.event('discovery.finished', { status: 'failed', reason });
    return { status: 'failed', reason, trace: trace(turns) };
  }
}

/**
 * A happy-path run never sees a failure screen, so the model can't know what
 * "no such member" looks like here. For each input with a probe value, replay
 * the draft with that value, capture the screen the app shows when the flow
 * can't continue, and ask the model which outcome it is. The detection text is
 * only accepted if it's actually on that screen.
 */
async function probeOutcomes(
  artifact: CapabilityArtifact,
  options: DiscoverOptions,
  recorder: RunRecorder,
  redactor: Redactor,
  proposals: readonly OutcomeProposal[],
): Promise<CapabilityArtifact> {
  const proposedNames = proposals.map((proposal) => proposal.name);
  let outcomes: OutcomeSpec[] = [...artifact.outcomes];
  const values = Object.fromEntries(options.inputs.map((input) => [input.name, input.value]));
  const env = Object.fromEntries(options.secrets.map((secret) => [secret.envVar, secret.value])) as NodeJS.ProcessEnv;

  for (const input of options.inputs.filter((i) => i.probeValue !== undefined)) {
    const probe = input.probeValue as string;
    await recorder.event('probe.started', { input: input.name, value: probe });
    const result = await replay({
      artifact,
      inputs: { ...values, [input.name]: probe },
      surface: options.surface,
      evidenceRoot: recorder.directory,
      runId: `probe-${input.name}`,
      variables: options.bindings,
      env,
      // Someone is watching discovery, and the draft only runs what it just did.
      riskyConfirmed: true,
      screenshots: 'never',
    });
    if (result.status !== 'failed') {
      await recorder.event('probe.inconclusive', { input: input.name, status: result.status });
      continue;
    }
    const seen = result.error.observed ?? '';
    await recorder.event('probe.observed', { input: input.name, stepId: result.error.stepId, screenText: seen });

    const known = proposedNames.length > 0 ? `\n\nOutcomes you proposed earlier: ${proposedNames.join(', ')}. If this screen is one of them, use that name.` : '';
    const answer = await options.model.turn({
      system:
        "You are reviewing a back-office application. Name the outcome a screen shows by what it means for the caller, like MEMBER_NOT_FOUND, and quote the screen's own wording.",
      tools: [OUTCOME_TOOL],
      messages: [
        {
          role: 'user',
          content: `When ${input.name} is ${JSON.stringify(probe)}, which should not exist, the application stopped at this screen instead of continuing:

${modelView(redactor.redact(seen))}

Which outcome is this? Copy the identifying phrase exactly from the text above.${known}`,
        },
      ],
    });
    const named = answer.call?.input ?? {};
    const phrase = String(named.when_text_contains ?? '').trim();
    const onScreen = phrase !== '' && normalise(seen).includes(normalise(phrase));
    // A name or phrase containing the probe value would only ever match that
    // value. The phrase keeps its shape with the argument swapped back in, so it
    // matches precisely for whoever is being looked up.
    const name = String(named.name ?? '')
      .split(probe)
      .join('')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    const detection = phrase.split(probe).join(`{{${input.name}}}`);
    if (!onScreen || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      await recorder.event('probe.rejected', { input: input.name, raw: answer.raw.slice(0, 400) });
      continue;
    }
    // The description the model gave while it was doing the task is better
    // than one written while staring at an error screen.
    const earlier = proposals.find((proposal) => proposal.name === name)?.description;
    const outcome: OutcomeSpec = {
      name,
      description: parameteriseText(earlier ?? String(named.description ?? name), options.inputs),
      when: { kind: 'textPresent', text: { mode: 'contains', value: detection } },
      terminal: true,
      disposition: named.disposition === 'needs_human' ? 'needs_human' : 'answer',
    };
    outcomes = [...outcomes.filter((o) => o.name !== name), outcome];
    await recorder.event('probe.outcome_added', { input: input.name, outcome: name, detection });
  }

  // The catch-all goes last so a more specific outcome always gets matched first.
  const ordered = [...outcomes.filter((o) => o.name !== HTTP_ERROR_OUTCOME.name), ...outcomes.filter((o) => o.name === HTTP_ERROR_OUTCOME.name)];
  return capabilityArtifactSchema.parse({ ...artifact, outcomes: ordered });
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Checks the model's chosen action against the screen and turns it into something runnable. */
function plan(
  name: string,
  input: Record<string, unknown>,
  controls: readonly UiNode[],
  secrets: readonly DiscoveredSecret[],
): PlannedAction | { error: string } {
  const intent = String(input.intent ?? '').trim();
  if (intent === '') return { error: 'every action needs an intent' };

  const pick = (): UiNode | { error: string } => {
    const index = Number(input.control);
    const node = Number.isInteger(index) ? controls[index - 1] : undefined;
    return node ?? { error: `there is no control ${String(input.control)}; the controls run from 1 to ${controls.length}` };
  };

  switch (name) {
    case 'click': {
      const node = pick();
      if ('error' in node) return node;
      return {
        intent,
        node,
        action: { kind: 'click', target: placeholder },
        primitive: { kind: 'click', ref: node.ref },
        record: () => ({ tool: 'click', intent, node }),
        done: `Clicked ${describeControl(node)}.`,
        signature: `click|${identity(node)}`,
      };
    }
    case 'type_text': {
      const node = pick();
      if ('error' in node) return node;
      if (!node.editable) return { error: `control ${String(input.control)} is a ${node.role}, which can't be typed into` };
      const text = String(input.text ?? '');
      // The model only ever sees placeholders; the real value goes in here.
      const real = secrets.reduce((t, s) => t.split(s.placeholder).join(s.value), text);
      return {
        intent,
        node,
        action: { kind: 'type', target: placeholder, value: { kind: 'literal', value: text } },
        primitive: { kind: 'fill', ref: node.ref, text: real },
        record: () => ({ tool: 'type_text', intent, node, text }),
        done: `Typed ${JSON.stringify(text)} into ${describeControl(node)}; it now holds that value.`,
        signature: `type|${identity(node)}|${text}`,
      };
    }
    case 'select_option': {
      const node = pick();
      if ('error' in node) return node;
      const option = String(input.option ?? '');
      return {
        intent,
        node,
        action: { kind: 'select', target: placeholder, value: { kind: 'literal', value: option } },
        primitive: { kind: 'select', ref: node.ref, value: option },
        record: () => ({ tool: 'select_option', intent, node, option }),
        done: `Selected ${JSON.stringify(option)} in ${describeControl(node)}.`,
        signature: `select|${identity(node)}|${option}`,
      };
    }
    case 'press_key': {
      const key = String(input.key ?? '');
      if (key === '') return { error: 'press_key needs a key' };
      const node = input.control === undefined ? undefined : pick();
      if (node && 'error' in node) return node;
      return {
        intent,
        ...(node ? { node } : {}),
        action: { kind: 'pressKey', key },
        primitive: { kind: 'press', key, ...(node ? { ref: node.ref } : {}) },
        record: () => ({ tool: 'press_key', intent, key, ...(node ? { node } : {}) }),
        done: `Pressed ${key}${node ? ` on ${describeControl(node)}` : ''}.`,
        signature: `press|${identity(node)}|${key}`,
      };
    }
    case 'read_value': {
      const node = pick();
      if ('error' in node) return node;
      const raw = (node.editable ? node.value : node.text) ?? '';
      if (raw.trim() === '') {
        return { error: `control ${String(input.control)} has no value to read; read the cell with the value, not its label` };
      }
      const key = String(input.key ?? '');
      return {
        intent,
        node,
        action: { kind: 'read', target: placeholder, into: key, from: 'text' },
        // Reading changes nothing on screen.
        primitive: { kind: 'waitForIdle', timeoutMs: 1 },
        record: () => ({
          tool: 'read_value',
          intent,
          node,
          key,
          valueType: input.value_type === 'number' ? 'number' : 'string',
          description: String(input.description ?? key),
          raw,
        }),
        done: `Recorded ${key} = ${JSON.stringify(raw)}.`,
        signature: `read|${identity(node)}|${key}`,
      };
    }
    default:
      return { error: `there is no tool called "${name}"` };
  }
}

function parseOutcomes(raw: unknown): OutcomeProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OutcomeProposal[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = String(record.name ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return [];
    return [
      {
        name,
        description: String(record.description ?? name),
        ...(typeof record.when_text_contains === 'string' && record.when_text_contains.trim()
          ? { whenTextContains: record.when_text_contains }
          : {}),
        ...(Array.isArray(record.when_http_status)
          ? { whenHttpStatus: record.when_http_status.filter((s): s is number => typeof s === 'number') }
          : {}),
        disposition: record.disposition === 'needs_human' ? 'needs_human' : 'answer',
      },
    ];
  });
}

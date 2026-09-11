import type Anthropic from '@anthropic-ai/sdk';
import type { CapabilityArtifact } from '../artifact/schema.js';
import { RunRecorder, type ScreenshotPolicy } from '../evidence/recorder.js';
import { PolicyEngine } from '../policy/engine.js';
import { Redactor } from '../policy/redactor.js';
import {
  UnattendedEscalationPort,
  type EscalationPort,
  type InterventionRequest,
} from '../replay/escalation-port.js';
import type { Observation, Surface, UiNode } from '../surface/types.js';
import type { ModelClient } from './model.js';
import { buildSystemPrompt, PROMPT_VERSION, renderScreen } from './prompt.js';
import { DISCOVERY_TOOLS } from './tools.js';
import {
  synthesiseArtifact,
  type DiscoveredInput,
  type DiscoveredSecret,
  type DiscoveryStep,
  type DiscoveryToolCall,
  type OutcomeProposal,
} from './synthesize.js';
import { randomUUID } from 'node:crypto';

/**
 * The discovery loop: observe, decide, act, until the goal is met.
 *
 * Three things about it are deliberate.
 *
 * The model sees the same normalised control listing the replay engine works
 * from, never markup. It keeps the prompt small, and it means the model's
 * mental model of the screen and the artifact's vocabulary are the same thing.
 *
 * Policy is enforced here, through the same engine replay uses, and a refusal
 * is handed back to the model as a tool error rather than ending the run. A
 * model that is told "that control is irreversible and you may not press it"
 * usually finds the read-only route to the same information, which is the
 * outcome worth having.
 *
 * And the model never writes targeting. It picks a control by number; the
 * durable target, the checkpoint and the risk class are derived afterwards from
 * observations that were actually taken.
 */

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
  /** Binding variable to the concrete value it holds for this run. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly inputs: readonly DiscoveredInput[];
  readonly secrets: readonly DiscoveredSecret[];
  readonly surface: Surface;
  readonly model: ModelClient;
  readonly evidenceRoot: string;
  readonly runId?: string;
  readonly maxSteps?: number;
  readonly allowIrreversible?: boolean;
  readonly allowedRoutes?: readonly string[];
  readonly screenshots?: ScreenshotPolicy;
  readonly escalation?: EscalationPort;
}

export interface DiscoveryTrace {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly turns: number;
  readonly steps: readonly { readonly intent: string; readonly tool: string }[];
}

export type DiscoveryResult =
  | { readonly status: 'discovered'; readonly artifact: CapabilityArtifact; readonly trace: DiscoveryTrace }
  | { readonly status: 'gave_up'; readonly reason: string; readonly trace: DiscoveryTrace }
  | { readonly status: 'failed'; readonly reason: string; readonly trace: DiscoveryTrace };

const MAX_TOOL_RESULT_CHARS = 400;

export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const runId = options.runId ?? `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const maxSteps = options.maxSteps ?? 25;
  const escalation = options.escalation ?? new UnattendedEscalationPort();

  const redactor = new Redactor({
    secrets: Object.fromEntries(options.secrets.map((s) => [s.ref, s.value])),
  });
  const recorder = await RunRecorder.open(
    options.evidenceRoot,
    runId,
    redactor,
    options.screenshots ?? 'on-failure',
  );

  const origin = new URL(options.entryUrl).origin;
  const policy = new PolicyEngine({
    allowlist: {
      origins: [origin],
      routes: options.allowedRoutes ?? [],
      actions: ['navigate', 'click', 'type', 'select', 'setChecked', 'pressKey', 'read', 'waitFor'],
    },
    // Irreversible work needs a person unless the operator launching discovery
    // said otherwise on the command line.
    maxRiskWithoutApproval: options.allowIrreversible ? 'irreversible' : 'sensitive',
  });

  const system = buildSystemPrompt({
    goal: options.goal,
    appDescription: options.appDescription,
    inputs: Object.fromEntries(options.inputs.map((i) => [i.name, i.value])),
    secretRefs: options.secrets.map((s) => s.ref),
    allowedOrigins: [origin],
    allowIrreversible: options.allowIrreversible ?? false,
    maxSteps,
  });

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const steps: DiscoveryStep[] = [];
  const summary: { intent: string; tool: string }[] = [];

  const trace = (turns: number): DiscoveryTrace => ({
    runId,
    evidenceDir: recorder.directory,
    turns,
    steps: summary,
  });

  await recorder.event('discovery.started', {
    runId,
    goal: options.goal,
    model: options.model.modelId,
    promptVersion: PROMPT_VERSION,
    entryUrl: options.entryUrl,
    inputs: Object.fromEntries(options.inputs.map((i) => [i.name, i.value])),
  });

  await options.surface.perform({ kind: 'navigate', url: options.entryUrl });

  let nudged = false;

  for (let turn = 1; turn <= maxSteps; turn += 1) {
    const observation = await options.surface.observe();
    const screen = renderScreen(observation, redactor);
    // Under an 'always' policy this captures the screen the model is about to
    // decide on, which is the frame a reviewer wants when a recorded step later
    // looks wrong. It is off by default because a capture of a member record
    // contains the member record.
    await recorder.screenshot(`turn-${turn}`, () => options.surface.screenshot(), 'step');

    messages.push({
      role: 'user',
      content: `STEP ${turn} of ${maxSteps}.\n\n${screen.text}`,
    });

    const result = await options.model.turn({ system, messages, tools: DISCOVERY_TOOLS });

    if (result.refusal) {
      await recorder.event('model.refused', result.refusal);
      return {
        status: 'failed',
        reason: `the model declined this request (${result.refusal.category ?? 'unspecified'}): ${result.refusal.explanation ?? 'no explanation given'}`,
        trace: trace(turn),
      };
    }

    if (!result.call) {
      if (nudged) {
        return { status: 'failed', reason: 'the model stopped choosing actions', trace: trace(turn) };
      }
      nudged = true;
      messages.push({ role: 'assistant', content: result.content });
      messages.push({
        role: 'user',
        content: 'Choose one tool call. If the goal is complete, call finish; if you are stuck, call give_up.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content: result.content });
    const call = result.call;
    await recorder.event('model.decided', {
      turn,
      tool: call.name,
      input: call.input,
      rationale: result.text.slice(0, 400),
    });

    if (call.name === 'give_up') {
      const reason = String(call.input.reason ?? 'no reason given');
      await raiseIntervention(escalation, recorder, {
        runId,
        capabilityId: options.capabilityId,
        capabilityName: options.name,
        tenantId: options.tenantId,
        stepId: `turn-${turn}`,
        stepIntent: options.goal,
        reason: 'target_unresolvable',
        detail: reason,
        risk: 'safe',
        location: observation.url,
        screenText: redactor.redact(observation.text.slice(0, 1200)),
      });
      return { status: 'gave_up', reason, trace: trace(turn) };
    }

    if (call.name === 'finish') {
      if (steps.length === 0) {
        messages.push(toolResult(call.id, 'You have not done anything yet. Take the first action.', true));
        continue;
      }
      const artifact = synthesiseArtifact({
        capabilityId: options.capabilityId,
        name: options.name,
        title: options.title,
        summary: String(call.input.summary ?? options.goal),
        productId: options.productId,
        ...(options.productVersion ? { productVersion: options.productVersion } : {}),
        tenantId: options.tenantId,
        entryUrl: options.entryUrl,
        bindings: options.bindings,
        inputs: options.inputs,
        secrets: options.secrets,
        outcomes: parseOutcomes(call.input.outcomes),
        steps,
        model: options.model.modelId,
        promptVersion: PROMPT_VERSION,
        runId,
      });
      await recorder.writeJson('artifact', artifact);
      await recorder.event('discovery.finished', {
        status: 'discovered',
        steps: artifact.steps.length,
        outputs: artifact.outputs.map((o) => o.name),
        outcomes: artifact.outcomes.map((o) => o.name),
      });
      return { status: 'discovered', artifact, trace: trace(turn) };
    }

    // --- an action -------------------------------------------------------
    const resolved = resolveControl(call, screen.controls);
    if ('error' in resolved) {
      messages.push(toolResult(call.id, resolved.error, true));
      await recorder.event('model.corrected', { turn, reason: resolved.error });
      continue;
    }

    const { node, action } = resolved;
    const decision = policy.evaluate({ mode: 'discovery', action: action.artifactAction, node });
    if (decision.verdict !== 'allow') {
      const message =
        decision.verdict === 'block'
          ? `That action is not permitted: ${decision.reason}. Find another route to the goal, or call give_up.`
          : `That control is ${decision.risk} and this run may not take ${decision.risk} actions: ${decision.reason}. Find a read-only route to the goal, or call give_up.`;
      await recorder.event('policy.refused', { turn, rule: decision.rule, reason: decision.reason });
      messages.push(toolResult(call.id, message, true));
      continue;
    }

    try {
      await performAction(options.surface, node, action, options.secrets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recorder.event('action.failed', { turn, message });
      messages.push(toolResult(call.id, `That action failed: ${message}`, true));
      continue;
    }

    const after = await options.surface.observe();
    steps.push({ call: action.discoveryCall(node, after), before: observation, after });
    summary.push({ intent: action.intent, tool: call.name });
    await recorder.event('action.performed', {
      turn,
      tool: call.name,
      intent: action.intent,
      control: { role: node.role, name: node.name, frame: node.framePath.join('/') },
      url: after.url,
    });

    messages.push(
      toolResult(
        call.id,
        `Done. The screen is now at ${after.url}.\n${redactor.redact(after.text).slice(0, MAX_TOOL_RESULT_CHARS)}`,
        false,
      ),
    );
  }

  await recorder.screenshot('out-of-steps', () => options.surface.screenshot(), 'failure');
  await recorder.event('discovery.finished', { status: 'failed', reason: 'step budget exhausted' });
  return {
    status: 'failed',
    reason: `the run used all ${maxSteps} steps without reaching the goal`,
    trace: trace(maxSteps),
  };
}

// --- helpers --------------------------------------------------------------

function toolResult(
  id: string,
  content: string,
  isError: boolean,
): Anthropic.Beta.BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  };
}

interface ResolvedAction {
  readonly intent: string;
  readonly artifactAction: Parameters<PolicyEngine['evaluate']>[0]['action'];
  readonly perform: (node: UiNode) => Parameters<Surface['perform']>[0];
  readonly discoveryCall: (node: UiNode, after: Observation) => DiscoveryToolCall;
}

const placeholderTarget = { description: 'the control the model selected', primary: {} };

function resolveControl(
  call: { name: string; input: Record<string, unknown> },
  controls: readonly UiNode[],
): { node: UiNode; action: ResolvedAction } | { error: string } {
  const intent = String(call.input.intent ?? '').trim();
  if (intent === '' && call.name !== 'press_key') {
    return { error: 'Every action needs an intent. Repeat the call with one.' };
  }

  const index = Number(call.input.control);
  const needsControl = call.name !== 'press_key' || call.input.control !== undefined;
  let node: UiNode | undefined;
  if (needsControl) {
    if (!Number.isInteger(index) || index < 1 || index > controls.length) {
      return {
        error: `There is no control ${String(call.input.control)} on this screen. The listing has ${controls.length} controls, numbered 1 to ${controls.length}.`,
      };
    }
    node = controls[index - 1];
  }

  switch (call.name) {
    case 'click': {
      if (!node) return { error: 'click needs a control number.' };
      return {
        node,
        action: {
          intent,
          artifactAction: { kind: 'click', target: placeholderTarget },
          perform: (n) => ({ kind: 'click', ref: n.ref }),
          discoveryCall: (n) => ({ tool: 'click', intent, node: n }),
        },
      };
    }
    case 'type_text': {
      if (!node) return { error: 'type_text needs a control number.' };
      if (!node.editable) {
        return { error: `Control ${index} is a ${node.role}, which cannot be typed into. Pick a text field.` };
      }
      const text = String(call.input.text ?? '');
      return {
        node,
        action: {
          intent,
          artifactAction: { kind: 'type', target: placeholderTarget, value: { kind: 'literal', value: text } },
          perform: (n) => ({ kind: 'fill', ref: n.ref, text }),
          discoveryCall: (n) => ({ tool: 'type_text', intent, node: n, text }),
        },
      };
    }
    case 'select_option': {
      if (!node) return { error: 'select_option needs a control number.' };
      const option = String(call.input.option ?? '');
      return {
        node,
        action: {
          intent,
          artifactAction: { kind: 'select', target: placeholderTarget, value: { kind: 'literal', value: option } },
          perform: (n) => ({ kind: 'select', ref: n.ref, value: option }),
          discoveryCall: (n) => ({ tool: 'select_option', intent, node: n, option }),
        },
      };
    }
    case 'press_key': {
      const key = String(call.input.key ?? '');
      if (key === '') return { error: 'press_key needs a key name.' };
      return {
        node: node ?? controls[0] ?? ({} as UiNode),
        action: {
          intent,
          artifactAction: { kind: 'pressKey', key },
          perform: (n) => (node ? { kind: 'press', key, ref: n.ref } : { kind: 'press', key }),
          discoveryCall: (n) => ({ tool: 'press_key', intent, key, ...(node ? { node: n } : {}) }),
        },
      };
    }
    case 'read_value': {
      if (!node) return { error: 'read_value needs a control number.' };
      const key = String(call.input.key ?? '');
      const valueType = call.input.value_type === 'number' ? ('number' as const) : ('string' as const);
      const raw = (node.editable ? node.value : node.text) ?? '';
      if (raw.trim() === '') {
        return {
          error: `Control ${index} holds no value to read. Read the cell containing the value, not its label.`,
        };
      }
      return {
        node,
        action: {
          intent,
          artifactAction: { kind: 'read', target: placeholderTarget, into: key, from: 'text' },
          // Reading changes nothing on the surface.
          perform: () => ({ kind: 'waitForIdle', timeoutMs: 1 }),
          discoveryCall: (n) => ({
            tool: 'read_value',
            intent,
            node: n,
            key,
            valueType,
            description: String(call.input.description ?? key),
            raw,
          }),
        },
      };
    }
    default:
      return { error: `Unknown tool "${call.name}".` };
  }
}

async function performAction(
  surface: Surface,
  node: UiNode,
  action: ResolvedAction,
  secrets: readonly DiscoveredSecret[],
): Promise<void> {
  const primitive = action.perform(node);
  if (primitive.kind === 'fill') {
    // The model was given placeholders; the real credential is substituted here
    // and never appears in the transcript, the log, or the artifact.
    const filled = secrets.reduce(
      (text, secret) => text.split(secret.placeholder).join(secret.value),
      primitive.text,
    );
    await surface.perform({ ...primitive, text: filled });
    return;
  }
  await surface.perform(primitive);
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
        ...(typeof record.when_text_contains === 'string' && record.when_text_contains.trim() !== ''
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

async function raiseIntervention(
  port: EscalationPort,
  recorder: RunRecorder,
  request: Omit<InterventionRequest, 'id' | 'raisedAt'>,
): Promise<void> {
  const full: InterventionRequest = { ...request, id: randomUUID(), raisedAt: new Date().toISOString() };
  await recorder.event('escalation.raised', { interventionId: full.id, detail: full.detail });
  const outcome = await port.raise(full);
  await recorder.event('escalation.resolved', { interventionId: full.id, resolution: outcome.resolution });
}

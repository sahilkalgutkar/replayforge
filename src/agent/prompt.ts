import type { Redactor } from '../policy/redactor.js';
import type { Observation, UiNode } from '../surface/types.js';
import type { ToolSpec } from './tools.js';

// How a screen is described to the model: the same normalised node list replay
// works from, never HTML. Everything is redacted first; the model never needs a
// member's SSN to decide which cell to read.

export const PROMPT_VERSION = 'discovery/2026-09-21';

const INTERACTIVE = new Set(['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio']);

export interface RenderedScreen {
  readonly text: string;
  /** Position + 1 is the number the model refers to. */
  readonly controls: readonly UiNode[];
}

function describeNode(node: UiNode): string {
  const parts = [node.role];
  if (node.name) parts.push(JSON.stringify(node.name));
  else if (node.nearbyText) parts.push(`(labelled ${JSON.stringify(node.nearbyText)})`);
  if (node.value !== undefined && node.value !== '') parts.push(`value=${JSON.stringify(node.value)}`);
  if (!node.enabled) parts.push('[disabled]');
  if (node.table?.rowHeader && node.table.columnHeader) {
    parts.push(`[row ${JSON.stringify(node.table.rowHeader)}, column ${JSON.stringify(node.table.columnHeader)}]`);
  } else if (node.table?.rowHeader) {
    parts.push(`[row ${JSON.stringify(node.table.rowHeader)}, column ${node.table.columnIndex}]`);
  }
  const frame = node.framePath.length > 0 ? `${node.framePath.join('/')}: ` : '';
  return `${frame}${parts.join(' ')}`;
}

export function renderScreen(observation: Observation, redactor: Redactor, limit = 120): RenderedScreen {
  const safe = redactor.redactObservation(observation);
  // Layout rows have a key made of the whole page; they're noise here.
  const useful = safe.nodes.filter(
    (n) =>
      n.visible &&
      (INTERACTIVE.has(n.role) || (n.text ?? n.name).trim() !== '') &&
      !(n.role === 'cell' && (n.table?.rowHeader?.length ?? 0) > 60),
  );
  const controls = useful.slice(0, limit);
  const header = [
    `URL: ${safe.url}`,
    safe.httpStatus === undefined ? undefined : `HTTP status: ${safe.httpStatus}`,
  ]
    .filter(Boolean)
    .join('\n');
  const listing = controls.map((node, i) => `  ${i + 1}. ${describeNode(node)}`).join('\n');
  const more = useful.length > controls.length ? `\n  ... ${useful.length - controls.length} more not listed` : '';
  return {
    text: `${header}\n\nSCREEN TEXT:\n${safe.text.trim().slice(0, 1200) || '(none)'}\n\nCONTROLS:\n${listing}${more}`,
    controls,
  };
}

export interface SystemPromptOptions {
  readonly goal: string;
  readonly appDescription: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly secretRefs: readonly string[];
  readonly allowedOrigin: string;
  readonly allowIrreversible: boolean;
  readonly maxSteps: number;
  readonly tools: readonly ToolSpec[];
}

function describeTool(tool: ToolSpec): string {
  const args = Object.entries(tool.parameters.properties)
    .map(([name, schema]) => {
      const optional = tool.parameters.required.includes(name) ? '' : ' (optional)';
      return `      ${name}${optional}: ${String(schema.description ?? schema.type)}`;
    })
    .join('\n');
  return `  ${tool.name}: ${tool.description}\n${args}`;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const inputs = Object.entries(options.inputs)
    .map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`)
    .join('\n');
  const credentials = options.secretRefs.map((ref) => `{{${ref}}}`).join(', ');

  return `You are operating a back-office application through its screens, the way a trained staff
member would, to work out how a task is done. What you do is saved as a flow that runs later
without you, so do the task cleanly and do nothing extra.

GOAL
${options.goal}

APPLICATION
${options.appDescription}

INPUTS (use these exact values)
${inputs || '  none'}
${
  credentials
    ? `\nCREDENTIALS
When a sign-on screen asks for a credential, type the placeholder exactly: ${credentials}.
The real value is filled in for you and never shown to you.\n`
    : ''
}
EACH TURN
You get the steps taken so far, the result of the last one, and the current screen as a numbered
list of CONTROLS. A control with no name of its own is shown with the label next to it, like
(labelled "Member Number"). Table cells show their row and column.

Reply with one JSON object: "tool" set to a tool name, plus that tool's arguments. Pick controls
by their number. Never write a selector.

TOOLS
${options.tools.map(describeTool).join('\n')}

RULES
1. Stay on ${options.allowedOrigin}.
2. Only take steps the goal needs.
3. ${
    options.allowIrreversible
      ? 'You may take an irreversible action if the goal requires it; say so in the intent.'
      : 'Never take an irreversible action such as posting, transferring, deleting or approving. If the goal needs one, call give_up.'
  }
4. Read each value the goal asks for with read_value before finishing. Read the cell with the value,
   not its label.
5. If a screen reports a problem (nothing found, access denied, session expired, an error page), do
   not work around it.
6. You have ${options.maxSteps} steps. Call finish as soon as the goal is met.

When you finish, list the outcomes a future run could reach besides success. A member that does not
exist is an answer, not a failure; access denied, an expired session or an error page need a person.
Only give detection wording you have actually seen. For the ones you haven't, standard HTTP statuses
are enough, and the system will check the rest itself afterwards.`;
}

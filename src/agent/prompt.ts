import type { Redactor } from '../policy/redactor.js';
import type { Observation, UiNode } from '../surface/types.js';

/**
 * How the screen is described to the model.
 *
 * Not HTML. The model sees the same normalised `UiNode` view the replay engine
 * sees — role, accessible name, inferred label, table coordinates — which keeps
 * the prompt small, keeps the model's mental model identical to the one the
 * artifact is written against, and means a desktop surface would render into
 * exactly the same listing.
 *
 * Everything here is redacted first. The model never needs a member's social
 * security number to work out which cell to read, so it never receives one.
 */

export const PROMPT_VERSION = 'discovery/2026-09-09';

const INTERACTIVE = new Set(['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio']);

export interface RenderedScreen {
  readonly text: string;
  /** Position in this array + 1 is the number the model refers to. */
  readonly controls: readonly UiNode[];
  readonly truncated: boolean;
}

function describeNode(node: UiNode): string {
  const parts: string[] = [node.role];
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

export function renderScreen(
  observation: Observation,
  redactor: Redactor,
  limit = 140,
): RenderedScreen {
  const safe = redactor.redactObservation(observation);
  const useful = safe.nodes.filter(
    (n) => n.visible && (INTERACTIVE.has(n.role) || (n.text ?? n.name).trim() !== ''),
  );
  const controls = useful.slice(0, limit);
  const lines = controls.map((node, i) => `  ${i + 1}. ${describeNode(node)}`);

  const header = [
    `URL: ${safe.url}`,
    safe.httpStatus === undefined ? undefined : `HTTP status: ${safe.httpStatus}`,
    `FRAMES: ${safe.frames.map((f) => f.path.join('/') || '(top)').join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const body = safe.text.trim().slice(0, 1500);

  return {
    text: `${header}\n\nSCREEN TEXT:\n${body || '(no text)'}\n\nCONTROLS:\n${lines.join('\n')}${
      useful.length > controls.length ? `\n  … ${useful.length - controls.length} more not listed` : ''
    }`,
    controls,
    truncated: useful.length > controls.length,
  };
}

export interface SystemPromptOptions {
  readonly goal: string;
  readonly appDescription: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly secretRefs: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowIrreversible: boolean;
  readonly maxSteps: number;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const inputLines = Object.entries(options.inputs)
    .map(([name, value]) => `  - ${name} = ${JSON.stringify(value)}`)
    .join('\n');

  return `You are operating a back-office business application through its user interface, the way a
trained staff member would, in order to work out how a task is done. What you learn will be
recorded as a reusable capability that runs afterwards without you, so how you do it matters as
much as whether it works.

GOAL
${options.goal}

APPLICATION
${options.appDescription}

${
  inputLines
    ? `INPUTS — the values this task was given. Use these exact values; do not invent or vary them:\n${inputLines}`
    : 'INPUTS: none.'
}

${
  options.secretRefs.length > 0
    ? `CREDENTIALS — you have been given placeholders, not the real values. When a sign-on screen asks
for one, type the placeholder exactly: ${options.secretRefs.map((r) => `{{${r}}}`).join(', ')}.
The real value is substituted outside your view and never appears in what is recorded.`
    : ''
}

HOW YOU SEE THE SCREEN
Each turn you receive the current screen as a numbered list of controls. The list is derived from
the application's accessibility information, not its markup. A control with no name of its own is
shown with the label found next to it, like (labelled "Member Number"). Cells inside a table are
shown with their row and column so you can tell one row from another.

HOW YOU ACT
Call exactly one tool per turn, choosing a control by its number. You are never asked to write a
selector, and you should not try: the recording system derives durable targeting from whichever
control you pick.

RULES
1. Stay inside this application. Permitted origins: ${options.allowedOrigins.join(', ')}.
2. Do the task and nothing else. Do not explore screens the goal does not need — every step you
   take becomes a step the capability repeats forever.
3. ${
    options.allowIrreversible
      ? 'You may complete an irreversible action if the goal requires it. Say so in the intent.'
      : 'Do not take irreversible actions — anything that posts, transfers, deletes, approves or otherwise cannot be undone. If the goal seems to require one, call give_up and explain.'
  }
4. Read the values the goal asks for with read_value before finishing. Read the cell holding the
   value, not the label beside it.
5. When a screen reports a problem — nothing found, permission denied, a session timeout, an error
   page — do not work around it. Note what it looked like; you will declare it as an outcome.
6. You have at most ${options.maxSteps} actions. Call finish as soon as the goal is met.

FINISHING
Call finish with a description of the capability and the outcomes a future run could legitimately
reach. Outcomes are results the caller needs told about, not crashes: a member that does not
exist is an answer, not a failure. Base the detection text on wording you actually saw this
application use.`;
}

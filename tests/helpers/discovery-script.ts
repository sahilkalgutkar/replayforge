import type { ModelTurnRequest } from '../../src/agent/model.js';

/**
 * Finds a control's number in the rendered screen the loop sent to the model.
 *
 * The tests pick controls the same way the model does — by reading the listing
 * — so a change that breaks how screens are rendered breaks these tests too,
 * which is the point.
 */
export function controlNumber(request: ModelTurnRequest, pattern: RegExp): number {
  const last = request.messages.at(-1);
  const text =
    typeof last?.content === 'string'
      ? last.content
      : JSON.stringify(last?.content ?? '');
  const section = text.split('CONTROLS:')[1] ?? '';
  for (const line of section.split('\n')) {
    const match = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (match && pattern.test(match[2] as string)) return Number(match[1]);
  }
  throw new Error(`no control matching ${pattern} in:\n${section}`);
}

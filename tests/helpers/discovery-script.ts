import type { ModelTurnRequest } from '../../src/agent/model.js';

// Finds a control's number in the screen the loop sent to the model, so scripted
// tests pick controls the same way the model does: by reading the listing.
export function controlNumber(request: ModelTurnRequest, pattern: RegExp): number {
  const text = request.messages.at(-1)?.content ?? '';
  const section = text.split('CONTROLS:')[1] ?? '';
  for (const line of section.split('\n')) {
    const match = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (match && pattern.test(match[2] as string)) return Number(match[1]);
  }
  throw new Error(`no control matching ${pattern} in:\n${section}`);
}

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, renderScreen } from '../../src/agent/prompt.js';
import { DISCOVERY_TOOLS } from '../../src/agent/tools.js';
import { Redactor } from '../../src/policy/redactor.js';
import { node } from '../helpers/nodes.js';
import type { Observation, UiNode } from '../../src/surface/types.js';

const redactor = new Redactor();

function screen(nodes: UiNode[], overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'o',
    capturedAt: 'now',
    url: 'http://app.test/x',
    title: '',
    frames: [],
    nodes,
    text: '',
    screenFingerprint: 'f',
    ...overrides,
  };
}

describe('rendering a screen for the model', () => {
  it('shows a label for an unnamed input and grid coordinates for a cell', () => {
    const text = renderScreen(
      screen([
        node({ role: 'textbox', editable: true, nearbyText: 'Member Number' }),
        node({
          role: 'cell',
          name: '$4,182.55',
          text: '$4,182.55',
          table: { rowIndex: 1, columnIndex: 3, rowHeader: 'Regular Savings', columnHeader: 'Current Balance' },
        }),
        node({ role: 'cell', name: 'x', text: 'x', table: { rowIndex: 1, columnIndex: 2, rowHeader: 'Row' } }),
      ]),
      redactor,
    ).text;
    expect(text).toContain('textbox (labelled "Member Number")');
    expect(text).toContain('[row "Regular Savings", column "Current Balance"]');
    expect(text).toContain('[row "Row", column 2]');
  });

  it('shows state, values and frames', () => {
    const text = renderScreen(
      screen([
        node({ role: 'button', name: 'Post', enabled: false }),
        node({ role: 'textbox', editable: true, nearbyText: 'Nickname', value: 'Holiday' }),
        node({ role: 'link', name: 'Member Search', framePath: ['navFrame'] }),
      ], { httpStatus: 403 }),
      redactor,
    ).text;
    expect(text).toContain('[disabled]');
    expect(text).toContain('value="Holiday"');
    expect(text).toContain('navFrame: link "Member Search"');
    expect(text).toContain('HTTP status: 403');
  });

  it('redacts before the model sees anything, and drops layout rows', () => {
    const rendered = renderScreen(
      screen(
        [
          node({ role: 'cell', name: '412-55-9087', text: '412-55-9087' }),
          node({ role: 'cell', name: 'Back', text: 'Back', table: { rowIndex: 0, columnIndex: 0, rowHeader: 'x'.repeat(80) } }),
        ],
        { text: 'SSN 412-55-9087' },
      ),
      redactor,
    );
    expect(rendered.text).not.toContain('412-55-9087');
    expect(rendered.controls).toHaveLength(1);
  });

  it('caps the listing and says how much it left out', () => {
    const many = Array.from({ length: 9 }, (_, i) => node({ role: 'button', name: `B${i}` }));
    const rendered = renderScreen(screen(many), redactor, 4);
    expect(rendered.controls).toHaveLength(4);
    expect(rendered.text).toContain('5 more not listed');
  });
});

describe('the system prompt', () => {
  const base = {
    goal: 'Read the balance.',
    appDescription: 'A console.',
    inputs: { memberNumber: '10021' },
    secretRefs: ['core_password'],
    allowedOrigin: 'http://app.test',
    maxSteps: 12,
    tools: DISCOVERY_TOOLS,
  };

  it('carries the goal, inputs, placeholders and every tool', () => {
    const prompt = buildSystemPrompt({ ...base, allowIrreversible: false });
    expect(prompt).toContain('Read the balance.');
    expect(prompt).toContain('memberNumber = "10021"');
    expect(prompt).toContain('{{core_password}}');
    for (const tool of DISCOVERY_TOOLS) expect(prompt).toContain(`${tool.name}:`);
    expect(prompt).toContain('Never take an irreversible action');
  });

  it('allows irreversible steps only when told to', () => {
    expect(buildSystemPrompt({ ...base, allowIrreversible: true })).toContain('You may take an irreversible action');
    expect(buildSystemPrompt({ ...base, inputs: {}, secretRefs: [], allowIrreversible: false })).toContain('none');
  });
});

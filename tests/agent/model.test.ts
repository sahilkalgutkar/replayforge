import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicModelClient, DEFAULT_MODEL, ScriptedModelClient } from '../../src/agent/model.js';
import { DISCOVERY_TOOLS } from '../../src/agent/tools.js';

/** A stub shaped like the one method this client calls. */
function stubClient(response: Record<string, unknown>): {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

const request = {
  system: 'you are operating an application',
  messages: [{ role: 'user' as const, content: 'STEP 1' }],
  tools: DISCOVERY_TOOLS,
};

describe('the Anthropic model client', () => {
  it('pulls out the tool call, the prose and the raw content to echo back', async () => {
    const { client } = stubClient({
      content: [
        { type: 'text', text: 'The sign-on screen is showing.' },
        { type: 'tool_use', id: 'tu_1', name: 'click', input: { control: 6, intent: 'sign on' } },
      ],
      stop_reason: 'tool_use',
      stop_details: null,
    });
    const turn = await new AnthropicModelClient({ client }).turn(request);

    expect(turn.call).toEqual({ id: 'tu_1', name: 'click', input: { control: 6, intent: 'sign on' } });
    expect(turn.text).toBe('The sign-on screen is showing.');
    expect(turn.content).toHaveLength(2);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.refusal).toBeUndefined();
  });

  it('reports no call when the model only wrote prose', async () => {
    const { client } = stubClient({
      content: [{ type: 'text', text: 'I am not sure what to do.' }],
      stop_reason: 'end_turn',
      stop_details: null,
    });
    const turn = await new AnthropicModelClient({ client }).turn(request);
    expect(turn.call).toBeUndefined();
    expect(turn.text).toContain('not sure');
  });

  it('surfaces a refusal with its category, so a stalled run explains itself', async () => {
    const { client } = stubClient({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
    });
    const turn = await new AnthropicModelClient({ client }).turn(request);
    expect(turn.refusal).toEqual({ category: 'cyber', explanation: 'declined' });
  });

  it('caches the prefix, asks for adaptive thinking, and opts into a fallback', async () => {
    const { client, create } = stubClient({ content: [], stop_reason: 'end_turn', stop_details: null });
    await new AnthropicModelClient({ client }).turn(request);

    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.model).toBe(DEFAULT_MODEL);
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.output_config).toEqual({ effort: 'high' });
    expect(sent.fallbacks).toBe('default');
    expect((sent.system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(sent.tool_choice).toEqual({ type: 'auto' });
  });

  it('takes the model id and effort from its options', async () => {
    const { client, create } = stubClient({ content: [], stop_reason: 'end_turn', stop_details: null });
    const model = new AnthropicModelClient({ client, modelId: 'claude-sonnet-5', effort: 'low' });
    expect(model.modelId).toBe('claude-sonnet-5');
    await model.turn(request);
    expect((create.mock.calls[0]?.[0] as Record<string, unknown>).output_config).toEqual({
      effort: 'low',
    });
  });
});

describe('the scripted client', () => {
  it('replays fixed calls and then reports the script is spent', async () => {
    const model = new ScriptedModelClient([{ name: 'click', input: { control: 1 } }]);
    expect((await model.turn(request)).call?.name).toBe('click');
    const spent = await model.turn(request);
    expect(spent.call).toBeUndefined();
    expect(spent.text).toContain('exhausted');
  });

  it('lets an entry read the request, so control numbers are not hardcoded', async () => {
    const model = new ScriptedModelClient([
      (r) => ({ name: 'click', input: { control: r.messages.length } }),
    ]);
    expect((await model.turn(request)).call?.input).toEqual({ control: 1 });
    expect(model.requests).toHaveLength(1);
  });
});

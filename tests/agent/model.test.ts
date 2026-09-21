import { describe, expect, it, vi } from 'vitest';
import { OllamaModelClient, ScriptedModelClient, parseDecision } from '../../src/agent/model.js';
import { DISCOVERY_TOOLS, OUTCOME_TOOL, decisionSchema } from '../../src/agent/tools.js';

const request = { system: 'sys', messages: [{ role: 'user' as const, content: 'STEP 1' }], tools: DISCOVERY_TOOLS };

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('decision parsing', () => {
  it('turns a tool object into a call', () => {
    expect(parseDecision('{"tool":"click","control":6,"intent":"sign on"}')).toEqual({
      call: { name: 'click', input: { control: 6, intent: 'sign on' } },
    });
  });

  it('gives no call for anything else', () => {
    expect(parseDecision('{"control":6}')).toEqual({});
    expect(parseDecision('not json')).toEqual({});
  });
});

describe('the decision schema', () => {
  it('lists one variant per tool, each naming its tool', () => {
    const schema = decisionSchema([OUTCOME_TOOL]) as { anyOf: Array<Record<string, unknown>> };
    expect(schema.anyOf).toHaveLength(1);
    expect(schema.anyOf[0]).toMatchObject({
      properties: { tool: { const: 'name_outcome' } },
      required: ['tool', 'name', 'description', 'when_text_contains', 'disposition'],
      additionalProperties: false,
    });
  });
});

describe('the Ollama client', () => {
  it('asks for output constrained to the tools, deterministically', async () => {
    const fetchImpl = stubFetch({ message: { content: '{"tool":"click","control":2,"intent":"go"}' } });
    const client = new OllamaModelClient({ fetchImpl, modelId: 'qwen3:14b', host: 'http://localhost:11434/' });
    const turn = await client.turn(request);

    expect(turn.call).toEqual({ name: 'click', input: { control: 2, intent: 'go' } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'qwen3:14b', stream: false, think: false, options: { temperature: 0 } });
    expect(sent.format).toEqual(decisionSchema(DISCOVERY_TOOLS));
    expect((sent.messages as Array<{ role: string }>)[0]?.role).toBe('system');
  });

  it('keeps the raw reply when it isn’t a call', async () => {
    const turn = await new OllamaModelClient({ fetchImpl: stubFetch({ message: { content: 'hmm' } }) }).turn(request);
    expect(turn.call).toBeUndefined();
    expect(turn.raw).toBe('hmm');
  });

  it('reports an error status and an unreachable server clearly', async () => {
    await expect(
      new OllamaModelClient({ fetchImpl: stubFetch({ error: 'no model' }, { ok: false, status: 404 }) }).turn(request),
    ).rejects.toThrow(/Ollama returned 404/);
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(new OllamaModelClient({ fetchImpl: down }).turn(request)).rejects.toThrow(/is it running\?/);
  });
});

describe('the scripted client', () => {
  it('plays fixed and computed entries, then runs out', async () => {
    const model = new ScriptedModelClient([
      { name: 'click', input: { control: 1 } },
      (r) => ({ name: 'click', input: { control: r.messages.length } }),
    ]);
    expect((await model.turn(request)).call?.input).toEqual({ control: 1 });
    expect((await model.turn(request)).call?.input).toEqual({ control: 1 });
    expect((await model.turn(request)).call).toBeUndefined();
    expect(model.requests).toHaveLength(3);
  });
});

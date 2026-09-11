import Anthropic from '@anthropic-ai/sdk';

/**
 * The model behind the discovery loop, behind an interface.
 *
 * The loop itself contains no vendor types, which is what lets the same loop
 * run against a scripted client in tests — the discovery path is then testable
 * without spending money or depending on a model behaving identically twice.
 */

export interface ModelTurnRequest {
  readonly system: string;
  readonly messages: Anthropic.Beta.BetaMessageParam[];
  readonly tools: Anthropic.Tool[];
}

export interface ModelTurn {
  /** The tool the model chose, if it chose one. */
  readonly call?: {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  };
  /** Any prose the model produced alongside the call. */
  readonly text: string;
  /** Assistant content echoed back verbatim on the next turn. */
  readonly content: Anthropic.Beta.BetaContentBlockParam[];
  readonly stopReason: string | null;
  readonly refusal?: { readonly category: string | null; readonly explanation: string | null };
}

export interface ModelClient {
  readonly modelId: string;
  turn(request: ModelTurnRequest): Promise<ModelTurn>;
}

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AnthropicModelClientOptions {
  readonly modelId?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * An already-constructed SDK client. Injected by the tests that cover how a
   * response is mapped into a ModelTurn — the tool call, the prose, and a
   * refusal — which is the part of this class worth verifying without paying
   * for a live call.
   */
  readonly client?: Anthropic;
}

export class AnthropicModelClient implements ModelClient {
  readonly modelId: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(options: AnthropicModelClientOptions = {}) {
    this.modelId = options.modelId ?? process.env.REPLAYFORGE_MODEL ?? DEFAULT_MODEL;
    this.client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.maxTokens = options.maxTokens ?? 16_000;
    this.effort = options.effort ?? 'high';
  }

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: this.maxTokens,
      // The system prompt and the tool list are identical on every turn of a
      // run, so caching the prefix keeps a twelve-step discovery from paying
      // for them twelve times.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools: request.tools,
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      // A model driving what is described as bank software is exactly the kind
      // of request a safety classifier may decline. Without a fallback, that
      // arrives as a run that simply stops, which is the worst way to learn
      // about it.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: request.messages,
    });

    const call = response.content.find(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
    );
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return {
      ...(call
        ? { call: { id: call.id, name: call.name, input: call.input as Record<string, unknown> } }
        : {}),
      text,
      content: response.content as unknown as Anthropic.Beta.BetaContentBlockParam[],
      stopReason: response.stop_reason,
      ...(response.stop_reason === 'refusal' && response.stop_details
        ? {
            refusal: {
              category: (response.stop_details as { category?: string | null }).category ?? null,
              explanation: (response.stop_details as { explanation?: string | null }).explanation ?? null,
            },
          }
        : {}),
    };
  }
}

export interface ScriptedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * A script entry is either a fixed call or a function of the request. The
 * function form matters: control numbers depend on what is on the screen, so a
 * script that hardcodes them tests nothing about whether the loop renders the
 * screen correctly.
 */
export type ScriptEntry = ScriptedCall | ((request: ModelTurnRequest) => ScriptedCall);

/**
 * A model client that replays a script of tool calls. Used by the tests that
 * exercise the discovery loop and artifact synthesis, which are the parts worth
 * verifying deterministically rather than paying a model to re-derive.
 */
export class ScriptedModelClient implements ModelClient {
  readonly modelId = 'scripted';
  private cursor = 0;
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly script: readonly ScriptEntry[]) {}

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const entry = this.script[this.cursor];
    this.cursor += 1;
    const next = typeof entry === 'function' ? entry(request) : entry;
    if (!next) {
      return { text: 'the script is exhausted', content: [], stopReason: 'end_turn' };
    }
    return {
      call: { id: `call-${this.cursor}`, name: next.name, input: next.input },
      text: '',
      content: [
        {
          type: 'tool_use',
          id: `call-${this.cursor}`,
          name: next.name,
          input: next.input,
        } as Anthropic.Beta.BetaContentBlockParam,
      ],
      stopReason: 'tool_use',
    };
  }
}

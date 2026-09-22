import { decisionSchema, type ToolSpec } from './tools.js';

// The model behind discovery, behind an interface. The loop doesn't know which
// backend it's talking to, which is also what lets tests run it against a
// scripted model.

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelTurnRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
}

export interface ModelTurn {
  readonly call?: { readonly name: string; readonly input: Record<string, unknown> };
  /** Whatever came back, for the log. */
  readonly raw: string;
}

export interface ModelClient {
  readonly modelId: string;
  turn(request: ModelTurnRequest): Promise<ModelTurn>;
}

export interface OllamaOptions {
  readonly modelId?: string;
  readonly host?: string;
  /** Context window to ask for. Each turn is kept small, so this is headroom. */
  readonly contextTokens?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A local model served by Ollama.
 *
 * Replies are constrained to a JSON schema of the tool vocabulary instead of
 * using Ollama's tool-call parsing. With qwen3:14b the tool-call parser dropped
 * three of eight calls in testing, returning neither text nor a call, while
 * constrained output gave a usable decision eight times out of eight.
 */
export class OllamaModelClient implements ModelClient {
  readonly modelId: string;
  private readonly host: string;
  private readonly contextTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.modelId = options.modelId ?? process.env.REPLAYFORGE_MODEL ?? 'qwen3:14b';
    this.host = (options.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.contextTokens = options.contextTokens ?? 8192;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.modelId,
          stream: false,
          think: false,
          format: decisionSchema(request.tools),
          options: { temperature: 0, num_ctx: this.contextTokens },
          messages: [{ role: 'system', content: request.system }, ...request.messages],
        }),
      });
    } catch (error) {
      throw new Error(
        `couldn't reach Ollama at ${this.host} (${error instanceof Error ? error.message : String(error)}); is it running?`,
      );
    }
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const raw = body.message?.content ?? '';
    return { raw, ...parseDecision(raw) };
  }
}

/** Turns a `{ "tool": ..., ...args }` reply into a call, or nothing if it isn't one. */
export function parseDecision(raw: string): Pick<ModelTurn, 'call'> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.tool !== 'string') return {};
    const { tool, ...input } = parsed;
    return { call: { name: tool, input } };
  } catch {
    return {};
  }
}

export interface ScriptedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * A script entry is a fixed call or a function of the request. The function form
 * matters because control numbers depend on the screen, so hardcoding them
 * would test nothing about how screens are rendered.
 */
export type ScriptEntry = ScriptedCall | ((request: ModelTurnRequest) => ScriptedCall);

/** Plays back a script of calls. Used by the tests. */
export class ScriptedModelClient implements ModelClient {
  readonly modelId = 'scripted';
  readonly requests: ModelTurnRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: readonly ScriptEntry[]) {}

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const entry = this.script[this.cursor];
    this.cursor += 1;
    if (!entry) return { raw: 'script finished' };
    const call = typeof entry === 'function' ? entry(request) : entry;
    return { call, raw: JSON.stringify({ tool: call.name, ...call.input }) };
  }
}

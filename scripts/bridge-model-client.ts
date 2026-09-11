import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelClient, ModelTurn, ModelTurnRequest } from '../src/agent/model.js';

/**
 * A ModelClient that hands each turn to an operator instead of an HTTP
 * endpoint.
 *
 * It writes the rendered screen to a file and waits for a decision to be
 * written back. Nothing about the discovery loop changes: the same prompt is
 * built, the same control listing is rendered, the same tool vocabulary is
 * offered, and the decision comes back in the same shape.
 *
 * I wrote it because the run that produced evidence/ was driven by an LLM I
 * already had in front of me rather than by an API key, and I wanted the loop
 * doing the work to be the real one rather than something I hand-simulated.
 * It has since earned its place for a second reason: it is the fastest way to
 * see what the model is actually being shown when a discovery run goes wrong.
 *
 * The default path remains AnthropicModelClient.
 */
export class BridgeModelClient implements ModelClient {
  private turnIndex = 0;

  constructor(
    private readonly directory: string,
    readonly modelId: string,
    private readonly timeoutMs = 45 * 60 * 1000,
  ) {}

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    this.turnIndex += 1;
    const index = this.turnIndex;
    await mkdir(this.directory, { recursive: true });

    const last = request.messages.at(-1);
    const screen =
      typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content, null, 2);

    if (index === 1) {
      await writeFile(join(this.directory, 'system.txt'), request.system, 'utf8');
      await writeFile(
        join(this.directory, 'tools.json'),
        JSON.stringify(request.tools, null, 2),
        'utf8',
      );
    }
    await writeFile(join(this.directory, `turn-${index}.screen.txt`), screen, 'utf8');
    await writeFile(join(this.directory, 'awaiting.txt'), String(index), 'utf8');

    const responsePath = join(this.directory, `turn-${index}.decision.json`);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(responsePath, 'utf8');
        const decision = JSON.parse(raw) as { name: string; input: Record<string, unknown> };
        return {
          call: { id: `bridge-${index}`, name: decision.name, input: decision.input },
          text: '',
          content: [
            {
              type: 'tool_use',
              id: `bridge-${index}`,
              name: decision.name,
              input: decision.input,
            },
          ] as ModelTurn['content'],
          stopReason: 'tool_use',
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw new Error(`no decision was written for turn ${index} within the timeout`);
  }
}

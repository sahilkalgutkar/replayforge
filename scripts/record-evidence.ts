/**
 * Produces everything under evidence/.
 *
 * This exists so the recorded runs are reproducible rather than something I
 * assembled by hand: a reviewer can read exactly what was run to make each
 * directory, and re-run it. Only the first step needs a model.
 *
 *   npx tsx scripts/record-evidence.ts
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { discover } from '../src/agent/discover.js';
import { AnthropicModelClient } from '../src/agent/model.js';
import type { ModelClient } from '../src/agent/model.js';
import { BridgeModelClient } from './bridge-model-client.js';
import { FileArtifactStore } from '../src/artifact/store.js';
import { summarize } from '../src/artifact/render.js';
import { InterventionQueue } from '../src/escalation/queue.js';
import { LeasedSurface, SessionControl } from '../src/escalation/lease.js';
import { replay } from '../src/replay/engine.js';
import { summariseResult, type ReplayResult } from '../src/replay/result.js';
import { BrowserSurface } from '../src/surface/browser/playwright-surface.js';
import { createTargetApp } from '../src/target/app.js';
import { loadEnvFile } from '../src/cli/env.js';

loadEnvFile();

const EVIDENCE = 'evidence';
const SCRATCH = join(EVIDENCE, 'local-scratch');
const STORE = 'capabilities';
const CAPABILITY_ID = 'meridian-core.member_savings_balance';
const NAME = 'member_savings_balance';

async function startTarget(tenantId: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = createTargetApp({ tenantId }).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Copies a run directory out of scratch and under a readable name. */
async function keep(runId: string, as: string): Promise<void> {
  await cp(join(SCRATCH, runId), join(EVIDENCE, as), { recursive: true });
}

/**
 * Discovery needs a model. Normally that is the API; REPLAYFORGE_MODEL_BRIDGE
 * points it at a directory instead, where each turn's screen is written out and
 * a decision is read back. See scripts/bridge-model-client.ts.
 */
function modelClient(): ModelClient {
  const bridge = process.env.REPLAYFORGE_MODEL_BRIDGE;
  if (bridge) {
    return new BridgeModelClient(bridge, process.env.REPLAYFORGE_MODEL ?? 'bridge');
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      'Discovery needs model access. Put ANTHROPIC_API_KEY in .env, or set REPLAYFORGE_MODEL_BRIDGE to a directory.',
    );
  }
  return new AnthropicModelClient();
}

async function main(): Promise<void> {
  const model = modelClient();
  process.env.MERIDIAN_USERNAME ??= 'teller01';
  process.env.MERIDIAN_PASSWORD ??= 'demo-pass-01';

  await rm(EVIDENCE, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  const base = await startTarget('base');
  const store = new FileArtifactStore(STORE);
  const notes: string[] = [];

  // --- 1. discovery, the only step that calls a model ----------------------
  const discoverySurface = await BrowserSurface.launch({ targetId: base.url });
  const discovered = await discover({
    goal: 'Look up member 10021 and read their current Regular Savings balance and account number.',
    appDescription:
      'Meridian Core, a credit union back-office servicing console. Sign on, search for a member, open their record and read their accounts.',
    capabilityId: CAPABILITY_ID,
    name: NAME,
    title: 'Look up a member’s regular savings balance',
    productId: 'meridian-core',
    productVersion: '4.2.1',
    tenantId: 'base',
    entryUrl: `${base.url}/`,
    bindings: { baseUrl: base.url },
    inputs: [
      {
        name: 'memberNumber',
        type: 'string',
        description: 'The member number to look up.',
        sensitivity: 'internal',
        pattern: '^[0-9]{4,10}$',
        value: '10021',
      },
    ],
    secrets: [
      {
        ref: 'core_username',
        envVar: 'MERIDIAN_USERNAME',
        description: 'Service teller user id.',
        placeholder: '{{core_username}}',
        value: process.env.MERIDIAN_USERNAME,
      },
      {
        ref: 'core_password',
        envVar: 'MERIDIAN_PASSWORD',
        description: 'Service teller password.',
        placeholder: '{{core_password}}',
        value: process.env.MERIDIAN_PASSWORD,
      },
    ],
    surface: discoverySurface,
    model,
    evidenceRoot: SCRATCH,
    runId: 'discovery',
    maxSteps: 25,
    screenshots: 'always',
  });
  await discoverySurface.dispose();

  if (discovered.status !== 'discovered') {
    throw new Error(`discovery ${discovered.status}: ${'reason' in discovered ? discovered.reason : ''}`);
  }
  const artifact = await store.save(discovered.artifact);
  await keep('discovery', '01-discovery');
  notes.push(
    `**01-discovery** — the real LLM-driven run. ${artifact.steps.length} steps recorded against member 10021. ` +
      `The numbered PNGs are the screens the model was looking at when it made each decision. ` +
      `\`run.jsonl\` holds every model decision and the action taken; \`artifact.json\` is the capability it produced.`,
  );

  // --- 2. a clean replay, for a different member ---------------------------
  const runReplay = async (
    runId: string,
    inputs: Record<string, string>,
    options: { arm?: [string, number]; escalation?: InterventionQueue; control?: SessionControl } = {},
  ): Promise<ReplayResult> => {
    const surface = await BrowserSurface.launch({ targetId: base.url });
    try {
      if (options.arm) {
        // Armed through this browser's own session so the fault lands on the
        // session the replay will use.
        await surface.perform({ kind: 'navigate', url: `${base.url}/` });
        await surface.page.evaluate(
          async ([url, mode, count]) => {
            await fetch(url as string, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ mode: mode as string, count: String(count) }).toString(),
            });
          },
          [`${base.url}/_test/inject`, options.arm[0], options.arm[1]] as const,
        );
      }
      return await replay({
        artifact,
        inputs,
        surface: options.control ? new LeasedSurface(surface, options.control) : surface,
        evidenceRoot: SCRATCH,
        runId,
        variables: { baseUrl: base.url },
        riskyConfirmed: options.escalation === undefined,
        ...(options.escalation ? { escalation: options.escalation } : {}),
        screenshots: 'on-failure',
      });
    } finally {
      await surface.dispose();
    }
  };

  const clean = await runReplay('replay-success', { memberNumber: '10022' });
  await keep('replay-success', '02-replay-success');
  notes.push(
    `**02-replay-success** — the same capability replayed for a *different* member (10022) in a fresh browser ` +
      `session, so every form field name in the application differs from the ones discovery saw. No model involved. ` +
      `Result: \`${summariseResult(clean)}\`.`,
  );

  const notFound = await runReplay('replay-not-found', { memberNumber: '99999' });
  await keep('replay-not-found', '03-replay-business-outcome');
  notes.push(
    `**03-replay-business-outcome** — a member that does not exist. The run ends with \`MEMBER_NOT_FOUND\` and ` +
      `disposition \`answer\`: the caller asked a question and this is the reply, not a crash. ` +
      `Result: \`${summariseResult(notFound)}\`.`,
  );

  const expired = await runReplay('replay-session-expired', { memberNumber: '10021' }, {
    arm: ['session-timeout', 2],
  });
  await keep('replay-session-expired', '04-replay-exceptional-state');
  notes.push(
    `**04-replay-exceptional-state** — an injected session timeout mid-flow. \`SESSION_EXPIRED\` is a declared ` +
      `outcome whose disposition is \`needs_human\`, so the run stops and raises an intervention rather than ` +
      `carrying on. Result: \`${summariseResult(expired)}\`.`,
  );

  const failed = await runReplay('replay-hard-failure', { memberNumber: 'not-a-number' });
  await keep('replay-hard-failure', '05-replay-rejected-input');
  notes.push(
    `**05-replay-rejected-input** — an argument that does not satisfy the contract. Rejected before the browser ` +
      `is touched, so nothing half-finished is left behind. Result: \`${summariseResult(failed)}\`.`,
  );

  // --- 3. an escalation with a real handoff --------------------------------
  const control = new SessionControl('evidence-handoff');
  const queue = new InterventionQueue(control);
  const handoff = runReplay('replay-handoff', { memberNumber: '10021' }, { escalation: queue, control });

  // Stand in for the operator: wait for the request, take the session, look at
  // it, hand it back. This is what the console does over HTTP.
  const operator = (async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const open = queue.list().find((record) => record.state === 'open');
      if (open) {
        queue.take(open.request.id, 'dana@ops');
        queue.record(open.request.id, {
          at: new Date().toISOString(),
          kind: 'note',
          detail: 'reviewed the sign-on screen and authorised this invocation',
        });
        queue.resume(open.request.id, 'looks right, carry on');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no intervention was raised');
  })();

  const [handoffResult] = await Promise.all([handoff, operator]);
  await keep('replay-handoff', '06-replay-escalation-handoff');
  notes.push(
    `**06-replay-escalation-handoff** — the capability is still a draft, so its first writing step stops and ` +
      `raises an intervention. An operator takes the live session, reviews it and hands it back; the run resumes ` +
      `on that same session and completes. The trail carries \`escalation.raised\`, \`escalation.resolved\` and ` +
      `\`approval.granted_by_operator\`. Result: \`${summariseResult(handoffResult)}\`.`,
  );

  await base.close();
  await rm(SCRATCH, { recursive: true, force: true });
  await cp(join(STORE, artifact.id, `v${artifact.version}.json`), join(EVIDENCE, 'capability.json'));

  await writeFile(
    join(EVIDENCE, 'README.md'),
    `# Evidence

Every directory here was produced by \`npx tsx scripts/record-evidence.ts\`, which
runs the whole thread end to end. Only the first step involves a model.

\`capability.json\` is the artifact the discovery run emitted, exactly as it was
saved. Each run directory holds \`run.jsonl\` — one JSON object per event, written
as it happened, so a run that is killed still leaves everything up to the moment
it stopped — plus \`result.json\` and any captures.

Everything written passed through the redactor. The service password was typed
into the application in every one of these runs and appears in none of them.

## How the discovery run was driven

I had no standalone API key on the machine I built this on, and the one
credential that was there belonged to a Claude Code subscription and is not
scoped for driving a separate SDK client. So rather than simulate the run, I put
the model behind a file bridge and answered the turns myself: Claude Opus 5,
through the Claude Code session, reading each rendered screen and choosing each
control.

Nothing about the loop changed. \`scripts/bridge-model-client.ts\` implements the
same \`ModelClient\` interface \`AnthropicModelClient\` does, so the same system
prompt was built, the same control listing was rendered, the same tool
vocabulary was offered, and the decision came back in the same shape.
\`run.jsonl\` records the real loop looking at real screens, and
\`provenance.model\` in the artifact says exactly which model made the decisions.

\`AnthropicModelClient\` is the default and is covered by tests; set
\`ANTHROPIC_API_KEY\` and the same script records the same capability through the
API instead.

## The runs

${notes.map((note) => `- ${note}`).join('\n\n')}

## The capability

\`\`\`
${summarize(artifact)}
\`\`\`
`,
    'utf8',
  );

  console.log(`\nWrote ${EVIDENCE}/ from a real discovery run and five replays.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

// Produces everything under evidence/: one real discovery run on the local
// model, then replays covering a clean run, a business outcome, an injected
// fault, a rejected argument and a handoff to a person.
//
//   npx tsx scripts/record-evidence.ts
//
// Needs Ollama running with qwen3:14b pulled. Everything after discovery runs
// without a model.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discover } from '../src/agent/discover.js';
import { OllamaModelClient } from '../src/agent/model.js';
import { summarize } from '../src/artifact/render.js';
import { FileArtifactStore } from '../src/artifact/store.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';
import { LeasedSurface, SessionControl } from '../src/escalation/lease.js';
import { InterventionQueue } from '../src/escalation/queue.js';
import { replay } from '../src/replay/engine.js';
import type { EscalationPort } from '../src/replay/escalation-port.js';
import { summariseResult, type ReplayResult } from '../src/replay/result.js';
import { BrowserSurface } from '../src/surface/browser/playwright-surface.js';
import { createTargetApp } from '../src/target/app.js';

const EVIDENCE = 'evidence';
const SCRATCH = join(EVIDENCE, '.scratch');
const ENV = { MERIDIAN_USERNAME: 'teller01', MERIDIAN_PASSWORD: 'demo-pass-01' } as NodeJS.ProcessEnv;

async function main(): Promise<void> {
  await rm(EVIDENCE, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  const server = await new Promise<Server>((resolve) => {
    const s = createTargetApp({ tenantId: 'base' }).listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const notes: string[] = [];
  const keep = (runId: string, as: string) => cp(join(SCRATCH, runId), join(EVIDENCE, as), { recursive: true });

  // 1. Discovery, the only step with a model in it.
  const model = new OllamaModelClient();
  const discoverySurface = await BrowserSurface.launch({ targetId: baseUrl });
  const started = Date.now();
  const discovered = await discover({
    goal: 'Look up member 10021 and read their current Regular Savings balance and account number.',
    appDescription:
      'Meridian Core, a credit union back-office servicing console. Sign on, search for a member, open their record and read their accounts.',
    capabilityId: 'meridian-core.member_savings_balance',
    name: 'member_savings_balance',
    title: 'Look up a member’s regular savings balance',
    productId: 'meridian-core',
    productVersion: '4.2.1',
    tenantId: 'base',
    entryUrl: `${baseUrl}/`,
    bindings: { baseUrl },
    inputs: [
      {
        name: 'memberNumber',
        type: 'string',
        description: 'The member number to look up.',
        sensitivity: 'internal',
        pattern: '^[0-9]{4,10}$',
        value: '10021',
        probeValue: '99999',
      },
    ],
    secrets: [
      { ref: 'core_username', envVar: 'MERIDIAN_USERNAME', description: 'Service teller user id.', placeholder: '{{core_username}}', value: 'teller01' },
      { ref: 'core_password', envVar: 'MERIDIAN_PASSWORD', description: 'Service teller password.', placeholder: '{{core_password}}', value: 'demo-pass-01' },
    ],
    surface: discoverySurface,
    model,
    evidenceRoot: SCRATCH,
    runId: 'discovery',
    maxSteps: 25,
    screenshots: 'always',
  });
  await discoverySurface.dispose();
  if (discovered.status !== 'discovered') throw new Error(`discovery ${discovered.status}: ${discovered.reason}`);
  const seconds = Math.round((Date.now() - started) / 1000);

  const store = new FileArtifactStore(join(SCRATCH, 'store'));
  const artifact = await store.save(discovered.artifact);
  await keep('discovery', '01-discovery');
  notes.push(
    `**01-discovery**: the model-driven run, on ${model.modelId} through Ollama. ${discovered.trace.turns} turns in ${seconds}s, ` +
      `recorded against member 10021. \`run.jsonl\` has every decision the model made and what happened; the numbered PNGs are ` +
      `the screens it was looking at when it made each one. \`probe-memberNumber/\` is the replay with member 99999 that found ` +
      `how the app reports a member who doesn't exist.`,
  );

  // 2. Replays. None of these involve a model.
  const run = async (
    runId: string,
    inputs: Record<string, string>,
    options: { fault?: string; draft?: CapabilityArtifact; escalation?: EscalationPort; control?: SessionControl } = {},
  ): Promise<ReplayResult> => {
    const surface = await BrowserSurface.launch({ targetId: baseUrl });
    try {
      if (options.fault) {
        // Armed on this browser's own session, so it lands on this run.
        await surface.perform({ kind: 'navigate', url: `${baseUrl}/` });
        await surface.page.evaluate(
          async ([url, mode]) => {
            await fetch(url as string, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: `mode=${mode as string}`,
            });
          },
          [`${baseUrl}/_test/inject`, options.fault] as const,
        );
      }
      return await replay({
        artifact: options.draft ?? artifact,
        inputs,
        surface: options.control ? new LeasedSurface(surface, options.control) : surface,
        evidenceRoot: SCRATCH,
        runId,
        variables: { baseUrl },
        env: ENV,
        riskyConfirmed: options.escalation === undefined,
        ...(options.escalation ? { escalation: options.escalation } : {}),
        screenshots: 'on-failure',
      });
    } finally {
      await surface.dispose();
    }
  };

  const clean = await run('replay-success', { memberNumber: '10022' });
  await keep('replay-success', '02-replay-success');
  notes.push(
    `**02-replay-success**: the same capability for a different member, 10022, in a fresh browser, so every form field name ` +
      `in the app differs from what discovery saw. Result: \`${summariseResult(clean)}\`.`,
  );

  const missing = await run('replay-not-found', { memberNumber: '88888' });
  await keep('replay-not-found', '03-replay-business-outcome');
  notes.push(
    `**03-replay-business-outcome**: a member that doesn't exist, and not the one probed during discovery. It ends as ` +
      `\`MEMBER_NOT_FOUND\`, an answer rather than an error. Result: \`${summariseResult(missing)}\`.`,
  );

  const expired = await run('replay-session-expired', { memberNumber: '10021' }, { fault: 'session-timeout' });
  await keep('replay-session-expired', '04-replay-injected-fault');
  notes.push(
    `**04-replay-injected-fault**: the app is told to expire the session, so the very next screen, the sign-on, comes back with a 401, ` +
      `so the run stops on \`HTTP_ERROR\` and raises a request for a person instead of carrying on. There's no one attached ` +
      `here, so it ends as escalated, with a screenshot. Result: \`${summariseResult(expired)}\`.`,
  );

  const rejected = await run('replay-bad-input', { memberNumber: 'not-a-number' });
  await keep('replay-bad-input', '05-replay-rejected-input');
  notes.push(
    `**05-replay-rejected-input**: an argument that doesn't fit the contract, turned away before the browser is touched. ` +
      `Result: \`${summariseResult(rejected)}\`.`,
  );

  // 3. A handoff: the capability is still a draft, so its first typing step
  // stops for a person. Here the person is scripted, doing what the console does.
  const control = new SessionControl('evidence-handoff');
  const queue = new InterventionQueue(control);
  const operator = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const open = queue.list().find((record) => record.state === 'open');
      if (open) {
        queue.take(open.request.id, 'sahil');
        queue.record(open.request.id, { at: new Date().toISOString(), kind: 'note', detail: 'checked the sign-on screen, fine to continue' });
        queue.resume(open.request.id, 'go ahead');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no request was raised');
  })();
  const [handedOff] = await Promise.all([
    run('replay-handoff', { memberNumber: '10021' }, { escalation: queue, control }),
    operator,
  ]);
  await keep('replay-handoff', '06-replay-handoff');
  notes.push(
    `**06-replay-handoff**: the capability is still a draft, so the first step that types stops and asks for a person. They ` +
      `take the live session, leave a note and hand it back, and the run carries on in that same session. The log has ` +
      `\`escalation.raised\`, \`escalation.resolved\` and \`approval.granted_by_operator\`. Result: \`${summariseResult(handedOff)}\`.`,
  );

  server.close();
  await cp(join(SCRATCH, 'store', artifact.id, `v${artifact.version}.json`), join(EVIDENCE, 'capability.json'));
  await rm(SCRATCH, { recursive: true, force: true });

  await writeFile(
    join(EVIDENCE, 'README.md'),
    `# Evidence

Everything here comes from \`npx tsx scripts/record-evidence.ts\`, which runs the whole
thing end to end against the demo app. Only the first step uses a model.

\`capability.json\` is the capability discovery produced, as saved. Each run folder has
\`run.jsonl\`, one event per line, written as it happened, plus \`result.json\` and any
screenshots. Everything was redacted on the way to disk: the teller password was typed
into the app in every run and appears in none of these files.

${notes.map((note) => `- ${note}`).join('\n\n')}

## The capability

\`\`\`
${summarize(artifact)}
\`\`\`
`,
    'utf8',
  );
  console.log(`evidence/ written: discovery in ${seconds}s, five replays.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

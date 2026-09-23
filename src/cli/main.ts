import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover } from '../agent/discover.js';
import { OllamaModelClient } from '../agent/model.js';
import { summarize, toToolDefinition } from '../artifact/render.js';
import { FileArtifactStore } from '../artifact/store.js';
import { validateArtifact } from '../artifact/validate.js';
import { CapabilityCatalog, toAgentResult } from '../catalog/catalog.js';
import { createOperatorConsole } from '../escalation/console.js';
import { LeasedSurface, SessionControl } from '../escalation/lease.js';
import { InterventionQueue } from '../escalation/queue.js';
import { replay } from '../replay/engine.js';
import { summariseResult } from '../replay/result.js';
import { BrowserSurface } from '../surface/browser/playwright-surface.js';
import { boolFlag, flag, parseArgs, requireFlag, type ParsedArgs } from './args.js';

const STORE = 'capabilities';
const EVIDENCE = 'runs';
const DEMO_SECRETS: Record<string, string> = {
  core_username: 'MERIDIAN_USERNAME',
  core_password: 'MERIDIAN_PASSWORD',
};

const USAGE = `replayforge: record a UI flow once with a model, then replay it without one.

  discover      --goal "..." --target <url> --capability <id> --name <snake_case>
                [--title "..."] [--input k=v]... [--probe k=v]... [--secret ref=ENV_VAR]...
                [--tenant base] [--allow-risky] [--model qwen3:14b] [--max-steps 25] [--headed]
  replay        <name> --target <url> [--input k=v]... [--tenant base] [--version N]
                [--confirm-risky] [--operator] [--headed]
  call          <name> --target <url> [--input k=v]...     prints the agent-facing JSON
  capabilities  [name] [--tools]
  approve       <name> --by <who> [--note "..."]

  --store <dir> (default ${STORE}), --runs <dir> (default ${EVIDENCE})`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'discover':
      return runDiscover(args);
    case 'replay':
      return runReplay(args);
    case 'call':
      return runCall(args);
    case 'capabilities':
      return runCapabilities(args);
    case 'approve':
      return runApprove(args);
    default:
      console.log(USAGE);
      return args.command === 'help' ? 0 : 1;
  }
}

const storeFor = (args: ParsedArgs) => new FileArtifactStore(flag(args, 'store', STORE));
const targetOf = (args: ParsedArgs) => requireFlag(args, 'target').replace(/\/+$/, '');

async function runsDir(args: ParsedArgs): Promise<string> {
  const dir = flag(args, 'runs', EVIDENCE);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function runDiscover(args: ParsedArgs): Promise<number> {
  const target = targetOf(args);
  const name = requireFlag(args, 'name');
  const secretMap = { ...DEMO_SECRETS, ...(args.pairs.secret ?? {}) };
  const missing = Object.entries(secretMap).filter(([, envVar]) => !process.env[envVar]);
  if (missing.length > 0) {
    console.error(`Missing from the environment: ${missing.map(([, v]) => v).join(', ')} (see .env.example)`);
    return 1;
  }

  const surface = await BrowserSurface.launch({ targetId: target, headless: !boolFlag(args, 'headed') });
  try {
    const probes = args.pairs.probe ?? {};
    const result = await discover({
      goal: requireFlag(args, 'goal'),
      appDescription: flag(args, 'app', 'A back-office business application.'),
      capabilityId: requireFlag(args, 'capability'),
      name,
      title: flag(args, 'title', name.replace(/_/g, ' ')),
      productId: flag(args, 'product', 'meridian-core'),
      tenantId: flag(args, 'tenant', 'base'),
      entryUrl: `${target}/`,
      bindings: { baseUrl: target },
      inputs: Object.entries(args.pairs.input ?? {}).map(([key, value]) => ({
        name: key,
        type: 'string' as const,
        description: `Given as ${key} on each call.`,
        sensitivity: 'internal' as const,
        value,
        ...(probes[key] ? { probeValue: probes[key] } : {}),
      })),
      secrets: Object.entries(secretMap).map(([ref, envVar]) => ({
        ref,
        envVar,
        description: `Read from ${envVar}.`,
        placeholder: `{{${ref}}}`,
        value: process.env[envVar] as string,
      })),
      surface,
      model: new OllamaModelClient(typeof args.flags.model === 'string' ? { modelId: args.flags.model } : {}),
      evidenceRoot: await runsDir(args),
      maxSteps: Number(flag(args, 'max-steps', '25')),
      allowIrreversible: boolFlag(args, 'allow-risky'),
    });
    if (result.status !== 'discovered') {
      console.error(`Discovery ${result.status}: ${result.reason}\nLog: ${result.trace.evidenceDir}`);
      return 1;
    }
    const saved = await storeFor(args).save(result.artifact);
    console.log(summarize(saved));
    for (const issue of validateArtifact(saved)) console.log(`  ${issue.severity}: ${issue.message}`);
    console.log(`\nSaved ${saved.id} v${saved.version}. Log: ${result.trace.evidenceDir}`);
    return 0;
  } finally {
    await surface.dispose();
  }
}

async function runReplay(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('replay needs a capability name; see `capabilities`');
    return 1;
  }
  const target = targetOf(args);
  const store = storeFor(args);
  const found = await new CapabilityCatalog(store).find(name);
  if (!found) {
    console.error(`No capability called "${name}".`);
    return 1;
  }
  const artifact = await store.load(found.id, typeof args.flags.version === 'string' ? Number(args.flags.version) : undefined);

  const surface = await BrowserSurface.launch({ targetId: target, headless: !boolFlag(args, 'headed') });
  const control = new SessionControl(`replay-${artifact.name}`);
  const queue = new InterventionQueue(control);
  let server: Server | undefined;
  if (boolFlag(args, 'operator')) {
    const port = Number(process.env.OPERATOR_HOST_PORT ?? 4320);
    const app = createOperatorConsole({ queue, control, surface, operator: flag(args, 'as', 'operator') });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
    console.log(`Operator console: http://localhost:${(server.address() as AddressInfo).port}/`);
  }

  try {
    const result = await replay({
      artifact,
      inputs: args.pairs.input ?? {},
      surface: new LeasedSurface(surface, control),
      evidenceRoot: await runsDir(args),
      tenantId: flag(args, 'tenant', artifact.app.recordedOnTenant),
      variables: { baseUrl: target, ...(args.pairs.variable ?? {}) },
      // Without the console there's nobody to hand to, so don't wait for one.
      escalation: boolFlag(args, 'operator') ? queue : new InterventionQueue(control, { waitMs: 1 }),
      riskyConfirmed: boolFlag(args, 'confirm-risky'),
    });
    console.log(summariseResult(result));
    for (const step of result.trace.steps) {
      const rung = step.rung && step.rung !== 'primary' ? ` [found on ${step.rung}]` : '';
      console.log(`  ${step.status.padEnd(9)} ${step.stepId}${rung}`);
    }
    console.log(`Log: ${result.trace.evidenceDir}`);
    return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
  } finally {
    await surface.dispose();
    server?.close();
  }
}

async function runCall(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('call needs a capability name');
    return 1;
  }
  const target = targetOf(args);
  const result = await new CapabilityCatalog(storeFor(args)).invoke(name, args.pairs.input ?? {}, {
    tenantId: flag(args, 'tenant', 'base'),
    variables: { baseUrl: target },
    evidenceRoot: await runsDir(args),
    openSurface: () => BrowserSurface.launch({ targetId: target, headless: !boolFlag(args, 'headed') }),
    riskyConfirmed: boolFlag(args, 'confirm-risky'),
  });
  console.log(JSON.stringify(toAgentResult(result), null, 2));
  return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
}

async function runCapabilities(args: ParsedArgs): Promise<number> {
  const catalog = new CapabilityCatalog(storeFor(args));
  if (boolFlag(args, 'tools')) {
    console.log(JSON.stringify(await catalog.toolDefinitions({ includeDrafts: true }), null, 2));
    return 0;
  }
  const name = args.positional[0];
  if (name) {
    const artifact = await catalog.find(name);
    if (!artifact) {
      console.error(`No capability called "${name}".`);
      return 1;
    }
    console.log(summarize(artifact));
    console.log(`\nWhat a calling agent sees:\n${JSON.stringify(toToolDefinition(artifact), null, 2)}`);
    return 0;
  }
  const entries = await catalog.entries();
  if (entries.length === 0) console.log('Nothing recorded yet. Use `discover`.');
  for (const entry of entries) {
    const note = entry.invocableUnattended ? '' : '  (needs approval before unattended use)';
    console.log(`${entry.tool.name.padEnd(28)} v${entry.artifact.version}  ${entry.artifact.approval.state.padEnd(8)} ${entry.tool.risk}${note}`);
  }
  return 0;
}

async function runApprove(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('approve needs a capability name');
    return 1;
  }
  const store = storeFor(args);
  const artifact = await new CapabilityCatalog(store).find(name);
  if (!artifact) {
    console.error(`No capability called "${name}".`);
    return 1;
  }
  const by = requireFlag(args, 'by');
  const at = new Date().toISOString();
  // Approval is a new version, so the file someone reviewed stays as they read it.
  const approved = await store.save({
    ...artifact,
    approval: {
      state: 'approved',
      approvedBy: by,
      approvedAt: at,
      ...(typeof args.flags.note === 'string' ? { note: args.flags.note } : {}),
    },
    provenance: {
      ...artifact.provenance,
      humanEdits: [...artifact.provenance.humanEdits, { at, by, summary: `approved v${artifact.version}` }],
    },
  });
  console.log(`${approved.name} v${approved.version} approved by ${by}.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

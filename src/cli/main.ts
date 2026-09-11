import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { FileArtifactStore } from '../artifact/store.js';
import { summarize, toToolDefinition } from '../artifact/render.js';
import { validateArtifact } from '../artifact/validate.js';
import { CapabilityCatalog, toAgentResult } from '../catalog/catalog.js';
import { discover } from '../agent/discover.js';
import { AnthropicModelClient } from '../agent/model.js';
import { createOperatorConsole } from '../escalation/console.js';
import { InterventionQueue } from '../escalation/queue.js';
import { LeasedSurface, SessionControl } from '../escalation/lease.js';
import { replay } from '../replay/engine.js';
import { summariseResult } from '../replay/result.js';
import { BrowserSurface } from '../surface/browser/playwright-surface.js';
import { boolFlag, flag, parseArgs, requireFlag, type ParsedArgs } from './args.js';
import { loadEnvFile } from './env.js';

loadEnvFile();

const DEFAULT_STORE = 'capabilities';
const DEFAULT_EVIDENCE = 'evidence';
const DEFAULT_SECRETS: Record<string, string> = {
  core_username: 'MERIDIAN_USERNAME',
  core_password: 'MERIDIAN_PASSWORD',
};

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
      printUsage();
      return args.command === 'help' ? 0 : 1;
  }
}

function printUsage(): void {
  console.log(`replayforge — record a UI flow once with a model, then replay it without one.

  discover      --goal "..." --target <url> --capability <id> --name <snake_case>
                [--title "..."] [--input k=v]... [--secret ref=ENV_VAR]... [--tenant base]
                [--allow-risky] [--model claude-opus-5] [--max-steps 25] [--headed]

  replay        <capability name> --target <url> [--input k=v]... [--tenant base]
                [--version N] [--confirm-risky] [--operator] [--headed]

  call          <capability name> --target <url> [--input k=v]...
                Prints only the agent-facing JSON result.

  capabilities  [name]        List the catalog, or show one capability.
                --tools       Print the tool definitions a calling model would see.

  approve       <capability name> --by <who> [--note "..."]

Common flags: --store <dir> (default ${DEFAULT_STORE}), --evidence <dir> (default ${DEFAULT_EVIDENCE}).`);
}

function storeFor(args: ParsedArgs): FileArtifactStore {
  return new FileArtifactStore(flag(args, 'store', DEFAULT_STORE));
}

async function runDiscover(args: ParsedArgs): Promise<number> {
  const target = requireFlag(args, 'target').replace(/\/+$/, '');
  const name = requireFlag(args, 'name');
  const evidenceRoot = flag(args, 'evidence', DEFAULT_EVIDENCE);
  await mkdir(evidenceRoot, { recursive: true });

  const secretMap = { ...DEFAULT_SECRETS, ...(args.pairs.secret ?? {}) };
  const missing = Object.entries(secretMap).filter(([, envVar]) => !process.env[envVar]);
  if (missing.length > 0) {
    console.error(
      `Missing credentials in the environment: ${missing.map(([ref, envVar]) => `${ref} (${envVar})`).join(', ')}`,
    );
    return 1;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('Discovery needs model access. Set ANTHROPIC_API_KEY (see .env.example).');
    return 1;
  }

  const surface = await BrowserSurface.launch({
    targetId: target,
    headless: !boolFlag(args, 'headed'),
  });

  try {
    const result = await discover({
      goal: requireFlag(args, 'goal'),
      appDescription: flag(args, 'app', 'A back-office business application driven through its UI.'),
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
        description: `Supplied at invocation time as ${key}.`,
        sensitivity: 'internal' as const,
        value,
      })),
      secrets: Object.entries(secretMap).map(([ref, envVar]) => ({
        ref,
        envVar,
        description: `Resolved from ${envVar} at replay time.`,
        placeholder: `{{${ref}}}`,
        value: process.env[envVar] as string,
      })),
      surface,
      model: new AnthropicModelClient({
        ...(typeof args.flags.model === 'string' ? { modelId: args.flags.model } : {}),
      }),
      evidenceRoot,
      maxSteps: Number(flag(args, 'max-steps', '25')),
      allowIrreversible: boolFlag(args, 'allow-risky'),
      screenshots: flag(args, 'screenshots', 'on-failure') as 'always' | 'on-failure' | 'never',
    });

    if (result.status !== 'discovered') {
      console.error(`Discovery ${result.status}: ${'reason' in result ? result.reason : ''}`);
      console.error(`Evidence: ${result.trace.evidenceDir}`);
      return 1;
    }

    const saved = await storeFor(args).save(result.artifact);
    console.log(summarize(saved));
    for (const issue of validateArtifact(saved)) {
      console.log(`  ${issue.severity}: ${issue.path} — ${issue.message}`);
    }
    console.log(`\nSaved ${saved.id} v${saved.version}. Evidence: ${result.trace.evidenceDir}`);
    console.log(`Replay it with:\n  npm run cli -- replay ${saved.name} --target ${target} ${
      Object.entries(args.pairs.input ?? {}).map(([k, v]) => `--input ${k}=${v}`).join(' ')
    }`);
    return 0;
  } finally {
    await surface.dispose();
  }
}

async function runReplay(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('replay needs a capability name. Try: capabilities');
    return 1;
  }
  const target = requireFlag(args, 'target').replace(/\/+$/, '');
  const evidenceRoot = flag(args, 'evidence', DEFAULT_EVIDENCE);
  await mkdir(evidenceRoot, { recursive: true });

  const store = storeFor(args);
  const catalog = new CapabilityCatalog(store);
  const found = await catalog.find(name);
  if (!found) {
    console.error(`No capability named "${name}" in ${flag(args, 'store', DEFAULT_STORE)}.`);
    return 1;
  }
  const artifact = await store.load(
    found.id,
    typeof args.flags.version === 'string' ? Number(args.flags.version) : undefined,
  );

  const surface = await BrowserSurface.launch({
    targetId: target,
    headless: !boolFlag(args, 'headed'),
  });
  const control = new SessionControl(`replay-${artifact.name}`);
  const queue = new InterventionQueue(control, {
    waitMs: boolFlag(args, 'operator') ? 0 : Number(flag(args, 'escalation-wait', '0')),
  });

  let consoleServer: import('node:http').Server | undefined;
  if (boolFlag(args, 'operator')) {
    const port = Number(process.env.OPERATOR_HOST_PORT ?? 4320);
    const app = createOperatorConsole({ queue, control, surface, operator: flag(args, 'as', 'operator') });
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
    consoleServer = server;
    const bound = (server.address() as AddressInfo).port;
    console.log(`Operator console: http://localhost:${bound}/  (this run will wait there if it stops)`);
  }

  try {
    const result = await replay({
      artifact,
      inputs: args.pairs.input ?? {},
      surface: new LeasedSurface(surface, control),
      evidenceRoot,
      tenantId: flag(args, 'tenant', artifact.app.recordedOnTenant),
      variables: { baseUrl: target, ...(args.pairs.variable ?? {}) },
      escalation: queue,
      riskyConfirmed: boolFlag(args, 'confirm-risky'),
      screenshots: flag(args, 'screenshots', 'on-failure') as 'always' | 'on-failure' | 'never',
    });

    console.log(summariseResult(result));
    console.log(`Evidence: ${result.trace.evidenceDir}`);
    for (const step of result.trace.steps) {
      const rung = step.rung && step.rung !== 'primary' ? `  [resolved on ${step.rung}]` : '';
      const drift = step.drift ? `  [screen drifted: missing ${step.drift.missing.join(', ') || 'nothing named'}]` : '';
      console.log(`  ${step.status.padEnd(9)} ${step.stepId}${rung}${drift}`);
    }
    return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
  } finally {
    await surface.dispose();
    consoleServer?.close();
  }
}

async function runCall(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('call needs a capability name.');
    return 1;
  }
  const target = requireFlag(args, 'target').replace(/\/+$/, '');
  const evidenceRoot = flag(args, 'evidence', DEFAULT_EVIDENCE);
  await mkdir(evidenceRoot, { recursive: true });

  const catalog = new CapabilityCatalog(storeFor(args));
  const result = await catalog.invoke(name, args.pairs.input ?? {}, {
    tenantId: flag(args, 'tenant', 'base'),
    variables: { baseUrl: target, ...(args.pairs.variable ?? {}) },
    evidenceRoot,
    openSurface: () =>
      BrowserSurface.launch({ targetId: target, headless: !boolFlag(args, 'headed') }),
    riskyConfirmed: boolFlag(args, 'confirm-risky'),
  });
  console.log(JSON.stringify(toAgentResult(result), null, 2));
  return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
}

async function runCapabilities(args: ParsedArgs): Promise<number> {
  const catalog = new CapabilityCatalog(storeFor(args));
  const name = args.positional[0];

  if (boolFlag(args, 'tools')) {
    console.log(JSON.stringify(await catalog.toolDefinitions({ includeDrafts: true }), null, 2));
    return 0;
  }

  if (name) {
    const artifact = await catalog.find(name);
    if (!artifact) {
      console.error(`No capability named "${name}".`);
      return 1;
    }
    console.log(summarize(artifact));
    console.log('\nTool definition a calling agent sees:');
    console.log(JSON.stringify(toToolDefinition(artifact), null, 2));
    const issues = validateArtifact(artifact);
    if (issues.length > 0) {
      console.log('\nReview notes:');
      for (const issue of issues) console.log(`  ${issue.severity}: ${issue.path} — ${issue.message}`);
    }
    return 0;
  }

  const entries = await catalog.entries();
  if (entries.length === 0) {
    console.log(`No capabilities in ${flag(args, 'store', DEFAULT_STORE)} yet. Record one with discover.`);
    return 0;
  }
  for (const entry of entries) {
    const gate = entry.invocableUnattended ? '' : '  (needs approval before unattended use)';
    console.log(
      `${entry.tool.name.padEnd(28)} v${entry.artifact.version}  ${entry.artifact.approval.state.padEnd(8)} ${entry.tool.risk.padEnd(12)}${gate}`,
    );
  }
  return 0;
}

async function runApprove(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    console.error('approve needs a capability name.');
    return 1;
  }
  const store = storeFor(args);
  const catalog = new CapabilityCatalog(store);
  const artifact = await catalog.find(name);
  if (!artifact) {
    console.error(`No capability named "${name}".`);
    return 1;
  }
  // Approval writes a new version rather than mutating the reviewed one, so the
  // file a reviewer read stays exactly as they read it.
  const approved = await store.save({
    ...artifact,
    approval: {
      state: 'approved',
      approvedBy: requireFlag(args, 'by'),
      approvedAt: new Date().toISOString(),
      ...(typeof args.flags.note === 'string' ? { note: args.flags.note } : {}),
    },
    provenance: {
      ...artifact.provenance,
      humanEdits: [
        ...artifact.provenance.humanEdits,
        {
          at: new Date().toISOString(),
          by: requireFlag(args, 'by'),
          summary: `approved v${artifact.version} for unattended replay`,
        },
      ],
    },
  });
  console.log(`${approved.name} v${approved.version} approved by ${approved.approval.approvedBy}.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

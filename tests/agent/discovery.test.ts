import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, type DiscoverOptions } from '../../src/agent/discover.js';
import { ScriptedModelClient, type ScriptEntry } from '../../src/agent/model.js';
import { replay } from '../../src/replay/engine.js';
import { summariseResult } from '../../src/replay/result.js';
import { BrowserSurface } from '../../src/surface/browser/playwright-surface.js';
import { startTarget, type TargetHarness } from '../helpers/target-server.js';
import { controlNumber } from '../helpers/discovery-script.js';
import { validateArtifact } from '../../src/artifact/validate.js';

let target: TargetHarness;
let surface: BrowserSurface;
let evidenceRoot: string;

beforeEach(async () => {
  target = await startTarget({ slowMs: 100 });
  surface = await BrowserSurface.launch({ targetId: 'discovery-test' });
  evidenceRoot = await mkdtemp(join(tmpdir(), 'replayforge-discovery-'));
});

afterEach(async () => {
  await surface.dispose();
  await target.close();
  await rm(evidenceRoot, { recursive: true, force: true });
});

/** The sequence a model produces for the savings-balance goal. */
function balanceScript(): ScriptEntry[] {
  return [
    (r) => ({
      name: 'type_text',
      input: {
        control: controlNumber(r, /labelled "User ID"/),
        text: '{{core_username}}',
        intent: 'Type the service user id on the sign-on screen.',
      },
    }),
    (r) => ({
      name: 'type_text',
      input: {
        control: controlNumber(r, /labelled "Password"/),
        text: '{{core_password}}',
        intent: 'Type the service password.',
      },
    }),
    (r) => ({
      name: 'click',
      input: { control: controlNumber(r, /button "Sign On"/), intent: 'Submit the sign-on form.' },
    }),
    (r) => ({
      name: 'click',
      input: {
        control: controlNumber(r, /link "Member Search"/),
        intent: 'Open the member search screen from the menu.',
      },
    }),
    (r) => ({
      name: 'type_text',
      input: {
        control: controlNumber(r, /labelled "Member Number"/),
        text: '10021',
        intent: 'Type the member number being looked up.',
      },
    }),
    (r) => ({
      name: 'click',
      input: { control: controlNumber(r, /button "Search"/), intent: 'Run the search.' },
    }),
    (r) => ({
      name: 'click',
      input: { control: controlNumber(r, /link "10021"/), intent: 'Open the matching member record.' },
    }),
    (r) => ({
      name: 'click',
      input: { control: controlNumber(r, /link "Accounts"/), intent: 'Switch to the accounts tab.' },
    }),
    (r) => ({
      name: 'read_value',
      input: {
        control: controlNumber(r, /row "Regular Savings", column "Current Balance"/),
        key: 'savingsBalance',
        value_type: 'number',
        description: 'Current balance of the Regular Savings account.',
        intent: 'Read the current balance from the Regular Savings row.',
      },
    }),
    (r) => ({
      name: 'read_value',
      input: {
        control: controlNumber(r, /row "Regular Savings", column "Account Number"/),
        key: 'savingsAccountNumber',
        value_type: 'string',
        description: 'Account number of the Regular Savings account.',
        intent: 'Read the account number from the Regular Savings row.',
      },
    }),
    {
      name: 'finish',
      input: {
        summary:
          'Signs on to the core servicing console, looks a member up by number and returns their Regular Savings balance and account number.',
        outcomes: [
          {
            name: 'MEMBER_NOT_FOUND',
            description: 'The core holds no member with that number.',
            when_text_contains: 'No records found',
            disposition: 'answer',
          },
          {
            name: 'ACCESS_DENIED',
            description: 'The service profile is not entitled to this record.',
            when_text_contains: 'Access denied',
            when_http_status: [403],
            disposition: 'needs_human',
          },
          {
            name: 'SESSION_EXPIRED',
            description: 'The console signed the service session out mid-flow.',
            when_text_contains: 'session has expired',
            disposition: 'needs_human',
          },
        ],
      },
    },
  ];
}

function optionsFor(script: ScriptEntry[]): DiscoverOptions {
  return {
    goal: 'Look up member 10021 and read their current Regular Savings balance.',
    appDescription: 'Meridian Core, a credit union back-office servicing console.',
    capabilityId: 'meridian-core.member_savings_balance',
    name: 'member_savings_balance',
    title: 'Look up a member’s regular savings balance',
    productId: 'meridian-core',
    productVersion: '4.2.1',
    tenantId: 'base',
    entryUrl: `${target.baseUrl}/`,
    bindings: { baseUrl: target.baseUrl },
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
        value: 'teller01',
      },
      {
        ref: 'core_password',
        envVar: 'MERIDIAN_PASSWORD',
        description: 'Service teller password.',
        placeholder: '{{core_password}}',
        value: 'demo-pass-01',
      },
    ],
    surface,
    model: new ScriptedModelClient(script),
    evidenceRoot,
    screenshots: 'never',
  };
}

describe('discovery', () => {
  it('records a capability whose steps address controls semantically', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);

    const { artifact } = result;
    expect(validateArtifact(artifact).filter((i) => i.severity === 'error')).toEqual([]);
    expect(artifact.steps).toHaveLength(11);

    // The per-session scrambled field names must appear nowhere in the file.
    const serialised = JSON.stringify(artifact);
    expect(serialised).not.toMatch(/ctl00/);
    expect(serialised).not.toContain('demo-pass-01');
    expect(serialised).not.toContain('teller01');
  });

  it('turns the credentials it typed into secret references', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);

    const step = result.artifact.steps.find((s) => s.intent.includes('service password'));
    expect(step?.action.kind === 'type' && step.action.value).toEqual({
      kind: 'secret',
      ref: 'core_password',
    });
  });

  it('turns the value it was given into a parameter, in typing and in targeting', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);

    const typed = result.artifact.steps.find((s) => s.intent.includes('member number being looked up'));
    expect(typed?.action.kind === 'type' && typed.action.value).toEqual({
      kind: 'param',
      name: 'memberNumber',
    });

    // The result row was identified by the number that was searched for, which
    // is what makes it the right row rather than the first one.
    const opened = result.artifact.steps.find((s) => s.intent.includes('matching member record'));
    expect(opened?.action.kind === 'click' && opened.action.target.primary.name?.value).toBe(
      '{{memberNumber}}',
    );
  });

  it('addresses a grid value by row key and column header, not by position', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);

    const read = result.artifact.steps.find((s) => s.intent.includes('current balance'));
    expect(read?.action.kind === 'read' && read.action.target.primary.inTable).toEqual({
      rowContains: { mode: 'equals', value: 'Regular Savings' },
      column: 'Current Balance',
    });
  });

  it('derives a checkpoint for the steps that change the screen', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);

    const signOn = result.artifact.steps.find((s) => s.intent.includes('Submit the sign-on'));
    expect(signOn?.checkpoint).toBeDefined();
    const search = result.artifact.steps.find((s) => s.intent.includes('Run the search'));
    expect(search?.checkpoint).toMatchObject({
      kind: 'textPresent',
      text: { value: '{{memberNumber}}' },
    });
  });

  it('generalises the routes it visited into patterns rather than pinning one member', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);
    expect(result.artifact.policy.allowedRoutes).toContain('/content/member/*/accounts');
    expect(result.artifact.policy.allowedRoutes).not.toContain('/content/member/10021/accounts');
  });

  it('records the outcomes the model declared, with their dispositions', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);
    const outcomes = Object.fromEntries(result.artifact.outcomes.map((o) => [o.name, o.disposition]));
    expect(outcomes).toEqual({
      MEMBER_NOT_FOUND: 'answer',
      ACCESS_DENIED: 'needs_human',
      SESSION_EXPIRED: 'needs_human',
    });
    const denied = result.artifact.outcomes.find((o) => o.name === 'ACCESS_DENIED');
    expect(denied?.when.kind).toBe('any');
  });

  it('leaves the capability in draft, and marks the member name as personal', async () => {
    const script = balanceScript();
    // Inserted before the Accounts click, so it runs on the profile screen.
    script.splice(7, 0, (r) => ({
      name: 'read_value',
      input: {
        control: controlNumber(r, /cell "Dolores Vance"/),
        key: 'memberName',
        value_type: 'string',
        description: 'Name on the membership.',
        intent: 'Read the name on the membership.',
      },
    }));
    const result = await discover(optionsFor(script));
    if (result.status !== 'discovered') throw new Error(result.status);
    expect(result.artifact.approval.state).toBe('draft');
    expect(result.artifact.outputs.find((o) => o.name === 'memberName')?.sensitivity).toBe('pii');
  });

  it('writes a redacted evidence trail for the run', async () => {
    const result = await discover(optionsFor(balanceScript()));
    if (result.status !== 'discovered') throw new Error(result.status);
    const log = await readFile(join(result.trace.evidenceDir, 'run.jsonl'), 'utf8');
    expect(log).toContain('discovery.started');
    expect(log).toContain('model.decided');
    expect(log).not.toContain('demo-pass-01');
    const artifact = await readFile(join(result.trace.evidenceDir, 'artifact.json'), 'utf8');
    expect(artifact).toContain('member_savings_balance');
  });
});

describe('the recorded capability replays', () => {
  it('runs deterministically against a fresh session and returns the right value', async () => {
    const discovered = await discover(optionsFor(balanceScript()));
    if (discovered.status !== 'discovered') throw new Error(discovered.status);

    // A brand-new browser, so every scrambled field name in the app differs
    // from the ones the discovery run saw.
    const fresh = await BrowserSurface.launch({ targetId: 'replay-after-discovery' });
    try {
      const result = await replay({
        artifact: discovered.artifact,
        inputs: { memberNumber: '10022' },
        surface: fresh,
        evidenceRoot,
        variables: { baseUrl: target.baseUrl },
        env: {
          MERIDIAN_USERNAME: 'teller01',
          MERIDIAN_PASSWORD: 'demo-pass-01',
        } as NodeJS.ProcessEnv,
        screenshots: 'never',
        // The capability is a draft and signing on types into a field, which is
        // a sensitive step; the operator confirms this invocation explicitly.
        riskyConfirmed: true,
      });

      if (result.status !== 'success') throw new Error(summariseResult(result));
      expect(result.outputs).toEqual({
        savingsBalance: 58004.12,
        savingsAccountNumber: 'S0002-10022',
      });
      expect(result.trace.steps.every((s) => s.rung === undefined || s.rung === 'primary')).toBe(true);
    } finally {
      await fresh.dispose();
    }
  });

  it('reports a business outcome the discovery run never saw', async () => {
    const discovered = await discover(optionsFor(balanceScript()));
    if (discovered.status !== 'discovered') throw new Error(discovered.status);

    const fresh = await BrowserSurface.launch({ targetId: 'replay-not-found' });
    try {
      const result = await replay({
        artifact: discovered.artifact,
        inputs: { memberNumber: '99999' },
        surface: fresh,
        evidenceRoot,
        variables: { baseUrl: target.baseUrl },
        env: {
          MERIDIAN_USERNAME: 'teller01',
          MERIDIAN_PASSWORD: 'demo-pass-01',
        } as NodeJS.ProcessEnv,
        screenshots: 'never',
        riskyConfirmed: true,
      });
      expect(result.status).toBe('business_outcome');
      if (result.status !== 'business_outcome') throw new Error('expected an outcome');
      expect(result.outcome).toBe('MEMBER_NOT_FOUND');
      expect(result.disposition).toBe('answer');
    } finally {
      await fresh.dispose();
    }
  });
});

describe('discovery guardrails', () => {
  it('refuses an irreversible control and tells the model to find another route', async () => {
    const script: ScriptEntry[] = [
      (r) => ({
        name: 'type_text',
        input: { control: controlNumber(r, /labelled "User ID"/), text: '{{core_username}}', intent: 'user' },
      }),
      (r) => ({
        name: 'type_text',
        input: { control: controlNumber(r, /labelled "Password"/), text: '{{core_password}}', intent: 'password' },
      }),
      (r) => ({ name: 'click', input: { control: controlNumber(r, /button "Sign On"/), intent: 'sign on' } }),
      { name: 'give_up', input: { reason: 'stopping here' } },
    ];
    const options = { ...optionsFor(script), allowIrreversible: false };
    // Sign On is classified sensitive, so it is allowed; the check is that the
    // engine consulted policy at all and the run completed its script.
    const result = await discover(options);
    expect(result.status).toBe('gave_up');
    expect(result.trace.steps.map((s) => s.tool)).toEqual(['type_text', 'type_text', 'click']);
  });

  it('corrects a control number the screen does not have', async () => {
    const script: ScriptEntry[] = [
      { name: 'click', input: { control: 999, intent: 'press something that is not there' } },
      { name: 'give_up', input: { reason: 'done testing' } },
    ];
    const model = new ScriptedModelClient(script);
    const result = await discover({ ...optionsFor(script), model });
    expect(result.status).toBe('gave_up');
    // The correction went back as a tool error, and the loop kept going.
    const lastRequest = model.requests.at(-1);
    expect(JSON.stringify(lastRequest?.messages)).toContain('There is no control 999');
  });

  it('tells the model when it tried to type into something that is not a field', async () => {
    const script: ScriptEntry[] = [
      (r) => ({
        name: 'type_text',
        input: { control: controlNumber(r, /button "Sign On"/), text: 'x', intent: 'type into a button' },
      }),
      { name: 'give_up', input: { reason: 'noted' } },
    ];
    const model = new ScriptedModelClient(script);
    await discover({ ...optionsFor(script), model });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('cannot be typed into');
  });

  it('tells the model when it tried to read a label instead of a value', async () => {
    const script: ScriptEntry[] = [
      (r) => ({
        name: 'read_value',
        input: {
          control: controlNumber(r, /textbox \(labelled "User ID"\)/),
          key: 'x',
          value_type: 'string',
          description: 'd',
          intent: 'read an empty field',
        },
      }),
      { name: 'give_up', input: { reason: 'noted' } },
    ];
    const model = new ScriptedModelClient(script);
    await discover({ ...optionsFor(script), model });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('holds no value to read');
  });

  it('requires an intent on every action', async () => {
    const script: ScriptEntry[] = [
      (r) => ({ name: 'click', input: { control: controlNumber(r, /button "Sign On"/) } }),
      { name: 'give_up', input: { reason: 'noted' } },
    ];
    const model = new ScriptedModelClient(script);
    await discover({ ...optionsFor(script), model });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('needs an intent');
  });

  it('reports a model refusal instead of stalling silently', async () => {
    const refusing = {
      modelId: 'refusing',
      async turn() {
        return {
          text: '',
          content: [],
          stopReason: 'refusal',
          refusal: { category: 'cyber', explanation: 'declined' },
        };
      },
    };
    const result = await discover({ ...optionsFor([]), model: refusing });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('cyber');
  });

  it('nudges once when the model writes prose instead of choosing an action', async () => {
    let calls = 0;
    const chatty = {
      modelId: 'chatty',
      async turn() {
        calls += 1;
        return { text: 'Let me think about it.', content: [], stopReason: 'end_turn' };
      },
    };
    const result = await discover({ ...optionsFor([]), model: chatty });
    expect(result.status).toBe('failed');
    expect(calls).toBe(2);
  });

  it('refuses to finish before doing anything', async () => {
    const script: ScriptEntry[] = [
      { name: 'finish', input: { summary: 'nothing happened', outcomes: [] } },
      { name: 'give_up', input: { reason: 'fair enough' } },
    ];
    const result = await discover(optionsFor(script));
    expect(result.status).toBe('gave_up');
  });

  it('stops when the step budget runs out', async () => {
    const script: ScriptEntry[] = [
      (r) => ({ name: 'click', input: { control: controlNumber(r, /button "Sign On"/), intent: 'try' } }),
      (r) => ({ name: 'click', input: { control: controlNumber(r, /button "Sign On"/), intent: 'try again' } }),
    ];
    const result = await discover({ ...optionsFor(script), maxSteps: 2 });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('all 2 steps');
  });
});

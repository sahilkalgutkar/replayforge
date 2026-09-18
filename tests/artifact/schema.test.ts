import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capabilityArtifactSchema,
  parseArtifact,
  type CapabilityArtifact,
  type OutcomeSpec,
  type Step,
} from '../../src/artifact/schema.js';
import { assertValid, paramsReferencedBy, validateArtifact } from '../../src/artifact/validate.js';
import { FileArtifactStore } from '../../src/artifact/store.js';
import { resolveForTenant } from '../../src/artifact/overrides.js';
import { highestRisk, summarize, toToolDefinition } from '../../src/artifact/render.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';

/** Indexing with noUncheckedIndexedAccess on, without littering tests with `!`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture has nothing at index ${index}`);
  return item;
}

const errorsOf = (artifact: CapabilityArtifact): string[] =>
  validateArtifact(artifact)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);

const warningsOf = (artifact: CapabilityArtifact): string[] =>
  validateArtifact(artifact)
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => issue.message);

describe('the schema', () => {
  it('accepts the sample capability and fills in defaults', () => {
    const artifact = sampleArtifact();
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.approval.state).toBe('draft');
    expect(at(artifact.steps, 0).retries).toEqual({ max: 1, backoffMs: 400 });
    expect(at(artifact.steps, 0).onFailure).toBe('fail');
  });

  it('insists on snake_case capability names and SCREAMING outcome names', () => {
    expect(() => sampleArtifact({ name: 'MemberSavingsBalance' })).toThrow(/snake_case/);
    const base = sampleArtifact();
    const renamed: OutcomeSpec = { ...at(base.outcomes, 0), name: 'memberNotFound' };
    expect(() => capabilityArtifactSchema.parse({ ...base, outcomes: [renamed] })).toThrow(
      /SCREAMING_SNAKE_CASE/,
    );
  });

  it('rejects an empty flow and an unknown schema version', () => {
    expect(() => parseArtifact({ ...sampleArtifact(), steps: [] })).toThrow();
    expect(() => parseArtifact({ ...sampleArtifact(), schemaVersion: 2 })).toThrow();
  });

  it('handles assertions nested to any depth', () => {
    const artifact = sampleArtifact({
      successCheckpoint: {
        kind: 'not',
        of: {
          kind: 'any',
          of: [
            { kind: 'all', of: [{ kind: 'httpStatusIn', statuses: [500] }] },
            { kind: 'urlMatches', pattern: '/error' },
          ],
        },
      },
    });
    expect(artifact.successCheckpoint.kind).toBe('not');
  });
});

describe('validation beyond types', () => {
  it('passes the sample capability', () => {
    expect(errorsOf(sampleArtifact())).toEqual([]);
  });

  it('catches an output no step produces', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({
      ...base,
      outputs: [...base.outputs, { name: 'ghost', type: 'string', description: 'x', from: 'nowhere' }],
    });
    expect(errorsOf(broken).join(' ')).toContain('no step produces');
  });

  it('catches a parameter and a secret the contract never declares', () => {
    const base = sampleArtifact();
    expect(errorsOf(capabilityArtifactSchema.parse({ ...base, inputs: [] })).join(' ')).toContain('memberNumber');
    expect(errorsOf(capabilityArtifactSchema.parse({ ...base, secrets: [] })).join(' ')).toContain('core_username');
  });

  it('catches duplicate step ids and outcome names', () => {
    const base = sampleArtifact();
    const first = at(base.steps, 0);
    const duplicated = capabilityArtifactSchema.parse({
      ...base,
      steps: [first, first, ...base.steps.slice(1)],
      outcomes: [at(base.outcomes, 0), at(base.outcomes, 0)],
    });
    const errors = errorsOf(duplicated).join(' ');
    expect(errors).toContain('duplicate step id');
    expect(errors).toContain('duplicate outcome name');
  });

  it('catches a step doing something the capability’s own policy forbids', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({
      ...base,
      policy: { ...base.policy, allowedActions: ['read'] },
    });
    expect(errorsOf(broken).join(' ')).toContain("policy doesn't allow");
  });

  it('warns about a risky step that checks nothing, and an unused input', () => {
    const base = sampleArtifact();
    const unchecked = capabilityArtifactSchema.parse({
      ...base,
      steps: base.steps.map((step: Step) => (step.id === 'sign_on' ? { ...step, checkpoint: undefined } : step)),
      outputs: base.outputs.filter((output) => output.name !== 'memberName'),
      inputs: [...base.inputs, { name: 'unusedFlag', type: 'boolean', description: 'never referenced' }],
    });
    const warnings = warningsOf(unchecked).join(' ');
    expect(warnings).toContain('would look like success');
    expect(warnings).toContain('the caller never sees it');
    expect(warnings).toContain('unusedFlag');
  });

  it('requires an approved capability to name its approver', () => {
    expect(errorsOf(sampleArtifact({ approval: { state: 'approved' } })).join(' ')).toContain(
      'who approved it',
    );
  });

  it('throws from assertValid, listing what is wrong', () => {
    const broken = capabilityArtifactSchema.parse({ ...sampleArtifact(), inputs: [], secrets: [] });
    expect(() => assertValid(broken)).toThrow(/doesn't hold together/);
    expect(() => assertValid(sampleArtifact())).not.toThrow();
  });

  it('pulls parameter references out of every kind of value', () => {
    expect(paramsReferencedBy({ kind: 'param', name: 'memberNumber' })).toEqual(['memberNumber']);
    expect(paramsReferencedBy({ kind: 'template', template: '{{ baseUrl }}/x/{{id}}' })).toEqual([
      'baseUrl',
      'id',
    ]);
    expect(paramsReferencedBy({ kind: 'literal', value: '{{notAReference}}' })).toEqual([]);
    expect(paramsReferencedBy({ kind: 'secret', ref: 'core_password' })).toEqual([]);
  });
});

describe('the store', () => {
  let root: string;
  let store: FileArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'replayforge-store-'));
    store = new FileArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a new version each time instead of overwriting', async () => {
    const first = await store.save(sampleArtifact());
    expect(first.version).toBe(1);
    const second = await store.save({ ...sampleArtifact(), title: 'Revised' });
    expect(second.version).toBe(2);
    expect((await store.load(first.id, 1)).title).toBe(sampleArtifact().title);
    expect((await store.load(first.id)).title).toBe('Revised');
    expect(await store.versions(first.id)).toEqual([1, 2]);
  });

  it('writes JSON a reviewer can read and diff', async () => {
    const saved = await store.save(sampleArtifact());
    const raw = await readFile(join(root, saved.id, 'v1.json'), 'utf8');
    expect(raw).toContain('\n  "name": "member_savings_balance"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('refuses to store something incoherent', async () => {
    const base = sampleArtifact();
    await expect(store.save({ ...base, secrets: [] })).rejects.toThrow(/doesn't hold together/);
    expect(await store.versions(base.id)).toEqual([]);
  });

  it('tells a missing capability apart from a missing version', async () => {
    await expect(store.load('nope')).rejects.toThrow(/nothing stored/);
    await store.save(sampleArtifact());
    await expect(store.load(sampleArtifact().id, 7)).rejects.toThrow(/has no version 7/);
  });

  it('lists the latest version of each capability', async () => {
    await store.save(sampleArtifact());
    await store.save({ ...sampleArtifact(), id: 'meridian-core.other', name: 'other_capability' });
    expect((await store.list()).map((a) => a.name)).toEqual([
      'member_savings_balance',
      'other_capability',
    ]);
    expect(await new FileArtifactStore(join(root, 'missing')).list()).toEqual([]);
  });
});

describe('tenant overrides', () => {
  const withOverride = (): CapabilityArtifact =>
    sampleArtifact({
      tenantOverrides: {
        northbay: {
          tenantId: 'northbay',
          note: 'Northbay renamed the member field and moved the menu item.',
          steps: {
            open_search: {
              target: {
                description: 'the customer search item in the menu frame',
                primary: {
                  role: 'link',
                  name: { mode: 'equals', value: 'Customer Search' },
                  framePath: ['navFrame'],
                },
              },
            },
            enter_member_number: {
              target: {
                description: 'the customer id field',
                primary: {
                  role: 'textbox',
                  editable: true,
                  nearbyText: { mode: 'contains', value: 'Customer ID' },
                  framePath: ['mainFrame'],
                },
              },
            },
            read_member_name: { skip: true },
          },
          extraSteps: [],
        },
      },
    });

  it('leaves the flow alone for a tenant with no override', () => {
    const resolved = resolveForTenant(withOverride(), 'base');
    expect(resolved.patchedSteps).toEqual([]);
    expect(resolved.artifact.steps).toHaveLength(12);
  });

  it('re-targets patched steps and drops skipped ones', () => {
    const resolved = resolveForTenant(withOverride(), 'northbay');
    expect(resolved.patchedSteps).toEqual(['open_search', 'enter_member_number']);
    expect(resolved.skippedSteps).toEqual(['read_member_name']);
    const step = resolved.artifact.steps.find((s) => s.id === 'enter_member_number');
    expect(step?.action.kind === 'type' && step.action.target.primary.nearbyText?.value).toBe('Customer ID');
    expect(resolved.artifact.steps.some((s) => s.id === 'read_member_name')).toBe(false);
  });

  it('will not let an override touch the contract', () => {
    const base = withOverride();
    const resolved = resolveForTenant(base, 'northbay');
    expect(resolved.artifact.inputs).toEqual(base.inputs);
    expect(resolved.artifact.outputs).toEqual(base.outputs);
    expect(resolved.artifact.outcomes).toEqual(base.outcomes);
    expect(resolved.artifact.policy).toEqual(base.policy);
  });

  it('inserts a step a tenant build needs and can move the entry point', () => {
    const base = sampleArtifact();
    const extra: Step = { ...at(base.steps, 3), id: 'acknowledge_bsa' };
    const resolved = resolveForTenant(
      sampleArtifact({
        tenantOverrides: {
          northbay: {
            tenantId: 'northbay',
            note: 'Northbay wants a BSA acknowledgement and runs on its own host.',
            entryUrl: '{{baseUrl}}/console',
            steps: {},
            extraSteps: [{ afterStepId: 'sign_on', step: extra }],
          },
        },
      }),
      'northbay',
    );
    expect(resolved.insertedSteps).toEqual(['acknowledge_bsa']);
    expect(at(resolved.artifact.steps, 4).id).toBe('acknowledge_bsa');
    expect(resolved.artifact.app.entryUrl).toBe('{{baseUrl}}/console');
  });

  it('rejects an override pointing at steps that are gone, or filed under the wrong tenant', () => {
    const stale = sampleArtifact({
      tenantOverrides: {
        northbay: {
          tenantId: 'northbay',
          note: 'stale',
          steps: { removed_step: { skip: true } },
          extraSteps: [{ afterStepId: 'also_gone', step: at(sampleArtifact().steps, 0) }],
        },
      },
    });
    const errors = errorsOf(stale).join(' ');
    expect(errors).toContain('removed_step');
    expect(errors).toContain('also_gone');

    const misfiled = sampleArtifact({
      tenantOverrides: {
        northbay: { tenantId: 'eastvale', note: 'mis-filed', steps: {}, extraSteps: [] },
      },
    });
    expect(errorsOf(misfiled).join(' ')).toContain('declares tenant "eastvale"');
  });
});

describe('rendering the contract', () => {
  it('produces a tool definition a calling model can use', () => {
    const tool = toToolDefinition(sampleArtifact());
    expect(tool.name).toBe('member_savings_balance');
    expect(tool.input_schema.required).toEqual(['memberNumber']);
    expect(tool.input_schema.properties.memberNumber).toMatchObject({
      type: 'string',
      pattern: '^[0-9]{4,10}$',
    });
    expect(tool.returns.savingsBalance).toEqual({
      type: 'number',
      description: 'Current balance of the Regular Savings account.',
    });
  });

  it('advertises the outcomes, so a caller does not treat them as errors', () => {
    const tool = toToolDefinition(sampleArtifact());
    expect(tool.outcomes.find((o) => o.name === 'MEMBER_NOT_FOUND')?.disposition).toBe('answer');
    expect(tool.outcomes.find((o) => o.name === 'ACCESS_DENIED')?.disposition).toBe('needs_human');
  });

  it('renders an enum parameter as a constrained string', () => {
    const artifact = sampleArtifact({
      inputs: [
        {
          name: 'memberNumber',
          type: 'enum',
          enumValues: ['10021', '10022'],
          required: true,
          description: 'Which fixture member.',
          sensitivity: 'internal',
        },
      ],
    });
    expect(toToolDefinition(artifact).input_schema.properties.memberNumber).toMatchObject({
      type: 'string',
      enum: ['10021', '10022'],
    });
  });

  it('reports the worst risk any step carries', () => {
    const base = sampleArtifact();
    expect(highestRisk(base)).toBe('sensitive');
    expect(
      highestRisk(
        sampleArtifact({
          steps: base.steps.map((step) => (step.id === 'sign_on' ? { ...step, risk: 'irreversible' } : step)),
        }),
      ),
    ).toBe('irreversible');
  });

  it('summarises a capability, flagging the risky steps', () => {
    const text = summarize(
      sampleArtifact({
        tenantOverrides: {
          northbay: { tenantId: 'northbay', note: 'n', steps: {}, extraSteps: [] },
        },
      }),
    );
    expect(text).toContain('member_savings_balance v1');
    expect(text).toContain('risk      sensitive');
    expect(text).toMatch(/!\s+sign_on/);
    expect(text).toContain('overrides northbay');
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityArtifactSchema, parseArtifact } from '../../src/artifact/schema.js';
import { validateArtifact, assertValid, paramsReferencedBy } from '../../src/artifact/validate.js';
import { FileArtifactStore } from '../../src/artifact/store.js';
import { resolveForTenant } from '../../src/artifact/overrides.js';
import { highestRisk, summarize, toToolDefinition } from '../../src/artifact/render.js';
import { sampleArtifact } from '../helpers/sample-artifact.js';
import type { CapabilityArtifact, Step } from '../../src/artifact/schema.js';

const stepAt = (artifact: CapabilityArtifact, index: number): Step => {
  const step = artifact.steps[index];
  if (!step) throw new Error(`fixture has no step at index ${index}`);
  return step;
};

describe('schema', () => {
  it('accepts the sample capability and fills defaults', () => {
    const artifact = sampleArtifact();
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.approval.state).toBe('draft');
    expect(artifact.steps[0]?.retries).toEqual({ max: 1, backoffMs: 400 });
    expect(artifact.steps[0]?.onFailure).toBe('fail');
  });

  it('rejects a capability name that is not snake_case', () => {
    expect(() => sampleArtifact({ name: 'MemberSavingsBalance' })).toThrow(/snake_case/);
  });

  it('rejects an outcome name that is not screaming snake case', () => {
    const base = sampleArtifact();
    expect(() =>
      capabilityArtifactSchema.parse({
        ...base,
        outcomes: [{ ...base.outcomes[0], name: 'memberNotFound' }],
      }),
    ).toThrow(/SCREAMING_SNAKE_CASE/);
  });

  it('rejects an artifact with no steps', () => {
    expect(() => parseArtifact({ ...sampleArtifact(), steps: [] })).toThrow();
  });

  it('rejects an unknown schema version', () => {
    expect(() => parseArtifact({ ...sampleArtifact(), schemaVersion: 2 })).toThrow();
  });

  it('parses nested assertions to arbitrary depth', () => {
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

describe('referential validation', () => {
  it('passes the sample capability with no errors', () => {
    expect(validateArtifact(sampleArtifact()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('catches an output no step produces', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({
      ...base,
      outputs: [...base.outputs, { name: 'ghost', type: 'string', description: 'x', from: 'nowhere' }],
    });
    expect(validateArtifact(broken)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('no step produces') }),
    );
  });

  it('catches a parameter a step uses but the contract never declares', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({ ...base, inputs: [] });
    const errors = validateArtifact(broken).filter((i) => i.severity === 'error');
    expect(errors.some((e) => e.message.includes('memberNumber'))).toBe(true);
  });

  it('catches an undeclared secret', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({ ...base, secrets: [] });
    const errors = validateArtifact(broken).filter((i) => i.severity === 'error');
    expect(errors.some((e) => e.message.includes('core_username'))).toBe(true);
  });

  it('catches a duplicate step id and a duplicate outcome name', () => {
    const base = sampleArtifact();
    const first = stepAt(base, 0);
    const dup = capabilityArtifactSchema.parse({
      ...base,
      steps: [first, first, ...base.steps.slice(1)],
      outcomes: [base.outcomes[0], base.outcomes[0]],
    });
    const errors = validateArtifact(dup).filter((i) => i.severity === 'error');
    expect(errors.some((e) => e.message.includes('duplicate step id'))).toBe(true);
    expect(errors.some((e) => e.message.includes('duplicate outcome name'))).toBe(true);
  });

  it('catches a step whose action the capability policy does not permit', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({
      ...base,
      policy: { ...base.policy, allowedActions: ['read'] },
    });
    const errors = validateArtifact(broken).filter((i) => i.severity === 'error');
    expect(errors.some((e) => e.message.includes('policy does not allow'))).toBe(true);
  });

  it('warns about a risky step that asserts nothing afterwards', () => {
    const base = sampleArtifact();
    const noCheck = capabilityArtifactSchema.parse({
      ...base,
      steps: base.steps.map((s) => (s.id === 'sign_on' ? { ...s, checkpoint: undefined } : s)),
    });
    expect(validateArtifact(noCheck)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('would look like success'),
      }),
    );
  });

  it('warns about a read no output exposes and an input no step uses', () => {
    const base = sampleArtifact();
    const loose = capabilityArtifactSchema.parse({
      ...base,
      outputs: base.outputs.filter((o) => o.name !== 'memberName'),
      inputs: [
        ...base.inputs,
        { name: 'unusedFlag', type: 'boolean', description: 'never referenced' },
      ],
    });
    const warnings = validateArtifact(loose).filter((i) => i.severity === 'warning');
    expect(warnings.some((w) => w.message.includes('the caller never sees it'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('unusedFlag'))).toBe(true);
  });

  it('requires an approved artifact to name its approver', () => {
    const broken = sampleArtifact({ approval: { state: 'approved' } });
    expect(validateArtifact(broken)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('who approved it') }),
    );
  });

  it('throws from assertValid with every error listed', () => {
    const base = sampleArtifact();
    const broken = capabilityArtifactSchema.parse({ ...base, inputs: [], secrets: [] });
    expect(() => assertValid(broken)).toThrow(/is not coherent/);
    expect(() => assertValid(sampleArtifact())).not.toThrow();
  });

  it('extracts parameter references from every value source shape', () => {
    expect(paramsReferencedBy({ kind: 'param', name: 'memberNumber' })).toEqual(['memberNumber']);
    expect(paramsReferencedBy({ kind: 'template', template: '{{ baseUrl }}/x/{{id}}' })).toEqual([
      'baseUrl',
      'id',
    ]);
    expect(paramsReferencedBy({ kind: 'literal', value: '{{notAReference}}' })).toEqual([]);
    expect(paramsReferencedBy({ kind: 'secret', ref: 'core_password' })).toEqual([]);
  });
});

describe('versioned store', () => {
  let root: string;
  let store: FileArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'replayforge-store-'));
    store = new FileArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('assigns v1 on first save and never overwrites it', async () => {
    const first = await store.save(sampleArtifact());
    expect(first.version).toBe(1);

    const second = await store.save({ ...sampleArtifact(), title: 'Revised' });
    expect(second.version).toBe(2);

    expect((await store.load(first.id, 1)).title).toBe(sampleArtifact().title);
    expect((await store.load(first.id)).title).toBe('Revised');
    expect(await store.versions(first.id)).toEqual([1, 2]);
  });

  it('writes readable JSON a reviewer can diff', async () => {
    const saved = await store.save(sampleArtifact());
    const raw = await readFile(join(root, saved.id, 'v1.json'), 'utf8');
    expect(raw).toContain('\n  "name": "member_savings_balance"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('refuses to store an incoherent artifact', async () => {
    const base = sampleArtifact();
    await expect(store.save({ ...base, secrets: [] })).rejects.toThrow(/not coherent/);
    expect(await store.versions(base.id)).toEqual([]);
  });

  it('reports a missing artifact and a missing version distinctly', async () => {
    await expect(store.load('nope')).rejects.toThrow(/no artifact stored/);
    await store.save(sampleArtifact());
    await expect(store.load(sampleArtifact().id, 7)).rejects.toThrow(/has no version 7/);
  });

  it('lists the latest version of each capability and skips unreadable ones', async () => {
    await store.save(sampleArtifact());
    await store.save({ ...sampleArtifact(), id: 'meridian-core.other', name: 'other_capability' });
    expect(await new FileArtifactStore(join(root, 'missing')).list()).toEqual([]);
    const listed = await store.list();
    expect(listed.map((a) => a.name)).toEqual(['member_savings_balance', 'other_capability']);
  });
});

describe('tenant overrides', () => {
  const withOverride = () =>
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

  it('leaves the base artifact untouched for a tenant with no override', () => {
    const resolved = resolveForTenant(withOverride(), 'base');
    expect(resolved.patchedSteps).toEqual([]);
    expect(resolved.artifact.steps).toHaveLength(12);
  });

  it('re-targets patched steps and drops skipped ones', () => {
    const resolved = resolveForTenant(withOverride(), 'northbay');
    expect(resolved.patchedSteps).toEqual(['open_search', 'enter_member_number']);
    expect(resolved.skippedSteps).toEqual(['read_member_name']);
    const step = resolved.artifact.steps.find((s) => s.id === 'enter_member_number');
    expect(step?.action.kind === 'type' && step.action.target.primary.nearbyText?.value).toBe(
      'Customer ID',
    );
    expect(resolved.artifact.steps.some((s) => s.id === 'read_member_name')).toBe(false);
  });

  it('does not let an override touch the contract', () => {
    const resolved = resolveForTenant(withOverride(), 'northbay');
    expect(resolved.artifact.inputs).toEqual(withOverride().inputs);
    expect(resolved.artifact.outcomes).toEqual(withOverride().outcomes);
    expect(resolved.artifact.policy).toEqual(withOverride().policy);
  });

  it('inserts a step the tenant build requires and can move the entry point', () => {
    const base = sampleArtifact();
    const extra: Step = { ...stepAt(base, 3), id: 'acknowledge_bsa' };
    const artifact = sampleArtifact({
      tenantOverrides: {
        northbay: {
          tenantId: 'northbay',
          note: 'Northbay requires a BSA acknowledgement and runs on its own host.',
          entryUrl: '{{baseUrl}}/console',
          steps: {},
          extraSteps: [{ afterStepId: 'sign_on', step: extra }],
        },
      },
    });
    const resolved = resolveForTenant(artifact, 'northbay');
    expect(resolved.insertedSteps).toEqual(['acknowledge_bsa']);
    expect(resolved.artifact.steps[4]?.id).toBe('acknowledge_bsa');
    expect(resolved.artifact.app.entryUrl).toBe('{{baseUrl}}/console');
  });

  it('rejects an override that patches a step which does not exist', () => {
    const artifact = sampleArtifact({
      tenantOverrides: {
        northbay: {
          tenantId: 'northbay',
          note: 'stale',
          steps: { removed_step: { skip: true } },
          extraSteps: [{ afterStepId: 'also_gone', step: stepAt(sampleArtifact(), 0) }],
        },
      },
    });
    const errors = validateArtifact(artifact).filter((i) => i.severity === 'error');
    expect(errors.some((e) => e.message.includes('removed_step'))).toBe(true);
    expect(errors.some((e) => e.message.includes('also_gone'))).toBe(true);
  });

  it('rejects an override filed under the wrong tenant key', () => {
    const artifact = sampleArtifact({
      tenantOverrides: {
        northbay: { tenantId: 'eastvale', note: 'mis-filed', steps: {}, extraSteps: [] },
      },
    });
    expect(validateArtifact(artifact)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('declares tenant "eastvale"') }),
    );
  });
});

describe('rendering', () => {
  it('produces a tool definition a function-calling agent can consume', () => {
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

  it('advertises declared outcomes so a caller does not treat them as errors', () => {
    const tool = toToolDefinition(sampleArtifact());
    expect(tool.outcomes.map((o) => o.name)).toContain('MEMBER_NOT_FOUND');
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
    expect(highestRisk(sampleArtifact())).toBe('sensitive');
    const base = sampleArtifact();
    const risky = sampleArtifact({
      steps: base.steps.map((s) => (s.id === 'sign_on' ? { ...s, risk: 'irreversible' } : s)),
    });
    expect(highestRisk(risky)).toBe('irreversible');
  });

  it('summarises a capability for a reviewer, flagging the risky steps', () => {
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

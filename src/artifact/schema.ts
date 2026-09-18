import { z } from 'zod';

// The capability artifact: what a successful discovery run turns into.
//
// It's a contract, not a macro. Whatever calls it has to decide whether to call
// it, what to pass and what comes back without reading the steps, and a person
// reviewing it has to be able to approve it the same way. So the typed surface
// is declared separately from the flow itself.

export const SCHEMA_VERSION = 1;

// --- targeting, mirroring src/surface/types.ts ---------------------------

export const textMatcherSchema = z.object({
  mode: z.enum(['equals', 'contains', 'startsWith', 'regex']),
  value: z.string(),
  caseSensitive: z.boolean().optional(),
});

export const targetMatcherSchema = z.object({
  role: z.string().optional(),
  name: textMatcherSchema.optional(),
  nearbyText: textMatcherSchema.optional(),
  text: textMatcherSchema.optional(),
  value: textMatcherSchema.optional(),
  inTable: z
    .object({
      rowContains: textMatcherSchema,
      column: z.union([z.string(), z.number().int().nonnegative()]),
    })
    .optional(),
  framePath: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  ordinal: z.number().int().nonnegative().optional(),
});

export const targetSpecSchema = z.object({
  /** Why this identifies the right control, for whoever reviews it. */
  description: z.string().min(1),
  primary: targetMatcherSchema,
  fallbacks: z.array(targetMatcherSchema).optional(),
});

// --- assertions ----------------------------------------------------------

export type Assertion =
  | { kind: 'targetPresent'; target: z.infer<typeof targetSpecSchema> }
  | { kind: 'targetAbsent'; target: z.infer<typeof targetSpecSchema> }
  | { kind: 'textPresent'; text: z.infer<typeof textMatcherSchema>; framePath?: string[] }
  | { kind: 'textAbsent'; text: z.infer<typeof textMatcherSchema>; framePath?: string[] }
  | { kind: 'httpStatusIn'; statuses: number[] }
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'all'; of: Assertion[] }
  | { kind: 'any'; of: Assertion[] }
  | { kind: 'not'; of: Assertion };

export const assertionSchema: z.ZodType<Assertion> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('targetPresent'), target: targetSpecSchema }),
    z.object({ kind: z.literal('targetAbsent'), target: targetSpecSchema }),
    z.object({
      kind: z.literal('textPresent'),
      text: textMatcherSchema,
      framePath: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal('textAbsent'),
      text: textMatcherSchema,
      framePath: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal('httpStatusIn'), statuses: z.array(z.number().int()) }),
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('all'), of: z.array(assertionSchema) }),
    z.object({ kind: z.literal('any'), of: z.array(assertionSchema) }),
    z.object({ kind: z.literal('not'), of: assertionSchema }),
  ]),
);

// --- values --------------------------------------------------------------

// Keeping these apart is what makes a parameterised replay safe: a literal was
// recorded and can be reviewed, a param arrives per call, and a secret is a
// name resolved outside the file.
export const valueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('param'), name: z.string() }),
  z.object({ kind: z.literal('secret'), ref: z.string() }),
  z.object({ kind: z.literal('template'), template: z.string() }),
]);

export const transformSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trim') }),
  z.object({ kind: z.literal('currencyToNumber') }),
  z.object({
    kind: z.literal('regexCapture'),
    pattern: z.string(),
    group: z.number().int().default(1),
  }),
]);

// --- actions -------------------------------------------------------------

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: valueSourceSchema }),
  z.object({ kind: z.literal('click'), target: targetSpecSchema }),
  z.object({ kind: z.literal('type'), target: targetSpecSchema, value: valueSourceSchema }),
  z.object({ kind: z.literal('select'), target: targetSpecSchema, value: valueSourceSchema }),
  z.object({ kind: z.literal('setChecked'), target: targetSpecSchema, checked: z.boolean() }),
  z.object({ kind: z.literal('pressKey'), key: z.string(), target: targetSpecSchema.optional() }),
  z.object({
    kind: z.literal('read'),
    target: targetSpecSchema,
    /** Key this value is stored under, referenced by an output. */
    into: z.string().min(1),
    from: z.enum(['text', 'value', 'name']).default('text'),
    transform: transformSchema.optional(),
  }),
  z.object({
    kind: z.literal('waitFor'),
    assertion: assertionSchema,
    timeoutMs: z.number().int().positive(),
  }),
]);

// --- risk, guards, steps -------------------------------------------------

/**
 * `safe` reads or navigates, `sensitive` writes something a person could undo,
 * `irreversible` posts to the core. Recorded per step, and worked out again at
 * replay from the live control; the stricter of the two wins.
 */
export const riskSchema = z.enum(['safe', 'sensitive', 'irreversible']);

/**
 * A condition a replay is allowed to absorb, and what to do about it. Guards run
 * before a step and are capped, so a recurring interstitial ends the run instead
 * of looping forever. Keeping them in the file means a reviewer can see exactly
 * which surprises a flow may swallow.
 */
export const guardSchema = z.object({
  name: z.string().min(1),
  when: assertionSchema,
  then: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('click'), target: targetSpecSchema }),
    z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
    z.object({ kind: z.literal('reload') }),
  ]),
  maxFirings: z.number().int().positive().default(2),
});

export const stepSchema = z.object({
  id: z.string().min(1),
  /** Plain description, used in logs and when a step needs a person. */
  intent: z.string().min(1),
  action: actionSchema,
  risk: riskSchema.default('safe'),
  /** Proves the step landed. Without one, the flow trusts that a click worked. */
  checkpoint: assertionSchema.optional(),
  guards: z.array(guardSchema).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
  retries: z
    .object({ max: z.number().int().nonnegative(), backoffMs: z.number().int().nonnegative() })
    .default({ max: 1, backoffMs: 400 }),
  onFailure: z.enum(['fail', 'escalate']).default('fail'),
  /** Fingerprint of the screen this step was recorded against. */
  expectedFingerprint: z.string().optional(),
  expectedControls: z.array(z.string()).default([]),
});

// --- the contract --------------------------------------------------------

export const sensitivitySchema = z.enum(['public', 'internal', 'pii', 'secret']);

export const paramSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  enumValues: z.array(z.string()).optional(),
  required: z.boolean().default(true),
  description: z.string().min(1),
  sensitivity: sensitivitySchema.default('internal'),
  /** Checked before the replay touches the application. */
  pattern: z.string().optional(),
  example: z.string().optional(),
});

export const outputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().min(1),
  sensitivity: sensitivitySchema.default('internal'),
  /** The `into` key of the read step that produces this. */
  from: z.string().min(1),
  required: z.boolean().default(true),
});

export const secretSchema = z.object({
  ref: z.string().min(1),
  description: z.string().min(1),
  /** Environment variable it's read from. Never a value. */
  envVar: z.string().min(1),
});

/**
 * A result the caller asked for that isn't the happy path. "No such member" is
 * an answer, not a crash, and mixing the two is the mistake this guards against.
 */
export const outcomeSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'outcome names are SCREAMING_SNAKE_CASE'),
  description: z.string().min(1),
  when: assertionSchema,
  terminal: z.boolean().default(true),
  /** Whether the caller should treat this as an answer or as a problem. */
  disposition: z.enum(['answer', 'needs_human']).default('answer'),
});

export const policySchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  /** Path patterns. `*` matches a segment, `**` the rest, `:name` one segment. */
  allowedRoutes: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).min(1),
  /** Highest risk this may run at without a person confirming. */
  maxRiskWithoutApproval: riskSchema.default('safe'),
  maxSteps: z.number().int().positive().default(60),
  maxDurationMs: z.number().int().positive().default(180_000),
});

export const approvalSchema = z.object({
  state: z.enum(['draft', 'approved', 'revoked']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  note: z.string().optional(),
});

export const stabilitySchema = z.object({
  runs: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  /** Times a step resolved on a fallback rather than its primary. */
  fallbackResolutions: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().optional(),
});

export const stepPatchSchema = z.object({
  target: targetSpecSchema.optional(),
  value: valueSourceSchema.optional(),
  checkpoint: assertionSchema.optional(),
  skip: z.boolean().optional(),
  note: z.string().optional(),
});

/**
 * How one institution's build differs. It may re-target a control, change a
 * literal, tighten a checkpoint, skip a step or add one, and may not touch the
 * contract. A difference that won't fit that shape means the two aren't really
 * running the same flow, and should be a separate capability.
 */
export const tenantOverrideSchema = z.object({
  tenantId: z.string().min(1),
  note: z.string().min(1),
  entryUrl: z.string().optional(),
  steps: z.record(z.string(), stepPatchSchema).default({}),
  extraSteps: z.array(z.object({ afterStepId: z.string().min(1), step: stepSchema })).default([]),
});

export const provenanceSchema = z.object({
  discoveredAt: z.string(),
  discoveryRunId: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  humanEdits: z
    .array(z.object({ at: z.string(), by: z.string(), summary: z.string() }))
    .default([]),
});

export const capabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.number().int().positive(),
  /** The name whatever calls this invokes. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'capability names are snake_case'),
  title: z.string().min(1),
  description: z.string().min(1),

  app: z.object({
    productId: z.string().min(1),
    productVersion: z.string().optional(),
    surface: z.enum(['browser', 'desktop']),
    entryUrl: z.string().min(1),
    /**
     * Values that come from the tenant's own setup rather than from the caller,
     * such as its hostname. Nothing calling this should need to know which host
     * a credit union runs its core on in order to read a balance.
     */
    bindingVariables: z.array(z.string()).default([]),
    recordedOnTenant: z.string().min(1),
  }),

  inputs: z.array(paramSchema).default([]),
  outputs: z.array(outputSchema).default([]),
  secrets: z.array(secretSchema).default([]),

  preconditions: z.array(assertionSchema).default([]),
  steps: z.array(stepSchema).min(1),
  outcomes: z.array(outcomeSchema).default([]),
  /** Checked at the end of a run that reached no terminal outcome. */
  successCheckpoint: assertionSchema,

  policy: policySchema,
  approval: approvalSchema.default({ state: 'draft' }),
  stability: stabilitySchema.default({ runs: 0, successes: 0, fallbackResolutions: 0 }),
  tenantOverrides: z.record(z.string(), tenantOverrideSchema).default({}),
  provenance: provenanceSchema,
});

export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Guard = z.infer<typeof guardSchema>;
export type ParamSpec = z.infer<typeof paramSchema>;
export type OutputSpec = z.infer<typeof outputSchema>;
export type SecretSpec = z.infer<typeof secretSchema>;
export type OutcomeSpec = z.infer<typeof outcomeSchema>;
export type PolicySpec = z.infer<typeof policySchema>;
export type TenantOverride = z.infer<typeof tenantOverrideSchema>;
export type ValueSource = z.infer<typeof valueSourceSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Sensitivity = z.infer<typeof sensitivitySchema>;
export type Transform = z.infer<typeof transformSchema>;
export type TargetSpec = z.infer<typeof targetSpecSchema>;
export type TargetMatcher = z.infer<typeof targetMatcherSchema>;

export function parseArtifact(input: unknown): CapabilityArtifact {
  return capabilityArtifactSchema.parse(input);
}

import { z } from 'zod';

/**
 * The capability artifact.
 *
 * The shape is driven by one idea: this is a *contract*, not a macro. A calling
 * agent has to be able to decide whether to invoke it, what to pass, and what it
 * will get back, without reading the steps. A human reviewer has to be able to
 * approve it without replaying it. So the typed surface — inputs, outputs,
 * outcomes, risk, policy — is declared separately from, and takes precedence
 * over, the step list.
 *
 * Four decisions worth naming:
 *
 * - **No selectors anywhere.** Steps address controls through `TargetSpec`,
 *   which is the surface-agnostic vocabulary from src/surface. That is what
 *   allows the same artifact to run against a browser today and an accessibility
 *   API tomorrow.
 * - **Business outcomes are declared, not inferred.** "No such member" is a
 *   result the caller asked for, so it is a first-class `outcomes` entry with
 *   its own detection assertion, not an exception thrown from step 4.
 * - **The artifact is keyed on the vendor product, not the tenant.** Hundreds of
 *   institutions run the same core. Recording per tenant does not scale, so the
 *   base artifact belongs to the product and per-tenant differences live in
 *   `tenantOverrides` as a narrow patch that a reviewer can read in one screen.
 * - **Secrets are referenced, never carried.** A step says "the password secret";
 *   the value is resolved from the environment at replay and never enters the
 *   file, the logs, or the model's context.
 */

export const SCHEMA_VERSION = 1;

// --- targeting (mirrors src/surface/types.ts, validated at the boundary) ---

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
  /** Why a reviewer should believe this identifies the right control. */
  description: z.string().min(1),
  primary: targetMatcherSchema,
  fallbacks: z.array(targetMatcherSchema).optional(),
});

// --- assertions ------------------------------------------------------------

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

// --- values ----------------------------------------------------------------

/**
 * Where a step's value comes from. Keeping these apart is what makes a
 * parameterised replay safe: a literal recorded during discovery can be
 * reviewed, a param is supplied per invocation, and a secret is a name that is
 * resolved outside the artifact.
 */
export const valueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('param'), name: z.string() }),
  z.object({ kind: z.literal('secret'), ref: z.string() }),
  z.object({ kind: z.literal('template'), template: z.string() }),
]);

export const transformSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trim') }),
  z.object({ kind: z.literal('currencyToNumber') }),
  z.object({ kind: z.literal('regexCapture'), pattern: z.string(), group: z.number().int().default(1) }),
]);

// --- actions ---------------------------------------------------------------

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
    /** Key this value is stored under, referenced by an output declaration. */
    into: z.string().min(1),
    /** Which field of the node to read. */
    from: z.enum(['text', 'value', 'name']).default('text'),
    transform: transformSchema.optional(),
  }),
  z.object({ kind: z.literal('waitFor'), assertion: assertionSchema, timeoutMs: z.number().int().positive() }),
]);

export type ActionKind = z.infer<typeof actionSchema>['kind'];

// --- risk, guards, steps ---------------------------------------------------

/**
 * `safe` reads or navigates. `sensitive` writes something a person could undo.
 * `irreversible` posts to the core. The classification is recorded per step at
 * discovery time and re-derived independently at replay time; if the two
 * disagree, the stricter one wins.
 */
export const riskSchema = z.enum(['safe', 'sensitive', 'irreversible']);

/**
 * A recoverable condition and what to do about it. Guards run *before* a step's
 * action, are bounded by `maxFirings`, and re-observe afterwards. This is where
 * a known interstitial or a transient slow load is handled, and keeping it
 * declarative means a reviewer can see exactly which surprises a capability is
 * allowed to absorb silently.
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
  /** Plain-language intent, carried into escalation context and evidence. */
  intent: z.string().min(1),
  action: actionSchema,
  risk: riskSchema.default('safe'),
  /** Proves the step landed. A step without one is trusting that a click worked. */
  checkpoint: assertionSchema.optional(),
  guards: z.array(guardSchema).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
  retries: z
    .object({ max: z.number().int().nonnegative(), backoffMs: z.number().int().nonnegative() })
    .default({ max: 1, backoffMs: 400 }),
  /** What to do when this step cannot complete and no outcome matched. */
  onFailure: z.enum(['fail', 'escalate']).default('fail'),
  /** Screen fingerprint observed here during discovery, for drift reporting. */
  expectedFingerprint: z.string().optional(),
  /** Named controls the recording saw on this screen, for a readable drift diff. */
  expectedControls: z.array(z.string()).default([]),
});

// --- contract --------------------------------------------------------------

export const sensitivitySchema = z.enum(['public', 'internal', 'pii', 'secret']);

export const paramSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  enumValues: z.array(z.string()).optional(),
  required: z.boolean().default(true),
  description: z.string().min(1),
  sensitivity: sensitivitySchema.default('internal'),
  /** Regex the caller's value must satisfy before the replay touches the app. */
  pattern: z.string().optional(),
  example: z.string().optional(),
});

export const outputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().min(1),
  sensitivity: sensitivitySchema.default('internal'),
  /** The `into` key of the read step that produces this value. */
  from: z.string().min(1),
  required: z.boolean().default(true),
});

export const secretSchema = z.object({
  ref: z.string().min(1),
  description: z.string().min(1),
  /** Environment variable the runtime resolves this from. Never a value. */
  envVar: z.string().min(1),
});

/**
 * A result the caller asked for that happens not to be the happy path.
 * Conflating these with failures is the mistake this schema is shaped to avoid:
 * a replay that ends in MEMBER_NOT_FOUND succeeded at its job.
 */
export const outcomeSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'outcome names are SCREAMING_SNAKE_CASE'),
  description: z.string().min(1),
  when: assertionSchema,
  /** Steps after this point are skipped when the outcome fires. */
  terminal: z.boolean().default(true),
  /** Whether the caller should treat this as an answer or as a problem. */
  disposition: z.enum(['answer', 'needs_human']).default('answer'),
});

export const policySchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  /** Path patterns, `:param` and `*` supported. Empty means any path on an allowed origin. */
  allowedRoutes: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).min(1),
  /** Risk classes this capability may execute without a human confirming. */
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
  /** Times a step resolved on a fallback rung rather than its primary. */
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
 * The narrow, reviewable patch that specialises a product-level capability for
 * one institution. Anything that cannot be said as a patch is a signal that the
 * two tenants are not really running the same flow, and should be a separate
 * capability rather than a fork.
 */
export const tenantOverrideSchema = z.object({
  tenantId: z.string().min(1),
  note: z.string().min(1),
  entryUrl: z.string().optional(),
  steps: z.record(z.string(), stepPatchSchema).default({}),
  extraSteps: z
    .array(z.object({ afterStepId: z.string().min(1), step: stepSchema }))
    .default([]),
});

export const provenanceSchema = z.object({
  discoveredAt: z.string(),
  discoveryRunId: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  /** Recorded so a reviewer can tell an authored artifact from a discovered one. */
  humanEdits: z
    .array(z.object({ at: z.string(), by: z.string(), summary: z.string() }))
    .default([]),
});

export const capabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.number().int().positive(),
  /** The name a calling agent invokes. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'capability names are snake_case'),
  title: z.string().min(1),
  description: z.string().min(1),

  app: z.object({
    productId: z.string().min(1),
    productVersion: z.string().optional(),
    surface: z.enum(['browser', 'desktop', 'terminal']),
    /** Entry point, parameterised so a tenant can point it at its own host. */
    entryUrl: z.string().min(1),
    /**
     * Template variables supplied by the tenant's deployment binding rather
     * than by the calling agent — the institution's hostname, for instance.
     * Keeping these out of `inputs` matters: an agent should not have to know
     * which host a credit union runs its core on in order to look up a balance.
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
  /** Asserted at the end of a run that reached no terminal outcome. */
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

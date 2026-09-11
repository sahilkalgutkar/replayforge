import type { OutputSpec, ParamSpec, Transform, ValueSource } from '../artifact/schema.js';

/**
 * Turning a recorded value source into the string that actually gets typed, and
 * turning what was read off a screen into the typed value a caller receives.
 *
 * Three sources are kept apart on purpose. A literal was recorded during
 * discovery and a reviewer can see it. A param arrives per invocation and is
 * validated against the contract *before* the run touches the app. A secret is
 * a name resolved from the environment at the last moment, so no credential is
 * ever in the artifact, the log, or the model's context.
 */

export type ExtractedValue = string | number | boolean;

export interface RunBindings {
  /** Per-tenant deployment values, e.g. the institution's hostname. */
  readonly variables: Readonly<Record<string, string>>;
  /** Secret values resolved from the environment for this run only. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface InputIssue {
  readonly name: string;
  readonly message: string;
}

const TEMPLATE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
// A global regex carries lastIndex between .test() calls, so detection uses its own copy.
const HAS_TEMPLATE = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/;

export function substituteTemplate(
  template: string,
  params: Readonly<Record<string, ExtractedValue>>,
  bindings: RunBindings,
): string {
  return template.replace(TEMPLATE, (whole, name: string) => {
    if (name in params) return String(params[name]);
    if (name in bindings.variables) return bindings.variables[name] as string;
    throw new Error(
      `template "${template}" references "${name}", which is neither a supplied input nor a tenant binding variable`,
    );
  });
}

export function resolveValue(
  source: ValueSource,
  params: Readonly<Record<string, ExtractedValue>>,
  bindings: RunBindings,
): string {
  switch (source.kind) {
    case 'literal':
      return source.value;
    case 'param': {
      const value = params[source.name];
      if (value === undefined) throw new Error(`input "${source.name}" was not supplied`);
      return String(value);
    }
    case 'secret': {
      const value = bindings.secrets[source.ref];
      if (value === undefined) {
        throw new Error(`secret "${source.ref}" is not available in this environment`);
      }
      return value;
    }
    case 'template':
      return substituteTemplate(source.template, params, bindings);
  }
}

export function applyTransform(raw: string, transform?: Transform): ExtractedValue {
  if (transform === undefined) return raw;
  switch (transform.kind) {
    case 'trim':
      return raw.replace(/\s+/g, ' ').trim();
    case 'currencyToNumber': {
      const cleaned = raw.replace(/[^\d.-]/g, '');
      const value = Number(cleaned);
      // Number('') is 0, so a cell reading "n/a" or an em dash would otherwise
      // become a balance of zero. Requiring a digit is what stops a screen that
      // declined to answer from being reported as an answer.
      if (!/\d/.test(cleaned) || !Number.isFinite(value)) {
        throw new Error(`could not read a number out of "${raw}"`);
      }
      return value;
    }
    case 'regexCapture': {
      const match = new RegExp(transform.pattern).exec(raw);
      const captured = match?.[transform.group];
      if (captured === undefined) {
        throw new Error(
          `pattern /${transform.pattern}/ group ${transform.group} captured nothing from "${raw}"`,
        );
      }
      return captured;
    }
  }
}

/**
 * Validates the caller's arguments against the contract before the run starts.
 * Failing here costs nothing; failing four screens into a banking console costs
 * a half-finished flow someone has to go clean up.
 */
export function validateInputs(
  specs: readonly ParamSpec[],
  supplied: Readonly<Record<string, unknown>>,
): { ok: true; values: Record<string, ExtractedValue> } | { ok: false; issues: InputIssue[] } {
  const issues: InputIssue[] = [];
  const values: Record<string, ExtractedValue> = {};

  for (const spec of specs) {
    const raw = supplied[spec.name];
    if (raw === undefined || raw === '') {
      if (spec.required) issues.push({ name: spec.name, message: 'is required but was not supplied' });
      continue;
    }
    const text = String(raw);

    if (spec.type === 'number') {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        issues.push({ name: spec.name, message: `expected a number, got "${text}"` });
        continue;
      }
      values[spec.name] = value;
    } else if (spec.type === 'boolean') {
      if (!['true', 'false'].includes(text.toLowerCase())) {
        issues.push({ name: spec.name, message: `expected true or false, got "${text}"` });
        continue;
      }
      values[spec.name] = text.toLowerCase() === 'true';
    } else if (spec.type === 'enum') {
      if (!(spec.enumValues ?? []).includes(text)) {
        issues.push({
          name: spec.name,
          message: `expected one of ${(spec.enumValues ?? []).join(', ')}, got "${text}"`,
        });
        continue;
      }
      values[spec.name] = text;
    } else {
      values[spec.name] = text;
    }

    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(text)) {
      issues.push({ name: spec.name, message: `does not match the required pattern ${spec.pattern}` });
    }
  }

  const declared = new Set(specs.map((s) => s.name));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      issues.push({ name, message: 'is not a parameter this capability declares' });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}

/** Coerces a value read off the screen into the type the contract promised. */
export function coerceOutput(
  spec: OutputSpec,
  value: ExtractedValue | undefined,
): { ok: true; value: ExtractedValue } | { ok: false; message: string } {
  if (value === undefined) {
    return spec.required
      ? { ok: false, message: `output "${spec.name}" was declared required but no step produced it` }
      : { ok: true, value: '' };
  }
  if (spec.type === 'number') {
    const cleaned = typeof value === 'number' ? String(value) : String(value).replace(/[^\d.-]/g, '');
    const numeric = Number(cleaned);
    // Same trap as applyTransform: an empty result parses as 0 rather than
    // failing, which would report a balance nobody read.
    if (!/\d/.test(cleaned) || !Number.isFinite(numeric)) {
      return { ok: false, message: `output "${spec.name}" is declared number but read "${String(value)}"` };
    }
    return { ok: true, value: numeric };
  }
  if (spec.type === 'boolean') {
    return { ok: true, value: Boolean(value) };
  }
  return { ok: true, value: String(value) };
}

/** Reads the declared secrets out of the environment, naming any that are missing. */
export function resolveSecrets(
  specs: readonly { ref: string; envVar: string }[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; secrets: Record<string, string> } | { ok: false; missing: string[] } {
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of specs) {
    const value = env[spec.envVar];
    if (value === undefined || value === '') missing.push(`${spec.ref} (${spec.envVar})`);
    else secrets[spec.ref] = value;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, secrets };
}

/**
 * Substitutes `{{param}}` references inside a recorded target or assertion.
 *
 * A discovery run frequently identifies a control by the value it was given —
 * "the result row whose link text is the member number I searched for". That is
 * a *better* target than an ordinal, because it is the thing that makes the row
 * the right row, so the schema has to be able to express it and the engine has
 * to be able to fill it in per invocation.
 *
 * Applied only to targets and assertions. Value sources are resolved through
 * `resolveValue`, which distinguishes a literal from a parameter deliberately,
 * and must not have that distinction erased by a blanket text substitution.
 */
export function deepSubstitute<T>(
  value: T,
  params: Readonly<Record<string, ExtractedValue>>,
  bindings: RunBindings,
): T {
  if (typeof value === 'string') {
    return (HAS_TEMPLATE.test(value)
      ? substituteTemplate(value, params, bindings)
      : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepSubstitute(item, params, bindings)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        deepSubstitute(inner, params, bindings),
      ]),
    ) as T;
  }
  return value;
}

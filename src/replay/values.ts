import type { OutputSpec, ParamSpec, Transform, ValueSource } from '../artifact/schema.js';

// Getting from a recorded value to the string that gets typed, and from what
// was read off a screen to the typed value the caller gets back.

export type ExtractedValue = string | number | boolean;

export interface RunBindings {
  /** Values from the tenant's own setup, like its hostname. */
  readonly variables: Readonly<Record<string, string>>;
  /** Secret values read from the environment for this run only. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface InputIssue {
  readonly name: string;
  readonly message: string;
}

const TEMPLATE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
// A /g regex keeps state between .test() calls, so detection gets its own.
const HAS_TEMPLATE = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/;

export function substituteTemplate(
  template: string,
  params: Readonly<Record<string, ExtractedValue>>,
  bindings: RunBindings,
): string {
  return template.replace(TEMPLATE, (_whole, name: string) => {
    if (name in params) return String(params[name]);
    if (name in bindings.variables) return bindings.variables[name] as string;
    throw new Error(`"${template}" refers to "${name}", which is neither an input nor a tenant variable`);
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
      if (value === undefined) throw new Error(`secret "${source.ref}" isn't available here`);
      return value;
    }
    case 'template':
      return substituteTemplate(source.template, params, bindings);
  }
}

/**
 * Fills `{{param}}` references inside a recorded target or check. A flow often
 * identifies a control by the value it was given, like "the result row whose
 * link is the member number I searched for", which is a better target than a
 * position. Only used on targets and checks; value sources go through
 * resolveValue so a recorded literal stays a literal.
 */
export function deepSubstitute<T>(
  value: T,
  params: Readonly<Record<string, ExtractedValue>>,
  bindings: RunBindings,
): T {
  if (typeof value === 'string') {
    return (HAS_TEMPLATE.test(value) ? substituteTemplate(value, params, bindings) : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => deepSubstitute(item, params, bindings)) as unknown as T;
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

export function applyTransform(raw: string, transform?: Transform): ExtractedValue {
  if (transform === undefined) return raw;
  switch (transform.kind) {
    case 'trim':
      return raw.replace(/\s+/g, ' ').trim();
    case 'currencyToNumber': {
      const cleaned = raw.replace(/[^\d.-]/g, '');
      // Number('') is 0, so without the digit check a cell saying "n/a" would
      // come back as a balance of zero.
      if (!/\d/.test(cleaned) || !Number.isFinite(Number(cleaned))) {
        throw new Error(`couldn't read a number out of "${raw}"`);
      }
      return Number(cleaned);
    }
    case 'regexCapture': {
      const captured = new RegExp(transform.pattern).exec(raw)?.[transform.group];
      if (captured === undefined) {
        throw new Error(`/${transform.pattern}/ group ${transform.group} captured nothing from "${raw}"`);
      }
      return captured;
    }
  }
}

/** Checks the caller's arguments before the run touches anything. */
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
      if (!Number.isFinite(Number(text))) {
        issues.push({ name: spec.name, message: `expected a number, got "${text}"` });
        continue;
      }
      values[spec.name] = Number(text);
    } else if (spec.type === 'boolean') {
      if (!['true', 'false'].includes(text.toLowerCase())) {
        issues.push({ name: spec.name, message: `expected true or false, got "${text}"` });
        continue;
      }
      values[spec.name] = text.toLowerCase() === 'true';
    } else if (spec.type === 'enum') {
      if (!(spec.enumValues ?? []).includes(text)) {
        issues.push({ name: spec.name, message: `expected one of ${(spec.enumValues ?? []).join(', ')}, got "${text}"` });
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

  const declared = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) issues.push({ name, message: "isn't a parameter this capability takes" });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}

/** Turns what was read into the type the contract promised. */
export function coerceOutput(
  spec: OutputSpec,
  value: ExtractedValue | undefined,
): { ok: true; value: ExtractedValue } | { ok: false; message: string } {
  if (value === undefined) {
    return spec.required
      ? { ok: false, message: `output "${spec.name}" is required but no step produced it` }
      : { ok: true, value: '' };
  }
  if (spec.type === 'number') {
    const cleaned = typeof value === 'number' ? String(value) : String(value).replace(/[^\d.-]/g, '');
    if (!/\d/.test(cleaned) || !Number.isFinite(Number(cleaned))) {
      return { ok: false, message: `output "${spec.name}" should be a number but read "${String(value)}"` };
    }
    return { ok: true, value: Number(cleaned) };
  }
  if (spec.type === 'boolean') return { ok: true, value: Boolean(value) };
  return { ok: true, value: String(value) };
}

/** Reads declared secrets from the environment, naming any that are missing. */
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

import type { Observation } from '../surface/types.js';

/**
 * Redaction at egress.
 *
 * The rule this implements: raw screen content is fine to hold in memory for
 * the duration of a step, and is never fine to *write down or send anywhere*.
 * So nothing redacts on the way in — the resolver needs the real text to find a
 * row — and everything redacts on the way out: the model prompt, the evidence
 * log, the artifact, the escalation payload.
 *
 * Two layers, in this order:
 *
 * 1. **Known secret values.** Whatever was resolved from the environment for
 *    this run is replaced by its reference name. This is the only layer that
 *    can be exact, so it runs first and it runs on every string.
 * 2. **Shaped identifiers.** Social security numbers, payment card numbers
 *    (Luhn-checked, so an order total is not mistaken for a PAN), email
 *    addresses and long bare digit runs. These are heuristics and are meant to
 *    be: the cost of over-redacting a log line is a slightly less readable log,
 *    and the cost of under-redacting one is regulated data at rest.
 */

export interface RedactorOptions {
  /** Secret values to mask, keyed by the reference name that replaces them. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Parameter values the contract marked as PII, keyed by parameter name. */
  readonly piiValues?: Readonly<Record<string, string>>;
  readonly extraPatterns?: readonly { readonly label: string; readonly pattern: RegExp }[];
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
// Anchored on a digit at both ends so a trailing separator is not swallowed.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const LONG_DIGITS = /\b\d{9,}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export class Redactor {
  private readonly secrets: ReadonlyArray<[string, string]>;
  private readonly pii: ReadonlyArray<[string, string]>;
  private readonly extra: readonly { label: string; pattern: RegExp }[];

  constructor(options: RedactorOptions = {}) {
    // Short values would match everywhere; masking them costs more than it buys.
    this.secrets = Object.entries(options.secrets ?? {}).filter(([, value]) => value.length >= 4);
    this.pii = Object.entries(options.piiValues ?? {}).filter(([, value]) => value.length >= 4);
    this.extra = options.extraPatterns ?? [];
  }

  redact(text: string): string {
    let out = text;
    for (const [ref, value] of this.secrets) out = replaceAll(out, value, `«secret:${ref}»`);
    for (const [name, value] of this.pii) out = replaceAll(out, value, `«pii:${name}»`);
    out = out.replace(SSN, '«ssn»');
    out = out.replace(EMAIL, '«email»');
    out = out.replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return luhnValid(digits) ? '«card»' : match;
    });
    out = out.replace(LONG_DIGITS, '«digits»');
    for (const { label, pattern } of this.extra) {
      out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), `«${label}»`);
    }
    return out;
  }

  /** Deep-redacts every string in a JSON-serialisable value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as unknown as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.redactDeep(v)]),
      ) as T;
    }
    return value;
  }

  redactObservation(observation: Observation): Observation {
    return {
      ...observation,
      text: this.redact(observation.text),
      nodes: observation.nodes.map((node) => ({
        ...node,
        name: this.redact(node.name),
        ...(node.value === undefined ? {} : { value: this.redact(node.value) }),
        ...(node.text === undefined ? {} : { text: this.redact(node.text) }),
        ...(node.nearbyText === undefined ? {} : { nearbyText: this.redact(node.nearbyText) }),
        ...(node.table === undefined
          ? {}
          : {
              table: {
                ...node.table,
                ...(node.table.rowHeader === undefined
                  ? {}
                  : { rowHeader: this.redact(node.table.rowHeader) }),
                ...(node.table.columnHeader === undefined
                  ? {}
                  : { columnHeader: this.redact(node.table.columnHeader) }),
              },
            }),
      })),
    };
  }
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle === '') return haystack;
  return haystack.split(needle).join(replacement);
}

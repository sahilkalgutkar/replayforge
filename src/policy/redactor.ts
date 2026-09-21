import type { Observation } from '../surface/types.js';

// Redaction happens on the way out, not on the way in. The resolver needs the
// real text to find a row, so nothing is scrubbed while a step runs, but
// everything written down or sent anywhere goes through here first.
//
// Known secret values are masked first, exactly. Then anything shaped like an
// SSN, email, card number or long account-style number. Those are heuristics:
// over-redacting a log line makes it slightly harder to read, under-redacting
// one leaves regulated data sitting in a file.

export interface RedactorOptions {
  /** Secret values to mask, keyed by the name to show instead. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Argument values marked as personal, keyed by parameter name. */
  readonly piiValues?: Readonly<Record<string, string>>;
  readonly extraPatterns?: readonly { readonly label: string; readonly pattern: RegExp }[];
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
// Starts and ends on a digit so a trailing space isn't swallowed.
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

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return needle === '' ? haystack : haystack.split(needle).join(replacement);
}

export class Redactor {
  private readonly secrets: ReadonlyArray<[string, string]>;
  private readonly pii: ReadonlyArray<[string, string]>;
  private readonly extra: readonly { label: string; pattern: RegExp }[];

  constructor(options: RedactorOptions = {}) {
    // Very short values would match all over the place.
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
    out = out.replace(CARD_CANDIDATE, (match) => (luhnValid(match.replace(/[ -]/g, '')) ? '«card»' : match));
    out = out.replace(LONG_DIGITS, '«digits»');
    for (const { label, pattern } of this.extra) {
      const global = pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
      out = out.replace(global, `«${label}»`);
    }
    return out;
  }

  /** Redacts every string inside a JSON-shaped value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as unknown as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, this.redactDeep(inner)]),
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
                ...(node.table.rowHeader === undefined ? {} : { rowHeader: this.redact(node.table.rowHeader) }),
                ...(node.table.columnHeader === undefined
                  ? {}
                  : { columnHeader: this.redact(node.table.columnHeader) }),
              },
            }),
      })),
    };
  }
}

/**
 * A small argv parser. A dependency would be defensible; this is 60 lines and
 * the CLI's shape is not going to grow much, so it is not worth one.
 */

export interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Repeatable `--input k=v` pairs, collected by flag name. */
  readonly pairs: Readonly<Record<string, Record<string, string>>>;
}

const PAIR_FLAGS = new Set(['input', 'secret', 'variable']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const pairs: Record<string, Record<string, string>> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const inline = name.includes('=') ? name.slice(name.indexOf('=') + 1) : undefined;
    const key = name.includes('=') ? name.slice(0, name.indexOf('=')) : name;
    const next = rest[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith('--') ? (i += 1, next) : undefined);

    if (PAIR_FLAGS.has(key)) {
      if (value === undefined || !value.includes('=')) {
        throw new Error(`--${key} expects key=value, got ${value ?? '(nothing)'}`);
      }
      const separator = value.indexOf('=');
      pairs[key] = { ...pairs[key], [value.slice(0, separator)]: value.slice(separator + 1) };
      continue;
    }
    flags[key] = value ?? true;
  }

  return { command, positional, flags, pairs };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function flag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags[name];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

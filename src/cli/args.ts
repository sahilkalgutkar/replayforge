// A small argument parser. The CLI is small enough that a library isn't worth it.

export interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Repeatable `--input k=v` style flags, collected by flag name. */
  readonly pairs: Readonly<Record<string, Record<string, string>>>;
}

const PAIR_FLAGS = new Set(['input', 'probe', 'secret', 'variable']);

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
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    let value: string | undefined = eq === -1 ? undefined : body.slice(eq + 1);
    const next = rest[i + 1];
    if (value === undefined && next !== undefined && !next.startsWith('--')) {
      value = next;
      i += 1;
    }

    if (PAIR_FLAGS.has(key)) {
      if (value === undefined || !value.includes('=')) {
        throw new Error(`--${key} expects key=value, got ${value ?? 'nothing'}`);
      }
      const split = value.indexOf('=');
      pairs[key] = { ...pairs[key], [value.slice(0, split)]: value.slice(split + 1) };
    } else {
      flags[key] = value ?? true;
    }
  }
  return { command, positional, flags, pairs };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags[name];
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`);
  return value;
}

export function flag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags[name];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

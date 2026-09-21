// Where a flow is allowed to go and what it's allowed to do there.
//
// Origins have to match exactly. Suffix matching is the usual hole: a check for
// "ends with bank.com" also accepts evilbank.com. Routes are simple patterns
// rather than regexes so someone reviewing a tenant's config can read them.

export interface AllowlistConfig {
  readonly origins: readonly string[];
  /** `*` matches one segment, `**` the rest of the path, `:name` one segment. */
  readonly routes: readonly string[];
  readonly actions: readonly string[];
}

export type AllowlistVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function normaliseOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

export function routeMatches(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  let p = 0;
  let q = 0;
  while (p < patternParts.length) {
    const segment = patternParts[p];
    if (segment === '**') return true;
    if (q >= pathParts.length) return false;
    if (segment !== '*' && !segment?.startsWith(':') && segment !== pathParts[q]) return false;
    p += 1;
    q += 1;
  }
  return q === pathParts.length;
}

export class Allowlist {
  private readonly origins: readonly string[];
  private readonly routes: readonly string[];
  private readonly actions: ReadonlySet<string>;

  constructor(config: AllowlistConfig) {
    this.origins = config.origins.map(normaliseOrigin);
    this.routes = config.routes;
    this.actions = new Set(config.actions);
  }

  checkAction(kind: string): AllowlistVerdict {
    if (this.actions.has(kind)) return { allowed: true };
    return {
      allowed: false,
      reason: `action "${kind}" isn't in the allowed list (${[...this.actions].join(', ')})`,
    };
  }

  checkLocation(rawUrl: string): AllowlistVerdict {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: `"${rawUrl}" isn't a URL this policy can check` };
    }
    if (!this.origins.includes(url.origin)) {
      return { allowed: false, reason: `origin ${url.origin} isn't allowed (allowed: ${this.origins.join(', ')})` };
    }
    if (this.routes.length === 0) return { allowed: true };
    if (this.routes.some((route) => routeMatches(route, url.pathname))) return { allowed: true };
    return { allowed: false, reason: `path ${url.pathname} on ${url.origin} matches no allowed route` };
  }
}

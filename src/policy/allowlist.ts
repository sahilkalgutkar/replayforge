/**
 * Where the agent is allowed to go and what it is allowed to do there.
 *
 * The allowlist is checked at one choke point used by both discovery and
 * replay, because two enforcement paths eventually disagree and the one that is
 * wrong is always the one running unattended against production.
 *
 * Matching is deliberately strict. An origin must match exactly — no suffix
 * matching, because `bank.com.evil.net` ends with nothing an operator wrote but
 * `endsWith('bank.com')` would happily accept `evilbank.com`. Routes are
 * explicit patterns rather than a regex, so an operator reviewing a tenant's
 * configuration can read them.
 */

export interface AllowlistConfig {
  readonly origins: readonly string[];
  /** Path patterns. `*` matches one segment, `**` matches the rest, `:name` matches one segment. */
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
      reason: `action "${kind}" is not in the allowed action list (${[...this.actions].join(', ')})`,
    };
  }

  checkLocation(rawUrl: string): AllowlistVerdict {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: `"${rawUrl}" is not a URL this policy can evaluate` };
    }
    if (!this.origins.includes(url.origin)) {
      return {
        allowed: false,
        reason: `origin ${url.origin} is not allowed (allowed: ${this.origins.join(', ')})`,
      };
    }
    if (this.routes.length === 0) return { allowed: true };
    if (this.routes.some((route) => routeMatches(route, url.pathname))) return { allowed: true };
    return {
      allowed: false,
      reason: `path ${url.pathname} on ${url.origin} matches no allowed route pattern`,
    };
  }
}

import { randomBytes } from 'node:crypto';

export type InjectionMode =
  | 'session-timeout'
  | 'record-not-found'
  | 'validation-error'
  | 'permission-denied'
  | 'interstitial'
  | 'slow'
  | 'server-error';

export const INJECTION_MODES: readonly InjectionMode[] = [
  'session-timeout',
  'record-not-found',
  'validation-error',
  'permission-denied',
  'interstitial',
  'slow',
  'server-error',
];

export function isInjectionMode(value: string): value is InjectionMode {
  return (INJECTION_MODES as readonly string[]).includes(value);
}

/** Remaining firings per armed fault. */
export type Injections = Map<InjectionMode, number>;

export function arm(injections: Injections, mode: InjectionMode, count = 1): void {
  injections.set(mode, count);
}

/** Uses up one firing of `mode` and returns true if it was armed. */
export function consume(injections: Injections, mode: InjectionMode): boolean {
  const remaining = injections.get(mode);
  if (remaining === undefined || remaining <= 0) return false;
  if (remaining === 1) injections.delete(mode);
  else injections.set(mode, remaining - 1);
  return true;
}

export interface Session {
  readonly id: string;
  /** Salt for the generated form field names. */
  readonly salt: string;
  signedIn: boolean;
  user: string | null;
  readonly injections: Injections;
  /** Sub-account drafts waiting on the review screen, keyed by token. */
  readonly drafts: Map<string, Record<string, string>>;
}

// One store per app instance. Browsers don't scope cookies by port, so the two
// tenants can't share one or signing in to one signs you in to both.
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(): Session {
    const session: Session = {
      id: randomBytes(12).toString('hex'),
      salt: randomBytes(4).toString('hex'),
      signedIn: false,
      user: null,
      injections: new Map(),
      drafts: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  drop(id: string): void {
    this.sessions.delete(id);
  }
}

// Field names are generated per session, like an old WebForms app, so nothing
// can rely on a field's name or id staying the same between sign-ons.
export function fieldName(session: Session, logical: string): string {
  return `ctl00$${session.salt}$${logical}`;
}

export function readField(
  session: Session,
  body: Record<string, unknown>,
  logical: string,
): string {
  const value = body[fieldName(session, logical)];
  return typeof value === 'string' ? value : '';
}

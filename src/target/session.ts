import { randomBytes } from 'node:crypto';

/**
 * Fault modes the demo app can be told to produce. These are armed out of band
 * through POST /_test/inject so that the injected condition never appears in a
 * URL the agent navigated to — a recorded artifact must not carry the fault with
 * it. Each mode is one-shot unless a count is given.
 */
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

export interface Session {
  readonly id: string;
  /** Per-session salt behind the scrambled form field names. */
  readonly salt: string;
  signedIn: boolean;
  user: string | null;
  createdAt: number;
  /** Remaining firings per armed fault mode. */
  readonly injections: Map<InjectionMode, number>;
  /** Sub-account drafts keyed by a per-session token. */
  readonly drafts: Map<string, Record<string, string>>;
}

const sessions = new Map<string, Session>();

export function createSession(): Session {
  const session: Session = {
    id: randomBytes(12).toString('hex'),
    salt: randomBytes(4).toString('hex'),
    signedIn: false,
    user: null,
    createdAt: Date.now(),
    injections: new Map(),
    drafts: new Map(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string | undefined): Session | undefined {
  return id === undefined ? undefined : sessions.get(id);
}

export function dropSession(id: string): void {
  sessions.delete(id);
}

export function arm(session: Session, mode: InjectionMode, count = 1): void {
  session.injections.set(mode, count);
}

/**
 * Consumes one firing of `mode` if armed. Returns whether the fault should fire
 * on this request.
 */
export function consume(session: Session, mode: InjectionMode): boolean {
  const remaining = session.injections.get(mode);
  if (remaining === undefined || remaining <= 0) return false;
  if (remaining === 1) session.injections.delete(mode);
  else session.injections.set(mode, remaining - 1);
  return true;
}

/**
 * Form field names are scrambled per session, the way a WebForms-era app emits
 * generated control ids. This is deliberate: it means any recorded flow that
 * targets elements by `name` or `id` breaks on the very next session, so the
 * only targeting strategy that survives is a semantic one. The replay engine
 * never sees these strings.
 */
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

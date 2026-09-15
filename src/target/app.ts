import express, { type Express, type Request, type Response } from 'express';
import { findMember, searchMembers } from './data.js';
import { profileFor } from './profiles.js';
import {
  arm,
  consume,
  isInjectionMode,
  readField,
  SessionStore,
  type InjectionMode,
  type Injections,
  type Session,
} from './session.js';
import * as views from './views.js';

const SPACER_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
);

export interface TargetAppOptions {
  readonly tenantId?: string;
  readonly username?: string;
  readonly password?: string;
  /** How long the `slow` fault stalls a request, in ms. */
  readonly slowMs?: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

function sessionOf(req: Request): Session {
  return (req as unknown as { session: Session }).session;
}

function validateDraft(draft: Record<string, string>): string | undefined {
  if (!draft.product) return 'Product Code is required.';
  if (!draft.nickname?.trim()) return 'Nickname is required.';
  const deposit = Number(String(draft.deposit ?? '').replace(/[$,]/g, ''));
  if (!Number.isFinite(deposit) || String(draft.deposit ?? '').trim() === '') {
    return 'Opening Deposit must be a number.';
  }
  if (deposit < 25) return 'Opening Deposit must be at least $25.00.';
  return undefined;
}

export function createTargetApp(options: TargetAppOptions = {}): Express {
  const profile = profileFor(options.tenantId ?? 'base');
  const username = options.username ?? process.env.MERIDIAN_USERNAME ?? 'teller01';
  const password = options.password ?? process.env.MERIDIAN_PASSWORD ?? 'demo-pass-01';
  const slowMs = options.slowMs ?? 6_000;
  const cookieName = `mcsid_${profile.tenantId}`;
  const store = new SessionStore();
  const globalInjections: Injections = new Map();

  // A fault armed on the session fires before one armed for everyone.
  const fires = (session: Session, mode: InjectionMode): boolean =>
    consume(session.injections, mode) || consume(globalInjections, mode);

  const send = (res: Response, body: string, status = 200): void => {
    res.status(status).type('html').send(body);
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const existing = store.get(parseCookies(req.headers.cookie)[cookieName]);
    const session = existing ?? store.create();
    if (!existing) {
      res.setHeader('Set-Cookie', `${cookieName}=${session.id}; Path=/; HttpOnly; SameSite=Lax`);
    }
    (req as unknown as { session: Session }).session = session;
    next();
  });

  app.get('/img/spacer.gif', (_req, res) => {
    res.type('gif').send(SPACER_GIF);
  });

  // Fault arming for tests. Kept off the app's own routes so a recorded flow
  // never passes through it. scope=global arms the fault for every session,
  // which is what you want when poking at it from curl.
  app.post('/_test/inject', (req, res) => {
    const mode = String(req.body?.mode ?? '');
    if (!isInjectionMode(mode)) {
      res.status(400).json({ error: `unknown injection mode "${mode}"` });
      return;
    }
    const requested = Number(req.body?.count ?? 1);
    const count = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const scope = req.body?.scope === 'global' ? 'global' : 'session';
    arm(scope === 'global' ? globalInjections : sessionOf(req).injections, mode, count);
    res.json({ armed: mode, count, scope });
  });

  app.post('/_test/clear', (req, res) => {
    sessionOf(req).injections.clear();
    globalInjections.clear();
    res.json({ cleared: true });
  });

  app.get('/', (req, res) => {
    send(res, views.loginPage(profile, sessionOf(req)));
  });

  app.post('/login', (req, res) => {
    const session = sessionOf(req);
    const user = readField(session, req.body ?? {}, 'user');
    const pass = readField(session, req.body ?? {}, 'pass');
    if (user !== username || pass !== password) {
      send(res, views.loginPage(profile, session, 'Sign on failed. Check your User ID and password.'), 401);
      return;
    }
    session.signedIn = true;
    session.user = user;
    res.redirect(302, '/console');
  });

  app.get('/logout', (req, res) => {
    store.drop(sessionOf(req).id);
    res.redirect(302, '/');
  });

  app.get('/console', (req, res) => {
    if (!sessionOf(req).signedIn) {
      res.redirect(302, '/');
      return;
    }
    send(res, views.framesetPage(profile));
  });

  app.get('/nav', (req, res) => {
    if (!sessionOf(req).signedIn) {
      send(res, views.sessionExpired(profile), 401);
      return;
    }
    send(res, views.navFrame(profile));
  });

  // Everything under /content goes through the fault checks and the sign-on
  // check first.
  app.use('/content', (req, res, next) => {
    void (async () => {
      const session = sessionOf(req);
      if (fires(session, 'server-error')) {
        send(res, views.serverError(profile), 500);
        return;
      }
      if (fires(session, 'session-timeout')) session.signedIn = false;
      if (!session.signedIn) {
        send(res, views.sessionExpired(profile), 401);
        return;
      }
      if (fires(session, 'slow')) {
        await new Promise((resolve) => setTimeout(resolve, slowMs));
      }
      if (req.method === 'GET' && fires(session, 'interstitial')) {
        send(res, views.interstitial(profile, req.originalUrl));
        return;
      }
      next();
    })();
  });

  app.get('/content/home', (req, res) => {
    send(res, views.homeFrame(profile, sessionOf(req).user ?? 'unknown'));
  });

  app.get('/content/transactions', (_req, res) => {
    send(res, views.simpleFrame(profile, 'Transactions', 'Select an account from a member record.'));
  });

  app.get('/content/reports', (_req, res) => {
    send(res, views.simpleFrame(profile, 'Reports', 'No scheduled reports are available today.'));
  });

  app.get('/content/member-search', (req, res) => {
    send(res, views.searchForm(profile, sessionOf(req)));
  });

  app.post('/content/member-search', (req, res) => {
    const session = sessionOf(req);
    const query = readField(session, req.body ?? {}, 'q');
    if (query.trim() === '') {
      send(res, views.searchForm(profile, session, `Enter a ${profile.memberNumberLabel.toLowerCase()} to search.`));
      return;
    }
    const results = fires(session, 'record-not-found') ? [] : searchMembers(query);
    send(res, views.searchResults(profile, results, query));
  });

  const memberScreen = (tab: 'profile' | 'accounts') => (req: Request, res: Response) => {
    const id = String(req.params.id);
    const member = findMember(id);
    if (!member) {
      send(res, views.searchResults(profile, [], id));
      return;
    }
    if (member.restricted || fires(sessionOf(req), 'permission-denied')) {
      send(res, views.permissionDenied(profile, member.memberNumber), 403);
      return;
    }
    send(res, views.memberDetail(profile, member, tab));
  };

  app.get('/content/member/:id', memberScreen('profile'));
  app.get('/content/member/:id/accounts', memberScreen('accounts'));

  app.get('/content/member/:id/new-subaccount', (req, res) => {
    const member = findMember(String(req.params.id));
    if (!member) {
      send(res, views.searchResults(profile, [], String(req.params.id)));
      return;
    }
    send(res, views.newSubAccountForm(profile, sessionOf(req), member, {}));
  });

  app.post('/content/member/:id/new-subaccount', (req, res) => {
    const session = sessionOf(req);
    const member = findMember(String(req.params.id));
    if (!member) {
      send(res, views.searchResults(profile, [], String(req.params.id)));
      return;
    }
    const draft = {
      product: readField(session, req.body ?? {}, 'product'),
      nickname: readField(session, req.body ?? {}, 'nickname'),
      deposit: readField(session, req.body ?? {}, 'deposit'),
    };
    const error = fires(session, 'validation-error')
      ? 'Product SAV02 is not available for this membership tier.'
      : validateDraft(draft);
    if (error) {
      send(res, views.newSubAccountForm(profile, session, member, draft, error));
      return;
    }
    const token = `dr-${Date.now().toString(36)}-${session.drafts.size}`;
    session.drafts.set(token, draft);
    send(res, views.subAccountReview(profile, member, draft, token));
  });

  app.post('/content/member/:id/new-subaccount/confirm', (req, res) => {
    const session = sessionOf(req);
    const member = findMember(String(req.params.id));
    const token = String(req.body?.token ?? '');
    const draft = session.drafts.get(token);
    if (!member || !draft) {
      send(res, views.serverError(profile), 500);
      return;
    }
    if (profile.extraAcknowledgement && req.body?.ack !== '1') {
      send(
        res,
        views.subAccountReview(
          profile,
          member,
          draft,
          token,
          'You must acknowledge the identity verification before posting.',
        ),
      );
      return;
    }
    session.drafts.delete(token);
    send(res, views.subAccountConfirmed(profile, `${draft.product}-${member.memberNumber}`, member.memberNumber));
  });

  return app;
}

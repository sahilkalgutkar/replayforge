import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { findMember, searchMembers } from './data.js';
import { profileFor, type TenantProfile } from './profiles.js';
import {
  arm,
  consume,
  createSession,
  dropSession,
  getSession,
  isInjectionMode,
  readField,
  type Session,
} from './session.js';
import * as views from './views.js';

const COOKIE = 'mcsid';
const SPACER_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
);

export interface TargetAppOptions {
  readonly tenantId?: string;
  readonly username?: string;
  readonly password?: string;
  /** Milliseconds the `slow` fault stalls a request for. */
  readonly slowMs?: number;
}

interface AppRequest extends Request {
  session: Session;
  profile: TenantProfile;
}

/** Express's generic Request does not carry our per-request additions. */
function ctx(req: Request): AppRequest {
  return req as unknown as AppRequest;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const html = (res: Response, body: string, status = 200): void => {
  res.status(status).type('html').send(body);
};

export function createTargetApp(options: TargetAppOptions = {}): Express {
  const profile = profileFor(options.tenantId ?? 'base');
  const username = options.username ?? process.env.MERIDIAN_USERNAME ?? 'teller01';
  const password = options.password ?? process.env.MERIDIAN_PASSWORD ?? 'demo-pass-01';
  const slowMs = options.slowMs ?? 6_000;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const r = req as AppRequest;
    const existing = getSession(parseCookies(req.headers.cookie)[COOKIE]);
    const session = existing ?? createSession();
    if (!existing) {
      res.setHeader('Set-Cookie', `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`);
    }
    r.session = session;
    r.profile = profile;
    next();
  });

  app.get('/img/spacer.gif', (_req, res) => {
    res.type('gif').send(SPACER_GIF);
  });

  // --- out-of-band fault arming -------------------------------------------
  // Kept off the navigable surface on purpose: an injected fault must never be
  // reachable from a URL the agent could have recorded.
  app.post('/_test/inject', (req, res) => {
    const { session } = ctx(req);
    const mode = String(req.body?.mode ?? '');
    const count = Number(req.body?.count ?? 1);
    if (!isInjectionMode(mode)) {
      res.status(400).json({ error: `unknown injection mode "${mode}"` });
      return;
    }
    arm(session, mode, Number.isFinite(count) && count > 0 ? count : 1);
    res.json({ armed: mode, count });
  });

  app.post('/_test/clear', (req, res) => {
    ctx(req).session.injections.clear();
    res.json({ cleared: true });
  });

  // --- sign on -------------------------------------------------------------
  app.get('/', (req, res) => {
    const { session } = ctx(req);
    html(res, views.loginPage(profile, session));
  });

  app.post('/login', (req, res) => {
    const { session } = ctx(req);
    const user = readField(session, req.body ?? {}, 'user');
    const pass = readField(session, req.body ?? {}, 'pass');
    if (user !== username || pass !== password) {
      html(res, views.loginPage(profile, session, 'Sign on failed. Check your User ID and password.'), 401);
      return;
    }
    session.signedIn = true;
    session.user = user;
    res.redirect(302, '/console');
  });

  app.get('/logout', (req, res) => {
    const { session } = ctx(req);
    dropSession(session.id);
    res.redirect(302, '/');
  });

  app.get('/console', (req, res) => {
    const { session } = ctx(req);
    if (!session.signedIn) {
      res.redirect(302, '/');
      return;
    }
    html(res, views.framesetPage(profile));
  });

  app.get('/nav', (req, res) => {
    const { session } = ctx(req);
    if (!session.signedIn) {
      html(res, views.sessionExpired(profile), 401);
      return;
    }
    html(res, views.navFrame(profile));
  });

  // --- fault gate for every content screen ---------------------------------
  const contentGate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { session } = ctx(req);

    if (consume(session, 'server-error')) {
      html(res, views.serverError(profile), 500);
      return;
    }
    if (consume(session, 'session-timeout')) {
      session.signedIn = false;
      html(res, views.sessionExpired(profile), 401);
      return;
    }
    if (!session.signedIn) {
      html(res, views.sessionExpired(profile), 401);
      return;
    }
    if (consume(session, 'slow')) {
      await new Promise((resolve) => setTimeout(resolve, slowMs));
    }
    if (req.method === 'GET' && consume(session, 'interstitial')) {
      html(res, views.interstitial(profile, req.originalUrl));
      return;
    }
    next();
  };

  app.use('/content', (req, res, next) => {
    void contentGate(req, res, next);
  });

  app.get('/content/home', (req, res) => {
    const { session } = ctx(req);
    html(res, views.homeFrame(profile, session.user ?? 'unknown'));
  });

  app.get('/content/transactions', (_req, res) => {
    html(res, views.simpleFrame(profile, 'Transactions', 'Select an account from a member record.'));
  });

  app.get('/content/reports', (_req, res) => {
    html(res, views.simpleFrame(profile, 'Reports', 'No scheduled reports are available today.'));
  });

  app.get('/content/member-search', (req, res) => {
    const { session } = ctx(req);
    html(res, views.searchForm(profile, session));
  });

  app.post('/content/member-search', (req, res) => {
    const { session } = ctx(req);
    const query = readField(session, req.body ?? {}, 'q');
    if (query.trim() === '') {
      html(res, views.searchForm(profile, session, `Enter a ${profile.memberNumberLabel.toLowerCase()} to search.`));
      return;
    }
    const results = consume(session, 'record-not-found') ? [] : searchMembers(query);
    html(res, views.searchResults(profile, results, query));
  });

  app.get('/content/member/:id', (req, res) => {
    const { session } = ctx(req);
    const member = findMember(req.params.id);
    if (!member) {
      html(res, views.searchResults(profile, [], req.params.id));
      return;
    }
    if (member.restricted || consume(session, 'permission-denied')) {
      html(res, views.permissionDenied(profile, member.memberNumber), 403);
      return;
    }
    html(res, views.memberDetail(profile, member, 'profile'));
  });

  app.get('/content/member/:id/accounts', (req, res) => {
    const { session } = ctx(req);
    const member = findMember(req.params.id);
    if (!member) {
      html(res, views.searchResults(profile, [], req.params.id));
      return;
    }
    if (member.restricted || consume(session, 'permission-denied')) {
      html(res, views.permissionDenied(profile, member.memberNumber), 403);
      return;
    }
    html(res, views.memberDetail(profile, member, 'accounts'));
  });

  app.get('/content/member/:id/new-subaccount', (req, res) => {
    const { session } = ctx(req);
    const member = findMember(req.params.id);
    if (!member) {
      html(res, views.searchResults(profile, [], req.params.id));
      return;
    }
    html(res, views.newSubAccountForm(profile, session, member, {}));
  });

  app.post('/content/member/:id/new-subaccount', (req, res) => {
    const { session } = ctx(req);
    const member = findMember(req.params.id);
    if (!member) {
      html(res, views.searchResults(profile, [], req.params.id));
      return;
    }
    const draft = {
      product: readField(session, req.body ?? {}, 'product'),
      nickname: readField(session, req.body ?? {}, 'nickname'),
      deposit: readField(session, req.body ?? {}, 'deposit'),
    };
    const error = validateDraft(draft, consume(session, 'validation-error'));
    if (error) {
      html(res, views.newSubAccountForm(profile, session, member, draft, error), 200);
      return;
    }
    const token = `dr-${Date.now().toString(36)}`;
    session.drafts.set(token, draft);
    html(res, views.subAccountReview(profile, member, draft, token));
  });

  app.post('/content/member/:id/new-subaccount/confirm', (req, res) => {
    const { session } = ctx(req);
    const member = findMember(req.params.id);
    const token = String(req.body?.token ?? '');
    const draft = session.drafts.get(token);
    if (!member || !draft) {
      html(res, views.serverError(profile), 500);
      return;
    }
    if (profile.extraAcknowledgement && req.body?.ack !== '1') {
      html(
        res,
        views.subAccountReview(profile, member, draft, token).replace(
          '<b>Review &#183; Open Sub-Account</b>',
          '<b>Review &#183; Open Sub-Account</b><br><font color="#990000">You must acknowledge the identity verification before posting.</font>',
        ),
      );
      return;
    }
    session.drafts.delete(token);
    const accountNumber = `${draft.product}-${member.memberNumber}`;
    html(res, views.subAccountConfirmed(profile, member, accountNumber));
  });

  return app;
}

function validateDraft(
  draft: Record<string, string>,
  forceFailure: boolean,
): string | undefined {
  if (forceFailure) {
    return 'Product SAV02 is not available for this membership tier.';
  }
  if (!draft.product) return 'Product Code is required.';
  if (!draft.nickname?.trim()) return 'Nickname is required.';
  const deposit = Number(String(draft.deposit ?? '').replace(/[$,]/g, ''));
  if (!Number.isFinite(deposit)) return 'Opening Deposit must be a number.';
  if (deposit < 25) return 'Opening Deposit must be at least $25.00.';
  return undefined;
}

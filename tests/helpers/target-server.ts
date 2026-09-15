import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTargetApp, type TargetAppOptions } from '../../src/target/app.js';

// Runs the demo app on a random port and keeps its session cookie between
// requests, the same way a browser would.

export interface TargetHarness {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly get: (path: string) => Promise<Response>;
  readonly post: (path: string, form: Record<string, string>) => Promise<Response>;
  /** The session cookie currently held, e.g. `mcsid_base=abc123`. */
  readonly cookie: () => string;
  /** Pulls a generated field name for `logical` out of a rendered page. */
  readonly fieldNameFrom: (body: string, logical: string) => string;
}

export async function startTarget(options: TargetAppOptions = {}): Promise<TargetHarness> {
  const server: Server = await new Promise((resolve) => {
    const s = createTargetApp(options).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = '';

  const remember = (res: Response): Response => {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? cookie;
    return res;
  };

  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    get: async (path) =>
      remember(await fetch(`${baseUrl}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })),
    post: async (path, form) =>
      remember(
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...(cookie ? { cookie } : {}),
          },
          body: new URLSearchParams(form).toString(),
          redirect: 'manual',
        }),
      ),
    cookie: () => cookie,
    fieldNameFrom: (body, logical) => {
      const match = body.match(new RegExp(`name="(ctl00\\$[0-9a-f]+\\$${logical})"`));
      if (!match?.[1]) throw new Error(`no field "${logical}" on page`);
      return match[1];
    },
  };
}

export async function signOn(t: TargetHarness): Promise<void> {
  const body = await (await t.get('/')).text();
  const res = await t.post('/login', {
    [t.fieldNameFrom(body, 'user')]: 'teller01',
    [t.fieldNameFrom(body, 'pass')]: 'demo-pass-01',
  });
  if (res.status !== 302) throw new Error(`sign on failed with ${res.status}`);
}

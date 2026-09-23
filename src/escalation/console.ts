import express, { type Express, type Request } from 'express';
import { supportsDirectControl, type DirectControl, type Surface } from '../surface/types.js';
import type { SessionControl } from './lease.js';
import type { InterventionQueue } from './queue.js';

// A deliberately plain operator console: a screenshot of the live page that
// refreshes, click and keyboard forwarding, and buttons to take control, hand
// back or abort. A proper co-browsing console is out of scope. What matters is
// that the person drives the same page the run was using, and that everything
// they do is recorded.

export interface OperatorConsoleOptions {
  readonly queue: InterventionQueue;
  readonly control: SessionControl;
  readonly surface: Surface;
  readonly operator?: string;
}

export function createOperatorConsole(options: OperatorConsoleOptions): Express {
  const { queue, control, surface } = options;
  const direct: DirectControl | undefined = supportsDirectControl(surface) ? surface : undefined;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const operatorOf = (req: Request): string =>
    String(req.body?.operator ?? options.operator ?? 'operator');
  const now = (): string => new Date().toISOString();
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  app.get('/', (_req, res) => {
    res.type('html').send(indexPage(queue.list().filter((r) => r.state !== 'resolved'), control.holder));
  });

  app.get('/api/interventions', (_req, res) => {
    res.json({ holder: control.holder, interventions: queue.list() });
  });

  app.get('/interventions/:id', (req, res) => {
    const record = queue.get(req.params.id);
    if (!record) {
      res.status(404).type('html').send('<p>No such intervention.</p>');
      return;
    }
    res.type('html').send(interventionPage(record, control.holder, direct !== undefined));
  });

  app.get('/interventions/:id/state', (req, res) => {
    const record = queue.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ state: record.state, holder: control.holder, actions: record.actions });
  });

  app.get('/interventions/:id/screen.png', (_req, res) => {
    surface
      .screenshot()
      .then((png) => res.type('png').set('cache-control', 'no-store').send(png))
      .catch((error: unknown) => res.status(503).json({ error: message(error) }));
  });

  app.post('/interventions/:id/take', (req, res) => {
    try {
      const record = queue.take(req.params.id, operatorOf(req));
      res.json({ state: record.state, holder: control.holder });
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  app.post('/interventions/:id/act', (req, res) => {
    void (async () => {
      if (!direct) {
        res.status(501).json({ error: "this surface can't be driven directly" });
        return;
      }
      try {
        control.assert('human');
        const kind = String(req.body?.kind ?? '');
        if (kind === 'click') {
          // Coordinates arrive normalised so the console can show the page at
          // any size.
          const { width, height } = await direct.viewport();
          const x = Math.round(Number(req.body?.x ?? 0) * width);
          const y = Math.round(Number(req.body?.y ?? 0) * height);
          await direct.clickAt(x, y);
          queue.record(req.params.id, { at: now(), kind: 'click', detail: `clicked at ${x},${y}` });
        } else if (kind === 'type') {
          const text = String(req.body?.text ?? '');
          await direct.typeText(text);
          // What they typed isn't recorded. Someone signing back in types a
          // password, and the log mustn't be where it ends up.
          queue.record(req.params.id, { at: now(), kind: 'type', detail: `typed ${text.length} character(s)` });
        } else if (kind === 'key') {
          const key = String(req.body?.key ?? '');
          await direct.pressKey(key);
          queue.record(req.params.id, { at: now(), kind: 'key', detail: `pressed ${key}` });
        } else if (kind === 'note') {
          queue.record(req.params.id, { at: now(), kind: 'note', detail: String(req.body?.text ?? '') });
        } else {
          res.status(400).json({ error: `unknown action "${kind}"` });
          return;
        }
        res.json({ ok: true, location: await surface.location() });
      } catch (error) {
        res.status(409).json({ error: message(error) });
      }
    })();
  });

  app.post('/interventions/:id/resume', (req, res) => {
    try {
      res.json(queue.resume(req.params.id, req.body?.note ? String(req.body.note) : undefined));
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  app.post('/interventions/:id/abort', (req, res) => {
    try {
      res.json(queue.abort(req.params.id, req.body?.note ? String(req.body.note) : undefined));
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  return app;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; color: #17202a; background: #f6f7f9; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .card { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .meta { color: #5b6673; font-size: 13px; }
  .meta b { color: #17202a; }
  .holder { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .agent { background: #e6f0ff; color: #1f4b99; }
  .human { background: #fff0d9; color: #8a5300; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #c6ccd4; background: #fff; cursor: pointer; }
  button.primary { background: #1f4b99; border-color: #1f4b99; color: #fff; }
  img { border: 1px solid #c6ccd4; max-width: 100%; cursor: crosshair; }
  pre { white-space: pre-wrap; background: #f2f4f6; padding: 10px; border-radius: 6px; font-size: 12px; }
  input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid #c6ccd4; border-radius: 6px; width: 320px; }
</style>`;

function indexPage(records: ReturnType<InterventionQueue['list']>, holder: string): string {
  const rows =
    records.length === 0
      ? '<p class="meta">Nothing waiting.</p>'
      : records
          .map(
            (r) => `<div class="card">
  <a href="/interventions/${esc(r.request.id)}"><b>${esc(r.request.capabilityName)}</b></a>
  <span class="meta">&middot; ${esc(r.request.stepId)} &middot; ${esc(r.request.reason)}</span>
  <div class="meta">${esc(r.request.stepIntent)}</div>
  <div class="meta">${esc(r.request.detail)}</div>
</div>`,
          )
          .join('\n');
  return `<html><head><title>Operator console</title>${STYLE}</head><body>
<h1>Waiting for a person <span class="holder ${holder}">${holder} has control</span></h1>
${rows}
<script>setTimeout(() => location.reload(), 3000);</script>
</body></html>`;
}

function interventionPage(
  record: NonNullable<ReturnType<InterventionQueue['get']>>,
  holder: string,
  canDrive: boolean,
): string {
  const r = record.request;
  return `<html><head><title>${esc(r.capabilityName)}</title>${STYLE}</head><body>
<h1>${esc(r.capabilityName)} <span class="holder ${holder}" id="holder">${holder} has control</span></h1>
<div class="card">
  <div class="meta"><b>Why it stopped</b> ${esc(r.reason)}: ${esc(r.detail)}</div>
  <div class="meta"><b>Step</b> ${esc(r.stepId)}: ${esc(r.stepIntent)}</div>
  <div class="meta"><b>Risk</b> ${esc(r.risk)} &nbsp; <b>Tenant</b> ${esc(r.tenantId)} &nbsp; <b>Run</b> ${esc(r.runId)}</div>
  <div class="meta"><b>Where</b> ${esc(r.location)}</div>
</div>
<div class="card">
  <button class="primary" id="take">Take control</button>
  <button id="resume">Hand back and carry on</button>
  <button id="abort">Stop the run</button>
  ${canDrive ? '' : '<span class="meta">This surface cannot be driven from here; record what you did as a note.</span>'}
</div>
<div class="card">
  <img id="screen" src="/interventions/${esc(r.id)}/screen.png" alt="live session">
  <p class="meta">Click the picture to click the page. Type below to type into it.</p>
  <p><input type="text" id="text" placeholder="text to type, or a note">
    <button id="send">Type it</button> <button id="enter">Press Enter</button> <button id="note">Save as note</button></p>
</div>
<div class="card"><b>What you've done</b><pre id="actions">${esc(JSON.stringify(record.actions, null, 2))}</pre></div>
<script>
const id = ${JSON.stringify(r.id)};
const img = document.getElementById('screen');
const post = (path, body) => fetch('/interventions/' + id + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((res) => res.json());
document.getElementById('take').onclick = () => post('/take').then(refresh);
document.getElementById('resume').onclick = () => post('/resume').then(() => (location.href = '/'));
document.getElementById('abort').onclick = () => post('/abort').then(() => (location.href = '/'));
document.getElementById('send').onclick = () => post('/act', { kind: 'type', text: text.value }).then(refresh);
document.getElementById('enter').onclick = () => post('/act', { kind: 'key', key: 'Enter' }).then(refresh);
document.getElementById('note').onclick = () => post('/act', { kind: 'note', text: text.value }).then(refresh);
img.onclick = (event) => {
  const box = img.getBoundingClientRect();
  post('/act', { kind: 'click', x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }).then(refresh);
};
function refresh() {
  img.src = '/interventions/' + id + '/screen.png?t=' + Date.now();
  fetch('/interventions/' + id + '/state').then((res) => res.json()).then((s) => {
    const badge = document.getElementById('holder');
    badge.textContent = s.holder + ' has control';
    badge.className = 'holder ' + s.holder;
    document.getElementById('actions').textContent = JSON.stringify(s.actions, null, 2);
  });
}
setInterval(refresh, 1500);
</script>
</body></html>`;
}

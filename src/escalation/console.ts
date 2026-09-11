import express, { type Express } from 'express';
import type { DirectControl, Surface } from '../surface/types.js';
import { supportsDirectControl } from '../surface/types.js';
import type { InterventionQueue } from './queue.js';
import type { SessionControl } from './lease.js';

/**
 * The operator surface.
 *
 * Deliberately plain: a screenshot that refreshes, click and keyboard
 * forwarding, and two buttons. The brief puts a real co-browsing console out of
 * scope and it is the right thing to cut, because the interesting part is not
 * the pixels — it is that the operator drives *the same live page* the
 * automation was using.
 *
 * That matters concretely. A fresh browser would lose the session cookie, the
 * frameset state and whatever half-completed form the run stopped on, so the
 * operator would be signing in again and re-finding the record before they
 * could help. Here they land exactly where the automation stopped, and when
 * they hand back, the run re-observes that same page and carries on.
 *
 * Every action they take is recorded against the intervention, so the handoff
 * is auditable rather than a gap in the trail.
 */

export interface OperatorConsoleOptions {
  readonly queue: InterventionQueue;
  readonly control: SessionControl;
  readonly surface: Surface;
  /** Name recorded against whatever the operator does. */
  readonly operator?: string;
}

export function createOperatorConsole(options: OperatorConsoleOptions): Express {
  const { queue, control, surface } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const direct: DirectControl | undefined = supportsDirectControl(surface) ? surface : undefined;

  const operatorOf = (req: express.Request): string =>
    String(req.body?.operator ?? req.query.operator ?? options.operator ?? 'operator');

  app.get('/', (_req, res) => {
    const open = queue.list().filter((r) => r.state !== 'resolved');
    res.type('html').send(renderIndex(open, control.holder));
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
    res.type('html').send(renderIntervention(record, control.holder, direct !== undefined));
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
      .then((buffer) => res.type('png').set('cache-control', 'no-store').send(buffer))
      .catch((error: unknown) =>
        res.status(503).json({ error: error instanceof Error ? error.message : String(error) }),
      );
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
        res.status(501).json({ error: 'this surface cannot be driven directly by a person' });
        return;
      }
      try {
        control.assert('human');
        const kind = String(req.body?.kind ?? '');
        if (kind === 'click') {
          const { width, height } = await direct.viewport();
          // The console sends normalised coordinates so its view can be scaled
          // to any size without the two sides disagreeing about pixels.
          const x = Math.round(Number(req.body?.x ?? 0) * width);
          const y = Math.round(Number(req.body?.y ?? 0) * height);
          await direct.clickAt(x, y);
          queue.record(req.params.id, { at: now(), kind: 'click', detail: `clicked at ${x},${y}` });
        } else if (kind === 'type') {
          const text = String(req.body?.text ?? '');
          await direct.typeText(text);
          // The text itself is not recorded: an operator signing back in types
          // a credential, and the audit trail must not become the place it
          // ends up. What they did is recorded; what they typed is not.
          queue.record(req.params.id, {
            at: now(),
            kind: 'type',
            detail: `typed ${text.length} character(s)`,
          });
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

function now(): string {
  return new Date().toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; color: #17202a; background: #f6f7f9; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .card { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .meta { color: #5b6673; font-size: 13px; }
  .meta b { color: #17202a; font-weight: 600; }
  .holder { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .agent { background: #e6f0ff; color: #1f4b99; }
  .human { background: #fff0d9; color: #8a5300; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #c6ccd4; background: #fff; cursor: pointer; }
  button.primary { background: #1f4b99; border-color: #1f4b99; color: #fff; }
  img { border: 1px solid #c6ccd4; max-width: 100%; cursor: crosshair; background: #fff; }
  pre { white-space: pre-wrap; background: #f2f4f6; padding: 10px; border-radius: 6px; font-size: 12px; }
  input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid #c6ccd4; border-radius: 6px; width: 320px; }
  a { color: #1f4b99; }
</style>`;

function renderIndex(
  records: ReturnType<InterventionQueue['list']>,
  holder: string,
): string {
  const rows =
    records.length === 0
      ? '<p class="meta">No open interventions.</p>'
      : records
          .map(
            (r) => `<div class="card">
    <div><a href="/interventions/${esc(r.request.id)}"><b>${esc(r.request.capabilityName)}</b></a>
      &middot; step ${esc(r.request.stepId)} &middot; <span class="meta">${esc(r.request.reason)}</span></div>
    <div class="meta">${esc(r.request.stepIntent)}</div>
    <div class="meta">${esc(r.request.detail)}</div>
  </div>`,
          )
          .join('\n');
  return `<html><head><title>Operator console</title>${STYLE}</head><body>
<h1>Interventions <span class="holder ${holder}">${holder} has control</span></h1>
${rows}
<script>setTimeout(() => location.reload(), 3000);</script>
</body></html>`;
}

function renderIntervention(
  record: NonNullable<ReturnType<InterventionQueue['get']>>,
  holder: string,
  canDrive: boolean,
): string {
  const r = record.request;
  return `<html><head><title>${esc(r.capabilityName)} &middot; ${esc(r.stepId)}</title>${STYLE}</head><body>
<h1>${esc(r.capabilityName)} <span class="holder ${holder}" id="holder">${holder} has control</span></h1>
<div class="card">
  <div class="meta"><b>Why it stopped</b> ${esc(r.reason)} &mdash; ${esc(r.detail)}</div>
  <div class="meta"><b>Step</b> ${esc(r.stepId)} &mdash; ${esc(r.stepIntent)}</div>
  <div class="meta"><b>Risk</b> ${esc(r.risk)} &nbsp; <b>Tenant</b> ${esc(r.tenantId)} &nbsp; <b>Run</b> ${esc(r.runId)}</div>
  <div class="meta"><b>Where</b> ${esc(r.location)}</div>
</div>
<div class="card">
  <button class="primary" id="take">Take control</button>
  <button id="resume">Hand back and resume</button>
  <button id="abort">Abort the run</button>
  ${canDrive ? '' : '<span class="meta">This surface cannot be driven directly; use the notes field to record what you did.</span>'}
</div>
<div class="card">
  <img id="screen" src="/interventions/${esc(r.id)}/screen.png" alt="live session">
  <p class="meta">Click the image to click the live page. Type below and press Send to type into it.</p>
  <p>
    <input type="text" id="text" placeholder="text to type, or a note">
    <button id="send">Send text</button>
    <button id="enter">Press Enter</button>
    <button id="note">Record as note</button>
  </p>
</div>
<div class="card"><b>Recorded actions</b><pre id="actions">${esc(JSON.stringify(record.actions, null, 2))}</pre></div>
<script>
const id = ${JSON.stringify(r.id)};
const img = document.getElementById('screen');
const post = (path, body) => fetch('/interventions/' + id + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

document.getElementById('take').onclick = () => post('/take', {}).then(refresh);
document.getElementById('resume').onclick = () => post('/resume', {}).then(() => location.href = '/');
document.getElementById('abort').onclick = () => post('/abort', {}).then(() => location.href = '/');
document.getElementById('send').onclick = () => post('/act', { kind: 'type', text: text.value }).then(refresh);
document.getElementById('enter').onclick = () => post('/act', { kind: 'key', key: 'Enter' }).then(refresh);
document.getElementById('note').onclick = () => post('/act', { kind: 'note', text: text.value }).then(refresh);

img.onclick = (event) => {
  const box = img.getBoundingClientRect();
  post('/act', {
    kind: 'click',
    x: (event.clientX - box.left) / box.width,
    y: (event.clientY - box.top) / box.height,
  }).then(refresh);
};

function refresh() {
  img.src = '/interventions/' + id + '/screen.png?t=' + Date.now();
  fetch('/interventions/' + id + '/state').then((r) => r.json()).then((s) => {
    document.getElementById('holder').textContent = s.holder + ' has control';
    document.getElementById('holder').className = 'holder ' + s.holder;
    document.getElementById('actions').textContent = JSON.stringify(s.actions, null, 2);
  });
}
setInterval(refresh, 1500);
</script>
</body></html>`;
}

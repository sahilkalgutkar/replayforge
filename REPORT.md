# Design report

replayforge turns one model-driven run through a legacy web app into a typed,
versioned capability, and then replays that capability without a model. The
target is a demo credit-union back office I built to be awkward on purpose:
framesets, table layouts, labels in the cell next to their field, and form
field names that change every session. The evidence for everything below is in
[`evidence/`](evidence/README.md).

## 1. Architecture

```
            discovery (once)                         replay (every call)
  goal ─▶ model ◀─▶ Surface ─▶ trace ─▶ synthesis ─▶ artifact ─▶ Replayer ─▶ Surface
                                                        │            │
                                             store (versioned)   PolicyEngine, RunRecorder,
                                                        │        EscalationPort
                                         catalog ─▶ tool definitions for an agent
```

The seam everything hangs on is `Surface`. It can observe a screen as a flat
list of `UiNode`s (role, name, value, nearby text, table position, frame path),
perform a primitive action, and screenshot. The only implementation is
Playwright, but discovery, replay, policy and the handoff all talk to the
interface. Target resolution (`resolve.ts`) is shared by discovery and replay,
so what the model pointed at and what replay finds use the same rules.

Discovery runs a local model (qwen3:14b through Ollama). Each turn it gets the
goal, the steps taken so far, the result of the last action and the current
screen rendered as text, and it answers with exactly one decision. When it
declares the goal met, synthesis turns the trace into steps: a primary target
plus fallbacks, a checkpoint that proves the step worked, a risk level, and a
screen fingerprint.

Replay (`replay/engine.ts`) walks those steps with no model anywhere in it.

The catalog exposes each capability as a tool definition, with a JSON schema
built from the contract. An agent calling `member_savings_balance` gets back
either typed outputs or a named outcome.

Two things I measured changed the design. qwen3's native tool calling through
Ollama lost 3 of 8 calls in a trial run: the reply came back as text with no
call in it. Constraining the reply with a JSON schema through Ollama's `format`
option made that 8 of 8, so discovery uses constrained output rather than
tools. I also send a compact state each turn (steps so far, the last result,
the current screen) rather than a growing chat history, which keeps every
prompt inside an 8k context. Early runs had the model retype the user id over
and over because it couldn't tell the field was already filled. Showing it its
own placeholder in the field, saying plainly what the last action did, and
refusing a fourth identical action fixed that. The recorded run takes 11 turns,
about two and a half minutes on a laptop.

## 2. Artifact schema

An artifact (`artifact/schema.ts`, zod) is a contract plus a flow. The contract
is the caller's view of it:

- **`inputs`** each have a type, a sensitivity and an optional pattern.
- **`outputs`** are typed and read off the final screens.
- **`secrets`** are references to environment variables, never values.
- **`outcomes`** are named business results with a disposition. `answer` means
  "member not found" is a legitimate reply. `needs_human` means stop and ask.

The flow is `steps`. Each one has:

- **an action**, with values as `{param}`, `{secret}` or literals;
- **a target**, a primary spec plus fallbacks;
- **a checkpoint**;
- **guards**, retries and a timeout;
- **a risk level**;
- **`expectedFingerprint` and `expectedControls`** for drift detection.

Around the flow sit a few more fields:

- **`policy`**: allowed origins, routes and actions, a step and time budget,
  and the highest risk allowed without approval.
- **`approval`**: draft, approved or revoked.
- **`tenantOverrides`**: per-tenant patches.
- **`provenance`**: the model, prompt version and discovery run id.
- **`stability`**: counters.

Targets never mention DOM ids or field names, because those are scrambled per
session. A spec says things like "a textbox in the table row whose text is
`Member Number`, column 1, in `mainFrame`". Anything that varies per run, like
the member number or the host, is a `{{placeholder}}`. That includes the text
a checkpoint expects to see.

Versions are immutable. `approve` writes v2 rather than editing v1, so a
replay log always points at exactly what ran. The saved artifact from the
evidence run is [`evidence/capability.json`](evidence/capability.json).

## 3. Determinism & error handling

Replay has four statuses:

- **`success`**: typed outputs.
- **`business_outcome`**: a named outcome that matched, with its disposition.
- **`escalated`**: a person was asked, and didn't hand it back.
- **`failed`**: one of ten categories, such as `input_invalid`,
  `target_ambiguous`, `checkpoint_failed`, `policy_blocked`, `step_timeout` or
  `budget_exceeded`.

The rules that keep it deterministic:

- **Ambiguity fails; it never guesses.** If a spec matches two controls, the
  step fails as `target_ambiguous` rather than clicking the first one. The
  rung that did match (primary or which fallback) is logged, so a run that
  only worked through a fallback is visible.
- **Every step proves itself.** The checkpoint is checked after the action. A
  step that clicked something and landed on the wrong screen fails there, not
  three steps later when an output is missing.
- **Outcomes are checked on every screen.** "No
  records found for 88888" ends the run as an answer (evidence 03) instead of
  becoming a missing-target failure.
- **Drift is reported, not acted on.** The screen's fingerprint is compared
  before the action. A changed screen that still resolves gets logged as
  `drift.detected`, which is what you'd want to watch after an upgrade.
- **Retries are capped.** A step gets a fixed number of attempts with a
  backoff, set per step (one retry by default), and every retry is logged. The
  catalog tells a calling agent that only `step_timeout` and `surface_error`
  are worth retrying.
- **Inputs are validated against the contract before the browser opens**
  (evidence 05).

Discovery had to make outcomes deterministic too. The model only ever sees the
happy path, so after it finishes, discovery replays the new flow with a probe
value (member 99999). It lets the model name the screen it lands on, and keeps
the outcome only if the phrase it picked is actually on that screen. Then it
parameterises the phrase, so "No records found for "{{memberNumber}}"."
matches any member.

Every flow also gets an `HTTP_ERROR` outcome (401, 403 or 5xx, `needs_human`),
checked last. That's how an expired session escalates instead of failing
somewhere odd (evidence 04). Its limit: an app that answers 200 with an error
page gets past it and fails on the next checkpoint instead. That's still a
stop, just with a less useful name.

## 4. Heterogeneity & multi-tenant

Artifacts are keyed on the product (`meridian-core`), not the tenant, because
the realistic case is one vendor product installed at many credit unions with
local configuration.

The demo app has a second tenant, Northbay, which renames "Member Search" to
"Customer Search", relabels the field "Customer ID" and reorders the menu.
Replaying the base capability there degrades rather than breaking
(`tests/catalog/cross-tenant.test.ts`):

- the menu fallback ("a link in the nav frame containing Search") absorbs the
  rename;
- the renamed field fails the step's checkpoint with a message naming the
  field it expected.

A tenant override then patches two steps. The contract (inputs, outputs,
outcomes, policy) isn't patchable, so a caller sees one capability on every
tenant. The override records which steps it patched, inserted or skipped, and
that goes into the run log.

Nothing in the core knows it's driving a browser. The seams for other kinds of
app are `Surface` and `UiNode`: a desktop adapter would map an accessibility
tree to the same nodes, and the artifact, replay, policy and escalation code
wouldn't change. I didn't build one; see Cuts.

## 5. Escalation & handoff

When a run needs a person, the replayer raises a request through an
`EscalationPort`. That happens for a `needs_human` outcome, for a step whose
risk is above what an unapproved artifact may do, or for a failed step marked
`escalate`. The request carries:

- the step and the reason;
- a screenshot;
- the redacted inputs;
- the steps done so far.

The part I cared about is that the person takes over **the same live session**,
not a fresh one. `SessionControl` is a lease on the browser: while an
intervention is open, the replayer holds no lease, and any action it tries
throws. `LeasedSurface` wraps the surface to enforce that. The operator takes
the request, which gives them the lease, and drives the page from the console.
The console serves a live screenshot and relays clicks at normalised
coordinates, typed text and keys. Typed text is sent through but not
recorded.

Handing back returns the lease, and the run carries on from the step that
stopped. Everything the person did is logged with their name.

Handing back also counts as approval for that step. On a draft capability, the
first step that types stops and asks (evidence 06). The log shows
`escalation.raised`, `escalation.resolved` and `approval.granted_by_operator`,
and the run then finishes in the same session. If the person aborts instead,
the run ends as `escalated`. With nobody attached, the default port answers
"unavailable" straight away and the run ends as `escalated` with the request
id, which is what evidence 04 shows.

Try it with `npm run cli -- replay ... --operator`, which prints the console URL.

## 6. Safety

- **Allowlist.** Origins are matched exactly, and routes against the patterns
  recorded during discovery. Following a link counts as navigation, so a link
  to another origin is blocked before the click.
- **Risk comes from the live control, not just the artifact.** The policy
  engine re-derives risk from what's on screen at replay time, such as a
  button labelled "Transfer" or "Close account", and the stricter of that and
  the recorded risk wins. An artifact that says a step is safe can't
  launder a step that now looks irreversible.
- **Approval.** A draft artifact can run steps up to `maxRiskWithoutApproval`,
  and only with a person approving the rest. Approving writes a new version
  with the approver recorded. A revoked artifact won't run.
- **Budgets.** Step count and wall-clock limits end a run that's wandering.
- **Secrets.** These are environment references, resolved at the last moment
  and never written to the artifact. Redaction happens at egress, in the
  recorder, the escalation request and the catalog result, not by trusting
  every caller to remember. Secret values are replaced wherever they appear,
  then anything shaped like an SSN, email, card or account number is masked. The password is typed in every
  evidence run and appears in none of the files.

The limits I know about:

- **Screenshots aren't redacted.** The browser masks the password field, but
  the user id is visible in them, and so would anything else on screen.
- **Pattern-based masking is a heuristic.** A card number formatted in an
  unusual way would get through.
- **Discovery sends screen text to the model.** That's fine for a local model.
  A hosted one would need the same redaction applied to what goes out.

## 7. Cuts

- **Desktop adapter.** The `Surface` seam is there, but a second
  implementation would have taken a week on its own.
- **A proper operator console.** Mine is a server-rendered page with a polling
  screenshot. It has no auth, no streaming, no multi-operator queue and no
  audit UI.
- **Scaling infrastructure.** Everything is one process: file store, in-memory
  queue, one browser per run. A real deployment needs a shared store, a
  durable queue, a browser pool and per-tenant isolation.
- **Model-assisted fallback at replay time.** When every rung fails, replay
  stops rather than asking a model to find the control. I think it should
  stay that way by default, but an opt-in "propose a patch for review" mode
  would be useful.
- **Stability scoring.** The counters exist, but nothing uses them yet to flag
  a capability that increasingly relies on fallbacks.
- **A second capability.** The catalog handles several; the evidence only has
  one.

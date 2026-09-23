# replayforge

Take-home project: a computer-use automation system for back-office apps that
don't have an API. The idea is to let an LLM work out a task in the UI once,
save what it did as a structured artifact, and then replay that artifact
deterministically without the model.

The design write-up is in [REPORT.md](REPORT.md), and a recorded set of runs,
including the model's discovery run and a few failures, is in
[evidence/](evidence/README.md).

## Trying it

You need Node 22+ and [Ollama](https://ollama.com) with `qwen3:14b` pulled
(only discovery uses it).

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run target
```

Leave that running, and in another terminal, record the capability. The
model works out the flow, which takes a couple of minutes, and saves it under
`capabilities/`:

```bash
npm run cli -- discover --target http://localhost:4310 \
  --capability meridian-core.member_savings_balance --name member_savings_balance \
  --goal "Look up member 10021 and read their Regular Savings balance and account number." \
  --input memberNumber=10021 --probe memberNumber=99999
```

It's saved as a draft, and a draft won't type into anything unattended. Run it
with a person attached instead:

```bash
npm run cli -- replay member_savings_balance --target http://localhost:4310 --input memberNumber=10021 --operator
```

That prints a console URL. Open it, take the request, look around the page if
you like, and hand it back. The run finishes in the same browser session.

Then approve it, which saves v2, and it runs on its own, with no model:

```bash
npm run cli -- approve member_savings_balance --by your-name
npm run cli -- replay member_savings_balance --target http://localhost:4310 --input memberNumber=10022
npm run cli -- replay member_savings_balance --target http://localhost:4310 --input memberNumber=88888
```

The first returns a balance; the second returns `MEMBER_NOT_FOUND`, which is
an answer, not an error. To see it from an agent's side:

```bash
npm run cli -- capabilities --tools
npm run cli -- call member_savings_balance --target http://localhost:4310 --input memberNumber=10021
```

To see a failure, inject one before a replay:

```bash
curl -X POST http://localhost:4310/_test/inject -d mode=session-timeout -d scope=global
```

That run stops on the expired session and asks for a person rather than
carrying on. Runs are logged under `runs/`.

## Status

- [x] Demo target app
- [x] Perception and element targeting
- [x] Artifact schema
- [x] Guardrails and replay engine
- [x] Discovery agent
- [x] Human handoff, CLI and write-up

## Demo app

I don't have access to a real banking system, so I built a small local one to
test against. It's deliberately awkward in the same ways old internal tools
are: framesets, table layouts, labels sitting in the next table cell instead of
a `<label>`, and no test IDs. Form field names are also generated per session,
so anything that finds fields by `name` or `id` breaks the next time you sign
in.

It runs two tenants from the same code with different configuration
("Member Number" vs "Customer ID", a different menu order, an extra
confirmation step), to stand in for two institutions on the same vendor
product.

### Running it

```bash
npm install
npm run target
```

- Base tenant: http://localhost:4310
- Northbay tenant: http://localhost:4311

Sign in with `teller01` / `demo-pass-01`. To change the ports, copy
`.env.example` to `.env` and edit it.

### Injecting faults

The app can be told to fail in specific ways, which I'll need later for testing
error handling:

```bash
curl -X POST http://localhost:4310/_test/inject -d mode=session-timeout -d scope=global
```

Modes: `session-timeout`, `record-not-found`, `validation-error`,
`permission-denied`, `interstitial`, `slow`, `server-error`. A fault fires once
unless you pass `count`. Without `scope=global` it only applies to the session
that made the request, which is what the tests use.

## Looking at a screen

Nothing above `src/surface` knows about the DOM. A screen becomes a flat list of
nodes with a role, a name, a value and, where it applies, the row and column of
the table cell it sits in. That shape exists in the browser's accessibility tree
and in the macOS and Windows accessibility APIs too, so a flow recorded against
one kind of application isn't automatically stuck there.

The awkward part is naming. Plenty of inputs in the demo app have no id, no
label and no ARIA, so the extractor works out a name from the cell next to the
control, or the column header above it. That's what makes "the field labelled
Member Number" a thing you can point at.

Finding a control again goes through one shared resolver, with two rules I
wanted from the start:

- If a target matches more than one control and the flow didn't say which, that's
  a failure, not a guess. Quietly taking the first match is how you click the
  wrong row in a grid and still report success.
- A target can carry fallbacks, and the result says which one matched. A step
  that starts winning on a fallback is the first sign the screen has changed.

## Capability artifacts

A recorded flow is a contract, not a macro. Inputs, outputs, outcomes, risk and
approval state are declared separately from the steps, so whatever calls it can
decide whether to call it without reading the flow, and a person can review it
the same way.

The part I care most about is that expected results are declared rather than
inferred. "No such member" is an answer the caller asked for, so it's an entry
in `outcomes` with its own detection rule, not an exception thrown from step
seven. Conditions a replay is allowed to shrug off are separate again, as capped
guards on the steps that can meet them.

Artifacts are keyed on the product rather than the institution, since plenty of
credit unions run the same vendor software. A tenant can patch a control, a
literal or a checkpoint, and cannot touch the contract.

Saving always writes a new version. Editing the file someone approved isn't a
storage detail.

## Discovery

Discovery is the only part that uses a model, and it runs locally through
[Ollama](https://ollama.com) with `qwen3:14b`, so nothing leaves the machine.
That seemed like the right default for something pointed at banking screens.

```bash
ollama pull qwen3:14b
```

The model never writes a selector. It gets the screen as a numbered list of
controls and picks one by number; synthesis then works out how to find that
control again, tests each candidate against the screen it came from, and keeps
the ones that match exactly one control. It also works out a check for each
step, the risk, and which routes the flow is allowed to visit.

A few things I ran into getting this working on a local model:

- **Tool calling was unreliable.** Ollama's tool-call parser silently dropped
  3 of 8 calls from qwen3:14b in testing, returning neither text nor a call. I
  constrain the reply to a JSON schema of the tools instead, which gave a usable
  decision 8 times out of 8.
- **The whole conversation doesn't fit.** Each turn sends the goal, a short
  list of steps taken, the last result and the current screen, so the goal
  never falls out of a small context window.
- **It got stuck retyping the user id.** The model typed the placeholder
  `{{core_username}}`, then saw the field redacted as something else and typed
  it again, twenty times. Filled credentials now show the placeholder it typed,
  and a model that repeats the same step is told so and then stopped.
- **A happy-path run never sees a failure screen**, so the model can't know how
  "no such member" looks. After it finishes, the draft gets replayed with a
  value that shouldn't exist, and the model names the screen the app actually
  shows. Detection text is only kept if it's on that screen. Every flow also
  gets a catch-all for HTTP error statuses, which covers access denied, expired
  sessions and error pages in the demo app; apps that answer 200 with an error
  page need that wording added by whoever reviews the flow.

A full run takes about two and a half minutes on an M1 Pro.

## Replaying a capability

Replay doesn't involve a model at all. Every branch a run can take was declared
in the artifact, so the same inputs give the same steps, and when something goes
wrong you can point at a line in the file rather than a transcript.

A run ends in one of four ways, and I kept them separate on purpose:

- **success**, with typed outputs;
- **business outcome**, a declared result like `MEMBER_NOT_FOUND` that is an
  answer rather than an error;
- **escalated**, meaning a person has it or needs to;
- **failed**, with the step, what was expected, what was on screen, and a
  screenshot.

Merging any two of those makes the caller behave badly. Treat "no such member"
as a failure and it retries a lookup that can't succeed; treat an escalation as
a failure and it retries something a person is already looking at.

Arguments and credentials are checked before the browser is touched. Failing
there costs nothing; failing four screens into a banking console leaves a
half-finished flow for someone to clean up.

## Guardrails

Discovery and replay both go through one policy engine, so the two can't drift
apart. It checks an allowlist of origins, routes and action types (origins match
exactly; suffix matching lets `evilbank.com` through a check for `bank.com`), and
it classifies each action as safe, sensitive or irreversible.

Risk is worked out again at replay from what the live control says, and the
stricter answer wins. If a button that said "Continue" when the flow was
recorded now says "Post Account", that gets caught. Irreversible steps are
blocked rather than just flagged, because in this setting one mistake is an
unintended funds movement. A capability still in draft can read but can't write
without someone confirming.

Anything written to a log or sent anywhere is redacted first: known secret
values by name, then anything shaped like an SSN, email, card or account number.
Screenshots can't be redacted that way, so they're only taken on failure by
default.

## Handing a run to a person

When a run needs a person, it stops and raises a request instead of failing.
That happens on a `needs_human` outcome like an expired session, on a step
riskier than an unapproved capability may take, or on a step marked to
escalate. The person picks it up in a small console and takes over **the same
browser session**, so they see exactly what the run saw and don't have to sign
in and navigate back. While they have it, the run holds no lease on the page
and can't act. When they hand it back, the run carries on from where it
stopped. Anything they did is logged under their name; text they type is sent
to the page but not written down. Handing back also counts as approving that
step.

The console is basic: a refreshing screenshot you can click on, a box to type
into, and take/resume/abort buttons. It's enough to show the handoff works, not
something I'd give to an operations team.

## Calling it from an agent

The catalog lists capabilities as tool definitions, each with a JSON schema for
its inputs, and runs them by name. An agent gets back typed outputs, a named
outcome, or an error saying whether a retry is worth it. It never sees the
steps or the secrets.

## Tests

```bash
npm test
```

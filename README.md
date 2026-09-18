# replayforge

Take-home project: a computer-use automation system for back-office apps that
don't have an API. The idea is to let an LLM work out a task in the UI once,
save what it did as a structured artifact, and then replay that artifact
deterministically without the model.

Work in progress.

## Status

- [x] Demo target app
- [x] Perception and element targeting
- [x] Artifact schema
- [x] Guardrails and replay engine
- [ ] Discovery agent
- [ ] Human handoff, CLI and write-up

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

## Tests

```bash
npm test
```

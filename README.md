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
- [ ] Guardrails and replay engine
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

## Tests

```bash
npm test
```

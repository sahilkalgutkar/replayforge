# replayforge

Take-home project: a computer-use automation system for back-office apps that
don't have an API. The idea is to let an LLM work out a task in the UI once,
save what it did as a structured artifact, and then replay that artifact
deterministically without the model.

Work in progress.

## Status

- [x] Demo target app
- [ ] Perception and element targeting
- [ ] Artifact schema
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

## Tests

```bash
npm test
```

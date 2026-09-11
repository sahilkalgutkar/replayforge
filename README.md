# replayforge

A take-home project: a computer-use automation system for back-office
applications that have no API.

The question it answers is how you let an AI agent operate such an application
*reliably*, rather than paying a model to re-reason about the same screens
forever. The approach here is record-once, replay-many. A model drives the real
UI to work out how a task is done. That successful run becomes a typed,
versioned **capability artifact** — a contract an agent can call by name with
typed arguments. From then on the capability replays deterministically with no
model in the decision loop, and when it cannot safely finish, it hands the live
session to a person and takes it back.

The through-line, and the shape of the code:

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how the agent invokes it in production.

The design decisions and their trade-offs are in **[REPORT.md](REPORT.md)**.
Recorded runs are in **[evidence/](evidence/)**, which also states which model
drove the discovery run and how.

## The target application

I did not point this at a public demo site. A demo site cannot be made to fail
on command, and it cannot be cloned into a second tenant — which would have made
the error taxonomy and the multi-tenant story hypothetical, and those are the
two parts most worth getting right.

So the target is a local back-office console I wrote to be genuinely hostile, in
the way the brief describes real ones:

- framesets, nested table layout, `<font>` tags, no ARIA, no test ids;
- most labels in an adjacent `<td>` rather than a `<label for>`, so several
  inputs have **no accessible name at all**;
- form field names derived from a per-session salt (`ctl00$9976893f$user`), the
  way a WebForms-era app emits generated control ids — **so any artifact that
  recorded a `name` or `id` selector is dead on the next sign-on.**

That last one is deliberate. It means semantic targeting is not rewarded here,
it is required.

The app also serves a second tenant, `northbay`: the same code with a different
configuration — "Customer ID" instead of "Member Number", a reordered menu, an
extra acknowledgement before posting. That is the stand-in for two institutions
running one vendor product.

## Setup

```bash
git clone https://github.com/sahilkalgutkar/replayforge.git
cd replayforge
npm install
npx playwright install chromium
cp .env.example .env
```

Then put an Anthropic API key in `.env`. It is needed **only** for the discovery
run; replay never reads it.

| Variable | What it is | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Model access for discovery. | *(required to record)* |
| `REPLAYFORGE_MODEL` | Model id used for discovery. | `claude-opus-5` |
| `MERIDIAN_USERNAME` / `MERIDIAN_PASSWORD` | Fake credentials for the demo app. Resolved at replay time through `secretRef`, never written into an artifact or a log. | `teller01` / `demo-pass-01` |
| `TARGET_HOST_PORT` | Base tenant. | `4310` |
| `TARGET_VARIANT_HOST_PORT` | `northbay` tenant. | `4311` |
| `OPERATOR_HOST_PORT` | Operator console. | `4320` |

Every published port is overridable, so a machine already using one of them can
still follow this README.

## Demo path

Start the demo application (both tenants) and leave it running:

```bash
npm run target
```

### 1. Record a capability with a model

```bash
npm run cli -- discover \
  --goal "Look up member 10021 and read their current Regular Savings balance and account number." \
  --target http://localhost:4310 \
  --capability meridian-core.member_savings_balance \
  --name member_savings_balance \
  --input memberNumber=10021
```

This is the only command that calls a model. It signs on, navigates, searches,
opens the record and reads the grid, then writes a capability into
`capabilities/` and a full evidence trail into `evidence/`.

If you would rather answer the turns yourself than spend a key — which is how
the committed evidence was recorded, and the quickest way to see what the model
is actually shown when a run goes wrong — point it at a directory instead:

```bash
REPLAYFORGE_MODEL_BRIDGE=/tmp/bridge npx tsx scripts/record-evidence.ts
```

Each turn writes `turn-N.screen.txt` there and waits for you to write
`turn-N.decision.json`. See `scripts/bridge-model-client.ts` and
[evidence/README.md](evidence/README.md).

### 2. Replay it deterministically, for a different member

```bash
npm run cli -- replay member_savings_balance \
  --target http://localhost:4310 \
  --input memberNumber=10022 \
  --confirm-risky
```

No model is involved. A fresh browser session means every form field name in the
app is scrambled differently from the ones the recording saw, which is the point.

`--confirm-risky` is needed because a freshly recorded capability is a **draft**,
and a draft may read but may not type into a live banking screen unattended.
Approve it and the flag is no longer needed:

```bash
npm run cli -- approve member_savings_balance --by you@example.com
```

### 3. See a business outcome, which is not a failure

```bash
npm run cli -- replay member_savings_balance \
  --target http://localhost:4310 --input memberNumber=99999
```

Returns `MEMBER_NOT_FOUND` with disposition `answer`. The caller asked a
question; this is the reply.

### 4. Invoke it the way an agent would

```bash
npm run cli -- capabilities --tools     # the tool definitions a model sees
npm run cli -- call member_savings_balance \
  --target http://localhost:4310 --input memberNumber=10021
```

`call` prints only the agent-facing JSON result: the outputs, or the outcome, or
an error that says whether retrying is worth it.

### 5. Hand a stuck run to a person

```bash
npm run cli -- replay member_savings_balance \
  --target http://localhost:4310 --input memberNumber=10021 --operator
```

Without `--confirm-risky`, the draft stops at its first writing step and waits.
Open <http://localhost:4320>, click into the intervention, take control, and you
are driving **the same live browser session** the run was using — same cookie,
same frameset, same half-finished screen. Hand it back and the run continues.

### 6. Make it fail on purpose

The demo app arms faults out of band, so an injected condition never appears in
a URL the agent could have recorded:

```bash
curl -X POST http://localhost:4310/_test/inject -d mode=session-timeout
curl -X POST http://localhost:4310/_test/inject -d mode=record-not-found
curl -X POST http://localhost:4310/_test/inject -d mode=permission-denied
curl -X POST http://localhost:4310/_test/inject -d mode=server-error
curl -X POST http://localhost:4310/_test/inject -d mode=interstitial
```

`interstitial` is absorbed by a bounded guard and the run completes.
`record-not-found` returns a business outcome. The rest escalate.

### Running without live services

Everything except discovery runs offline. The test suite starts its own copies
of the demo app on ephemeral ports and needs no key:

```bash
npm test
npm run coverage
```

One module is excluded from the coverage report with its reason stated in
`vitest.config.ts`: the DOM extractor is stringified into the page and executes
in the browser, so Node's coverage provider cannot instrument it. It is verified
instead by `tests/surface/extraction-naming.test.ts`, which asserts every naming
and inference path it implements through `observe()`.

## What is where

| Path | What it holds |
| --- | --- |
| `src/surface/` | The seam. `UiNode`, `TargetSpec`, `Primitive` — and the shared resolver that turns a recorded target into exactly one control. |
| `src/surface/browser/` | The only code that knows about Playwright, frames and the DOM. |
| `src/artifact/` | The capability schema, referential validation, the versioned store, tenant overrides. |
| `src/agent/` | The discovery loop, the prompt, and the synthesis that derives durable targeting from what the model picked. |
| `src/replay/` | The production execution path and its result contract. |
| `src/policy/` | Allowlist, risk classification, redaction. One choke point, used by both paths. |
| `src/escalation/` | The control lease and the operator console. |
| `src/catalog/` | Saved capabilities as callable tools for an agent. |
| `src/target/` | The hostile demo application and its second tenant. |

## Tests

340 tests. The integration tests drive a real Chromium against real
instances of the demo app; the only thing ever mocked is the model, and only so
the discovery loop can be verified deterministically instead of paid for twice.

The test I would point at first is in `tests/agent/discovery.test.ts`: it runs
discovery for one member, then replays the artifact it produced for a
*different* member in a *fresh* browser, and checks that every step still
resolved on its primary target.

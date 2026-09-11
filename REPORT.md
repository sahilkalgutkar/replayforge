# Design write-up

## 1. Architecture

```
  goal ──▶ discovery loop ──▶ capability artifact ──▶ replay engine ──▶ result
             (model)            (typed contract)        (no model)
                │                      │                     │
                └──────── policy engine, redaction ──────────┘
                                       │
                             escalation port ──▶ operator console
                                                  (same live session)
```

**The load-bearing decision is the surface seam.** Everything above
`src/surface/types.ts` speaks three vocabularies only: `UiNode` (role,
accessible name, value, inferred label, table coordinates, frame path),
`TargetSpec` (how to find a control again) and `Primitive` (click, fill, select,
press, navigate). No layer above it can name a CSS selector, a window handle or
a pixel, because none of those appear in that vocabulary.

A `Surface` has exactly two jobs: flatten what it perceives into `UiNode[]`, and
execute a `Primitive` against a node it emitted. Interpreting a recorded target
is deliberately *not* one of them — that lives in `resolve.ts` and is shared, so
a browser adapter and a desktop adapter cannot drift in how they read the same
artifact.

**The second decision is that the model never writes targeting.** It picks a
control by number from a rendered listing; synthesis derives the matcher, the
fallback ladder, the checkpoint, the risk class and the route allowlist
afterwards, from observations actually taken. A model asked for a locator
produces one that works today; code that can test a candidate against the screen
it came from can insist on one that resolves *uniquely*. Neither half does the
other's job well.

**Trade-offs.** Single process, file-backed store, in-memory intervention queue.
Building scaling infrastructure is explicitly not rewarded and I agree — the
interfaces that would have to survive a queue or a database (`ArtifactStore`,
`EscalationPort`, `Surface`) are narrow on purpose. TypeScript with Playwright,
because Playwright gives frame handling, screenshots and direct input on one
object, which the handoff needs. Zod, so one definition is parser, type and
reviewable documentation at once.

## 2. Artifact schema

The artifact is a **contract, not a macro**. A calling agent must decide whether
to invoke it, what to pass and what it returns *without reading the steps*, and a
reviewer must approve it the same way. So the typed surface is declared
independently of the flow: `inputs`, `outputs`, `secrets`, `outcomes`, `policy`,
`approval`, `provenance`, then `steps` and `tenantOverrides`.

Five choices worth defending.

**No selectors anywhere.** Steps address controls through `TargetSpec`. Role,
name, value and table coordinates have direct equivalents in the browser
accessibility tree, the macOS AX API and Windows UI Automation, which is what
makes the file portable rather than browser-shaped.

**Business outcomes are declared, not inferred.** `MEMBER_NOT_FOUND` is an entry
with its own detection assertion and a `disposition` saying whether it is an
answer or something a person must see — not an exception thrown from step seven.
Conflating outcome with failure is called out as the common mistake here, so the
schema is shaped against it: outcomes, guards and hard failures are three
different constructs.

**Recoverable conditions are declarative and bounded.** A guard is
`{ when, then, maxFirings }` attached to the steps that can meet it. Keeping it
in the file rather than the engine means a reviewer sees exactly which surprises
a capability may absorb silently.

**Keyed on the product, not the tenant.** Hundreds of institutions run the same
core, so recording per tenant does not scale. An override may re-target a
control, change a literal, tighten a checkpoint, skip or insert a step, and may
**not** touch inputs, outputs, outcomes or policy. A difference that will not fit
that shape means the tenants are not running the same flow, and should be a
second capability rather than a wider patch format.

**Secrets are referenced, never carried,** and every save writes a new immutable
version — editing in place the thing a reviewer approved is a control failure,
not a storage detail.

Zod proves the file is shaped right; `validate.ts` proves it is coherent: an
output no step produces, a parameter no contract declares, an undeclared secret,
an action the capability's own policy forbids, an override patching a step that
no longer exists. Those are the errors you do not want to find four screens into
a live banking console.

## 3. Determinism & error handling

No model is consulted during replay. Every branch was declared in the artifact,
which makes a failure explainable by pointing at a line of the file rather than
at a transcript.

**Targeting.** Each target carries a primary matcher and an ordered fallback
ladder, derived at record time by testing candidates against the screen they came
from. Two rules carry the claim. *Ambiguity is a failure, never a coin flip* — a
matcher selecting several nodes without a declared ordinal fails with
`target_ambiguous`, because silently taking the first match is how a replay
clicks the wrong grid row and reports success. And *the rung that matched is part
of the result* — a step that starts winning on a fallback is the earliest drift
signal there is.

**Waiting.** Clicks arm a navigation listener *before* acting, since the click
promise does not await the navigation it starts and an observation taken
immediately after can read the screen being left. No fixed sleeps: the grace
window is bounded and exits the moment a navigation begins.

**Checkpoints.** Every screen-changing step asserts a post-condition, derived by
diffing before against after and preferring a newly present control named after
the caller's own argument. A step without one trusts that a click worked.

**Four statuses, because collapsing any two breaks the caller.**

| Status | Means | The caller should |
| --- | --- | --- |
| `success` | Goal met. | Use the outputs. |
| `business_outcome` | A declared, legitimate result. | Treat it as an answer, or route it onward if its disposition says so. |
| `escalated` | A person holds it, or none was available. | Not retry. |
| `failed` | Something broke. | Retry only `step_timeout` / `surface_error`. |

Ten failure categories, each carrying step id, intent, expectation, observation,
URL and a capture. Argument validation and credential resolution happen *before*
the browser is touched: failing there costs nothing, failing four screens in
leaves a half-finished flow someone must clean up.

**Runtime conditions, concretely.** Against the demo app I inject session expiry,
record-not-found, permission denial, a validation error, an interstitial,
slowness and a 500. The interstitial is absorbed by a bounded guard and the run
completes; record-not-found returns a business outcome; permission denial,
session expiry and the error page are outcomes dispositioned `needs_human`, so
they escalate; slowness is ridden out by the retry budget; everything else is a
categorised failure.

**Two real bugs this shook out.** Rendered text omits the value of a form
control, so an assertion looking for the label on a submit button found nothing —
control names and values now count as being on screen. And `Number('')` is `0`,
so a balance cell reading "n/a" would have been returned as a balance of zero.

**Drift** is secondary, as the brief says. Each step records the screen's
structural fingerprint and the named controls it saw; a mismatch is reported with
the missing controls named and does not fail the run on its own — the checkpoint
decides that.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `UiNode` in, `Primitive` out. A desktop
adapter over the macOS AX API or Windows UI Automation implements the same two
methods: both already expose role, name, value and bounds, and both have a tree
walk producing what the DOM extractor produces. `framePath` generalises to a
window or pane path.

The honest gap: a surface with *no* accessibility information — a Citrix window,
a Java applet — needs screenshot-plus-OCR, and a `UiNode` produced that way has
weaker identity. `TargetSpec` still expresses it, but the ladder would lean much
harder on table coordinates and bounds, and I would want a confidence field on
resolution before trusting it unattended.

**Multi-tenant reuse.** Artifacts are identified by `(productId, name)`, never by
tenant. A tenant contributes a *binding* — its hostname and credentials, which is
why `bindingVariables` is separate from `inputs`: an agent should not need to
know which host a credit union runs its core on in order to read a balance — and
optionally an override.

I built this and ran it. Replaying the base capability against the variant tenant
does not simply break. The recorded target `link "Member Search"` finds nothing;
its fallback rung, a link whose name *contains* "Search" in the menu frame,
matches "Customer Search", so the run reaches the right screen anyway; what the
ladder cannot absorb is the renamed field, and the step's checkpoint catches it
with a `checkpoint_failed` that names the field. The specialisation closing the
gap is two re-targeted controls and one tightened checkpoint, with the contract
untouched — and the artifact still runs on the tenant it was recorded against.

**What I would add for scale** (designed, not built): a tenant registry holding
bindings and override sets; promotion across tenants as a shadow replay whose
only output is a drift report; and stability scoring per `(capability, tenant)`
so an artifact can be approved for one institution and held back for another. The
schema carries `stability` for that reason.

## 5. Escalation & handoff

**Detecting stuck** is not a heuristic, which I think is right. The run escalates
on four declared conditions: a policy decision of `needs_approval`, a declared
outcome dispositioned `needs_human`, an unresolvable target on a step whose
`onFailure` is `escalate`, and a failed checkpoint on such a step. Everything
else is a categorised failure. A guessed "I seem to be stuck" would be worse.

**The control lease.** Both sides hold references to the same live browser
context, so without an explicit holder nothing stops a retry timer from clicking
while a person is mid-sentence. `SessionControl` names the holder at every
instant; `LeasedSurface` makes an out-of-turn action an error rather than a race;
the ledger records who held it, when and why. Observation stays open to both
sides deliberately — watching is not driving, and the run must see what the
operator did in order to resume from it.

**Taking control of the live session** is the part I was least willing to fake. A
fresh browser loses the session cookie, the frameset state and whatever
half-finished form the run stopped on, so the operator would be signing in again
before they could help. Instead the console drives the same `Page`: it streams
screenshots and forwards clicks (normalised coordinates), typing and key presses
back into it. The integration test proves this rather than asserting it — the
operator types through the console over HTTP, and the *run's own* next
observation contains that text.

**Handing back.** Control returns to the agent, the run re-observes that same
page and retries the step it stopped on. An operator who took the session, looked
at the step and handed it back has *approved* this invocation; the alternative is
escalating the same step to the same person on the next attempt. Every action
they take is recorded — and **what they typed is not**, because an operator
signing back in types a credential and the audit trail must not become where it
ends up.

**Mocked deliberately:** the console's presentation. A refreshing screenshot and
two buttons, no websockets, no shift routing. The mechanism is real and the seam
is `EscalationPort`, so a queue routing to a ticketing system drops in without
the engine changing.

## 6. Safety

**One choke point.** Discovery and replay authorise every action through the same
`PolicyEngine`. Two enforcement paths drift, and the one that ends up wrong is
always the unattended one.

**The allowlist** covers origins, route patterns and action kinds. Origins match
**exactly** — suffix matching is the classic hole, since `bank.com.evil.net` ends
with nothing an operator wrote but `endsWith` also accepts `evilbank.com`. Routes
are readable patterns rather than a regex, so a reviewer can check a tenant's
configuration without parsing one. A post-step location check catches an
application navigating itself somewhere off-limits.

**Risky and irreversible actions.** `safe` reads or navigates, `sensitive` writes
something a person could undo, `irreversible` posts to the core. The class is
re-derived at replay from what the live control calls itself, and the stricter of
recorded-versus-derived wins: a recording is one model's judgement about one
screen on one day, and if the button that said "Continue" now says "Post
Account", only the live read catches it.

I chose to **block rather than flag**, and would defend that for this domain
specifically: a false positive costs a confirmation prompt, a false negative
costs an unintended funds movement at a credit union. A draft may read but may
not write unattended. Discovery is exempt, because producing a recording is how a
capability becomes reviewable at all and it runs with a person watching.

**Regulated data.** Redaction happens at egress, never on the way in — the
resolver needs the real cell text to find the Regular Savings row. Everything
leaving the process is redacted: prompt, evidence log, artifact, escalation
payload. Known secret values mask first and exactly, then SSNs, emails,
Luhn-valid card numbers and long digit runs; a formatted currency amount stays
readable, which matters when the log is what you debug from.

**Its limits, plainly.** A screenshot of a member record *contains* the record,
and no redactor fixes that — captures default to failure-only and a real
deployment needs an image redactor or an encrypted store. Pattern redaction is a
heuristic: it over-redacts a long reference number and misses a name that is only
a name in context; the sensitivity-tagged values are the reliable half. The risk
vocabulary is a word list, so a control labelled only with an icon classifies as
`sensitive` and no better. And the allowlist governs navigation, not
exfiltration: nothing stops a capability reading a field it should not and
returning it as an output. What stops that is a reviewer reading the contract,
which is why the contract is built to be readable.

## 7. Cuts

**Left out deliberately.** A desktop surface (designed in §4, not built — and the
OCR case needs a confidence signal the schema does not carry). A real operator
console; the presentation is a mock, the control transfer is not. All scaling
infrastructure. **Assisted fallback on replay failure** is the stretch goal I
most wanted and cut: it needs a careful answer to "what may the model change, and
does the result amend the artifact or only this run", and a half-answer would
undermine the determinism the rest of the system rests on. **Multi-run stability
scoring** — the field exists and nothing populates it; without a promotion
workflow it would be a number nobody reads. And a **second capability**: the demo
app has an irreversible open-sub-account flow with a validation error and a
confirmation screen, and I built the app to support it, but recording it would
have exercised the same machinery. Depth over breadth.

**Next, in order.**

1. **Promotion as a shadow replay** — run an approved capability against a new
   tenant with actions suppressed and emit only a drift report. The highest-value
   thing missing, because it turns "does this work for the other two hundred
   institutions" from a question into a job.
2. **Stability scoring with an approval gate that reads it**, refusing unattended
   promotion below a threshold.
3. **Assisted fallback, bounded properly** — one step, one re-observation,
   policy-checked, recorded as evidence, never amending the artifact without a
   human edit entry.
4. **An evidence store that can hold screenshots safely**, so the default capture
   policy could stop being failure-only.
5. **A desktop adapter over the macOS AX API**, which is the honest test of
   whether the seam is where I think it is.

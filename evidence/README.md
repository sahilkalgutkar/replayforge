# Evidence

Every directory here was produced by `npx tsx scripts/record-evidence.ts`, which
runs the whole thread end to end. Only the first step involves a model.

`capability.json` is the artifact the discovery run emitted, exactly as it was
saved. Each run directory holds `run.jsonl` — one JSON object per event, written
as it happened, so a run that is killed still leaves everything up to the moment
it stopped — plus `result.json` and any captures.

Everything written passed through the redactor. The service password was typed
into the application in every one of these runs and appears in none of them.

## How the discovery run was driven

I had no standalone API key on the machine I built this on, and the one
credential that was there belonged to a Claude Code subscription and is not
scoped for driving a separate SDK client. So rather than simulate the run, I put
the model behind a file bridge and answered the turns myself: Claude Opus 5,
through the Claude Code session, reading each rendered screen and choosing each
control.

Nothing about the loop changed. `scripts/bridge-model-client.ts` implements the
same `ModelClient` interface `AnthropicModelClient` does, so the same system
prompt was built, the same control listing was rendered, the same tool
vocabulary was offered, and the decision came back in the same shape.
`run.jsonl` records the real loop looking at real screens, and
`provenance.model` in the artifact says exactly which model made the decisions.

`AnthropicModelClient` is the default and is covered by tests; set
`ANTHROPIC_API_KEY` and the same script records the same capability through the
API instead.

## The runs

- **01-discovery** — the real LLM-driven run. 11 steps recorded against member 10021. The numbered PNGs are the screens the model was looking at when it made each decision. `run.jsonl` holds every model decision and the action taken; `artifact.json` is the capability it produced.

- **02-replay-success** — the same capability replayed for a *different* member (10022) in a fresh browser session, so every form field name in the application differs from the ones discovery saw. No model involved. Result: `success — savingsBalance=58004.12, savingsAccountNumber=S0002-10022`.

- **03-replay-business-outcome** — a member that does not exist. The run ends with `MEMBER_NOT_FOUND` and disposition `answer`: the caller asked a question and this is the reply, not a crash. Result: `MEMBER_NOT_FOUND (answer) — The core holds no member with that number. The search screen reports it in place of a results table; this is a legitimate answer to the caller's question, not a failure.`.

- **04-replay-exceptional-state** — an injected session timeout mid-flow. `SESSION_EXPIRED` is a declared outcome whose disposition is `needs_human`, so the run stops and raises an intervention rather than carrying on. Result: `escalated at step 04_sign_on — SESSION_EXPIRED: The console signed the service session out part-way through the flow. A replay cannot sign itself back in safely, so a person has to. (intervention fff9ade2-8518-4db9-8aeb-38f33b75455a)`.

- **05-replay-rejected-input** — an argument that does not satisfy the contract. Rejected before the browser is touched, so nothing half-finished is left behind. Result: `failed [input_invalid] at step —: memberNumber does not match the required pattern ^[0-9]{4,10}$`.

- **06-replay-escalation-handoff** — the capability is still a draft, so its first writing step stops and raises an intervention. An operator takes the live session, reviews it and hands it back; the run resumes on that same session and completes. The trail carries `escalation.raised`, `escalation.resolved` and `approval.granted_by_operator`. Result: `success — savingsBalance=4182.55, savingsAccountNumber=S0001-10021`.

## The capability

```
member_savings_balance v1 — Look up a member’s regular savings balance
  product   meridian-core (recorded on tenant base)
  approval  draft
  risk      sensitive
  inputs    memberNumber:string
  outputs   savingsBalance:number, savingsAccountNumber:string
  outcomes  MEMBER_NOT_FOUND, ACCESS_DENIED, SESSION_EXPIRED, CORE_UNAVAILABLE
  steps     11
       00_open_entry  Open the application at its entry point.
    !  02_user_id  Type the service user id into the sign-on form.
    !  03_password  Type the service password into the sign-on form.
       04_sign_on  Submit the sign-on form to reach the servicing console.
    !  05_member_search  Open the member search screen from the menu.
    !  06_member_number  Type the member number being looked up into the search field.
       07_search  Run the member search.
    !  08_10021  Open the member record from the search results.
    !  09_accounts  Switch to the Accounts tab on the member record.
       10_4_182_55  Read the current balance from the Regular Savings row of the accounts grid.
       11_s0001_10021  Read the account number from the Regular Savings row of the accounts grid.
```

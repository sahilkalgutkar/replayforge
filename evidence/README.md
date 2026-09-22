# Evidence

Everything here comes from `npx tsx scripts/record-evidence.ts`, which runs the whole
thing end to end against the demo app. Only the first step uses a model.

`capability.json` is the capability discovery produced, as saved. Each run folder has
`run.jsonl`, one event per line, written as it happened, plus `result.json` and any
screenshots. Everything was redacted on the way to disk: the teller password was typed
into the app in every run and appears in none of these files.

- **01-discovery**: the model-driven run, on qwen3:14b through Ollama. 11 turns in 141s, recorded against member 10021. `run.jsonl` has every decision the model made and what happened; the numbered PNGs are the screens it was looking at when it made each one. `probe-memberNumber/` is the replay with member 99999 that found how the app reports a member who doesn't exist.

- **02-replay-success**: the same capability for a different member, 10022, in a fresh browser, so every form field name in the app differs from what discovery saw. Result: `success: accountNumber=S0002-10022, savingsBalance=58004.12`.

- **03-replay-business-outcome**: a member that doesn't exist, and not the one probed during discovery. It ends as `MEMBER_NOT_FOUND`, an answer rather than an error. Result: `MEMBER_NOT_FOUND (answer): The member record does not exist in the system.`.

- **04-replay-injected-fault**: the app is told to expire the session, so the very next screen, the sign-on, comes back with a 401, so the run stops on `HTTP_ERROR` and raises a request for a person instead of carrying on. There's no one attached here, so it ends as escalated, with a screenshot. Result: `escalated at 03_sign_on: HTTP_ERROR: The application answered a screen with an HTTP error status (401, 403 or 5xx), such as a signed-out session, a permission denial or a server fault. Added to every recorded flow. (intervention 30bd20c1-7b03-451f-91bf-775286c9f186)`.

- **05-replay-rejected-input**: an argument that doesn't fit the contract, turned away before the browser is touched. Result: `failed [input_invalid] at start: memberNumber does not match the required pattern ^[0-9]{4,10}$`.

- **06-replay-handoff**: the capability is still a draft, so the first step that types stops and asks for a person. They take the live session, leave a note and hand it back, and the run carries on in that same session. The log has `escalation.raised`, `escalation.resolved` and `approval.granted_by_operator`. Result: `success: accountNumber=S0001-10021, savingsBalance=4182.55`.

## The capability

```
member_savings_balance v1 - Look up a member’s regular savings balance
  product   meridian-core (recorded on tenant base)
  approval  draft
  risk      sensitive
  inputs    memberNumber:string
  outputs   accountNumber:string, savingsBalance:number
  outcomes  MEMBER_NOT_FOUND, HTTP_ERROR
  steps     11
       00_open  Open the application at its entry point.
    !  01_user_id  Enter the username to sign into the application.
    !  02_password  Enter the password to sign into the application.
       03_sign_on  Sign on to the Meridian Core application using the provided credentials.
       04_member_search  Navigate to the Member Search function to look up member {{memberNumber}}.
    !  05_member_number  Enter the member number {{memberNumber}} into the Member Number field.
       06_search  Search for member {{memberNumber}} using the Member Number field.
       07_member_number  Open the member record for member {{memberNumber}} to view their account details.
       08_accounts  Navigate to the Accounts section to view the member's account details.
       09_read_account_number  Read the account number for the Regular Savings account.
       10_read_savings_balance  Read the current balance for the Regular Savings account.
```

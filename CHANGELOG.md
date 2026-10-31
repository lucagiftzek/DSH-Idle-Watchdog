# Changelog

## 1.1.0

New, all optional, all defaulting to the 1.0 behaviour:

* `skipWhenGoalActive`: do not nudge a chat whose goal-round driver is armed and active (uses the optional `goals` service; no-op when absent).
* `onlyAfterError`: nudge only after an `agent/error` since the last human message; one nudge answers one error.
* `backoffFactor` and `backoffMaxMinutes`: exponential wait between nudges per chat.
* `quietHours` (`enabled`, `start`, `end`, `timezone`): no idle nudges inside a daily window, wraps midnight, IANA zone support. API prompts are not affected.
* `GET /dsh-idle-watchdog/api/next`: read-only preview of what the next scan would do per watched chat. Also included in `/status` as `preview`.
* Settings: a Behaviour card for the new options, and a Status table with next nudge (or the reason it is held), last outcome and nudge count.
* Per-chat last outcome (nudged, cap notice, send failed, human replied) persisted in the state file.

Changed:

* The built-in default prompt no longer contains a dash character (wording otherwise unchanged). Installs that set `defaultPrompt` are unaffected.
* Decision logic is one pure function (`evaluateChat`) shared by the scan and the preview, so the preview cannot disagree with what is sent.
* README rewritten for first-time users; package metadata prepared for npm.

## 1.0.0

* Idle nudges for opted-in chats with per-chat prompt and window, nudge cap, folded cap notice.
* Secret-protected external prompt API with rate limiting and cold-chat wake.
* Settings section, activity ledger, durable state.

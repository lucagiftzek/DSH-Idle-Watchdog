# Changelog

## 1.2.0 (2026-11-01)

Runs on DSH 0.1.5 and on DSH 0.2.x (0.1.7 and later) with the same code:

* Settings: DSH 0.1.5 keeps the registered namespace `dsh-idle-watchdog` in `settings.yaml`. DSH 0.2.x has no registrable namespaces; the plugin now exports its settings schema as `Config` (every field live, no remount) and stores values in its profile row `idle-watchdog` in `cordis.patch.yml`. On the first 0.2.x boot it imports the old `dsh-idle-watchdog` section once from `settings.yaml.imported` (the core import cannot, because the section name is not the entry id), and never over a row that already has values.
* API secret: new version-independent home `$DSH_HOME/idle-watchdog/api-secret` (mode 0600, override with `DSH_IDLE_WATCHDOG_SECRET_FILE`). Precedence: env `DSH_IDLE_WATCHDOG_SECRET`, then the file, then the stored setting. `POST /secret` writes the file (and, on 0.1.5 only, the namespace copy as before); on 0.2.x the secret is never written into the profile patch, and the legacy import moves it into the file. Scripts should read the file instead of grepping `settings.yaml`, which no longer exists on 0.2.x.
* `/status` reports `secretSource` (env, file, settings or none, never the value), `secretFile` and `settingsEntry`; `settingsStore` can now also be `profile-row`.
* Schemastery is resolved from the running harness first, so live fields are wrapped the way the 0.2.x Loader commits them.
* New `GET /dsh-idle-watchdog/api/doctor`: read-only self-check (settings mode, `Config` visible, API secret configured and its source, secret file mode, watched chats, `sessionController`, next-nudge preview, last scan age, state file writable). It never shows a secret value or a path.
* The packaged skill `idle-watchdog-doctor` is registered with the skills service at start.
* A missing `settings.json` on a fresh install is logged as an info line (`init: no fallback settings.json yet ...`) instead of `WATCHDOG_INIT_FAILED`; other init failures keep the code.
* The module now also has a default export `{ name, inject, apply, Config }` (the named exports are unchanged), so the 0.2.x loader finds `Config` there.

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

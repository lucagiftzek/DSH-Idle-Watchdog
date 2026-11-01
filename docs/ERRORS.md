# Error codes: Idle Watchdog

Every HTTP error body from `/dsh-idle-watchdog/api` has this shape:

```json
{ "ok": false, "error": "invalid-secret", "code": "WATCHDOG_SECRET_INVALID",
  "message": "The presented secret does not match", "hint": "...", "docs": "docs/ERRORS.md#watchdog_secret_invalid" }
```

`error` keeps the short string that scripts already parse (it never changed when codes were added), `code` is the stable identifier, `docs` is relative to the package root. Some errors add fields: `retryAfterMs` (rate limits), `ref` (not found), `candidates` (ambiguous), `detail`. Log lines start with the code, so `grep WATCHDOG_` finds them. The plugin has no agent tools; the codes appear on HTTP routes and in the log.

Read-only diagnostics: `GET /dsh-idle-watchdog/api/health`, `/status`, `/next`, `/chats`, `/logs`. The one-call self-check is `GET /dsh-idle-watchdog/api/doctor`; its failing rows carry these codes.

Start here when you have a symptom instead of a code: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#start-here).

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| WATCHDOG_SECRET_NOT_CONFIGURED | 503 | route POST /dsh-idle-watchdog/api/prompt | The API has no secret from any source and fails closed. | `GET /dsh-idle-watchdog/api/status` and read `secretSource` (`none` confirms it), `envSecretPresent` and `secretFile`. ([details](#watchdog_secret_not_configured)) |
| WATCHDOG_SECRET_INVALID | 401 | route POST /dsh-idle-watchdog/api/prompt, log (ledger entry `prompt-rejected`, reason `bad-secret`) | The presented secret differs from the configured one. | `GET /status`: compare `secretSource` (env, file, settings) with what the caller uses. ([details](#watchdog_secret_invalid)) |
| WATCHDOG_AUTH_THROTTLED | 429 | route POST /dsh-idle-watchdog/api/prompt | Ten wrong secrets in a minute from one address; the address is paused. | Wait the seconds in the `retry-after` header (`retryAfterMs` in the body). ([details](#watchdog_auth_throttled)) |
| WATCHDOG_RATE_LIMITED | 429 | route POST /dsh-idle-watchdog/api/prompt | More prompt calls per minute from one address than `api.rateLimitPerMinute` (default 30). | Wait for `retry-after`; batch messages or add a delay in the caller. ([details](#watchdog_rate_limited)) |
| WATCHDOG_PROMPT_INVALID | 400 | route POST /dsh-idle-watchdog/api/prompt | `chat` or `message` is missing or empty after trimming. | Send `{"chat":"<id, prefix or title>","message":"text"}` with `content-type: application/json`. ([details](#watchdog_prompt_invalid)) |
| WATCHDOG_CHAT_NOT_FOUND | 404 | route POST /dsh-idle-watchdog/api/prompt | The reference matches no chat (also a cold id the host does not know). | `GET /dsh-idle-watchdog/api/chats?refresh` lists sessions with ids, titles and live flags. ([details](#watchdog_chat_not_found)) |
| WATCHDOG_CHAT_AMBIGUOUS | 409 | route POST /dsh-idle-watchdog/api/prompt | A prefix or title matches several chats; `candidates` lists up to 5. | Pick one id from `candidates` and send it in full. ([details](#watchdog_chat_ambiguous)) |
| WATCHDOG_CHAT_NOT_LIVE | 409 | route POST /dsh-idle-watchdog/api/prompt | The chat is not loaded and `wakeColdForApi` is off. | Enable `wakeColdForApi` in Settings (live), or open the chat in the web UI so it is loaded, then retry. ([details](#watchdog_chat_not_live)) |
| WATCHDOG_RESOLVER_UNAVAILABLE | 409 | route POST /dsh-idle-watchdog/api/prompt | The host has no session controller to wake a cold chat. Answered with the legacy string `chat-not-live`. | Open the chat in the UI so it is live, then retry. ([details](#watchdog_resolver_unavailable)) |
| WATCHDOG_CHAT_NOT_RESOLVABLE | 409 | route POST /dsh-idle-watchdog/api/prompt | The host knows the chat but could not load it; `detail` carries the host reason. | Open the chat in the web UI; if it does not load there either, the session itself is the problem. ([details](#watchdog_chat_not_resolvable)) |
| WATCHDOG_CHAT_SUBAGENT_OWNED | 403 | route POST /dsh-idle-watchdog/api/prompt | The chat is a child session owned by a subagent. | Address the parent chat. Child sessions are not addressable by design. ([details](#watchdog_chat_subagent_owned)) |
| WATCHDOG_RESOLVE_FAILED | 500 | route POST /dsh-idle-watchdog/api/prompt, ledger entry `prompt-resolve-failed` | The host threw an unexpected error while loading the chat. | `GET /logs` and find `prompt-resolve-failed` with its message. ([details](#watchdog_resolve_failed)) |
| WATCHDOG_FOLLOWUP_FAILED | 500 | route POST /dsh-idle-watchdog/api/prompt, ledger entry `prompt-failed` | The chat resolved but queueing the message threw. | `GET /logs` for `prompt-failed` and its message; retry once. ([details](#watchdog_followup_failed)) |
| WATCHDOG_CSRF_GUARD | 403 | route PUT /dsh-idle-watchdog/api/settings, route POST /dsh-idle-watchdog/api/secret | Browser-only routes need the UI request shape. | Send both headers (see the troubleshooting entry). The prompt route is for scripts and needs neither. ([details](#watchdog_csrf_guard)) |
| WATCHDOG_SETTINGS_EMPTY | 400 | route PUT /dsh-idle-watchdog/api/settings | After validation the patch has no setting left. | Send known keys within limits (README settings table); check spelling and types. ([details](#watchdog_settings_empty)) |
| WATCHDOG_SECRET_LENGTH | 400 | route POST /dsh-idle-watchdog/api/secret | The secret is shorter than 16 or longer than 256 characters. | Use 16 to 256 characters; a long random value is best. ([details](#watchdog_secret_length)) |
| WATCHDOG_ROUTE_NOT_FOUND | 404 | route any other path or method under /dsh-idle-watchdog/api | The plugin is loaded but does not serve that path and method. | Use GET `health`, `status`, `next`, `chats`, `logs`; PUT `settings`; POST `secret`, `prompt`. ([details](#watchdog_route_not_found)) |
| WATCHDOG_BODY_TOO_LARGE | 400 | route POST /prompt, PUT /settings, POST /secret | The body is above 64 KiB. | Shorten it; a prompt message is limited to 8000 characters anyway. ([details](#watchdog_body_too_large)) |
| WATCHDOG_BODY_INVALID | 400 | route POST /prompt, PUT /settings, POST /secret | The body is not valid JSON; `error` carries the parser message. | Build the body with a tool (`node -e`, `jq -n`) instead of hand quoting, and send `content-type: application/json`. ([details](#watchdog_body_invalid)) |
| WATCHDOG_INTERNAL | 400 | any route (answered with status 400 for compatibility), log | An unexpected exception inside a route. | Find the log line starting with `WATCHDOG_INTERNAL` in the `dsh web` log, and `GET /logs`. ([details](#watchdog_internal)) |
| WATCHDOG_INIT_FAILED | n/a | log | Loading saved state or the fallback settings file failed at start. | Read the file named in the line; a missing `settings.json` is no longer reported with this code. ([details](#watchdog_init_failed)) |
| WATCHDOG_TICK_FAILED | n/a | log | The idle scan or a session event handler threw; the next scan continues. | Read the line (it names the chat or handler). One occurrence is noise; a line on every scan means report a bug. ([details](#watchdog_tick_failed)) |
| WATCHDOG_STATE_WRITE_FAILED | n/a | log | Saving the nudge counters to `state.json` failed. | Check `df` and `ls -ld` on `${DSH_HOME:-$HOME/.dsh}/idle-watchdog`. Nudging continues; after a restart the counters start from zero. ([details](#watchdog_state_write_failed)) |

### WATCHDOG_SECRET_NOT_CONFIGURED
- **Meaning:** The API has no secret from any source and fails closed.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `secret-not-configured`.
- **Likely causes:**
  1. No secret was ever saved and env `DSH_IDLE_WATCHDOG_SECRET` is not set in the `dsh web` process.
  2. The secret file is empty, missing, or its path override `DSH_IDLE_WATCHDOG_SECRET_FILE` points elsewhere.
  3. After an upgrade to DSH 0.2.x the old secret only lived in `settings.yaml`, which was renamed to `settings.yaml.imported`, and it was never moved to the file.
- **Agent action:**
  1. `GET /dsh-idle-watchdog/api/status` and read `secretSource` (`none` confirms it), `envSecretPresent` and `secretFile`.
  2. Check the file exists with mode 0600: `ls -l "${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret"`.
  3. Fix: save a secret in Settings, Idle Watchdog (writes the file), or create the file yourself (see the troubleshooting entry).
- **Needs the human:** Yes if a secret must be chosen or an environment variable of the `dsh web` service changed.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-secret)

### WATCHDOG_SECRET_INVALID
- **Meaning:** The presented secret differs from the configured one.
- **Where:** route POST /dsh-idle-watchdog/api/prompt, log (ledger entry `prompt-rejected`, reason `bad-secret`). Legacy `error` string: `invalid-secret`.
- **Likely causes:**
  1. The caller reads an old source (for example `settings.yaml`, gone on DSH 0.2.x) or a stale copy.
  2. Env `DSH_IDLE_WATCHDOG_SECRET` is set in the `dsh web` process and wins over the file, but the caller reads the file.
  3. The secret was rotated; a file change is picked up within about 5 seconds, an env change needs a restart.
  4. A trailing newline or quote ended up in the header value.
- **Agent action:**
  1. `GET /status`: compare `secretSource` (env, file, settings) with what the caller uses.
  2. Probe without sending a message: POST `{"chat":"","message":""}` with the secret; `400` (`WATCHDOG_PROMPT_INVALID`) means the secret was accepted.
  3. Make the caller read the source that wins (see the troubleshooting entry). Never print the secret.
- **Needs the human:** No, unless the secret itself must be rotated or an environment variable changed.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-secret)

### WATCHDOG_AUTH_THROTTLED
- **Meaning:** Ten wrong secrets in a minute from one address; the address is paused.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `rate-limited`.
- **Likely causes:**
  1. A script or cron job keeps sending a wrong or missing secret.
  2. Several scripts share one address and one of them is misconfigured.
- **Agent action:**
  1. Wait the seconds in the `retry-after` header (`retryAfterMs` in the body).
  2. Fix the caller first (code `WATCHDOG_SECRET_INVALID`), otherwise it throttles itself again.
  3. The budget is per source address and fixed; it is not a setting.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-rate-limited)

### WATCHDOG_RATE_LIMITED
- **Meaning:** More prompt calls per minute from one address than `api.rateLimitPerMinute` (default 30).
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `rate-limited`.
- **Likely causes:**
  1. A loop or burst of webhook deliveries.
  2. The limit was lowered in Settings.
- **Agent action:**
  1. Wait for `retry-after`; batch messages or add a delay in the caller.
  2. To allow more: raise `api.rateLimitPerMinute` (1 to 600) in Settings.
- **Needs the human:** Only to raise the limit if the caller cannot slow down.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-rate-limited)

### WATCHDOG_PROMPT_INVALID
- **Meaning:** `chat` or `message` is missing or empty after trimming.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `chat and non-empty message are required`.
- **Likely causes:**
  1. The JSON field names are wrong (`chat`, `message`).
  2. Shell quoting produced an empty value.
  3. The message is empty or only whitespace.
- **Agent action:**
  1. Send `{"chat":"<id, prefix or title>","message":"text"}` with `content-type: application/json`.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CHAT_NOT_FOUND
- **Meaning:** The reference matches no chat (also a cold id the host does not know).
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `chat-not-found`.
- **Likely causes:**
  1. Typo, or a title that is not an exact match (case is ignored, spelling is not).
  2. An id prefix shorter than 6 characters, or a prefix of a chat that is neither live nor in the watched list.
  3. The chat title is not known to the plugin catalog yet (it refreshes about every 15 seconds).
  4. The chat was deleted.
- **Agent action:**
  1. `GET /dsh-idle-watchdog/api/chats?refresh` lists sessions with ids, titles and live flags.
  2. Retry with the full session id.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CHAT_AMBIGUOUS
- **Meaning:** A prefix or title matches several chats; `candidates` lists up to 5.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `ambiguous-chat`.
- **Likely causes:**
  1. Two chats share a title, or an id prefix is too short.
- **Agent action:**
  1. Pick one id from `candidates` and send it in full.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CHAT_NOT_LIVE
- **Meaning:** The chat is not loaded and `wakeColdForApi` is off.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `chat-not-live`.
- **Likely causes:**
  1. The setting `wakeColdForApi` was switched off (default is on).
- **Agent action:**
  1. Enable `wakeColdForApi` in Settings (live), or open the chat in the web UI so it is loaded, then retry.
- **Needs the human:** Only the decision whether API calls may wake cold chats.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_RESOLVER_UNAVAILABLE
- **Meaning:** The host has no session controller to wake a cold chat. Answered with the legacy string `chat-not-live`.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `chat-not-live`.
- **Likely causes:**
  1. The running `dsh web` is an older or different build without the session controller service.
  2. The server half was updated but `dsh web` was not restarted.
- **Agent action:**
  1. Open the chat in the UI so it is live, then retry.
  2. Compare `GET /health` `version` with the installed package version; a mismatch means a restart is pending.
- **Needs the human:** Yes, a restart of `dsh web` if the build is current but the service is missing.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CHAT_NOT_RESOLVABLE
- **Meaning:** The host knows the chat but could not load it; `detail` carries the host reason.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `chat-not-resolvable`.
- **Likely causes:**
  1. The stored session cannot be opened (format, lock, or it is being deleted).
  2. The host refused to resume it.
- **Agent action:**
  1. Open the chat in the web UI; if it does not load there either, the session itself is the problem.
  2. Retry through the API after it loads.
- **Needs the human:** Yes if the session is damaged.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CHAT_SUBAGENT_OWNED
- **Meaning:** The chat is a child session owned by a subagent.
- **Where:** route POST /dsh-idle-watchdog/api/prompt. Legacy `error` string: `subagent-owned`.
- **Likely causes:**
  1. The id belongs to a subagent run, not to a top-level chat.
- **Agent action:**
  1. Address the parent chat. Child sessions are not addressable by design.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_RESOLVE_FAILED
- **Meaning:** The host threw an unexpected error while loading the chat.
- **Where:** route POST /dsh-idle-watchdog/api/prompt, ledger entry `prompt-resolve-failed`. Legacy `error` string: `resolve-failed`.
- **Likely causes:**
  1. A host side failure while resuming the session.
- **Agent action:**
  1. `GET /logs` and find `prompt-resolve-failed` with its message.
  2. Retry once; if it repeats, collect the entry and report a bug.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_FOLLOWUP_FAILED
- **Meaning:** The chat resolved but queueing the message threw.
- **Where:** route POST /dsh-idle-watchdog/api/prompt, ledger entry `prompt-failed`. Legacy `error` string: `followup-failed`.
- **Likely causes:**
  1. The agent was disposed between resolve and delivery.
  2. A host side error.
- **Agent action:**
  1. `GET /logs` for `prompt-failed` and its message; retry once.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_CSRF_GUARD
- **Meaning:** Browser-only routes need the UI request shape.
- **Where:** route PUT /dsh-idle-watchdog/api/settings, route POST /dsh-idle-watchdog/api/secret. Legacy `error` string: `csrf-guard`.
- **Likely causes:**
  1. A script calls a settings route without header `X-Requested-With: dsh-idle-watchdog` or without `Content-Type: application/json`.
- **Agent action:**
  1. Send both headers (see the troubleshooting entry). The prompt route is for scripts and needs neither.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-csrf-guard)

### WATCHDOG_SETTINGS_EMPTY
- **Meaning:** After validation the patch has no setting left.
- **Where:** route PUT /dsh-idle-watchdog/api/settings. Legacy `error` string: `no-valid-settings-in-body`.
- **Likely causes:**
  1. Unknown key names, wrong types, or values out of range were all dropped.
- **Agent action:**
  1. Send known keys within limits (README settings table); check spelling and types.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### WATCHDOG_SECRET_LENGTH
- **Meaning:** The secret is shorter than 16 or longer than 256 characters.
- **Where:** route POST /dsh-idle-watchdog/api/secret. Legacy `error` string: `secret must be 16..256 characters`.
- **Likely causes:**
  1. Too short or too long a secret was submitted.
- **Agent action:**
  1. Use 16 to 256 characters; a long random value is best.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-secret)

### WATCHDOG_ROUTE_NOT_FOUND
- **Meaning:** The plugin is loaded but does not serve that path and method.
- **Where:** route any other path or method under /dsh-idle-watchdog/api. Legacy `error` string: `not-found`.
- **Likely causes:**
  1. Typo in the path, wrong method (for example GET on /prompt), or a feature of a newer version (the `/api/doctor` route needs plugin 1.2.0 with the doctor commit).
- **Agent action:**
  1. Use GET `health`, `status`, `next`, `chats`, `logs`; PUT `settings`; POST `secret`, `prompt`.
  2. A 404 on every path (no JSON body) means the plugin is not loaded: see the troubleshooting entry.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-route-404)

### WATCHDOG_BODY_TOO_LARGE
- **Meaning:** The body is above 64 KiB.
- **Where:** route POST /prompt, PUT /settings, POST /secret. Legacy `error` string: `request body too large`.
- **Likely causes:**
  1. A very long message or a huge settings patch.
- **Agent action:**
  1. Shorten it; a prompt message is limited to 8000 characters anyway.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_BODY_INVALID
- **Meaning:** The body is not valid JSON; `error` carries the parser message.
- **Where:** route POST /prompt, PUT /settings, POST /secret.
- **Likely causes:**
  1. Shell quoting broke the JSON.
  2. Wrong content, for example form encoding.
- **Agent action:**
  1. Build the body with a tool (`node -e`, `jq -n`) instead of hand quoting, and send `content-type: application/json`.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-prompt-chat)

### WATCHDOG_INTERNAL
- **Meaning:** An unexpected exception inside a route.
- **Where:** any route (answered with status 400 for compatibility), log.
- **Likely causes:**
  1. A bug, or a disk error writing the secret file or the settings.
- **Agent action:**
  1. Find the log line starting with `WATCHDOG_INTERNAL` in the `dsh web` log, and `GET /logs`.
  2. Check disk space and the permissions of the plugin data directory, then retry once; report a bug with the line.
- **Needs the human:** Only to report the bug.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-start-here)

### WATCHDOG_INIT_FAILED
- **Meaning:** Loading saved state or the fallback settings file failed at start.
- **Where:** log.
- **Likely causes:**
  1. A corrupt `state.json` or `settings.json`, or wrong file permissions.
  2. An unexpected crash in the start-up loader (the line says `init crashed` and carries a stack).
  A missing `settings.json` on a fresh install is not an error any more: the plugin logs the info line `init: no fallback settings.json yet (fresh install), nothing to load` without a code.
- **Agent action:**
  1. If the line is the info line about a missing `settings.json`, it carries no code and needs no action.
  2. Otherwise move the named file aside (`mv file file.bad-$(date +%Y%m%d)`), never delete, and restart when convenient.
- **Needs the human:** Yes for the restart.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### WATCHDOG_TICK_FAILED
- **Meaning:** The idle scan or a session event handler threw; the next scan continues.
- **Where:** log.
- **Likely causes:**
  1. A host event had an unexpected shape, or one chat failed while being evaluated.
- **Agent action:**
  1. Read the line (it names the chat or handler). One occurrence is noise; a line on every scan means report a bug.
- **Needs the human:** No.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-nudges)

### WATCHDOG_STATE_WRITE_FAILED
- **Meaning:** Saving the nudge counters to `state.json` failed.
- **Where:** log.
- **Likely causes:**
  1. Disk full, or the data directory is not writable by the `dsh web` user.
- **Agent action:**
  1. Check `df` and `ls -ld` on `${DSH_HOME:-$HOME/.dsh}/idle-watchdog`. Nudging continues; after a restart the counters start from zero.
- **Needs the human:** Yes if permissions or disk space need an administrator.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-start-here)

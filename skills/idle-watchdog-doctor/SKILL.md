---
name: idle-watchdog-doctor
description: Diagnose and fix Idle Watchdog problems step by step (API 404, secret 401/503, rate limits, chat not found, nudges that never fire or fire too often, settings not saving). Load it when a call to /dsh-idle-watchdog/api fails, an error carries a WATCHDOG_ code, or the user reports that idle nudges do not arrive.
---

# Idle Watchdog doctor

## Rules
- Read-only checks first. Never print the API secret: read it into a command, never echo it, never paste a settings row.
- Never restart `dsh web` yourself: the chat you are in may run inside it. Ask the human.
- Steps marked [HUMAN] need the human (restart, choosing a secret, policy settings, environment of the service).
- Policy settings (idle window, cap, quiet hours, opt-in of a chat, `wakeColdForApi`) are the human's decision: propose, do not change.
- Stop and report after a fix; verify with the step given.
- Start with the doctor: `curl -s $U/dsh-idle-watchdog/api/doctor` (read-only, no secret value). Read `status` and every check that is not `ok` or `skip`; its codes are in `docs/ERRORS.md`. A 404 there means the plugin is older than the doctor or not loaded: use the read-only routes below.

## 0. Facts (read-only)
Set `U` to the DSH web URL (for example `http://127.0.0.1:3080`).
1. Plugin dir (docs live in `docs/` there): `node -p "require('path').dirname(require.resolve('dsh-idle-watchdog/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"`
2. Running server half: `curl -s $U/dsh-idle-watchdog/api/health` (`version`).
3. State: `curl -s $U/dsh-idle-watchdog/api/status` and read `version`, `settingsStore` (`settings` on DSH 0.1.5, `profile-row` on 0.2.x, `fallback-file` otherwise), `secretSource` (`env`, `file`, `settings`, `none`), `envSecretPresent`, `settings.enabled`, `settings.wakeColdForApi`. The secret value is never in it.
4. Per chat verdict: `curl -s $U/dsh-idle-watchdog/api/next` (`rows[].action`, `rows[].reason`, `dueAt`, `nudgesSent/maxNudges`).
5. Ledger tail: `curl -s "$U/dsh-idle-watchdog/api/logs?n=40"`. The `dsh web` log lines start with `idle-watchdog:`; errors carry a `WATCHDOG_` code.
6. Chats that resolve: `curl -s "$U/dsh-idle-watchdog/api/chats?refresh"`.
7. Doctor (one call, read-only): `curl -s $U/dsh-idle-watchdog/api/doctor`; each check has `status`, `detail`, and for problems a `code`, `hint` and `human` when only the human can fix it.

The full guide is `docs/TROUBLESHOOTING.md` in the plugin dir, the codes are in `docs/ERRORS.md`. Fallback: the repository README on GitHub.

## 1. Decision tree
Start from what you observe.

- **HTTP 404 on `/health` (non JSON or empty body)** -> the server half is not loaded or not restarted: Troubleshooting entry 1, then "Common install problems" C1 and C2. Ask the human to restart `dsh web`. Also check the kill switch (env `DSH_IDLE_WATCHDOG_DISABLE=1` or a `disabled: true` row for `idle-watchdog`), which removes the routes on purpose (entry 10).
- **JSON `{"error":"not-found"}`** (`WATCHDOG_ROUTE_NOT_FOUND`) -> the plugin is loaded, the path or method is wrong. Valid: GET `health status next chats logs`, PUT `settings`, POST `secret prompt`.
- **`/health` version older than the installed package, or `/next` answers 404** -> old server half still running: entry 8. [HUMAN] restart.
- **503 `secret-not-configured`** (`WATCHDOG_SECRET_NOT_CONFIGURED`) -> `secretSource` is `none`: entry 2, cause 1. [HUMAN] picks the secret (Settings, or the 0600 file `${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret`).
- **401 `invalid-secret`** (`WATCHDOG_SECRET_INVALID`) -> the caller uses the wrong source. Precedence: env `DSH_IDLE_WATCHDOG_SECRET` of the `dsh web` process, then the file, then the stored setting. Scripts that grep `settings.yaml` break on DSH 0.2.x (the file becomes `settings.yaml.imported`). Fix the reader, probe with an empty body (below). Entry 2.
- **429 `rate-limited`** -> `WATCHDOG_AUTH_THROTTLED` (10 wrong secrets per minute per address: fix the secret first) or `WATCHDOG_RATE_LIMITED` (calls per minute, setting `api.rateLimitPerMinute`). Wait the `retry-after` seconds. Entry 3.
- **404 `chat-not-found`, 409 `ambiguous-chat`, 409 `chat-not-live`, 403 `subagent-owned`** -> entry 4. Look the chat up in `/chats?refresh` and send the full session id. `chat-not-live` needs `wakeColdForApi` (human decision) or an open chat.
- **403 `csrf-guard`** on `PUT /settings` or `POST /secret` -> browser-only routes; send `X-Requested-With: dsh-idle-watchdog` and `Content-Type: application/json`. Entry 9.
- **"Nudges never arrive"** -> read `/next` for the chat: no row means the chat was never opted in; `disabled`, `chat-off`, `not-live`, `running`, `waiting`, `cap-reached`, `goal-active`, `waiting-for-error`, `quiet-hours` each have a cause and a fix in entry 5. Reasons that are policy are reported, not changed.
- **"Nudges too often"** -> entry 6 (window, backoff, cap). Propose settings to the human.
- **"Settings do not save" or reset on DSH 0.2.x** -> entry 7: check `settingsStore`, the profile row `idle-watchdog`, the one-time legacy import.
- **"I need it to stop now"** -> entry 10: Enabled off in Settings (live), then the kill switch [HUMAN].
- **Anything about install, blank GUI, restart, memory** -> "Common install problems on DSH" C1 to C7.

Probe a secret without sending a message (never print `IW`):
```bash
IW=${DSH_IDLE_WATCHDOG_SECRET:-$(cat "${DSH_IDLE_WATCHDOG_SECRET_FILE:-${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret}" 2>/dev/null)}
curl -s -o /dev/null -w '%{http_code}\n' -X POST $U/dsh-idle-watchdog/api/prompt \
  -H 'content-type: application/json' -H "x-idle-watchdog-secret: $IW" -d '{"chat":"","message":""}'
```
`400` means the secret is accepted and nothing was delivered. Run it once, not in a loop: wrong answers count towards the throttle.

## 2. Fixes you may apply
- Correct a caller script or your own curl: read the secret from env, else the file, never from `settings.yaml`.
- Use the full session id from `/chats?refresh`.
- Add the two headers for the browser routes.
- Back up (`cp file file.bak-$(date +%Y%m%d)`) before any hand edit; move a corrupt `state.json` aside instead of deleting it.
- Read-only everything else.

## 3. Steps that need the human
- Restarting `dsh web` (server half loads only at start; the browser half hot-reloads).
- Choosing or rotating the secret, and any change of the `dsh web` service environment.
- Policy: `idleMinutes`, `maxNudges`, backoff, quiet hours, `onlyAfterError`, `skipWhenGoalActive`, which chats are watched, `wakeColdForApi`, `api.rateLimitPerMinute`.
- Kill switch by environment variable or by `disabled: true` row.
- Router, proxy or login-gate changes in front of DSH.

## 4. Report back
Tell the human: the failing symptom or `code`, the cause you found (quote the `/status` or `/next` fields, never the secret), what you changed (if anything) and how you verified it, and exactly what they still need to do (for example "restart dsh web, then I re-run /health and /next").

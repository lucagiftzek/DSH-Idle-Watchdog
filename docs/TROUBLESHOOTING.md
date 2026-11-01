# Troubleshooting Idle Watchdog

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 1.2.0.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `idle-watchdog-doctor` skill (bundled in `skills/`, registered by the plugin; the README shows how to install it by hand if your DSH does not list it), or run section 0 yourself. Every HTTP error the plugin returns carries a `code`; look it up in [ERRORS.md](ERRORS.md). The read-only routes `GET /dsh-idle-watchdog/api/health`, `/status`, `/next` and `/logs` are the diagnostics; the one-call self-check is `GET /dsh-idle-watchdog/api/doctor`, which gathers the same facts in a single report (read-only, no secret value).

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example `http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`. **[HUMAN]** marks a step that needs the person who runs the machine (restart, secrets they choose, services).

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | The API answers 404 | Plugin not loaded, or `dsh web` not restarted after install or update | [1](#t-route-404) |
| 2 | 401 `invalid-secret`, 503 `secret-not-configured`, or scripts broke after the DSH 0.2.x update | Wrong or missing secret source | [2](#t-secret) |
| 3 | 429 `rate-limited` | Too many calls, or too many wrong secrets | [3](#t-rate-limited) |
| 4 | `chat-not-found`, `ambiguous-chat`, `chat-not-live`, `subagent-owned` on `/prompt` | Reference does not resolve, or the chat is cold | [4](#t-prompt-chat) |
| 5 | Nudges never fire | Chat not opted in, window, quiet hours, backoff, goal, error-only | [5](#t-no-nudges) |
| 6 | Nudges fire too often | Window too short, no backoff, cap too high | [6](#t-too-many-nudges) |
| 7 | Settings do not save (DSH 0.2.x), or reset | Profile row or `Config` not seen, one-time import | [7](#t-settings-not-saved) |
| 8 | New options are visible but do nothing | Old server half still running | [8](#t-new-options-no-effect) |
| 9 | 403 `csrf-guard` when a script writes settings | Browser-only route | [9](#t-csrf-guard) |
| 10 | I need to stop all nudging now | Kill switch | [10](#t-kill-switch) |
| C1 to C7 | Install and update problems shared by all DSH plugins | See the section at the end | [C1](#c1-not-loaded) |

## 0. Collect facts (read-only, always safe)

```bash
U=<dsh-url>
dsh --version
curl -s $U/dsh-idle-watchdog/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.status||r.code,(r.checks||[]).filter(c=>c.status!=="ok"&&c.status!=="skip").map(c=>[c.id,c.status,c.code,c.detail]))})'   # one call: every check that is not ok
curl -s $U/dsh-idle-watchdog/api/health ; echo                       # {"ok":true,"plugin":...,"version":...}
curl -s $U/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({version:r.version,settingsStore:r.settingsStore,settingsEntry:r.settingsEntry,secretSource:r.secretSource,envSecretPresent:r.envSecretPresent,secretFile:r.secretFile,enabled:r.settings&&r.settings.enabled,watched:(r.perChat||[]).length})})'
curl -s $U/dsh-idle-watchdog/api/next | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("enabled",r.enabled,"quietNow",r.quietNow);for(const c of r.rows)console.log(c.sessionId,JSON.stringify(c.label),c.action,c.reason,"nudges",c.nudgesSent+"/"+c.maxNudges)})'
curl -s "$U/dsh-idle-watchdog/api/logs?n=30"                          # activity ledger tail (JSON lines)
P=$(node -p "require('path').dirname(require.resolve('dsh-idle-watchdog/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"); node -p "require('$P/package.json').version"
ls -l "${DSH_HOME:-$HOME/.dsh}/idle-watchdog/"                        # api-secret (0600), state.json, activity.jsonl
```

What to read: `settingsStore` is `settings` (DSH 0.1.5), `profile-row` (DSH 0.2.x) or `fallback-file` (no settings service). `secretSource` is `env`, `file`, `settings` or `none` (the value is never shown). A `/health` version older than the installed package version means the server half has not been restarted since the update. The same facts, as the plugin saw them at start, are in the `dsh web` log lines starting with `idle-watchdog:`. Error log lines start with a `WATCHDOG_` code.

Where state lives: `${DSH_HOME:-$HOME/.dsh}/idle-watchdog/` holds `api-secret` (mode 0600), `state.json` (nudge counters, rewritten atomically) and `activity.jsonl` (rolling audit ledger). There is no lock file.

<a id="t-route-404"></a>
## 1. The API answers 404

**Likely causes** (most likely first)
1. The server half is not running the current code: the package was installed or updated but `dsh web` was not restarted. The browser half hot-reloads (so the Settings section may even appear), the server half loads only at start.
2. The package is not in the profile bundles, or DSH refused it (see [C1](#c1-not-loaded)).
3. The kill switch is set, so the routes are intentionally not mounted ([entry 10](#t-kill-switch)).
4. A reverse proxy in front of DSH does not forward `/dsh-idle-watchdog/`.
5. Only ONE path answers 404 with a JSON body `{"error":"not-found","code":"WATCHDOG_ROUTE_NOT_FOUND"}`: the plugin is loaded, the path or method is wrong (for example `GET` on `/prompt`, or `/api/doctor` on a plugin version older than the doctor).

**Diagnose** (read-only)
```bash
for p in health status next nope; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/dsh-idle-watchdog/api/$p)"; done
curl -s <dsh-url>/dsh-idle-watchdog/api/nope ; echo            # JSON not-found = loaded; HTML or empty = not loaded
```
Healthy: `200 200 200` and a JSON `not-found` for the last. `404 404 404 404` is cause 1, 2, 3 or 4. `/health` works but `/next` is `404` while the installed package is 1.1.0 or newer: cause 1 (an older server half is running, see [entry 8](#t-new-options-no-effect)).

Is the kill switch set in the running process (Linux, same user)?
```bash
PID=$(pgrep -f 'dsh.* web' | head -1); tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -c '^DSH_IDLE_WATCHDOG_DISABLE=1$'
grep -n -B1 -A2 -- '- id: idle-watchdog' "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" | grep -n 'disabled'
```

**Fix**
- Cause 1 **[HUMAN]**: restart `dsh web` (the chat you are in may run inside it, so ask first). Reload the browser tab afterwards.
- Cause 2: follow [C1](#c1-not-loaded).
- Cause 3 **[HUMAN]**: remove the variable or the `disabled: true` row, then restart.
- Cause 4 **[HUMAN]**: make the proxy forward `/dsh-idle-watchdog/` (and keep it behind your login proxy, the route has no host authentication).

**Verify**
```bash
curl -s <dsh-url>/dsh-idle-watchdog/api/health
```

**Related codes:** `WATCHDOG_ROUTE_NOT_FOUND`.

<a id="t-secret"></a>
## 2. 401 invalid-secret, 503 secret-not-configured, or scripts that suddenly fail

**Likely causes**
1. **503:** no secret from any source. Precedence is: env `DSH_IDLE_WATCHDOG_SECRET` of the `dsh web` process (wins), then the file `${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret` (mode 0600; path override `DSH_IDLE_WATCHDOG_SECRET_FILE`), then the stored `api.secret` setting. All empty means the API fails closed.
2. **401, scripts broke after plugin 1.2.0 or DSH 0.2.x:** the script still greps the secret out of `settings.yaml`. On DSH 0.2.x that file is renamed to `settings.yaml.imported` at the first boot, so such a reader finds nothing (often silently) and sends an empty or old secret.
3. **401, env wins:** env `DSH_IDLE_WATCHDOG_SECRET` is set for `dsh web`, so the file is ignored, but your script reads the file (or the other way round).
4. **401, rotated:** a changed file is picked up within about 5 seconds; a changed env value needs a restart of `dsh web`.
5. A trailing newline, quote or space in the header value.

**Diagnose** (read-only, never prints the secret)
```bash
curl -s <dsh-url>/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({secretSource:r.secretSource,envSecretPresent:r.envSecretPresent,secretFile:r.secretFile})})'
ls -l "${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret"        # expect -rw------- and size above 16
```
`secretSource: none` is cause 1. `env` means the process environment decides: your script must send that exact value. `file` means the file decides.

Test the secret WITHOUT sending a message (an empty body is rejected after authentication succeeds):
```bash
IW=${DSH_IDLE_WATCHDOG_SECRET:-$(cat "${DSH_IDLE_WATCHDOG_SECRET_FILE:-${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret}" 2>/dev/null)}
curl -s -o /dev/null -w '%{http_code}\n' -X POST <dsh-url>/dsh-idle-watchdog/api/prompt \
  -H 'content-type: application/json' -H "x-idle-watchdog-secret: $IW" -d '{"chat":"","message":""}'
```
`400` = the secret is accepted (nothing was delivered). `401` = wrong source or value. `503` = nothing configured. Do not echo `$IW`. Ten wrong tries per minute from one address lead to `429` ([entry 3](#t-rate-limited)).

**Fix**
- Cause 1 **[HUMAN]**: choose a long random secret (16 to 256 characters) and either save it in Settings, Idle Watchdog (this writes the file; on 0.2.x it never goes into the profile patch), or create the file yourself:
  ```bash
  install -d -m 0700 "${DSH_HOME:-$HOME/.dsh}/idle-watchdog"
  ( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret" )
  chmod 600 "${DSH_HOME:-$HOME/.dsh}/idle-watchdog/api-secret"
  ```
  That prints nothing and the value stays in the file. If you let a person pick the secret, they must not paste it into a chat.
- Cause 2: change the script to read env first, then the file, as in the probe above (`IW=${DSH_IDLE_WATCHDOG_SECRET:-$(cat ...api-secret)}`), and never grep `settings.yaml` any more. Keep the secret in the curl, never print it.
- Cause 3: make both sides use the same source; the simplest is to unset the env variable of `dsh web` **[HUMAN]** and use the file only.
- Cause 4: wait 5 seconds after a file change; restart `dsh web` **[HUMAN]** after an env change.

**Verify:** the probe above prints `400`.

**Related codes:** `WATCHDOG_SECRET_NOT_CONFIGURED`, `WATCHDOG_SECRET_INVALID`, `WATCHDOG_SECRET_LENGTH`.

<a id="t-rate-limited"></a>
## 3. 429 rate-limited

**Likely causes**
1. **Failed secrets:** 10 wrong secrets per minute from one source address pause that address (`WATCHDOG_AUTH_THROTTLED`, legacy `error` is also `rate-limited`). Typical: a cron job with an outdated secret reader looping every few seconds.
2. **Call budget:** more than `api.rateLimitPerMinute` (default 30) prompt calls per minute from one address (`WATCHDOG_RATE_LIMITED`).

**Diagnose**
```bash
curl -s "<dsh-url>/dsh-idle-watchdog/api/logs?n=60" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of JSON.parse(s).tail)if(/prompt-rejected/.test(JSON.stringify(l)))console.log(JSON.stringify(l))})'
```
Entries with reason `bad-secret` and `throttled: true` are cause 1; reason `rate-limit` is cause 2. The response carries the `code`, `retryAfterMs` and header `retry-after`.

**Fix**
- Cause 1: fix the caller's secret first ([entry 2](#t-secret)), then wait `retry-after` seconds. Waiting alone only works until the next wrong call.
- Cause 2: slow the caller down or batch messages. To allow more, raise `api.rateLimitPerMinute` (1 to 600) in Settings (live) **[HUMAN]** if the caller cannot be changed.

**Verify:** the probe from entry 2 prints `400` again.

**Related codes:** `WATCHDOG_AUTH_THROTTLED`, `WATCHDOG_RATE_LIMITED`.

<a id="t-prompt-chat"></a>
## 4. The prompt API cannot reach the chat (chat-not-found, ambiguous-chat, chat-not-live, subagent-owned)

`chat` is an exact session id, a UNIQUE id prefix of 6 or more characters (only among live or watched chats), or an exact chat title or Settings label (case-insensitive).

**Likely causes**
1. `404 chat-not-found`: typo, a title that is not exact, a prefix shorter than 6 characters, or a cold chat referenced by id prefix (prefixes only resolve among live or watched chats; a cold chat needs its FULL id). A title that was set only moments ago can also be missing until the catalog refreshes (about 15 seconds; `/api/chats?refresh` forces it).
2. `409 ambiguous-chat`: two chats share the title or the prefix; the `candidates` field lists up to 5 ids.
3. `409 chat-not-live`: the chat is not loaded and `wakeColdForApi` is off. Same legacy string with a hint starting `sessionController unavailable`: this DSH build cannot wake cold chats.
4. `403 subagent-owned`: the id belongs to a child session of a subagent.
5. `409 chat-not-resolvable` or `500 resolve-failed`: the host could not open the session.
6. `400` with `chat and non-empty message are required`: a field is empty or misspelled.

**Diagnose** (read-only)
```bash
curl -s "<dsh-url>/dsh-idle-watchdog/api/chats?refresh" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).rows)console.log(c.sessionId,JSON.stringify(c.title),"live="+c.live,"running="+c.running)})'
curl -s <dsh-url>/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("wakeColdForApi",JSON.parse(s).settings.wakeColdForApi))'
```
Find the chat in the first list and use its full `sessionId`. `live=false` plus `wakeColdForApi false` is cause 3.

**Fix**
- Cause 1 and 2: send the full session id.
- Cause 3: switch `wakeColdForApi` on in Settings (live) **[HUMAN]** (the decision whether outside callers may resume chats is theirs), or open the chat in the UI first.
- Cause 4: address the parent chat.
- Cause 5: open the chat in the web UI; if it does not load there, the stored session is the problem. Read `GET /logs` for `prompt-resolve-failed`.

**Verify:** repeat the call; `202` means delivered to a live chat, `200` means a cold chat was resumed first.

**Related codes:** `WATCHDOG_CHAT_NOT_FOUND`, `WATCHDOG_CHAT_AMBIGUOUS`, `WATCHDOG_CHAT_NOT_LIVE`, `WATCHDOG_RESOLVER_UNAVAILABLE`, `WATCHDOG_CHAT_SUBAGENT_OWNED`, `WATCHDOG_CHAT_NOT_RESOLVABLE`, `WATCHDOG_RESOLVE_FAILED`, `WATCHDOG_FOLLOWUP_FAILED`, `WATCHDOG_PROMPT_INVALID`, `WATCHDOG_BODY_INVALID`, `WATCHDOG_BODY_TOO_LARGE`.

<a id="t-no-nudges"></a>
## 5. Nudges never fire

Only chats you opted in are ever nudged, only while their agent is live and idle. `GET /api/next` shows, for every watched chat, whether it would nudge and the reason if not.

**Likely causes** (the `reason` field of `/api/next`)
1. The chat is NOT in the list at all: it was never opted in (Settings, Idle Watchdog, add the chat). There is no implicit watching.
2. `disabled`: master switch `enabled` is off. `chat-off`: this chat's switch is off.
3. `not-live`: the chat is not loaded. Cold chats are never woken for idle reasons (only the API wakes them).
4. `running`: a turn is in progress; a running agent is never interrupted.
5. `waiting`: the window has not elapsed yet. The clock starts at the LAST append of any kind, including the plugin's own previous nudge, and the window is `idleMinutes` (or the per-chat override) times `backoffFactor` to the power of the nudges already sent, capped by `backoffMaxMinutes`. After a restart a chat with no saved state starts its window at boot.
6. `cap-reached`: `maxNudges` nudges were sent without a human reply (0 means never nudge). A human message resets the count.
7. `goal-active`: `skipWhenGoalActive` is on and a goal round driver is armed for the chat.
8. `waiting-for-error`: `onlyAfterError` is on and no agent error was seen since the last human message. Errors are learned from a live event; one error allows one nudge.
9. `quiet-hours`: inside the daily window. It wraps midnight and uses the configured IANA zone, blank means the server's local time.

**Diagnose**
```bash
curl -s <dsh-url>/dsh-idle-watchdog/api/next | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("enabled",r.enabled,"quietNow",r.quietNow);for(const c of r.rows)console.log(c.sessionId,JSON.stringify(c.label),c.action,c.reason,c.dueAt?new Date(c.dueAt).toISOString():"-","window",c.windowMinutes+"m","nudges",c.nudgesSent+"/"+c.maxNudges)})'
curl -s "<dsh-url>/dsh-idle-watchdog/api/logs?n=40"
```
`action: nudge` with reason `due` means the next scan sends it (scan period `tickSeconds`, default 30, read at start). Ledger entries `nudge-sent`, `nudge-failed`, `cap-noticed` show what already happened.

**Fix**
- Cause 1, 2, 7, 8, 9: change the setting in Settings, Idle Watchdog (live) **[HUMAN]** because they are policy choices; do not flip them without asking.
- Cause 3: nothing to fix; open the chat to make it live.
- Cause 5: wait, or shorten `idleMinutes`.
- Cause 6: reply in the chat, or raise `maxNudges`.
- `WATCHDOG_TICK_FAILED` in the log on every scan: a plugin bug, report it.

**Verify:** `/api/next` shows `action: nudge` or a `dueAt` in the near future for the chat.

**Related codes:** `WATCHDOG_TICK_FAILED`, `WATCHDOG_STATE_WRITE_FAILED`.

<a id="t-too-many-nudges"></a>
## 6. Nudges fire too often

**Likely causes**
1. `idleMinutes` is short and `backoffFactor` is `1` (constant window, the default).
2. `maxNudges` is high; every nudge is a prompt that costs a model turn.
3. A per-chat `idleMinutes` or prompt override is more aggressive than the global setting.
4. The chat is also driven by a goal round driver and `skipWhenGoalActive` is off, so two mechanisms push it.
5. A second DSH install sharing the same chats and the same plugin row nudges too.

**Diagnose**
```bash
curl -s "<dsh-url>/dsh-idle-watchdog/api/logs?n=200" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of JSON.parse(s).tail){const t=JSON.stringify(l);if(/nudge-sent/.test(t))console.log(t)}})'
curl -s <dsh-url>/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s).settings;console.log({idleMinutes:x.idleMinutes,maxNudges:x.maxNudges,backoffFactor:x.backoffFactor,backoffMaxMinutes:x.backoffMaxMinutes,skipWhenGoalActive:x.skipWhenGoalActive,onlyAfterError:x.onlyAfterError,quietHours:x.quietHours})})'
```
The spacing between consecutive `nudge-sent` entries equals the effective window.

**Fix** (all in Settings, live, **[HUMAN]** because it is policy): raise `idleMinutes`, set `backoffFactor` to `2` and `backoffMaxMinutes` to a bound, lower `maxNudges`, enable `quietHours`, turn on `onlyAfterError` to nudge only after failures, and `skipWhenGoalActive` when a goal driver is in use. To stop one chat: switch it off in the chat table.

**Verify:** `/api/next` shows the new `windowMinutes` per chat.

<a id="t-settings-not-saved"></a>
## 7. Settings do not save, or reset (DSH 0.2.x)

**Likely causes**
1. `/status` shows `settingsStore: fallback-file`: the settings service or the schema library was not found, so values go to `${DSH_HOME:-$HOME/.dsh}/idle-watchdog/settings.json` instead of the DSH store.
2. On DSH 0.2.x the values belong to the profile row with entry id `idle-watchdog` (NOT the section name `dsh-idle-watchdog`) in `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml`. The form only works when the plugin's `Config` export is visible to the loader (the schema library comes from the running harness).
3. One-time legacy import: the core does not import the old `dsh-idle-watchdog` section of `settings.yaml` (the name differs from the entry id). The plugin does it itself at its first 0.2.x start, from `settings.yaml.imported` (or `settings.yaml`), only when the row holds no values, and moves the old `api.secret` into the secret file. Look for the log line `legacy settings import: imported` (or `already-configured`, `no-legacy-section`).
4. A script that rewrites `settings.yaml` after the migration makes the CORE re-import other plugins' sections at every boot and overwrite their rows. It does not affect this row, but it is a common cause of "settings reset".
5. A hand edit of the row YAML that is invalid, or a home patch or command-line overlay that sets the same key.
6. Saving through a script returns `403 csrf-guard` ([entry 9](#t-csrf-guard)) or `400 no-valid-settings-in-body` (every key was invalid or out of range).

**Diagnose**
```bash
curl -s <dsh-url>/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.settingsStore,r.settingsEntry)})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A25 -- '- id: idle-watchdog' "$D/profiles/web/cordis.patch.yml" | grep -v -i secret   # row (never paste it anywhere)
```
Expected: DSH 0.1.5 `settings`, DSH 0.2.x `profile-row` with an entry object naming `idle-watchdog`.

**Fix**
- Cause 1/2: use plugin 1.2.0 or newer, which supports both lines; confirm the plugin's own start line `settings via profile row idle-watchdog` in the `dsh web` log. If it says `settings via file`, restart `dsh web` after the install is complete **[HUMAN]**.
- Cause 3: nothing to do; to redo an import, empty the row's `config` values **[HUMAN]** and restart.
- Cause 4: stop the script that rewrites `settings.yaml`.
- Cause 5: back up the file (`cp file file.bak-$(date +%Y%m%d)`), fix the YAML, restart **[HUMAN]**.

**Verify:** change a value in Settings, then `/status` shows it and the row in `cordis.patch.yml` carries it (except the secret, which lives only in the secret file on 0.2.x).

**Related codes:** `WATCHDOG_SETTINGS_EMPTY`, `WATCHDOG_INIT_FAILED`.

<a id="t-new-options-no-effect"></a>
## 8. New options are visible but have no effect

**Cause:** the browser half hot-reloaded to the new version, the old server half is still running. Mixed versions are tolerated by design: against a 1.0 server the client hides the 1.1 options and shows a banner asking for a restart. The options of a newer server half (`skipWhenGoalActive`, `onlyAfterError`, backoff, quiet hours, `/api/next` from 1.1; the secret file and the `secretSource` field from 1.2) do nothing until the server half restarts, and the settings the form saves are only honoured as far as the running server understands them. Also: `tickSeconds` is read once when the plugin arms, so changing it needs a restart too.

**Diagnose**
```bash
curl -s <dsh-url>/dsh-idle-watchdog/api/health ; echo                          # version of the RUNNING server half
node -p "require('$P/package.json').version"                                   # installed version (P from section 0)
curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-idle-watchdog/api/next  # 404 = server half older than 1.1.0
```
Different versions, or `404` on `/next`, confirm it.

**Fix:** restart `dsh web` **[HUMAN]**; reload the browser tab.

**Verify:** `/health` shows the installed version and `/next` answers `200`.

<a id="t-csrf-guard"></a>
## 9. 403 csrf-guard when a script writes settings

`PUT /dsh-idle-watchdog/api/settings` and `POST /dsh-idle-watchdog/api/secret` are browser routes. They require header `X-Requested-With: dsh-idle-watchdog` and `Content-Type: application/json`, which a cross-site form cannot set. `POST /prompt` is the machine route and needs only the secret.

**Diagnose:** the response is `403` with `"code":"WATCHDOG_CSRF_GUARD"` and the exact header in its `hint`.

**Fix:** add both headers.
```bash
curl -s -X PUT <dsh-url>/dsh-idle-watchdog/api/settings \
  -H 'content-type: application/json' -H 'x-requested-with: dsh-idle-watchdog' \
  -d '{"idleMinutes":30}'
```
Prefer Settings in the UI for the secret; if a script sets it, read the new value from a file into the request body, do not type it on a command line (shell history).

**Verify:** the reply is `{"ok":true,...}`. Unknown keys are dropped; if nothing valid is left you get `WATCHDOG_SETTINGS_EMPTY`.

**Related codes:** `WATCHDOG_CSRF_GUARD`, `WATCHDOG_SETTINGS_EMPTY`, `WATCHDOG_SECRET_LENGTH`.

<a id="t-kill-switch"></a>
## 10. Stop all nudging (kill switch)

From the lightest to the heaviest:
1. Settings, Idle Watchdog: switch **Enabled** off. Live, no restart; the API keeps working. (`/next` then shows `disabled`.)
2. Per chat: switch the chat off in the chat table.
3. **[HUMAN]** set `DSH_IDLE_WATCHDOG_DISABLE=1` in the environment of `dsh web` and restart: the plugin arms nothing and mounts no routes (so the API answers 404).
4. **[HUMAN]** add to `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` and restart:
   ```yaml
   - id: idle-watchdog
     disabled: true
   ```
Undo by reversing the step. Verify with `/api/next` (step 1 and 2) or `/api/health` (steps 3 and 4: 404 means off).


## Common install problems on DSH

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example
`http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no tab, no settings, no tools)

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start;
(5) the entry is defined twice (`duplicate loader entry id`: a hand-written `insert` row in
the profile patch plus the package's own patch); (6) an old build without `dsh.bundle` in its
`package.json` (`declares no dsh.bundle`).

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-idle-watchdog' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-idle-watchdog" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'idle-watchdog' | head    # composed tree, does not boot
# DSH log: the terminal running `dsh web`, or your service manager, e.g.
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-idle-watchdog|idle-watchdog|incompatible|skipped|exemption|duplicate loader entry|declares no dsh.bundle' | tail -40
```

**Fix:** install with `dsh plugin --profile web add dsh-idle-watchdog` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`; override values with a plain
`- id: idle-watchdog` row, never a second `insert` row), then restart
`dsh web` **[HUMAN if your chat runs inside dsh web]**. If the log says the bundle
was skipped as incompatible, update the plugin; DSH 0.2.x also offers an exact-version
exemption (`dsh plugin allow-version`, see the log message), which must be granted
again after every DSH version change.

**Verify:** the Idle Watchdog section appears in Settings; `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-idle-watchdog/api/health` prints `200`.

Plugin specifics: the package has no `engines.dsh` field, so the 0.2.x compatibility gate falls through to the peer ranges; a refusal is rare. The entry id is `idle-watchdog` (the `name` export). If you set the kill switch (`DSH_IDLE_WATCHDOG_DISABLE=1` or a `disabled: true` row, see [entry 10](#t-kill-switch)), the plugin is intentionally not mounted and its routes answer 404.

<a id="c2-route-404"></a>
### C2. Every plugin route answers 404

**Causes:** the plugin's server half is not loaded (C1), or the kill switch is set (entry 10), or it was updated and the
running `dsh web` still has the old server code (the client half hot-reloads, the
server half loads only at start). A 404 on ONE path while others answer means a
wrong path, not a load problem.

**Diagnose**
```bash
for p in api/health api/status api/does-not-exist; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/dsh-idle-watchdog/$p)"; done
```
All 404 = route prefix not registered. `200` on health and status and a JSON `404` (`"error":"not-found"`) on the last = healthy.

**Fix:** restart `dsh web` **[HUMAN]**. If you open DSH through a browser login or a
reverse proxy, check the proxy forwards `/dsh-idle-watchdog/` to DSH. After a restart the
web UI may ask you to open the launch URL again (the one `dsh web` prints, with its
one-time token); that is expected and unrelated to plugin routes.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not save, or reset after a restart

**Causes by DSH line:**
- **0.1.5:** the plugin registers a settings namespace; values live in
  `$DSH_HOME/settings.yaml` under the plugin's section. A hand edit with a YAML error
  makes the whole file unreadable.
- **0.2.x:** settings are forms over the plugin's exported `Config`; values live in
  `$DSH_HOME/profiles/web/cordis.patch.yml` under the row `- id: idle-watchdog` `config:`.
  (a) Only fields marked live (`volatile`) are editable in forms; others are edited in
  the row and remount the plugin. (b) The loader reads `Config` from the DEFAULT export
  when the module has one: a plugin that exports `default { name, apply }` without
  `Config` gets no form. (c) A plugin that touches `ctx.settings` without declaring
  `inject: ['settings']` throws on 0.2.x. (d) A home patch or command-line overlay that
  sets the same key wins, and the form write is refused. (e) On first boot 0.2.x renames
  `settings.yaml` to `settings.yaml.imported` and imports only sections whose name equals
  an entry id with all keys declared live; a `settings.yaml` that reappears (a script
  rewriting it) is imported AGAIN at every boot and overwrites profile rows. This plugin's
  section is `dsh-idle-watchdog` but its entry id is `idle-watchdog`, so the core never
  imports it; the plugin imports it ITSELF once at its first 0.2.x start (from
  `settings.yaml.imported`, never over a row that already holds values) and moves the old
  `api.secret` into the 0600 secret file. See [entry 7](#t-settings-not-saved).

**Diagnose**
```bash
dsh --version
curl -s <dsh-url>/dsh-idle-watchdog/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({version:r.version,settingsStore:r.settingsStore,settingsEntry:r.settingsEntry,secretSource:r.secretSource})})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A12 -- '- id: idle-watchdog' "$D/profiles/web/cordis.patch.yml"   # 0.2.x row (may contain secrets: do not paste it anywhere)
```

**Fix:** use a plugin version that supports your DSH line (`settingsStore` in `/status` must be `settings` on 0.1.5 and `profile-row` on 0.2.x; `fallback-file` means the settings service was not found and values go to a JSON file instead). On 0.2.x stop any script that rewrites
`settings.yaml`, and edit non-live fields in the row. Back up the file before any hand
edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c4-gui-blank"></a>
### C4. After a DSH update the web UI does not render ("Failed to load plugins", blank page)

**Causes:** on 0.2.x an unmet REQUIRED client inject stops the whole GUI, not just one
plugin. Typical: a plugin requires `dsh-better-sidebar` (or another client service) and
that package was refused as too old for the new DSH. Older plugin builds that require
their sidebar host are affected; current ones inject it optionally.

**Diagnose:** browser devtools console (the first red error names the plugin), and the
DSH log for `skipped` / `incompatible` bundles (C1 command).

**Fix:** update `dsh-better-sidebar` (0.28 or newer for DSH 0.2.1) and the plugin;
or disable the failing bundle by row and restart **[HUMAN]**:
```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: idle-watchdog
  disabled: true
```

<a id="c5-model-404"></a>
### C5. After a DSH update every model turn fails (HTTP 404) for one provider

**Cause:** an environment variable such as `DEEPSEEK_BASE_URL` changed meaning between
DSH lines (0.1.5: plain API host; 0.2.x: the Anthropic-messages base, for example
`https://api.deepseek.com/anthropic`). Not a plugin bug, but it looks like one.

**Fix:** set the base URL the new line expects (env or the provider row), restart **[HUMAN]**.

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add dsh-idle-watchdog
# pnpm only: add --child-concurrency 1 to reduce peak memory
```
A runaway then kills only itself. Check afterwards that your other services are up.

<a id="c7-stale-client"></a>
### C7. UI shows new options but they do nothing, or "restart dsh web" banners

**Cause:** the client half (browser bundle) hot-reloaded, the server half did not. Mixed
versions are tolerated by design, but new server features stay off until a restart.
**Fix:** restart `dsh web` when convenient **[HUMAN]**; reload the browser tab.

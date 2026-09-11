# DSH-Idle-Watchdog — design

DeepSeek Harness web-profile plugin: watches chats, auto-prompts the ones that
go idle, and exposes a small secret-protected HTTP API that lets external
callers (cron jobs, other boxes, phones via the estate edge) inject a message
into a specific chat.

Built against this estate on **BlackServer**, 2026-09-11.

## 1. The infrastructure this rides (measured, not assumed)

| Need | Primitive | Where it lives |
|---|---|---|
| Enumerate every chat (live **and** persisted-cold) | `sessionQuery.listSessions(): SessionRecord[]`, `readTitleSnapshots(ids)` | `@deepseek-ai/dsh-session-query` |
| Live agents + status | `ctx.agents.list() / .get(id)`, `agent.status: 'idle' \| 'running'` | `agents` service (`dsh-agent-loop`) |
| Post into a chat | `agent.followup(UserMessage)` — queues a user-role message and opens a turn when idle | same |
| Wake a cold chat for an API prompt | `ctx.sessionController.resolveAgent(sessionId) → {agent} \| {error}` — the browser's own lazy-resume path | `@deepseek-ai/dsh-api-session-controller` |
| Folded notices (not fake user turns) | `session.append('user/message', {source:{kind:'plugin', form:'notice', summary}})` | `session/event` plane; precedent: `@weibaohui/dsh-continue` |
| Activity signal per chat | `ctx.on('session/event', (session, event) …)` — post-commit append feed | core |
| Settings persistence + live edits | `ctx.settings.register(ns, schemasterySchema, {applies:'live'}) → {get, update}` | `@deepseek-ai/dsh-settings` |
| HTTP surface | `ctx.webServer.register({kind:'prefix', path, handler(req,res)})` | `@deepseek-ai/dsh-host-webserver` |
| Settings-page UI | client slot `settings.section` + locale registry | `slots`/`locale` client services; precedent: `dsh-continue` client |
| State dir | `$DSH_HOME/idle-watchdog/` (`DSH_HOME=/home/lucagiftzek/.dsh`) | convention from dsh-continue |

Deployment shape (from `~/.dsh/profiles/web/`): the web server is
`dsh web --host 127.0.0.1 --port 3080`, composed from bundles listed in
`package.json` `dsh.profile.bundles`; local plugins are `link:` deps under
`/opt/stacks/llm/plugins/*` (dsh-artifacts, dsh-voice, dsh-session-pin,
dsh-model-picker-augmented). A plugin package contributes
`dsh.bundle.patch → cordis.patch.yml` inserting one host row. The public edge
is `llm.tzekos.eu` → Traefik (tz-auth forwardAuth) → `dsh-proxy.py` → dsh.

**Auth reality check**: the webServer mounts plugin routes *without any host
auth* (the CSRF lesson from this box's `dsh-genui` incident). Reaching them
from outside means passing tz-auth at the edge; on the box itself anything can
hit `127.0.0.1:3080`. Therefore the API's own secret is the *primary* control
for machine callers, and mutating UI endpoints get a CSRF guard
(`X-Requested-With` + JSON content-type).

## 2. Feature map

* **Idle nudge**: when a watched chat's last durable append is older than
  `idleMinutes`, post the configured prompt via `followup`, up to
  `maxNudges` per idle period; the counter resets when a *human* message
  arrives (`source.kind === 'user'`). Cadence: next nudge is measured from the
  last append — which includes the watchdog's own prompt — so no extra
  cooldown knob is needed.
* **Settings UI** (Settings page section): master switch, global window /
  cap / default prompt, per-chat table (enable, custom prompt, custom
  window), secret management, live status, activity log.
* **Per-chat opt-in**: a chat is only ever nudged when it has an enabled
  entry in `settings.chats`. No implicit watching of "all chats".
* **External API** `POST /dsh-idle-watchdog/api/prompt` with header
  `x-idle-watchdog-secret` (or `Authorization: Bearer`): body
  `{chat, message, provenance?}`. Chat resolved as exact id, ≥6-char unique
  id-prefix among live/watched chats, or exact title among live/watched chats.
  Cold chats are woken through `resolveAgent` (fail-closed 409 otherwise).
  Constant-time secret compare (sha256-then-`timingSafeEqual`), fail-closed
  when no secret exists, per-IP sliding-window rate limit, 64 KiB body cap,
  8000-char message cap, secret never echoed or logged (only a sha256
  fingerprint is shown).
* **Kill switches**: `- id: idle-watchdog / disabled: true` in
  `~/.dsh/profiles/web/cordis.patch.yml` (restart), or `DSH_IDLE_WATCHDOG_DISABLE=1`.

## 3. Storage

| What | Where | Why |
|---|---|---|
| Settings (incl. `chats[]`) | settings ns `dsh-idle-watchdog` → `settings.yaml`; fallback `$DSH_HOME/idle-watchdog/settings.json` if the settings service/schemastery is unavailable | survives restarts, hand-editable; fallback keeps the UI functional |
| Runtime watchdog state (lastActivity, nudge counters) | `$DSH_HOME/idle-watchdog/state.json`, atomic write, flushed ≤ every 60 s when dirty, pruned | continuity across restarts without reading durable logs |
| Audit ledger | `$DSH_HOME/idle-watchdog/activity.jsonl` rolling 512 KiB/2000 lines | `ctx.logger` is filtered; jsonl is the local convention |

The API secret resolves per request: **env `DSH_IDLE_WATCHDOG_SECRET` wins**,
then `settings.api.secret`, else fail-closed. So a secret can stay off disk.

## 4. Idle semantics, exactly

* "Idle" is only ever computed for **live** agents (`ctx.agents.get(sid)`),
  because only they can receive `followup` without waking state. A watched
  chat that is not live is skipped and marked `notLive` — never nudged, never
  error-logged.
* Every committed `session/event` append for a watched chat stamps
  `lastActivityAt = now` (model output, tool results, plugin prompts alike).
* A human `user/message` (`source.kind === 'user'`) additionally resets
  `nudgesSent` to 0 — a fresh idle period begins.
* A chat only nudges while its agent reports `status === 'idle'`; a `running`
  agent is working, not idle.
* On plugin boot, chats with no state start with `lastActivityAt = boot`
  (grace window — no boot storm).
* Reaching `maxNudges` posts one folded notice ("watchdog paused until you
  reply") — never a fake user turn.

## 5. HTTP surface

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /dsh-idle-watchdog/api/health` | none | liveness/version pill only |
| `GET /dsh-idle-watchdog/api/status` | none (no titles) | settings (secret masked), chat states, activity tail |
| `GET /dsh-idle-watchdog/api/chats` | none | picker list: sessions + titles + live/running flags |
| `PUT /dsh-idle-watchdog/api/settings` | `X-Requested-With` + JSON | save sanitized settings patch |
| `POST /dsh-idle-watchdog/api/secret` | `X-Requested-With` + JSON | set/clear API secret |
| `POST /dsh-idle-watchdog/api/prompt` | **secret** | external chat prompt (the API) |
| `GET /dsh-idle-watchdog/api/logs` | none | activity tail |

Route owns the full response; every reply is `application/json`, `no-store`.
Unknown sub-paths 404. No CORS headers are ever sent, so cross-origin JSON
POSTs fail preflight in browsers — same-origin UI + server-side callers only.

## 6. Failure posture

* No static import of anything that could drift at load (the 794-restart
  crash-loop lesson): core packages are reached only via `ctx.get()`,
  schemastery through a defensive require chain; `inject` is the minimal
  proven trio `['agents','settings','webServer']`.
* Every timer subscription is registered inside `ctx.effect` so stop/unload
  disposes it; intervals are `unref()`d.
* Handler exceptions answer 400/500 JSON, never throw into the webServer.
* `followup` throws are caught, traced, counted; a failing chat cannot stop
  the tick for others.
* All inputs length-capped and type-checked before use; chat ids validated
  against a safe charset; titles are display-only and never path inputs.

## 7. Files

```
lib/index.js   host half (watchdog engine + routes + settings)
lib/client.js  browser half — hand-written __ModuleLoader__ bundle, no build step
               (precedent: dsh-voice, dsh-model-picker-augmented)
test/run.mjs   pure-helper unit tests + fake-ctx boot/route smoke tests
```

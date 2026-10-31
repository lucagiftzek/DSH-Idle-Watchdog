# DSH-Idle-Watchdog

A [DeepSeek Harness](https://www.deepseek.com) (dsh) web-profile plugin that
watches your chats and keeps them moving:

* **Idle nudges** — when a chat you opted into has been silent for longer than
  your idle window, the watchdog posts a prompt *into that same chat* —
  personalised globally and per-chat — up to a cap of nudges per idle period.
  The moment you reply, the period resets. It never touches a chat that did
  not opt in, never nudges a running agent, and never wakes cold sessions for
  idle reasons.
* **External prompt API** — one small, secret-protected HTTP endpoint that
  lets *anything* (cron, another box, a phone script) inject a message into a
  specific chat by id, id-prefix, or exact title — waking cold chats through
  dsh's own resume path when needed.

Everything is configured in **Settings → Idle Watchdog** in the dsh web UI.

```
POST /dsh-idle-watchdog/api/prompt            ← the API (secret header)
  { "chat": "nightly report",
    "message": "Sweep finished — summarize the failures and propose fixes." }
→ 202 { "ok": true, "chat": "session-4c1760…", "via": "title", "resumed": false }
```

## Install (DSH web profile)

```bash
# 1. package is linked, not copied — keep the repo checked out where it lives
cd ~/.dsh/profiles/web
# 2. add to package.json:
#    "dependencies": { … "dsh-idle-watchdog": "link:/opt/stacks/llm/plugins/DSH-Idle-Watchdog" … }
#    "dsh": { "profile": { "bundles": [ …, "dsh-idle-watchdog" ] } }
pnpm install
# 3. restart dsh-web — the host composition is mounted at boot only
```

Or with the official installer if you prefer registry flow once published:
`dsh plugin --profile web add link:/opt/stacks/llm/plugins/DSH-Idle-Watchdog`.

After restart, reload the web UI: the **Idle Watchdog** card appears in
Settings (client half mounts live via the patch reload; host half needs the
restart above).

## Configuration (Settings → Idle Watchdog)

| Field | Meaning | Default |
|---|---|---|
| Enabled | Master switch (per-chat opt-in still required) | on |
| Idle window | Minutes of silence before a nudge | 20 |
| Max nudges | Nudges per idle period; your reply refills the budget | 3 |
| Default prompt | What gets posted when a chat has no own prompt | *(English nudge)* |
| Watched chats | Per chat: on/off, personal prompt, personal window | none watched |
| API secret | Shared secret for the external prompt API | unset → API fails closed |
| API rate limit | Prompt calls per minute per source IP | 30 |
| Wake cold chats | Allow the API to resume a session that is not live | on |

Settings persist in the `dsh-idle-watchdog` namespace of
`~/.dsh/settings.yaml` (hand-editable, applies live). If the settings service
is ever unavailable, the plugin transparently falls back to
`~/.dsh/idle-watchdog/settings.json` — the `/status` endpoint reports which
store is active.

## The API

`POST /dsh-idle-watchdog/api/prompt` — JSON body:

| Field | Required | Notes |
|---|---|---|
| `chat` | yes | exact session id, **unique** id prefix (≥6 chars, live/watched chats), or exact chat title / UI label |
| `message` | yes | ≤ 8000 chars, becomes a user-role message (`source.kind: "plugin"`, plugin `dsh-idle-watchdog`) |
| `provenance` | no | ≤ 80-char free label recorded in the audit ledger (e.g. `cron-backup`) |

Auth header (one of): `x-idle-watchdog-secret: <secret>` or
`Authorization: Bearer <secret>`.

Responses: `202` delivered to live chat · `200` delivered after resuming a
cold chat · `400` validation · `401` wrong secret (≥10/min/IP before
throttling to `429`) · `403` subagent-owned chat · `404` unknown chat ·
`409` ambiguous/undeliverable · `503` no secret configured (fail-closed).

The route is loopback (`127.0.0.1:3080`); if you expose it through a reverse
proxy it should also sit behind your login proxy (for example a forward-auth
gate). From another box with ssh to your DSH host:

```bash
ssh your-dsh-host 'curl -sS -X POST http://127.0.0.1:3080/dsh-idle-watchdog/api/prompt \
  -H "content-type: application/json" \
  -H "x-idle-watchdog-secret: $IW_SECRET" \
  -d "{\"chat\":\"ops triage\",\"message\":\"Recheck the queue and alert on regressions.\"}"'
```

A browser cross-site JSON POST to `/prompt` is impossible without knowing the
secret (custom header ⇒ CORS preflight ⇒ no CORS headers are ever sent);
UI-mutating endpoints additionally require `X-Requested-With:
dsh-idle-watchdog` + `content-type: application/json` (CSRF guard). Bodies are
capped at 64 KiB. The secret is compared in constant time (sha256-then-
`timingSafeEqual`); only its first 8 hex fingerprint is ever displayed or
logged. Set `DSH_IDLE_WATCHDOG_SECRET` in the dsh-web environment to keep the
secret off disk entirely (env wins over the stored one).

## Nudge semantics in one paragraph

Idle = *live agent, `status: idle`, and the last durable append to the chat is
older than the window*. The window measures from **any** append — assistant
output, tool results, the watchdog's own prompt — so cadence after a nudge is
automatically “another full window of silence”. A human `user/message` resets
the nudge counter; reaching the cap posts one folded *notice* (not a fake
user turn) and waits for you. State survives restarts
(`~/.dsh/idle-watchdog/state.json`, atomic writes); the audit ledger is
`~/.dsh/idle-watchdog/activity.jsonl` (rolling, 512 KiB).

## Ops

```bash
curl -sS http://127.0.0.1:3080/dsh-idle-watchdog/api/health   # liveness
curl -sS http://127.0.0.1:3080/dsh-idle-watchdog/api/status   # full state, masked secret
curl -sS http://127.0.0.1:3080/dsh-idle-watchdog/api/logs     # ledger tail
```

* **Pause without restart** — toggle *Enabled* in Settings (live).
* **Kill switch** — `~/.dsh/profiles/web/cordis.patch.yml`:
  `- id: idle-watchdog` / `disabled: true`, then restart dsh-web.
* **Off entirely** — `DSH_IDLE_WATCHDOG_DISABLE=1` in the dsh-web env.

## Internals

See [docs/DESIGN.md](docs/DESIGN.md): the exact host services this rides
(`agents`, `sessionQuery`, `sessionController.resolveAgent`, `webServer`,
`settings`), the failure posture (defensive schemastery load, `ctx.get()`
optional services, unref'd timers under `ctx.effect`), and why cold chats are
API-only.

## Development

```bash
pnpm install        # once — pulls @deepseek-ai/schemastery (peer of dsh-settings)
npm test            # pure-helper units + fake-ctx boot + nudge-loop integration
```

License: MIT.

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If this plugin is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.

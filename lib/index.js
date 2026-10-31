/**
 * DSH-Idle-Watchdog, host half.
 *
 * Two jobs, one engine:
 *
 *  1. IDLE NUDGES. A chat the user opted into is watched; when its last
 *     durable append is older than the configured window and its agent is
 *     idle, the watchdog posts the configured prompt into the SAME live
 *     session via `agent.followup(...)`, up to `maxNudges` times per idle
 *     period. A human reply reopens the period. Everything is opt-in per
 *     chat; nothing is ever sent to a chat that did not ask for it.
 *
 *  2. EXTERNAL PROMPT API. `POST /dsh-idle-watchdog/api/prompt` with an
 *     `x-idle-watchdog-secret` header (or `Authorization: Bearer`) injects
 *     `{chat, message}` into one chat, the same followup path, but
 *     caller-driven. Secret is compared in constant time, the whole surface
 *     fails closed without a configured secret, and calls are rate-limited
 *     per source IP. This is the machine-entry point crons and other boxes
 *     use; the socket itself is loopback-bound and a public edge should
 *     additionally sit behind your login proxy, so the secret is defense at
 *     the last remaining open layer (DSH runs unauthenticated plugin
 *     routes, see the DSH plugin routes CSRF note).
 *
 * WHY THIS SHAPE (measured on this box, 2026-09-11):
 *
 *  - `agent.followup` is the only supported "send into a live session"
 *    primitive that respects turn boundaries (it queues through the agent's
 *    inbox); see @weibaohui/dsh-continue, the working in-production precedent
 *    for event-driven prompting on this exact host.
 *  - Cold (persisted, unmounted) chats are woken ONLY for explicit API
 *    prompts, through the browser's own lazy path `sessionController
 *    .resolveAgent`. The idle nudge never touches cold chats: a chat nobody
 *    mounted is not "idle", it is gone, and auto-mounting hundreds of agents
 *    at boot would be a resource disaster (see your host's RAM margins).
 *  - The host composition is boot-loaded and a throwing plugin entry takes
 *    the WHOLE app down (this box crash-looped 794 times on 2026-09-08 the
 *    hard way). So: static `inject` is the minimal proven trio
 *    ['agents','settings','webServer']; every other core service is read via
 *    optional `ctx.get()`; schemastery is resolved defensively and the plugin
 *    still boots (with a JSON file fallback store) when it is absent.
 *
 * KILL SWITCH: add to ~/.dsh/profiles/web/cordis.patch.yml
 *     - id: idle-watchdog
 *       disabled: true
 *   and restart dsh-web, or set DSH_IDLE_WATCHDOG_DISABLE=1 in its env.
 *
 * Docs: README.md (usage + API), docs/DESIGN.md (internals + contracts).
 */

'use strict'

// Only node builtins + the profile's schemastery are imported, and the
// latter defensively (see loadSchemastery). No @deepseek-ai/* static import:
// those drift between releases and a failed import at load bricks boot.
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import fsP from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

export const name = 'idle-watchdog'
export const inject = ['agents', 'settings', 'webServer']

// ── Identity ──────────────────────────────────────────────────────────────
export const PLUGIN_ID = 'dsh-idle-watchdog'   // settings ns, message source, route prefix, audit label
const ROW_ID = 'idle-watchdog'                 // cordis row id (kill-switch handle)
const SETTINGS_NS = PLUGIN_ID                  // must match /^[a-z][a-z0-9-]*$/ (settings channel rule)
const API_PREFIX = '/' + PLUGIN_ID + '/api'
const SECRET_ENV = 'DSH_IDLE_WATCHDOG_SECRET'
const DISABLE_ENV = 'DSH_IDLE_WATCHDOG_DISABLE'
const VERSION = '1.1.0'

// ── Defaults ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: true,             // master switch (per-chat opt-in still required)
  idleMinutes: 20,           // silence window before a nudge
  maxNudges: 3,              // nudges per idle period; human reply resets
  tickSeconds: 30,           // scan cadence
  defaultPrompt: 'You have been quiet for a while, anything you would like me to continue or pick up next?',
  notifyOnCap: true,         // folded notice when the per-period cap is hit
  wakeColdForApi: true,      // API prompts may resume a cold chat
  api: {
    rateLimitPerMinute: 30,  // per source IP, prompt endpoint
  },
  chats: [],                 // [{id, label, enabled, prompt, idleMinutes}]
  // v1.1 additions. Every default reproduces the v1.0 behaviour exactly.
  skipWhenGoalActive: false, // do not nudge a chat whose goal-round driver is armed and active
  onlyAfterError: false,     // nudge only after an agent/error since the last human message
  backoffFactor: 1,          // 1 = constant window; 2 = window doubles after each nudge
  backoffMaxMinutes: 0,      // 0 = no cap on the backed-off window
  quietHours: {              // no idle nudges inside this daily window (API prompts unaffected)
    enabled: false,
    start: '22:00',
    end: '07:00',
    timezone: '',            // '' = server local time, else an IANA zone such as Europe/Berlin
  },
}

// Hard bounds, independent of anything the client UI renders, curl exists.
const LIMITS = {
  idleMinutes: [1, 7 * 24 * 60],
  maxNudges: [0, 20],
  tickSeconds: [5, 3600],
  backoffFactor: [1, 10],
  backoffMaxMinutes: [0, 7 * 24 * 60],
  windowCeilMinutes: 366 * 24 * 60,   // hard ceiling on a backed-off window
  promptChars: 8000,
  labelChars: 200,
  chatsMax: 200,
  secretMin: 16,
  secretMax: 256,
  summaryChars: 120,         // CONTEXT_SUMMARY_MAX_CHARS in dsh-llm
  bodyBytes: 64 * 1024,
  idChars: 200,
}

const STATE_KEEP_MS = 30 * 24 * 60 * 60 * 1000  // prune unwatched state older than this
const STATE_FLUSH_MS = 60 * 1000
const ACTIVITY_MAX_BYTES = 512 * 1024
const ACTIVITY_KEEP_LINES = 2000
const ACTIVITY_TAIL_LINES = 30
const CHATS_LIST_MAX = 300
const PREFIX_MIN_LEN = 6                       // id-prefix resolution must be >= this
const ID_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const PROVENANCE_RE = /^[A-Za-z0-9 ._:/@#()<>{}=\[\]-]{1,80}$/

// ── Module-level state created in apply() (per-fiber; disposed on unload) ─
function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }
function displayPath(p) {
  const home = homedir()
  return p === home ? '~' : p.startsWith(home + sep) ? '~' + p.slice(home.length) : p
}

/**
 * Resolve the profile's schemastery copy defensively.
 *
 * dsh-settings demands a schemastery schema (callable + toJSON; zod is
 * rejected at register). The package ships in the web profile's node_modules,
 * but a plain static `import` that ever fails to resolve is a boot-killing
 * SyntaxError, not a degradation. So: candidate paths first (explicit env
 * override for exotic installs, global-prefix copies, then standard
 * resolution from this file, which works once the declared dependency is
 * installed), and `null` on total failure, apply() then runs in
 * fallback-store mode instead of taking the UI down.
 */
function loadSchemastery() {
  const req = require_()
  const candidates = []
  if (process.env.DSH_SCHEMASTERY_ENTRY) candidates.push(process.env.DSH_SCHEMASTERY_ENTRY)
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    candidates.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
  }
  for (const c of candidates) {
    try { if (req.existsSync(c)) return createRequire(c)(c) } catch {}
  }
  try { return createRequire(import.meta.url)('@deepseek-ai/schemastery') } catch {}
  return null
}
// createRequire needs a filename; inside ESM we also need fs.existsSync for
// candidate probing, which is cheaper required on demand than imported.
function require_() {
  const r = createRequire(import.meta.url)
  r.existsSync = (p) => { try { r('node:fs').accessSync(p); return true } catch { return false } }
  return r
}

/** settings schema; null when schemastery is unavailable. */
function settingsSchema(z) {
  if (!z) return null
  return z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    idleMinutes: z.number().min(1).default(DEFAULTS.idleMinutes),
    maxNudges: z.number().min(0).default(DEFAULTS.maxNudges),
    tickSeconds: z.number().min(5).default(DEFAULTS.tickSeconds),
    defaultPrompt: z.string().default(DEFAULTS.defaultPrompt),
    notifyOnCap: z.boolean().default(DEFAULTS.notifyOnCap),
    wakeColdForApi: z.boolean().default(DEFAULTS.wakeColdForApi),
    skipWhenGoalActive: z.boolean().default(DEFAULTS.skipWhenGoalActive),
    onlyAfterError: z.boolean().default(DEFAULTS.onlyAfterError),
    backoffFactor: z.number().min(1).default(DEFAULTS.backoffFactor),
    backoffMaxMinutes: z.number().min(0).default(DEFAULTS.backoffMaxMinutes),
    quietHours: z.object({
      enabled: z.boolean().default(false),
      start: z.string().default('22:00'),
      end: z.string().default('07:00'),
      timezone: z.string().default(''),
    }).default({ enabled: false, start: '22:00', end: '07:00', timezone: '' }),
    api: z.object({
      rateLimitPerMinute: z.number().min(1).default(DEFAULTS.api.rateLimitPerMinute),
      /** Empty = rely on env, or fail closed. Read is always masked. */
      secret: z.string().default(''),
    }).default({ rateLimitPerMinute: DEFAULTS.api.rateLimitPerMinute, secret: '' }),
    chats: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      enabled: z.boolean().default(true),
      prompt: z.string().default(''),        // '' = defaultPrompt
      idleMinutes: z.number().default(0),     // 0 = global window
    })).default([]),
  })
}

// ── Pure helpers (exported through __internals; unit-tested in test/run.mjs) ─

/** Trim any string field to a cap, non-strings become ''. */
function str(v, cap) { return typeof v === 'string' ? v.slice(0, cap) : '' }

/**
 * Validate + sanitize one per-chat entry. Returns null when unusable.
 * The chat id is kept exactly as given (ids on this host are `brandString`s,
 * e.g. "session-…", but any safe charset up to idChars is accepted).
 */
function sanitizeChatEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = str(entry.id, LIMITS.idChars).trim()
  if (!id || !ID_SAFE_RE.test(id)) return null
  return {
    id,
    label: str(entry.label, LIMITS.labelChars),
    enabled: entry.enabled !== false,
    prompt: str(entry.prompt, LIMITS.promptChars),
    idleMinutes: Number.isFinite(entry.idleMinutes) && entry.idleMinutes >= 1 && entry.idleMinutes <= LIMITS.idleMinutes[1]
      ? Math.floor(entry.idleMinutes) : 0,
  }
}

/**
 * Build a sanitized settings patch from a raw PUT body. Unknown keys drop;
 * out-of-bound numerics clamp; malformed chats are individually discarded.
 * `secret` is intentionally NOT accepted here, only POST /secret writes it,
 * so it can never echo through a status GET that mirrors `settings`.
 */
function sanitizeSettingsPatch(body) {
  const patch = {}
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return patch
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.notifyOnCap === 'boolean') patch.notifyOnCap = body.notifyOnCap
  if (typeof body.wakeColdForApi === 'boolean') patch.wakeColdForApi = body.wakeColdForApi
  if (Number.isFinite(body.idleMinutes)) patch.idleMinutes = clamp(body.idleMinutes, ...LIMITS.idleMinutes)
  if (Number.isFinite(body.maxNudges)) patch.maxNudges = clamp(body.maxNudges, ...LIMITS.maxNudges)
  if (Number.isFinite(body.tickSeconds)) patch.tickSeconds = clamp(body.tickSeconds, ...LIMITS.tickSeconds)
  if (typeof body.defaultPrompt === 'string' && body.defaultPrompt.trim() !== '') {
    patch.defaultPrompt = body.defaultPrompt.slice(0, LIMITS.promptChars)
  }
  if (typeof body.skipWhenGoalActive === 'boolean') patch.skipWhenGoalActive = body.skipWhenGoalActive
  if (typeof body.onlyAfterError === 'boolean') patch.onlyAfterError = body.onlyAfterError
  if (Number.isFinite(body.backoffFactor)) patch.backoffFactor = clampFactor(body.backoffFactor)
  if (Number.isFinite(body.backoffMaxMinutes)) patch.backoffMaxMinutes = clamp(body.backoffMaxMinutes, ...LIMITS.backoffMaxMinutes)
  if (body.quietHours && typeof body.quietHours === 'object' && !Array.isArray(body.quietHours)) {
    const q = sanitizeQuietHoursPatch(body.quietHours)
    if (Object.keys(q).length) patch.quietHours = q
  }
  if (body.api && typeof body.api === 'object' && !Array.isArray(body.api)) {
    const api = {}
    if (Number.isFinite(body.api.rateLimitPerMinute)) api.rateLimitPerMinute = clamp(body.api.rateLimitPerMinute, 1, 600)
    if (Object.keys(api).length) patch.api = api
  }
  if (Array.isArray(body.chats)) {
    const seen = new Set()
    const chats = []
    for (const c of body.chats.slice(0, LIMITS.chatsMax)) {
      const e = sanitizeChatEntry(c)
      if (!e || seen.has(e.id)) continue
      seen.add(e.id)
      chats.push(e)
    }
    patch.chats = chats
  }
  return patch
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, Math.floor(n))) }

/** Backoff factor keeps one decimal (1.5 is meaningful); bounded to LIMITS. */
function clampFactor(n) {
  const [min, max] = LIMITS.backoffFactor
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10))
}

/** "HH:MM" -> minutes since midnight, or null when malformed. */
function parseClock(v) {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h <= 23 && mi <= 59 ? h * 60 + mi : null
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '') return ''
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return ''
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz } catch { return '' }
}

/** Sanitize a quiet-hours object: bad clocks fall back to defaults, bad zone to local. */
function normalizeQuietHours(q) {
  const d = DEFAULTS.quietHours
  const v = q && typeof q === 'object' ? q : {}
  const pad = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0')
  const a = parseClock(v.start), b = parseClock(v.end)
  return {
    enabled: v.enabled === true,
    start: a === null ? d.start : pad(a),
    end: b === null ? d.end : pad(b),
    timezone: validTimeZone(v.timezone),
  }
}

/**
 * Partial quiet-hours patch from a PUT body: only fields that are present AND
 * valid survive, so a typo ("23.30", "Europe/Berln") keeps the stored value
 * instead of silently resetting it to the default; the caller merges the
 * result over the current object (a partial curl PUT must not wipe the rest).
 */
function sanitizeQuietHoursPatch(q) {
  const out = {}
  if (typeof q.enabled === 'boolean') out.enabled = q.enabled
  for (const k of ['start', 'end']) {
    const m = parseClock(q[k])
    if (m !== null) out[k] = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  }
  if (typeof q.timezone === 'string') {
    const tz = q.timezone.trim()
    if (tz === '') out.timezone = ''
    else if (validTimeZone(tz)) out.timezone = tz
  }
  return out
}

/** Minutes since local midnight for `now` in the given zone ('' = server local). */
function minutesOfDay(now, timezone) {
  const date = new Date(now)
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
      const hh = Number(parts.find((p) => p.type === 'hour').value), mm = Number(parts.find((p) => p.type === 'minute').value)
      return (hh % 24) * 60 + mm
    } catch {}
  }
  return date.getHours() * 60 + date.getMinutes()
}

/** Is `now` inside the quiet window? Wraps midnight when start > end; start == end means never. */
function inQuietHours(now, q) {
  if (!q || q.enabled !== true) return false
  const a = parseClock(q.start), b = parseClock(q.end)
  if (a === null || b === null || a === b) return false
  const cur = minutesOfDay(now, validTimeZone(q.timezone))
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b)
}

/** Settings view safe to hand to the browser: secret replaced by fingerprint. */
function safeSettings(eff) {
  return {
    enabled: eff.enabled, idleMinutes: eff.idleMinutes, maxNudges: eff.maxNudges,
    tickSeconds: eff.tickSeconds, defaultPrompt: eff.defaultPrompt,
    notifyOnCap: eff.notifyOnCap, wakeColdForApi: eff.wakeColdForApi,
    skipWhenGoalActive: eff.skipWhenGoalActive, onlyAfterError: eff.onlyAfterError,
    backoffFactor: eff.backoffFactor, backoffMaxMinutes: eff.backoffMaxMinutes,
    quietHours: { ...eff.quietHours },
    api: { rateLimitPerMinute: eff.api.rateLimitPerMinute, secret: eff.api.secret ? '***' : '', secretFingerprint: secretFingerprint(eff.api.secret) },
    chats: eff.chats.map((c) => ({ ...c })),
  }
}

/** sha256 fingerprint (first 8 hex), display-only; '' when unset. */
function secretFingerprint(secret) {
  if (typeof secret !== 'string' || secret === '') return ''
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Constant-time secret compare. Both sides are hashed first so lengths never
 * leak through timingSafeEqual's short-circuit on unequal lengths.
 * Env secret wins over the stored one (so a secret can stay off disk).
 */
function secretEquals(presented, configured) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  if (typeof configured !== 'string' || configured.length === 0) return false
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(configured, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Pull the candidate secret out of request headers (both accepted forms). */
function presentedSecret(headers) {
  const direct = headers['x-idle-watchdog-secret']
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim().slice(0, 512)
  const auth = headers.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    const m = auth.replace(/^bearer\s+/i, '').trim()
    if (m) return m.slice(0, 512)
  }
  return ''
}

/** Per-IP sliding-minute limiter. Pure-ish closure; clock injectable for tests. */
function makeRateLimiter(limitsFn, clock = () => Date.now()) {
  const hits = new Map() // ip -> number[] (ms timestamps within window)
  return {
    /** @returns {ok, retryAfterMs} */
    take(ip) {
      const now = clock()
      const limit = limitsFn()
      const windowMs = 60_000
      let arr = hits.get(ip)
      if (!arr) { arr = []; hits.set(ip, arr) }
      // drop stale + cap runaway memory (an attacker cannot widen the array
      // beyond limit+1 per window because over-limit is rejected un-pushed)
      const fresh = arr.filter((t) => now - t < windowMs)
      if (fresh.length >= limit) {
        hits.set(ip, fresh)
        return { ok: false, retryAfterMs: Math.max(50, windowMs - (now - fresh[0])) }
      }
      fresh.push(now)
      hits.set(ip, fresh)
      if (hits.size > 4096) { // trim map pressure from spoofed-ip floods
        for (const [k, v] of hits) { if (now - (v[v.length - 1] ?? 0) >= windowMs) hits.delete(k) }
      }
      return { ok: true, retryAfterMs: 0 }
    },
    reset() { hits.clear() },
  }
}

/** Resolve one requested chat reference against known shapes. Pure. */
function resolveChatRef(ref, ctxLists) {
  const { liveIds, watched, titleIndex } = ctxLists
  const needle = typeof ref === 'string' ? ref.trim() : ''
  if (!needle) return { kind: 'invalid' }
  // 1) exact id, any session we know of
  if (ctxLists.knownIds.has(needle)) return { kind: 'exact', id: needle }
  // 2) unique id-prefix, but only over live + watched chats (never the whole
  //    persisted corpus, so a short prefix cannot be ambiguous against cold noise)
  if (needle.length >= PREFIX_MIN_LEN) {
    const pool = new Set([...liveIds, ...watched.map((c) => c.id)])
    const hits = [...pool].filter((id) => id.startsWith(needle))
    if (hits.length === 1) return { kind: 'prefix', id: hits[0] }
    if (hits.length > 1) return { kind: 'ambiguous', ids: hits.slice(0, 5) }
  }
  // 3) exact title among live/watched chats (titles are what humans know)
  const byTitle = titleIndex.get(needle.toLowerCase())
  if (byTitle && byTitle.length === 1) return { kind: 'title', id: byTitle[0] }
  if (byTitle && byTitle.length > 1) return { kind: 'ambiguous', ids: byTitle.slice(0, 5) }
  return { kind: 'unknown' }
}

/** Fresh per-chat runtime state. */
function newState(now) {
  return { lastActivityAt: now, nudgesSent: 0, lastNudgeAt: null, notLive: false, cappedNoticed: false, errorAt: null, lastOutcome: null }
}

/** Is this appended event a HUMAN user message? (nudge counter resets on it) */
function isHumanUserMessage(event) {
  if (!event || event.type !== 'user/message') return false
  const data = event.data
  if (!data || typeof data !== 'object') return false
  // tool results are their own event type; anything without an explicit human
  // source (older rows) is treated as human so a reset is never missed.
  return !data.source || typeof data.source !== 'object' || data.source.kind === undefined || data.source.kind === 'user'
}

/**
 * Window (ms) a chat must stay silent before its NEXT nudge. With the default
 * backoffFactor of 1 this is the plain idle window; with a factor f the n-th
 * nudge waits window * f^n (n = nudges already sent this period), optionally
 * capped by backoffMaxMinutes.
 */
function nudgeWindowMs(entry, st, eff) {
  const baseMin = entry && entry.idleMinutes > 0 ? entry.idleMinutes : eff.idleMinutes
  const factor = Number.isFinite(eff.backoffFactor) && eff.backoffFactor > 1 ? eff.backoffFactor : 1
  // Exponent bounded by the nudge-cap ceiling (a corrupt state file must not
  // reach Infinity), window by one year: finite, JSON-safe, still "never".
  const n = Math.min(LIMITS.maxNudges[1], Math.max(0, Number.isFinite(st.nudgesSent) ? st.nudgesSent : 0))
  let min = Math.min(baseMin * Math.pow(factor, n), LIMITS.windowCeilMinutes)
  if (eff.backoffMaxMinutes > 0) min = Math.min(min, Math.max(baseMin, eff.backoffMaxMinutes))
  return Math.round(min * 60_000)
}

/**
 * Full, explainable decision for one watched chat. Pure. The same function
 * drives the tick (action 'nudge') and the preview endpoint / Settings table
 * (reason + dueAt), so what the UI predicts is what the tick does.
 * @returns {action: 'nudge'|'wait', reason: string, dueAt: number|null, windowMs: number, prompt?: string}
 * reasons: disabled, chat-off, cap-reached, not-live, running, goal-active,
 *          waiting-for-error, waiting (window not elapsed), quiet-hours, due
 */
function evaluateChat({ now, entry, st, eff, agentLive, agentStatus, goalActive }) {
  const windowMs = entry ? nudgeWindowMs(entry, st, eff) : 0
  const dueAt = entry ? st.lastActivityAt + windowMs : null
  const wait = (reason) => ({ action: 'wait', reason, dueAt, windowMs })
  if (!eff.enabled) return wait('disabled')
  if (!entry || entry.enabled === false) return wait('chat-off')
  if (!agentLive) return wait('not-live')
  if (agentStatus === 'running') return wait('running')
  if (eff.maxNudges <= 0 || st.nudgesSent >= eff.maxNudges) return wait('cap-reached')
  if (eff.skipWhenGoalActive && goalActive) return wait('goal-active')
  if (eff.onlyAfterError && !st.errorAt) return wait('waiting-for-error')
  if (now < dueAt) return wait('waiting')
  if (inQuietHours(now, eff.quietHours)) return wait('quiet-hours')
  return { action: 'nudge', reason: 'due', dueAt, windowMs, prompt: (entry.prompt && entry.prompt.trim()) ? entry.prompt : eff.defaultPrompt }
}

/**
 * Core nudge decision for one watched chat at tick time (v1.0 contract kept).
 * @returns null (do nothing) | {prompt: string}
 */
function decideNudge(args) {
  const r = evaluateChat(args)
  return r.action === 'nudge' ? { prompt: r.prompt } : null
}

/** Read the tail of the rolling activity ledger as parsed objects. */
async function readActivityTail(file, n = ACTIVITY_TAIL_LINES) {
  try {
    const raw = await fsP.readFile(file, 'utf8')
    const lines = raw.trimEnd().split('\n').filter(Boolean)
    const out = []
    for (const l of lines.slice(-n)) { try { out.push(JSON.parse(l)) } catch {} }
    return out
  } catch { return [] }
}

/** Append-only JSONL ledger with rolling truncation, the plugin keeps its
 *  own operational record instead of the host logger (house convention). */
function makeTracer(file) {
  let approxSize = -1
  return (event, data = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
    fsP.mkdir(join(file, '..'), { recursive: true })
      .then(() => fsP.appendFile(file, line, 'utf8'))
      .then(() => {
        if (approxSize < 0) { approxSize = 0; return fsP.stat(file).then((s) => { approxSize = s.size }).catch(() => {}) }
        approxSize += line.length
        if (approxSize <= ACTIVITY_MAX_BYTES) return
        approxSize = 0
        return fsP.readFile(file, 'utf8')
          .then((raw) => atomicWriteFile(file, raw.trimEnd().split('\n').slice(-ACTIVITY_KEEP_LINES).join('\n') + '\n'))
      })
      .catch(() => {})
  }
}

async function atomicWriteFile(file, content) {
  const dir = join(file, '..')
  await fsP.mkdir(dir, { recursive: true })
  const temp = join(dir, `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content)
  await fsP.rename(temp, file)
}

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > LIMITS.bodyBytes) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** CSRF guard for browser-mutation endpoints: a cross-origin form can neither
 *  set this header nor a strict JSON content-type without a CORS preflight,
 *  and this route answers no preflight. The machine endpoint (/prompt) is
 *  protected by the secret itself and needs no header gate. */
function csrfOk(req) {
  return req.headers['x-requested-with'] === PLUGIN_ID &&
    String(req.headers['content-type'] || '').split(';')[0].trim() === 'application/json'
}

// ── The plugin ─────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const boot = Date.now()
  const pluginDir = join(dshHome(), 'idle-watchdog')
  const activityFile = join(pluginDir, 'activity.jsonl')
  const stateFile = join(pluginDir, 'state.json')
  const fallbackSettingsFile = join(pluginDir, 'settings.json')
  const trace = makeTracer(activityFile)
  const log = (m) => { console.log(`idle-watchdog: ${m}`) }
  const warn = (m) => { console.error(`idle-watchdog: ${m}`) }

  // Hard kill switch without touching the composition.
  if (process.env[DISABLE_ENV] === '1') {
    trace('disabled-by-env', { pid: process.pid })
    log(`${DISABLE_ENV}=1, armed off`)
    return
  }

  // ── settings store (service primary, JSON file fallback) ──
  const z = loadSchemastery()
  const settingsOverrides = {}      // in-memory when no scope
  let fallbackSettings = {}         // merged into overrides when scope absent
  let settingsScope = null
  const schema = settingsSchema(z)
  if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
    try {
      settingsScope = ctx.settings.register(SETTINGS_NS, schema, { base: structuredCloneSafe(DEFAULTS), applies: 'live' })
      trace('settings-registered', { ns: SETTINGS_NS })
    } catch (e) {
      trace('settings-register-failed', { message: String(e && e.message || e) })
      warn(`settings register failed: ${e && e.message}`)
    }
  }
  if (!settingsScope) trace('settings-store', { mode: 'fallback-file', file: displayPath(fallbackSettingsFile) })

  const effective = () => {
    let raw
    if (settingsScope && typeof settingsScope.get === 'function') {
      try { raw = settingsScope.get() } catch { raw = null }
    } else {
      raw = { ...fallbackSettings, ...settingsOverrides }
    }
    return normalizeSettings(raw)
  }
  /** Merge stored raw (partial allowed) over defaults and enforce every bound. */
  function normalizeSettings(raw) {
    const v = raw && typeof raw === 'object' ? raw : {}
    const api = v.api && typeof v.api === 'object' ? v.api : {}
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULTS.enabled,
      idleMinutes: bound(v.idleMinutes, DEFAULTS.idleMinutes, ...LIMITS.idleMinutes),
      maxNudges: bound(v.maxNudges, DEFAULTS.maxNudges, ...LIMITS.maxNudges),
      tickSeconds: bound(v.tickSeconds, DEFAULTS.tickSeconds, ...LIMITS.tickSeconds),
      defaultPrompt: typeof v.defaultPrompt === 'string' && v.defaultPrompt.trim() ? v.defaultPrompt.slice(0, LIMITS.promptChars) : DEFAULTS.defaultPrompt,
      notifyOnCap: typeof v.notifyOnCap === 'boolean' ? v.notifyOnCap : DEFAULTS.notifyOnCap,
      wakeColdForApi: typeof v.wakeColdForApi === 'boolean' ? v.wakeColdForApi : DEFAULTS.wakeColdForApi,
      skipWhenGoalActive: typeof v.skipWhenGoalActive === 'boolean' ? v.skipWhenGoalActive : DEFAULTS.skipWhenGoalActive,
      onlyAfterError: typeof v.onlyAfterError === 'boolean' ? v.onlyAfterError : DEFAULTS.onlyAfterError,
      backoffFactor: Number.isFinite(v.backoffFactor) ? clampFactor(v.backoffFactor) : DEFAULTS.backoffFactor,
      backoffMaxMinutes: bound(v.backoffMaxMinutes, DEFAULTS.backoffMaxMinutes, ...LIMITS.backoffMaxMinutes),
      quietHours: normalizeQuietHours(v.quietHours),
      api: {
        rateLimitPerMinute: bound(api.rateLimitPerMinute, DEFAULTS.api.rateLimitPerMinute, 1, 600),
        secret: typeof api.secret === 'string' ? api.secret.slice(0, LIMITS.secretMax) : '',
      },
      chats: Array.isArray(v.chats) ? v.chats.map(sanitizeChatEntry).filter(Boolean).slice(0, LIMITS.chatsMax) : [],
    }
  }
  function bound(n, d, min, max) { return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d }
  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)) }

  async function persistSettingsPatch(patch) {
    // The stored secret is only ever rewritten by /secret (which sends a full
    // api object). A UI save may carry a partial api, merge against the
    // currently-stored one so a settings write can never silently wipe it.
    if (patch.api) {
      const current = effective().api
      patch = { ...patch, api: { ...current, ...patch.api } }
    }
    // Same for quietHours: the sanitized patch is partial by design.
    if (patch.quietHours) patch = { ...patch, quietHours: { ...effective().quietHours, ...patch.quietHours } }
    if (settingsScope && typeof settingsScope.update === 'function') {
      await settingsScope.update(patch)
      return 'settings'
    }
    const merged = { ...fallbackSettings, ...settingsOverrides, ...patch }
    Object.assign(settingsOverrides, patch)
    fallbackSettings = merged
    await atomicWriteFile(fallbackSettingsFile, JSON.stringify(merged, null, 2) + '\n')
    return 'fallback-file'
  }

  // ── chat runtime state ──
  /** sessionId -> state */
  const states = new Map()
  let stateDirty = false
  let statesLoaded = false

  async function loadStates() {
    try {
      const raw = JSON.parse(await fsP.readFile(stateFile, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [id, s] of Object.entries(raw)) {
          if (!s || typeof s !== 'object') continue
          if (!ID_SAFE_RE.test(id)) continue
          states.set(id, {
            ...newState(boot),
            lastActivityAt: Number.isFinite(s.lastActivityAt) ? s.lastActivityAt : boot,
            nudgesSent: Number.isFinite(s.nudgesSent) ? s.nudgesSent : 0,
            lastNudgeAt: Number.isFinite(s.lastNudgeAt) ? s.lastNudgeAt : null,
            cappedNoticed: Boolean(s.cappedNoticed),
            errorAt: Number.isFinite(s.errorAt) ? s.errorAt : null,
            lastOutcome: s.lastOutcome && typeof s.lastOutcome === 'object' && typeof s.lastOutcome.kind === 'string'
              ? { kind: s.lastOutcome.kind.slice(0, 40), at: Number.isFinite(s.lastOutcome.at) ? s.lastOutcome.at : 0 } : null,
          })
        }
      }
      trace('states-loaded', { count: states.size })
    } catch { /* first boot or missing file, start clean */ }
    statesLoaded = true
  }
  async function flushStates(force = false) {
    if (!stateDirty && !force) return
    try {
      const eff = effective()
      const watchedIds = new Set(eff.chats.filter((c) => c.enabled).map((c) => c.id))
      const now = Date.now()
      const out = {}
      for (const [id, s] of states) {
        // Keep only watched chats' states, and drop anything long silent.
        if (!watchedIds.has(id) && now - s.lastActivityAt > STATE_KEEP_MS) { states.delete(id); continue }
        if (!watchedIds.has(id) && now - s.lastActivityAt > STATE_FLUSH_MS * 60) continue
        out[id] = { lastActivityAt: s.lastActivityAt, nudgesSent: s.nudgesSent, lastNudgeAt: s.lastNudgeAt, cappedNoticed: s.cappedNoticed, errorAt: s.errorAt, lastOutcome: s.lastOutcome }
      }
      await atomicWriteFile(stateFile, JSON.stringify(out))
      stateDirty = false   // only cleared once the write actually landed
    } catch (e) { warn(`state flush failed: ${e && e.message}`) }
  }

  function stateFor(id) {
    let st = states.get(id)
    if (!st) { st = newState(statesLoaded ? Date.now() : boot); states.set(id, st); stateDirty = true }
    return st
  }

  // ── live-activity tracking ──
  // Watched ids set is rebuilt whenever settings resolve (cheap: chats<=200).
  let watchedIndex = new Map() // id -> entry
  function rebuildWatchedIndex(eff) {
    const next = new Map()
    for (const c of eff.chats) if (c.enabled) next.set(c.id, c)
    watchedIndex = next
  }

  const onSessionEvent = (session, event) => {
    try {
      const id = session && session.id
      if (typeof id !== 'string' || !watchedIndex.has(id)) return
      const st = stateFor(id)
      st.lastActivityAt = Date.now()
      if (isHumanUserMessage(event)) {
        // A human spoke: the idle period restarts and the nudge budget refills.
        st.nudgesSent = 0
        st.cappedNoticed = false
        st.errorAt = null
        st.lastOutcome = { kind: 'human-replied', at: Date.now() }
      }
      stateDirty = true
    } catch (e) { warn(`session/event handler: ${e && e.message}`) }
  }

  // Live-bus error signal: remembers that a watched chat's agent hit an error,
  // which is the only trigger when onlyAfterError is on. Cleared by a human
  // reply or by the nudge that answers it.
  const onAgentError = (payload) => {
    try {
      const id = payload && payload.agent && payload.agent.id
      if (typeof id !== 'string' || !watchedIndex.has(id)) return
      const st = stateFor(id)
      st.errorAt = Date.now()
      stateDirty = true
    } catch (e) { warn(`agent/error handler: ${e && e.message}`) }
  }

  /** Active, armed goal on this agent? Only when the goals service is present. */
  function goalActiveFor(agent) {
    try {
      const goals = ctx.get && ctx.get('goals')
      if (!goals || typeof goals.get !== 'function' || !agent) return false
      const g = goals.get(agent)
      return Boolean(g && g.phase === 'active' && g.activation === 'armed')
    } catch { return false }
  }

  // ── nudge delivery ──
  function buildPromptMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    }
  }
  function postNotice(session, text) {
    if (!session || typeof session.append !== 'function') return
    const summary = text.slice(0, LIMITS.summaryChars)
    try {
      session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary },
      })
    } catch (e) { trace('notice-failed', { message: String(e && e.message) }) }
  }

  function sendNudge(sid, entry, st, prompt, via) {
    const agent = ctx.agents.get(sid)
    if (!agent || typeof agent.followup !== 'function') {
      st.notLive = true
      return { ok: false, reason: 'not-live' }
    }
    st.notLive = false
    try {
      agent.followup(buildPromptMessage(prompt))
      st.nudgesSent += 1
      st.lastNudgeAt = Date.now()
      st.lastActivityAt = Date.now()  // next window measures from our own prompt too
      st.errorAt = null               // an error is answered once
      st.lastOutcome = { kind: 'nudged', at: Date.now() }
      stateDirty = true
      trace('nudge-sent', { sessionId: sid, nudge: st.nudgesSent, via: via || 'idle', prompt: prompt.slice(0, 80) })
      return { ok: true, agent }
    } catch (e) {
      trace('nudge-failed', { sessionId: sid, message: String(e && e.message) })
      st.lastOutcome = { kind: 'failed', at: Date.now() }
      stateDirty = true
      return { ok: false, reason: 'followup-threw', error: e }
    }
  }

  // ── tick ──
  function tick() {
    try {
      const eff = effective()
      rebuildWatchedIndex(eff)
      if (!eff.enabled) return
      const now = Date.now()
      for (const entry of watchedIndex.values()) {
        try {
          const agent = ctx.agents.get(entry.id)
          const st = stateFor(entry.id)
          const act = decideNudge({
            now, entry, st, eff,
            agentLive: Boolean(agent),
            agentStatus: agent ? agent.status : undefined,
            goalActive: eff.skipWhenGoalActive ? goalActiveFor(agent) : false,
          })
          if (!act) continue
          const r = sendNudge(entry.id, entry, st, act.prompt, 'idle')
          if (!r.ok && r.reason === 'followup-threw') continue
          if (!r.ok) continue
          if (eff.notifyOnCap && st.nudgesSent >= eff.maxNudges && !st.cappedNoticed) {
            st.cappedNoticed = true
            st.lastOutcome = { kind: 'capped', at: Date.now() }
            stateDirty = true
            const session = agent.session
            postNotice(session, `Idle-Watchdog: ${st.nudgesSent} idle prompt(s) sent without a reply, pausing this chat until you answer.`)
            trace('cap-noticed', { sessionId: entry.id, nudges: st.nudgesSent })
          }
        } catch (e) { warn(`tick chat ${entry.id}: ${e && e.message}`) }
      }
    } catch (e) { warn(`tick: ${e && e.message}`) }
  }

  /** Read-only preview: what the next tick would do for every watched chat. Sends nothing. */
  function previewRows(eff = effective()) {
    const now = Date.now()
    const quietNow = inQuietHours(now, eff.quietHours)
    const rows = []
    for (const entry of eff.chats) {
      const agent = ctx.agents.get(entry.id)
      const st = states.get(entry.id) || newState(now)
      const r = evaluateChat({
        now, entry, st, eff,
        agentLive: Boolean(agent), agentStatus: agent ? agent.status : undefined,
        goalActive: eff.skipWhenGoalActive ? goalActiveFor(agent) : false,
      })
      rows.push({
        sessionId: entry.id, label: entry.label, watched: entry.enabled !== false,
        live: Boolean(agent), running: Boolean(agent && agent.status === 'running'),
        action: r.action, reason: r.reason, dueAt: r.dueAt, windowMinutes: Math.round(r.windowMs / 60_000),
        nudgesSent: st.nudgesSent, maxNudges: eff.maxNudges, errorPending: Boolean(st.errorAt),
        lastNudgeAt: st.lastNudgeAt, lastOutcome: st.lastOutcome,
        willSend: r.action === 'nudge' ? (r.prompt || '').slice(0, 120) : undefined,
      })
    }
    return { now, quietNow, quietHours: eff.quietHours, enabled: eff.enabled, rows }
  }

  // ── chat catalog for the UI + prompt resolution ──
  // (title cache and known-ids are refreshed lazily; cheap host reads only)
  let catalog = { at: 0, rows: [], titleIndex: new Map(), knownIds: new Set() }
  async function buildCatalog(force = false) {
    const now = Date.now()
    if (!force && now - catalog.at < 15_000) return catalog
    const rows = []
    const titleIndex = new Map()
    const knownIds = new Set()
    const addTitle = (title, id) => {
      if (!title) return
      const k = String(title).toLowerCase()
      if (!titleIndex.has(k)) titleIndex.set(k, [])
      const list = titleIndex.get(k)
      if (!list.includes(id)) list.push(id)
    }
    const sessionQuery = ctx.get && ctx.get('sessionQuery')
    const titleService = ctx.get && ctx.get('sessionTitle')
    // ctx.<service> property reads THROW for anything outside `inject`, the
    // optional stores must come through ctx.get() (undefined when absent).
    const sessionsStore = ctx.get && ctx.get('sessions')
    try {
      let records = []
      if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
        records = await sessionQuery.listSessions()
      } else {
        records = sessionsStore && typeof sessionsStore.list === 'function'
          ? sessionsStore.list().map((s) => ({ header: s.header, live: true }))
          : []
      }
      const heads = []
      for (const rec of records.slice(0, CHATS_LIST_MAX * 2)) {
        const h = rec && rec.header
        if (!h || typeof h.id !== 'string' || !ID_SAFE_RE.test(h.id)) continue
        if (h.origin === 'subagent') continue           // children belong to their parents
        if (knownIds.has(h.id)) continue
        knownIds.add(h.id)
        heads.push(h)
      }
      // Live agents absent from the record set are still resolvable chats -
      // the catalog must cover everything an API caller could aim at.
      for (const a of ctx.agents.list()) {
        const id = a && a.id
        if (typeof id !== 'string' || !ID_SAFE_RE.test(id) || knownIds.has(id)) continue
        const header = a.session && a.session.header
        if (header && header.origin === 'subagent') continue
        knownIds.add(id)
        heads.push(header || { id })
      }
      let titles = new Map()
      if (sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function') {
        try {
          const snaps = await sessionQuery.readTitleSnapshots(heads.map((h) => h.id))
          // SessionTitleObservationResult: { sessionId, status, value: { session, title?: { title } } }
          for (const s of snaps || []) {
            if (!s || s.status !== 'fulfilled') continue
            const t = s.value && s.value.title && s.value.title.title
            if (s.sessionId && typeof t === 'string' && t) titles.set(s.sessionId, t.slice(0, LIMITS.labelChars))
          }
        } catch {}
      }
      for (const h of heads.slice(0, CHATS_LIST_MAX)) {
        const agent = ctx.agents.get(h.id)
        const liveSession = sessionsStore && typeof sessionsStore.get === 'function' ? sessionsStore.get(h.id) : undefined
        let title = titles.get(h.id)
        if (!title && titleService && liveSession) {
          try { title = titleService.get(liveSession)?.title } catch {}
        }
        title = typeof title === 'string' && title ? title.slice(0, LIMITS.labelChars) : ''
        const row = {
          sessionId: h.id,
          title,
          cwd: typeof h.cwd === 'string' ? h.cwd.slice(0, LIMITS.labelChars) : '',
          createdAt: Number.isFinite(h.createdAt) ? h.createdAt : 0,
          live: Boolean(agent),
          running: Boolean(agent && agent.status === 'running'),
        }
        rows.push(row)
        addTitle(title, h.id)
      }
      // User-given labels are a first-class API handle too: the settings table
      // shows them, so callers may speak the same name as the UI displays.
      for (const c of effective().chats) if (c.label) addTitle(c.label.slice(0, LIMITS.labelChars), c.id)
      catalog = { at: now, rows, titleIndex, knownIds }
    } catch (e) {
      trace('catalog-failed', { message: String(e && e.message) })
    }
    return catalog
  }

  // ── external prompt path ──
  async function handlePrompt(req, res) {
    const eff = effective()
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
    const secretConfigured = (process.env[SECRET_ENV] || '').trim() || eff.api.secret || ''
    if (secretConfigured === '') {
      trace('prompt-rejected', { reason: 'no-secret', ip })
      sendJson(res, 503, { error: 'secret-not-configured', hint: `set ${SECRET_ENV} or save a secret in Settings → Idle Watchdog` })
      return
    }
    if (!secretEquals(presentedSecret(req.headers), secretConfigured)) {
      // Failed auth costs the caller a slot in a small per-IP budget, so the
      // endpoint cannot be used to brute-force guesses at the secret.
      const af = authFailLimiter.take(ip)
      if (!af.ok) res.setHeader('retry-after', String(Math.ceil(af.retryAfterMs / 1000)))
      trace('prompt-rejected', { reason: 'bad-secret', ip, throttled: !af.ok })
      sendJson(res, af.ok ? 401 : 429, { error: af.ok ? 'invalid-secret' : 'rate-limited', retryAfterMs: af.retryAfterMs })
      return
    }
    const rl = rateLimiter.take(ip)
    if (!rl.ok) {
      res.setHeader('retry-after', String(Math.ceil(rl.retryAfterMs / 1000)))
      trace('prompt-rejected', { reason: 'rate-limit', ip })
      sendJson(res, 429, { error: 'rate-limited', retryAfterMs: rl.retryAfterMs })
      return
    }
    const body = await readJsonBody(req)
    const chatRef = str(body.chat, LIMITS.idChars)
    const message = str(body.message, LIMITS.promptChars)
    const provenance = PROVENANCE_RE.test(str(body.provenance, 80)) ? str(body.provenance, 80) : 'api'
    if (!chatRef || message.trim() === '') {
      sendJson(res, 400, { error: 'chat and non-empty message are required' })
      return
    }
    const cat = await buildCatalog()
    const watched = eff.chats
    const liveIds = ctx.agents.list().map((a) => a.id).filter((id) => typeof id === 'string')
    // Merge the cached catalog's title index with the CURRENT settings' chat
    // labels: a chat added/renamed since the last catalog build must resolve
    // by its label immediately (the cached part refreshes on its own TTL).
    const titleIndex = new Map(cat.titleIndex)
    for (const c of watched) {
      if (!c.label) continue
      const k = c.label.toLowerCase()
      const list = titleIndex.get(k) ? [...titleIndex.get(k)] : []
      if (!list.includes(c.id)) list.push(c.id)
      titleIndex.set(k, list)
    }
    const ref0 = resolveChatRef(chatRef, { knownIds: new Set([...cat.knownIds, ...liveIds]), liveIds, watched, titleIndex })
    // An id-shaped reference absent from the (<=15 s stale) catalog is still
    // worth attempting: the chat may have been created after the last build.
    // resolveAgent is the authority on whether it exists at all.
    const ref = (ref0.kind === 'unknown' && chatRef.length >= 8 && ID_SAFE_RE.test(chatRef))
      ? { kind: 'exact', id: chatRef, unverified: true }
      : ref0
    if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { error: 'chat-not-found', ref: chatRef.slice(0, 40) }); return }
    if (ref.kind === 'ambiguous') { sendJson(res, 409, { error: 'ambiguous-chat', candidates: ref.ids }); return }
    const sid = ref.id
    let agent = ctx.agents.get(sid)
    let resumed = false
    if (!agent) {
      if (!eff.wakeColdForApi) { sendJson(res, 409, { error: 'chat-not-live', hint: 'wakeColdForApi is off' }); return }
      const controller = ctx.get && ctx.get('sessionController')
      if (!controller || typeof controller.resolveAgent !== 'function') {
        sendJson(res, ref.unverified ? 404 : 409, { error: ref.unverified ? 'chat-not-found' : 'chat-not-live', hint: 'sessionController unavailable' })
        return
      }
      try {
        const r = await controller.resolveAgent(sid)
        if (r && r.agent) { agent = r.agent; resumed = true }
        else {
          // Map the stable Session-domain error kinds onto statuses: not-found
          // is a 404, everything else means "exists but undeliverable".
          const kind = String((r && r.error && (r.error.kind || r.error.code)) || '')
          if (ref.unverified && kind.includes('not-found')) sendJson(res, 404, { error: 'chat-not-found', ref: chatRef.slice(0, 40) })
          else sendJson(res, 409, { error: 'chat-not-resolvable', detail: kind || undefined })
        }
      } catch (e) {
        trace('prompt-resolve-failed', { sessionId: sid, message: String(e && e.message) })
        // The resolver signals some outcomes by THROWING its domain errors
        // (ApiSessionNotFound, ApiSessionSubagentOwnership, …): surface those
        // as honest statuses instead of a generic 500.
        const en = String((e && (e.name || (e.constructor && e.constructor.name))) || '')
        if (en.includes('NotFound')) sendJson(res, 404, { error: 'chat-not-found', ref: chatRef.slice(0, 40) })
        else if (en.includes('Subagent') || en.includes('Ownership')) sendJson(res, 403, { error: 'subagent-owned', detail: 'child sessions are not addressable' })
        else sendJson(res, 500, { error: 'resolve-failed' })
      }
      if (!agent) return
    }
    try {
      agent.followup(buildPromptMessage(message))
    } catch (e) {
      trace('prompt-failed', { sessionId: sid, message: String(e && e.message) })
      sendJson(res, 500, { error: 'followup-failed' })
      return
    }
    // Track prompt-injected activity through the normal append feed; the
    // watchdog's own source keeps nudge accounting untouched (kind: plugin).
    trace('prompt-accepted', { sessionId: sid, via: ref.kind, provenance, resumed })
    sendJson(res, resumed ? 200 : 202, { ok: true, chat: sid, via: ref.kind, resumed })
  }

  // ── HTTP route ──
  const rateLimiter = makeRateLimiter(() => {
    try { return effective().api.rateLimitPerMinute } catch { return DEFAULTS.api.rateLimitPerMinute }
  })
  // Separate, tighter budget for wrong-secret attempts (fixed cap: reading
  // settings per-try from inside the limiter during an auth storm is exactly
  // what the limiter is supposed to protect against).
  const authFailLimiter = makeRateLimiter(() => 10)

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://idle-watchdog.local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path

      if (req.method === 'GET' && sub === '/health') {
        sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, version: VERSION, bootedAt: boot })
        return
      }
      if (req.method === 'GET' && sub === '/status') {
        const eff = effective()
        const perChat = []
        for (const [id, st] of states) {
          const agent = ctx.agents.get(id)
          perChat.push({
            sessionId: id, live: Boolean(agent), running: Boolean(agent && agent.status === 'running'),
            lastActivityAt: st.lastActivityAt, nudgesSent: st.nudgesSent, lastNudgeAt: st.lastNudgeAt,
            lastOutcome: st.lastOutcome,
          })
        }
        sendJson(res, 200, {
          armed: true, row: ROW_ID, version: VERSION, bootedAt: boot,
          settingsStore: settingsScope ? 'settings' : 'fallback-file',
          envSecretPresent: Boolean((process.env[SECRET_ENV] || '').trim()),
          settings: safeSettings(eff),
          perChat: perChat.slice(-100),
          preview: previewRows(eff),
          activityTail: await readActivityTail(activityFile),
          stateFile: displayPath(stateFile), activityFile: displayPath(activityFile),
        })
        return
      }
      if (req.method === 'GET' && sub === '/next') {
        sendJson(res, 200, previewRows())
        return
      }
      if (req.method === 'GET' && sub === '/chats') {
        const cat = await buildCatalog(url.searchParams.has('refresh'))
        sendJson(res, 200, { at: cat.at, rows: cat.rows })
        return
      }
      if (req.method === 'GET' && sub === '/logs') {
        const n = clamp(Number(url.searchParams.get('n')) || ACTIVITY_TAIL_LINES, 1, 200)
        sendJson(res, 200, { tail: await readActivityTail(activityFile, n) })
        return
      }
      if (req.method === 'PUT' && sub === '/settings') {
        if (!csrfOk(req)) { sendJson(res, 403, { error: 'csrf-guard' }); return }
        const body = await readJsonBody(req)
        const patch = sanitizeSettingsPatch(body)
        if (Object.keys(patch).length === 0) { sendJson(res, 400, { error: 'no-valid-settings-in-body' }); return }
        const store = await persistSettingsPatch(patch)
        rebuildWatchedIndex(effective())
        trace('settings-updated', { keys: Object.keys(patch).join(','), store })
        sendJson(res, 200, { ok: true, store, settings: safeSettings(effective()) })
        return
      }
      if (req.method === 'POST' && sub === '/secret') {
        if (!csrfOk(req)) { sendJson(res, 403, { error: 'csrf-guard' }); return }
        const body = await readJsonBody(req)
        if (body.clear === true) {
          await persistSettingsPatch({ api: { ...(effective().api), secret: '' } })
          trace('secret-cleared', {})
          sendJson(res, 200, { ok: true, configured: false })
          return
        }
        const secret = typeof body.secret === 'string' ? body.secret.trim() : ''
        if (secret.length < LIMITS.secretMin || secret.length > LIMITS.secretMax) {
          sendJson(res, 400, { error: `secret must be ${LIMITS.secretMin}..${LIMITS.secretMax} characters` })
          return
        }
        await persistSettingsPatch({ api: { ...(effective().api), secret } })
        trace('secret-set', { fingerprint: secretFingerprint(secret) })
        sendJson(res, 200, { ok: true, configured: true, fingerprint: secretFingerprint(secret) })
        return
      }
      if (req.method === 'POST' && sub === '/prompt') {
        await handlePrompt(req, res)
        return
      }
      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      // Never throw into the webServer. If a response already started, only
      // close it; otherwise answer 400 (bad body) / 500 (unexpected).
      try {
        if (res.headersSent) { res.end(); return }
        sendJson(res, 400, { error: String(error && error.message || error) })
      } catch {}
    }
  }

  // ── wiring (everything reversible; the fiber owns each effect) ──
  ctx.effect(() => {
    const dispose = ctx.on('session/event', onSessionEvent)
    return () => { try { dispose() } catch {} }
  }, 'idle-watchdog: session/event subscription')

  ctx.effect(() => {
    // Optional: a host without this bus event simply never reports errors.
    let dispose = () => {}
    try { dispose = ctx.on('agent/error', onAgentError) || dispose } catch (e) { trace('agent-error-subscribe-failed', { message: String(e && e.message) }) }
    return () => { try { dispose() } catch {} }
  }, 'idle-watchdog: agent/error subscription')

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'idle-watchdog: api route')

  let tickTimer = null
  let flushTimer = null
  const armTimers = () => {
    if (tickTimer) return // already armed
    tickTimer = setInterval(tick, effective().tickSeconds * 1000)
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
    flushTimer = setInterval(() => { void flushStates() }, STATE_FLUSH_MS)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
    trace('armed', {
      pid: process.pid, boot, settingsStore: settingsScope ? 'settings' : 'fallback-file',
      row: ROW_ID, version: VERSION, config: Object.keys(config || {}).length ? Object.keys(config) : undefined,
    })
    log(`armed, ${displayPath(pluginDir)} · route ${API_PREFIX} · settings via ${settingsScope ? SETTINGS_NS : 'file'}`)
  }
  void (async () => {
    // Load durable state and the fallback settings file; a failure here must
    // NOT skip arming, worst case the watchdog runs without history.
    try {
      await loadStates()
      const saved = await fsP.readFile(fallbackSettingsFile, 'utf8')
      if (saved) fallbackSettings = JSON.parse(saved) || {}
    } catch (e) { warn(`init: ${e && e.message}`) }
    try { rebuildWatchedIndex(effective()) } catch {}
    armTimers()
    void buildCatalog(true).catch(() => {})   // warm the picker without blocking the fiber
  })().catch((e) => {
    // An unhandled rejection can exit the whole process; never let a plugin
    // helper throw past this boundary.
    warn(`init crashed: ${e && e.stack || e}`)
    try { armTimers() } catch {}
  })

  ctx.effect(() => () => {
    if (tickTimer) clearInterval(tickTimer)
    if (flushTimer) clearInterval(flushTimer)
    void flushStates(true)
    trace('disarmed', { pid: process.pid })
  }, 'idle-watchdog: timers + final state flush')
}

// Test surface: pure helpers only (never live data, never the closure state).
export const __internals = {
  DEFAULTS, LIMITS, PLUGIN_ID, SETTINGS_NS, API_PREFIX,
  sanitizeChatEntry, sanitizeSettingsPatch, safeSettings, secretEquals, secretFingerprint,
  presentedSecret, makeRateLimiter, resolveChatRef, decideNudge, isHumanUserMessage,
  newState, clamp, str, csrfOk,
  evaluateChat, nudgeWindowMs, inQuietHours, normalizeQuietHours, parseClock, clampFactor, sanitizeQuietHoursPatch,
}

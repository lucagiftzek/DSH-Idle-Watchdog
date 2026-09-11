/**
 * DSH-Idle-Watchdog — host half.
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
 *     `{chat, message}` into one chat — the same followup path, but
 *     caller-driven. Secret is compared in constant time, the whole surface
 *     fails closed without a configured secret, and calls are rate-limited
 *     per source IP. This is the machine-entry point crons and other boxes
 *     use; on this estate the socket itself is loopback-bound and the public
 *     edge additionally sits behind tz-auth, so the secret is defense at the
 *     last remaining open layer (BlackServer runs unauthenticated plugin
 *     routes — see the dsh-genui CSRF incident note in the profile patch).
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
 *    at boot would be a resource disaster (see the estate RAM margins rule).
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
 *   and restart dsh-web — or set DSH_IDLE_WATCHDOG_DISABLE=1 in its env.
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
const VERSION = '1.0.0'

// ── Defaults ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: true,             // master switch (per-chat opt-in still required)
  idleMinutes: 20,           // silence window before a nudge
  maxNudges: 3,              // nudges per idle period; human reply resets
  tickSeconds: 30,           // scan cadence
  defaultPrompt: 'You have been quiet for a while — anything you would like me to continue or pick up next?',
  notifyOnCap: true,         // folded notice when the per-period cap is hit
  wakeColdForApi: true,      // API prompts may resume a cold chat
  api: {
    rateLimitPerMinute: 30,  // per source IP, prompt endpoint
  },
  chats: [],                 // [{id, label, enabled, prompt, idleMinutes}]
}

// Hard bounds, independent of anything the client UI renders — curl exists.
const LIMITS = {
  idleMinutes: [1, 7 * 24 * 60],
  maxNudges: [0, 20],
  tickSeconds: [5, 3600],
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
 * resolution from this file — which works once the declared dependency is
 * installed), and `null` on total failure — apply() then runs in
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
 * `secret` is intentionally NOT accepted here — only POST /secret writes it,
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

/** Settings view safe to hand to the browser: secret replaced by fingerprint. */
function safeSettings(eff) {
  return {
    enabled: eff.enabled, idleMinutes: eff.idleMinutes, maxNudges: eff.maxNudges,
    tickSeconds: eff.tickSeconds, defaultPrompt: eff.defaultPrompt,
    notifyOnCap: eff.notifyOnCap, wakeColdForApi: eff.wakeColdForApi,
    api: { rateLimitPerMinute: eff.api.rateLimitPerMinute, secret: eff.api.secret ? '***' : '', secretFingerprint: secretFingerprint(eff.api.secret) },
    chats: eff.chats.map((c) => ({ ...c })),
  }
}

/** sha256 fingerprint (first 8 hex) — display-only; '' when unset. */
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
  return { lastActivityAt: now, nudgesSent: 0, lastNudgeAt: null, notLive: false, cappedNoticed: false }
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
 * Core nudge decision for one watched chat at tick time. Pure: the caller
 * supplies the live-agent facts it could not know statically.
 * @returns null (do nothing) | {prompt: string}
 */
function decideNudge({ now, entry, st, eff, agentLive, agentStatus }) {
  if (!eff.enabled) return null
  if (!entry || entry.enabled === false) return null
  if (!agentLive || agentStatus === 'running') return null
  const windowMs = (entry.idleMinutes > 0 ? entry.idleMinutes : eff.idleMinutes) * 60_000
  if (eff.maxNudges <= 0) return null
  if (st.nudgesSent >= eff.maxNudges) return null
  if (now - st.lastActivityAt < windowMs) return null
  return { prompt: (entry.prompt && entry.prompt.trim()) ? entry.prompt : eff.defaultPrompt }
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

/** Append-only JSONL ledger with rolling truncation (ctx.logger is filtered,
 *  so the plugin keeps its own record — house convention). */
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
  const log = (m) => { try { ctx.logger.info(`idle-watchdog: ${m}`) } catch {} }
  const warn = (m) => { try { ctx.logger.warn(`idle-watchdog: ${m}`) } catch {} }

  // Hard kill switch without touching the composition.
  if (process.env[DISABLE_ENV] === '1') {
    trace('disabled-by-env', { pid: process.pid })
    log(`${DISABLE_ENV}=1 — armed off`)
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
    // api object). A UI save may carry a partial api — merge against the
    // currently-stored one so a settings write can never silently wipe it.
    if (patch.api) {
      const current = effective().api
      patch = { ...patch, api: { ...current, ...patch.api } }
    }
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
          })
        }
      }
      trace('states-loaded', { count: states.size })
    } catch { /* first boot or missing file — start clean */ }
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
        out[id] = { lastActivityAt: s.lastActivityAt, nudgesSent: s.nudgesSent, lastNudgeAt: s.lastNudgeAt, cappedNoticed: s.cappedNoticed }
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
      }
      stateDirty = true
    } catch (e) { warn(`session/event handler: ${e && e.message}`) }
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
      stateDirty = true
      trace('nudge-sent', { sessionId: sid, nudge: st.nudgesSent, via: via || 'idle', prompt: prompt.slice(0, 80) })
      return { ok: true, agent }
    } catch (e) {
      trace('nudge-failed', { sessionId: sid, message: String(e && e.message) })
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
          })
          if (!act) continue
          const r = sendNudge(entry.id, entry, st, act.prompt, 'idle')
          if (!r.ok && r.reason === 'followup-threw') continue
          if (!r.ok) continue
          if (eff.notifyOnCap && st.nudgesSent >= eff.maxNudges && !st.cappedNoticed) {
            st.cappedNoticed = true
            stateDirty = true
            const session = agent.session
            postNotice(session, `Idle-Watchdog: ${st.nudgesSent} idle prompt(s) sent without a reply — pausing this chat until you answer.`)
            trace('cap-noticed', { sessionId: entry.id, nudges: st.nudgesSent })
          }
        } catch (e) { warn(`tick chat ${entry.id}: ${e && e.message}`) }
      }
    } catch (e) { warn(`tick: ${e && e.message}`) }
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
    try {
      let records = []
      if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
        records = await sessionQuery.listSessions()
      } else {
        records = ctx.sessions ? ctx.sessions.list().map((s) => ({ header: s.header, live: true })) : []
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
      // Live agents absent from the record set are still resolvable chats —
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
          for (const s of snaps || []) {
            const t = s && (s.snapshot?.title ?? s.title)
            if (s && s.sessionId && typeof t === 'string' && t) titles.set(s.sessionId, t.slice(0, LIMITS.labelChars))
          }
        } catch {}
      }
      for (const h of heads.slice(0, CHATS_LIST_MAX)) {
        const agent = ctx.agents.get(h.id)
        const liveSession = ctx.sessions ? ctx.sessions.get(h.id) : undefined
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
          })
        }
        sendJson(res, 200, {
          armed: true, row: ROW_ID, version: VERSION, bootedAt: boot,
          settingsStore: settingsScope ? 'settings' : 'fallback-file',
          envSecretPresent: Boolean((process.env[SECRET_ENV] || '').trim()),
          settings: safeSettings(eff),
          perChat: perChat.slice(-100),
          activityTail: await readActivityTail(activityFile),
          stateFile: displayPath(stateFile), activityFile: displayPath(activityFile),
        })
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
    log(`armed — ${displayPath(pluginDir)} · route ${API_PREFIX} · settings via ${settingsScope ? SETTINGS_NS : 'file'}`)
  }
  void (async () => {
    // Load durable state and the fallback settings file; a failure here must
    // NOT skip arming — worst case the watchdog runs without history.
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
}

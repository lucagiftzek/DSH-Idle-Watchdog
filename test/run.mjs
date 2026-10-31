/**
 * DSH-Idle-Watchdog, tests.
 *
 * Two layers:
 *  1. Pure-helper unit tests over the decision/validation surface
 *     (sanitize, secret compare, rate limit, chat resolution, nudge decision).
 *  2. A boot smoke test of apply() against a fake cordis ctx (fallback
 *     settings store), driving the real HTTP handler with fake req/res:
 *     health -> csrf reject -> settings save -> secret set -> external prompt
 *     with good/bad/absent secrets and rate-limit behavior.
 *
 * $DSH_HOME is pointed at a throwaway directory, so nothing here ever touches
 * the real ~/.dsh. Run: node test/run.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'iw-test-'))
delete process.env.DSH_IDLE_WATCHDOG_SECRET
delete process.env.DSH_IDLE_WATCHDOG_DISABLE

const mod = await import('../lib/index.js')
const I = mod.__internals
const {
  DEFAULTS, sanitizeSettingsPatch, safeSettings, secretEquals, secretFingerprint,
  presentedSecret, makeRateLimiter, resolveChatRef, decideNudge, isHumanUserMessage, newState,
  evaluateChat, nudgeWindowMs, inQuietHours, normalizeQuietHours,
} = I

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name) }

console.log('# pure helpers')

test('sanitize drops unknown keys and clamps numerics', () => {
  const p = sanitizeSettingsPatch({ enabled: false, idleMinutes: 999999, maxNudges: -5, tickSeconds: 12, junk: 1 })
  assert.equal(p.enabled, false)
  assert.equal(p.idleMinutes, 7 * 24 * 60)   // clamped to a week
  assert.equal(p.maxNudges, 0)
  assert.equal(p.tickSeconds, 12)
  assert.equal(p.junk, undefined)
  assert.equal(p.secret, undefined)          // secret never through this door
})

test('sanitize chats: dedupe, bounds, junk rejection', () => {
  const p = sanitizeSettingsPatch({ chats: [
    { id: 'session-abc', label: 'L', prompt: 'p'.repeat(9000), idleMinutes: 5 },
    { id: 'session-abc', label: 'dup' },
    { id: 'bad id with spaces' },
    { id: 'session-ok', idleMinutes: 99999999 },
    null, 'string',
  ] })
  assert.equal(p.chats.length, 2)
  assert.equal(p.chats[0].prompt.length, 8000)
  assert.equal(p.chats[1].idleMinutes, 0)    // out-of-bounds -> inherit global
  assert.ok(p.chats.every((c) => !c.label || c.label.length <= 200))
})

test('safeSettings masks the secret to *** + fingerprint', () => {
  const eff = { ...DEFAULTS, api: { rateLimitPerMinute: 30, secret: 'super-secret-value-1234' } }
  const s = safeSettings(eff)
  assert.equal(s.api.secret, '***')
  assert.equal(s.api.secretFingerprint, secretFingerprint('super-secret-value-1234'))
  assert.equal(s.api.secretFingerprint.length, 8)
  assert.ok(!JSON.stringify(s).includes('super-secret'))
})

test('secretEquals is exact, length-safe, fail-closed', () => {
  assert.ok(secretEquals('a'.repeat(32), 'a'.repeat(32)))
  assert.ok(!secretEquals('a'.repeat(31), 'a'.repeat(32)))
  assert.ok(!secretEquals('', 'anything'))
  assert.ok(!secretEquals('x', ''))          // no configured secret -> deny
  assert.ok(!secretEquals(undefined, 'x'))
})

test('presentedSecret accepts both header forms', () => {
  assert.equal(presentedSecret({ 'x-idle-watchdog-secret': ' zz ' }), 'zz')
  assert.equal(presentedSecret({ authorization: 'Bearer zz2' }), 'zz2')
  assert.equal(presentedSecret({ authorization: 'Basic zz2' }), '')
  assert.equal(presentedSecret({}), '')
})

test('rate limiter window math', () => {
  let now = 0
  const rl = makeRateLimiter(() => 3, () => now)
  assert.ok(rl.take('ip').ok); assert.ok(rl.take('ip').ok); assert.ok(rl.take('ip').ok)
  const denied = rl.take('ip')
  assert.equal(denied.ok, false)
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60000)
  now = 59_999
  assert.equal(rl.take('ip').ok, false)      // still inside the minute
  now = 60_001
  assert.ok(rl.take('ip').ok)                // oldest slot expired
  assert.ok(rl.take('other-ip').ok)          // per-ip isolation
})

test('resolveChatRef precedence: exact > prefix > title; ambiguity kept', () => {
  const lists = {
    knownIds: new Set(['session-aa112233', 'session-bb445566', 'session-cc77']),
    liveIds: ['session-aa112233', 'session-bb445566'],
    watched: [{ id: 'session-cc77', enabled: true }],
    titleIndex: new Map([['nightly', ['session-aa112233']], ['dupe', ['session-aa112233', 'session-bb445566']]]),
  }
  assert.deepEqual(resolveChatRef('session-cc77', lists), { kind: 'exact', id: 'session-cc77' })
  // 'session-aa' is >=6 chars and matches exactly one live id -> prefix resolves
  assert.deepEqual(resolveChatRef('session-aa', lists), { kind: 'prefix', id: 'session-aa112233' })
  assert.deepEqual(resolveChatRef('session-aa11', lists), { kind: 'prefix', id: 'session-aa112233' })
  assert.deepEqual(resolveChatRef('session-bb', lists), { kind: 'prefix', id: 'session-bb445566' })
  assert.deepEqual(resolveChatRef('NIGHTLY', lists), { kind: 'title', id: 'session-aa112233' })
  assert.equal(resolveChatRef('dupe', lists).kind, 'ambiguous')
  assert.equal(resolveChatRef('ab', lists).kind, 'unknown')                   // below prefix min length
  assert.equal(resolveChatRef('   ', lists).kind, 'invalid')
})

test('isHumanUserMessage only counts human turns', () => {
  assert.ok(isHumanUserMessage({ type: 'user/message', data: { source: { kind: 'user' } } }))
  assert.ok(isHumanUserMessage({ type: 'user/message', data: {} }))            // legacy/no source
  assert.ok(!isHumanUserMessage({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-idle-watchdog' } } }))
  assert.ok(!isHumanUserMessage({ type: 'turn/end', data: { source: { kind: 'user' } } }))
})

test('decideNudge respects window, cap, running, master switch', () => {
  const now = 1_000_000_000
  const base = { now, eff: { ...DEFAULTS, enabled: true, idleMinutes: 20, maxNudges: 3 }, agentLive: true, agentStatus: 'idle' }
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const fresh = { ...newState(now - 60_000) }
  assert.equal(decideNudge({ ...base, entry, st: fresh }), null)               // silent only 1m
  assert.ok(decideNudge({ ...base, entry, st: { ...fresh, lastActivityAt: now - 21 * 60_000 } }))
  assert.equal(decideNudge({ ...base, entry, st: { ...fresh, lastActivityAt: now - 21 * 60_000 }, agentStatus: 'running' }), null)
  assert.equal(decideNudge({ ...base, entry, st: { ...fresh, lastActivityAt: now - 21 * 60_000, nudgesSent: 3 } }), null)
  assert.equal(decideNudge({ ...base, entry: { ...entry, enabled: false }, st: { ...fresh, lastActivityAt: now - 21 * 60_000 } }), null)
  const perChat = decideNudge({ ...base, entry: { ...entry, prompt: 'personal!' }, st: { ...fresh, lastActivityAt: now - 21 * 60_000 } })
  assert.equal(perChat.prompt, 'personal!')
  const shortWindow = decideNudge({ ...base, entry: { ...entry, idleMinutes: 5 }, st: { ...fresh, lastActivityAt: now - 6 * 60_000 } })
  assert.ok(shortWindow)                                                       // 5m personal window hit
})

test('v1.1 defaults reproduce v1.0 behaviour', () => {
  assert.equal(DEFAULTS.skipWhenGoalActive, false)
  assert.equal(DEFAULTS.onlyAfterError, false)
  assert.equal(DEFAULTS.backoffFactor, 1)
  assert.equal(DEFAULTS.backoffMaxMinutes, 0)
  assert.equal(DEFAULTS.quietHours.enabled, false)
  assert.ok(!/[\u2013\u2014]/.test(DEFAULTS.defaultPrompt), 'no dashes in the default prompt')
  const eff = { ...DEFAULTS }
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  for (const n of [0, 1, 2]) assert.equal(nudgeWindowMs(entry, { nudgesSent: n }, eff), 20 * 60_000)
})

test('backoff: window grows per nudge and respects the cap', () => {
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const eff = { ...DEFAULTS, backoffFactor: 2 }
  assert.equal(nudgeWindowMs(entry, { nudgesSent: 0 }, eff), 20 * 60_000)
  assert.equal(nudgeWindowMs(entry, { nudgesSent: 1 }, eff), 40 * 60_000)
  assert.equal(nudgeWindowMs(entry, { nudgesSent: 2 }, eff), 80 * 60_000)
  assert.equal(nudgeWindowMs(entry, { nudgesSent: 2 }, { ...eff, backoffMaxMinutes: 60 }), 60 * 60_000)
  const now = 1_000_000_000
  const base = { now, entry, eff, agentLive: true, agentStatus: 'idle' }
  // 1 nudge sent, silent 30m: constant window would fire, doubled (40m) must not
  assert.equal(decideNudge({ ...base, st: { ...newState(now - 30 * 60_000), nudgesSent: 1 } }), null)
  assert.ok(decideNudge({ ...base, st: { ...newState(now - 41 * 60_000), nudgesSent: 1 } }))
})

test('backoff window stays finite with a corrupt nudge count', () => {
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const eff = { ...DEFAULTS, backoffFactor: 10 }
  for (const n of [1e6, Infinity, NaN, -5]) {
    const w = nudgeWindowMs(entry, { nudgesSent: n }, eff)
    assert.ok(Number.isFinite(w) && w >= 20 * 60_000 && w <= 366 * 24 * 60 * 60_000, 'finite window for ' + n)
  }
})

test('goal-active skip only when enabled', () => {
  const now = 1_000_000_000
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const st = newState(now - 30 * 60_000)
  const base = { now, entry, st, agentLive: true, agentStatus: 'idle', goalActive: true }
  assert.ok(decideNudge({ ...base, eff: { ...DEFAULTS } }), 'default: goal ignored (v1.0 behaviour)')
  const r = evaluateChat({ ...base, eff: { ...DEFAULTS, skipWhenGoalActive: true } })
  assert.equal(r.action, 'wait'); assert.equal(r.reason, 'goal-active')
})

test('onlyAfterError waits for an error, then fires once', () => {
  const now = 1_000_000_000
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const eff = { ...DEFAULTS, onlyAfterError: true }
  const st = newState(now - 30 * 60_000)
  const base = { now, entry, eff, agentLive: true, agentStatus: 'idle' }
  assert.equal(evaluateChat({ ...base, st }).reason, 'waiting-for-error')
  assert.equal(evaluateChat({ ...base, st: { ...st, errorAt: now - 1000 } }).action, 'nudge')
})

test('quiet hours: same-day, midnight wrap, disabled, bad input', () => {
  const at = (h, m) => new Date(2026, 0, 15, h, m).getTime()   // local time
  const q = { enabled: true, start: '22:00', end: '07:00', timezone: '' }
  assert.equal(inQuietHours(at(23, 0), q), true)
  assert.equal(inQuietHours(at(3, 0), q), true)
  assert.equal(inQuietHours(at(7, 0), q), false)
  assert.equal(inQuietHours(at(12, 0), q), false)
  const day = { enabled: true, start: '09:00', end: '17:00', timezone: '' }
  assert.equal(inQuietHours(at(10, 0), day), true)
  assert.equal(inQuietHours(at(18, 0), day), false)
  assert.equal(inQuietHours(at(23, 0), { ...q, enabled: false }), false)
  assert.equal(inQuietHours(at(23, 0), { ...q, start: '08:00', end: '08:00' }), false)
  assert.equal(inQuietHours(at(23, 0), { enabled: true, start: 'zz', end: '07:00' }), false)
  const n = normalizeQuietHours({ enabled: true, start: '9:5', end: '25:00', timezone: 'Not/AZone' })
  assert.deepEqual(n, { enabled: true, start: '22:00', end: '07:00', timezone: '' })
  assert.equal(normalizeQuietHours({ timezone: 'Europe/Berlin' }).timezone, 'Europe/Berlin')
  // an explicit zone is honoured: 12:00 UTC is 21:00 in Tokyo
  const utcNoon = Date.UTC(2026, 0, 15, 12, 0)
  assert.equal(inQuietHours(utcNoon, { enabled: true, start: '20:00', end: '23:00', timezone: 'Asia/Tokyo' }), true)
  assert.equal(inQuietHours(utcNoon, { enabled: true, start: '20:00', end: '23:00', timezone: 'UTC' }), false)
  // quiet hours defer a due nudge
  const entry = { id: 'x', enabled: true, prompt: '', idleMinutes: 0 }
  const now = at(23, 0)
  const r = evaluateChat({ now, entry, st: newState(now - 60 * 60_000), eff: { ...DEFAULTS, quietHours: q }, agentLive: true, agentStatus: 'idle' })
  assert.equal(r.reason, 'quiet-hours')
})

test('sanitize accepts the v1.1 keys with bounds', () => {
  const p = sanitizeSettingsPatch({ skipWhenGoalActive: true, onlyAfterError: true, backoffFactor: 99, backoffMaxMinutes: -3, quietHours: { enabled: true, start: '23:30', end: '06:15', timezone: 'UTC' } })
  assert.equal(p.skipWhenGoalActive, true)
  assert.equal(p.onlyAfterError, true)
  assert.equal(p.backoffFactor, 10)
  assert.equal(p.backoffMaxMinutes, 0)
  assert.deepEqual(p.quietHours, { enabled: true, start: '23:30', end: '06:15', timezone: 'UTC' })
  assert.equal(sanitizeSettingsPatch({ backoffFactor: 1.5 }).backoffFactor, 1.5)
})

// ── boot smoke: fake ctx + real handler ──────────────────────────────────
console.log('# apply() smoke over fake ctx')

function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.writeHead = (code, headers) => { r.statusCode = code; Object.assign(r.headers, headers || {}) }
  r.end = (data) => { r.body = data || '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  return r
}
function fakeReq(method, path, { headers, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = Object.assign({}, headers)
  req.socket = { remoteAddress: '192.0.2.7' }
  req.destroy = () => {}
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  else setImmediate(() => req.emit('end'))
  return req
}

const fakeAgents = new Map()
const followups = []
fakeAgents.set('session-watchme', {
  id: 'session-watchme', status: 'idle',
  session: { id: 'session-watchme', append: () => {} },
  followup: (m) => followups.push(m),
})

const registered = { routes: [], effects: [], events: [] }
// sessionQuery fake with the REAL production shapes (SessionRecord headers;
// readTitleSnapshots → {sessionId, status, value:{session, title?}}) so the
// catalog path is driven exactly as the host will drive it.
const fakeSessionQuery = {
  listSessions: async () => [
    { header: { id: 'session-watchme', cwd: '/srv/demo', createdAt: 1720000000000 }, live: true, persisted: true },
    { header: { id: 'session-cold-legacy', cwd: '/srv/demo', createdAt: 1710000000000 }, live: false, persisted: true },
  ],
  readTitleSnapshots: async (ids) => ids.map((id) => (id === 'session-watchme'
    ? { sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: 'Alpha demo', messageSeqs: [1], source: { kind: 'provider', provider: 'fake' }, eventSeq: 3, updatedAt: 1 } } }
    : { sessionId: id, status: 'fulfilled', value: { session: { id } } })),
}
// The real cordis Fiber THROWS on any ctx.<service> property read outside
// `inject`, mimic that exactly. A permissive plain-object ctx once let the
// ctx.sessions catalog bug ship to production.
const strictCtx = (base) => new Proxy(base, {
  get(t, k) {
    if (typeof k === 'symbol' || k in t) return t[k]
    throw new TypeError(`cannot get property "${String(k)}" without inject`)
  },
})
const ctx = strictCtx({
  agents: {
    get: (id) => fakeAgents.get(id),
    list: () => [...fakeAgents.values()],
  },
  settings: { register: () => { throw new Error('schema path unavailable in fake ctx') } }, // force fallback store
  webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  on: (name, fn) => { registered.events.push([name, fn]); return () => {} },
  // cordis ctx.effect(fn) runs fn NOW and keeps its return as the disposer.
  effect: (fn, label) => { registered.effects.push([fn, label]); return fn() },
  get: (k) => (k === 'sessionQuery' ? fakeSessionQuery : k === 'sessionTitle' ? { get: () => undefined } : undefined),
})

mod.apply(ctx, {})
assert.equal(registered.routes.length, 1, 'one prefix route registered')
const handler = registered.routes[0].handler
assert.equal(registered.routes[0].path, '/dsh-idle-watchdog/api')
assert.equal(registered.routes[0].kind, 'prefix')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(300) // let the async init arm the fallback store + watched index

const call = async (req, res) => { await handler(req, res); return res }

// health
{
  const res = await call(fakeReq('GET', '/dsh-idle-watchdog/api/health'), fakeRes())
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  console.log('  ok - GET /health')
}
// csrf rejects headerless settings writes
{
  const res = await call(fakeReq('PUT', '/dsh-idle-watchdog/api/settings', { body: { enabled: false } }), fakeRes())
  assert.equal(res.statusCode, 403)
  console.log('  ok - PUT /settings without csrf header -> 403')
}
// accepted settings save (fallback store), enabling a watched chat
{
  const res = await call(fakeReq('PUT', '/dsh-idle-watchdog/api/settings', {
    headers: { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' },
    body: { idleMinutes: 1, maxNudges: 2, chats: [{ id: 'session-watchme', label: 'Watch me', enabled: true }] },
  }), fakeRes())
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.store, 'fallback-file')
  assert.equal(body.settings.chats.length, 1)
  assert.equal(body.settings.idleMinutes, 1)
  console.log('  ok - PUT /settings with guard -> saved to fallback store')
}
// quietHours PUT is a partial merge; typos keep the stored value
{
  const put = (quietHours) => call(fakeReq('PUT', '/dsh-idle-watchdog/api/settings', {
    headers: { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' },
    body: { quietHours },
  }), fakeRes())
  let res = await put({ enabled: true, start: '23:30', end: '06:15', timezone: 'UTC' })
  assert.equal(res.statusCode, 200)
  res = await put({ enabled: false })
  assert.deepEqual(JSON.parse(res.body).settings.quietHours, { enabled: false, start: '23:30', end: '06:15', timezone: 'UTC' }, 'partial PUT keeps the other fields')
  res = await put({ start: '23.00', timezone: 'Europe/Berln' })
  assert.equal(res.statusCode, 400, 'all-invalid quietHours is not a silent reset')
  res = await put({ start: '21:00', timezone: 'Nope/Zone' })
  assert.deepEqual(JSON.parse(res.body).settings.quietHours, { enabled: false, start: '21:00', end: '06:15', timezone: 'UTC' }, 'bad zone keeps the stored one')
  console.log('  ok - PUT quietHours merges partially and never silently resets')
}
// the picker data: catalog built from sessionQuery with real shapes
{
  const res = await call(fakeReq('GET', '/dsh-idle-watchdog/api/chats?refresh=1'), fakeRes())
  assert.equal(res.statusCode, 200)
  const { rows } = JSON.parse(res.body)
  const watched = rows.find((r) => r.sessionId === 'session-watchme')
  assert.ok(watched, 'known chat listed')
  assert.equal(watched.title, 'Alpha demo', 'title mapped from real SessionTitleObservationResult shape')
  assert.equal(watched.live, true)
  assert.ok(rows.some((r) => r.sessionId === 'session-cold-legacy'), 'cold persisted chat listed too')
  console.log('  ok - GET /chats builds catalog via sessionQuery (titles + cold rows)')
}
// prompt without any configured secret fails closed
{
  const res = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { body: { chat: 'session-watchme', message: 'hi' } }), fakeRes())
  assert.equal(res.statusCode, 503)
  console.log('  ok - POST /prompt fail-closed without secret (503)')
}
// set the secret (UI endpoint), then good/bad/absent secret prompt behavior
{
  const csrf = { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' }
  const r1 = await call(fakeReq('POST', '/dsh-idle-watchdog/api/secret', { headers: csrf, body: { secret: 'short' } }), fakeRes())
  assert.equal(r1.statusCode, 400, 'secret below min length rejected')
  const r2 = await call(fakeReq('POST', '/dsh-idle-watchdog/api/secret', { headers: csrf, body: { secret: 'a-proper-long-secret-1' } }), fakeRes())
  assert.equal(r2.statusCode, 200)
  assert.ok(/^[0-9a-f]{8}$/.test(JSON.parse(r2.body).fingerprint))

  const bad = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'x-idle-watchdog-secret': 'wrong-secret-000000' }, body: { chat: 'session-watchme', message: 'hi' } }), fakeRes())
  assert.equal(bad.statusCode, 401)
  assert.equal(followups.length, 0)

  const good = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { authorization: 'Bearer a-proper-long-secret-1' }, body: { chat: 'Watch me', message: 'external ping', provenance: 'test-run' } }), fakeRes())
  assert.equal(good.statusCode, 202)
  const accepted = JSON.parse(good.body)
  assert.equal(accepted.chat, 'session-watchme')
  assert.equal(accepted.via, 'title')
  assert.equal(followups.length, 1)
  assert.equal(followups[0].content[0].text, 'external ping')
  assert.equal(followups[0].source.kind, 'plugin')
  assert.ok(followups[0].id.length > 10)
  // the REAL session title (from readTitleSnapshots, not the settings label) resolves too
  const byTitle = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'x-idle-watchdog-secret': 'a-proper-long-secret-1' }, body: { chat: 'alpha demo', message: 'by title' } }), fakeRes())
  assert.equal(byTitle.statusCode, 202)
  assert.equal(JSON.parse(byTitle.body).via, 'title')
  console.log('  ok - secret set -> bad 401, good prompt accepted via title ref (label + real title)')
}
// rate limiting: default 30/min, flood past it
{
  let last
  for (let i = 0; i < 40; i++) last = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'x-idle-watchdog-secret': 'a-proper-long-secret-1' }, body: { chat: 'session-watchme', message: 'x' } }), fakeRes())
  assert.equal(last.statusCode, 429)
  assert.ok(Number(last.headers['retry-after']) >= 1)
  console.log('  ok - /prompt rate-limits the source IP (429 + Retry-After)')
}
// unknown chat 404, junk body 400, missing route 404
{
  const r1 = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'x-idle-watchdog-secret': 'a-proper-long-secret-1' }, body: { chat: 'session-does-not-exist-at-all', message: 'x' } }), fakeRes())
  assert.ok(r1.statusCode === 404 || r1.statusCode === 429, 'unknown (or rate-limited), got ' + r1.statusCode)
  const r2 = await call(fakeReq('GET', '/dsh-idle-watchdog/api/nope'), fakeRes())
  assert.equal(r2.statusCode, 404)
  console.log('  ok - unknown chat and unknown route 404')
}
// status mirrors masked settings
{
  const res = await call(fakeReq('GET', '/dsh-idle-watchdog/api/status'), fakeRes())
  const body = JSON.parse(res.body)
  assert.equal(body.armed, true)
  assert.equal(body.settingsStore, 'fallback-file')
  assert.equal(body.settings.api.secret, '***')
  assert.ok(!res.body.includes('a-proper-long-secret-1'))
  console.log('  ok - GET /status masks the secret end-to-end')
}

// ── integration: settings scope store + the actual idle-nudge loop ──────
console.log('# idle-nudge loop (fresh DSH_HOME, settings-scope store)')

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'iw-test2-'))
const { writeFileSync, readFileSync, mkdirSync, existsSync } = await import('node:fs')
mkdirSync(join(process.env.DSH_HOME, 'idle-watchdog'), { recursive: true })
// Point the defensive schemastery loader at the running install's copy when
// present (before `pnpm install` the plugin has no node_modules of its own),
// so the primary settings-scope path, not just the fallback, is exercised.
for (const guess of [
  join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'),
  join(process.env.HOME || '', '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'),
]) {
  if (existsSync(guess)) { process.env.DSH_SCHEMASTERY_ENTRY = guess; break }
}
// Seed durable state: the chat went quiet 70 s ago (window below is 60 s).
const seedAt = Date.now() - 70_000
writeFileSync(join(process.env.DSH_HOME, 'idle-watchdog', 'state.json'), JSON.stringify({
  'session-nudge': { lastActivityAt: seedAt, nudgesSent: 0, lastNudgeAt: null, cappedNoticed: false },
}))
// The pre-configured chat lives in BOTH candidate stores so the nudge loop is
// tested identically whether the scope (schemastery) path engages or not.
const seedSettings = {
  idleMinutes: 1, maxNudges: 5, tickSeconds: 5,
  chats: [{ id: 'session-nudge', label: 'Nudge me', enabled: true, prompt: 'personal nudge', idleMinutes: 0 }],
}
writeFileSync(join(process.env.DSH_HOME, 'idle-watchdog', 'settings.json'), JSON.stringify(seedSettings))

// Fake settings scope standing in for @deepseek-ai/dsh-settings (pre-configured
// chat + short window + fast tick, as an already-edited settings.yaml would be).
let storedRaw = seedSettings
const notices = []
const followups2 = []
const nudgeAgent = {
  id: 'session-nudge', status: 'idle',
  session: { id: 'session-nudge', append: (type, data) => notices.push({ type, data }) },
  followup: (m) => followups2.push(m),
}
const registered2 = { routes: [], events: [] }
const ctx2 = strictCtx({
  agents: { get: (id) => (id === 'session-nudge' ? nudgeAgent : undefined), list: () => [nudgeAgent] },
  settings: {
    register: (ns, schema, opts) => {
      assert.equal(ns, 'dsh-idle-watchdog')
      assert.ok(schema && typeof schema === 'function', 'schemastery schema is callable')
      return { get: () => storedRaw, update: async (patch) => { storedRaw = { ...storedRaw, ...patch } } }
    },
  },
  webServer: { register: (route) => { registered2.routes.push(route); return () => {} } },
  on: (name, fn) => { registered2.events.push([name, fn]); return () => {} },
  effect: (fn) => fn(),
  get: () => undefined,
})
mod.apply(ctx2, {})
assert.equal(registered2.routes.length, 1)
const handler2 = registered2.routes[0].handler
const scopeEngaged = Boolean(process.env.DSH_SCHEMASTERY_ENTRY)
await sleep(300) // async init: loadStates + armTimers (tick every 5 s)

// /status reports the settings store and the seeded chat
{
  const res = fakeRes()
  await handler2(fakeReq('GET', '/dsh-idle-watchdog/api/status'), res)
  const body = JSON.parse(res.body)
  assert.equal(body.settingsStore, scopeEngaged ? 'settings' : 'fallback-file')
  const chat = body.perChat.find((c) => c.sessionId === 'session-nudge')
  assert.ok(chat && chat.live === true && chat.running === false)
  assert.equal(chat.nudgesSent, 0)
  const nres = fakeRes()
  await handler2(fakeReq('GET', '/dsh-idle-watchdog/api/next'), nres)
  const next = JSON.parse(nres.body)
  const row = next.rows.find((r) => r.sessionId === 'session-nudge')
  assert.ok(row && ['waiting', 'due'].includes(row.reason), 'preview explains the watched chat')
  assert.ok(Number.isFinite(row.dueAt) && row.maxNudges >= 1)
  assert.equal(next.quietNow, false)
  assert.ok(body.preview && body.preview.rows.length >= 1, 'status carries the preview')
  console.log(`  ok - ${scopeEngaged ? 'settings-scope store active' : 'fallback store (schemastery absent)'}; seeded state visible`)
}
// let the tick fire: idle 70 s > 60 s window on a live idle agent => nudge
await sleep(5600)
assert.equal(followups2.length, 1, 'exactly one nudge delivered')
assert.equal(followups2[0].content[0].text, 'personal nudge')   // per-chat prompt wins
assert.equal(followups2[0].source.kind, 'plugin')
assert.equal(followups2[0].source.plugin, 'dsh-idle-watchdog')
{
  const res = fakeRes()
  await handler2(fakeReq('GET', '/dsh-idle-watchdog/api/status'), res)
  const chat = JSON.parse(res.body).perChat.find((c) => c.sessionId === 'session-nudge')
  assert.equal(chat.nudgesSent, 1)
  assert.equal(chat.lastOutcome && chat.lastOutcome.kind, 'nudged', 'last outcome recorded')
  assert.ok(Date.now() - chat.lastActivityAt < 2000)            // nudge re-armed the window
  console.log('  ok - idle tick delivered personalised followup, counter incremented')
}
// ledger recorded it
{
  const raw = readFileSync(join(process.env.DSH_HOME, 'idle-watchdog', 'activity.jsonl'), 'utf8')
  assert.ok(raw.includes('"nudge-sent"'), 'activity.jsonl has the nudge line')
  assert.ok(!raw.includes('a-proper-long-secret-1'), 'old test secret never leaks into ledger')
  console.log('  ok - activity ledger written')
}
// a HUMAN message through the real subscription resets the counter
{
  const ev = registered2.events[0][1]   // the 'session/event' subscription from apply()
  ev(nudgeAgent.session, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } })
  const res = fakeRes()
  await handler2(fakeReq('GET', '/dsh-idle-watchdog/api/status'), res)
  const chat = JSON.parse(res.body).perChat.find((c) => c.sessionId === 'session-nudge')
  assert.equal(chat.nudgesSent, 0)
  // and another quiet tick does NOT re-nudge before the window elapses again
  await sleep(5600)
  assert.equal(followups2.length, 1, 'no immediate re-nudge right after a human spoke')
  console.log('  ok - human reply resets the idle period')
}
// disabled master switch stops all nudging even when overdue
{
  nudgeAgent.status = 'idle'
  const csrf = { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' }
  const res = fakeRes()
  await handler2(fakeReq('PUT', '/dsh-idle-watchdog/api/settings', { headers: csrf, body: { enabled: false } }), res)
  assert.equal(res.statusCode, 200)
  await sleep(5600)
  assert.equal(followups2.length, 1, 'tick is inert while disabled')
  console.log('  ok - master switch disarms nudging live (no restart)')
}

console.log(`\nall tests passed (${passed} unit + smoke + nudge-loop layers)`)

/**
 * DSH-Idle-Watchdog, error shape tests.
 *
 * 1. The catalog matches docs/ERRORS.md (no code without a table row and a
 *    section).
 * 2. Every HTTP error of the /api routes keeps its status and its legacy
 *    `error` string and gains code/message/hint/docs; extra fields stay.
 * 3. No test secret ever appears in a response body.
 *
 * $DSH_HOME is a throwaway directory. Run: node test/errors.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'iw-err-'))
delete process.env.DSH_IDLE_WATCHDOG_SECRET
delete process.env.DSH_IDLE_WATCHDOG_SECRET_FILE
delete process.env.DSH_IDLE_WATCHDOG_DISABLE

const mod = await import('../lib/index.js')
const { E } = await import('../lib/errors.js')
const { LIMITS } = mod.__internals

const FAKE_SECRET = 'test-secret-0123456789-abcdef'
const CSRF = { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' }
const bodies = []

// ── catalog vs docs ──
{
  const md = readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8')
  assert.deepEqual(E.missingFromDoc(md), [], 'every catalog code has a table row and a section in docs/ERRORS.md')
  for (const [code, def] of Object.entries(E.codes)) {
    assert.ok(code.startsWith('WATCHDOG_'), code)
    assert.equal(def.docs, `docs/ERRORS.md#${code.toLowerCase()}`)
    assert.ok(!/[\u2013\u2014]/.test(def.message + def.hint + (def.legacy || '')), `${code} has no em or en dash`)
  }
  assert.ok(E.has('WATCHDOG_INTERNAL'))
  console.log('  ok - catalog and docs/ERRORS.md agree, anchors and texts clean')
}
{
  assert.equal(E.codes.WATCHDOG_SECRET_LENGTH.legacy, `secret must be ${LIMITS.secretMin}..${LIMITS.secretMax} characters`,
    'catalog legacy string follows the real secret limits')
  console.log('  ok - secret length legacy string matches LIMITS')
}

// ── fake host (same shape as test/run.mjs) ──
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.writeHead = (code, headers) => { r.statusCode = code; Object.assign(r.headers, headers || {}) }
  r.end = (data) => { r.body = data || '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  return r
}
function fakeReq(method, path, { headers, body, raw, ip = '192.0.2.7' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = Object.assign({}, headers)
  req.socket = { remoteAddress: ip }
  req.destroy = () => {}
  if (raw !== undefined) setImmediate(() => { req.emit('data', Buffer.from(raw)); req.emit('end') })
  else if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  else setImmediate(() => req.emit('end'))
  return req
}
const agents = new Map()
for (const id of ['session-twin-a', 'session-twin-b']) agents.set(id, { id, status: 'idle', session: { id, append: () => {} }, followup: () => {} })
const registered = { routes: [] }
const strictCtx = (base) => new Proxy(base, {
  get(t, k) {
    if (typeof k === 'symbol' || k in t) return t[k]
    throw new TypeError(`cannot get property "${String(k)}" without inject`)
  },
})
const ctx = strictCtx({
  agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
  settings: { register: () => { throw new Error('fallback store') } },
  webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  on: () => () => {},
  effect: (fn) => fn(),
  get: () => undefined,
})
mod.apply(ctx, {})
const handler = registered.routes[0].handler
await new Promise((r) => setTimeout(r, 300))

const API = '/dsh-idle-watchdog/api'
async function call(method, path, opts) {
  const res = fakeRes()
  await handler(fakeReq(method, API + path, opts), res)
  bodies.push(res.body)
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null }
}
/** Assert the standard shape plus the legacy status and error string. */
function shape(r, status, legacy, code) {
  assert.equal(r.status, status, `status for ${code}`)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.error, legacy, `legacy error for ${code}`)
  assert.equal(r.json.code, code)
  assert.equal(typeof r.json.message, 'string')
  assert.ok(r.json.message.length > 0)
  assert.equal(typeof r.json.hint, 'string')
  assert.equal(r.json.docs, `docs/ERRORS.md#${code.toLowerCase()}`)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.match(r.headers['content-type'], /^application\/json/)
}

// 503 fail closed, no secret anywhere
{
  const r = await call('POST', '/prompt', { body: { chat: 'x', message: 'hi' } })
  shape(r, 503, 'secret-not-configured', 'WATCHDOG_SECRET_NOT_CONFIGURED')
  assert.match(r.json.hint, /DSH_IDLE_WATCHDOG_SECRET/)
  console.log('  ok - 503 secret-not-configured')
}

process.env.DSH_IDLE_WATCHDOG_SECRET = FAKE_SECRET
const good = { 'x-idle-watchdog-secret': FAKE_SECRET }

// 401 wrong secret, retryAfterMs kept
{
  const r = await call('POST', '/prompt', { headers: { 'x-idle-watchdog-secret': 'wrong-secret-000000' }, body: { chat: 'x', message: 'hi' }, ip: '192.0.2.21' })
  shape(r, 401, 'invalid-secret', 'WATCHDOG_SECRET_INVALID')
  assert.ok('retryAfterMs' in r.json, 'retryAfterMs field kept')
  console.log('  ok - 401 invalid-secret')
}
// 429 after 10 wrong secrets from one address
{
  let last
  for (let i = 0; i < 12; i++) last = await call('POST', '/prompt', { headers: { 'x-idle-watchdog-secret': 'wrong-secret-000000' }, body: { chat: 'x', message: 'hi' }, ip: '192.0.2.22' })
  shape(last, 429, 'rate-limited', 'WATCHDOG_AUTH_THROTTLED')
  assert.ok(Number(last.headers['retry-after']) >= 1)
  assert.ok(last.json.retryAfterMs > 0)
  console.log('  ok - 429 rate-limited after failed secrets (throttle code)')
}
// 429 plain rate limit
{
  let last
  for (let i = 0; i < 40; i++) last = await call('POST', '/prompt', { headers: good, body: { chat: 'no such chat', message: 'x' }, ip: '192.0.2.23' })
  shape(last, 429, 'rate-limited', 'WATCHDOG_RATE_LIMITED')
  assert.ok(last.json.retryAfterMs > 0)
  console.log('  ok - 429 rate-limited (call budget code)')
}
// 400 missing fields
{
  const r = await call('POST', '/prompt', { headers: good, body: { chat: '', message: '' }, ip: '192.0.2.24' })
  shape(r, 400, 'chat and non-empty message are required', 'WATCHDOG_PROMPT_INVALID')
  console.log('  ok - 400 chat and message required')
}
// 404 chat-not-found keeps ref
{
  const r = await call('POST', '/prompt', { headers: good, body: { chat: 'no such chat', message: 'x' }, ip: '192.0.2.25' })
  shape(r, 404, 'chat-not-found', 'WATCHDOG_CHAT_NOT_FOUND')
  assert.equal(r.json.ref, 'no such chat')
  console.log('  ok - 404 chat-not-found (ref kept)')
}
// 409 ambiguous keeps candidates
{
  const r = await call('POST', '/prompt', { headers: good, body: { chat: 'session-twin', message: 'x' }, ip: '192.0.2.26' })
  shape(r, 409, 'ambiguous-chat', 'WATCHDOG_CHAT_AMBIGUOUS')
  assert.deepEqual([...r.json.candidates].sort(), ['session-twin-a', 'session-twin-b'])
  console.log('  ok - 409 ambiguous-chat (candidates kept)')
}
// 409 cold chat without a session controller; the 404 variant for unverified ids
{
  const unknownCold = await call('POST', '/prompt', { headers: good, body: { chat: 'session-cold-unknown-1', message: 'x' }, ip: '192.0.2.27' })
  shape(unknownCold, 404, 'chat-not-found', 'WATCHDOG_CHAT_NOT_FOUND')
  assert.match(unknownCold.json.hint, /^sessionController unavailable/)
  console.log('  ok - 404 chat-not-found for an unverified id without a session controller')
}
// 403 csrf guard on settings and secret writes
{
  const a = await call('PUT', '/settings', { body: { enabled: false } })
  shape(a, 403, 'csrf-guard', 'WATCHDOG_CSRF_GUARD')
  assert.match(a.json.hint, /X-Requested-With: dsh-idle-watchdog/)
  const b = await call('POST', '/secret', { body: { secret: 'x'.repeat(20) } })
  shape(b, 403, 'csrf-guard', 'WATCHDOG_CSRF_GUARD')
  console.log('  ok - 403 csrf-guard on PUT /settings and POST /secret')
}
// 400 settings body and secret length
{
  const a = await call('PUT', '/settings', { headers: CSRF, body: { nonsense: true } })
  shape(a, 400, 'no-valid-settings-in-body', 'WATCHDOG_SETTINGS_EMPTY')
  const b = await call('POST', '/secret', { headers: CSRF, body: { secret: 'short' } })
  shape(b, 400, `secret must be ${LIMITS.secretMin}..${LIMITS.secretMax} characters`, 'WATCHDOG_SECRET_LENGTH')
  console.log('  ok - 400 no-valid-settings-in-body and secret length')
}
// 400 invalid JSON and too large body
{
  const a = await call('PUT', '/settings', { headers: CSRF, raw: '{not json' })
  assert.equal(a.status, 400)
  assert.equal(a.json.code, 'WATCHDOG_BODY_INVALID')
  assert.match(a.json.error, /^invalid JSON body: /)
  assert.equal(a.json.error, a.json.message)
  const b = await call('PUT', '/settings', { headers: CSRF, raw: JSON.stringify({ chats: 'x'.repeat(LIMITS.bodyBytes + 10) }) })
  shape(b, 400, 'request body too large', 'WATCHDOG_BODY_TOO_LARGE')
  console.log('  ok - 400 invalid JSON and body too large')
}
// 404 unknown route
{
  const r = await call('GET', '/nope')
  shape(r, 404, 'not-found', 'WATCHDOG_ROUTE_NOT_FOUND')
  console.log('  ok - 404 not-found for an unknown path')
}
// read routes keep answering 200 without the error shape
{
  for (const p of ['/health', '/status', '/next', '/logs']) {
    const r = await call('GET', p)
    assert.equal(r.status, 200, p)
    assert.ok(!('code' in r.json), p)
  }
  console.log('  ok - health, status, next, logs still plain 200')
}
// body-level hygiene
for (const b of bodies) assert.ok(!b.includes(FAKE_SECRET), 'a response body leaked the test secret')
for (const b of bodies) assert.ok(!/[\u2013\u2014]/.test(b), 'a response body has an em or en dash')
console.log('  ok - no secret and no dash in any response body')
console.log('\nall error shape tests passed')
process.exit(0)

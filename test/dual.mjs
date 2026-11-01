/**
 * DSH-Idle-Watchdog: settings on DSH 0.1.5 (register) AND DSH 0.2.x (forms).
 *
 * Needs the harness schemastery with volatile support for the 0.2 half:
 *   DSH_GLOBAL_PREFIX=<prefix of a dsh 0.2.x install> node test/dual.mjs
 * Without it the 0.2 half is skipped (reported), the 0.1.5 half always runs.
 *
 * Covers: same effective settings from the same legacy section on both lines,
 * the one-time import from settings.yaml.imported (name mismatch: section
 * dsh-idle-watchdog, entry idle-watchdog), the API secret moved into the 0600
 * secret file and never into the profile row, env > file > stored precedence,
 * no re-import over a configured row, and secret rotation via POST /secret.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const SECRET = 'legacy-secret-0123456789abcdef'
const LEGACY = `dsh-idle-watchdog:
  enabled: true
  idleMinutes: 45
  maxNudges: 3
  tickSeconds: 30
  defaultPrompt: Keep going please.
  notifyOnCap: true
  wakeColdForApi: true
  api:
    rateLimitPerMinute: 12
    secret: ${SECRET}
  chats:
    - id: session-abc
      label: Alpha
      enabled: true
`
const home = mkdtempSync(join(tmpdir(), 'iw-dual-'))
process.env.DSH_HOME = home
delete process.env.DSH_IDLE_WATCHDOG_SECRET
const mod = await import('../lib/index.js')
const { loadHostSchemastery } = await import('../lib/dual-settings.js')
const z = loadHostSchemastery(import.meta.url)
const volatileOk = Boolean(z && typeof z.prototype.volatile === 'function')

let passed = 0
const ok = (m) => { passed++; console.log('  ok - ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strictCtx = (base) => new Proxy(base, {
  get(t, k) {
    if (typeof k === 'symbol' || k in t) return t[k]
    throw new TypeError(`cannot get property "${String(k)}" without inject`)
  },
})
function fakeReq(method, url, { headers = {}, body } = {}) {
  const req = new EventEmitter()
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress: '127.0.0.1' } })
  // Like a real IncomingMessage: nothing flows until a 'data' listener exists,
  // so an await before the body read (the secret file stat) loses nothing.
  let flowing = false
  const on = req.on.bind(req)
  req.on = (ev, fn) => {
    on(ev, fn)
    if (ev === 'data' && !flowing) {
      flowing = true
      setImmediate(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    }
    return req
  }
  req.destroy = () => {}
  return req
}
function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}) }, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ? String(b) : '' } }
}
const guard = { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' }
const agents = { get: () => undefined, list: () => [] }

async function boot(settings, extra = {}, config = {}) {
  const routes = []
  const ctx = strictCtx({
    agents, settings,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    on: () => () => {}, effect: (fn) => fn(), get: () => undefined,
    ...extra,
  })
  mod.apply(ctx, config)
  await sleep(250)
  const call = async (req) => { const res = fakeRes(); await routes[0].handler(req, res); return res }
  return { call }
}
const status = async (call) => JSON.parse((await call(fakeReq('GET', '/dsh-idle-watchdog/api/status'))).body)

// ── default export: what the 0.2.x loader reads (`exports.default ?? exports`) ──
{
  const plugin = mod.default ?? mod
  assert.equal(typeof plugin, 'object', 'a default OBJECT, never the bare apply function')
  assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.equal(plugin.name, mod.name); assert.deepEqual(plugin.inject, mod.inject); assert.equal(plugin.apply, mod.apply)
  assert.equal(plugin.Config, mod.Config, 'Config is the same object on the named and the default export')
  if (volatileOk) assert.ok(plugin.Config && plugin.Config.dict && plugin.Config.dict.idleMinutes, 'Config carries the live fields the loader needs')
  ok('Config is on the default export object { name, inject, apply, Config }')
}

// ── 0.1.5: registered namespace (identical to v1.1.0 behaviour) ────────────
console.log('# DSH 0.1.5 register mode')
let v15
{
  const yamlSection = {
    enabled: true, idleMinutes: 45, maxNudges: 3, tickSeconds: 30, defaultPrompt: 'Keep going please.',
    notifyOnCap: true, wakeColdForApi: true, api: { rateLimitPerMinute: 12, secret: SECRET },
    chats: [{ id: 'session-abc', label: 'Alpha', enabled: true }],
  }
  let stored = structuredClone(yamlSection)
  const registered = []
  const { call } = await boot({
    register(ns, schema, opts) { registered.push([ns, opts.applies]); return { get: () => stored, update: async (p) => { stored = { ...stored, ...p } } } },
  })
  assert.deepEqual(registered, [['dsh-idle-watchdog', 'live']])
  ok('registers namespace dsh-idle-watchdog, applies live')
  const st = await status(call)
  assert.equal(st.settingsStore, 'settings')
  assert.equal(st.secretSource, 'settings', 'no file yet: the stored secret is used, as before')
  assert.ok(!JSON.stringify(st).includes(SECRET), 'status never carries the secret')
  v15 = st.settings
  ok('status redacted, store=settings, secretSource=settings')
  const pr = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'content-type': 'application/json', 'x-idle-watchdog-secret': SECRET }, body: { chat: 'nope', message: 'x' } }))
  assert.notEqual(pr.statusCode, 401); assert.notEqual(pr.statusCode, 503)
  ok('external prompt accepts the stored secret (got ' + pr.statusCode + ' for an unknown chat)')
  const NEW = 'rotated-secret-abcdef0123456789'
  const rs = await call(fakeReq('POST', '/dsh-idle-watchdog/api/secret', { headers: guard, body: { secret: NEW } }))
  assert.equal(rs.statusCode, 200)
  assert.equal(stored.api.secret, NEW, '0.1.5 keeps writing the namespace copy')
  const file = join(home, 'idle-watchdog', 'api-secret')
  assert.equal(readFileSync(file, 'utf8').trim(), NEW)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  ok('POST /secret writes the namespace AND the 0600 secret file')
  await call(fakeReq('POST', '/dsh-idle-watchdog/api/secret', { headers: guard, body: { clear: true } }))
  assert.equal(existsSync(file), false); assert.equal(stored.api.secret, '')
  ok('clear removes both')
}

// ── 0.2.x: forms over the live Config, profile row ─────────────────────────
if (!volatileOk) {
  console.log('# DSH 0.2 forms mode SKIPPED (set DSH_GLOBAL_PREFIX to a dsh 0.2.x prefix)')
} else {
  console.log('# DSH 0.2 forms mode')
  const home2 = mkdtempSync(join(tmpdir(), 'iw-dual2-'))
  process.env.DSH_HOME = home2
  writeFileSync(join(home2, 'settings.yaml.imported'), LEGACY, { mode: 0o600 })
  const WRITE = Symbol.for('cosmokit.volatile.write')
  let user = {}
  const writes = []
  const config = mod.Config(structuredClone(user))
  const fiber = {}
  const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b
  const forms = {
    describe: () => [{ ns: 'idle-watchdog', user: structuredClone(user) }],
    async update(id, patch) {
      assert.equal(id, 'idle-watchdog')
      for (const k of Object.keys(patch)) assert.ok(mod.Config.dict[k] && mod.Config.dict[k].meta.volatile, `field ${k} is live`)
      writes.push(structuredClone(patch))
      user = merge(user, patch)
      const next = mod.Config(structuredClone(user))
      for (const [k, v] of Object.entries(config)) if (v && WRITE in v) v[WRITE](next[k].get())
    },
    configure: () => () => {},
  }
  const extra = {
    fiber,
    loader: { entries: () => [{ options: { id: 'idle-watchdog', name: 'dsh-idle-watchdog' }, fiber }], await: async () => {} },
    profileContext: { home: home2 },
  }
  const { call } = await boot(forms, extra, config)
  await sleep(200)
  assert.equal(writes.length, 1, 'one import write')
  assert.ok(!JSON.stringify(writes[0]).includes(SECRET), 'the secret never reaches the profile row')
  ok('legacy section dsh-idle-watchdog imported into entry idle-watchdog without the secret')
  const file = join(home2, 'idle-watchdog', 'api-secret')
  assert.equal(readFileSync(file, 'utf8').trim(), SECRET)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  ok('secret moved into the 0600 secret file')
  const st = await status(call)
  assert.equal(st.settingsStore, 'profile-row')
  assert.equal(st.secretSource, 'file')
  assert.ok(st.settings.api.secretFingerprint, 'the UI sees a configured secret (fingerprint of the file secret)')
  assert.ok(!JSON.stringify(st).includes(SECRET))
  const strip = (s) => ({ ...s, api: { ...s.api, secret: undefined, secretFingerprint: undefined } })
  assert.deepEqual(strip(st.settings), strip(v15), 'same effective settings as on 0.1.5 from the same section')
  ok('effective settings identical to the 0.1.5 run')
  const pr = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'content-type': 'application/json', 'x-idle-watchdog-secret': SECRET }, body: { chat: 'nope', message: 'x' } }))
  assert.notEqual(pr.statusCode, 401); assert.notEqual(pr.statusCode, 503)
  ok('external prompt accepts the file secret')
  process.env.DSH_IDLE_WATCHDOG_SECRET = 'env-secret-0123456789abcdef'
  assert.equal((await status(call)).secretSource, 'env')
  delete process.env.DSH_IDLE_WATCHDOG_SECRET
  ok('env wins over the file')
  const sv = await call(fakeReq('PUT', '/dsh-idle-watchdog/api/settings', { headers: guard, body: { idleMinutes: 50 } }))
  assert.equal(sv.statusCode, 200)
  assert.equal(JSON.parse(sv.body).store, 'profile-row')
  assert.equal((await status(call)).settings.idleMinutes, 50)
  ok('PUT /settings writes the profile row and is live')
  const NEW = 'rotated-secret-abcdef0123456789'
  await call(fakeReq('POST', '/dsh-idle-watchdog/api/secret', { headers: guard, body: { secret: NEW } }))
  assert.equal(readFileSync(file, 'utf8').trim(), NEW)
  assert.ok(!JSON.stringify(user).includes(NEW), 'rotation never reaches the row')
  await sleep(5100) // file cache window
  const pr2 = await call(fakeReq('POST', '/dsh-idle-watchdog/api/prompt', { headers: { 'content-type': 'application/json', 'x-idle-watchdog-secret': NEW }, body: { chat: 'nope', message: 'x' } }))
  assert.notEqual(pr2.statusCode, 401)
  ok('rotation via POST /secret goes to the file only')
  // a second boot must not re-import over the configured row
  const before = writes.length
  await boot(forms, extra, config)
  await sleep(200)
  assert.equal(writes.length, before)
  ok('no re-import once the row carries values')
}
console.log(`\nall dual tests passed (${passed})`)

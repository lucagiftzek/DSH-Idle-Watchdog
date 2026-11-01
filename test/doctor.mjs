/**
 * DSH-Idle-Watchdog: skill registration, benign init log, default export and the doctor.
 *   node test/doctor.mjs
 *   DSH_GLOBAL_PREFIX=<prefix of a dsh 0.2.x install> node test/doctor.mjs   (also runs against the real skill registry)
 * $DSH_HOME is a throwaway directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const root = mkdtempSync(join(tmpdir(), 'iw-doctor-'))
process.env.DSH_HOME = join(root, 'home')
delete process.env.DSH_IDLE_WATCHDOG_SECRET
delete process.env.DSH_IDLE_WATCHDOG_SECRET_FILE
delete process.env.DSH_IDLE_WATCHDOG_DISABLE

const mod = await import('../lib/index.js')

let passed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (m) => { passed++; console.log('  ok - ' + m) }

const strictCtx = (base) => new Proxy(base, {
  get(t, k) {
    if (typeof k === 'symbol' || k in t) return t[k]
    throw new TypeError(`cannot get property "${String(k)}" without inject`)
  },
})
function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}) }, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ? String(b) : '' } }
}
function fakeReq(method, url, { headers = {} } = {}) {
  const req = new EventEmitter()
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress: '127.0.0.1' }, destroy() {} })
  setImmediate(() => req.emit('end'))
  return req
}
/** Boot the plugin against a fake host; returns the route caller and the captured console lines. */
async function boot(extra = {}) {
  const routes = []
  const lines = { log: [], error: [] }
  const origLog = console.log, origErr = console.error
  console.log = (...a) => { lines.log.push(a.join(' ')) }
  console.error = (...a) => { lines.error.push(a.join(' ')) }
  try {
    const ctx = strictCtx({
      agents: { get: () => undefined, list: () => [] },
      settings: { register: () => { throw new Error('fallback store') } },
      webServer: { register: (r) => { routes.push(r); return () => {} } },
      on: () => () => {}, effect: (fn) => fn(), get: () => undefined,
      ...extra,
    })
    mod.apply(ctx, {})
    await sleep(300)
  } finally { console.log = origLog; console.error = origErr }
  const call = async (method, path, opts) => { const res = fakeRes(); await routes[0].handler(fakeReq(method, '/dsh-idle-watchdog/api' + path, opts), res); return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null, body: res.body } }
  return { call, lines }
}

// ── skill registration ──
{
  let provider = null
  await boot({ inject(deps, cb) { assert.deepEqual(deps, ['skills']); cb({ skills: { registerProvider(f) { provider = f() } } }) } })
  assert.ok(provider, 'a skill provider was registered')
  assert.equal(provider.name, 'plugin-dsh-idle-watchdog')
  const list = await provider.list()
  assert.deepEqual(list.map((s) => s.name), ['idle-watchdog-doctor'])
  assert.match((await provider.get(list[0], {})).content, /Idle Watchdog doctor|idle watchdog doctor/i)
  ok('apply registers the packaged idle-watchdog-doctor skill through ctx.inject(["skills"])')
}
{
  const PREFIX = process.env.DSH_GLOBAL_PREFIX
  if (!PREFIX) console.log('  skip - real skill registry (DSH_GLOBAL_PREFIX not set)')
  else {
    const N = join(PREFIX, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    const { Context } = await import(join(N, 'cordis/lib/index.js'))
    const sk = await import(join(N, 'dsh-skill/lib/index.js'))
    const { registerPluginSkills } = await import('../lib/plugin-skills.js')
    const rootCtx = new Context()
    await rootCtx.plugin({ name: 'iw-skill-probe', apply(ctx) { registerPluginSkills(ctx, { plugin: 'dsh-idle-watchdog', dir: new URL('../skills/', import.meta.url) }) } })
    await rootCtx.plugin(sk.SkillRegistry ?? sk.default)
    await sleep(100)
    const list = await rootCtx.skills.list({})
    assert.ok(list.some((s) => s.name === 'idle-watchdog-doctor' && s.provider === 'plugin-dsh-idle-watchdog'))
    assert.ok((await rootCtx.skills.get('idle-watchdog-doctor', {})).content.length > 100)
    ok('the real skill registry lists and loads idle-watchdog-doctor')
  }
}
{
  const shared = process.env.DSH_PLUGIN_SKILLS_SHARED  // optional: path of the shared plugin-skills.js the vendored copy tracks
  let src = null
  if (shared) { try { src = readFileSync(shared, 'utf8') } catch { /* shared source not present */ } }
  if (src !== null) {
    assert.equal(readFileSync(new URL('../lib/plugin-skills.js', import.meta.url), 'utf8'), src)
    ok('vendored plugin-skills.js is byte-identical to the shared source')
  }
}

// ── benign fresh-install init line ──
{
  const stateless = mkdtempSync(join(tmpdir(), 'iw-init-'))
  process.env.DSH_HOME = stateless
  let b = await boot()
  const all = [...b.lines.log, ...b.lines.error]
  assert.ok(!all.some((l) => l.includes('WATCHDOG_INIT_FAILED')), 'no failure code on a fresh install: ' + all.join(' | '))
  assert.ok(b.lines.log.some((l) => l === 'idle-watchdog: init: no fallback settings.json yet (fresh install), nothing to load'), 'info line present')
  assert.ok(!b.lines.error.some((l) => /ENOENT/.test(l)))
  ok('a missing settings.json is an info line without a failure code')

  // a real init failure stays coded
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(stateless, 'idle-watchdog'), { recursive: true })
  writeFileSync(join(stateless, 'idle-watchdog', 'settings.json'), '{ not json')
  b = await boot()
  assert.ok(b.lines.error.some((l) => l.startsWith('idle-watchdog: WATCHDOG_INIT_FAILED init:')), 'corrupt settings.json is still WATCHDOG_INIT_FAILED')
  ok('a corrupt settings.json is still logged as WATCHDOG_INIT_FAILED')
  rmSync(stateless, { recursive: true, force: true })
  process.env.DSH_HOME = join(root, 'home')
}

// ── doctor: unit ──
const { watchdogDoctor } = await import('../lib/doctor.js')
const { E } = await import('../lib/errors.js')
const byId = (r, id) => r.checks.find((c) => c.id === id)
const SECRET_ENV = 'env-secret-PLANTED-0123456789'
const SECRET_FILE = 'file-secret-PLANTED-0123456789'
const SECRET_SET = 'stored-secret-PLANTED-0123456789'
const PLANTED = [SECRET_ENV, SECRET_FILE, SECRET_SET]

{
  const dir = mkdtempSync(join(tmpdir(), 'iw-doc-unit-'))
  const { writeFileSync, chmodSync, mkdirSync } = await import('node:fs')
  const secretFile = join(dir, 'api-secret')
  const stateFile = join(dir, 'state.json')
  const eff = { enabled: true, tickSeconds: 30, wakeColdForApi: true, chats: [{ id: 'session-a', enabled: true }, { id: 'session-b', enabled: false }] }
  const now = 1_000_000_000
  const base = (over = {}) => ({
    ctx: { get: (n) => (n === 'sessionController' ? { resolveAgent() {} } : undefined) },
    version: '1.2.0', store: { mode: 'forms', entryId: 'idle-watchdog', writable: () => true }, configVisible: true,
    settings: () => eff, configuredSecret: async () => ({ source: 'file', value: SECRET_FILE }), readSecretFile: async () => SECRET_FILE,
    secretFile, stateFile, preview: () => ({ rows: [{ action: 'nudge' }, { action: 'wait' }], quietNow: false }),
    lastTickAt: () => now - 10_000, bootedAt: now - 600_000, stateWriteFailing: () => false, now, ...over,
  })
  writeFileSync(secretFile, SECRET_FILE + '\n', { mode: 0o600 }); chmodSync(secretFile, 0o600)

  let r = await watchdogDoctor(base())
  assert.equal(r.plugin, 'dsh-idle-watchdog'); assert.equal(r.version, '1.2.0'); assert.ok(r.host && r.generatedAt)
  assert.equal(r.docs, 'docs/TROUBLESHOOTING.md')
  assert.equal(byId(r, 'secret').detail, 'configured (source file)')
  assert.equal(byId(r, 'secret_file').status, 'ok')
  assert.equal(byId(r, 'watched_chats').detail, '2 configured, 1 watched')
  assert.equal(byId(r, 'session_controller').status, 'ok')
  assert.match(byId(r, 'preview').detail, /2 chats evaluated, 1 would be nudged/)
  assert.match(byId(r, 'tick').detail, /last scan 10 s ago/)
  assert.equal(byId(r, 'state_file').status, 'ok')
  for (const p of PLANTED) assert.ok(!JSON.stringify(r).includes(p), 'secret leaked')
  assert.ok(!JSON.stringify(r).includes(dir), 'path leaked')
  ok('doctor: healthy report, secret reported as boolean plus source, no value or path')

  // every non-ok row of a stressed report carries a catalog code or a hint, and never a secret
  chmodSync(secretFile, 0o644)
  r = await watchdogDoctor(base({
    configuredSecret: async () => ({ source: 'none', value: '' }), ctx: { get: () => undefined }, lastTickAt: () => 0, bootedAt: now - 900_000,
    stateWriteFailing: () => true, store: { mode: 'config', writable: () => true }, preview: () => ({ rows: [], quietNow: false }),
  }))
  assert.equal(r.status, 'warn')
  assert.equal(byId(r, 'secret').code, 'WATCHDOG_SECRET_NOT_CONFIGURED'); assert.equal(byId(r, 'secret').human, true)
  assert.equal(byId(r, 'secret_file').status, 'warn'); assert.match(byId(r, 'secret_file').detail, /mode 644/)
  assert.equal(byId(r, 'session_controller').code, 'WATCHDOG_RESOLVER_UNAVAILABLE')
  assert.equal(byId(r, 'tick').code, 'WATCHDOG_TICK_FAILED')
  assert.equal(byId(r, 'state_file').code, 'WATCHDOG_STATE_WRITE_FAILED')
  assert.equal(byId(r, 'settings').status, 'warn')
  for (const c of r.checks) {
    if (c.code) assert.ok(E.has(c.code) && c.docs === E.codes[c.code].docs && c.hint, c.id)
    if (c.status === 'warn' || c.status === 'fail') assert.ok(c.hint && c.docs, c.id + ' has a hint')
  }
  for (const p of PLANTED) assert.ok(!JSON.stringify(r).includes(p))
  chmodSync(secretFile, 0o600)
  ok('doctor: stressed install gives coded warnings with hints')

  r = await watchdogDoctor(base({ readSecretFile: async () => '' }))
  assert.equal(byId(r, 'secret_file').code, 'WATCHDOG_SECRET_LENGTH')
  r = await watchdogDoctor(base({ ctx: { settings: { update() {}, describe() {} }, get: () => undefined }, configVisible: false }))
  assert.equal(byId(r, 'config').status, 'fail')
  r = await watchdogDoctor(base({ ctx: { settings: { update() {}, describe() {} }, get: () => undefined }, configVisible: true }))
  assert.equal(byId(r, 'config').status, 'ok')
  r = await watchdogDoctor(base({ ctx: { get: () => undefined }, settings: () => ({ ...eff, wakeColdForApi: false }) }))
  assert.equal(byId(r, 'session_controller').status, 'info')
  r = await watchdogDoctor(base({ stateFile: join(dir, 'new', 'deeper', 'state.json') }))
  assert.match(byId(r, 'state_file').detail, /created on first save/)
  assert.ok(!fs_exists(join(dir, 'new')), 'the doctor never creates the directory')
  ok('doctor: secret length, Config visibility, cold-wake off and a missing state directory')

  r = await watchdogDoctor({ ...base(), store: { get mode() { throw new Error('boom') } }, settings: () => { throw new Error('boom') }, preview: () => { throw new Error('boom') }, configuredSecret: async () => { throw new Error('boom') } })
  assert.ok(['ok', 'warn', 'fail'].includes(r.status)); assert.equal(byId(r, 'preview').status, 'fail')
  ok('doctor never throws: failing probes become failing rows')
  rmSync(dir, { recursive: true, force: true })
}
function fs_exists(p) { try { statSync(p); return true } catch { return false } }

// ── doctor: route ──
{
  const home = mkdtempSync(join(tmpdir(), 'iw-doc-route-'))
  process.env.DSH_HOME = home
  const { mkdirSync, writeFileSync, chmodSync, readdirSync, statSync: st2 } = await import('node:fs')
  mkdirSync(join(home, 'idle-watchdog'), { recursive: true })
  writeFileSync(join(home, 'idle-watchdog', 'settings.json'), JSON.stringify({ chats: [{ id: 'session-aaa', label: 'A' }], api: { secret: SECRET_SET } }))
  writeFileSync(join(home, 'idle-watchdog', 'api-secret'), SECRET_FILE + '\n', { mode: 0o600 }); chmodSync(join(home, 'idle-watchdog', 'api-secret'), 0o600)
  process.env.DSH_IDLE_WATCHDOG_SECRET = SECRET_ENV
  const agents = new Map([['session-aaa', { id: 'session-aaa', status: 'idle', session: { id: 'session-aaa', append() {} }, followup() {} }]])
  const b = await boot({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } })
  const snapshot = () => readdirSync(join(home, 'idle-watchdog')).sort().map((n) => n + ':' + st2(join(home, 'idle-watchdog', n)).size).join(',')
  const before = snapshot()
  const r = await b.call('GET', '/doctor')
  assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store'); assert.match(r.headers['content-type'], /^application\/json/)
  assert.equal(r.json.plugin, 'dsh-idle-watchdog'); assert.ok(['ok', 'warn', 'fail'].includes(r.json.status))
  assert.deepEqual(r.json.checks.map((c) => c.id), ['plugin', 'settings', 'config', 'secret', 'secret_file', 'watched_chats', 'session_controller', 'preview', 'tick', 'state_file'])
  assert.equal(byId(r.json, 'secret').detail, 'configured (source env)')
  assert.equal(byId(r.json, 'secret_file').status, 'ok')
  assert.equal(byId(r.json, 'watched_chats').detail, '1 configured, 1 watched')
  assert.equal(byId(r.json, 'preview').status, 'ok')
  assert.equal(byId(r.json, 'state_file').status, 'ok')
  for (const p of PLANTED) assert.ok(!r.body.includes(p), 'secret leaked into the doctor body')
  assert.ok(!r.body.includes(home), 'path leaked into the doctor body')
  assert.equal(before, snapshot(), 'the doctor wrote nothing')
  ok('route: GET /doctor answers 200 in the report shape, leaks no secret or path, writes nothing')

  const status = await b.call('GET', '/status')
  assert.equal(status.status, 200)
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const x = await b.call(method, '/doctor', { headers: { 'x-requested-with': 'dsh-idle-watchdog', 'content-type': 'application/json' } })
    assert.equal(x.status, 404); assert.equal(x.json.code, 'WATCHDOG_ROUTE_NOT_FOUND')
  }
  ok('route: only GET serves the doctor (other methods give WATCHDOG_ROUTE_NOT_FOUND), same open access as /status')

  // no secret anywhere: warn with the coded row, still 200
  delete process.env.DSH_IDLE_WATCHDOG_SECRET
  rmSync(join(home, 'idle-watchdog', 'api-secret'))
  writeFileSync(join(home, 'idle-watchdog', 'settings.json'), JSON.stringify({}))
  const b2 = await boot()
  const r2 = await b2.call('GET', '/doctor')
  assert.equal(r2.status, 200)
  assert.equal(byId(r2.json, 'secret').code, 'WATCHDOG_SECRET_NOT_CONFIGURED')
  assert.equal(byId(r2.json, 'secret_file').status, 'skip')
  assert.equal(r2.json.status, 'warn')
  ok('route: no secret configured gives a coded warning, not an error')
  rmSync(home, { recursive: true, force: true })
  process.env.DSH_HOME = join(root, 'home')
}

// ── docs ──
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  for (const f of ['../README.md', '../docs/ERRORS.md', '../docs/TROUBLESHOOTING.md', '../skills/idle-watchdog-doctor/SKILL.md']) {
    const text = read(f)
    assert.ok(!/doctor[^\n]{0,160}\bplanned\b|\bplanned\b[^\n]{0,160}doctor/i.test(text), 'doctor still called planned in ' + f)
    assert.ok(!/[\u2013\u2014]/.test(text), 'dash in ' + f)
    assert.ok(text.includes('/dsh-idle-watchdog/api/doctor'), 'route not mentioned in ' + f)
  }
  ok('docs describe the real doctor route, not a planned one')
}

rmSync(root, { recursive: true, force: true })
console.log(`\nall doctor tests passed (${passed})`)

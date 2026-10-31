/**
 * Client-half boot test.
 *
 * Executes lib/client.js the way the dsh browser loader does (fake
 * window.__ModuleLoader__ + require('react')), applies it against fake
 * slots/locale services, then MOUNTS the settings-section component in a
 * jsdom DOM with real react-dom, so effects run: initial fetches resolve
 * through the API helpers, the full loaded layout renders, and the token
 * stylesheet lands in <head>. A component that throws in the browser throws
 * here first.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fsSync from 'node:fs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const React = require('react')
const { act } = require('react-dom/test-utils')
const { createRoot } = require('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location

const statusPayload = {
  armed: true, row: 'idle-watchdog', version: '1.1.0', bootedAt: Date.now(),
  settingsStore: 'settings', envSecretPresent: false,
  settings: {
    enabled: true, idleMinutes: 20, maxNudges: 3, tickSeconds: 30,
    defaultPrompt: 'anything to continue?', notifyOnCap: true, wakeColdForApi: true,
    skipWhenGoalActive: false, onlyAfterError: false, backoffFactor: 1, backoffMaxMinutes: 0,
    quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: '' },
    api: { rateLimitPerMinute: 30, secret: '***', secretFingerprint: 'ab12cd34' },
    chats: [{ id: 'session-demo-chat', label: 'Demo', enabled: true, prompt: '', idleMinutes: 0 }],
  },
  perChat: [{ sessionId: 'session-demo-chat', live: true, running: false, lastActivityAt: Date.now() - 90_000, nudgesSent: 1, lastNudgeAt: null }],
  preview: { now: Date.now(), quietNow: true, enabled: true, rows: [
    { sessionId: 'session-demo-chat', label: 'Demo', watched: true, live: true, running: false, action: 'wait', reason: 'waiting', dueAt: Date.now() + 600_000, windowMinutes: 20, nudgesSent: 1, maxNudges: 3, lastOutcome: { kind: 'nudged', at: Date.now() - 60_000 } },
  ] },
  activityTail: [{ at: new Date().toISOString(), event: 'armed', row: 'idle-watchdog', pid: 1 }],
}
const fetchCalls = []
const fetchImpl = {
  fn: (url) => {
    fetchCalls.push(String(url))
    const body = String(url).endsWith('/chats')
      ? { at: Date.now(), rows: [{ sessionId: 'session-other', title: 'Other chat', cwd: '/', createdAt: Date.now(), live: false, running: false }] }
      : statusPayload
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  },
}
// late-bound so swapping fetchImpl.fn mid-test is visible inside the bundle
// (the loader factory passes `fetch` as a function parameter, shadowing global)
globalThis.fetch = (url, init) => fetchImpl.fn(url, init)

// ── execute the loader bundle ──
const src = fsSync.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
dom.window.__ModuleLoader__ = { load: (pkg) => { dom.window.__loaded = pkg } }
new Function('window', 'document', 'location', 'fetch', src)(dom.window, dom.window.document, dom.window.location, (url, init) => fetchImpl.fn(url, init))
assert.ok(dom.window.__loaded, '__ModuleLoader__.load was called')
assert.equal(dom.window.__loaded.id, 'dsh-idle-watchdog')

const cache = new Map([['react', React]])
const plugin = dom.window.__loaded.factory((id) => {
  assert.ok(cache.has(id), `loader must only ask for declared deps, got ${id}`)
  return cache.get(id)
})
assert.equal(plugin.name, 'dsh-idle-watchdog')
assert.deepEqual(plugin.inject, ['slots', 'locale'])

const slots = { registered: [] }
const ctx = {
  locale: {
    register: (ns, lang, dict) => { assert.equal(ns, 'dshIdleWatchdog'); assert.ok(dict.title) },
    bind: undefined,   // exercise the fallback path (no bind on this ctx)
  },
  slots: {
    inject: (name, provider) => { provider() },   // the loader calls the provider to materialize the slot
    register: (spec, component) => { slots.registered.push(spec); slots.component = component; return () => {} },
  },
  effect: (fn) => fn(),
}
plugin.apply(ctx)
assert.equal(slots.registered.length, 1)
assert.equal(slots.registered[0].name, 'settings.section')
assert.equal(slots.registered[0].id, 'dsh-idle-watchdog')
assert.ok(slots.registered[0].label().includes('Idle Watchdog'))

// ── mount, run effects, inspect the loaded DOM ──
;(async () => {
  const root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(React.createElement(slots.component)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })  // let the status/chats fetches resolve

  const html = document.getElementById('root').innerHTML
  assert.ok(html.includes('Idle window'), 'loaded settings form rendered (not the spinner)')
  assert.ok(html.includes('External API'), 'API card rendered')
  assert.ok(html.includes('/dsh-idle-watchdog/api/prompt'), 'curl example shows the real route')
  assert.ok(html.includes('anything to continue?'), 'default prompt bound from the API')
  assert.ok(html.includes('Next nudge') && html.includes('nudged'), 'status table shows next nudge and last outcome')
  assert.ok(html.includes('Quiet hours'), 'behaviour card rendered')
  assert.ok(html.includes('ab12cd34'), 'secret fingerprint shown, value not')
  assert.ok(document.getElementById('dsh-idle-watchdog-styles'), 'stylesheet element in <head>')
  assert.ok(fetchCalls.includes('/dsh-idle-watchdog/api/status'), 'status polled')
  assert.ok(fetchCalls.includes('/dsh-idle-watchdog/api/chats'), 'chat picker fetched')

  // a save round-trip: click Save, verify the guarded mutation shape
  const buttons = [...document.querySelectorAll('button')]
  const save = buttons.find((b) => b.textContent === 'Save settings')
  assert.ok(save, 'save button present')
  const calls = []
  fetchImpl.fn = (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(statusPayload) }) }
  await act(async () => { save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  const settingsCall = calls.find((c) => c.url.endsWith('/settings'))
  assert.ok(settingsCall, 'save issues PUT /settings')
  assert.equal(settingsCall.init.method, 'PUT')
  assert.equal(settingsCall.init.headers['x-requested-with'], 'dsh-idle-watchdog', 'CSRF header sent by the UI')
  const sentBody = JSON.parse(settingsCall.init.body)
  assert.equal(sentBody.chats[0].id, 'session-demo-chat', 'chat table round-trips')
  assert.equal(sentBody.backoffFactor, 1, 'new keys round-trip')
  assert.equal(sentBody.quietHours.enabled, false)
  assert.equal(sentBody.api.secret, undefined, 'save never sends a secret')

  await act(async () => { root.unmount() })
  console.log('client boot test: ok (loads, registers settings.section, mounts, saves with CSRF guard)')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })

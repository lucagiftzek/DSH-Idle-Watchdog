/**
 * Idle Watchdog doctor: a read-only self-check (standard: PLUGIN-DOCS-STANDARD.md, section 5).
 *
 * Served as GET /dsh-idle-watchdog/api/doctor, with the same access as the
 * other read routes (/health, /status, /next). It never writes, never sends a
 * nudge or a prompt, never reads a secret VALUE into its output: the secret is
 * reported as a boolean plus its source (env, file, settings or none). Paths
 * are not reported either.
 */

import { stat, access } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { dirname } from 'node:path'
import { check, doctorReport, hostInfo } from './plugin-errors.js'
import { E } from './errors.js'

const DOCS = 'docs/TROUBLESHOOTING.md'
const coded = (code, extra = {}) => ({ code, hint: E.codes[code].hint, docs: E.codes[code].docs, ...extra })

async function writableDir(dir) {
  // The state directory may not exist yet on a fresh install: then its nearest existing parent decides.
  let d = dir
  for (let i = 0; i < 8; i++) {
    try { await access(d, FS.W_OK); return { ok: true, exists: d === dir } } catch (e) {
      if (e && e.code === 'ENOENT') { const up = dirname(d); if (up === d) return { ok: false }; d = up; continue }
      return { ok: false }
    }
  }
  return { ok: false }
}

/**
 * @param {object} o
 * @param {object} o.ctx
 * @param {string} o.version
 * @param {object} o.store        dual-settings store (mode, entryId, writable)
 * @param {boolean} o.configVisible
 * @param {() => object} o.settings        effective settings (normalised)
 * @param {() => Promise<{source: string, value: string}>} o.configuredSecret   value is only tested for emptiness
 * @param {() => Promise<string>} o.readSecretFile   '' when absent or unusable
 * @param {string} o.secretFile   path (never reported)
 * @param {string} o.stateFile    path (never reported)
 * @param {() => object} o.preview   previewRows()
 * @param {() => number} o.lastTickAt    ms epoch, 0 = never
 * @param {number} o.bootedAt
 * @param {() => boolean} o.stateWriteFailing
 * @param {number} [o.now]
 */
export async function watchdogDoctor(o) {
  const now = o.now ?? Date.now()
  const host = await hostInfo(o.ctx).catch(() => null)
  const eff = (() => { try { return o.settings() } catch { return null } })()
  const checks = []

  checks.push(await check('plugin', 'Plugin loaded', async () => ({
    status: 'ok',
    detail: `dsh-idle-watchdog ${o.version}, route /dsh-idle-watchdog/api, up ${Math.max(0, Math.round((now - o.bootedAt) / 1000))} s, ${eff && eff.enabled === false ? 'switched off in Settings' : 'enabled'}`,
  })))

  checks.push(await check('settings', 'Settings store', async () => {
    const writable = o.store.mode === 'config' ? true : Boolean(o.store.writable())
    const label = o.store.mode === 'config' ? 'fallback file' : o.store.mode
    const detail = `mode ${label}${o.store.entryId ? ', entry ' + o.store.entryId : ''}, ${writable ? 'writable' : 'read-only'}`
    if (o.store.mode === 'config') return { status: 'warn', detail: detail + ' (no settings service found)', hint: 'The settings service or the schema library was not found, so values are kept in a plugin fallback file instead of the DSH store; see the troubleshooting guide (settings do not save).', docs: DOCS, human: true }
    return writable ? { status: 'ok', detail } : { status: 'warn', detail, hint: 'The settings store is read-only: on DSH 0.2.x the plugin needs its loader row and a Config on its default export (troubleshooting: settings do not save).', docs: DOCS, human: true }
  }))

  checks.push(await check('config', 'Config visible to the loader', async () => {
    if (!host || host.settingsMode !== 'forms') return { status: 'skip', detail: 'only needed on DSH 0.2.x (settings mode forms)' }
    return o.configVisible
      ? { status: 'ok', detail: 'Config exported on the named and the default export' }
      : { status: 'fail', detail: 'no Config: the Settings form cannot be built', hint: 'The schema library could not be resolved by the plugin; see the troubleshooting guide (settings do not save).', docs: DOCS, human: true }
  }))

  checks.push(await check('secret', 'API secret configured', async () => {
    const s = await o.configuredSecret()
    return s.value
      ? { status: 'ok', detail: `configured (source ${s.source})` }
      : { status: 'warn', detail: 'not configured: the prompt API refuses every call (idle nudges are unaffected)', ...coded('WATCHDOG_SECRET_NOT_CONFIGURED', { human: true }) }
  }))

  checks.push(await check('secret_file', 'Secret file mode 0600', async () => {
    if (process.platform === 'win32') return { status: 'skip', detail: 'file modes are not checked on this platform' }
    let st
    try { st = await stat(o.secretFile) } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'skip', detail: 'no secret file (the secret comes from env or settings, or is not set)' }
      throw e
    }
    if (!st.isFile()) return { status: 'warn', detail: 'the secret path is not a regular file', hint: 'Remove it and save the secret again in Settings, Idle Watchdog.', docs: DOCS, human: true }
    const mode = st.mode & 0o777
    if (mode & 0o077) return { status: 'warn', detail: `mode ${mode.toString(8).padStart(3, '0')}, group or others can read it`, hint: 'Run chmod 600 on the api-secret file in the plugin data directory (the path is shown by GET /status as secretFile).', docs: DOCS, human: true }
    const usable = Boolean(await o.readSecretFile())
    return usable
      ? { status: 'ok', detail: `mode ${mode.toString(8).padStart(3, '0')}, content usable` }
      : { status: 'warn', detail: `mode ${mode.toString(8).padStart(3, '0')}, but the content is not a usable secret (16 to 256 characters)`, ...coded('WATCHDOG_SECRET_LENGTH', { human: true }) }
  }))

  checks.push(await check('watched_chats', 'Watched chats', async () => {
    const chats = eff ? eff.chats : []
    const on = chats.filter((c) => c.enabled !== false).length
    if (!chats.length) return { status: 'info', detail: 'none: opt chats in under Settings, Idle Watchdog (the prompt API does not need this)' }
    return { status: 'ok', detail: `${chats.length} configured, ${on} watched` }
  }))

  checks.push(await check('session_controller', 'sessionController available', async () => {
    let controller
    try { controller = o.ctx && typeof o.ctx.get === 'function' ? o.ctx.get('sessionController') : undefined } catch { controller = undefined }
    const has = Boolean(controller && typeof controller.resolveAgent === 'function')
    if (has) return { status: 'ok', detail: 'present: the prompt API can wake chats that are not loaded' }
    if (eff && eff.wakeColdForApi === false) return { status: 'info', detail: 'absent, and wakeColdForApi is off: only loaded chats can be prompted' }
    return { status: 'warn', detail: 'absent: prompts to chats that are not loaded fail', ...coded('WATCHDOG_RESOLVER_UNAVAILABLE', { human: true }) }
  }))

  checks.push(await check('preview', 'Next nudge preview', async () => {
    const p = o.preview()
    const rows = Array.isArray(p.rows) ? p.rows : []
    const due = rows.filter((r) => r.action === 'nudge').length
    return { status: 'ok', detail: rows.length ? `${rows.length} chats evaluated, ${due} would be nudged on the next scan${p.quietNow ? ', quiet hours active' : ''}` : 'available, no chats to evaluate' }
  }))

  checks.push(await check('tick', 'Last scan', async () => {
    const last = o.lastTickAt()
    const tickMs = (eff ? eff.tickSeconds : 30) * 1000
    const sinceBoot = now - o.bootedAt
    if (!last) {
      return sinceBoot > tickMs * 2 + 60_000
        ? { status: 'warn', detail: `no scan since start (${Math.round(sinceBoot / 1000)} s ago)`, ...coded('WATCHDOG_TICK_FAILED', { human: true }) }
        : { status: 'info', detail: 'no scan yet, the plugin only just started' }
    }
    const age = now - last
    return age > tickMs * 3 + 60_000
      ? { status: 'warn', detail: `last scan ${Math.round(age / 1000)} s ago, expected every ${Math.round(tickMs / 1000)} s`, ...coded('WATCHDOG_TICK_FAILED', { human: true }) }
      : { status: 'ok', detail: `last scan ${Math.round(age / 1000)} s ago (every ${Math.round(tickMs / 1000)} s)` }
  }))

  checks.push(await check('state_file', 'State file writable', async () => {
    const dir = dirname(o.stateFile)
    const w = await writableDir(dir)
    if (!w.ok) return { status: 'warn', detail: 'the plugin data directory is not writable', ...coded('WATCHDOG_STATE_WRITE_FAILED', { human: true }) }
    if (o.stateWriteFailing()) return { status: 'warn', detail: 'directory is writable but the last save of the nudge counters failed', ...coded('WATCHDOG_STATE_WRITE_FAILED', { human: true }) }
    try { await access(o.stateFile, FS.W_OK) } catch (e) {
      if (e && e.code !== 'ENOENT') return { status: 'warn', detail: 'state.json exists but is not writable', ...coded('WATCHDOG_STATE_WRITE_FAILED', { human: true }) }
    }
    return { status: 'ok', detail: w.exists ? 'writable' : 'writable (the directory is created on first save)' }
  }))

  return doctorReport({ plugin: 'dsh-idle-watchdog', version: o.version, host, checks, docs: DOCS })
}

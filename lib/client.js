/**
 * DSH-Idle-Watchdog, browser half.
 *
 * Not an ES module: dsh serves plugin client halves through its own loader,
 * so this file is one `window.__ModuleLoader__.load({id, factory})` call and
 * `require` is the loader's. Hand-written with React.createElement and no
 * build step, matching dsh-voice / dsh-model-picker-augmented (working
 * precedents in this profile).
 *
 * Surfaces, all inside one Settings-page section:
 *   - master switch + global window / cap / default prompt
 *   - per-chat table: enable, personalised prompt, personal idle window
 *   - a picker that lists real chats (ids, titles, live/running flags)
 *   - API secret management (set / rotate / clear, fingerprint only)
 *   - a live status card + the watchdog's own activity tail
 *   - ready-made curl examples for the external prompt API
 *
 * Colors come only from the `--dsw-*` theme token layers, so light/dark
 * follows the shell. Every mutation carries the plugin's X-Requested-With
 * header + JSON content type, the host-side CSRF guard for UI endpoints;
 * the machine endpoint (/prompt) is secret-only and never touched from here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-idle-watchdog',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef

    var PLUGIN_ID = 'dsh-idle-watchdog'
    var API = '/' + PLUGIN_ID + '/api'
    var LOCALE_NS = 'dshIdleWatchdog'
    var CLIENT_NAME = 'dsh-idle-watchdog'

    // ── locale (en dictionary; the registry falls back to keys) ──────────
    var EN = {
      title: 'Idle Watchdog',
      hint: 'Watches opted-in chats. When one goes quiet for longer than the idle window, the watchdog posts your prompt into it (up to the nudge cap, until a human replies). The same engine exposes a small secret-protected HTTP API to prompt any chat from outside.',
      armed: 'armed', notArmed: 'not armed', storeSettings: 'store: settings.yaml', storeFallback: 'store: fallback file',
      secGlobal: 'Global', secChats: 'Watched chats', secApi: 'External API', secActivity: 'Activity',
      enabled: 'Watchdog enabled', idleMinutes: 'Idle window (minutes)', maxNudges: 'Max nudges per idle period',
      tickSeconds: 'Scan every (seconds)', defaultPrompt: 'Default prompt', notifyOnCap: 'Post a notice when the cap is hit',
      wakeCold: 'API may wake a cold chat to deliver a prompt', rateLimit: 'API rate limit (calls/min/IP)',
      save: 'Save settings', saved: 'Settings saved', operationFailed: 'Operation failed', loading: '…',
      chatsEmpty: 'No chats watched yet, pick one below.',
      chatTitle: 'Chat', chatOn: 'On', chatPrompt: 'Prompt override', chatWindow: 'Window (min, 0=global)', chatRemove: 'Remove',
      addChat: 'Add chat…', addChatHint: 'Lists live and recent sessions. Titles come from the session store.',
      live: 'live', running: 'running', cold: 'cold',
      secretTitle: 'API secret', secretSet: 'Set / rotate', secretClear: 'Clear', secretConfigured: 'configured',
      secretNotConfigured: 'not configured, the API fails closed', secretFp: 'fingerprint', secretEnvHint: 'The env secret (DSH_IDLE_WATCHDOG_SECRET) always wins over the stored one.',
      secretPlaceholder: 'at least 16 characters',
      apiUsageTitle: 'Prompt a chat from anywhere',
      statusTitle: 'Status', lastActivity: 'last append', nudges: 'nudges',
      nextNudge: 'Next nudge', lastOutcome: 'Last outcome', agentCol: 'agent', previewHint: 'Read-only preview of what the next scan would do. Nothing is sent from here.',
      secBehaviour: 'Behaviour', skipGoal: 'Skip chats with an active goal round', onlyError: 'Nudge only after an agent error',
      backoffFactor: 'Backoff factor (1 = constant)', backoffMax: 'Backoff cap (minutes, 0 = none)',
      quietEnabled: 'Quiet hours (no idle nudges)', quietStart: 'From (HH:MM)', quietEnd: 'Until (HH:MM)', quietZone: 'Time zone (blank = server)',
      quietNow: 'quiet hours active now',
      needsRestart: 'These options need the v1.1 server half. The browser half is already updated; restart dsh-web to enable them.',
      rDisabled: 'watchdog off', rChatOff: 'chat off', rCap: 'cap reached, waiting for you', rNotLive: 'not live', rRunning: 'agent running',
      rGoal: 'goal round active', rError: 'waiting for an error', rQuiet: 'quiet hours', rDue: 'due now', rWaiting: 'in',
      oNudged: 'nudged', oCapped: 'cap notice', oFailed: 'send failed', oHuman: 'you replied', oNone: 'none yet',
    }

    // ── tiny token-based stylesheet ──────────────────────────────────────
    var STYLE = [
      '.iw-page{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}',
      '.iw-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.iw-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.iw-hint{color:var(--dsw-alias-label-secondary)}',
      '.iw-dir{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.iw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.iw-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:160px}',
      '.iw-spacer{flex:1}',
      '.iw-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.iw-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.iw-toggle{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}',
      '.iw-toggle.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.iw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}',
      '.iw-btn:hover{border-color:var(--dsw-alias-border-l3)}',
      '.iw-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.iw-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.iw-input{min-height:30px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none;box-sizing:border-box;width:100%}',
      '.iw-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.iw-mono{font-family:var(--dsw-font-family-mono,monospace);font-size:12px}',
      '.iw-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.iw-table th{text-align:left;padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.iw-table td{padding:5px 8px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
      '.iw-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}',
      '.iw-log{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:2px;font-size:12px}',
      '.iw-pre{white-space:pre-wrap;word-break:break-all;padding:8px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);font-size:11.5px}',
      '.iw-spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);animation:iwspin .7s linear infinite}',
      '@keyframes iwspin{to{transform:rotate(360deg)}}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(PLUGIN_ID + '-styles')) return
      var holder = document.createElement('div')
      holder.id = PLUGIN_ID + '-styles'
      holder.style.display = 'none'
      holder.innerHTML = '<style>' + STYLE + '</style>'
      document.head.appendChild(holder)
    }

    // ── api helpers ──────────────────────────────────────────────────────
    function getJson(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }
    function mutate(method, url, body) {
      return fetch(url, {
        method: method,
        headers: { 'content-type': 'application/json', 'x-requested-with': PLUGIN_ID },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().catch(function () { return {} }).then(function (d) {
          if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status)
          return d
        })
      })
    }
    function num(v, fallback) { var n = Number(v); return Number.isFinite(n) ? n : fallback }
    function ago(ms) {
      if (!ms) return '-'
      var s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
      if (s < 60) return s + 's'
      if (s < 3600) return Math.floor(s / 60) + 'm'
      if (s < 86400) return Math.floor(s / 3600) + 'h'
      return Math.floor(s / 86400) + 'd'
    }
    function until(ms) {
      var s = Math.floor((ms - Date.now()) / 1000)
      if (s <= 0) return ''
      if (s < 60) return s + 's'
      if (s < 3600) return Math.ceil(s / 60) + 'm'
      if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.ceil((s % 3600) / 60) + 'm'
      return Math.floor(s / 86400) + 'd'
    }
    function reasonText(t, r) {
      var map = { disabled: 'rDisabled', 'chat-off': 'rChatOff', 'cap-reached': 'rCap', 'not-live': 'rNotLive', running: 'rRunning',
        'goal-active': 'rGoal', 'waiting-for-error': 'rError', 'quiet-hours': 'rQuiet', due: 'rDue' }
      if (r.reason === 'waiting') return t('rWaiting') + ' ' + (until(r.dueAt) || '0s')
      if (!r.reason) return '-'
      return map[r.reason] ? t(map[r.reason]) : String(r.reason)
    }
    function outcomeText(t, o) {
      if (!o) return t('oNone')
      var map = { nudged: 'oNudged', capped: 'oCapped', failed: 'oFailed', 'human-replied': 'oHuman' }
      return t(map[o.kind] || 'oNone') + ' ' + ago(o.at) + ' ago'
    }
    function shortId(sid) { return !sid ? '-' : sid.length <= 18 ? sid : sid.slice(0, 9) + '…' + sid.slice(-5) }

    // ── the section ──────────────────────────────────────────────────────
    function WatchdogSection(props) {
      var t = props.__t
      var _status = useState(null); var status = _status[0], setStatus = _status[1]
      var _chats = useState(null); var chatCatalog = _chats[0], setChatCatalog = _chats[1]
      var _busy = useState(false); var busy = _busy[0], setBusy = _busy[1]
      var _toast = useState(null); var toast = _toast[0], setToast = _toast[1]
      // editable mirror of settings (initialized from the first status load)
      var _form = useState(null); var form = _form[0], setForm = _form[1]
      var initialized = useRef(false)
      var _secretDraft = useState(''); var secretDraft = _secretDraft[0], setSecretDraft = _secretDraft[1]
      var _pick = useState(''); var pick = _pick[0], setPick = _pick[1]
      var lastWriteAt = useRef(0)

      function onToast(text, ms) { setToast(text); setTimeout(function () { setToast(null) }, ms || 3000) }
      function refresh() {
        return getJson(API + '/status').then(function (d) {
          setStatus(d)
          // Re-seed the editor from the server only when no local write is in
          // flight: an in-flight pre-save snapshot must never clobber it.
          var writeFresh = Date.now() - lastWriteAt.current < 5000
          if (!initialized.current && d && d.settings && !writeFresh) { setForm(JSON.parse(JSON.stringify(d.settings))); initialized.current = true }
        }).catch(function () {})
      }
      function refreshCatalog() { return getJson(API + '/chats').then(function (d) { setChatCatalog(d && d.rows || []) }).catch(function () {}) }
      useEffect(function () {
        ensureStyles()
        refresh(); refreshCatalog()
        var timer = setInterval(refresh, 15000)
        return function () { clearInterval(timer) }
      }, [])

      function setField(k, v) { setForm(function (f) { var n = JSON.parse(JSON.stringify(f)); n[k] = v; return n }) }
      function setApiField(k, v) { setForm(function (f) { var n = JSON.parse(JSON.stringify(f)); n.api = n.api || {}; n.api[k] = v; return n }) }
      function setQuiet(k, v) { setForm(function (f) { var n = JSON.parse(JSON.stringify(f)); n.quietHours = n.quietHours || {}; n.quietHours[k] = v; return n }) }
      function updateChat(i, patch) { setForm(function (f) { var n = JSON.parse(JSON.stringify(f)); n.chats = n.chats.map(function (c, j) { return j === i ? Object.assign({}, c, patch) : c }); return n }) }
      function removeChat(i) { setForm(function (f) { var n = JSON.parse(JSON.stringify(f)); n.chats.splice(i, 1); return n }) }
      function addChat(id) {
        if (!id) return
        var known = chatCatalog && chatCatalog.find(function (c) { return c.sessionId === id })
        setForm(function (f) {
          if (f.chats.some(function (c) { return c.id === id })) return f
          var n = JSON.parse(JSON.stringify(f))
          n.chats.push({ id: id, label: known && known.title || '', enabled: true, prompt: '', idleMinutes: 0 })
          return n
        })
        setPick('')
      }

      // The browser half hot-reloads; the server half only loads at the next
      // dsh-web restart. A v1.0 server lacks the v1.1 keys: never offer (or
      // send) options it would silently drop.
      function serverHasV11(st) { return !!(st && st.settings && typeof st.settings.backoffFactor === 'number') }

      function doSave() {
        setBusy(true)
        lastWriteAt.current = Date.now()
        var body = {
          enabled: form.enabled, idleMinutes: form.idleMinutes, maxNudges: form.maxNudges,
          tickSeconds: form.tickSeconds, defaultPrompt: form.defaultPrompt, notifyOnCap: form.notifyOnCap,
          wakeColdForApi: form.wakeColdForApi,
          api: { rateLimitPerMinute: form.api && form.api.rateLimitPerMinute },
          chats: form.chats,
        }
        if (serverHasV11(status)) {
          body.skipWhenGoalActive = form.skipWhenGoalActive; body.onlyAfterError = form.onlyAfterError
          body.backoffFactor = form.backoffFactor; body.backoffMaxMinutes = form.backoffMaxMinutes; body.quietHours = form.quietHours
        }
        mutate('PUT', API + '/settings', body).then(function () { onToast(t('saved')); initialized.current = false; return refresh() })
          .catch(function (e) { onToast(e.message || t('operationFailed'), 4000) })
          .finally(function () { setBusy(false) })
      }
      function doSecret(body) {
        setBusy(true)
        lastWriteAt.current = Date.now()
        mutate('POST', API + '/secret', body)
          .then(function () { setSecretDraft(''); initialized.current = false; return refresh() })
          .catch(function (e) { onToast(e.message || t('operationFailed'), 4000) })
          .finally(function () { setBusy(false) })
      }

      if (status === null || form === null) {
        return h('div', { className: 'iw-page' }, h('div', { className: 'iw-row' }, h('div', { className: 'iw-spin' }), t('loading')))
      }

      var quiet = form.quietHours || {}
      var v11 = serverHasV11(status)
      // v1.0 server: no preview, so derive the rows from the watched chats and
      // the old perChat state instead of claiming nothing is watched.
      var preview = status.preview && Array.isArray(status.preview.rows) ? status.preview.rows
        : form.chats.map(function (c) {
            var pc = (status.perChat || []).find(function (x) { return x.sessionId === c.id }) || {}
            return { sessionId: c.id, label: c.label, live: !!pc.live, running: !!pc.running, nudgesSent: pc.nudgesSent || 0,
              maxNudges: form.maxNudges, reason: null, lastOutcome: pc.lastOutcome || null }
          })
      var watchedIds = {}
      form.chats.forEach(function (c) { watchedIds[c.id] = true })
      var pickerRows = (chatCatalog || []).filter(function (r) { return !watchedIds[r.sessionId] }).slice(0, 120)
      var secretConfigured = !!(status.settings.api.secretFingerprint)
      var origin = (typeof location !== 'undefined' && location.origin) || 'http://127.0.0.1:3080'
      var curlExample = 'curl -X POST ' + origin + API + '/prompt \\\n' +
        '  -H "content-type: application/json" \\\n' +
        '  -H "x-idle-watchdog-secret: <YOUR-SECRET>" \\\n' +
        '  -d \'{"chat":"<session-id, id-prefix or exact title>",\n' +
        '       "message":"Nightly sweep finished, review the report and continue.",\n' +
        '       "provenance":"cron"}\''

      var toggle = function (key, label) {
        return h('label', { key: key, className: 'iw-toggle' + (form[key] ? ' on' : '') },
          h('input', { type: 'checkbox', checked: !!form[key], onChange: function (e) { setField(key, e.target.checked) } }), label)
      }
      var numberField = function (key, label, min, max) {
        return h('div', { className: 'iw-field', key: key },
          h('label', { className: 'iw-dir' }, label),
          h('input', { className: 'iw-input', type: 'number', min: min, max: max, value: form[key],
            onChange: function (e) { setField(key, num(e.target.value, form[key])) }, style: { maxWidth: 140 } }))
      }

      return h('div', { className: 'iw-page' },
        h('div', { className: 'iw-row' },
          h('span', { className: 'iw-tag' + (status.armed ? ' accent' : '') }, status.armed ? t('armed') : t('notArmed')),
          h('span', { className: 'iw-tag' }, status.settingsStore === 'settings' ? t('storeSettings') : t('storeFallback')),
          h('span', { className: 'iw-spacer' }),
          h('span', { className: 'iw-dir' }, 'v' + (status.version || '?'))),
        h('div', { className: 'iw-hint' }, t('hint')),

        // ── Global card ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('secGlobal')),
          toggle('enabled', t('enabled')),
          h('div', { className: 'iw-row' },
            numberField('idleMinutes', t('idleMinutes'), 1, 10080),
            numberField('maxNudges', t('maxNudges'), 0, 20),
            numberField('tickSeconds', t('tickSeconds'), 5, 3600)),
          h('div', { className: 'iw-field' },
            h('label', { className: 'iw-dir' }, t('defaultPrompt')),
            h('input', { className: 'iw-input', value: form.defaultPrompt, onChange: function (e) { setField('defaultPrompt', e.target.value) } })),
          toggle('notifyOnCap', t('notifyOnCap'))),

        // ── Behaviour card (v1.1) ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('secBehaviour')),
          !v11 && h('div', { className: 'iw-dir' }, t('needsRestart')),
          v11 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'iw-row' }, toggle('skipWhenGoalActive', t('skipGoal')), toggle('onlyAfterError', t('onlyError'))),
          h('div', { className: 'iw-row' },
            h('div', { className: 'iw-field', style: { maxWidth: 200, flex: 'none' } },
              h('label', { className: 'iw-dir' }, t('backoffFactor')),
              h('input', { className: 'iw-input', type: 'number', min: 1, max: 10, step: 0.5, value: form.backoffFactor == null ? 1 : form.backoffFactor,
                onChange: function (e) { setField('backoffFactor', num(e.target.value, 1)) } })),
            numberField('backoffMaxMinutes', t('backoffMax'), 0, 10080)),
          h('label', { className: 'iw-toggle' + (quiet.enabled ? ' on' : ''), style: { alignSelf: 'flex-start' } },
            h('input', { type: 'checkbox', checked: !!quiet.enabled, onChange: function (e) { setQuiet('enabled', e.target.checked) } }), t('quietEnabled')),
          h('div', { className: 'iw-row' },
            h('div', { className: 'iw-field', style: { maxWidth: 140, flex: 'none' } },
              h('label', { className: 'iw-dir' }, t('quietStart')),
              h('input', { className: 'iw-input', value: quiet.start || '', onChange: function (e) { setQuiet('start', e.target.value) } })),
            h('div', { className: 'iw-field', style: { maxWidth: 140, flex: 'none' } },
              h('label', { className: 'iw-dir' }, t('quietEnd')),
              h('input', { className: 'iw-input', value: quiet.end || '', onChange: function (e) { setQuiet('end', e.target.value) } })),
            h('div', { className: 'iw-field', style: { maxWidth: 240, flex: 'none' } },
              h('label', { className: 'iw-dir' }, t('quietZone')),
              h('input', { className: 'iw-input', value: quiet.timezone || '', placeholder: 'Europe/Berlin', onChange: function (e) { setQuiet('timezone', e.target.value) } }))))),

        // ── Watched chats card ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('secChats')),
          form.chats.length === 0
            ? h('div', { className: 'iw-hint' }, t('chatsEmpty'))
            : h('table', { className: 'iw-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('chatTitle')), h('th', null, t('chatOn')),
                  h('th', null, t('chatPrompt')), h('th', null, t('chatWindow')), h('th', null, ' '))),
                h('tbody', null, form.chats.map(function (c, i) {
                  var live = (status.perChat || []).find(function (p) { return p.sessionId === c.id })
                  return h('tr', { key: c.id },
                    h('td', null,
                      h('div', null, c.label || shortId(c.id)),
                      h('div', { className: 'iw-dir iw-mono' }, shortId(c.id), live ? ' · ' + (live.running ? t('running') : live.live ? t('live') : t('cold')) : '')),
                    h('td', null, h('input', { type: 'checkbox', checked: c.enabled !== false, onChange: function (e) { updateChat(i, { enabled: e.target.checked }) } })),
                    h('td', null, h('input', { className: 'iw-input', value: c.prompt, placeholder: '(default)', onChange: function (e) { updateChat(i, { prompt: e.target.value }) } })),
                    h('td', null, h('input', { className: 'iw-input', type: 'number', min: 0, max: 10080, value: c.idleMinutes, style: { maxWidth: 80 }, onChange: function (e) { updateChat(i, { idleMinutes: Math.max(0, num(e.target.value, 0)) }) } })),
                    h('td', null, h('button', { className: 'iw-btn', title: t('chatRemove'), onClick: function () { removeChat(i) } }, '✕')))
                }))),
          h('div', { className: 'iw-row' },
            h('select', { className: 'iw-input', style: { maxWidth: 420 }, value: pick, onChange: function (e) { setPick(e.target.value) } },
              h('option', { value: '' }, t('addChat')),
              pickerRows.map(function (r) {
                var label = (r.title || shortId(r.sessionId)) + (r.live ? (r.running ? ' · running' : ' · live') : '')
                return h('option', { key: r.sessionId, value: r.sessionId }, label)
              })),
            h('button', { className: 'iw-btn', disabled: !pick, onClick: function () { addChat(pick) } }, '+'),
            h('button', { className: 'iw-btn', onClick: refreshCatalog }, '↻')),
          h('div', { className: 'iw-dir' }, t('addChatHint'))),

        // ── External API card ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('secApi')),
          h('div', { className: 'iw-row' },
            h('span', { className: 'iw-tag' + (secretConfigured || status.envSecretPresent ? ' accent' : '') },
              secretConfigured ? t('secretConfigured') + ' · ' + status.settings.api.secretFingerprint : (status.envSecretPresent ? 'env secret present' : t('secretNotConfigured'))),
            h('span', { className: 'iw-spacer' })),
          h('div', { className: 'iw-row' },
            h('input', { className: 'iw-input', type: 'password', value: secretDraft, placeholder: t('secretPlaceholder'), style: { maxWidth: 360 }, onChange: function (e) { setSecretDraft(e.target.value) } }),
            h('button', { className: 'iw-btn iw-btn-primary', disabled: busy || secretDraft.trim().length < 16, onClick: function () { doSecret({ secret: secretDraft.trim() }) } }, t('secretSet')),
            secretConfigured && h('button', { className: 'iw-btn', disabled: busy, onClick: function () { doSecret({ clear: true }) } }, t('secretClear'))),
          h('div', { className: 'iw-dir' }, t('secretEnvHint')),
          h('div', { className: 'iw-row' },
            h('div', { className: 'iw-field', style: { maxWidth: 160, flex: 'none' } },
              h('label', { className: 'iw-dir' }, t('rateLimit')),
              h('input', { className: 'iw-input', type: 'number', min: 1, max: 600, value: (form.api && form.api.rateLimitPerMinute) || 30,
                onChange: function (e) { setApiField('rateLimitPerMinute', num(e.target.value, 30)) } })),
            toggle('wakeColdForApi', t('wakeCold'))),
          h('div', { className: 'iw-dir' }, t('apiUsageTitle')),
          h('pre', { className: 'iw-pre' }, curlExample)),

        // ── live status of watched chats ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('statusTitle')),
          status.preview && status.preview.quietNow && h('span', { className: 'iw-tag accent', style: { alignSelf: 'flex-start' } }, t('quietNow')),
          preview.length === 0
            ? h('div', { className: 'iw-dir' }, t('chatsEmpty'))
            : h('table', { className: 'iw-table' },
                h('thead', null, h('tr', null, h('th', null, t('chatTitle')), h('th', null, t('nextNudge')), h('th', null, t('lastOutcome')), h('th', null, t('lastActivity')), h('th', null, t('nudges')), h('th', null, t('agentCol')))),
                h('tbody', null, preview.map(function (p) {
                  var pc = (status.perChat || []).find(function (x) { return x.sessionId === p.sessionId })
                  return h('tr', { key: p.sessionId },
                    h('td', null, p.label || shortId(p.sessionId)),
                    h('td', null, reasonText(t, p)),
                    h('td', null, outcomeText(t, p.lastOutcome)),
                    h('td', null, pc ? ago(pc.lastActivityAt) : '-'),
                    h('td', null, String(p.nudgesSent || 0) + '/' + p.maxNudges),
                    h('td', null, p.running ? t('running') : p.live ? t('live') : t('cold')))
                }))),
          h('div', { className: 'iw-dir' }, t('previewHint'))),

        // ── activity tail ──
        h('div', { className: 'iw-card' },
          h('div', { className: 'iw-title' }, t('secActivity')),
          (!status.activityTail || status.activityTail.length === 0)
            ? h('div', { className: 'iw-dir' }, t('loading'))
            : h('div', { className: 'iw-log' }, status.activityTail.slice(-14).reverse().map(function (l, i) {
                var at = l.at ? new Date(l.at).toLocaleTimeString() : ''
                var rest = Object.keys(l).filter(function (k) { return k !== 'at' && k !== 'event' })
                  .map(function (k) { return k + '=' + (typeof l[k] === 'string' ? l[k] : JSON.stringify(l[k])) }).join(' ')
                return h('div', { key: i, className: 'iw-row', style: { gap: 8 } },
                  h('span', { className: 'iw-dir iw-mono' }, at),
                  h('span', { className: 'iw-mono' }, l.event || ''),
                  h('span', { className: 'iw-dir' }, rest.slice(0, 140)))
              }))),

        h('div', { className: 'iw-row' },
          h('button', { className: 'iw-btn iw-btn-primary', disabled: busy, onClick: doSave }, t('save'))),

        toast && h('div', { className: 'iw-toast' }, toast))
    }

    function SettingsSlotComponent(props) {
      useEffect(ensureStyles, [])
      return h(WatchdogSection, { __t: props.__t })
    }

    // ── plugin contract ──────────────────────────────────────────────────
    module.exports = {
      name: CLIENT_NAME,
      inject: ['slots', 'locale'],
      apply(ctx) {
        var t = function (key) { return EN[key] || key }
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(LOCALE_NS, 'en', EN)
            var bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null
            if (bound) t = function (key) { return bound(key) || EN[key] || key }
          }
        } catch (e) { try { console.error('[dsh-idle-watchdog] locale:', e) } catch {} }
        ctx.effect(function () {
          try {
            ctx.slots.inject('settings.section', function () { return ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 95,
              locale: LOCALE_NS,
              label: function () { return t('title') },
              inject: function () { return {} },
            }, function IdleWatchdogSectionSlot() {
              return h(SettingsSlotComponent, { __t: t })
            }) })
          } catch (e) {
            ;(globalThis.__skErrors = globalThis.__skErrors || []).push('idle-watchdog settings:' + (e && e.message))
            throw e
          }
        }, 'dsh-idle-watchdog: settings section')
      },
    }

    return module.exports
  },
})

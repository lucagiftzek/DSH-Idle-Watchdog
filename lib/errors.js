/**
 * Error catalog of the Idle Watchdog plugin (prefix WATCHDOG).
 *
 * Every HTTP error body of the /dsh-idle-watchdog/api routes is built from this
 * catalog: { ok:false, error, code, message, hint, docs, ...extra fields }.
 * `error` keeps the short kebab-case string that scripts already parse (the
 * `legacy` field), so adding codes never changes what an older client sees.
 *
 * Codes are an API: add, never rename. Each code has a section in
 * docs/ERRORS.md (a test fails when one is missing).
 */
import { defineErrors } from './plugin-errors.js'

/** Dynamic text (messages, details) never carries credentials into bodies or logs. */
export function scrub(text) {
  return String(text)
    .replace(/(authorization|x-idle-watchdog-secret)\s*[:=]\s*\S+/gi, '$1=***')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
}

export const E = defineErrors('WATCHDOG', {
  // ── prompt API: authentication and rate limits ──
  WATCHDOG_SECRET_NOT_CONFIGURED: {
    status: 503, legacy: 'secret-not-configured',
    message: 'The prompt API has no secret configured, so it refuses every call',
    hint: 'Set DSH_IDLE_WATCHDOG_SECRET for the dsh web process, or save a secret in Settings, Idle Watchdog (it is written to the 0600 secret file).',
  },
  WATCHDOG_SECRET_INVALID: {
    status: 401, legacy: 'invalid-secret',
    message: 'The presented secret does not match',
    hint: 'Send x-idle-watchdog-secret or Authorization: Bearer with the secret from env DSH_IDLE_WATCHDOG_SECRET, else the secret file. Scripts that still read settings.yaml break on DSH 0.2.x.',
  },
  WATCHDOG_AUTH_THROTTLED: {
    status: 429, legacy: 'rate-limited',
    message: 'Too many failed secret attempts from this address',
    hint: 'Wait for retry-after, then retry with the correct secret. Every wrong secret costs one of 10 attempts per minute.',
  },
  WATCHDOG_RATE_LIMITED: {
    status: 429, legacy: 'rate-limited',
    message: 'Too many prompt calls from this address',
    hint: 'Wait for retry-after, slow the caller down, or raise api.rateLimitPerMinute in Settings.',
  },
  // ── prompt API: request and chat resolution ──
  WATCHDOG_PROMPT_INVALID: {
    status: 400, legacy: 'chat and non-empty message are required',
    message: 'The prompt body needs a chat reference and a non-empty message',
    hint: 'POST JSON {"chat":"<session id, unique id prefix or exact title>","message":"..."}.',
  },
  WATCHDOG_CHAT_NOT_FOUND: {
    status: 404, legacy: 'chat-not-found',
    message: 'No chat matches that reference',
    hint: 'Use a full session id, a unique id prefix of 6 or more characters (live or watched chats), or an exact chat title. GET /dsh-idle-watchdog/api/chats lists what resolves.',
  },
  WATCHDOG_CHAT_AMBIGUOUS: {
    status: 409, legacy: 'ambiguous-chat',
    message: 'The reference matches more than one chat',
    hint: 'Use a longer id prefix or the full session id; the candidates field lists the matches.',
  },
  WATCHDOG_CHAT_NOT_LIVE: {
    status: 409, legacy: 'chat-not-live',
    message: 'The chat is not loaded and waking it is switched off',
    hint: 'wakeColdForApi is off: enable wakeColdForApi in Settings, or open the chat in the UI first.',
  },
  WATCHDOG_RESOLVER_UNAVAILABLE: {
    status: 409, legacy: 'chat-not-live',
    message: 'The host cannot wake a chat that is not loaded',
    hint: 'sessionController unavailable: this DSH build lacks the session controller service, or its server half has not been restarted. Ask the human to restart dsh web.',
  },
  WATCHDOG_CHAT_NOT_RESOLVABLE: {
    status: 409, legacy: 'chat-not-resolvable',
    message: 'The chat exists but the host could not load it',
    hint: 'The detail field names the host reason. Open the chat in the UI once, then retry.',
  },
  WATCHDOG_CHAT_SUBAGENT_OWNED: {
    status: 403, legacy: 'subagent-owned',
    message: 'The chat belongs to a subagent and is not addressable',
    hint: 'Address the parent chat instead; child sessions cannot receive prompts.',
  },
  WATCHDOG_RESOLVE_FAILED: {
    status: 500, legacy: 'resolve-failed',
    message: 'The host failed while loading the chat',
    hint: 'Read GET /dsh-idle-watchdog/api/logs for prompt-resolve-failed, then retry once. Report a bug if it repeats.',
  },
  WATCHDOG_FOLLOWUP_FAILED: {
    status: 500, legacy: 'followup-failed',
    message: 'The chat was found but delivering the message failed',
    hint: 'Read GET /dsh-idle-watchdog/api/logs for prompt-failed, check the chat is not being torn down, then retry.',
  },
  // ── browser-only routes (settings, secret) ──
  WATCHDOG_CSRF_GUARD: {
    status: 403, legacy: 'csrf-guard',
    message: 'This route only accepts the plugin UI request shape',
    hint: 'Send header X-Requested-With: dsh-idle-watchdog and Content-Type: application/json. The prompt route does not need them.',
  },
  WATCHDOG_SETTINGS_EMPTY: {
    status: 400, legacy: 'no-valid-settings-in-body',
    message: 'The settings body held no valid setting',
    hint: 'Send a JSON object with known keys inside their limits (see the settings table in the README).',
  },
  WATCHDOG_SECRET_LENGTH: {
    status: 400, legacy: 'secret must be 16..256 characters',
    message: 'The secret length is out of range',
    hint: 'Use 16 to 256 characters.',
  },
  // ── generic ──
  WATCHDOG_ROUTE_NOT_FOUND: {
    status: 404, legacy: 'not-found',
    message: 'The plugin does not serve that path or method',
    hint: 'Valid routes: GET health, status, next, chats, logs; PUT settings; POST secret, prompt (all under /dsh-idle-watchdog/api).',
  },
  WATCHDOG_BODY_TOO_LARGE: {
    status: 400, legacy: 'request body too large',
    message: 'The request body is larger than 64 KiB',
    hint: 'Shorten the message (limit 8000 characters) or the settings patch.',
  },
  WATCHDOG_BODY_INVALID: {
    status: 400,
    message: 'The request body is not valid JSON',
    hint: 'Send a JSON object with content-type application/json; quote the shell argument carefully.',
  },
  WATCHDOG_INTERNAL: {
    status: 500,
    message: 'Unexpected error',
    hint: 'Collect the matching WATCHDOG_INTERNAL log line from the dsh web log and GET /dsh-idle-watchdog/api/logs, then report a bug. The route keeps answering 400 for compatibility.',
  },
  // ── log only (no HTTP response) ──
  WATCHDOG_INIT_FAILED: {
    status: 500,
    message: 'Loading saved state or fallback settings failed at start',
    hint: 'Check the file mode and JSON validity of state.json and settings.json under the plugin data directory. A missing settings.json on a fresh install is not an error: it is logged as an info line without this code.',
  },
  WATCHDOG_TICK_FAILED: {
    status: 500,
    message: 'A scan or an event handler threw',
    hint: 'The scan continues with the next chat. If it repeats for every scan, read the line and report a bug.',
  },
  WATCHDOG_STATE_WRITE_FAILED: {
    status: 500,
    message: 'Saving the nudge counters to state.json failed',
    hint: 'Check disk space and the permissions of the plugin data directory. Nudging continues; counters reset after a restart.',
  },
}, { scrub })

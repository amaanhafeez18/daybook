// Voice chat and AI budget settings: defaults, normalizers and the limits of one call. Shared by the
// voice mint (api/voice.js), the assistant's update_settings tool and the app (Settings, Talk button).
//   settings.voice = { enabled, dailyMinutes, sessionMinutes, silenceSeconds, voice } (missing = default;
//     saved with updateSettings({ voice: {...} }))
//   settings.aiBudgetUsd = 20 (US$ a month for all AI features; 0 = none; missing = 20)
// Per device (readPref/writePref, not here): 'voice.mode' 'open'|'hold', 'voice.quiet',
//   'voice.audioSession', 'voice.introSeen', 'voice.echoTipShown'.
// Pure module with zero imports.

// The realtime voices (gpt-realtime 2.x). Marin and Cedar first: OpenAI's recommended pair. Every voice
// costs the same (pricing is per token, not per voice). public/voices/<id>.mp3 holds a short sample
// of each (scripts/make_voice_samples.mjs).
export const VOICE_NAMES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
export const VOICE_RECOMMENDED = ['marin', 'cedar']
export const VOICE_DEFAULTS = { enabled: true, dailyMinutes: 30, sessionMinutes: 15, silenceSeconds: 60, voice: 'marin' }
export const VOICE_OPTIONS = { dailyMinutes: [10, 20, 30, 60], sessionMinutes: [5, 10, 15], silenceSeconds: [30, 60, 120], voice: VOICE_NAMES }
export const BUDGET_DEFAULT = 20
export const BUDGET_OPTIONS = [0, 5, 10, 20, 50]
export const BUDGET_WARN = 0.8 // share of the budget that brings the "80% used" heads-up
export const BUDGET_MAX = 500

const DAILY_MIN_LEFT_SEC = 60 // less than a minute of today's voice left: no new call

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// A number (or numeric text) → the nearest allowed option; anything else → the fallback.
function option(value, options, fallback) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return options.reduce((best, item) => (Math.abs(item - n) < Math.abs(best - n) ? item : best), options[0])
}

// settings (the whole settings object) → complete voice prefs; unknown values become defaults.
export function voicePrefs(settings) {
  const raw = isObject(settings?.voice) ? settings.voice : {}
  const voice = typeof raw.voice === 'string' ? raw.voice.trim().toLowerCase() : ''
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : VOICE_DEFAULTS.enabled,
    dailyMinutes: option(raw.dailyMinutes, VOICE_OPTIONS.dailyMinutes, VOICE_DEFAULTS.dailyMinutes),
    sessionMinutes: option(raw.sessionMinutes, VOICE_OPTIONS.sessionMinutes, VOICE_DEFAULTS.sessionMinutes),
    silenceSeconds: option(raw.silenceSeconds, VOICE_OPTIONS.silenceSeconds, VOICE_DEFAULTS.silenceSeconds),
    voice: VOICE_OPTIONS.voice.includes(voice) ? voice : VOICE_DEFAULTS.voice,
  }
}

// The monthly AI budget in US$ (0 = none). Missing or unreadable → the default; capped at BUDGET_MAX.
export function budgetUsd(settings) {
  const raw = settings?.aiBudgetUsd
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return BUDGET_DEFAULT
  return Math.min(BUDGET_MAX, Math.round(n * 100) / 100)
}

// What one new call may use. prefs: voicePrefs(...); usedTodaySec / monthUsd: from the ledger
// (null when it can't be read: then only the call length applies). budgetUsd: 0 = none.
// → { blocked: null|'off'|'budget'|'daily', sessionSec, dailyLeftSec, silenceSec,
//     budgetLeftUsd (null = no budget), warnBudget }
export function callLimits({ prefs, budgetUsd: budget = 0, usedTodaySec = 0, monthUsd = 0 } = {}) {
  const p = voicePrefs({ voice: prefs })
  const dailySec = p.dailyMinutes * 60
  const used = Number(usedTodaySec) > 0 ? Number(usedTodaySec) : 0
  const dailyLeftSec = Math.max(0, Math.floor(dailySec - used))
  const spent = Number(monthUsd) > 0 ? Number(monthUsd) : 0
  const limit = Number(budget) > 0 ? Number(budget) : 0
  const blocked = !p.enabled ? 'off'
    : limit && spent >= limit ? 'budget'
      : dailyLeftSec < DAILY_MIN_LEFT_SEC ? 'daily'
        : null
  return {
    blocked,
    sessionSec: Math.min(p.sessionMinutes * 60, dailyLeftSec),
    dailyLeftSec,
    silenceSec: p.silenceSeconds,
    budgetLeftUsd: limit ? Math.max(0, limit - spent) : null,
    warnBudget: Boolean(limit && spent >= limit * BUDGET_WARN),
  }
}

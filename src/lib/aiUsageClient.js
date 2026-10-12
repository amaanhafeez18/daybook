// What Daybook's AI features have cost, for Settings → Voice & AI cost, the usage sheet and the
// voice chat buttons: GET /api/voice?op=usage (the server's ledger summary, src/lib/aiLedger.js
// summarizeLedger), kept in localStorage ('daybook.aiUsage', tagged with the account it belongs to)
// so it paints at once and is fetched again when it's older than a moment. One copy is shared by
// every screen that shows it.
import { useEffect, useSyncExternalStore } from 'react'
import { apiRequest, readJson, tokenUserId, writeJson } from './api.js'
import { toISO } from './dates.js'
import { budgetUsd, callLimits, voicePrefs } from './voice/prefs.js'

const CACHE_KEY = 'daybook.aiUsage'
// Fetched again when the copy on screen is older than this (Settings asks for a fresh one).
const FRESH_MS = 2 * 60 * 1000

const EMPTY = Object.freeze({ summary: null, available: null, loading: false, at: 0, error: '', pricesChecked: '' })
let state = null
let request = null
const listeners = new Set()

function emit(next) {
  state = next
  for (const listener of listeners) listener()
}

// The cached copy, only if it belongs to the account signed in now.
function cached() {
  const value = readJson(CACHE_KEY, null)
  const user = tokenUserId()
  if (!value || typeof value !== 'object' || !user || value.userId !== user) return EMPTY
  return { ...EMPTY, summary: value.summary && typeof value.summary === 'object' ? value.summary : null, available: typeof value.available === 'boolean' ? value.available : null, at: Number(value.at) || 0, pricesChecked: value.pricesChecked || '' }
}

const current = () => {
  if (!state || state.userId !== tokenUserId()) state = { ...cached(), userId: tokenUserId() }
  return state
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The user's own day and time zone go along, so "today" and "this month" are theirs (not UTC's).
function usageUrl(now = new Date()) {
  const params = new URLSearchParams({ op: 'usage', localDate: toISO(now) })
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (timeZone) params.set('timeZone', timeZone)
  } catch {
    // the server falls back to UTC
  }
  return `/api/voice?${params}`
}

// Fetches the summary again (once at a time). Resolves with the new state; never throws.
export function refreshAiUsage() {
  if (request) return request
  const user = tokenUserId()
  if (!user) return Promise.resolve(current())
  emit({ ...current(), loading: true, error: '' })
  request = apiRequest(usageUrl())
    .then((payload) => {
      if (tokenUserId() !== user) return current() // signed out (or in as someone else) meanwhile
      const next = {
        ...EMPTY,
        userId: user,
        summary: payload?.summary && typeof payload.summary === 'object' ? payload.summary : null,
        available: payload?.available !== false && !!payload?.summary,
        at: Date.now(),
        pricesChecked: typeof payload?.pricesChecked === 'string' ? payload.pricesChecked : '',
      }
      writeJson(CACHE_KEY, { userId: user, summary: next.summary, available: next.available, at: next.at, pricesChecked: next.pricesChecked })
      emit(next)
      return next
    })
    .catch((error) => {
      if (tokenUserId() !== user) return current()
      const next = { ...current(), loading: false, error: error?.message || 'Couldn’t load your usage.' }
      emit(next)
      return next
    })
    .finally(() => { request = null })
  return request
}

// { summary, available, loading, refresh, at, error, pricesChecked }. available: true / false (the
// database has no usage column yet) / null (not known yet). maxAgeMs: 0 always fetches on mount;
// enabled: false only reads what's on this device.
export function useAiUsage({ maxAgeMs = FRESH_MS, enabled = true } = {}) {
  const snapshot = useSyncExternalStore(subscribe, current, () => EMPTY)
  useEffect(() => {
    if (!enabled) return
    const value = current()
    if (!value.at || Date.now() - value.at >= maxAgeMs) refreshAiUsage()
  }, [maxAgeMs, enabled])
  return { summary: snapshot.summary, available: snapshot.available, loading: snapshot.loading, at: snapshot.at, error: snapshot.error, pricesChecked: snapshot.pricesChecked, refresh: refreshAiUsage }
}

// Forget the copy on this device (signing out, or after a call so the next look fetches).
export function staleAiUsage() {
  if (!state) return
  emit({ ...state, at: 0 })
}

// Whether voice would be refused right now, from the copy on this device: 'off' | 'daily' |
// 'budget' | null. Only a copy fetched today counts for the daily and monthly limits (an older one
// may be from before midnight or last month); the server checks again either way.
export function voiceBlocked(settings, usage, now = new Date()) {
  const prefs = voicePrefs(settings)
  if (!prefs.enabled) return 'off'
  const summary = usage?.summary
  const fresh = summary && usage.at && toISO(new Date(usage.at)) === toISO(now)
  if (!fresh) return null
  try {
    const limits = callLimits({ prefs, budgetUsd: budgetUsd(settings), usedTodaySec: Number(summary.voiceSecondsToday) || 0, monthUsd: Number(summary.month?.total) || 0 })
    return limits?.blocked || null
  } catch {
    return null
  }
}

const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0)

// One feature's figures from a summary's byFeature: { usd, n, seconds, handoffUsd } (the month and
// today totals), or a plain US$ amount (a day in last30). Anything missing reads as 0.
export function featureFigures(byFeature, id) {
  const entry = byFeature && typeof byFeature === 'object' ? byFeature[id] : null
  if (typeof entry === 'number') return { usd: positive(entry), n: 0, seconds: 0, handoffUsd: 0 }
  if (!entry || typeof entry !== 'object') return { usd: 0, n: 0, seconds: 0, handoffUsd: 0 }
  return {
    usd: positive(entry.usd ?? (entry.u != null ? entry.u / 1e6 : 0)),
    n: positive(entry.n),
    seconds: positive(entry.seconds ?? entry.s),
    handoffUsd: positive(entry.handoffUsd ?? (entry.a != null ? entry.a / 1e6 : 0)),
  }
}

// A day's total in US$ (summary.last30 entries).
export const dayCost = (day) => positive(day?.usd)

// Pure helpers for getting a new account set up: the "Get set up" card and the one hint card on
// Today, the notification hints and the faster timetable (the location helpers are in
// lib/location.js, the Settings hub's in lib/hub.js). No browser or React code, so
// tests/setup.test.mjs can check them.
import { timeRangeMinutes } from './dates.js'
import { savedCoords } from './location.js'

export const SETUP_DAYS = 14
export const DEFAULT_CLASS_MINUTES = 50
const DAY_MS = 24 * 60 * 60 * 1000

// Lists whose rows carry createdAt: the oldest one says how long the account has been in use.
const AGE_LISTS = ['tasks', 'events', 'friends', 'contactLogs', 'classes', 'journalEntries', 'voiceNotes', 'gymSessions', 'bodyWeights', 'foodEntries']

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const list = (value) => (Array.isArray(value) ? value : [])

// ---- "Get set up" ------------------------------------------------------------------------------

// Whole days since the account's oldest row, 0 for an account with nothing in it yet, or null when
// it has rows but none says when it was made (rows from before createdAt: an established account).
// enough: stop at the first row at least that many days old and return its age (all a caller like
// setupVisible needs), so an established account isn't a Date.parse of every row on each update.
export function accountAgeDays(data, now = Date.now(), enough = Infinity) {
  const lists = AGE_LISTS.map((key) => list(data?.[key])).filter((rows) => rows.length)
  if (!lists.length) return 0
  let oldest = Infinity
  const age = () => Math.max(0, Math.floor((now - oldest) / DAY_MS))
  const isEnough = (row) => {
    const at = Date.parse(row?.createdAt || '')
    if (Number.isFinite(at) && at < oldest) oldest = at
    return now - oldest >= enough * DAY_MS
  }
  // Lists are kept newest or oldest first, so the ends of each are looked at first.
  if (lists.some((rows) => isEnough(rows[0]) || isEnough(rows[rows.length - 1]))) return age()
  for (const rows of lists) {
    for (const row of rows) if (isEnough(row)) return age()
  }
  return oldest === Infinity ? null : age()
}

// The card is for new accounts (under SETUP_DAYS old) until it's hidden (settings.setupHidden).
export function setupVisible(data, now = Date.now()) {
  if (data?.settings?.setupHidden === true) return false
  const age = accountAgeDays(data, now, SETUP_DAYS)
  return age !== null && age < SETUP_DAYS
}

export function hasGymPlan(gym) {
  return list(gym?.schedule?.versions).length > 0 || list(gym?.routines).length > 0
}

export function hasSavedLocation(settings) {
  return savedCoords(settings) !== null
}

// Push support values (lib/notifications.js pushSupport) where reminders can be turned on here,
// one way or another; elsewhere (no push at all, the dev server) the step isn't offered.
const REMINDER_SUPPORT = new Set(['default', 'granted', 'install', 'denied'])

// The card's rows, in order, for the areas that are on: [{ id, done }]. Each one ticks itself off
// from the data. `push` is pushSupport(), `subscribed` whether this device gets reminders.
export function setupSteps({ settings = {}, classes = [], friends = [], areas = {}, hasCoords = false, push = 'unsupported', subscribed = false } = {}) {
  const steps = [
    { id: 'classes', done: list(classes).length > 0 },
    areas.gym !== false && { id: 'gym', done: hasGymPlan(settings?.gym) },
    areas.food !== false && { id: 'food', done: Number(settings?.food?.goals?.calories) > 0 },
    areas.people !== false && { id: 'people', done: list(friends).length > 0 },
    { id: 'location', done: !!hasCoords || hasSavedLocation(settings) },
    REMINDER_SUPPORT.has(push) && { id: 'reminders', done: push === 'granted' && subscribed === true },
  ]
  return steps.filter(Boolean)
}

// Today shows at most one hint card: 'setup' (the card above, while something is left), else on
// the Home Screen app 'reminders' (notifications can be asked for), else in iOS Safari 'install'
// (reminders need the Home Screen app), else null. `dismissed` = { reminders, install } (per device).
export function todayHint({ setup = false, steps = [], push, subscribed, standalone = false, dismissed = {} } = {}) {
  if (setup && steps.some((step) => !step.done)) return 'setup'
  if (standalone && push === 'default' && subscribed !== true && !dismissed.reminders) return 'reminders'
  if (push === 'install' && !dismissed.install) return 'install'
  return null
}

// What the "notifications are off here" row under a reminder switch says: null (nothing to say, or
// still checking), 'off' (can be turned on with a tap), 'install' (iPhone: Home Screen app first)
// or 'blocked' (denied in the phone's settings).
export function notifyHintState(support, subscribed) {
  if (support === 'granted') return subscribed === false ? 'off' : null
  if (support === 'default') return 'off'
  if (support === 'install') return 'install'
  if (support === 'denied') return 'blocked'
  return null
}

// ---- faster timetable --------------------------------------------------------------------------

// The end date most classes share (from today on), for a new class: a timetable usually ends on
// one day. A tie goes to the later date. '' when no class has one.
export function commonEndDate(endDates, today) {
  const counts = new Map()
  for (const date of list(endDates)) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) continue
    counts.set(date, (counts.get(date) || 0) + 1)
  }
  let best = ''
  for (const [date, count] of counts) {
    const top = counts.get(best) || 0
    if (count > top || (count === top && date > best)) best = date
  }
  return best
}

// Minutes of the first time range in `times` (newest class first) that has both ends, else 50.
export function classLength(times) {
  for (const time of list(times)) {
    const { start, end } = timeRangeMinutes(time)
    if (start !== null && end !== null && end > start) return end - start
  }
  return DEFAULT_CLASS_MINUTES
}

// 'HH:MM' plus minutes, kept within the day (a late start ends at 23:59 rather than wrapping).
export function addMinutesHHMM(start, minutes) {
  const match = String(start || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ''
  const total = Math.min(23 * 60 + 59, Number(match[1]) * 60 + Number(match[2]) + Math.max(0, Number(minutes) || 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

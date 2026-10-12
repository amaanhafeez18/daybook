// Reminder settings that learn from what the owner does. Looks at recent history and proposes at
// most a couple of changes to settings.notifications, each offered once (Settings → Notifications,
// "Suggested"): nothing changes until they tap Change (with Undo), and an answered offer — Change or
// Not now — is remembered in settings.learned.dismissed so it never comes back.
//   gymTime: the workout reminder vs when recent workouts actually started.
//   taskLead: the default reminder for timed tasks vs the one they keep picking per task.
// (The morning summary and evening check-in times aren't learned: nothing in the data says when the
// owner actually reads them.) Pure: imports only ./dates.js, no browser or React code.

import { addDaysISO, formatTime, isISODate, toISO } from './dates.js'

export const LEARNED_MAX = 50 // answered offers kept in settings.learned.dismissed

const GYM_SESSIONS = 8 // look at the latest 8 workouts…
const GYM_MIN = 6 // …needing at least 6 that started within 45 min of their usual time
const GYM_BAND = 45
const GYM_EARLY = 25 // remind 25 min before the usual start…
const GYM_STEP = 15 // …on a quarter hour
const GYM_MIN_CHANGE = 30 // only worth offering when it moves the reminder by 30 min or more
const GYM_DAYS = 90

const LEAD_TASKS = 8 // the latest 8 timed tasks…
const LEAD_MIN_TASKS = 6
const LEAD_MIN_SAME = 5 // …5 of them with the same reminder picked
const LEAD_DAYS = 120

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const pad = (n) => String(n).padStart(2, '0')
const hhmmOf = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
const minutesOf = (value) => {
  const match = TIME_RE.exec(typeof value === 'string' ? value.trim().slice(0, 5) : '')
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const list = (value) => (Array.isArray(value) ? value.filter(isObj) : [])

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// The local date and minutes of an ISO timestamp, or null.
function localMoment(iso) {
  if (typeof iso !== 'string' || !iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return { day: toISO(date), minutes: date.getHours() * 60 + date.getMinutes() }
}

function inQuietHours(minutes, prefs) {
  if (!prefs?.quietHours) return false
  const start = minutesOf(prefs.quietStart)
  const end = minutesOf(prefs.quietEnd)
  if (start === null || end === null || start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

// "1 hour before", "15 minutes before", "at the time", "no reminder".
export function leadText(minutes) {
  if (minutes === 0) return 'at the time'
  if (!Number.isInteger(minutes) || minutes < 0) return 'no reminder'
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`
  return `${minutes} minute${minutes === 1 ? '' : 's'} before`
}

// Logged after the fact, so its start time is a stand-in: flagged as a backfill, never finished
// with a clock (assistant quick logs), or saved over a minute after its start ("Log my sets" starts
// an hour back; a live workout's createdAt is its startedAt). Same rule as stats.isBackfillWorkout.
function afterTheFact(session) {
  if (session.backfill === true || !session.endedAt) return true
  const created = Date.parse(session.createdAt)
  const started = Date.parse(session.startedAt)
  return Number.isFinite(created) && Number.isFinite(started) && created - started > 60000
}

// Workouts that were started live (a real start time on the day they're logged for), newest first.
function liveStarts(sessions, today) {
  const from = isISODate(today) ? addDaysISO(today, -GYM_DAYS) : null
  const out = []
  for (const session of list(sessions)) {
    if (!isISODate(session.date) || (from && (session.date < from || session.date > today))) continue
    if (afterTheFact(session)) continue
    const start = localMoment(session.startedAt)
    if (!start || start.day !== session.date) continue
    out.push({ stamp: new Date(session.startedAt).getTime(), minutes: start.minutes })
  }
  return out.sort((a, b) => b.stamp - a.stamp)
}

// The workout reminder vs when the latest 8 workouts started: ~25 min before their usual start
// (on a quarter hour) when that's 30+ min from the current reminder and the starts are steady.
// prefs: the merged notification prefs (gym, gymTime, quiet hours). → offer or null.
export function gymTimeSuggestion({ sessions, prefs, today }) {
  if (!prefs?.gym) return null
  const current = minutesOf(prefs.gymTime)
  if (current === null) return null
  const recent = liveStarts(sessions, today).slice(0, GYM_SESSIONS)
  if (recent.length < GYM_MIN) return null
  const usual = median(recent.map((item) => item.minutes))
  const steady = recent.filter((item) => Math.abs(item.minutes - usual) <= GYM_BAND).length
  if (steady < GYM_MIN) return null
  const target = Math.round((usual - GYM_EARLY) / GYM_STEP) * GYM_STEP
  if (target < 0 || target >= 1440 || Math.abs(target - current) < GYM_MIN_CHANGE) return null
  if (inQuietHours(target, prefs)) return null
  const value = hhmmOf(target)
  const around = formatTime(hhmmOf(Math.round(usual / 5) * 5))
  return {
    kind: 'gymTime',
    // Keyed on the reminder being questioned, not the proposal: "Not now" means "leave my 5:00 PM
    // reminder alone" even when the suggested time drifts a little later on.
    key: `gymTime:${hhmmOf(current)}`,
    patch: { gymTime: value },
    previous: { gymTime: prefs.gymTime },
    text: `Your last ${recent.length} workouts started around ${around}, but the workout reminder comes at ${formatTime(prefs.gymTime)}. Move it to ${formatTime(value)}?`,
    done: `Workout reminder moved to ${formatTime(value)}`,
  }
}

const isFriendReminder = (task) => typeof task.details === 'string' && task.details.startsWith('friend-reminder:')

// The default reminder for timed tasks vs the ones picked per task: when 5 of the latest 8 timed
// tasks got the same reminder, and it isn't the default, offer to make it the default.
export function leadSuggestion({ tasks, prefs, today }) {
  const current = Number(prefs?.taskLead)
  if (!Number.isFinite(current)) return null
  const from = isISODate(today) ? addDaysISO(today, -LEAD_DAYS) : null
  const timed = list(tasks)
    .filter((task) => isISODate(task.date) && minutesOf(task.time) !== null && !isFriendReminder(task))
    .filter((task) => !from || task.date >= from)
    .map((task) => ({ task, order: (typeof task.createdAt === 'string' && task.createdAt) || `${task.date}T${task.time}` }))
    .sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0))
    .slice(0, LEAD_TASKS)
    .map((item) => item.task)
  if (timed.length < LEAD_MIN_TASKS) return null
  const counts = new Map()
  for (const task of timed) {
    const minutes = task.reminderMinutes ?? task.reminder_minutes
    if (Number.isInteger(minutes) && minutes >= 0) counts.set(minutes, (counts.get(minutes) || 0) + 1)
  }
  let best = null
  for (const [minutes, count] of counts) if (!best || count > best.count) best = { minutes, count }
  if (!best || best.count < LEAD_MIN_SAME || best.minutes === current) return null
  const picked = leadText(best.minutes)
  const now = current < 0 ? 'new timed tasks get no reminder' : `the default is ${leadText(current)}`
  return {
    kind: 'taskLead',
    key: `taskLead:${current}`,
    patch: { taskLead: best.minutes },
    previous: { taskLead: prefs.taskLead },
    text: `You picked ${picked} on ${best.count} of your last ${timed.length} timed tasks, but ${now}. Make ${picked} the default?`,
    done: `Timed tasks now remind you ${picked}`,
  }
}

// Keys of the offers already answered.
export function answeredKeys(settings) {
  return new Set(list(settings?.learned?.dismissed).map((item) => item.key).filter((key) => typeof key === 'string'))
}

// The offers to show now, best first (at most `limit`), minus answered ones.
// prefs: merged notification prefs; tasks/gymSessions: the store lists.
export function learnedSuggestions({ settings, prefs, tasks, gymSessions, today, limit = 2 }) {
  const answered = answeredKeys(settings)
  const gymArea = settings?.areas?.gym !== false
  const offers = [
    gymArea ? gymTimeSuggestion({ sessions: gymSessions, prefs, today }) : null,
    leadSuggestion({ tasks, prefs, today }),
  ]
  return offers.filter((offer) => offer && !answered.has(offer.key)).slice(0, Math.max(0, limit))
}

// settings.learned with `key` answered (newest first, at most 50 kept). `at`: an ISO timestamp.
export function withAnswered(learned, key, at) {
  const base = isObj(learned) ? learned : {}
  const kept = list(base.dismissed).filter((item) => item.key !== key)
  return { ...base, dismissed: [{ key, at }, ...kept].slice(0, LEARNED_MAX) }
}

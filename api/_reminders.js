// Shared by api/cron.js (scheduled reminders) and api/push.js (test notifications).
// Files starting with "_" are not deployed as their own serverless functions.
import webpush from 'web-push'
// Pure, dependency-free gym modules shared with the app.
import { resolveDay } from '../src/lib/gym/schedule.js'
import { estimateMinutes } from '../src/lib/gym/stats.js'
// Pure date helpers (no imports), shared with the app.
import { timeRangeMinutes } from '../src/lib/dates.js'

// Keep in sync with src/lib/notifications.js.
export const DEFAULT_NOTIFICATIONS = {
  taskLead: 15, // minutes before a timed task; 0 = at the time, -1 = off
  allDayTime: '09:00', // reminder time for tasks with a date but no time; '' = off
  allDayMode: 'day', // 'day' = on the due day, 'before' = the day before
  dailySummary: true,
  dailySummaryTime: '08:00',
  overdue: true,
  overdueTime: '18:00',
  people: true, // catch-ups and birthdays (in the summary, plus "Talk to…" task reminders)
  gym: false, // workout reminder on days the gym plan shows a routine (not rest, skipped, shifted or done)
  gymTime: '17:00', // local time of the workout reminder
  prayer: false, // prayer-time reminders (needs settings.location; times from api/_prayer.js)
  prayerLead: 0, // minutes before each prayer; 0 = at the time
  prayers: ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'], // which prayers
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '07:00',
}

const SEND_WINDOW_MS = 45 * 60 * 1000 // late cron runs still deliver, but stale reminders are dropped
// An untimed task added after its all-day reminder time with an explicit all-day reminder (on the
// day / the day before) is reminded once, this long after it was created, instead of never.
const LATE_ALLDAY_DELAY_MS = 60 * 1000
// Late all-day reminders due together are sent as one notification (api/cron.js); one added less than
// LATE_ALLDAY_DELAY_MS ago holds back the others for up to this long, so they go out together.
const LATE_ALLDAY_HOLD_MS = 5 * 60 * 1000
export const LATE_ALLDAY_BATCH = 'late-allday'

export const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']

// The user's local calendar date at `now` (for the day's prayer times).
export function localDateFor(settings, now = Date.now()) {
  return localNow(now, safeZone(settings?.timeZone || 'UTC')).date
}

export function notificationPrefs(settings) {
  return { ...DEFAULT_NOTIFICATIONS, ...(settings?.notifications || {}) }
}

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

let configured = false
function configure() {
  if (configured) return
  // Apple requires the subject to be a mailto: or https: URL.
  const subject = process.env.VAPID_SUBJECT
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'mailto:notifications@daybook.app')
  webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
  configured = true
}

// Sends to every device the user enabled; removes subscriptions the push service says are gone.
// Returns { sent, failed }: failed counts devices that may be reachable later (not 404/410).
export async function sendToUser(supabase, userId, payload) {
  configure()
  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('vapid_public', process.env.VAPID_PUBLIC_KEY)
  if (error) throw error
  let sent = 0
  let failed = 0
  await Promise.all((subscriptions || []).map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: 'high', timeout: 10000 },
      )
      sent += 1
      await supabase.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).eq('id', subscription.id)
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', subscription.id)
      } else {
        failed += 1
        console.error('Push failed:', err.statusCode, err.body || err.message)
      }
    }
  }))
  return { sent, failed }
}

// ---- time zones ---------------------------------------------------------------------------

const zoneFormatters = new Map()

// Throws a RangeError for an unknown time zone.
function zoneFormatter(timeZone) {
  let formatter = zoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    zoneFormatters.set(timeZone, formatter)
  }
  return formatter
}

// settings.timeZone is user-writable, so an invalid one falls back to UTC instead of throwing.
function safeZone(zone) {
  try {
    zoneFormatter(zone)
    return zone
  } catch {
    return 'UTC'
  }
}

function zoneParts(timestamp, timeZone) {
  return Object.fromEntries(zoneFormatter(timeZone).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]))
}

function offsetMinutes(timestamp, timeZone) {
  const p = zoneParts(timestamp, timeZone)
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - timestamp) / 60000
}

// Local wall-clock date + time in `timeZone` → UTC timestamp (handles DST changes).
export function zonedToUtc(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = guess - offsetMinutes(guess, timeZone) * 60000
  const second = guess - offsetMinutes(timestamp, timeZone) * 60000
  if (second !== timestamp) timestamp = second
  return timestamp
}

export function localNow(timestamp, timeZone) {
  const p = zoneParts(timestamp, timeZone)
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

function addDays(date, delta) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + delta)
  return value.toISOString().slice(0, 10)
}

// Whole days from one YYYY-MM-DD date to another.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000)
}

// Keep in sync with src/lib/planner.js reminderInterval / RELATIONSHIPS.
function catchUpInterval(friend) {
  if (friend.reminder_days !== undefined && friend.reminder_days !== null) return friend.reminder_days
  return friend.relationship === 'close_friend' ? 10 : friend.relationship === 'acquaintance' ? null : 30
}

function toMinutes(time) {
  const [hour, minute] = String(time || '').split(':').map(Number)
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
}

function isTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function formatTime(time) {
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`
}

// Moves a reminder that falls inside quiet hours to the moment they end.
function outsideQuietHours(timestamp, prefs, timeZone) {
  if (!prefs.quietHours) return timestamp
  const start = toMinutes(prefs.quietStart)
  const end = toMinutes(prefs.quietEnd)
  if (start === null || end === null || start === end) return timestamp
  const local = localNow(timestamp, timeZone)
  const inside = start < end ? local.minutes >= start && local.minutes < end : local.minutes >= start || local.minutes < end
  if (!inside) return timestamp
  const endDate = start > end && local.minutes >= start ? addDays(local.date, 1) : local.date
  return zonedToUtc(endDate, prefs.quietEnd, timeZone)
}

// "today", "tomorrow", "yesterday", or "Thu, Sep 24".
function dayLabel(date, today) {
  if (date === today) return 'today'
  if (date === addDays(today, 1)) return 'tomorrow'
  if (date === addDays(today, -1)) return 'yesterday'
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}

function isReminderTask(task) {
  return typeof task.details === 'string' && task.details.startsWith('friend-reminder:')
}

// ---- gym ------------------------------------------------------------------------------------

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Today's gym day when it shows an existing routine that still needs doing (status 'today'),
// else null: no plan, rest, skipped, shifted, done, deleted routine, or sessions unknown.
function plannedWorkout(settings, gymSessions, today) {
  const gym = settings?.gym
  if (!isObject(gym) || !Array.isArray(gym.schedule?.versions) || !gym.schedule.versions.length) return null
  if (!Array.isArray(gymSessions)) return null // couldn't load sessions: don't remind about a workout that may be done
  try {
    const day = resolveDay(gym, gymSessions, today, today)
    return day.status === 'today' && day.routine ? day : null
  } catch (error) {
    // The gym plan must never stop task reminders.
    console.error('Gym day failed:', error.message || error)
    return null
  }
}

// The gym day `date` shows a routine that's still to do (not rest, skipped, shifted or done), else null.
function plannedWorkoutOn(settings, gymSessions, date, today) {
  const gym = settings?.gym
  if (!isObject(gym) || !Array.isArray(gym.schedule?.versions) || !gym.schedule.versions.length || !Array.isArray(gymSessions)) return null
  try {
    const day = resolveDay(gym, gymSessions, date, today)
    return ['today', 'upcoming'].includes(day.status) && day.routine ? day : null
  } catch (error) {
    console.error('Gym day failed:', error.message || error)
    return null
  }
}

// A workout for today is already in progress (settings.gym.active, synced by the app).
function workoutInProgress(gym, today, timeZone) {
  const active = gym?.active
  if (!isObject(active)) return false
  if (active.date === today) return true
  const started = Date.parse(active.startedAt)
  return Number.isFinite(started) && localNow(started, timeZone).date === today
}

// 'Push' → 'Push day'; a name that already ends in "day" stays as it is ('Leg Day').
function gymDayName(routine) {
  const name = typeof routine?.name === 'string' && routine.name.trim() ? routine.name.trim() : 'Workout'
  return /\bday$/i.test(name) ? name : `${name} day`
}

function workoutReminder(day, today, time, timeZone) {
  const count = Array.isArray(day.routine.exercises) ? day.routine.exercises.filter(isObject).length : 0
  const minutes = estimateMinutes(day.routine)
  const parts = []
  if (count) parts.push(`${count} exercise${count === 1 ? '' : 's'}`)
  if (minutes) parts.push(`~${minutes} min`)
  if (day.deload) parts.push('Deload week')
  return {
    key: `gym:${today}`,
    fireAt: zonedToUtc(today, time, timeZone),
    title: `${gymDayName(day.routine)} today`,
    body: parts.join(' · ') || 'Time to train',
    url: '/#/gym',
    tag: 'gym',
  }
}

// ---- task reminders -------------------------------------------------------------------------

// When one task's reminder fires under these prefs (before quiet hours), or why it doesn't.
// → { off: 'nodate' | 'people' | 'task' | 'lead' | 'allday' }
//   | { off: 'added', time, dayBefore }
//   | { timed: true, key, fireAt, due, lead }
//   | { timed: false, key, fireAt, time, dayBefore, scheduled, late }
// An untimed task created after its all-day reminder time (on or before its date) gets:
//   * with an explicit all-day reminder (reminder_minutes 0 = on the day, >= 1440 = the day before:
//     the user or the assistant asked for one), late: one ping shortly after creation (once per key)
//     when that is still on or before the due date after quiet hours; otherwise the passed time.
//   * otherwise (a plain quick-add, a catch-up task the app adds on open) off 'added': no ping. The
//     user has just typed it, and the evening nudge lists what's still open today.
// Tasks may be database rows (snake_case) or app/assistant objects (camelCase).
function taskReminderPlan(task, prefs, timeZone) {
  if (!isDate(task.date)) return { off: 'nodate' }
  if (isReminderTask(task) && !prefs.people) return { off: 'people' }
  const minutes = task.reminder_minutes ?? task.reminderMinutes
  const override = Number.isInteger(minutes) ? minutes : null
  if (override !== null && override < 0) return { off: 'task' } // negative = no reminder

  if (isTime(task.time)) {
    const lead = override ?? Number(prefs.taskLead)
    if (!Number.isFinite(lead) || lead < 0) return { off: 'lead' }
    const due = zonedToUtc(task.date, task.time, timeZone)
    return { timed: true, key: `task:${task.id}:${task.date}T${task.time}:${lead}`, fireAt: due - lead * 60000, due, lead }
  }

  // Only all-day values count here (0 = on the day, >= 1440 = day before); a lead left over
  // from when the task had a time falls back to the all-day default.
  const allDayOverride = override === 0 || override >= 1440 ? override : null
  const mode = allDayOverride === null ? (prefs.allDayTime ? (prefs.allDayMode === 'before' ? 1440 : 0) : -1) : allDayOverride
  if (mode < 0) return { off: 'allday' }
  const time = isTime(prefs.allDayTime) ? prefs.allDayTime : '09:00'
  const dayBefore = mode >= 1440
  const scheduled = zonedToUtc(dayBefore ? addDays(task.date, -1) : task.date, time, timeZone)
  const plan = { timed: false, key: `task:${task.id}:${task.date}:allday:${dayBefore ? 'before' : 'day'}`, fireAt: scheduled, time, dayBefore, scheduled, late: false }

  // B5: added after the all-day time (see above).
  const created = Date.parse(task.created_at ?? task.createdAt ?? '')
  if (Number.isFinite(created) && created > scheduled && localNow(created, timeZone).date <= task.date) {
    if (allDayOverride === null || isReminderTask(task)) return { off: 'added', time, dayBefore }
    const fireAt = outsideQuietHours(created + LATE_ALLDAY_DELAY_MS, prefs, timeZone)
    if (localNow(fireAt, timeZone).date <= task.date) return { ...plan, fireAt, late: true }
  }
  return plan
}

function taskTitle(task) {
  return task.priority === 'urgent' ? `Urgent: ${task.text}` : task.text
}

const PREVIEW_OFF = {
  nodate: 'no reminder will fire (the task has no date)',
  people: 'no reminder will fire (catch-up reminders are off in Settings → Notifications)',
  task: 'no reminder will fire (reminders are turned off for this task)',
  lead: 'no reminder will fire (reminders for timed tasks are off in Settings → Notifications)',
  allday: 'no reminder will fire (all-day reminders are off in Settings → Notifications; give it a time to get one)',
}

// When the reminder for `task` will actually fire, mirroring dueNotifications (quiet hours, the send
// window, the late all-day rule). prefs: settings.notifications (defaults filled in here). A task
// without created_at is taken to be created now.
// → { at: epoch ms | null, label: 'today 7:45 PM' | null, warning: string | null }
export function reminderPreview(task, prefs, timeZone, nowMs = Date.now()) {
  const none = (warning) => ({ at: null, label: null, warning })
  const item = isObject(task) ? task : {}
  if (item.done || item.archived) return none(null)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const merged = { ...DEFAULT_NOTIFICATIONS, ...(isObject(prefs) ? prefs : {}) }
  const zone = safeZone(typeof timeZone === 'string' && timeZone ? timeZone : 'UTC')
  const today = localNow(now, zone).date
  const withCreated = item.created_at || item.createdAt ? item : { ...item, created_at: new Date(now).toISOString() }
  const plan = taskReminderPlan(withCreated, merged, zone)
  if (plan.off === 'added') {
    return none(`no reminder will fire (all-day reminders go at ${formatTime(plan.time)}${plan.dayBefore ? ' the day before' : ''}, which had passed when it was added; give it a time to get one)`)
  }
  if (plan.off) return none(PREVIEW_OFF[plan.off])

  const planned = plan.fireAt
  let at = outsideQuietHours(planned, merged, zone)
  const quietMoved = at !== planned
  const label = (timestamp) => {
    const local = localNow(timestamp, zone)
    return `${dayLabel(local.date, today)} ${formatTime(local.time)}`
  }
  if (at < now) {
    // The next cron run (every minute) still sends anything up to SEND_WINDOW_MS late.
    if (now - at <= SEND_WINDOW_MS) at = now
    else if (item.date < today || (plan.timed && plan.due < now)) return none(`no reminder will fire (the task’s ${plan.timed ? 'date and time have' : 'date has'} passed)`)
    else if (plan.timed) return none(`no reminder will fire (its reminder time, ${label(planned)}, has passed)`)
    else return none(`no reminder will fire (all-day reminders go at ${formatTime(plan.time)}${plan.dayBefore ? ' the day before' : ''}, which has passed)`)
  }
  let warning = null
  if (plan.late) warning = `all-day reminders go at ${formatTime(plan.time)}${plan.dayBefore ? ' the day before' : ''}, which has passed, so it pings once right after saving; give it a time for a proper reminder`
  else if (quietMoved) warning = `the reminder falls in quiet hours, so it comes at ${formatTime(localNow(at, zone).time)} instead`
  return { at, label: label(at), warning }
}

// ---- summaries -----------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay()
const weekdayName = (date) => WEEKDAY_NAMES[weekdayOf(date)]
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// Timed tasks first, by time; then the rest.
function byTaskTime(a, b) {
  const left = isTime(a.time) ? a.time : '99:99'
  const right = isTime(b.time) ? b.time : '99:99'
  return left < right ? -1 : left > right ? 1 : 0
}

// "Essay (9:00 AM), Call mom, Gym +2 more"; long titles are cut so the banner stays readable.
function taskNames(list) {
  const short = (text) => {
    const value = String(text || '').trim()
    return value.length > 40 ? `${value.slice(0, 38).trimEnd()}…` : value
  }
  const names = list.slice(0, 3).map((task) => `${short(task.text)}${isTime(task.time) ? ` (${formatTime(task.time)})` : ''}`)
  return `${names.join(', ')}${list.length > 3 ? ` +${list.length - 3} more` : ''}`
}

// Class slots on a date (rows: days ["Mon"] + day_details, or [{ day, time, room }]), by start time.
function classSlotsOn(classes, date) {
  const weekday = WEEKDAYS[weekdayOf(date)]
  const slots = []
  for (const item of Array.isArray(classes) ? classes : []) {
    if (!isObject(item) || (isDate(item.end_date) && item.end_date < date)) continue
    const details = isObject(item.day_details) ? item.day_details : {}
    for (const day of Array.isArray(item.days) ? item.days : []) {
      const name = typeof day === 'string' ? day : day?.day
      if (name !== weekday) continue
      const time = typeof day === 'string' ? details[day]?.time || item.time || '' : day?.time || ''
      slots.push({ name: String(item.name || 'Class'), start: timeRangeMinutes(time).start })
    }
  }
  return slots.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9))
}

const minutesText = (minutes) => formatTime(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)

// "ECON 1022 at 2:30 PM" / "3 classes from 11:30 AM" / "" (no classes).
function classesLine(classes, date) {
  const slots = classSlotsOn(classes, date)
  if (!slots.length) return ''
  const names = [...new Set(slots.map((slot) => slot.name))]
  const first = slots[0].start
  if (names.length === 1) return `${names[0]}${first !== null ? ` at ${minutesText(first)}` : ''}`
  return `${names.length} classes${first !== null ? ` from ${minutesText(first)}` : ''}`
}

// "🎂 Ali’s birthday today/tomorrow" for friends whose birthday falls on one of `dates`. Feb 29
// birthdays are marked on Mar 1 in other years.
function birthdayLines(friends, today, dates) {
  const lines = []
  for (const date of dates) {
    const year = Number(date.slice(0, 4))
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    for (const friend of Array.isArray(friends) ? friends : []) {
      if (!isDate(friend?.birthday)) continue
      const monthDay = friend.birthday.slice(5) === '02-29' && !leap ? '03-01' : friend.birthday.slice(5)
      if (monthDay === date.slice(5)) lines.push(`🎂 ${friend.name}’s birthday ${date === today ? 'today' : 'tomorrow'}`)
    }
  }
  return lines
}

// ---- what is due ----------------------------------------------------------------------------

// Tapping a task's reminder opens that task (TasksPage reads #/tasks/<id>); anything without an id
// opens the list.
function taskUrl(task) {
  const id = task?.id == null ? '' : String(task.id)
  return id ? `/#/tasks/${encodeURIComponent(id)}` : '/#/tasks'
}

// Every notification that should fire around `now` for one user, oldest first.
// contactLogs: [{ friend_id, date }], or null when unavailable (falls back to "Talk to…" tasks).
// gymSessions: gym session rows with at least { date } from the last few days, or null when
// unavailable (gym reminders then wait for a later run within SEND_WINDOW_MS).
// prayerTimings: today's { Fajr: 'HH:MM', … } for the user's location (api/_prayer.js), or null when
// unknown; prayer reminders ignore quiet hours (Fajr is early by nature).
export function dueNotifications({ settings, tasks, friends, contactLogs = null, classes, gymSessions = null, prayerTimings = null }, now = Date.now()) {
  const prefs = notificationPrefs(settings)
  // Areas switched off in Settings → What you use get no reminders either.
  const areas = isObject(settings?.areas) ? settings.areas : {}
  if (areas.gym === false) prefs.gym = false
  if (areas.people === false) prefs.people = false
  const timeZone = safeZone(settings?.timeZone || 'UTC')
  const today = localNow(now, timeZone).date
  const tomorrow = addDays(today, 1)
  const open = tasks.filter((task) => !task.done && !task.archived)
  // Overdue counts leave out catch-up tasks when those notifications are off.
  const counted = open.filter((task) => prefs.people || !isReminderTask(task))
  const workout = areas.gym !== false && (prefs.gym || prefs.dailySummary) ? plannedWorkout(settings, gymSessions, today) : null
  const candidates = []

  // Task reminders
  for (const task of open) {
    const plan = taskReminderPlan(task, prefs, timeZone)
    if (plan.off) continue
    let body
    if (plan.timed) {
      const when = `${dayLabel(task.date, today)} at ${formatTime(task.time)}`
      body = plan.lead === 0 ? `Due now (${formatTime(task.time)})` : task.date < today ? `Was due ${when}` : `Due ${when}`
    } else if (plan.late) {
      body = localNow(plan.fireAt, timeZone).date === task.date ? 'Due today' : 'Due tomorrow'
    } else {
      body = plan.dayBefore ? 'Due tomorrow' : 'Due today'
    }
    candidates.push({ key: plan.key, fireAt: plan.fireAt, title: taskTitle(task), body, url: taskUrl(task), tag: `task-${task.id}`, ...(plan.late ? { batch: LATE_ALLDAY_BATCH } : {}) })
  }

  // Morning summary: every day it's on, a clear day included (so it's plain the reminders work).
  if (prefs.dailySummary && isTime(prefs.dailySummaryTime)) {
    const dueToday = open.filter((task) => task.date === today && !isReminderTask(task)).sort(byTaskTime)
    const overdue = counted.filter((task) => isDate(task.date) && task.date < today)
    const lines = []
    if (dueToday.length) lines.push(`${plural(dueToday.length, 'task')}: ${taskNames(dueToday)}`)
    if (overdue.length) lines.push(`${overdue.length} overdue`)
    const classLine = classesLine(classes, today)
    if (classLine) lines.push(classLine)
    if (workout) lines.push(`Gym: ${gymDayName(workout.routine)}`)
    if (prefs.people) {
      lines.push(...birthdayLines(friends, today, [today, tomorrow]))
      let catchUpCount
      if (Array.isArray(contactLogs)) {
        // From the contact history, so it doesn't depend on the app having created "Talk to…" tasks.
        const lastById = {}
        for (const log of contactLogs) {
          if (log.friend_id && isDate(log.date) && (!lastById[log.friend_id] || log.date > lastById[log.friend_id])) lastById[log.friend_id] = log.date
        }
        catchUpCount = friends.filter((friend) => {
          const interval = catchUpInterval(friend)
          const last = lastById[friend.id]
          return interval && (!last || daysBetween(last, today) >= interval)
        }).length
      } else {
        catchUpCount = open.filter((task) => task.date === today && isReminderTask(task)).length
      }
      if (catchUpCount) lines.push(`${catchUpCount} catch-up${catchUpCount === 1 ? '' : 's'} due`)
    }
    candidates.push({
      key: `summary:${today}`,
      fireAt: zonedToUtc(today, prefs.dailySummaryTime, timeZone),
      title: `Your ${weekdayName(today)}`,
      body: lines.length ? lines.join(' · ') : 'Nothing planned. A clear day.',
      url: '/#/today',
      tag: 'daily-summary',
    })
  }

  // Evening check-in: a recap of today and a look at tomorrow, every day it's on. Needs today's done
  // tasks too (api/cron.js loads them) to say how the day went.
  if (prefs.overdue && isTime(prefs.overdueTime)) {
    const todays = tasks.filter((task) => task.date === today && !task.archived && !isReminderTask(task))
    const stillOpen = todays.filter((task) => !task.done).sort(byTaskTime)
    const doneCount = todays.length - stillOpen.length
    const overdue = counted.filter((task) => isDate(task.date) && task.date < today)
    const parts = []
    if (todays.length && !stillOpen.length) parts.push(`All ${todays.length} done today ✓`)
    else if (stillOpen.length) parts.push(`${doneCount ? `${doneCount} of ${todays.length} done · ` : ''}Still open: ${taskNames(stillOpen)}`)
    if (overdue.length) parts.push(`${overdue.length} overdue`)
    const ahead = []
    const tomorrowTasks = open.filter((task) => task.date === tomorrow && !isReminderTask(task)).sort(byTaskTime)
    if (tomorrowTasks.length) {
      const first = tomorrowTasks.find((task) => isTime(task.time))
      ahead.push(`${plural(tomorrowTasks.length, 'task')}${first ? ` (first ${formatTime(first.time)})` : ''}`)
    }
    const classLine = classesLine(classes, tomorrow)
    if (classLine) ahead.push(classLine)
    const nextWorkout = plannedWorkoutOn(settings, gymSessions, tomorrow, today)
    if (nextWorkout) ahead.push(`Gym: ${gymDayName(nextWorkout.routine)}`)
    if (prefs.people) ahead.push(...birthdayLines(friends, today, [tomorrow]))
    parts.push(ahead.length ? `Tomorrow: ${ahead.join(', ')}` : 'Tomorrow: nothing planned yet')
    candidates.push({
      key: `overdue:${today}`,
      fireAt: zonedToUtc(today, prefs.overdueTime, timeZone),
      title: stillOpen.length || overdue.length ? 'Before the day ends' : 'Evening check-in',
      body: parts.join(' · '),
      url: stillOpen.length || overdue.length ? '/#/tasks' : '/#/today',
      tag: 'evening-nudge',
    })
  }

  // Workout reminder on gym days, unless today's workout is already under way
  if (prefs.gym && workout && !workoutInProgress(settings.gym, today, timeZone)) {
    const time = isTime(prefs.gymTime) ? prefs.gymTime : DEFAULT_NOTIFICATIONS.gymTime
    candidates.push(workoutReminder(workout, today, time, timeZone))
  }

  // Prayer reminders
  if (prefs.prayer && isObject(prayerTimings)) {
    const wanted = Array.isArray(prefs.prayers) && prefs.prayers.length ? prefs.prayers : PRAYER_NAMES
    const lead = Number.isFinite(Number(prefs.prayerLead)) ? Math.min(120, Math.max(0, Math.round(Number(prefs.prayerLead)))) : 0
    for (const name of PRAYER_NAMES) {
      if (!wanted.includes(name) || !isTime(prayerTimings[name])) continue
      const at = zonedToUtc(today, prayerTimings[name], timeZone)
      candidates.push({
        key: `prayer:${today}:${name}`,
        fireAt: at - lead * 60000,
        title: lead ? `${name} in ${lead} min` : `Time for ${name}`,
        body: `${name} at ${formatTime(prayerTimings[name])}`,
        url: '/#/today',
        tag: `prayer-${name}`,
        noQuiet: true,
      })
    }
  }

  const scheduled = candidates.map((item) => ({ ...item, fireAt: item.noQuiet ? item.fireAt : outsideQuietHours(item.fireAt, prefs, timeZone) }))
  // A late all-day reminder for a task added under a minute ago holds back the due ones for a little
  // while, so tasks added together are reminded together (api/cron.js sends a batch as one).
  const waiting = scheduled.some((item) => item.batch && item.fireAt > now && item.fireAt - now <= LATE_ALLDAY_DELAY_MS)
  return scheduled
    .filter((item) => item.fireAt <= now && now - item.fireAt <= SEND_WINDOW_MS)
    .filter((item) => !(waiting && item.batch && now - item.fireAt < LATE_ALLDAY_HOLD_MS))
    .sort((a, b) => a.fireAt - b.fireAt)
}

// dueNotifications' list → groups, each sent as one notification by api/cron.js: items of the same
// `batch` (late all-day reminders) together, at the first one's place; everything else on its own.
export function groupDue(due) {
  const groups = []
  const byBatch = new Map()
  for (const item of Array.isArray(due) ? due : []) {
    if (!item?.batch) {
      groups.push([item])
    } else if (byBatch.has(item.batch)) {
      byBatch.get(item.batch).push(item)
    } else {
      const group = [item]
      byBatch.set(item.batch, group)
      groups.push(group)
    }
  }
  return groups
}

// One notification for reminders of the same batch sent together (see api/cron.js): '3 tasks due
// today' / 'Buy milk, Pay rent, Call Ali and 2 more'. A single item is sent as it is.
export function combineReminders(items) {
  const list = (Array.isArray(items) ? items : []).filter(isObject)
  if (list.length <= 1) {
    const item = list[0] || {}
    return { title: item.title, body: item.body, url: item.url, tag: item.tag }
  }
  const bodies = [...new Set(list.map((item) => item.body))]
  const day = bodies.length === 1 ? /^Due (today|tomorrow)$/.exec(bodies[0])?.[1] : null
  const names = list.map((item) => item.title)
  return {
    title: day ? `${list.length} tasks due ${day}` : `${list.length} tasks coming up`,
    body: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`,
    url: '/#/tasks',
    tag: LATE_ALLDAY_BATCH,
  }
}

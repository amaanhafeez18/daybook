// Shared by api/cron.js (scheduled reminders) and api/push.js (test notifications).
// Files starting with "_" are not deployed as their own serverless functions.
import webpush from 'web-push'
// Pure, dependency-free gym modules shared with the app.
import { resolveDay } from '../src/lib/gym/schedule.js'
import { estimateMinutes } from '../src/lib/gym/stats.js'
// Pure date helpers (no imports), shared with the app.
import { timeRangeMinutes } from '../src/lib/dates.js'
// The app icon's count, the same rule the app uses (src/lib/agenda.js is browser-free).
import { badgeCount } from '../src/lib/agenda.js'
import { savedLocation } from './_prayer.js'

// Keep in sync with src/lib/notifications.js.
export const DEFAULT_NOTIFICATIONS = {
  taskLead: 15, // minutes before a timed task; 0 = at the time, -1 = off
  allDayTime: '09:00', // reminder time for tasks with a date but no time; '' = off
  allDayMode: 'day', // 'day' = on the due day, 'before' = the day before
  dailySummary: true,
  dailySummaryTime: '08:00',
  dailySummaryAi: false, // the morning summary written by the assistant (api/_briefing.js); falls back to the template
  overdue: true,
  overdueTime: '18:00',
  badge: false, // count of overdue + due-today open tasks on the app icon (sent with every push)
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

// '14:05' → '2:05 PM'.
export function formatTime(time) {
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

// The routine's own name ('Upper A', 'Leg Day'), or 'Workout'.
function gymDayName(routine) {
  return typeof routine?.name === 'string' && routine.name.trim() ? routine.name.trim() : 'Workout'
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
    title: `Time for ${gymDayName(day.routine)}`,
    body: parts.join(' · ') || 'Time to train',
    url: '/#/gym',
    tag: 'gym',
    kind: 'gym',
    name: `${gymDayName(day.routine)} workout`,
    day: 'today',
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
    if (localNow(fireAt, timeZone).date <= task.date) return { ...plan, fireAt, late: true, held: fireAt !== created + LATE_ALLDAY_DELAY_MS }
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

// The first `max` UTF-16 units of `text`, without half an emoji at the cut (a lone surrogate shows
// as a replacement character in the banner) or trailing spaces.
export const cutText = (text, max) => String(text).slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd()

// "Essay (9:00 AM), Call mom, Gym and 2 more"; long titles are cut so the banner stays readable.
function taskNames(list) {
  const short = (text) => {
    const value = String(text || '').trim()
    return value.length > 40 ? `${cutText(value, 38)}…` : value
  }
  const names = list.slice(0, 3).map((task) => `${short(task.text)}${isTime(task.time) ? ` (${formatTime(task.time)})` : ''}`)
  return `${names.join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`
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
  return slotsLine(classSlotsOn(classes, date))
}

// The same line from a day's class slots ([{ name, start }], by start time).
function slotsLine(slots) {
  if (!slots.length) return ''
  const names = [...new Set(slots.map((slot) => slot.name))]
  const first = slots[0].start
  if (names.length === 1) return `${names[0]}${first !== null ? ` at ${minutesText(first)}` : ''}`
  return `${names.length} classes${first !== null ? ` from ${minutesText(first)}` : ''}`
}

// The earliest timed task or class on `date` starting at or after `fromMinutes`, else null.
// `tasks` are that day's open tasks. → { name: 'Dentist', start: 570 (minutes), isClass }
function firstUp(tasks, classes, date, fromMinutes) {
  const items = []
  for (const task of tasks) {
    if (isTime(task.time)) items.push({ name: String(task.text || '').trim(), start: toMinutes(task.time), isClass: false })
  }
  for (const slot of classSlotsOn(classes, date)) if (slot.start !== null) items.push({ name: slot.name, start: slot.start, isClass: true })
  const next = items.filter((item) => item.name && item.start >= fromMinutes).sort((a, b) => a.start - b.start)[0]
  return next ? { name: next.name, start: next.start, isClass: next.isClass } : null
}

// firstUp's item as the summary shows it: 'Dentist 9:30 AM' (a long name is cut).
function firstText(first) {
  const name = String(first.name || '')
  return `${name.length > 40 ? `${cutText(name, 38)}…` : name} ${minutesText(first.start)}`
}

// The morning summary's weather words, or '' when rain is unlikely or unknown.
function rainLine(forecast) {
  const chance = forecast?.rainChance == null ? NaN : Number(forecast.rainChance)
  if (!Number.isFinite(chance)) return ''
  if (chance >= 50) return `Rain likely (${Math.round(chance)}%)`
  if (chance >= 30) return `Chance of rain (${Math.round(chance)}%)`
  return ''
}

const SUMMARY_MAX = 180 // about what an expanded lock-screen banner shows

// Joins the summary's parts with " · ". Too long: each { text, short } part uses its short form, then
// the end is cut. Plain strings stay as they are.
function fitSummary(parts) {
  const join = (pick) => parts.map((part) => (typeof part === 'string' ? part : pick(part))).filter(Boolean).join(' · ')
  const full = join((part) => part.text)
  if (full.length <= SUMMARY_MAX) return full
  const short = join((part) => part.short)
  return short.length <= SUMMARY_MAX ? short : `${cutText(short, SUMMARY_MAX - 1)}…`
}

// "Ali’s birthday today/tomorrow" for friends whose birthday falls on one of `dates`. Feb 29
// birthdays are marked on Mar 1 in other years.
function birthdayLines(friends, today, dates) {
  const lines = []
  for (const date of dates) {
    const year = Number(date.slice(0, 4))
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    for (const friend of Array.isArray(friends) ? friends : []) {
      if (!isDate(friend?.birthday)) continue
      const monthDay = friend.birthday.slice(5) === '02-29' && !leap ? '03-01' : friend.birthday.slice(5)
      if (monthDay === date.slice(5)) lines.push(`${friend.name}’s birthday ${date === today ? 'today' : 'tomorrow'}`)
    }
  }
  return lines
}

// ---- the morning summary ---------------------------------------------------------------------

// What one user's day looks like at `now`, shared by dueNotifications and summaryFacts.
function dayContext({ settings, tasks }, now) {
  const prefs = notificationPrefs(settings)
  // Areas switched off in Settings → What you use get no reminders either.
  const areas = isObject(settings?.areas) ? settings.areas : {}
  if (areas.gym === false) prefs.gym = false
  if (areas.people === false) prefs.people = false
  const timeZone = safeZone(settings?.timeZone || 'UTC')
  const today = localNow(now, timeZone).date
  const open = (Array.isArray(tasks) ? tasks : []).filter((task) => !task.done && !task.archived)
  // Overdue counts leave out catch-up tasks when those notifications are off.
  const counted = open.filter((task) => prefs.people || !isReminderTask(task))
  return { prefs, areas, timeZone, today, open, counted }
}

function catchUpsDue(friends, contactLogs, open, today) {
  if (Array.isArray(contactLogs)) {
    // From the contact history, so it doesn't depend on the app having created "Talk to…" tasks.
    const lastById = {}
    for (const log of contactLogs) {
      if (log.friend_id && isDate(log.date) && (!lastById[log.friend_id] || log.date > lastById[log.friend_id])) lastById[log.friend_id] = log.date
    }
    return (Array.isArray(friends) ? friends : []).filter((friend) => {
      const interval = catchUpInterval(friend)
      const last = lastById[friend.id]
      return interval && (!last || daysBetween(last, today) >= interval)
    }).length
  }
  return open.filter((task) => task.date === today && isReminderTask(task)).length
}

// The facts behind the morning summary (the template's text and the assistant-written note in
// api/_briefing.js both come from these). `now` is when it's sent: `time` and the prayers still ahead.
function buildSummaryFacts({ settings, friends, contactLogs = null, classes, prayerTimings = null, forecast = null }, context, workout, now) {
  const { prefs, areas, timeZone, today, open, counted } = context
  const local = localNow(now, timeZone)
  const dueToday = open.filter((task) => task.date === today && !isReminderTask(task)).sort(byTaskTime)
  const chance = forecast?.rainChance == null ? NaN : Number(forecast.rainChance)
  const goals = areas.food !== false && isObject(settings?.food?.goals) ? settings.food.goals : null
  const calories = Number(goals?.calories)
  const protein = Number(goals?.protein)
  const wantPrayers = isObject(prayerTimings) && savedLocation(settings) && (prefs.prayer || settings?.showPrayerTimes !== false)
  return {
    date: today,
    weekday: weekdayName(today),
    time: local.time,
    // What comes first from the summary's time on.
    first: firstUp(dueToday, classes, today, toMinutes(prefs.dailySummaryTime)),
    tasks: dueToday.map((task) => ({ text: String(task.text || '').trim(), time: isTime(task.time) ? task.time : '' })),
    overdue: counted.filter((task) => isDate(task.date) && task.date < today).length,
    classes: classSlotsOn(classes, today),
    workout: workout ? {
      name: gymDayName(workout.routine),
      exercises: Array.isArray(workout.routine.exercises) ? workout.routine.exercises.filter(isObject).length : 0,
      minutes: estimateMinutes(workout.routine) || null,
    } : null,
    birthdays: prefs.people ? birthdayLines(friends, today, [today, addDays(today, 1)]) : [],
    catchUps: prefs.people ? catchUpsDue(friends, contactLogs, open, today) : 0,
    rainChance: Number.isFinite(chance) ? chance : null,
    food: goals && calories > 0 ? { calories: Math.round(calories), protein: protein > 0 ? Math.round(protein) : null } : null,
    prayers: wantPrayers
      ? PRAYER_NAMES.filter((name) => isTime(prayerTimings[name]) && toMinutes(prayerTimings[name]) > local.minutes).slice(0, 3).map((name) => ({ name, time: prayerTimings[name] }))
      : [],
  }
}

// One user's morning summary facts at `now` (the same input as dueNotifications).
// → { date, weekday, time, first: { name, start, isClass } | null, tasks: [{ text, time }], overdue,
//     classes: [{ name, start }], workout: { name, exercises, minutes } | null, birthdays: [string],
//     catchUps, rainChance, food: { calories, protein } | null, prayers: [{ name, time }] }
// (start = minutes after midnight or null; time = HH:MM, `time` itself = local time at `now`.)
export function summaryFacts(input = {}, now = Date.now()) {
  const context = dayContext(input, now)
  const workout = context.areas.gym !== false ? plannedWorkout(input.settings, input.gymSessions ?? null, context.today) : null
  return buildSummaryFacts(input, context, workout, now)
}

// The templated morning summary from summaryFacts: its parts joined with ' · ', leading with what
// comes first, then the weather; kept under SUMMARY_MAX.
export function summaryBody(facts) {
  const f = isObject(facts) ? facts : {}
  const lines = []
  if (isObject(f.first)) lines.push(`First: ${firstText(f.first)}`)
  const rain = rainLine({ rainChance: f.rainChance })
  if (rain) lines.push(rain)
  const tasks = Array.isArray(f.tasks) ? f.tasks : []
  if (tasks.length) lines.push({ text: `${plural(tasks.length, 'task')}: ${taskNames(tasks)}`, short: plural(tasks.length, 'task') })
  if (f.overdue) lines.push(`${f.overdue} overdue`)
  const slots = Array.isArray(f.classes) ? f.classes : []
  const classLine = slotsLine(slots)
  // The day's only class, already named by "First:", isn't repeated.
  const onlyClassFirst = f.first?.isClass && new Set(slots.map((slot) => slot.name)).size === 1
  if (classLine && !onlyClassFirst) lines.push(classLine)
  if (isObject(f.workout)) lines.push(`Gym: ${f.workout.name}`)
  if (Array.isArray(f.birthdays)) lines.push(...f.birthdays)
  if (f.catchUps) lines.push(`${f.catchUps} catch-up${f.catchUps === 1 ? '' : 's'} due`)
  return !lines.length ? 'Nothing planned. A clear day.' : lines.length === 1 && rain ? `Nothing planned · ${rain}` : fitSummary(lines)
}

// ---- the app icon's count ---------------------------------------------------------------------

// The number to show on the app icon with a push (open tasks overdue or due today in the user's
// time zone), or null when the count is off (notifications.badge). Never sent on its own: iOS
// revokes subscriptions that get pushes without a notification.
export function appBadgeFor(settings, tasks, now = Date.now()) {
  if (notificationPrefs(settings).badge !== true) return null
  return badgeCount(tasks, localDateFor(settings, now), { people: settings?.areas?.people !== false })
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
// forecast: { rainChance } for today at the saved location (api/_weather.js), or null; only the
// morning summary uses it.
export function dueNotifications(input, now = Date.now()) {
  const { settings, tasks, friends, classes, gymSessions = null, prayerTimings = null } = input
  const context = dayContext(input, now)
  const { prefs, areas, timeZone, today, open, counted } = context
  const tomorrow = addDays(today, 1)
  const workout = areas.gym !== false && (prefs.gym || prefs.dailySummary) ? plannedWorkout(settings, gymSessions, today) : null
  const candidates = []

  // Task reminders. `kind`, `name`, `day`, `when` and `urgent` are for groupDue / combineReminders.
  for (const task of open) {
    const plan = taskReminderPlan(task, prefs, timeZone)
    if (plan.off) continue
    // Where quiet hours put it (already applied to a late one): an all-day reminder held past midnight
    // says "Due today", not the "Due tomorrow" it was planned with.
    const fireAt = outsideQuietHours(plan.fireAt, prefs, timeZone)
    const held = fireAt !== plan.fireAt || plan.held === true
    let body
    let day
    let when = ''
    if (plan.timed) {
      day = dayLabel(task.date, today)
      when = `${day === 'today' ? '' : `${day} `}at ${formatTime(task.time)}`
      body = plan.lead === 0 ? `Due now (${formatTime(task.time)})` : task.date < today ? `Was due ${day} at ${formatTime(task.time)}` : `Due ${day} at ${formatTime(task.time)}`
    } else {
      // Held past midnight from late on its own day (a late all-day time), it was due yesterday.
      const fireDate = localNow(fireAt, timeZone).date
      day = fireDate === task.date ? 'today' : fireDate < task.date ? 'tomorrow' : 'yesterday'
      body = day === 'yesterday' ? 'Was due yesterday' : `Due ${day}`
    }
    candidates.push({
      key: plan.key,
      fireAt,
      title: taskTitle(task),
      body,
      url: taskUrl(task),
      tag: `task-${task.id}`,
      kind: plan.timed ? 'timed' : 'allday',
      name: String(task.text || '').trim() || 'Task',
      urgent: task.priority === 'urgent',
      day,
      ...(plan.timed ? { when, time: task.time, now: plan.lead === 0 } : {}),
      ...(held ? { held: true } : {}),
      ...(plan.late ? { batch: LATE_ALLDAY_BATCH } : {}),
    })
  }

  // Morning summary: every day it's on, a clear day included (so it's plain the reminders work).
  // `facts` rides along for api/cron.js (the assistant-written version); groupDue and
  // combineReminders ignore it.
  if (prefs.dailySummary && isTime(prefs.dailySummaryTime)) {
    const facts = buildSummaryFacts(input, context, workout, now)
    candidates.push({
      key: `summary:${today}`,
      fireAt: zonedToUtc(today, prefs.dailySummaryTime, timeZone),
      title: `Your ${weekdayName(today)}`,
      body: summaryBody(facts),
      url: '/#/today',
      tag: 'daily-summary',
      kind: 'summary',
      facts,
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
    if (todays.length && !stillOpen.length) parts.push(`All ${todays.length} done today`)
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
      // Always Today: it offers "Move to tomorrow" for what's left (and the mood) in the evening.
      title: 'Evening check-in',
      body: parts.join(' · '),
      url: '/#/today',
      tag: 'evening-nudge',
      kind: 'evening',
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
    for (const [index, name] of PRAYER_NAMES.entries()) {
      if (!wanted.includes(name) || !isTime(prayerTimings[name])) continue
      const at = zonedToUtc(today, prayerTimings[name], timeZone)
      // The next of the day's five (wanted or not), so the banner also says what comes after.
      const next = PRAYER_NAMES.slice(index + 1).find((other) => isTime(prayerTimings[other]) && prayerTimings[other] > prayerTimings[name])
      candidates.push({
        key: `prayer:${today}:${name}`,
        fireAt: at - lead * 60000,
        title: lead ? `${name} in ${lead} min` : `Time for ${name}`,
        body: `${name} at ${formatTime(prayerTimings[name])}${next ? ` · Then ${next} at ${formatTime(prayerTimings[next])}` : ''}`,
        url: '/#/today',
        tag: `prayer-${name}`,
        kind: 'prayer',
        noQuiet: true,
      })
    }
  }

  // Quiet hours move a reminder to the moment they end; the ones moved there are sent together
  // (groupDue), marked `held` ('overnight' when quiet hours span midnight).
  const overnight = toMinutes(prefs.quietStart) > toMinutes(prefs.quietEnd)
  const scheduled = candidates.map((item) => {
    if (item.noQuiet) return item
    const fireAt = outsideQuietHours(item.fireAt, prefs, timeZone)
    const held = item.held || fireAt !== item.fireAt
    return { ...item, fireAt, ...(held ? { held: overnight ? 'overnight' : 'quiet' } : {}) }
  })
  // A late all-day reminder for a task added under a minute ago holds back the due ones for a little
  // while, so tasks added together are reminded together (api/cron.js sends a batch as one).
  const waiting = scheduled.some((item) => item.batch && item.fireAt > now && item.fireAt - now <= LATE_ALLDAY_DELAY_MS)
  return scheduled
    .filter((item) => item.fireAt <= now && now - item.fireAt <= SEND_WINDOW_MS)
    .filter((item) => !(waiting && item.batch && now - item.fireAt < LATE_ALLDAY_HOLD_MS))
    .sort((a, b) => a.fireAt - b.fireAt)
}

// ---- one notification for reminders due together --------------------------------------------
//
// Everything a cron run finds due for one user counts as one moment. groupDue decides what shares a
// banner (api/cron.js claims every item's key in notification_log on its own, so nothing is sent
// twice, then sends each group's newly claimed items as one push via combineReminders):
//   * one push for the run's all-day task reminders (on the day, the day before, or the late ping for
//     a task just added) together with everything quiet hours held back (tasks and the workout
//     reminder): '4 tasks due today' / '3 reminders held overnight';
//   * a timed task at its reminder time keeps its own banner, apart from the all-day ones (it is about
//     that moment); timed tasks due in the same run share one: '2 tasks at 3:00 PM' (runs are a minute
//     apart, so that is the same minute unless a run was late: then '2 tasks coming up', with times);
//   * on their own: the morning summary and evening check-in (digests already), prayer reminders
//     (time-critical, never held) and the workout reminder at its time.
// A group with one item is sent exactly as that item (tapping it still opens that task).

// The group an item of dueNotifications belongs to, or null for its own notification.
function groupKey(item) {
  if (!isObject(item) || item.noQuiet || item.facts || ['summary', 'evening', 'prayer'].includes(item.kind)) return null
  if (item.held && ['timed', 'allday', 'gym'].includes(item.kind)) return 'together'
  if (item.kind === 'allday') return 'together'
  if (item.kind === 'timed') return 'timed'
  if (item.batch) return `batch:${item.batch}` // an item from before `kind` existed
  return null
}

// dueNotifications' list → groups (arrays), each sent as one notification by api/cron.js, in the
// order their first item came.
export function groupDue(due) {
  const groups = []
  const byKey = new Map()
  for (const item of Array.isArray(due) ? due : []) {
    const key = groupKey(item)
    if (key === null) {
      groups.push([item])
    } else if (byKey.has(key)) {
      byKey.get(key).push(item)
    } else {
      const group = [item]
      byKey.set(key, group)
      groups.push(group)
    }
  }
  return groups
}

const BODY_NAME_MAX = 40

// One line in a combined body: 'Urgent: Pay rent', 'Dentist (3:00 PM)', 'Push day workout'.
function reminderName(item, withTime) {
  const raw = String(item.name || item.title || '').trim()
  const name = raw.length > BODY_NAME_MAX ? `${cutText(raw, BODY_NAME_MAX - 2)}…` : raw
  const time = withTime && item.kind === 'timed' && isTime(item.time) ? ` (${formatTime(item.time)})` : ''
  return `${item.urgent && item.name ? 'Urgent: ' : ''}${name}${time}`
}

// One notification for reminders sent together (see groupDue). A single item is sent as it is.
// → { title, body (≤ SUMMARY_MAX), url, tag }
export function combineReminders(items) {
  const list = (Array.isArray(items) ? items : []).filter(isObject)
  if (list.length <= 1) {
    const item = list[0] || {}
    return { title: item.title, body: item.body, url: item.url, tag: item.tag }
  }
  // Urgent ones first, then what quiet hours held (it's late already); otherwise in the order they
  // came (oldest reminder first).
  const ordered = [...list.filter((item) => item.urgent), ...list.filter((item) => !item.urgent && item.held), ...list.filter((item) => !item.urgent && !item.held)]
  const count = list.length
  const heldCount = list.filter((item) => item.held).length
  const allDay = list.every((item) => item.kind === 'allday' || (!item.kind && /^Due (today|tomorrow)$/.test(String(item.body))))
  const timed = list.every((item) => item.kind === 'timed')
  const whens = new Set(list.map((item) => (item.now ? 'now' : item.when)))
  // Held ones aren't at their moment any more, so they always say their own times.
  const sameMoment = timed && whens.size === 1 && !whens.has(undefined) && !list.some((item) => item.held)

  let title
  if (allDay) {
    const dayOf = (item) => item.day || /^Due (today|tomorrow)$/.exec(String(item.body))?.[1]
    const today = list.filter((item) => dayOf(item) === 'today').length
    const tomorrow = list.filter((item) => dayOf(item) === 'tomorrow').length
    if (today === count) title = `${count} tasks due today`
    else if (tomorrow === count) title = `${count} tasks due tomorrow`
    else if (today + tomorrow === count) title = `${count} tasks due: ${today} today, ${tomorrow} tomorrow`
    else title = `${count} tasks coming up`
  } else if (heldCount) {
    // Only what quiet hours held is "held": all-day ones due now just share the banner.
    const heldText = list.some((item) => item.held === 'overnight') ? 'held overnight' : 'from quiet hours'
    title = heldCount === count ? `${count} reminders ${heldText}` : `${count} reminders, ${heldCount} ${heldText}`
  } else if (sameMoment) {
    title = whens.has('now') ? `${count} tasks due now` : `${count} tasks ${[...whens][0]}`
  } else if (timed) {
    title = `${count} tasks coming up`
  } else {
    title = `${count} reminders`
  }

  const names = ordered.map((item) => reminderName(item, !sameMoment))
  const shown = names.slice(0, 3).join(', ')
  const body = `${shown}${count > 3 ? ` and ${count - 3} more` : ''}`

  // Today lists today's tasks and the workout; anything else opens the task list.
  const urls = new Set(list.map((item) => item.url))
  const url = urls.size === 1 && [...urls][0] ? [...urls][0]
    : list.every((item) => (item.day || /^Due (today)$/.exec(String(item.body))?.[1]) === 'today') ? '/#/today' : '/#/tasks'
  const minute = Math.floor(Number(list[0].fireAt) / 60000)
  return {
    title,
    body: body.length > SUMMARY_MAX ? `${cutText(body, SUMMARY_MAX - 1)}…` : body,
    url,
    tag: Number.isFinite(minute) ? `reminders-${minute}` : 'reminders',
  }
}

// Shared by api/cron.js (scheduled reminders) and api/push.js (test notifications).
// Files starting with "_" are not deployed as their own serverless functions.
import webpush from 'web-push'

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
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '07:00',
}

const SEND_WINDOW_MS = 45 * 60 * 1000 // late cron runs still deliver, but stale reminders are dropped

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
export async function sendToUser(supabase, userId, payload) {
  configure()
  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('vapid_public', process.env.VAPID_PUBLIC_KEY)
  if (error) throw error
  let sent = 0
  await Promise.all((subscriptions || []).map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: 'high' },
      )
      sent += 1
      await supabase.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).eq('id', subscription.id)
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', subscription.id)
      } else {
        console.error('Push failed:', err.statusCode, err.body || err.message)
      }
    }
  }))
  return sent
}

// ---- time zones ---------------------------------------------------------------------------

function zoneParts(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]))
  return parts
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

// ---- what is due ----------------------------------------------------------------------------

// Every notification that should fire around `now` for one user, oldest first.
export function dueNotifications({ settings, tasks, friends, contactLogs, classes }, now = Date.now()) {
  const prefs = notificationPrefs(settings)
  const timeZone = settings?.timeZone || 'UTC'
  const today = localNow(now, timeZone).date
  const tomorrow = addDays(today, 1)
  const open = tasks.filter((task) => !task.done && !task.archived)
  const candidates = []

  // Task reminders
  for (const task of open) {
    if (!isDate(task.date)) continue
    if (isReminderTask(task) && !prefs.people) continue
    const override = Number.isInteger(task.reminder_minutes) ? task.reminder_minutes : null
    if (override === -1) continue

    if (isTime(task.time)) {
      const lead = override ?? Number(prefs.taskLead)
      if (!Number.isFinite(lead) || lead < 0) continue
      const due = zonedToUtc(task.date, task.time, timeZone)
      const when = `${dayLabel(task.date, today)} at ${formatTime(task.time)}`
      candidates.push({
        key: `task:${task.id}:${task.date}T${task.time}:${lead}`,
        fireAt: due - lead * 60000,
        title: task.priority === 'urgent' ? `Urgent: ${task.text}` : task.text,
        body: lead === 0 ? `Due now (${formatTime(task.time)})` : task.date < today ? `Was due ${when}` : `Due ${when}`,
        url: '/#/tasks',
        tag: `task-${task.id}`,
      })
    } else {
      let mode = override === null ? (prefs.allDayTime ? (prefs.allDayMode === 'before' ? 1440 : 0) : -1) : override
      if (mode < 0) continue
      const time = isTime(prefs.allDayTime) ? prefs.allDayTime : '09:00'
      const dayBefore = mode >= 1440
      const date = dayBefore ? addDays(task.date, -1) : task.date
      candidates.push({
        key: `task:${task.id}:${task.date}:allday:${dayBefore ? 'before' : 'day'}`,
        fireAt: zonedToUtc(date, time, timeZone),
        title: task.priority === 'urgent' ? `Urgent: ${task.text}` : task.text,
        body: dayBefore ? 'Due tomorrow' : 'Due today',
        url: '/#/tasks',
        tag: `task-${task.id}`,
      })
    }
  }

  // Morning summary
  if (prefs.dailySummary && isTime(prefs.dailySummaryTime)) {
    const dueToday = open.filter((task) => task.date === today && !isReminderTask(task))
    const overdue = open.filter((task) => isDate(task.date) && task.date < today)
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${today}T12:00:00Z`).getUTCDay()]
    const classCount = classes.filter((item) => (!item.end_date || item.end_date >= today) && (item.days || []).some((day) => (typeof day === 'string' ? day : day?.day) === weekday)).length
    const lines = []
    if (dueToday.length) lines.push(`${dueToday.length} due today: ${dueToday.slice(0, 3).map((task) => task.text).join(', ')}${dueToday.length > 3 ? '…' : ''}`)
    if (overdue.length) lines.push(`${overdue.length} overdue`)
    if (classCount) lines.push(`${classCount} class${classCount === 1 ? '' : 'es'}`)
    if (prefs.people) {
      const birthdays = friends.filter((friend) => isDate(friend.birthday) && (friend.birthday.slice(5) === today.slice(5) || friend.birthday.slice(5) === tomorrow.slice(5)))
      for (const friend of birthdays) lines.push(`🎂 ${friend.name}’s birthday ${friend.birthday.slice(5) === today.slice(5) ? 'today' : 'tomorrow'}`)
      const catchUps = open.filter((task) => task.date === today && isReminderTask(task))
      if (catchUps.length) lines.push(`${catchUps.length} catch-up${catchUps.length === 1 ? '' : 's'} due`)
    }
    if (lines.length) {
      candidates.push({ key: `summary:${today}`, fireAt: zonedToUtc(today, prefs.dailySummaryTime, timeZone), title: 'Your day', body: lines.join(' · '), url: '/#/today', tag: 'daily-summary' })
    }
  }

  // Evening nudge for anything still open
  if (prefs.overdue && isTime(prefs.overdueTime)) {
    const overdue = open.filter((task) => isDate(task.date) && task.date < today)
    const stillOpen = open.filter((task) => task.date === today && !isReminderTask(task))
    if (overdue.length || stillOpen.length) {
      const parts = []
      if (stillOpen.length) parts.push(`${stillOpen.length} still open today`)
      if (overdue.length) parts.push(`${overdue.length} overdue`)
      const names = [...stillOpen, ...overdue].slice(0, 3).map((task) => task.text).join(', ')
      candidates.push({ key: `overdue:${today}`, fireAt: zonedToUtc(today, prefs.overdueTime, timeZone), title: 'Before the day ends', body: `${parts.join(' · ')}: ${names}`, url: '/#/tasks', tag: 'evening-nudge' })
    }
  }

  return candidates
    .map((item) => ({ ...item, fireAt: outsideQuietHours(item.fireAt, prefs, timeZone) }))
    .filter((item) => item.fireAt <= now && now - item.fireAt <= SEND_WINDOW_MS)
    .sort((a, b) => a.fireAt - b.fireAt)
}

// What the rest of today looks like, for the Today card: the "Now / Next" line and the evening's
// leftovers, plus the app icon's count. Pure (no store, no clock): the caller passes today's tasks,
// class slots and the time.
// Keep browser-free: imported by api/ (api/_reminders.js sends the icon count with every push).
import { timeRangeMinutes, timeToMinutes } from './dates.js'

// "Next" covers what starts within this many minutes; anything later reads "Free until …".
export const NEXT_WINDOW = 180
// A timed task is a moment rather than a stretch: it counts as 15 minutes.
const TASK_MINUTES = 15
// A class with only a start time lasts an hour (the same rule as planner.js classOver).
const CLASS_MINUTES = 60

// Today's timed items as [{ start, end, title, ref }], skipping done tasks and unreadable times.
// classSlots: classesOn(today) entries ({ id, name, time }).
function items(tasks = [], classSlots = []) {
  const list = []
  for (const slot of classSlots) {
    const { start, end } = timeRangeMinutes(slot?.time)
    if (start === null) continue
    list.push({ start, end: end !== null && end > start ? end : start + CLASS_MINUTES, title: slot.name || 'Class', ref: { type: 'class', id: slot.id } })
  }
  for (const task of tasks) {
    if (!task || task.done || task.archived || !task.time) continue
    const start = timeToMinutes(task.time)
    if (start === null) continue
    list.push({ start, end: start + TASK_MINUTES, title: task.text || 'Task', ref: { type: 'task', id: task.id } })
  }
  return list.sort((a, b) => a.start - b.start || a.end - b.end)
}

// The line at the top of the Today card, or null when nothing timed is left today:
//   { kind: 'now', … }  a class is on (end = when it finishes)
//   { kind: 'next', … } the next thing starts within NEXT_WINDOW minutes
//   { kind: 'free', … } it starts later than that ("Free until 4 PM · then Dentist")
// Each also has { title, start, end, minutesUntil, ref: { type: 'task'|'class', id } }, with
// start/end in minutes after midnight. A timed task whose time has passed is not "now": it is
// shown as passed on its own row instead.
export function nowNext({ tasks = [], classSlots = [], nowMinutes = 0 } = {}) {
  const list = items(tasks, classSlots)
  const current = list.find((item) => item.ref.type === 'class' && item.start <= nowMinutes && nowMinutes < item.end)
  if (current) return { kind: 'now', title: current.title, start: current.start, end: current.end, minutesUntil: 0, ref: current.ref }
  const next = list.find((item) => item.start >= nowMinutes)
  if (!next) return null
  const minutesUntil = next.start - nowMinutes
  return { kind: minutesUntil <= NEXT_WINDOW ? 'next' : 'free', title: next.title, start: next.start, end: next.end, minutesUntil, ref: next.ref }
}

// After the evening check-in: today's open tasks that are still "left", i.e. untimed or with a
// time that has passed. A 9 PM task that is still ahead stays put.
export function eveningLeftovers(tasks = [], today = '', nowHHMM = '00:00') {
  const now = timeToMinutes(nowHHMM) ?? 0
  return tasks.filter((task) => {
    if (!task || task.done || task.archived || task.date !== today) return false
    const start = task.time ? timeToMinutes(task.time) : null
    return start === null || start < now
  })
}

// Whether a timed task's time has passed today (its row shows the time greyed).
export function timePassed(task, today, nowMinutes) {
  if (!task || task.done || task.date !== today || !task.time) return false
  const start = timeToMinutes(task.time)
  return start !== null && start < nowMinutes
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const BADGE_MAX = 9999

// The number on the app icon: open tasks that are overdue or due today (the set Today shows).
// people: false leaves out catch-up reminder tasks ("Talk to…", details "friend-reminder:…").
// Anything that isn't a list counts 0; rows that aren't tasks, or have no proper date, are skipped.
export function badgeCount(tasks, today, { people = true } = {}) {
  if (!Array.isArray(tasks) || typeof today !== 'string') return 0
  let count = 0
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || task.done || task.archived) continue
    if (typeof task.date !== 'string' || !ISO_DATE.test(task.date) || task.date > today) continue
    if (people === false && typeof task.details === 'string' && task.details.startsWith('friend-reminder:')) continue
    count += 1
  }
  return Math.min(BADGE_MAX, count)
}

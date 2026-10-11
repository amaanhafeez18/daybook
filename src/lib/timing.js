// Times that fit your day: the task sheet's time chips learned from the times you actually use,
// and what's already busy on a day (classes and timed tasks) so a chip or "This evening" can
// avoid it. Pure (no store, no clock): the caller passes the lists and today.
import { addDaysISO, timeRangeMinutes, timeToMinutes } from './dates.js'

export const DEFAULT_TIMES = ['09:00', '12:00', '15:00', '18:00']
// A timed task keeps this many minutes busy around its time.
const TASK_MINUTES = 30
// A class with only a start time lasts an hour (planner.js classOver).
const CLASS_MINUTES = 60

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const isReminder = (task) => typeof task?.details === 'string' && task.details.startsWith('friend-reminder:')

// The times you use, as up to `limit` "HH:MM" chips in clock order. Counts task.time on tasks
// dated from `days` ago onwards (friend reminders are the app's, not yours), rounded to the
// nearest :00 or :30; a slot used `minUses` times or more is kept. The rest is topped up from
// DEFAULT_TIMES, skipping any within an hour of a learned one.
export function usualTimes(tasks = [], today = '', { days = 90, minUses = 3, limit = 4 } = {}) {
  const since = today ? addDaysISO(today, -days) : ''
  const counts = new Map()
  for (const task of tasks) {
    if (!task?.date || !task.time || isReminder(task) || (since && task.date < since)) continue
    const minutes = timeToMinutes(task.time)
    if (minutes === null) continue
    const slot = Math.min(23 * 60 + 30, Math.round(minutes / 30) * 30)
    counts.set(slot, (counts.get(slot) || 0) + 1)
  }
  const learned = [...counts]
    .filter(([, count]) => count >= minUses)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([slot]) => slot)
  const picked = [...learned]
  for (const time of DEFAULT_TIMES) {
    if (picked.length >= limit) break
    const minutes = timeToMinutes(time)
    if (learned.some((slot) => Math.abs(slot - minutes) <= 60)) continue
    picked.push(minutes)
  }
  return picked.sort((a, b) => a - b).map(hhmm)
}

// What's busy on `date`: [{ start, end, label, kind: 'class'|'task' }] (minutes after midnight),
// soonest first. classSlots: classesOn(date) entries; tasks: any list (only that day's open timed
// tasks count, and exceptId, the task being edited, never does). Unreadable times are skipped.
export function busySlots(classSlots = [], tasks = [], date = '', exceptId = null) {
  const busy = []
  for (const slot of classSlots) {
    const { start, end } = timeRangeMinutes(slot?.time)
    if (start === null) continue
    busy.push({ start, end: end !== null && end > start ? end : start + CLASS_MINUTES, label: slot.name || 'a class', kind: 'class' })
  }
  for (const task of tasks) {
    if (!task || task.date !== date || !task.time || task.done || task.archived || task.id === exceptId) continue
    const start = timeToMinutes(task.time)
    if (start === null) continue
    busy.push({ start, end: start + TASK_MINUTES, label: task.text || 'a task', kind: 'task' })
  }
  return busy.sort((a, b) => a.start - b.start)
}

// The busy slot an "HH:MM" falls in, or null.
export function clashSlot(time, busy = []) {
  const minutes = timeToMinutes(time)
  if (minutes === null) return null
  return busy.find((slot) => slot.start <= minutes && minutes < slot.end) || null
}

// What an "HH:MM" clashes with ("Economics", "Dentist"), or null.
export function clashAt(time, busy = []) {
  return clashSlot(time, busy)?.label ?? null
}

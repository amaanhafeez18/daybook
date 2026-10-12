// Times that fit your day: the task sheet's time chips learned from the times you actually use,
// and what's already busy on a day (classes and timed tasks) so a chip or "This evening" can
// avoid it. Pure (no store, no clock): the caller passes the lists and today.
import { WEEKDAY_SHORT, addDaysISO, isISODate, timeRangeMinutes, timeToMinutes, weekdayIndex } from './dates.js'

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

// ---- clashes and free time (also used by api/assistant.js: keep this file browser-free) -----------
// Times in and out are "HH:MM" strings; a busy list can also hold minutes (busySlots above).

const EVENT_MINUTES = 30
const DAY_END = 24 * 60
const toMinutes = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : timeToMinutes(value))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (minutes) => hhmm(Math.min(DAY_END - 1, minutes))

// ---- naming a class in a title ("ECON 101 midterm", "CS1026 quiz", "Econ essay") ----------------
// Also used by radar.js. No regex lookbehind (Safari before 16.4 can't parse one).

// Words in class names that don't single a class out.
const CLASS_GENERIC = new Set(['intro', 'introduction', 'principles', 'advanced', 'fundamentals', 'topics', 'seminar', 'lecture', 'lectures', 'studies', 'general', 'course', 'class', 'basic', 'basics', 'applied', 'theory', 'special', 'selected', 'section', 'tutorial', 'workshop', 'english', 'online', 'honors', 'honours', 'room', 'group', 'level', 'part', 'unit', 'year', 'grade', 'module'])
// A course code: 2–10 letters, then 2–4 digits and maybe a section letter ("ECON 101", "COMPSCI 1026A").
const CLASS_CODE = /(?:^|[^\p{L}\p{N}])(\p{L}{2,10})\s*-?\s*(\d{2,4})(\p{L}?)(?![\p{L}\p{N}])/gu
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cleanText = (text) => String(text || '').replace(/\s+/g, ' ').trim()
const EDGE = '(?:^|[^\\p{L}\\p{N}])'
const AFTER = '(?![\\p{L}\\p{N}])'
// `text` as a whole word (any case; spaces match any run of spaces).
export const wordPattern = (text) => new RegExp(`${EDGE}${escapeRe(String(text)).replace(/\s+/g, '\\s+')}${AFTER}`, 'iu')

const NAME_STOP = new Set(['of', 'and', 'the', 'to', 'in', 'for', 'a', 'an', 'on', 'with'])

// The course code in a class name → { letters, raw, number, suffix, initials, short } or null.
// initials: of a spelled-out subject ("Computer Science 201" → "cs"); short: whether the letters
// read as an abbreviation ("ECON", "COMPSCI") rather than an everyday word ("Science").
function classCode(name) {
  for (const match of name.matchAll(CLASS_CODE)) {
    const letters = match[1].toLowerCase()
    if (CLASS_GENERIC.has(letters)) continue
    const before = name.slice(0, match.index + match[0].indexOf(match[1]))
    const words = `${before} ${match[1]}`.split(/[^\p{L}]+/u).filter((part) => part && !NAME_STOP.has(part.toLowerCase()))
    const initials = words.length >= 2 && words.length <= 5 ? words.map((part) => part[0]).join('').toLowerCase() : ''
    const short = letters.length <= 5 || match[1] === match[1].toUpperCase()
    return { letters, raw: match[1], number: match[2], suffix: match[3], initials, short }
  }
  return null
}

// How to recognise each class in a title → [{ id, name, patterns: [{ how, re }] }], strongest
// pattern first: its full name ('name'); its code with or without the space or section letter
// ('code': "ECON 101", "econ101", "COMPSCI 1026"); the number after any short form of the
// subject ('code': "CS1026", "Econ 101", when no other class has that number under that letter);
// the code's letters ('letters': "ECON", when no other class shares them); and its distinctive
// name words ('word': "Economics" in "Principles of Economics", when no other class has them).
// Classes whose term ended before `today` are left out.
export function classMatchers(classes = [], today = '') {
  const list = (Array.isArray(classes) ? classes : []).filter((item) => item && typeof item.name === 'string' && item.name.trim()
    && !((item.endDate || item.end_date) && today && (item.endDate || item.end_date) < today))
  const counts = new Map()
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1)
  const info = list.map((item) => {
    const name = cleanText(item.name)
    const code = classCode(name)
    if (code) {
      if (code.letters.length >= 3) bump(`l:${code.letters}`)
      bump(`n:${code.letters[0]}${code.number}`)
      if (code.initials) bump(`i:${code.initials}${code.number}`)
    }
    const nameWords = [...new Set(name.toLowerCase().split(/[^\p{L}]+/u).filter((part) => part.length >= 5 && !CLASS_GENERIC.has(part)))]
    for (const part of nameWords) bump(`w:${part}`)
    return { item, name, code, nameWords }
  })
  return info.map(({ item, name, code, nameWords }) => {
    const patterns = [{ how: 'name', re: wordPattern(name) }]
    if (code) {
      patterns.push({ how: 'code', re: new RegExp(`${EDGE}${escapeRe(code.raw)}\\s*-?\\s*${code.number}(?:${escapeRe(code.suffix)})?${AFTER}`, 'iu') })
      if (counts.get(`n:${code.letters[0]}${code.number}`) === 1) {
        patterns.push({ how: 'code', re: new RegExp(`${EDGE}${escapeRe(code.letters[0])}\\p{L}{0,9}\\s*-?\\s*${code.number}\\p{L}?${AFTER}`, 'iu') })
      }
      if (code.initials && counts.get(`i:${code.initials}${code.number}`) === 1) {
        patterns.push({ how: 'code', re: new RegExp(`${EDGE}${escapeRe(code.initials)}\\s*-?\\s*${code.number}\\p{L}?${AFTER}`, 'iu') })
      }
      // An everyday word ("Science" in "Computer Science 201") is only a word of the name.
      if (code.letters.length >= 3 && counts.get(`l:${code.letters}`) === 1) patterns.push({ how: code.short ? 'letters' : 'word', re: wordPattern(code.letters) })
    }
    for (const part of nameWords) if (counts.get(`w:${part}`) === 1 && part !== code?.letters) patterns.push({ how: 'word', re: wordPattern(part) })
    return { id: item.id, name, patterns }
  })
}

// The class a title names → { id, name, how } (how it matched, strongest kind across classes;
// the first class on a tie), or null.
const HOW_RANK = { name: 0, code: 1, letters: 2, word: 3 }
export function classIn(text, matchers = []) {
  const value = cleanText(text)
  if (!value) return null
  let best = null
  for (const matcher of Array.isArray(matchers) ? matchers : []) {
    const hit = matcher?.patterns?.find((pattern) => pattern.re.test(value))
    if (hit && (!best || HOW_RANK[hit.how] < HOW_RANK[best.how])) best = { id: matcher.id, name: matcher.name, how: hit.how }
  }
  return best
}

// Whether `title` names the class called `className` ("ECON 101 midterm" names "ECON 101"): then
// something at that class's time is part of the class, not a clash with it.
const singleMatchers = new Map()
export function namesClass(title, className) {
  const name = cleanText(className)
  if (!name || !cleanText(title)) return false
  if (!singleMatchers.has(name)) {
    if (singleMatchers.size > 200) singleMatchers.clear()
    singleMatchers.set(name, classMatchers([{ id: name, name }]))
  }
  return !!classIn(title, singleMatchers.get(name))
}

// The class slots on `date` from the class records (the app's camelCase or the database's
// snake_case: days ["Mon"] + dayDetails/day_details, or [{ day, time }]; endDate/end_date ends the
// term) → [{ title, start, end }] by start time. A start-only time lasts an hour; unreadable
// times ("TBA") are left out.
export function classSlotsFor(classes = [], date = '') {
  if (!isISODate(date)) return []
  const weekday = WEEKDAY_SHORT[weekdayIndex(date)]
  const slots = []
  for (const item of Array.isArray(classes) ? classes : []) {
    if (!isObject(item)) continue
    const endDate = item.endDate || item.end_date
    if (endDate && date > endDate) continue
    const details = isObject(item.dayDetails) ? item.dayDetails : isObject(item.day_details) ? item.day_details : {}
    for (const day of Array.isArray(item.days) ? item.days : []) {
      const name = typeof day === 'string' ? day : day?.day
      if (name !== weekday) continue
      const time = typeof day === 'string' ? details[day]?.time || item.time || '' : day?.time || ''
      const { start, end } = timeRangeMinutes(time)
      if (start === null) continue
      slots.push({ title: String(item.name || 'Class'), start: hhmm(start), end: clip(end !== null && end > start ? end : start + CLASS_MINUTES) })
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start))
}

// Everything busy on `date` → [{ kind: 'class'|'event'|'task', title, start, end }] by start.
// Tasks: that day's open timed tasks (30 min each). Events: that day's timed events (30 min, or
// their range), except those linked to a task in `tasks` (the task stands for them) and those of
// the item being edited (exceptId: a task's or an event's id). `title`: the item's own title; a
// class it names ("ECON 101 midterm" in ECON 101) is where it happens, so that class isn't busy.
// Something running past midnight (end before start) is busy to the end of the day.
export function busyOn({ date, classSlots = [], events = [], tasks = [], exceptId = null, title = '' } = {}) {
  const busy = []
  const untilEnd = (start, end, fallback) => (end === null ? start + fallback : end > start ? end : end < start ? DAY_END : start + fallback)
  for (const slot of classSlots) {
    const start = toMinutes(slot?.start)
    if (start === null) continue
    const name = slot.title || slot.name || 'Class'
    if (title && namesClass(title, name)) continue
    busy.push({ kind: 'class', title: name, start, end: untilEnd(start, toMinutes(slot?.end), CLASS_MINUTES) })
  }
  const taskIds = new Set()
  for (const task of tasks) {
    if (!task) continue
    taskIds.add(task.id)
    if (task.date !== date || !task.time || task.done || task.archived || (exceptId && task.id === exceptId)) continue
    const start = timeToMinutes(task.time)
    if (start === null) continue
    busy.push({ kind: 'task', title: task.text || 'Task', start, end: start + TASK_MINUTES })
  }
  for (const event of events) {
    if (!event || event.date !== date || !event.time) continue
    const linked = event.taskId || event.task_id
    if (exceptId && (event.id === exceptId || linked === exceptId)) continue
    if (linked && taskIds.has(linked)) continue
    const { start, end } = timeRangeMinutes(event.time)
    if (start === null) continue
    busy.push({ kind: 'event', title: event.title || 'Event', start, end: untilEnd(start, end, EVENT_MINUTES) })
  }
  return busy
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ kind, title, start, end }) => ({ kind, title, start: hhmm(start), end: clip(end) }))
}

// What something at `time` on `date` lasting `minutes` overlaps → [{ kind, title, start, end }].
// Touching ends don't count: a task at 4:30 doesn't clash with a class that ends at 4:30. `title`:
// the item's own title, so "ECON 101 quiz" in ECON 101's slot doesn't clash with ECON 101.
export function clashesAt({ date, time, minutes = 30, classSlots = [], events = [], tasks = [], exceptId = null, title = '' } = {}) {
  const from = timeToMinutes(time)
  if (from === null || !date) return []
  const to = from + Math.max(1, Number(minutes) || 30)
  return busyOn({ date, classSlots, events, tasks, exceptId, title })
    .filter((slot) => timeToMinutes(slot.start) < to && from < timeToMinutes(slot.end))
}

// The clash a task row names: for each open timed task dated `from` or later (up to `to`, if
// given), the first thing it overlaps, a class before an event before another task →
// { [taskId]: { kind, title, start, end } }. Tasks without a clash are left out.
export function taskClashes({ tasks = [], events = [], classes = [], from = '', to = '' } = {}) {
  const byDate = new Map()
  for (const task of tasks) {
    if (!task || !task.date || !task.time || task.done || task.archived) continue
    if ((from && task.date < from) || (to && task.date > to)) continue
    if (!byDate.has(task.date)) byDate.set(task.date, [])
    byDate.get(task.date).push(task)
  }
  if (!byDate.size) return {}
  const allIds = new Set(tasks.map((task) => task?.id))
  const rank = { class: 0, event: 1, task: 2 }
  const out = {}
  for (const [date, list] of byDate) {
    const classSlots = classSlotsFor(classes, date)
    // A task's own event stands for it (and is hidden); other events linked to a task are too.
    const dayEvents = events.filter((event) => event?.date === date && !allIds.has(event.taskId || event.task_id))
    const dayTasks = tasks.filter((task) => task?.date === date)
    for (const task of list) {
      const clashes = clashesAt({ date, time: task.time, classSlots, events: dayEvents, tasks: dayTasks, exceptId: task.id, title: task.text })
      if (clashes.length) out[task.id] = clashes.sort((a, b) => rank[a.kind] - rank[b.kind] || a.start.localeCompare(b.start))[0]
    }
  }
  return out
}

// Busy stretches in minutes, merged and clipped to [from, to).
function mergedBusy(busy = [], from = 0, to = DAY_END) {
  const spans = []
  for (const slot of busy) {
    const start = toMinutes(slot?.start)
    if (start === null) continue
    const rawEnd = toMinutes(slot?.end)
    const end = rawEnd !== null && rawEnd > start ? rawEnd : start + TASK_MINUTES
    if (end <= from || start >= to) continue
    spans.push([Math.max(from, start), Math.min(to, end)])
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  return merged
}

// The free stretches between `from` and `to` on a day with `busy` ([{ start, end }], "HH:MM" or
// minutes) that last at least minMinutes → [{ start, end }] ("HH:MM"). `date` is accepted for
// symmetry; busy already belongs to that day.
export function freeSlots({ busy = [], from = '08:00', to = '22:00', minMinutes = 30 } = {}) {
  const start = toMinutes(from) ?? 0
  const end = toMinutes(to) ?? DAY_END
  if (end <= start) return []
  const free = []
  let cursor = start
  for (const [busyStart, busyEnd] of mergedBusy(busy, start, end)) {
    if (busyStart - cursor >= minMinutes) free.push({ start: hhmm(cursor), end: hhmm(busyStart) })
    cursor = Math.max(cursor, busyEnd)
  }
  if (end - cursor >= minMinutes) free.push({ start: hhmm(cursor), end: clip(end) })
  return free
}

// The first start at or after `time` where `minutes` fit without overlapping `busy` → "HH:MM", or
// null. `time` itself when it's free (whatever `to` says); otherwise the end of what's in the way,
// rounded up to 5 minutes, as long as it finishes by `to`.
export function nextFreeStart({ time, minutes = 30, busy = [], to = '22:00' } = {}) {
  let start = timeToMinutes(time)
  if (start === null) return null
  const length = Math.max(1, Number(minutes) || 30)
  const limit = toMinutes(to) ?? DAY_END
  const spans = mergedBusy(busy, 0, DAY_END)
  for (let step = 0; step <= spans.length; step += 1) {
    const blocking = spans.filter(([busyStart, busyEnd]) => busyStart < start + length && start < busyEnd)
    if (!blocking.length) return hhmm(start)
    start = Math.ceil(Math.max(...blocking.map(([, busyEnd]) => busyEnd)) / 5) * 5
    if (start + length > limit) return null
  }
  return null
}

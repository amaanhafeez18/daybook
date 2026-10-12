// Deadline radar: exams and deadlines in the next week, found in your own tasks and events, and two
// study blocks on your freest evenings before one when nothing is planned for it yet. Pure (no
// store, no clock, no React): the caller passes the lists, today and the time. Browser-free.
//
// A task or event counts when its title has an exam word ("exam", "midterm", "assignment",
// "essay"…), or a looser word ("quiz", "test", "final", "project", "report", "presentation", "due",
// "deadline"…) together with one of your classes ("ECON 101", "Econ", "Economics"). Everyday
// uses are left out: "blood test", "test drive", "eye exam", "pub quiz", and prep tasks themselves
// ("Study for…").
import { WEEKDAY_SHORT, addDaysISO, diffDays, isISODate, timeToMinutes, weekdayIndex } from './dates.js'
import { busyOn, classIn, classMatchers, classSlotsFor, freeSlots, wordPattern as word } from './timing.js'

export { classIn, classMatchers }

export const RADAR_DAYS = 7
export const RADAR_DISMISSED_MAX = 50

// Enough on their own. Exams ("exam", "midterm") get "Study for"; the rest "Work on".
const STRONG = /\b(?:exams?|midterms?|mid-terms?|assignments?|essays?|coursework|homework|problem sets?|psets?|term papers?)\b/i
// A thesis is worked on for months: it counts only when something about it is due.
const THESIS = /\b(?:thesis|dissertation)\b/i
const THESIS_DUE = /\b(?:due|deadline|submit|submission|defen[cs]e|hand\s*in)\b/i
// Only with a class named too.
const WEAK = /\b(?:finals?|quiz(?:zes)?|tests?|projects?|reports?|presentations?|paper|due|deadline|submissions?|submit|hw|viva|oral|portfolio)\b/i
// With a class named only by a word of its name ("Science"), only an exam word will do.
const WEAK_EXAM = /\b(?:finals?|quiz(?:zes)?|tests?|presentations?|viva|oral)\b/i
const EXAMS = /\b(?:exams?|midterms?|mid-terms?|finals?|quiz(?:zes)?|tests?|viva|oral)\b/i
// Everyday phrases with those words in them.
const NOT_SCHOOL = [
  /\b(?:blood|covid|pcr|antigen|drug|eye|hearing|vision|pregnancy|allergy|dna|urine|lab|skin|stress|smog|emissions?|speed|smoke|a\/?b|unit|load|beta|road|driving|driver'?s|breathalyz\w*)\s+tests?\b/i,
  /\btests?\s+(?:drive|run|ride|batch|kitchen|print|flight|match|cricket)\b/i,
  /\btest(?:ing)?\s+(?:the|my|our|a|new)\b/i,
  /\b(?:eye|dental|medical|physical|vision|health|annual|vet|breast|skin|prostate)\s+(?:exam|check)s?\b/i,
  /\b(?:pub|trivia|quiz)\s+(?:quiz|night)\b/i,
  /\bquiz\s+night\b/i,
  /\bfinal\s+(?:fantasy|episode|season|cut|draft|fitting|payment|bill|notice|call|boarding)\b/i,
  /\b(?:season|series)\s+finale?\b/i,
  /\bmid-?terms?\s+elections?\b/i,
  /\b(?:vote|voting|elections?|ballot|nba|nfl|nhl|mlb|league|cup|tournament|playoffs?)\b/i,
  /\b(?:rent|bill|bills|invoice|tax|taxes|payment|card|loan|library books?|books?|subscription|renewal|visa|passport|license|licence|insurance)\s+(?:is\s+)?due\b/i,
  /\bdue\s+(?:back|date for (?:rent|bills?|payment))\b/i,
  /\b(?:pick\s*up|collect|get)\b.*\b(?:results?|reports?)\b/i,
  /\b(?:jury|duty|work|job|shift|seat|room|task)\s+assignments?\b/i,
  /\bassignment\s+of\b/i,
  /\bhomework\s+club\b/i,
  /\b(?:help|kids?|children|son|daughter)\b.*\bhomework\b/i,
]
// Prep tasks are what the radar offers, not deadlines themselves.
const PREP = /^\s*(?:study|studying|revise|revision|review|reviewing|prep|prepare|preparing|practice|practise|read|reading|work on|start|draft|outline|research|finish|plan)\b/i
const PREP_WORDS = /\b(?:study|studying|revise|revision|review|prep|prepare|practice|practise|flashcards|notes|past papers?)\b/i
// Shorthand at the front of a title that isn't what it's about: "tmrw research for…", "CS1026: review…".
const LEAD = /^\s*(?:(?:today|tonight|tom|tmr|tmrw|tomorrow|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\p{L}{1,10}\s*-?\s*\d{2,4}\p{L}?\s*[:\-–—])[\s:,.\-–—]*/iu
const isPrep = (value) => {
  let text = value
  for (let i = 0; i < 3 && LEAD.test(text); i += 1) text = text.replace(LEAD, '')
  return PREP.test(text)
}

const isReminder = (details) => typeof details === 'string' && details.startsWith('friend-reminder:')
const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim()

// Whether a title reads as a deadline: { exam } or null. hasClass: it names one of the classes;
// how: how (classIn), where 'word' (only a word of the class's name) is weak evidence.
export function deadlineKind(text, { hasClass = false, how = '' } = {}) {
  const value = clean(text)
  if (!value || isPrep(value) || NOT_SCHOOL.some((pattern) => pattern.test(value))) return null
  const loose = hasClass && (how === 'word' ? WEAK_EXAM : WEAK).test(value)
  if (!STRONG.test(value) && !(THESIS.test(value) && THESIS_DUE.test(value)) && !loose) return null
  return { exam: EXAMS.test(value) }
}

// Exams and deadlines from tomorrow to `days` ahead, soonest first (ones that name a class first
// on the same day) → [{ key, source: 'task'|'event', id, title, date, time, classId, className, exam }].
// Done, archived and dismissed ones (settings.radar.dismissed keys) are left out. An event linked
// to a task is the task's.
export function upcomingDeadlines({ tasks = [], events = [], classes = [], today, days = RADAR_DAYS, dismissed = [] } = {}) {
  if (!isISODate(today)) return []
  const until = addDaysISO(today, days)
  const skip = new Set((Array.isArray(dismissed) ? dismissed : []).map((entry) => (typeof entry === 'string' ? entry : entry?.key)).filter(Boolean))
  const matchers = classMatchers(classes, today)
  const taskIds = new Set(tasks.map((task) => task?.id))
  const sources = [
    ...tasks.filter((task) => task && !task.done && !task.archived && !isReminder(task.details))
      .map((task) => ({ source: 'task', id: task.id, title: task.text, date: task.date, time: task.time || '' })),
    ...events.filter((event) => event && !taskIds.has(event.taskId || event.task_id))
      .map((event) => ({ source: 'event', id: event.id, title: event.title, date: event.date, time: event.time || '' })),
  ]
  const found = []
  for (const entry of sources) {
    if (!isISODate(entry.date) || entry.date <= today || entry.date > until) continue
    const key = `${entry.source}:${entry.id}`
    if (skip.has(key)) continue
    const match = classIn(entry.title, matchers)
    const kind = deadlineKind(entry.title, { hasClass: !!match, how: match?.how })
    if (!kind) continue
    found.push({ key, source: entry.source, id: entry.id, title: clean(entry.title), date: entry.date, time: entry.time, classId: match?.id ?? null, className: match?.name ?? '', exam: kind.exam })
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || (a.className ? 0 : 1) - (b.className ? 0 : 1) || (timeToMinutes(a.time) ?? 1e4) - (timeToMinutes(b.time) ?? 1e4))
}

// Whether something is already planned for it: a task (open or done, not archived) from the last
// week up to the day before, or open with no date, that mentions its class or the words of its title,
// or that is a study task when the title is only an exam word ("Midterm"). An earlier deadline
// itself ("ECON 101 quiz 1" before "ECON 101 quiz 2") isn't prep unless it says it is ("review").
export function hasPrep(item, tasks = [], { today, classes = [] } = {}) {
  if (!item) return false
  const matchers = classMatchers(classes, today)
  const own = classIn(item.title, matchers)
  const subject = clean(item.title).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length >= 3 && !STRONG.test(part) && !WEAK.test(part) && !EXAMS.test(part) && !STOP.has(part))
  const since = today ? addDaysISO(today, -7) : ''
  return tasks.some((task) => {
    if (!task || task.archived || task.id === item.id || isReminder(task.details)) return false
    if (task.date ? task.date >= item.date || (since && task.date < since) : task.done) return false
    const text = clean(task.text)
    const named = classIn(text, matchers)
    if (deadlineKind(text, { hasClass: !!named, how: named?.how }) && !PREP_WORDS.test(text)) return false
    if (own && named?.id === own.id) return true
    const lower = text.toLowerCase()
    if (subject.length) return subject.every((part) => word(part).test(lower)) || (PREP_WORDS.test(text) && subject.some((part) => word(part).test(lower)))
    return PREP_WORDS.test(text)
  })
}
const STOP = new Set(['the', 'and', 'for', 'with', 'due', 'my', 'our', 'on', 'in', 'of', 'to', 'at', 'next', 'week', 'class', 'big', 'final'])

// What the study tasks are called: "Study for ECON 101 midterm", "Work on History essay".
export function studyTitle(item) {
  const title = clean(item?.title).replace(/[.!]+$/, '')
  const short = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title
  return `${item?.exam ? 'Study for' : 'Work on'} ${short}`
}

// Up to `count` study blocks of `minutes` on the freest evenings (`from`–`to`) from today to the
// day before → [{ date, time, text }] by date. Each day's busy time is its classes, events and open
// timed tasks; a day without a free stretch that long is skipped. The freest evenings win, and on
// a tie the one nearer the deadline. Today only counts from `now` ("HH:MM") plus a little.
export function studyPlan({ item, tasks = [], events = [], classes = [], today, now = '', count = 2, from = '17:00', to = '22:00', minutes = 60 } = {}) {
  if (!item || !isISODate(today) || !isISODate(item.date) || item.date <= today) return []
  const fromMinutes = timeToMinutes(from) ?? 17 * 60
  const nowMinutes = timeToMinutes(now)
  const days = []
  for (let date = today; date < item.date; date = addDaysISO(date, 1)) {
    let start = fromMinutes
    if (date === today && nowMinutes !== null) start = Math.max(start, Math.ceil((nowMinutes + 15) / 30) * 30)
    const busy = busyOn({ date, classSlots: classSlotsFor(classes, date), events, tasks })
    const free = freeSlots({ busy, from: hhmm(start), to, minMinutes: minutes })
      .map((slot) => ({ ...slot, start: hhmm(Math.ceil(timeToMinutes(slot.start) / 30) * 30) }))
      .filter((slot) => timeToMinutes(slot.end) - timeToMinutes(slot.start) >= minutes)
    if (!free.length) continue
    const total = free.reduce((sum, slot) => sum + timeToMinutes(slot.end) - timeToMinutes(slot.start), 0)
    days.push({ date, total, time: free[0].start })
  }
  return days
    .sort((a, b) => b.total - a.total || b.date.localeCompare(a.date))
    .slice(0, Math.max(0, count))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ date: day.date, time: day.time, text: studyTitle(item) }))
}

const hhmm = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`

// "Tomorrow" / "Thu, in 4 days".
export function radarWhen(date, today) {
  if (!isISODate(date) || !isISODate(today)) return ''
  const delta = diffDays(today, date)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  return `${WEEKDAY_SHORT[weekdayIndex(date)]}, in ${delta} days`
}

// ---- settings.radar = { dismissed: [{ key, at }] } (newest last, at most 50) ----------------------

export function readRadar(settings) {
  const raw = settings?.radar
  const dismissed = Array.isArray(raw?.dismissed)
    ? raw.dismissed.filter((entry) => entry && typeof entry.key === 'string' && entry.key).map((entry) => ({ key: entry.key, at: typeof entry.at === 'string' ? entry.at : '' }))
    : []
  return { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), dismissed }
}

export function dismissRadar(radar, key, today = '') {
  const current = readRadar({ radar })
  const dismissed = [...current.dismissed.filter((entry) => entry.key !== key), { key, at: today }].slice(-RADAR_DISMISSED_MAX)
  return { ...current, dismissed }
}

export function restoreRadar(radar, key) {
  const current = readRadar({ radar })
  return { ...current, dismissed: current.dismissed.filter((entry) => entry.key !== key) }
}

// "Usually today": tasks you repeat (Laundry on Sundays, rent around the 1st, plants every 3
// days) learned from the tasks you've ticked off, offered on Today and in the new-task sheet.
// Nothing is ever added by itself: a suggestion is one tap to add, or "Not this" to hide it.
//
// Pure (no React, no store): it only reads the task list it's given. The owner's choices live in
// settings.rhythms = { off, dismissed: [{ key, title, at }] } (see readRhythms).
//
//   rhythmKey(text)            "Pay rent (Oct 5)" → "pay rent": one key for a task's repeats
//   learnRhythms(tasks, today) every rhythm found, due today or not
//   usualToday({ … })          the ones to offer today, best first
import { diffDays, isISODate, parseISO, timeToMinutes, toISO, weekdayIndex } from './dates.js'

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MAX_AGE_DAYS = 400 // older history is ignored
const DISMISSED_CAP = 60
const EARLIEST = '04:00' // rows show from here until the evening check-in

// ---- title keys ---------------------------------------------------------------------------------

// Always dates, whatever their place in the title ("may" and "march" are ordinary words too, so
// they're in the ambiguous list below instead).
const FULL_NAMES = new Set([
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays',
])
// Dates only next to a day number or as the last word: "Pay rent Oct" loses "Oct", "Buy sun cream" keeps "sun".
const AMBIGUOUS = new Set(['jan', 'feb', 'mar', 'march', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun'])
const RELATIVE = new Set(['today', 'tomorrow', 'tonight'])
const NUMERIC_DATE = /^\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ORDINAL = /^\d{1,2}(?:st|nd|rd|th)$/

const fold = (text) => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const trimPunctuation = (word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')

function isDayNumber(token) {
  const match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(token || '')
  return !!match && Number(match[1]) >= 1 && Number(match[1]) <= 31
}

// Which tokens (lowercase, no punctuation around them) are date words, to be left out.
function dateTokens(tokens) {
  const drop = tokens.map(() => false)
  const dropNumberBeside = (index) => {
    if (isDayNumber(tokens[index + 1]) && !drop[index + 1]) drop[index + 1] = true
    else if (isDayNumber(tokens[index - 1]) && !drop[index - 1]) drop[index - 1] = true
    else return false
    return true
  }
  tokens.forEach((token, index) => {
    if (NUMERIC_DATE.test(token) || ISO_DATE.test(token) || ORDINAL.test(token) || RELATIVE.has(token)) drop[index] = true
    else if (token === 'week' && (tokens[index - 1] === 'this' || tokens[index - 1] === 'next')) {
      drop[index] = true
      drop[index - 1] = true
    } else if (FULL_NAMES.has(token)) {
      drop[index] = true
      dropNumberBeside(index)
    } else if (AMBIGUOUS.has(token) && dropNumberBeside(index)) drop[index] = true
  })
  // An ambiguous word left at the very end ("Pay rent Oct").
  let last = tokens.length - 1
  while (last >= 0 && (drop[last] || !tokens[last])) last -= 1
  if (last >= 0 && AMBIGUOUS.has(tokens[last])) drop[last] = true
  return drop
}

// The key a task's repeats share: lowercase, no accents, dates and punctuation gone. Plain numbers
// stay ("Week 5 reading" and "Week 6 reading" are different tasks). Under 3 characters → ''.
export function rhythmKey(text) {
  // Words, with "5/10" or "2026-10-05" kept whole (their separators would split them into numbers).
  const tokens = fold(text).split(/\s+/).flatMap((word) => {
    const core = trimPunctuation(word)
    return NUMERIC_DATE.test(core) || ISO_DATE.test(core) ? [core] : word.replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  }).filter(Boolean)
  const drop = dateTokens(tokens)
  const key = tokens.filter((_, index) => !drop[index]).join(' ').replace(/\s+/g, ' ').trim()
  return key.length < 3 ? '' : key
}

// The title with its date words taken out, keeping the owner's own capitals: "Pay rent Oct" → "Pay rent".
function withoutDates(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  const cores = words.map((word) => trimPunctuation(fold(word)))
  const drop = dateTokens(cores)
  const kept = words.filter((_, index) => !drop[index]).join(' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—,:;/|·(]+|[\s\-–—,:;/|·(]+$/g, '')
    .trim()
  return kept ? kept[0].toUpperCase() + kept.slice(1) : ''
}

// What to call a rhythm: the text used most often (ties go to the latest), else the latest text;
// with its date words removed and a capital first letter. items: oldest first.
export function rhythmTitle(items) {
  const list = (items || []).filter((item) => String(item?.text || '').trim())
  if (!list.length) return ''
  const counts = new Map()
  list.forEach((item, index) => {
    const text = String(item.text).trim()
    const entry = counts.get(text) || { count: 0, last: -1 }
    counts.set(text, { count: entry.count + 1, last: index })
  })
  let best = null
  for (const [text, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.last > best.last)) best = { text, ...entry }
  }
  // Without its date words either way: "Pay rent Oct" every month is still "Pay rent".
  const text = best.count > 1 ? best.text : String(list.at(-1).text).trim()
  return withoutDates(text) || text
}

// ---- history ------------------------------------------------------------------------------------

const isFriendReminder = (task) => typeof task?.details === 'string' && task.details.startsWith('friend-reminder:')

function localDay(stamp) {
  if (!stamp) return ''
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? '' : toISO(date)
}

// "17:00" for any time the app understands, else ''.
function cleanTime(value) {
  const minutes = timeToMinutes(value)
  if (minutes === null || minutes < 0 || minutes >= 1440) return ''
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// The day a ticked-off task counts for: when it was ticked, unless that was more than 2 days after
// its date (a clean-up of old tasks), then its date. null for open tasks, the future and old history.
export function occurrenceDay(task, today) {
  if (!task?.done) return null
  const ticked = localDay(task.completedAt)
  const dated = isISODate(task.date) ? task.date : ''
  let day = ''
  if (ticked && dated) day = diffDays(dated, ticked) > 2 ? dated : ticked
  else day = ticked || dated
  if (!day || day > today || diffDays(day, today) > MAX_AGE_DAYS) return null
  return day
}

// key → { days: sorted unique days, items: [{ day, time, text, priority }] oldest first }.
// Archived done tasks count; friend reminders don't.
export function collectHistory(tasks, today) {
  const history = new Map()
  for (const task of tasks || []) {
    if (!task || isFriendReminder(task)) continue
    const day = occurrenceDay(task, today)
    if (!day) continue
    const key = rhythmKey(task.text)
    if (!key) continue
    const entry = history.get(key) || { days: [], items: [] }
    entry.items.push({ day, time: cleanTime(task.time), text: String(task.text || '').trim(), priority: task.priority || 'medium' })
    history.set(key, entry)
  }
  for (const entry of history.values()) {
    entry.items.sort((a, b) => a.day.localeCompare(b.day))
    entry.days = [...new Set(entry.items.map((item) => item.day))]
  }
  return history
}

// ---- detection ----------------------------------------------------------------------------------

// The middle value (the lower of the two middle ones for an even count).
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

const gapsOf = (days) => days.slice(1).map((day, index) => diffDays(days[index], day))

function daysInMonth(iso) {
  const date = parseISO(iso)
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

const dayOfMonth = (iso) => Number(iso.slice(8, 10))
// The day of the month, with the last day of any month counted as 31.
const domOf = (iso) => (dayOfMonth(iso) === daysInMonth(iso) ? 31 : dayOfMonth(iso))
const monthIndex = (iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1

function weekly(days, today) {
  const recent = days.slice(-12)
  const byWeekday = new Map()
  for (const day of recent) {
    const weekday = weekdayIndex(day)
    byWeekday.set(weekday, [...(byWeekday.get(weekday) || []), day])
  }
  // The weekday with the most entries; on a tie, the one used most recently.
  let onDay = []
  for (const list of byWeekday.values()) {
    if (list.length > onDay.length || (list.length === onDay.length && list.at(-1) > onDay.at(-1))) onDay = list
  }
  if (onDay.length < 3) return null
  const share = onDay.length / recent.length
  if (share < 0.6) return null
  const every = Math.round(median(gapsOf(onDay)) / 7)
  if (every !== 1 && every !== 2) return null
  const expected = Math.floor(diffDays(onDay[0], onDay.at(-1)) / (7 * every)) + 1
  const coverage = onDay.length / expected
  if (coverage < 0.6) return null
  const last = onDay.at(-1)
  const since = diffDays(last, today)
  if (since > 7 * every + 14) return { dead: true }
  const weekday = weekdayIndex(last)
  const due = since >= 0 && weekdayIndex(today) === weekday && (every === 1 || since % 14 === 0)
  return { kind: 'weekly', weekday, every, strength: share * Math.min(1, coverage), count: days.length, last, due }
}

function monthly(days, today) {
  const recent = days.slice(-12)
  const target = median(recent.slice(-6).map(domOf))
  const hits = recent.filter((day) => Math.abs(dayOfMonth(day) - Math.min(target, daysInMonth(day))) <= 2)
  if (hits.length < 3) return null
  const months = new Set(hits.map(monthIndex))
  if (months.size < 3) return null
  const span = monthIndex(hits.at(-1)) - monthIndex(hits[0]) + 1
  if (span > months.size + 1) return null
  const share = hits.length / recent.filter((day) => day >= hits[0]).length
  if (share < 0.6) return null
  const last = hits.at(-1)
  if (diffDays(last, today) > 62) return { dead: true }
  const dueDay = Math.min(target, daysInMonth(today))
  const recently = days.some((day) => day <= today && diffDays(day, today) <= 20)
  const due = dayOfMonth(today) >= dueDay && dayOfMonth(today) <= dueDay + 2 && !recently
  return { kind: 'monthly', dom: target, strength: share, count: days.length, last: days.at(-1), due }
}

function everyNDays(days, today) {
  const window = days.slice(-9)
  const gaps = gapsOf(window)
  if (gaps.length < 2) return null
  const every = median(gaps)
  if (every < 1 || every > 45) return null
  const tolerance = Math.max(1, Math.round(0.25 * every))
  const ok = gaps.filter((gap) => Math.abs(gap - every) <= tolerance).length / gaps.length
  if (ok < 0.75) return null
  // Every day or two: only a habit kept up for a while (6+ times over 10+ days), not a busy week.
  if (every <= 2 && (days.length < 6 || diffDays(days[0], days.at(-1)) < 10)) return null
  const last = days.at(-1)
  const since = diffDays(last, today)
  const due = since >= Math.max(1, every - (every >= 7 ? 1 : 0)) && since <= 2 * every
  return { kind: 'days', every, strength: ok, count: days.length, last, due }
}

// The rhythm in a list of days (sorted, unique), or null. The first pattern that fits wins (weekly,
// then monthly, then every N days); one that fits but isn't due today comes back with due: false.
// { kind: 'weekly' | 'monthly' | 'days', weekday?, every?, dom?, strength 0–1, count, last, due }
export function detectRhythm(days, today) {
  const list = (days || []).filter((day) => isISODate(day) && day <= today)
  if (list.length < 3) return null
  for (const find of [weekly, monthly, everyNDays]) {
    const found = find(list, today)
    if (found) return found.dead ? null : found
  }
  return null
}

// The time it's usually done at, when there is a steady one lately: the newest timed one (among
// the last 2), if at least one other recent time is within an hour of it. Else null.
export function usualTime(items) {
  const recent = (items || []).slice(-6)
  const timed = recent.map((item, index) => ({ index, minutes: timeToMinutes(item?.time) })).filter((item) => item.minutes !== null && item.minutes >= 0 && item.minutes < 1440)
  const latest = timed.at(-1)
  if (!latest || latest.index < recent.length - 2) return null
  const near = timed.filter((item) => Math.abs(item.minutes - latest.minutes) <= 60).length
  return near >= 2 ? cleanTime(recent[latest.index].time) : null
}

// Every rhythm in the task history, due today or not:
// [{ key, title, rhythm, usualTime, priority, lastDay }].
export function learnRhythms(tasks, today) {
  try {
    const learned = []
    for (const [key, { days, items }] of collectHistory(tasks, today)) {
      const rhythm = detectRhythm(days, today)
      if (!rhythm) continue
      const lastPriority = items.at(-1)?.priority
      learned.push({
        key,
        title: rhythmTitle(items),
        rhythm,
        usualTime: usualTime(items),
        priority: lastPriority === 'high' || lastPriority === 'urgent' ? lastPriority : 'medium',
        lastDay: days.at(-1),
      })
    }
    return learned
  } catch {
    return []
  }
}

// ---- what to offer ------------------------------------------------------------------------------

// The rhythms due today that aren't already on the list (any open task, anything dated today,
// done today) or hidden, best first: strongest, most repeated, longest since.
// learned: learnRhythms' result, when the caller already has it.
export function usualToday({ tasks = [], today, rhythms, limit = 2, learned } = {}) {
  try {
    const prefs = normalizeRhythms(rhythms)
    if (prefs.off) return []
    const hidden = new Set(prefs.dismissed.map((entry) => entry.key))
    const taken = new Set()
    for (const task of tasks || []) {
      if (!task) continue
      const open = !task.done && !task.archived
      const datedToday = !task.archived && task.date === today
      const doneToday = task.done && (localDay(task.completedAt) === today || task.date === today)
      if (open || datedToday || doneToday) taken.add(rhythmKey(task.text))
    }
    return (learned || learnRhythms(tasks, today))
      .filter((item) => item.rhythm?.due && !taken.has(item.key) && !hidden.has(item.key))
      .sort((a, b) => b.rhythm.strength - a.rhythm.strength || b.rhythm.count - a.rhythm.count || String(a.lastDay).localeCompare(String(b.lastDay)))
      .slice(0, limit)
  } catch {
    return []
  }
}

const ordinal = (n) => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`
}

// "Every Sunday", "Every other Friday", "Every 3 days", "Every day", "Around the 1st",
// "Around the end of the month". Takes a rhythm (or a learned item).
export function rhythmLabel(r) {
  const rhythm = r?.rhythm || r
  if (!rhythm) return ''
  if (rhythm.kind === 'weekly') return `Every ${rhythm.every === 2 ? 'other ' : ''}${WEEKDAY_NAMES[rhythm.weekday] || 'week'}`
  if (rhythm.kind === 'monthly') return rhythm.dom >= 31 ? 'Around the end of the month' : `Around the ${ordinal(rhythm.dom)}`
  if (rhythm.kind === 'days') return rhythm.every === 1 ? 'Every day' : `Every ${rhythm.every} days`
  return ''
}

// "Like last time · 5 PM" is offered while that time is still ahead.
export function showTimeChip(s, nowHHMM) {
  return !!s?.usualTime && s.usualTime > String(nowHHMM || '')
}

// What Today shows at this time: nothing before 04:00, everything until the evening check-in,
// then only the ones with a usual time still ahead.
export function visibleNow(list, nowHHMM, eveningHHMM = '18:00') {
  const now = String(nowHHMM || '')
  if (now < EARLIEST) return []
  if (now < String(eveningHHMM || '18:00')) return [...(list || [])]
  return (list || []).filter((item) => showTimeChip(item, now))
}

// Learned rhythms whose title starts like what's being typed, word by word ("pay r" → "Pay rent").
// Not the one already typed in full, nor hidden ones.
export function titleMatches(learned, query, { dismissed = [], limit = 2 } = {}) {
  const typed = fold(query).replace(/[^a-z0-9]+/g, ' ').trim()
  if (typed.length < 2) return []
  const words = typed.split(' ')
  const hidden = new Set((dismissed || []).map((entry) => (typeof entry === 'string' ? entry : entry?.key)))
  const starts = (key) => {
    const keyWords = key.split(' ')
    for (let at = 0; at + words.length <= keyWords.length; at += 1) {
      if (words.every((word, index) => (index < words.length - 1 ? keyWords[at + index] === word : keyWords[at + index].startsWith(word)))) return true
    }
    return false
  }
  return (learned || [])
    .filter((item) => item?.key && item.key !== typed && !hidden.has(item.key) && starts(item.key))
    .sort((a, b) => (b.rhythm?.count || 0) - (a.rhythm?.count || 0) || (b.rhythm?.strength || 0) - (a.rhythm?.strength || 0))
    .slice(0, limit)
}

// ---- settings.rhythms ---------------------------------------------------------------------------

function normalizeRhythms(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const dismissed = Array.isArray(raw.dismissed)
    ? raw.dismissed
      .filter((entry) => entry && typeof entry.key === 'string' && entry.key)
      .map((entry) => ({ key: entry.key, title: typeof entry.title === 'string' ? entry.title : entry.key, at: typeof entry.at === 'string' ? entry.at : '' }))
    : []
  return { off: raw.off === true, dismissed }
}

// settings.rhythms, with corrupt or missing parts back to the defaults ({ off: false, dismissed: [] }).
export function readRhythms(settings) {
  return normalizeRhythms(settings?.rhythms)
}

// "Not this": hidden from now on (newest first, at most 60 kept).
export function dismissRhythm(rhythms, { key, title }, today) {
  const current = normalizeRhythms(rhythms)
  if (!key) return current
  const entry = { key, title: title || key, at: today || '' }
  return { ...current, dismissed: [entry, ...current.dismissed.filter((item) => item.key !== key)].slice(0, DISMISSED_CAP) }
}

// "Bring back".
export function restoreRhythm(rhythms, key) {
  const current = normalizeRhythms(rhythms)
  return { ...current, dismissed: current.dismissed.filter((item) => item.key !== key) }
}

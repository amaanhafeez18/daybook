// Dates are stored as local YYYY-MM-DD strings and times as 24-hour HH:MM.

export function toISO(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayISO() {
  return toISO(new Date())
}

// Noon avoids daylight-saving edge cases when adding days.
export function parseISO(iso) {
  return new Date(`${iso}T12:00:00`)
}

// Rejects impossible dates such as 2027-02-29 (some engines roll them over to the next month).
export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = parseISO(value)
  return !Number.isNaN(date.getTime()) && date.getDate() === Number(value.slice(8, 10))
}

export function addDaysISO(iso, delta) {
  const date = parseISO(iso)
  date.setDate(date.getDate() + delta)
  return toISO(date)
}

export function diffDays(fromISO, toISOValue) {
  return Math.round((parseISO(toISOValue) - parseISO(fromISO)) / 86400000)
}

export function weekdayIndex(iso) {
  return parseISO(iso).getDay()
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function nowTimeHHMM(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// "14:30" -> "2:30 PM". Free text (e.g. "9:00 AM - 10:30 AM") is returned unchanged.
export function formatTime(value) {
  if (!value) return ''
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) return String(value)
  const hour = Number(match[1])
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`
}

// Minutes after midnight for "14:30", "2:30 PM", or the start of "9:00 AM - 10:30 AM".
export function timeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!match) return null
  let hour = Number(match[1])
  const suffix = match[3]?.toUpperCase()
  if (suffix === 'PM' && hour < 12) hour += 12
  if (suffix === 'AM' && hour === 12) hour = 0
  return hour * 60 + Number(match[2])
}

// Start and end (minutes after midnight) of a free-text time or range: "2:30 PM - 4:30 PM",
// "14:30–15:50", "2:30-3:30 PM", "11 AM to 1 PM". A side without AM/PM borrows the other side's
// (flipped when that would make the class end before it starts). end is null without a range.
export function timeRangeMinutes(value) {
  const parts = String(value || '').trim().split(/\s*(?:[-–—]|\bto\b)\s*/i).filter(Boolean)
  const read = (text) => {
    const match = String(text || '').match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?$/i)
    if (!match || Number(match[1]) > 23 || Number(match[2] || 0) > 59) return null
    return { hour: Number(match[1]), minute: Number(match[2] || 0), suffix: match[3]?.toLowerCase() || null }
  }
  const toMinutes = ({ hour, minute }, suffix) => {
    let h = hour
    if (suffix === 'p' && h < 12) h += 12
    if (suffix === 'a' && h === 12) h = 0
    return h * 60 + minute
  }
  const start = read(parts[0])
  if (!start) return { start: null, end: null }
  const end = parts.length > 1 ? read(parts[1]) : null
  if (!end) return { start: toMinutes(start, start.suffix), end: null }
  const flip = (suffix) => (suffix === 'a' ? 'p' : 'a')
  let startSuffix = start.suffix
  let endSuffix = end.suffix
  if (!startSuffix && endSuffix && start.hour <= 12) {
    startSuffix = toMinutes(start, endSuffix) <= toMinutes(end, endSuffix) ? endSuffix : flip(endSuffix)
  } else if (startSuffix && !endSuffix && end.hour <= 12) {
    endSuffix = toMinutes(end, startSuffix) >= toMinutes(start, startSuffix) ? startSuffix : flip(startSuffix)
  }
  return { start: toMinutes(start, startSuffix), end: toMinutes(end, endSuffix) }
}

export function compareTimes(a, b) {
  const left = timeToMinutes(a)
  const right = timeToMinutes(b)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

// Date labels run per row on every render, so formatters are cached. They are pinned to UTC and
// given UTC noon, so the output matches local formatting and can't go stale if the zone changes.
const formatters = new Map()

function formatUTC(year, monthIndex, day, options) {
  const key = JSON.stringify(options)
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' })
    formatters.set(key, formatter)
  }
  const date = new Date(0)
  date.setUTCFullYear(year, monthIndex, day)
  date.setUTCHours(12)
  return formatter.format(date)
}

const formatISODate = (iso, options) => formatUTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), options)

export function formatDateShort(iso) {
  if (!isISODate(iso)) return iso || ''
  const sameYear = Number(iso.slice(0, 4)) === new Date().getFullYear()
  return formatISODate(iso, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateLong(iso) {
  if (!isISODate(iso)) return iso || ''
  return formatISODate(iso, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatMonthYear(year, month) {
  return formatUTC(year, month, 1, { month: 'long', year: 'numeric' })
}

// "Today", "Tomorrow", "Yesterday", "Friday" (within the week ahead), otherwise "Sep 22".
export function relativeDay(iso, today = todayISO()) {
  if (!isISODate(iso)) return ''
  const delta = diffDays(today, iso)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta === -1) return 'Yesterday'
  if (delta > 1 && delta < 7) return formatISODate(iso, { weekday: 'long' })
  return formatDateShort(iso)
}

export function timeAgo(iso, today = todayISO()) {
  if (!isISODate(iso)) return ''
  const days = diffDays(iso, today)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

export function greeting(date = new Date()) {
  const hour = date.getHours()
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

// Next occurrence of a birthday (YYYY-MM-DD, any year) on or after `today`.
export function nextBirthday(birthday, today = todayISO()) {
  if (!isISODate(birthday)) return null
  const [, month, day] = birthday.split('-')
  const year = Number(today.slice(0, 4))
  let candidate = `${year}-${month}-${day}`
  if (!isISODate(candidate)) candidate = `${year}-03-01` // Feb 29 in a non-leap year
  if (candidate < today) {
    candidate = `${year + 1}-${month}-${day}`
    if (!isISODate(candidate)) candidate = `${year + 1}-03-01`
  }
  return candidate
}

export function formatDuration(minutes) {
  if (minutes < 1) return 'now'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (!hours) return `${mins} min`
  return mins ? `${hours} h ${mins} min` : `${hours} h`
}

// ---- due-date labels -------------------------------------------------------------------------

// "Today", "Tomorrow", "Friday" (within the week ahead), otherwise "Mon, Oct 5" (plus the year
// when it isn't this one). Unlike relativeDay, a date further out keeps its weekday.
export function dueDayLabel(iso, today = todayISO()) {
  if (!isISODate(iso)) return ''
  const delta = diffDays(today, iso)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta === -1) return 'Yesterday'
  if (delta > 1 && delta < 7) return formatISODate(iso, { weekday: 'long' })
  const sameYear = iso.slice(0, 4) === String(today).slice(0, 4)
  return formatISODate(iso, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

// For a chip: "Tomorrow · 5:00 PM".
export function formatDue(iso, time = '', today = todayISO()) {
  const day = dueDayLabel(iso, today)
  if (!day) return time ? formatTime(time) : ''
  return time ? `${day} · ${formatTime(time)}` : day
}

// For a sentence: `Added for ${dueSentence(…)}` -> "tomorrow at 5:00 PM", "Friday", "Mon, Oct 5".
export function dueSentence(iso, time = '', today = todayISO()) {
  const day = dueDayLabel(iso, today)
  const lead = ['Today', 'Tomorrow', 'Yesterday'].includes(day) ? day.toLowerCase() : day
  return time ? `${lead} at ${formatTime(time)}` : lead
}

// ---- natural-language quick add --------------------------------------------------------------
// parseQuickAdd('Call mom tomorrow at 5pm', now) ->
//   { title: 'Call mom', date: '2026-09-24', time: '17:00', matched: [{ start, end, text }] }
// Only words at the very start or end of the text count, so titles such as "Call Friday's
// contact" or "Plan the Monday meeting" keep their words. When nothing is recognised (or nothing
// would be left of the title) the result is { title: text, date: '', time: '', matched: [] }.
//   days:  today, tomorrow/tmrw, mon…sunday (the next one after today), this fri (today on a
//          Friday), next fri (Friday of next week), next week (Monday), this weekend,
//          oct 2 / 2nd of october, in 3 days / in 2 weeks
//   times: 5pm, 5:30 pm, 17:30, at 5 (1–6 mean PM), noon, in 20 min / in 2 hours / in an hour,
//          tonight (8 PM), this morning / tomorrow evening
// A time without a day means today, or tomorrow once that time has passed. No AI: plain patterns.

const WEEKDAY_WORDS = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?'
const MONTH_WORDS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45 }
const COUNT = `\\d{1,3}(?:\\.\\d+)?|${Object.keys(COUNT_WORDS).join('|')}`
const MERIDIEM = 'a\\.?m\\.?|p\\.?m\\.?'
const DAY_PARTS = { morning: 9, afternoon: 14, evening: 18, night: 20 }
const DAY_PREFIX = '(?:(?:on|by|due|for)\\s+)?'
const TIME_PREFIX = '(?:(?:at|by|around)\\s+|@\\s*)?'

// A word just before the phrase that makes it part of the title: "in the sun", "every Monday",
// "until 5pm", "from 3 to 5pm", "table for 8pm".
const GUARD_WORDS = 'the|a|an|my|your|his|her|our|their|its|of|every|each|until|till|til|since|after|before|from|last|per|than|about|re|regarding'
const GUARD_DATE = new RegExp(`(?:^|\\s)(?:${GUARD_WORDS})[\\s,;:–—-]*$`, 'i')
// A time glued to a dash after another time is the end of a range ("3-5pm", "5pm-6pm"): the
// title keeps the whole range rather than losing its start to a task at the end time.
const GUARD_TIME = new RegExp(`(?:(?:^|\\s)(?:${GUARD_WORDS}|for|to|and|or|-)[\\s,;:–—-]*|(?:\\d|[ap]\\.?m\\.?)\\s*[-–—]\\s*)$`, 'i')

const countValue = (word) => {
  const key = String(word).toLowerCase()
  return key in COUNT_WORDS ? COUNT_WORDS[key] : Number(key)
}

// kind: 'date' sets the day, 'time' the clock, 'daypart' the day plus a part of it (a clock time
// may still follow: "tonight at 9"), 'offset' both at once ("in 2 hours").
const QUICK_PATTERNS = [
  { kind: 'daypart', re: '(?:(this)|(tomorrow|tmrw|tmr))\\s+(morning|afternoon|evening|night)', read: (m) => ({ dayOffset: m[2] ? 1 : 0, dayPart: m[3].toLowerCase() }) },
  { kind: 'daypart', re: 'tonight', read: () => ({ dayOffset: 0, dayPart: 'night' }) },
  {
    kind: 'offset',
    re: `in\\s+(half\\s+an?|${COUNT})\\s*(minutes?|mins?|m|hours?|hrs?|hr|h)`,
    read: (m) => {
      const hours = /^h/i.test(m[2])
      const count = /^half/i.test(m[1]) ? (hours ? 0.5 : null) : countValue(m[1])
      if (count === null || !Number.isFinite(count) || count <= 0 || count > (hours ? 72 : 1440)) return null
      return { offsetMinutes: Math.round(count * (hours ? 60 : 1)) }
    },
  },
  {
    kind: 'date',
    re: `in\\s+(${COUNT})\\s*(days?|d|weeks?|wks?|w)`,
    read: (m) => {
      const count = countValue(m[1])
      if (!Number.isInteger(count) || count > 400) return null
      return { dayOffset: count * (/^w/i.test(m[2]) ? 7 : 1) }
    },
  },
  { kind: 'time', re: `${TIME_PREFIX}(\\d{1,2}):(\\d{2})\\s*(${MERIDIEM})?`, read: (m) => clockParts(m[1], m[2], m[3]) },
  { kind: 'time', re: `${TIME_PREFIX}(\\d{1,2})\\s*(${MERIDIEM})`, read: (m) => clockParts(m[1], '00', m[2]) },
  { kind: 'time', re: '(?:at\\s+)?(?:noon|midday)', read: () => ({ hour: 12, minute: 0, meridiem: '24' }) },
  { kind: 'time', re: '(?:at|@)\\s*(\\d{1,2})', read: (m) => clockParts(m[1], '00', '') },
  { kind: 'date', re: `${DAY_PREFIX}next\\s+week`, read: () => ({ relative: 'next-week' }) },
  { kind: 'date', re: `${DAY_PREFIX}(today|tomorrow|tmrw|tmr)`, read: (m) => ({ dayOffset: /^today$/i.test(m[1]) ? 0 : 1 }) },
  { kind: 'date', re: `${DAY_PREFIX}this\\s+weekend`, read: () => ({ relative: 'weekend' }) },
  {
    kind: 'date',
    re: `${DAY_PREFIX}(?:(this|next)\\s+)?(${WEEKDAY_WORDS})\\.?`,
    read: (m) => ({
      weekday: WEEKDAY_INDEX[m[2].slice(0, 3).toLowerCase()],
      which: (m[1] || '').toLowerCase(),
      // "sun" and "sat" on their own are ordinary words ("Sun cream"): see parseQuickAdd.
      weak: /^(sun|sat)$/i.test(m[2]) && !/^(on|by|due|for|this|next)\s/i.test(m[0]),
    }),
  },
  { kind: 'date', re: `${DAY_PREFIX}(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, read: (m) => monthDay(m[1], m[2]) },
  { kind: 'date', re: `${DAY_PREFIX}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORDS})`, read: (m) => monthDay(m[2], m[1]) },
]

function monthDay(monthWord, dayText) {
  const day = Number(dayText)
  return day >= 1 && day <= 31 ? { month: MONTH_INDEX[monthWord.slice(0, 3).toLowerCase()], day } : null
}

function clockParts(hourText, minuteText, meridiemText) {
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const meridiem = String(meridiemText || '').replace(/\./g, '').toLowerCase()
  if (minute > 59 || hour > 23) return null
  if (meridiem && (hour === 0 || hour > 12)) return null
  // "09:00" and "17:30" are 24-hour times; "9:00" and "at 9" are ambiguous.
  const explicit = hour === 0 || hour > 12 || (hourText.length === 2 && hourText[0] === '0')
  return { hour, minute, meridiem: meridiem || (explicit ? '24' : '') }
}

const SEPARATORS = '[\\s,;:(\\[–—-]'
const END_TAIL = '[\\s.,!?;:)\\]]*$'
const START_LOOK = '(?=$|[\\s.,!?;)\\]]|:(?!\\d))'
const COMPILED = QUICK_PATTERNS.map((pattern) => ({
  ...pattern,
  end: new RegExp(`(^|${SEPARATORS}+)(${pattern.re})${END_TAIL}`, 'i'),
  start: new RegExp(`^(${SEPARATORS}*)(${pattern.re})${START_LOOK}`, 'i'),
  alone: new RegExp(`^(?:${pattern.re})$`, 'i'),
}))

function blocked(kind, found) {
  if (kind === 'date') return !!found.day
  if (kind === 'time') return !!found.clock
  if (kind === 'daypart') return !!(found.day || found.dayPart)
  return !!(found.day || found.clock) // offset
}

// The first pattern that matches at this end (side 'end') or start (side 'start') of the text.
function takePhrase(text, side, found, allowWeak) {
  for (const pattern of COMPILED) {
    if (blocked(pattern.kind, found)) continue
    const match = text.match(pattern[side])
    if (!match) continue
    const phrase = match[2]
    const parts = pattern.read(phrase.match(pattern.alone)) // groups numbered from 1 again
    if (!parts || (parts.weak && !allowWeak)) continue
    const start = match.index + match[1].length
    if (side === 'end' && (pattern.kind === 'time' ? GUARD_TIME : GUARD_DATE).test(text.slice(0, start))) continue
    return { kind: pattern.kind, parts, start, end: start + phrase.length, text: phrase }
  }
  return null
}

function resolveDay(parts, today) {
  if (Number.isInteger(parts.dayOffset)) return addDaysISO(today, parts.dayOffset)
  const weekday = weekdayIndex(today)
  const toNextMonday = 7 - ((weekday + 6) % 7) // 1…7
  if (parts.relative === 'next-week') return addDaysISO(today, toNextMonday)
  if (parts.relative === 'weekend') return addDaysISO(today, weekday === 0 ? 0 : 6 - weekday)
  if (Number.isInteger(parts.weekday)) {
    if (parts.which === 'next') return addDaysISO(today, toNextMonday + ((parts.weekday + 6) % 7))
    const ahead = (parts.weekday - weekday + 7) % 7
    return addDaysISO(today, parts.which === 'this' ? ahead : ahead || 7)
  }
  if (Number.isInteger(parts.month)) {
    const year = Number(today.slice(0, 4))
    const iso = (y) => `${y}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
    if (isISODate(iso(year)) && iso(year) >= today) return iso(year)
    if (isISODate(iso(year + 1))) return iso(year + 1)
  }
  return ''
}

const hhmm = (hour, minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

function resolveClock({ hour, minute, meridiem }, dayPart, date, today, nowHHMM) {
  if (meridiem === '24') return hhmm(hour, minute)
  if (meridiem === 'am') return hhmm(hour % 12, minute)
  if (meridiem === 'pm') return hhmm((hour % 12) + 12, minute)
  if (hour === 12) return hhmm(12, minute)
  // 1–11 without am/pm: the part of the day decides; otherwise 1–6 are afternoon/evening, 10–11
  // morning, and 7–9 morning unless that has already passed today ("gym at 7" after 7 AM).
  if (dayPart) return hhmm(dayPart === 'morning' ? hour : hour + 12, minute)
  if (hour <= 6) return hhmm(hour + 12, minute)
  const morning = hhmm(hour, minute)
  const evening = hhmm(hour + 12, minute)
  return hour <= 9 && (!date || date === today) && morning <= nowHHMM && evening > nowHHMM ? evening : morning
}

function parseOnce(text, now, allowWeak) {
  const today = toISO(now)
  const nowHHMM = nowTimeHHMM(now)
  const found = { day: null, clock: null, dayPart: null, offsetMinutes: 0, weak: false }
  const matched = []
  let lo = 0
  let hi = text.length
  for (let step = 0; step < 8; step += 1) {
    const rest = text.slice(lo, hi)
    const fromEnd = takePhrase(rest, 'end', found, allowWeak)
    const hit = fromEnd || takePhrase(rest, 'start', found, allowWeak)
    if (!hit) break
    const { kind, parts } = hit
    if (kind === 'offset') {
      found.offsetMinutes = parts.offsetMinutes
      found.day = parts
      found.clock = parts
    } else if (kind === 'daypart') {
      found.day = parts
      found.dayPart = parts.dayPart
    } else if (kind === 'date') found.day = parts
    else found.clock = parts
    if (parts.weak) found.weak = true
    matched.push({ start: lo + hit.start, end: lo + hit.end, text: hit.text })
    if (fromEnd) hi = lo + hit.start
    else lo += hit.end
  }
  if (!matched.length) return null

  // Trailing "(" / "[" (and leading ")" / "]") belonged to the bracketed phrase just removed.
  const title = text.slice(lo, hi).replace(/^[\s,;:)\]–—-]+|[\s,;:(\[–—-]+$/g, '')
  if (!/[\p{L}\p{N}]/u.test(title)) return null

  let date = ''
  let time = ''
  if (found.offsetMinutes) {
    const at = new Date(now.getTime() + found.offsetMinutes * 60000)
    date = toISO(at)
    time = nowTimeHHMM(at)
  } else {
    if (found.day) {
      date = resolveDay(found.day, today)
      if (!date) return null
    }
    if (found.clock) time = resolveClock(found.clock, found.dayPart, date, today, nowHHMM)
    else if (found.dayPart) time = hhmm(DAY_PARTS[found.dayPart], 0)
    if (time && !date) date = time > nowHHMM ? today : addDaysISO(today, 1)
  }
  return { title, date, time, matched: matched.sort((a, b) => a.start - b.start), weak: found.weak }
}

export function parseQuickAdd(text, now = new Date()) {
  const source = String(text ?? '')
  const none = { title: source.trim(), date: '', time: '', matched: [] }
  if (!source.trim()) return none
  let result = parseOnce(source, now, true)
  // A bare "sun"/"sat" is only a day next to a time ("brunch sat 10am"), not in "Sun cream".
  if (result?.weak && !result.time) result = parseOnce(source, now, false)
  if (!result) return none
  return { title: result.title, date: result.date, time: result.time, matched: result.matched }
}

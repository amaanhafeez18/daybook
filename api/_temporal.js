// Day words in a message ("tmrw", "Thursday", "next Fri", "Oct 8", "10/8", "the 8th") resolved to dates
// against the user's local today, for the assistant: a developer note before the newest message, the
// check that a staged edit is on the day the user named, and the check on the assistant's own reply.
// Pure ESM: no imports and no clock (today is always passed in as YYYY-MM-DD).
//
// Rules (also echoed in the note so the model can overrule them from context):
// - today / tonight / this morning|afternoon|evening = today; tomorrow (+ typos: tmrw, tommorw …) = +1;
//   day after tomorrow = +2; yesterday = -1; "in 3 days" = +3.
// - A plain weekday ("Thursday", "this Thu", "on Thu") = its next occurrence, today if today is that day
//   (the note then also gives next week's). "next Thursday" = the Thursday of next week (Mon–Sun), the
//   same rule as "next week"; the note also gives the nearer one when they differ. "last Thursday" = the
//   most recent one before today.
// - Explicit dates: "Oct 8", "October 8th", "8 Oct", "8th of October", "10/8" (US month/day) without a
//   year = the next one (this year's while it's at most two weeks ago), so "Apr 10" in October is next
//   April; after "last", "went", "did" or "since" the most recent one. "the 8th" = this month, or next
//   month once it has passed ("the 8th floor" is not a date).
// - False positives are avoided with whole words only, and the short words that are also English (mon,
//   wed, sat, sun) count only with a date or time nearby ("on Sat", "Sat 3pm", "next Sun", "Wed morning"),
//   a capital letter mid-sentence, or "to"/"for" in front ("move it to wed"; not "to sun"), and never
//   after "I", "we", "the" and similar ("I sat down", "the sun"). Month words count only next to a day number ("may I", "march on" don't), and plural weekdays
//   ("on Mondays", "every Monday") are routines, not a day. A typo of a weekday must still end like one
//   ("thrusday", "mondya"), so "subway", "monkey" and "Freddy" aren't days; "Sun Life" (two capitalised
//   words) isn't Sunday.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_WORDS = new Map([...MONTHS.map((name, index) => [name, index]), ...MONTHS.map((name, index) => [name.slice(0, 3), index]), ['sept', 8]])

const DAY_ABBREVS = new Map([['tue', 2], ['tues', 2], ['weds', 3], ['thu', 4], ['thur', 4], ['thurs', 4], ['thrs', 4], ['thrus', 4], ['fri', 5]])
const SHY_ABBREVS = new Map([['mon', 1], ['wed', 3], ['sat', 6], ['sun', 0]]) // also English words
const TOMORROW = new Set(['tomorrow', 'tomorow', 'tommorow', 'tommorrow', 'tommorw', 'tomorrw', 'tomorro', 'tomoro', 'tomrrow', 'tomrow', 'tomrw', 'tmrw', 'tmr', 'tmw', 'tmrrw', 'tmrow', 'tmro', 'tmorrow', 'tommrow', '2moro', '2morrow', '2morow', '2mrw'])
const YESTERDAY = new Set(['yesterday', 'yday', 'yesterdy', 'yesteday', 'yesturday', 'yestarday', 'yesterdat', 'ysterday'])
const TODAY = new Map([['today', 'today'], ['todays', 'today'], ['2day', 'today'], ['tonight', 'tonight'], ['tonite', 'tonight'], ['2nite', 'tonight']])
const DAY_PARTS = new Set(['morning', 'afternoon', 'evening', 'night', 'noon', 'lunch', 'lunchtime'])
const NOT_WEEKDAYS = new Set(['today', 'someday', 'midday', 'holiday', 'birthday', 'payday', 'weekday', 'everyday', 'doomsday', 'heyday', 'workday', 'yesterday', 'sundae', 'monthly', 'saturn'])
const BEFORE_OK = new Set(['on', 'this', 'next', 'last', 'by', 'until', 'till', 'til', 'from', 'before', 'after', 'coming', 'thru', 'through'])
const BEFORE_BAD = new Set(['i', 'we', 'you', 'he', 'she', 'they', 'it', 'who', 'just', 'had', 'have', 'has', 'was', 'were', 'the', 'a', 'an', 'been', 'then', 'also', 'finally', 'and', 'got', 'get'])
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const PAST_BEFORE = new Set(['last', 'went', 'did', 'since'])
const NTH_NOUNS = new Set(['floor', 'street', 'st', 'ave', 'avenue', 'grade', 'place', 'row', 'century', 'birthday', 'anniversary', 'time', 'attempt', 'try', 'round', 'year', 'edition', 'period', 'class', 'lesson', 'chapter', 'step'])
const UNIT_AFTER = /^(cups?|tsp|tbsp|tablespoons?|teaspoons?|lbs?|oz|kg|g|grams?|servings?|slices?|pieces?|portions?|of)$/i

const toDate = (iso) => new Date(`${iso}T12:00:00Z`)
export function addDays(iso, delta) {
  const date = toDate(iso)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}
export const daysBetween = (from, to) => Math.round((toDate(to) - toDate(from)) / 86400000)
const weekdayOf = (iso) => toDate(iso).getUTCDay()
const pad = (n) => String(n).padStart(2, '0')

// A real date as YYYY-MM-DD, or null (Feb 30 is not a date).
function isoOf(year, month, day) {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null
}

// Month and day without a year: the next one, or this year's while it's at most two weeks ago ("Apr 10"
// said in October is next April); `past` ("last", "went" before it) = the most recent one.
function dateNoYear(month, day, today, past = false) {
  const year = Number(today.slice(0, 4))
  const options = [year - 1, year, year + 1].map((y) => isoOf(y, month, day)).filter(Boolean)
  if (!options.length) return null
  if (past) return options.filter((iso) => iso <= today).pop() || options[0]
  return options.find((iso) => daysBetween(today, iso) >= -14) || options[options.length - 1]
}

function withYear(month, day, yearText, today, past = false) {
  if (!yearText) return dateNoYear(month, day, today, past)
  const year = Number(yearText.length === 2 ? `20${yearText}` : yearText)
  return isoOf(year, month, day)
}

// 'Thu, Oct 8' (', 2027' when the year isn't today's).
export function dayLabel(iso, today = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return ''
  const [year, month, day] = iso.split('-').map(Number)
  return `${SHORT_DAYS[weekdayOf(iso)]}, ${SHORT_MONTHS[month - 1]} ${day}${today && String(year) !== today.slice(0, 4) ? `, ${year}` : ''}`
}

// Optimal string alignment distance (a swapped pair of letters counts once).
export function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
    }
  }
  return rows[a.length][b.length]
}

const isTomorrow = (word) => TOMORROW.has(word) || (word.length >= 6 && word.length <= 10 && word[0] === 't' && editDistance(word, 'tomorrow') <= 2)
const isYesterday = (word) => YESTERDAY.has(word) || (word.length >= 7 && word[0] === 'y' && editDistance(word, 'yesterday') <= 2)

// A full weekday name or a misspelling of one ('thrusday', 'wendsday', 'mondya', 'sundy'): its index, or
// -1. A typo must still end like a day ('subway', 'monkey', 'Freddy' don't).
function weekdayName(word) {
  const exact = WEEKDAYS.indexOf(word)
  if (exact >= 0) return exact
  if (word.length < 5 || !/(?:day|[^d]dy|dya)$/.test(word) || NOT_WEEKDAYS.has(word)) return -1
  if (WEEKDAYS.includes(word.replace(/s$/, ''))) return -1 // "Mondays" is a routine, not a day
  const close = WEEKDAYS.map((name, index) => ({ index, name, d: editDistance(word, name) }))
    .filter(({ name, d }) => name[0] === word[0] && (d <= 1 || (d <= 2 && word.length >= 6 && name.slice(0, 2) === word.slice(0, 2))))
  const best = Math.min(...close.map(({ d }) => d))
  const found = close.filter(({ d }) => d === best)
  return found.length === 1 ? found[0].index : -1
}

const TOKEN_RE = /\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\b\.?|[A-Za-z0-9]+(?:['’][A-Za-z]+)?|[.!?;]/g
const isTimeToken = (low) => /^\d{1,2}(:\d{2})?\s*[ap]\.?m\.?$/.test(low) || /^\d{1,2}:\d{2}/.test(low)
const dayNumber = (low) => (/^\d{1,2}(st|nd|rd|th)?$/.test(low) ? Number.parseInt(low, 10) : null)

function tokenize(text) {
  return [...String(text ?? '').matchAll(TOKEN_RE)].map((match) => ({
    raw: match[0],
    low: match[0].toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, ''),
    start: match.index,
    end: match.index + match[0].length,
  }))
}

// Where a weekday lands: plain = its next occurrence (today counts), 'next' = next week's (Mon–Sun),
// 'last' = the most recent before today.
function weekdayDate(index, modifier, today) {
  const ahead = (index - weekdayOf(today) + 7) % 7
  const upcoming = addDays(today, ahead)
  if (modifier === 'last') return { iso: addDays(today, -(((weekdayOf(today) - index + 7) % 7) || 7)), kind: 'past' }
  if (modifier === 'next') {
    const nextMonday = addDays(today, 7 - ((weekdayOf(today) + 6) % 7))
    const iso = addDays(nextMonday, (index + 6) % 7)
    return { iso, kind: 'weekday', alt: iso !== upcoming ? upcoming : undefined, altNote: 'next' }
  }
  return { iso: upcoming, kind: 'weekday', alt: ahead === 0 ? addDays(today, 7) : undefined, altNote: ahead === 0 ? 'today' : undefined }
}

// Every day word in the text, in order: [{ word, iso, kind, meaning?, typo?, alt?, altNote? }].
// kind: 'relative' (today, tomorrow…), 'weekday', 'past' (last Friday), 'date' (Oct 8, 10/8, the 8th).
export function resolveDayWords(text, { today } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) return []
  const tokens = tokenize(text)
  const found = []
  const add = (from, to, entry) => found.push({ word: String(text).slice(tokens[from].start, tokens[to].end), ...entry })
  const low = (index) => tokens[index]?.low ?? ''
  for (let i = 0; i < tokens.length; i += 1) {
    const word = low(i)
    // "(the) day after tomorrow" / "day before yesterday"
    if (word === 'day' && low(i + 1) === 'after' && isTomorrow(low(i + 2))) {
      const from = low(i - 1) === 'the' ? i - 1 : i
      add(from, i + 2, { iso: addDays(today, 2), kind: 'relative', meaning: 'the day after tomorrow', typo: low(i + 2) !== 'tomorrow' })
      i += 2
      continue
    }
    if (word === 'day' && low(i + 1) === 'before' && isYesterday(low(i + 2))) {
      const from = low(i - 1) === 'the' ? i - 1 : i
      add(from, i + 2, { iso: addDays(today, -2), kind: 'relative', meaning: 'the day before yesterday' })
      i += 2
      continue
    }
    if (TODAY.has(word)) { add(i, i, { iso: today, kind: 'relative', meaning: TODAY.get(word), typo: !['today', 'tonight', 'todays'].includes(word) }); continue }
    if (word === 'this' && ['morning', 'afternoon', 'evening'].includes(low(i + 1))) { add(i, i + 1, { iso: today, kind: 'relative', meaning: 'today' }); i += 1; continue }
    if (isTomorrow(word)) { add(i, i, { iso: addDays(today, 1), kind: 'relative', meaning: 'tomorrow', typo: word !== 'tomorrow' }); continue }
    if (isYesterday(word)) { add(i, i, { iso: addDays(today, -1), kind: 'relative', meaning: 'yesterday', typo: word !== 'yesterday' }); continue }
    if (word === 'in' && low(i + 2).replace(/s$/, '') === 'day') {
      const n = /^\d{1,2}$/.test(low(i + 1)) ? Number(low(i + 1)) : NUMBER_WORDS[low(i + 1)]
      if (n >= 1 && n <= 60) { add(i, i + 2, { iso: addDays(today, n), kind: 'relative', meaning: `in ${n} days` }); i += 2; continue }
    }
    // Weekdays: full names, typos, abbreviations; "this/next/last/on" in front.
    let index = weekdayName(word)
    let typo = index >= 0 && WEEKDAYS[index] !== word
    if (index < 0 && DAY_ABBREVS.has(word)) index = DAY_ABBREVS.get(word)
    if (index < 0 && SHY_ABBREVS.has(word)) {
      const before = low(i - 1)
      const after = low(i + 1)
      const raw = tokens[i].raw
      const sentenceStart = i === 0 || /^[.!?;]$/.test(tokens[i - 1].raw)
      // "Call Sun Life": a capitalised name, not Sunday.
      const capital = /^[A-Z]/.test(raw) && !sentenceStart && !/^[A-Z]/.test(tokens[i + 1]?.raw || '')
      const timeAfter = isTimeToken(after) || DAY_PARTS.has(after) || dayNumber(after) !== null || MONTH_WORDS.has(after) || (after === 'at' && (isTimeToken(low(i + 2)) || /^\d{1,2}$/.test(low(i + 2))))
      // "move it to Wed", "push to sat"; not "to sun" ("exposed to sun").
      const toDay = (before === 'to' || before === 'for') && word !== 'sun'
      if (!BEFORE_BAD.has(before) && (BEFORE_OK.has(before) || toDay || timeAfter || capital)) index = SHY_ABBREVS.get(word)
      typo = false
    }
    if (index >= 0 && ['every', 'each'].includes(low(i - 1))) continue // a routine, not a day
    if (index >= 0) {
      const before = low(i - 1)
      const modifier = before === 'next' ? 'next' : before === 'last' || (before === 'past' && low(i - 2) === 'this') ? 'last' : ''
      const from = before === 'past' && low(i - 2) === 'this' ? i - 2 : ['next', 'last', 'this', 'coming'].includes(before) ? i - 1 : i
      // "Thursday, Oct 8": the explicit date that follows is its own entry.
      add(from, i, { ...weekdayDate(index, modifier, today), meaning: WEEKDAYS[index], typo })
      continue
    }
    const past = [1, 2, 3, 4, 5].some((back) => PAST_BEFORE.has(low(i - back)))
    // "Oct 8", "October 8th, 2027"
    if (MONTH_WORDS.has(word) && dayNumber(low(i + 1)) !== null && !UNIT_AFTER.test(low(i + 2))) {
      const year = /^\d{4}$/.test(low(i + 2)) ? low(i + 2) : ''
      const iso = withYear(MONTH_WORDS.get(word) + 1, dayNumber(low(i + 1)), year, today, past)
      if (iso) { add(i, year ? i + 2 : i + 1, { iso, kind: 'date' }); i += year ? 2 : 1; continue }
    }
    // "8 Oct", "8th of October"
    if (dayNumber(word) !== null && (MONTH_WORDS.has(low(i + 1)) || (low(i + 1) === 'of' && MONTH_WORDS.has(low(i + 2))))) {
      const at = low(i + 1) === 'of' ? i + 2 : i + 1
      const year = /^\d{4}$/.test(low(at + 1)) ? low(at + 1) : ''
      const iso = withYear(MONTH_WORDS.get(low(at)) + 1, dayNumber(word), year, today, past)
      if (iso) { add(low(i - 1) === 'the' ? i - 1 : i, year ? at + 1 : at, { iso, kind: 'date' }); i = year ? at + 1 : at; continue }
    }
    // "10/8" (US month/day); not "1/2 cup", "3/4" or a score ("rated it 7/10").
    const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(word)
    if (slash) {
      const [month, day] = [Number(slash[1]), Number(slash[2])]
      const fraction = !slash[3] && day <= 8 && month < day
      const score = !slash[3] && (day === 10 || day === 5) && (/^(rated?|rating|score|scored|mood|energy|out|a|it|was|is)$/.test(low(i - 1)) || /^(rated?|rating|score|scored|mood|energy)$/.test(low(i - 2)))
      const iso = !fraction && !score && !UNIT_AFTER.test(low(i + 1)) ? withYear(month, day, slash[3] || '', today, past) : null
      if (iso) { add(i, i, { iso, kind: 'date' }); continue }
    }
    // "the 8th" (not "the 8th of October", handled above, or "the 8th floor"): this month, or next month
    // once it's past.
    if (word === 'the' && /^\d{1,2}(st|nd|rd|th)$/.test(low(i + 1)) && low(i + 2) !== 'of' && !MONTH_WORDS.has(low(i + 2)) && !NTH_NOUNS.has(low(i + 2).replace(/s$/, ''))) {
      const day = dayNumber(low(i + 1))
      const [year, month] = today.split('-').map(Number)
      let iso = isoOf(year, month, day)
      if (!iso || iso < today) iso = month === 12 ? isoOf(year + 1, 1, day) : isoOf(year, month + 1, day)
      if (iso) { add(i, i + 1, { iso, kind: 'date' }); i += 1; continue }
    }
  }
  return found
}

// The developer note for the newest message, or null when it names no day.
// 'Day words in the newest message: “tommorw” = tomorrow = Thu, Oct 8; “Thursday” = Thu, Oct 8. Today is Wed, Oct 7.'
export function dayHintNote(text, today) {
  const found = resolveDayWords(text, { today })
  if (!found.length) return null
  const seen = new Set()
  const parts = []
  for (const entry of found) {
    const key = entry.word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const weekday = entry.kind === 'weekday' || entry.kind === 'past' ? `${entry.meaning.charAt(0).toUpperCase()}${entry.meaning.slice(1)}` : ''
    const meaning = weekday ? (entry.typo ? ` = ${weekday}` : '') : entry.meaning && entry.meaning !== key ? ` = ${entry.meaning}` : ''
    const alt = !entry.alt ? '' : entry.altNote === 'today' ? ` (today; next week's is ${dayLabel(entry.alt, today)})` : ` (the ${weekday} of next week; could also mean ${dayLabel(entry.alt, today)})`
    const before = entry.kind === 'date' && entry.iso < today ? ' (in the past)' : ''
    parts.push(`“${entry.word}”${meaning} = ${dayLabel(entry.iso, today)}${before}${alt}`)
  }
  let note = `Day words in the newest message: ${parts.join('; ')}. Today is ${dayLabel(today, today)}.`
  if (new Set(found.map((entry) => entry.iso)).size > 1) note += ' These point to different days: if they are meant for the same thing, ask which one (show both dates) before changing anything; moving something from one of these days to another is fine.'
  if (found.some((entry) => entry.typo)) note += ' When you act on a misspelt day word, say how you read it (e.g. I read “tmrw” as tomorrow, Thu, Oct 8).'
  return note
}

// ---- the check on the assistant's own reply

const REL_WORDS = ['yesterday', 'today', 'tomorrow']
const WD_RE = '(?:(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?\\.?,?\\s+)?'
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DATE_RE = `(${WD_RE})(?:(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE}))(?:,?\\s+(\\d{4}))?(?![\\d:/])`
const AT_TIME = ',?\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?'
// "tomorrow, Oct 7." / "tomorrow (Wed, Oct 7)": the date as an aside right after the word (a comma or a
// bracket, nothing else), and it must end there (or go on with a time): "tomorrow, Oct 7 at 1:30 PM",
// but not "today, Oct 8 works better" or "(Oct 7–8)".
const REL_FIRST = new RegExp(`\\b(yesterday|today|tomorrow)(\\s*,\\s*|\\s*\\(\\s*)${DATE_RE}`, 'gi')
const AFTER_COMMA = new RegExp(`^(?:${AT_TIME}|\\s*$|[.,;!?)])`, 'i')
const AFTER_BRACKET = new RegExp(`^(?:${AT_TIME})?\\s*\\)`, 'i')
// "Oct 7 (tomorrow)": only in brackets, so a new sentence starting with "tomorrow" is never touched.
const REL_AFTER = new RegExp(`${DATE_RE}(\\s*\\(\\s*)(yesterday|today|tomorrow)(\\s*\\))`, 'gi')
// "the day after tomorrow, Fri", "a week from today (Wed, Oct 14)", "today and tomorrow (Oct 7–8)",
// "not today, Oct 8": the word is part of a longer phrase, so it's left alone.
const PHRASE_BEFORE = /\b(after|before|from|since|and|or|through|thru|than|not|of|but|between|&)\s*$/i

// The date a matched explicit date names, or null when it's unclear (an unknown month, or a weekday
// that disagrees with the date: then it's not clear which part is wrong).
function matchedDate(weekdayText, monthA, dayA, dayB, monthB, yearText, today) {
  const monthWord = String(monthA || monthB || '').toLowerCase().replace(/\.$/, '')
  const month = MONTH_WORDS.has(monthWord) ? MONTH_WORDS.get(monthWord) : MONTHS.findIndex((name) => monthWord.length >= 3 && name.startsWith(monthWord))
  if (month < 0) return null
  const iso = withYear(month + 1, Number(dayA || dayB), yearText || '', today)
  if (!iso) return null
  const weekday = String(weekdayText || '').trim().toLowerCase().replace(/[.,]/g, '')
  if (weekday && !WEEKDAYS[weekdayOf(iso)].startsWith(weekday.slice(0, 3))) return null
  return iso
}

const relWordFor = (iso, today) => REL_WORDS[daysBetween(today, iso) + 1] || ''
const sameCase = (word, like) => (/^[A-Z]/.test(like) ? word.charAt(0).toUpperCase() + word.slice(1) : word)

// What to change when a relative word and the date next to it disagree: { rel } (the word, trusting the
// date), { date } (the date, when the word's day is one this turn's calls set and the date's isn't), or
// null (leave it: they agree, no relative word fits the date, or it's unclear which one is meant).
function relFix(rel, iso, today, dates) {
  const relIso = addDays(today, REL_WORDS.indexOf(rel.toLowerCase()) - 1)
  if (relIso === iso) return null
  if (dates.has(relIso)) return dates.has(iso) ? null : { date: dayLabel(relIso, today) }
  const right = relWordFor(iso, today)
  return right ? { rel: right } : null
}

// Fixes "tomorrow, Oct 7" when Oct 7 is today: a relative word right next to an explicit date that
// disagrees with it becomes the right one ("today, Oct 7"); when the turn's calls set the word's day
// (`dates`, YYYY-MM-DD) the date is corrected instead, so the reply matches the card. Nothing else in
// the reply changes, and nothing is dropped.
export function fixRelativeDates(reply, today, { dates = [] } = {}) {
  if (typeof reply !== 'string' || !reply || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) return reply
  const set = new Set(dates)
  let out = reply.replace(REL_FIRST, (whole, rel, sep, wd, monthA, dayA, dayB, monthB, year, offset, text) => {
    const rest = text.slice(offset + whole.length)
    if (PHRASE_BEFORE.test(text.slice(0, offset)) || !(sep.includes('(') ? AFTER_BRACKET : AFTER_COMMA).test(rest)) return whole
    const iso = matchedDate(wd, monthA, dayA, dayB, monthB, year, today)
    const fix = iso && relFix(rel, iso, today, set)
    if (!fix) return whole
    return fix.rel ? `${sameCase(fix.rel, rel)}${whole.slice(rel.length)}` : `${rel}${sep}${fix.date}`
  })
  out = out.replace(REL_AFTER, (whole, wd, monthA, dayA, dayB, monthB, year, open, rel, close, offset, text) => {
    if (PHRASE_BEFORE.test(text.slice(0, offset))) return whole
    const iso = matchedDate(wd, monthA, dayA, dayB, monthB, year, today)
    const fix = iso && relFix(rel, iso, today, set)
    if (!fix) return whole
    const date = whole.slice(0, whole.length - open.length - rel.length - close.length)
    return fix.rel ? `${date}${open}${sameCase(fix.rel, rel)}${close}` : `${fix.date}${open}${rel}${close}`
  })
  return out
}

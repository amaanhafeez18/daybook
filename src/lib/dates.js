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

export function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseISO(value).getTime())
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

export function compareTimes(a, b) {
  const left = timeToMinutes(a)
  const right = timeToMinutes(b)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

export function formatDateShort(iso) {
  if (!isISODate(iso)) return iso || ''
  const date = parseISO(iso)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function formatDateLong(iso) {
  if (!isISODate(iso)) return iso || ''
  return parseISO(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatMonthYear(year, month) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

// "Today", "Tomorrow", "Yesterday", "Friday" (within the week ahead), otherwise "Sep 22".
export function relativeDay(iso, today = todayISO()) {
  if (!isISODate(iso)) return ''
  const delta = diffDays(today, iso)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta === -1) return 'Yesterday'
  if (delta > 1 && delta < 7) return parseISO(iso).toLocaleDateString(undefined, { weekday: 'long' })
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

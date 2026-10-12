// A voice chat ("talk") saved in the chat history: one assistant message per call, holding the
// transcript. A leaf module (no imports): api/assistant.js imports it to keep, show and replay talk
// messages, and api/_voice.js builds on it. Files starting with "_" are not deployed as functions.

// Talk ids are made by the phone when Talk is tapped.
export const TALK_ID_RE = /^talk_[a-z0-9]{8,32}$/

// Why a call ended (null while it is live).
export const TALK_END_REASONS = ['user', 'cap', 'daily', 'budget', 'quiet', 'background', 'interrupted', 'network', 'navigated', 'error']
export const TALK_MODES = ['open', 'hold']
export const TALK_INTENTS = ['chat', 'journal', 'debrief']
// Turn roles: u = spoken by the user, t = typed by the user in the call, a = Daybook's final answer.
export const TALK_ROLES = ['u', 't', 'a']

const MAX_TURNS = 150
const MAX_TURN_CHARS = 1500
const MAX_TOTAL_CHARS = 30000
const MAX_SECONDS = 6 * 3600
const MAX_SEGMENTS = 50
const MAX_USD = 1000

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isoOrNull = (value) => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null)
const clampNumber = (value, min, max, fallback) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const cut = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// One stored turn: { id, r, t, at? }, or null when it holds nothing.
function normalizeTurn(raw) {
  if (!isPlainObject(raw) || !TALK_ROLES.includes(raw.r)) return null
  const t = cut(raw.t, MAX_TURN_CHARS)
  if (!t) return null
  const at = isoOrNull(raw.at)
  return { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : '', r: raw.r, t, ...(at ? { at } : {}) }
}

// A talk as stored, bounded, or null when it isn't one. The oldest turns go first when there are too
// many (or too much text); `trimmed` counts them.
export function normalizeTalk(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !TALK_ID_RE.test(raw.id)) return null
  let turns = (Array.isArray(raw.turns) ? raw.turns : []).map(normalizeTurn).filter(Boolean)
  let trimmed = Math.round(clampNumber(raw.trimmed, 0, 1e6, 0))
  if (turns.length > MAX_TURNS) {
    trimmed += turns.length - MAX_TURNS
    turns = turns.slice(-MAX_TURNS)
  }
  let total = turns.reduce((sum, turn) => sum + turn.t.length, 0)
  while (total > MAX_TOTAL_CHARS && turns.length) {
    total -= turns[0].t.length
    turns = turns.slice(1)
    trimmed += 1
  }
  const startedAt = isoOrNull(raw.startedAt) || new Date().toISOString()
  return {
    id: raw.id,
    startedAt,
    endedAt: isoOrNull(raw.endedAt),
    seconds: Math.round(clampNumber(raw.seconds, 0, MAX_SECONDS, 0)),
    segments: Math.round(clampNumber(raw.segments, 1, MAX_SEGMENTS, 1)),
    mode: TALK_MODES.includes(raw.mode) ? raw.mode : 'open',
    intent: TALK_INTENTS.includes(raw.intent) ? raw.intent : 'chat',
    usd: Math.round(clampNumber(raw.usd, 0, MAX_USD, 0) * 10000) / 10000,
    end: TALK_END_REASONS.includes(raw.end) ? raw.end : null,
    turns,
    trimmed,
  }
}

// "Sun Oct 11" and "9:12 PM" in the user's time zone (UTC when it isn't a real zone).
function zoned(iso, timeZone) {
  const date = new Date(iso)
  const parts = (zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {})
  let p
  try {
    p = parts(timeZone || 'UTC')
  } catch {
    p = parts('UTC')
  }
  return { day: `${p.weekday} ${p.month} ${p.day}`, clock: `${p.hour}:${p.minute}`, period: String(p.dayPeriod || '').toUpperCase() }
}

const HEAD_CHARS = 600
const TAIL_CHARS = 2400

// The talk as text for the text assistant (its history and the summary):
// "[Voice chat Sun Oct 11, 9:12–9:23 PM, 11 min]\nUser: …\nDaybook: …". A long one keeps its start
// and its end. It only changes when the call does, so the history prefix stays cacheable.
export function talkHistoryText(talk, { timeZone } = {}) {
  const value = talk?.turns ? talk : normalizeTalk(talk)
  if (!value) return ''
  const start = zoned(value.startedAt, timeZone)
  const endIso = value.endedAt || (value.seconds ? new Date(Date.parse(value.startedAt) + value.seconds * 1000).toISOString() : null)
  let when = `${start.day}, ${start.clock} ${start.period}`
  if (endIso) {
    const end = zoned(endIso, timeZone)
    when = end.day !== start.day || end.period !== start.period
      ? `${start.day}, ${start.clock} ${start.period}–${end.clock} ${end.period}`
      : `${start.day}, ${start.clock}–${end.clock} ${end.period}`
  }
  const minutes = value.seconds ? Math.max(1, Math.round(value.seconds / 60)) : 0
  const header = `[Voice chat ${when}${minutes ? `, ${minutes} min` : ''}]`
  const lines = value.turns.map((turn) => `${turn.r === 'a' ? 'Daybook' : turn.r === 't' ? 'User (typed)' : 'User'}: ${turn.t.replace(/\s+/g, ' ')}`)
  let body = lines.join('\n') || '(nothing was said)'
  if (value.trimmed) body = `(earlier part not kept)\n${body}`
  if (body.length > HEAD_CHARS + TAIL_CHARS) body = `${body.slice(0, HEAD_CHARS)} … ${body.slice(-TAIL_CHARS)}`
  return `${header}\n${body}`
}

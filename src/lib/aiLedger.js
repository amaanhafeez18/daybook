// The AI cost ledger: what each AI feature cost, per local day, kept in
// assistant_conversations.usage.ai (api/_usage.js writes it). Shape:
//   { v: 1, since: 'YYYY-MM-DD',
//     days: { 'YYYY-MM-DD': { voice: { u, n, s, a }, chat: { u, n }, note: { u, n, s }, food: { u, n }, brief: { u, n } } },
//     months: { 'YYYY-MM': { …same buckets } },          // days older than the newest 62, rolled up; newest 13
//     talks: { '<talkId>': { day, model, u, s, billed, at, segs: { '<sessionId>': { day, model, mintedAt, maxSec, seq, u, s } } } },
//     unpriced: { '<model>': count } }
// u = micro-dollars (integers), n = uses, s = seconds, a = µ$ of voice hand-offs to the text
// assistant (already inside voice.u). Every function returns a new ledger and leaves its input alone.
// Pure module with zero imports (used by api/ and the app).

export const FEATURES = [
  { id: 'voice', label: 'Voice chats' },
  { id: 'chat', label: 'Assistant (typing)' },
  { id: 'note', label: 'Voice notes' },
  { id: 'food', label: 'Food AI' },
  { id: 'brief', label: 'Morning note' },
]
const FEATURE_IDS = FEATURES.map((feature) => feature.id)

const KEEP_DAYS = 62
const KEEP_MONTHS = 13
const KEEP_TALKS = 30
const SEGMENTS_FOR_MS = 24 * 60 * 60 * 1000 // a talk's segments are dropped a day after its last write
const BUDGET_WARN = 0.8 // the same as BUDGET_WARN in src/lib/voice/prefs.js (this module has no imports)
const VOICE_MEASURED_SEC = 20 * 60 // "your" voice cost a minute needs 20 minutes in the last 30 days
const CHAT_MEASURED_N = 30 // "your" cost a message needs 30 messages

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const whole = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
const usd = (u) => whole(u) / 1e6

// ---- Dates ----------------------------------------------------------------------------------------

// Today's date in a time zone, 'YYYY-MM-DD'. An unknown or missing zone → UTC.
export function localDay(timeZone, now = Date.now()) {
  const date = new Date(now)
  if (typeof timeZone === 'string' && timeZone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(date).map((part) => [part.type, part.value]))
      const day = `${parts.year}-${parts.month}-${parts.day}`
      if (isDay(day)) return day
    } catch {
      // unknown time zone: UTC below
    }
  }
  return date.toISOString().slice(0, 10)
}

const dayNumber = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86400000
const dayFromNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10)
const addDays = (day, n) => dayFromNumber(dayNumber(day) + n)
const daysInMonthOf = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate()
const monthAfter = (key) => {
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
const monthBefore = (key) => {
  const [y, m] = key.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// ---- Buckets --------------------------------------------------------------------------------------

function cleanBucket(raw) {
  const bucket = { u: whole(raw?.u), n: whole(raw?.n) }
  if (whole(raw?.s)) bucket.s = whole(raw.s)
  if (whole(raw?.a)) bucket.a = whole(raw.a)
  return bucket
}

function addBucket(bucket, { u = 0, n = 0, s = 0, a = 0 }) {
  const next = cleanBucket(bucket)
  next.u += whole(u)
  next.n += whole(n)
  if (whole(s) || next.s) next.s = (next.s || 0) + whole(s)
  if (whole(a) || next.a) next.a = (next.a || 0) + whole(a)
  return next
}

// Adds every bucket of `day` into `into` (a day or month object), → a new object.
function mergeBuckets(into, day) {
  const next = { ...(isObject(into) ? into : {}) }
  for (const [id, bucket] of Object.entries(isObject(day) ? day : {})) {
    if (FEATURE_IDS.includes(id) && isObject(bucket)) next[id] = addBucket(next[id], bucket)
  }
  return next
}

// ---- Ledger ---------------------------------------------------------------------------------------

export function emptyLedger(day) {
  return { v: 1, since: isDay(day) ? day : null, days: {}, months: {}, talks: {}, unpriced: {} }
}

// A stored ledger made safe to read and copy (anything malformed is dropped).
function ledgerOf(ai, day) {
  if (!isObject(ai)) return emptyLedger(day)
  const days = {}
  for (const [key, value] of Object.entries(isObject(ai.days) ? ai.days : {})) if (isDay(key) && isObject(value)) days[key] = { ...value }
  const months = {}
  for (const [key, value] of Object.entries(isObject(ai.months) ? ai.months : {})) if (/^\d{4}-\d{2}$/.test(key) && isObject(value)) months[key] = { ...value }
  const talks = {}
  for (const [key, value] of Object.entries(isObject(ai.talks) ? ai.talks : {})) {
    if (isObject(value)) talks[key] = { ...value, segs: isObject(value.segs) ? { ...value.segs } : {} }
  }
  const unpriced = {}
  for (const [key, value] of Object.entries(isObject(ai.unpriced) ? ai.unpriced : {})) if (whole(value)) unpriced[key] = whole(value)
  return { v: 1, since: isDay(ai.since) ? ai.since : isDay(day) ? day : null, days, months, talks, unpriced }
}

// Keeps the newest KEEP_DAYS days (older ones are added into their month) and KEEP_MONTHS months.
function rollUp(ai) {
  const keys = Object.keys(ai.days).sort()
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) {
    const month = key.slice(0, 7)
    ai.months[month] = mergeBuckets(ai.months[month], ai.days[key])
    delete ai.days[key]
  }
  const months = Object.keys(ai.months).sort()
  for (const key of months.slice(0, Math.max(0, months.length - KEEP_MONTHS))) delete ai.months[key]
  return ai
}

// One cost booked on a local day. feature: one of FEATURES, or 'voiceAsk' (a request handed from a
// voice chat to the text assistant: booked under voice as u and a, not counted as a call). Unknown
// features count as chat, so no spend is lost. unpricedModel: the model was priced at a fallback rate.
export function addToLedger(ai, { day, feature, micros = 0, n = 1, s = 0, a = 0, unpricedModel = null } = {}) {
  const date = isDay(day) ? day : localDay(null)
  const next = ledgerOf(ai, date)
  if (!next.since || date < next.since) next.since = date
  const handoff = feature === 'voiceAsk'
  const id = FEATURE_IDS.includes(feature) ? feature : handoff ? 'voice' : 'chat'
  const entry = handoff ? { u: micros, n: 0, s: 0, a: micros } : { u: micros, n, s, a }
  if (whole(entry.u) || whole(entry.n) || whole(entry.s) || whole(entry.a)) {
    next.days[date] = { ...(next.days[date] || {}), [id]: addBucket(next.days[date]?.[id], entry) }
  }
  if (typeof unpricedModel === 'string' && unpricedModel.trim()) {
    const model = unpricedModel.trim().slice(0, 60)
    if (next.unpriced[model] || Object.keys(next.unpriced).length < 10) next.unpriced[model] = (next.unpriced[model] || 0) + 1
  }
  return rollUp(next)
}

// Drops all but the newest KEEP_TALKS talks and the segments of talks idle for a day.
function pruneTalks(ai, now) {
  const entries = Object.entries(ai.talks).sort(([, x], [, y]) => (Number(y.at) || 0) - (Number(x.at) || 0))
  for (const [key] of entries.slice(KEEP_TALKS)) delete ai.talks[key]
  for (const [key, talk] of entries.slice(0, KEEP_TALKS)) {
    if (now - (Number(talk.at) || 0) > SEGMENTS_FOR_MS && Object.keys(talk.segs || {}).length) ai.talks[key] = { ...talk, segs: {} }
  }
  return ai
}

const toMs = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : Date.now()
}

// A voice call segment was minted (a new call, or "Continue"): billing for it starts at zero.
// mintedAt: ms or ISO; maxSec: the longest this segment may bill.
export function openTalkSegment(ai, { talkId, sessionId, day, model, mintedAt, maxSec } = {}) {
  const date = isDay(day) ? day : localDay(null)
  const next = ledgerOf(ai, date)
  if (typeof talkId !== 'string' || !talkId || typeof sessionId !== 'string' || !sessionId) return next
  const at = toMs(mintedAt)
  const talk = next.talks[talkId] || { day: date, model: String(model || ''), u: 0, s: 0, billed: false, segs: {} }
  next.talks[talkId] = {
    ...talk,
    at,
    // A segment already opened keeps what it has billed (opening it again never resets it).
    segs: { ...talk.segs, [sessionId]: talk.segs?.[sessionId] || { day: date, model: String(model || talk.model || ''), mintedAt: at, maxSec: whole(maxSec), seq: 0, u: 0, s: 0 } },
  }
  return pruneTalks(next, at)
}

// A checkpoint's cumulative totals for one segment (micros and seconds so far). Bills only what is
// new since that segment's last checkpoint, so repeating a checkpoint never double counts; an older
// or repeated seq is skipped. The call is counted (voice.n) on its first bill.
// → { ai, deltaMicros, deltaSeconds, skipped: false | 'unknown' | 'seq' }
export function billTalk(ai, { talkId, sessionId, seq, micros = 0, seconds = 0, now = Date.now() } = {}) {
  const next = ledgerOf(ai, null)
  const talk = next.talks[talkId]
  const seg = talk?.segs?.[sessionId]
  if (!isObject(seg)) return { ai: next, deltaMicros: 0, deltaSeconds: 0, skipped: 'unknown' }
  const step = whole(seq)
  if (step <= whole(seg.seq)) return { ai: next, deltaMicros: 0, deltaSeconds: 0, skipped: 'seq' }
  const totalMicros = whole(micros)
  const totalSeconds = whole(seconds)
  const deltaMicros = Math.max(0, totalMicros - whole(seg.u))
  const deltaSeconds = Math.max(0, totalSeconds - whole(seg.s))
  const first = !talk.billed && (deltaMicros > 0 || deltaSeconds > 0)
  next.talks[talkId] = {
    ...talk,
    u: whole(talk.u) + deltaMicros,
    s: whole(talk.s) + deltaSeconds,
    billed: Boolean(talk.billed || first),
    at: now,
    segs: { ...talk.segs, [sessionId]: { ...seg, seq: step, u: Math.max(whole(seg.u), totalMicros), s: Math.max(whole(seg.s), totalSeconds) } },
  }
  let out = next
  if (deltaMicros || deltaSeconds || first) {
    out = addToLedger(next, { day: isDay(seg.day) ? seg.day : talk.day, feature: 'voice', micros: deltaMicros, n: first ? 1 : 0, s: deltaSeconds })
  }
  return { ai: pruneTalks(out, now), deltaMicros, deltaSeconds, skipped: false }
}

// ---- Summary --------------------------------------------------------------------------------------

function emptyByFeature() {
  return Object.fromEntries(FEATURE_IDS.map((id) => [id, { usd: 0, n: 0, seconds: 0, handoffUsd: 0 }]))
}

// Sums day/month objects into { total, byFeature } (byFeature: { [id]: { usd, n, seconds, handoffUsd } }).
function totalOf(list) {
  const sums = Object.fromEntries(FEATURE_IDS.map((id) => [id, { u: 0, n: 0, s: 0, a: 0 }]))
  for (const entry of list) {
    for (const id of FEATURE_IDS) {
      const bucket = entry?.[id]
      if (!isObject(bucket)) continue
      sums[id].u += whole(bucket.u)
      sums[id].n += whole(bucket.n)
      sums[id].s += whole(bucket.s)
      sums[id].a += whole(bucket.a)
    }
  }
  const byFeature = emptyByFeature()
  let total = 0
  for (const id of FEATURE_IDS) {
    byFeature[id] = { usd: usd(sums[id].u), n: sums[id].n, seconds: sums[id].s, handoffUsd: usd(sums[id].a) }
    total += sums[id].u
  }
  return { total: usd(total), byFeature, micros: total }
}

// Totals of the kept days from `from` to `to` (inclusive, 'YYYY-MM-DD').
// → { total, byFeature: { [id]: { usd, n, seconds, handoffUsd } } }
export function totalsBetween(ai, from, to) {
  const ledger = ledgerOf(ai, null)
  const { total, byFeature } = totalOf(Object.entries(ledger.days).filter(([key]) => key >= from && key <= to).map(([, value]) => value))
  return { total, byFeature }
}

// Where the month is heading, in US$: spent + a daily average × the days left. From day 7 the
// average is this month's; before that it's the last 7 days (which reach into last month).
// last7Usd: the last 7 days' totals, today included. No spending at all → spent.
export function projectMonth({ spent = 0, dayOfMonth = 1, daysInMonth = 30, last7Usd = [] } = {}) {
  const left = Math.max(0, daysInMonth - dayOfMonth)
  const week = (Array.isArray(last7Usd) ? last7Usd : []).reduce((sum, value) => sum + (Number(value) > 0 ? Number(value) : 0), 0)
  if (!(spent > 0) && !(week > 0)) return Math.max(0, Number(spent) || 0)
  const avg = dayOfMonth >= 7 ? spent / dayOfMonth : week / 7
  return spent + avg * left
}

// Everything Settings, the usage sheet, the voice mint and the ai_usage tool show. today: the
// user's local date. budgetUsd: 0 = no budget. A missing ledger reads as no spending yet.
// last30 is oldest first and zero-filled; its byFeature holds US$ per feature.
export function summarizeLedger(ai, { today, budgetUsd = 0, now = Date.now(), warnAt = BUDGET_WARN } = {}) {
  const day = isDay(today) ? today : localDay(null, now)
  const ledger = ledgerOf(ai, null)
  const monthKey = day.slice(0, 7)
  const lastMonthKey = monthBefore(monthKey)
  const daysOf = (prefix) => Object.entries(ledger.days).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value)

  const todayTotals = totalOf([ledger.days[day]])
  const month = totalOf([...daysOf(monthKey), ledger.months[monthKey]])
  const lastMonth = totalOf([...daysOf(lastMonthKey), ledger.months[lastMonthKey]])

  const last30 = []
  for (let i = 29; i >= 0; i -= 1) {
    const key = addDays(day, -i)
    const totals = totalOf([ledger.days[key]])
    last30.push({ day: key, usd: totals.total, byFeature: Object.fromEntries(FEATURE_IDS.map((id) => [id, totals.byFeature[id].usd])) })
  }
  const recent = totalOf(last30.map((entry) => ledger.days[entry.day]))
  const voice = recent.byFeature.voice
  const chat = recent.byFeature.chat
  const activeDays = last30.filter((entry) => entry.usd > 0).length
  // Days the averages cover: since tracking began, at most 30.
  const tracked = ledger.since && ledger.since <= day ? Math.min(30, dayNumber(day) - dayNumber(ledger.since) + 1) : 0

  const dayOfMonth = Number(day.slice(8, 10))
  const daysInMonth = daysInMonthOf(day)
  const projected = projectMonth({ spent: month.total, dayOfMonth, daysInMonth, last7Usd: last30.slice(-7).map((entry) => entry.usd) })

  const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : 0
  const pct = budget ? month.micros / (budget * 1e6) : 0
  const state = !budget ? 'none' : pct >= 1 ? 'over' : pct >= warnAt ? 'warn' : 'ok'

  return {
    available: true,
    since: ledger.since,
    today: { total: todayTotals.total, byFeature: todayTotals.byFeature },
    month: {
      key: monthKey,
      total: month.total,
      byFeature: month.byFeature,
      voiceMinutes: Math.round((month.byFeature.voice.seconds / 60) * 10) / 10,
      calls: month.byFeature.voice.n,
    },
    lastMonth: { key: lastMonthKey, total: lastMonth.total, byFeature: lastMonth.byFeature },
    last30,
    projected,
    dayOfMonth,
    daysInMonth,
    budget: { usd: budget, spent: month.total, pct, state, resetsOn: `${monthAfter(monthKey)}-01` },
    voiceSecondsToday: todayTotals.byFeature.voice.seconds,
    perUnit: {
      voicePerMin: voice.seconds >= VOICE_MEASURED_SEC ? voice.usd / (voice.seconds / 60) : null,
      avgCallMinutes: voice.seconds >= VOICE_MEASURED_SEC && voice.n ? voice.seconds / 60 / voice.n : null,
      chatPerMsg: chat.n >= CHAT_MEASURED_N ? chat.usd / chat.n : null,
    },
    // The calculator's "Use my averages" (enabled from 3 days of data).
    averages: {
      days: activeDays,
      voiceMinutesPerDay: tracked ? voice.seconds / 60 / tracked : 0,
      callMinutes: voice.n ? voice.seconds / 60 / voice.n : null,
      chatPerDay: tracked ? chat.n / tracked : 0,
      usdPerDay: tracked ? recent.total / tracked : 0,
    },
    unpriced: Object.keys(ledger.unpriced),
  }
}

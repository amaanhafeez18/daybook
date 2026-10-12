// What Daybook's AI features cost: OpenAI prices, cost from the usage OpenAI reports with each reply,
// the Settings calculator's estimates and money formatting. Used by api/ (metering, the voice mint,
// the ai_usage tool) and by the app (live call cost, Settings → Voice & AI cost).
// Pure module with zero imports. Costs are in micro-dollars (µ$, integers) unless a name says usd.

export const PRICES_CHECKED = '2026-10-12'

// US$ per 1M tokens (developers.openai.com/api/docs/pricing, checked on PRICES_CHECKED).
const REALTIME_MINI = { textIn: 0.60, textCached: 0.06, audioIn: 10, audioCached: 0.30, textOut: 2.40, audioOut: 20 }
const REALTIME_FULL = { textIn: 4, textCached: 0.40, audioIn: 32, audioCached: 0.40, textOut: 24, audioOut: 64 }
export const REALTIME_PRICES = {
  'gpt-realtime-2.1-mini': REALTIME_MINI,
  'gpt-realtime-mini': REALTIME_MINI,
  'gpt-realtime-2.1': REALTIME_FULL,
  'gpt-realtime-2': REALTIME_FULL,
  // The older full models charge less for text out.
  'gpt-realtime-1.5': { ...REALTIME_FULL, textOut: 16 },
  'gpt-realtime': { ...REALTIME_FULL, textOut: 16 },
}

// cacheWrite: GPT-5.6 and later charge 1.25× the input rate for the input tokens they first store
// in the prompt cache (usage.input_tokens_details.cache_write_tokens). Models without it bill those
// tokens as ordinary input.
export const TEXT_PRICES = {
  'gpt-5-mini': { in: 0.25, cached: 0.025, out: 2.00 },
  'gpt-5-nano': { in: 0.05, cached: 0.005, out: 0.40 },
  'gpt-5.4-mini': { in: 0.75, cached: 0.075, out: 4.50 },
  'gpt-5.4-nano': { in: 0.20, cached: 0.02, out: 1.25 },
  'gpt-5.6-luna': { in: 0.20, cached: 0.02, cacheWrite: 0.25, out: 1.20 },
  'gpt-5.6-terra': { in: 2, cached: 0.20, cacheWrite: 2.50, out: 12 },
  'gpt-6-luna': { in: 0.10, cached: 0.01, cacheWrite: 0.125, out: 0.50 },
  'gpt-6-sol': { in: 2, cached: 0.20, cacheWrite: 2.50, out: 10 },
  'gpt-6.1-sol': { in: 2, cached: 0.10, cacheWrite: 2.50, out: 10 },
  'gpt-4.1-mini': { in: 0.40, cached: 0.10, out: 1.60 },
}

// US$ per minute of audio.
export const TRANSCRIBE_PER_MIN = {
  'gpt-transcribe': 0.0045,
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
  'gpt-live-transcribe': 0.017,
  'gpt-realtime-whisper': 0.017,
}

// Models billed by tokens (their usage comes back as { type: 'tokens', input_tokens, output_tokens }),
// US$ per 1M tokens. With that usage they are priced exactly instead of from TRANSCRIBE_PER_MIN.
export const TRANSCRIBE_TOKEN_PRICES = {
  'gpt-4o-mini-transcribe': { in: 1.25, out: 5 },
  'gpt-4o-transcribe': { in: 2.5, out: 10 },
}

export const WEB_SEARCH_PER_CALL = 0.01 // US$ per hosted web_search call (its content tokens are in the usage)

// An unknown model is priced like these and flagged `unpriced`.
export const FALLBACK = { text: 'gpt-5-mini', realtime: 'gpt-realtime-2.1-mini', transcribe: 'gpt-transcribe' }

export const micros = (usd) => Math.round(usd * 1e6)
export const dollars = (u) => u / 1e6

// A count from OpenAI's usage: a finite number ≥ 0, else 0 (missing, NaN, negative, text).
const count = (value) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

// The price table key for a model id: the id itself, or the id without a dated snapshot suffix
// (gpt-5-mini-2025-08-07 → gpt-5-mini). null when the table doesn't know it.
export function priceKey(model, table) {
  const id = String(model ?? '').trim().toLowerCase()
  if (!id || !table) return null
  if (Object.hasOwn(table, id)) return id
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return Object.hasOwn(table, base) ? base : null
}

// ---- Realtime (voice chat) ------------------------------------------------------------------------

export function emptyTally() {
  return { responses: 0, textIn: 0, textCached: 0, audioIn: 0, audioCached: 0, textOut: 0, audioOut: 0 }
}

// Adds one `response.done` usage to the tally (updated in place and returned; a missing tally starts
// a new one). reasoning_tokens are already inside the output text_tokens, so they are never added
// again; cached counts are capped at their totals.
export function addRealtimeUsage(tally, usage) {
  const base = tally && typeof tally === 'object' ? tally : emptyTally()
  for (const key of Object.keys(emptyTally())) base[key] = count(base[key])
  if (!usage || typeof usage !== 'object') return base
  const input = usage.input_token_details || {}
  const cached = input.cached_tokens_details || {}
  const output = usage.output_token_details || {}
  const textIn = count(input.text_tokens)
  const audioIn = count(input.audio_tokens)
  base.textIn += textIn
  base.textCached += Math.min(textIn, count(cached.text_tokens))
  base.audioIn += audioIn
  base.audioCached += Math.min(audioIn, count(cached.audio_tokens))
  base.textOut += count(output.text_tokens)
  base.audioOut += count(output.audio_tokens)
  base.responses += 1
  return base
}

// A realtime tally → { micros, unpriced }.
export function tallyCost(tally, model) {
  const key = priceKey(model, REALTIME_PRICES)
  const p = REALTIME_PRICES[key || FALLBACK.realtime]
  const t = tally && typeof tally === 'object' ? tally : {}
  const textIn = count(t.textIn)
  const textCached = Math.min(textIn, count(t.textCached))
  const audioIn = count(t.audioIn)
  const audioCached = Math.min(audioIn, count(t.audioCached))
  const value = (textIn - textCached) * p.textIn + textCached * p.textCached
    + (audioIn - audioCached) * p.audioIn + audioCached * p.audioCached
    + count(t.textOut) * p.textOut + count(t.audioOut) * p.audioOut
  return { micros: Math.round(value), unpriced: !key }
}

// ---- Text (Responses API) -------------------------------------------------------------------------

// usage: { input, cached, writes, output } (Daybook's debug shape) or OpenAI's own
// { input_tokens, input_tokens_details: { cached_tokens, cache_write_tokens }, output_tokens }.
// Cache writes are part of the uncached input, billed at the model's cacheWrite rate (its input
// rate when it has none). → { micros, unpriced }
export function textCost(usage, model, { webCalls = 0 } = {}) {
  const key = priceKey(model, TEXT_PRICES)
  const p = TEXT_PRICES[key || FALLBACK.text]
  const u = usage && typeof usage === 'object' ? usage : {}
  const input = count(u.input ?? u.input_tokens)
  const cached = Math.min(input, count(u.cached ?? u.input_tokens_details?.cached_tokens))
  const writes = Math.min(input - cached, count(u.writes ?? u.input_tokens_details?.cache_write_tokens))
  const output = count(u.output ?? u.output_tokens)
  const value = (input - cached - writes) * p.in + cached * p.cached + writes * (p.cacheWrite ?? p.in) + output * p.out
    + Math.floor(count(webCalls)) * WEB_SEARCH_PER_CALL * 1e6
  return { micros: Math.round(value), unpriced: !key }
}

// ---- Transcription --------------------------------------------------------------------------------

// seconds of audio, or OpenAI's transcription usage: { type: 'duration', seconds } or
// { type: 'tokens', input_tokens, output_tokens, input_token_details: { audio_tokens } }.
// Token usage from a model in TRANSCRIBE_TOKEN_PRICES is priced exactly from its tokens (seconds
// stays as given). For any other model it is turned into seconds at ≈ 10 audio tokens a second
// (undocumented, so that one is an estimate). → { micros, seconds, estimated, unpriced }
export function transcriptionCost({ seconds = 0, usage = null } = {}, model) {
  let secs = count(seconds)
  const tokenKey = priceKey(model, TRANSCRIBE_TOKEN_PRICES)
  if (usage?.type === 'tokens' && tokenKey) {
    const p = TRANSCRIBE_TOKEN_PRICES[tokenKey]
    const value = count(usage.input_tokens) * p.in + count(usage.output_tokens) * p.out
    return { micros: Math.round(value), seconds: secs, estimated: false, unpriced: false }
  }
  const key = priceKey(model, TRANSCRIBE_PER_MIN)
  const rate = TRANSCRIBE_PER_MIN[key || FALLBACK.transcribe]
  let estimated = false
  if (usage?.type === 'duration') secs = count(usage.seconds)
  else if (usage?.type === 'tokens') {
    secs = count(usage.input_token_details?.audio_tokens ?? usage.input_tokens) / 10
    estimated = true
  }
  return { micros: Math.round((secs / 60) * rate * 1e6), seconds: secs, estimated, unpriced: !key }
}

// A call's transcription token usage summed: { in, out, audio } (updated in place and returned; a
// missing one starts a new one). For realtime transcription models billed by tokens.
export function addTranscriptionTokens(tokens, usage) {
  const base = tokens && typeof tokens === 'object' ? tokens : { in: 0, out: 0, audio: 0 }
  for (const key of ['in', 'out', 'audio']) base[key] = count(base[key])
  if (!usage || typeof usage !== 'object') return base
  base.in += count(usage.input_tokens)
  base.out += count(usage.output_tokens)
  base.audio += count(usage.input_token_details?.audio_tokens)
  return base
}

// Summed transcription tokens ({ in, out, audio }) → transcriptionCost of them as one usage.
export function transcriptionTokensCost(tokens, model) {
  const t = tokens && typeof tokens === 'object' ? tokens : {}
  const usage = { type: 'tokens', input_tokens: count(t.in), output_tokens: count(t.out), input_token_details: { audio_tokens: Math.min(count(t.audio), count(t.in)) } }
  return transcriptionCost({ usage }, model)
}

// ---- Estimates (Settings calculator) --------------------------------------------------------------

// One voice call on gpt-realtime-2.1-mini, in US$. Fitted to the cost model (90% of the context
// cached; every reply re-reads the whole call, so longer calls cost more a minute):
// $0.071 at 2.5 min, $0.40 at 10, $0.72 at 15, $1.11 at 20. Checked against the owner's first real
// calls (OpenAI bill, 2026-10-12): a 4.6-min call came to $0.136 against $0.145 estimated.
export function sessionEstimate(minutes) {
  const m = count(minutes)
  return m * (0.0247 + 0.00154 * m)
}

// The range around the typical estimate: quieter calls with short replies, up to talkative ones. Spoken
// audio IS cached on re-reads (the 2026-10-12 bill: 85% of the calls' audio input billed at the cached
// rate), so the earlier 3.5× "audio not cached" top end no longer applies.
const RANGE_LOW = 0.5
const RANGE_HIGH = 2
// Once voice is priced from their own calls (k already carries the real caching), only day-to-day
// spread is left, so the range narrows.
const MEASURED_LOW = 0.8
const MEASURED_HIGH = 1.5
// A typical typed message to the assistant, in US$, at list price: about $0.0018 on gpt-5-mini and
// $0.0006 on gpt-6-luna (model evaluation, 2026-10-12), more for web lookups.
const CHAT_PER_MESSAGE = 0.002
const DAYS = 30

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// A month of use in US$. measured (summarizeLedger's perUnit): { voicePerMin, avgCallMinutes,
// chatPerMsg }; each one that isn't null replaces the typical figure ("yours").
// → { total, low, high, voice, chat, basis: { voice: 'yours'|'typical', chat: 'yours'|'typical' } }
export function estimateMonth({ voiceMinutesPerDay = 0, callMinutes = 15, chatPerDay = 0, measured = {} } = {}) {
  const minutes = count(voiceMinutesPerDay)
  const call = count(callMinutes) || 15
  const m = measured && typeof measured === 'object' ? measured : {}
  let k = 1
  const voicePerMin = count(m.voicePerMin)
  if (voicePerMin) {
    // Compare like with like: the model's cost a minute at the calls they actually make.
    const usual = count(m.avgCallMinutes) || call
    k = clamp(voicePerMin / (sessionEstimate(usual) / usual), 0.3, 5)
  }
  const chatPerMsg = count(m.chatPerMsg) || CHAT_PER_MESSAGE
  const voice = minutes ? DAYS * (minutes / call) * sessionEstimate(call) * k : 0
  const chat = DAYS * count(chatPerDay) * chatPerMsg
  const [lo, hi] = voicePerMin ? [MEASURED_LOW, MEASURED_HIGH] : [RANGE_LOW, RANGE_HIGH]
  return {
    total: voice + chat,
    low: voice * lo + chat,
    high: voice * hi + chat,
    voice,
    chat,
    basis: { voice: voicePerMin ? 'yours' : 'typical', chat: count(m.chatPerMsg) ? 'yours' : 'typical' },
  }
}

// The most voice can cost in a month at these limits, in US$: expected (typical calls), worst (every
// call talkative) and capped (worst, but never past the budget; 0 = no budget).
// At the defaults (30 min a day, 15-min calls, $20): about $43, $86 and $20.
export function capCeiling({ dailyMinutes = 30, sessionMinutes = 15, budgetUsd = 0 } = {}) {
  const session = count(sessionMinutes) || 15
  const expected = DAYS * (count(dailyMinutes) / session) * sessionEstimate(session)
  const worst = expected * RANGE_HIGH
  const budget = count(budgetUsd)
  return { expected, worst, capped: budget ? Math.min(worst, budget) : worst }
}

// The words after a capCeiling amount: none when the budget is what stops it (the real ceiling),
// else ', if every call is a long, talkative one'. → '' or that phrase
export function worstCaveat(ceiling, budgetUsd = 0) {
  const budget = count(budgetUsd)
  return budget && count(ceiling?.capped) >= budget ? '' : ', if every call is a long, talkative one'
}

// ---- Formatting -----------------------------------------------------------------------------------

const grouped = (whole) => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// '<$0.01' · '$0.13' · '$12.40' · '$1,240'. With { cents: true }, amounts under $1 read as cents
// ('9¢', '<1¢') — the live call cost.
export function formatUsd(usd, { cents = false } = {}) {
  const value = count(usd)
  if (cents && value < 0.995) {
    if (value > 0 && value < 0.005) return '<1¢'
    return `${Math.round(value * 100)}¢`
  }
  if (value > 0 && value < 0.005) return '<$0.01'
  if (value >= 999.995) return `$${grouped(Math.round(value))}`
  const [whole, fraction] = value.toFixed(2).split('.')
  return `$${grouped(whole)}.${fraction}`
}

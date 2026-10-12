// The AI cost ledger and the assistant's daily message count, both in
// assistant_conversations.usage (no migration: the column is from 2026-09-23-auth-hardening.sql):
//   { date, count,   // the assistant's UTC daily message cap (unchanged)
//     rev,           // compare-and-swap counter: every write here is rev + 1
//     ai }           // the ledger (src/lib/aiLedger.js)
// mutateUsage is the only writer of `usage`. It never touches updated_at (the messages' CAS key) and
// never throws: a failed write is logged and the user's request carries on. Callers race the writes
// against raceTimeout (1.5 s). Without the column everything here is a no-op ({ available: false }).
// Files starting with "_" are not deployed as their own serverless functions. No browser code here.
import { randomUUID } from 'node:crypto'
import { FALLBACK, formatUsd, textCost, transcriptionCost } from '../src/lib/aiPricing.js'
import { FEATURES, addToLedger, billTalk, emptyLedger, localDay, openTalkSegment, summarizeLedger, totalsBetween } from '../src/lib/aiLedger.js'
import { budgetUsd as budgetOf } from '../src/lib/voice/prefs.js'

const TABLE = 'assistant_conversations'
const ATTEMPTS = 4
const NOTE_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe' // what api/_openai.js transcribes voice notes with by default

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// No `usage` column: Postgres 42703 on a read, PostgREST PGRST204 on a write.
function missingColumn(error) {
  const code = String(error?.code || '')
  return code === '42703' || code === 'PGRST204' || (/usage/.test(String(error?.message || '')) && /column/i.test(String(error?.message || '')) && /does not exist|could not find/i.test(String(error?.message || '')))
}

function logFailure(what, error) {
  try {
    console.error(`Usage ${what} failed:`, String(error?.message || error).slice(0, 200))
  } catch {
    // logging never matters more than the request
  }
}

// A promise settled within `ms`: its result, or `fallback` when it takes longer or rejects.
export function raceTimeout(promise, ms = 1500, fallback = { ok: false, timeout: true }) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch((error) => ({ ok: false, error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// Reads `usage`, applies fn(copy of it) → fields to change (null = nothing to write), and writes
// { ...usage, ...fields, rev: rev + 1 } only if nobody else wrote in between (else re-reads and
// tries again, up to 4 times). A missing row is created.
// → { ok, available, usage } (usage = what is stored now; ok false = not written)
export async function mutateUsage(supabase, userId, fn, { attempts = ATTEMPTS } = {}) {
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt) await sleep(30 + Math.floor(Math.random() * 90))
      const { data, error } = await supabase.from(TABLE).select('usage').eq('user_id', userId).maybeSingle()
      if (error) {
        if (missingColumn(error)) return { ok: false, available: false, usage: null }
        throw error
      }
      const prev = isObject(data?.usage) ? data.usage : {}
      const fields = fn(structuredClone(prev))
      if (fields === null || fields === undefined) return { ok: true, available: true, usage: prev, unchanged: true }
      const rev = Number.isInteger(prev.rev) ? prev.rev : null
      const next = { ...prev, ...fields, rev: (rev ?? 0) + 1 }

      if (!data) {
        const { error: insertError } = await supabase.from(TABLE).insert({ id: randomUUID(), user_id: userId, messages: [], usage: next })
        if (!insertError) return { ok: true, available: true, usage: next }
        if (missingColumn(insertError)) return { ok: false, available: false, usage: null }
        if (insertError.code === '23505') continue // created meanwhile by another request
        throw insertError
      }
      let query = supabase.from(TABLE).update({ usage: next }).eq('user_id', userId)
      query = rev === null ? query.is('usage->>rev', null) : query.eq('usage->>rev', String(rev))
      const { data: rows, error: updateError } = await query.select('user_id')
      if (updateError) {
        if (missingColumn(updateError)) return { ok: false, available: false, usage: null }
        throw updateError
      }
      if (rows?.length) return { ok: true, available: true, usage: next }
      // Zero rows: someone else wrote since the read. Read again.
    }
    logFailure('write', 'still conflicting after retries')
    return { ok: false, available: true, usage: null, conflict: true }
  } catch (error) {
    logFailure('write', error)
    return { ok: false, available: true, usage: null, error }
  }
}

// → { available, ai, usage } (ai null when nothing is recorded yet). Unreadable → available false.
export async function readLedger(supabase, userId) {
  try {
    const { data, error } = await supabase.from(TABLE).select('usage').eq('user_id', userId).maybeSingle()
    if (error) {
      if (!missingColumn(error)) logFailure('read', error)
      return { available: false, ai: null, usage: null }
    }
    const usage = isObject(data?.usage) ? data.usage : {}
    return { available: true, ai: isObject(usage.ai) ? usage.ai : null, usage }
  } catch (error) {
    logFailure('read', error)
    return { available: false, ai: null, usage: null }
  }
}

const dayOr = (day) => (isDay(day) ? day : localDay(null))

// Books costs on the user's local `day`. entries: [{ feature, micros, n?, s?, a?, unpricedModel? }]
// (feature 'voiceAsk' = a voice chat's hand-off to the text assistant). → { ok }
export async function recordUsage(supabase, userId, entries, { day } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry) && (entry.micros > 0 || entry.n > 0 || entry.s > 0 || entry.unpricedModel))
  if (!list.length || !userId) return { ok: true, skipped: true }
  const date = dayOr(day)
  const result = await mutateUsage(supabase, userId, (usage) => ({
    ai: list.reduce((ai, entry) => addToLedger(ai, { ...entry, day: date }), isObject(usage.ai) ? usage.ai : emptyLedger(date)),
  }))
  return { ok: result.ok, available: result.available }
}

// A voice call segment was minted. args: { talkId, sessionId, day, model, mintedAt, maxSec } → { ok }
export async function recordTalkSegment(supabase, userId, args = {}) {
  const date = dayOr(args.day)
  const result = await mutateUsage(supabase, userId, (usage) => ({
    ai: openTalkSegment(isObject(usage.ai) ? usage.ai : emptyLedger(date), { ...args, day: date }),
  }))
  return { ok: result.ok, available: result.available }
}

// A checkpoint's cumulative cost and seconds for one segment; only what's new is billed.
// → { ok, available, ai, deltaMicros, deltaSeconds, skipped: false|'unknown'|'seq' }
// ('unknown': no such segment was minted, or it was pruned; nothing written.)
export async function recordTalk(supabase, userId, { talkId, sessionId, seq, micros, seconds } = {}) {
  let bill = { deltaMicros: 0, deltaSeconds: 0, skipped: 'unknown' }
  const result = await mutateUsage(supabase, userId, (usage) => {
    bill = billTalk(usage.ai, { talkId, sessionId, seq, micros, seconds })
    return bill.skipped ? null : { ai: bill.ai }
  })
  const ai = isObject(result.usage?.ai) ? result.usage.ai : null
  return { ok: result.ok && !bill.skipped, available: result.available, ai, deltaMicros: bill.deltaMicros, deltaSeconds: bill.deltaSeconds, skipped: bill.skipped }
}

// The assistant's daily message count (UTC usageDate), keeping the ledger. → { ok, error? }
export async function bumpMessageCount(supabase, userId, usageDate) {
  const result = await mutateUsage(supabase, userId, (usage) => ({
    date: usageDate,
    count: (usage.date === usageDate ? Number(usage.count) || 0 : 0) + 1,
  }))
  if (result.ok) return { ok: true }
  return { ok: false, error: result.error || new Error(result.available === false ? 'No usage column.' : 'The usage count couldn’t be saved.') }
}

// Ledger entries for what a request's debug log says it used: every 'openai.response' (model, usage,
// webCalls) as one `feature` entry, and every 'openai.transcribe' as a voice note. Consumed debug
// items are marked `metered: true`, so a second call (a stream's late history fold) only books what
// is new; the use itself (n) is counted on the first call that books anything.
export function usageFromDebug(debug, { feature = 'chat' } = {}) {
  if (!Array.isArray(debug)) return []
  const entries = []
  let micros = 0
  let responses = 0
  let counted = false
  const unpriced = new Set()
  for (const item of debug) {
    if (!isObject(item)) continue
    if (item.step === 'openai.response') {
      if (item.metered) {
        counted = true
        continue
      }
      item.metered = true
      if (!item.usage) continue
      const webCalls = Number.isFinite(item.webCalls) ? item.webCalls : (Array.isArray(item.outputTypes) ? item.outputTypes.filter((type) => type === 'web_search_call').length : 0)
      const cost = textCost(item.usage, item.model || FALLBACK.text, { webCalls })
      if (cost.unpriced && item.model) unpriced.add(String(item.model))
      micros += cost.micros
      responses += 1
    } else if (item.step === 'openai.transcribe' && !item.metered) {
      item.metered = true
      // OpenAI's own usage when the transcription sent one; else the recording's length.
      const cost = transcriptionCost({ seconds: item.seconds, usage: isObject(item.usage) ? item.usage : null }, item.model || NOTE_TRANSCRIBE_MODEL)
      entries.push({ feature: 'note', micros: cost.micros, n: 1, s: Math.round(cost.seconds), ...(cost.unpriced && item.model ? { unpricedModel: String(item.model) } : {}) })
    }
  }
  if (responses) {
    const [first, ...rest] = [...unpriced]
    entries.unshift({ feature, micros, n: counted ? 0 : 1, ...(first ? { unpricedModel: first } : {}) })
    for (const model of rest) entries.push({ feature, micros: 0, n: 0, unpricedModel: model })
  }
  return entries
}

// ---- The assistant's ai_usage tool ----------------------------------------------------------------

const PERIODS = ['today', 'month', 'last_month', 'last_30_days']
const LABELS = Object.fromEntries(FEATURES.map((feature) => [feature.id, feature.label]))
const pct = (value) => `${Math.round(value * 100)}%`

function featureLines(byFeature) {
  return FEATURES.map(({ id }) => ({ id, ...byFeature[id] }))
    .filter((entry) => entry.usd > 0 || entry.n > 0)
    .map((entry) => ({
      feature: LABELS[entry.id],
      usd: formatUsd(entry.usd),
      uses: entry.n,
      ...(entry.id === 'voice' ? { minutes: Math.round(entry.seconds / 60), ...(entry.handoffUsd > 0 ? { handedToAssistant: formatUsd(entry.handoffUsd) } : {}) } : {}),
      ...(entry.id === 'note' && entry.seconds ? { minutes: Math.round((entry.seconds / 60) * 10) / 10 } : {}),
    }))
}

// What Daybook's AI has cost: today, this month (projection and budget), last month or the last 30
// days. → { ok, period, total, byFeature, projected, budget, since, note } | { ok: false, message }
export async function usageToolResult(supabase, userId, { period, settings, ctx } = {}) {
  const ledger = await readLedger(supabase, userId)
  if (!ledger.available) return { ok: false, message: 'AI usage isn’t tracked yet: it needs the 2026-09-23 database update (the usage column).' }
  const which = PERIODS.includes(period) ? period : 'month'
  const timeZone = typeof settings?.timeZone === 'string' && settings.timeZone ? settings.timeZone : ctx?.timeZone
  const today = isDay(ctx?.localDate) ? ctx.localDate : localDay(timeZone)
  const budget = budgetOf(settings)
  const summary = summarizeLedger(ledger.ai, { today, budgetUsd: budget })
  let total
  let byFeature
  if (which === 'today') ({ total, byFeature } = summary.today)
  else if (which === 'month') ({ total, byFeature } = summary.month)
  else if (which === 'last_month') ({ total, byFeature } = summary.lastMonth)
  else ({ total, byFeature } = totalsBetween(ledger.ai, summary.last30[0].day, today))
  const startOf = { today, month: `${summary.month.key}-01`, last_month: `${summary.lastMonth.key}-01`, last_30_days: summary.last30[0].day }[which]
  const since = summary.since
  return {
    ok: true,
    period: which,
    total: formatUsd(total),
    byFeature: featureLines(byFeature),
    ...(which === 'month' ? { projected: formatUsd(summary.projected) } : {}),
    budget: budget ? `${formatUsd(budget)} a month, ${pct(summary.budget.pct)} used this month` : 'No monthly budget set',
    since,
    note: `Estimates from the usage OpenAI reports with each reply; the OpenAI bill is final.${since && since > startOf ? ` Tracking started ${since}, so earlier use isn't included.` : ''}`,
  }
}

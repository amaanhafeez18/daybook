// The morning summary written by the assistant (Settings → Notifications → Morning summary →
// "Written by the assistant", notifications.dailySummaryAi). api/cron.js calls morningBriefing right
// after it has claimed the day's `summary:<date>` key, so each user gets at most one generation a day;
// anything that goes wrong sends the templated summary instead (summaryBody in _reminders.js).
// Files starting with "_" are not deployed as their own serverless functions. No browser code here.
import { fastestEffort, modelFromEnv, responsesJson } from './_openai.js'
import { formatTime, notificationPrefs } from './_reminders.js'
import { patchSettingsAtomic } from './_settings.js'
import { raceTimeout, recordUsage } from './_usage.js'
import { dollars, textCost } from '../src/lib/aiPricing.js'

// Fixed text, so every call shares OpenAI's prompt cache (no ${} or per-user details in here).
export const BRIEFING_INSTRUCTIONS = [
  'You write the morning notification of a personal planner app. You get a short digest of the user’s day, one fact per line.',
  'Write one or two warm, natural sentences, at most 180 characters in all, like a friendly assistant giving a quick heads-up.',
  'When the digest has a First line, lead with that and its time (First up, …); otherwise lead with the most useful fact. Then add the one or two other facts that matter most, in this order: a task due today, the gym plan, how many tasks are overdue (as a count), rain. Leave the rest out; mention prayer times only if nothing else is planned.',
  'Use only the facts in the digest. Never invent or change a task, class, person, place, time, number or the weather. Keep names as written but drop labels in brackets such as (class).',
  'Write every time exactly as the digest does (for example 9:30 AM). Leave out the date, the current time, exercise counts and durations.',
  'Write full, flowing sentences, never a list of fragments or semicolons, and don’t start with a time; opening with words like First up is fine. A gym line has no time of its own, so never give it one.',
  'Mention rain only when the digest has a Rain line, and prayers only when it has a Prayers line.',
  'If there is nothing planned, say it is a clear day in a friendly way.',
  'No greeting with a name, no emoji, no markdown, no lists, no quotation marks, no questions.',
  'Reply as JSON: {"text": "…"}.',
].join('\n')

const BRIEFING_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

const MAX_TEXT = 180 // about what an expanded lock-screen banner shows (as the template)
const MIN_TEXT = 15
const DIGEST_MAX = 900
const DIGEST_TASKS = 8
const TITLE_MAX = 40
const RAIN_FROM = 30 // %: the digest mentions rain from this chance up
export const BRIEFING_BUDGET_MS = 20000 // after this much of a cron run, the rest get the template
const TIMEOUT_MS = 7000
// Reasoning tokens count toward the cap; 200 could end 'incomplete'.
const MAX_OUTPUT_TOKENS = 400

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const list = (value) => (Array.isArray(value) ? value : [])

// Minutes after midnight → '2:30 PM'.
function clock(minutes) {
  const value = Math.max(0, Math.min(1439, Math.round(minutes)))
  return formatTime(`${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`)
}

// One line of user text, at most TITLE_MAX characters (no half an emoji at the cut).
function short(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= TITLE_MAX) return value
  return `${value.slice(0, TITLE_MAX - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`
}

// summaryFacts (api/_reminders.js) → the digest the model writes from, one fact per line, at most
// DIGEST_MAX characters. Holds only what the templated summary could say: task titles and times, never
// task notes or details, and not the user's name.
export function briefingDigest(facts) {
  const f = isObject(facts) ? facts : {}
  const lines = []
  if (isDate(f.date)) {
    lines.push(`Day: ${new Date(`${f.date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })}`)
  }
  const nowMinutes = isTime(f.time) ? toMinutes(f.time) : null
  if (nowMinutes !== null) lines.push(`Now: ${clock(nowMinutes)}`)
  if (isObject(f.first) && Number.isFinite(f.first.start) && short(f.first.name)) {
    lines.push(`First: ${short(f.first.name)}${f.first.isClass ? ' (class)' : ''} at ${clock(f.first.start)}`)
  }
  const tasks = list(f.tasks).filter((task) => isObject(task) && short(task.text))
  if (tasks.length) {
    const names = tasks.slice(0, DIGEST_TASKS).map((task) => `${short(task.text)}${isTime(task.time) ? ` at ${formatTime(task.time)}` : ''}`)
    lines.push(`Tasks today (${tasks.length}): ${names.join('; ')}${tasks.length > DIGEST_TASKS ? `; and ${tasks.length - DIGEST_TASKS} more` : ''}`)
  }
  if (Number(f.overdue) > 0) lines.push(`Overdue tasks: ${Math.round(Number(f.overdue))}`)
  const classes = list(f.classes).filter((slot) => isObject(slot) && short(slot.name))
  if (classes.length) {
    lines.push(`Classes: ${classes.slice(0, 6).map((slot) => `${short(slot.name)}${Number.isFinite(slot.start) ? ` at ${clock(slot.start)}` : ''}`).join('; ')}`)
  }
  // Just the day's name: given the exercise count and minutes, the model kept reciting them.
  if (isObject(f.workout) && short(f.workout.name)) lines.push(`Gym: ${short(f.workout.name)} day`)
  const birthdays = list(f.birthdays).map(short).filter(Boolean)
  if (birthdays.length) lines.push(`Birthdays: ${birthdays.slice(0, 4).join('; ')}`)
  if (Number(f.catchUps) > 0) lines.push(`Catch-ups due: ${Math.round(Number(f.catchUps))}`)
  const rain = f.rainChance == null ? NaN : Number(f.rainChance)
  if (Number.isFinite(rain) && rain >= RAIN_FROM) lines.push(`Rain: ${Math.min(100, Math.round(rain))}% chance`)
  if (isObject(f.food) && Number(f.food.calories) > 0) {
    lines.push(`Food goal: ${Math.round(f.food.calories)} kcal${Number(f.food.protein) > 0 ? `, ${Math.round(f.food.protein)} g protein` : ''}`)
  }
  const prayers = list(f.prayers)
    .filter((prayer) => isObject(prayer) && isTime(prayer.time) && short(prayer.name) && (nowMinutes === null || toMinutes(prayer.time) > nowMinutes))
    .slice(0, 3)
  if (prayers.length) lines.push(`Prayers still ahead: ${prayers.map((prayer) => `${short(prayer.name)} at ${formatTime(prayer.time)}`).join('; ')}`)

  let digest = lines.join('\n')
  if (digest.length > DIGEST_MAX) {
    // Whole lines only: the first ones (day, first thing, tasks) matter most.
    const cut = digest.slice(0, DIGEST_MAX)
    digest = cut.includes('\n') ? cut.slice(0, cut.lastIndexOf('\n')) : `${cut.slice(0, DIGEST_MAX - 1)}…`
  }
  return digest
}

const TIME_12 = /\b(\d{1,2})(?::([0-5]\d))?\s?([ap])\.?\s?m\b\.?/gi
const TIME_BARE = /\b(\d{1,2}):([0-5]\d)\b/g
const PERCENT = /(\d+(?:\.\d+)?)\s?%/g

const norm12 = (hour, minute, half) => `${Number(hour)}:${minute || '00'} ${half.toUpperCase()}M`

// Every time and percentage a text mentions, normalised: { times12, bare, percents }.
function numbersIn(text) {
  const times12 = new Set()
  const bare = new Set()
  for (const match of text.matchAll(TIME_12)) {
    times12.add(norm12(match[1], match[2], match[3]))
    bare.add(`${Number(match[1])}:${match[2] || '00'}`)
  }
  // Bare times are those not followed by AM/PM.
  for (const match of text.replace(TIME_12, ' ').matchAll(TIME_BARE)) bare.add(`${Number(match[1])}:${match[2]}`)
  const percents = new Set([...text.matchAll(PERCENT)].map((match) => String(Number(match[1]))))
  // Other whole numbers ("3 tasks"), with thousands separators dropped ("3,000" = "3000").
  const counts = new Set(text.replace(TIME_12, ' ').replace(TIME_BARE, ' ').replace(PERCENT, ' ').replace(/(\d),(\d{3})\b/g, '$1$2').match(/\b\d+\b/g) || [])
  return { times12, bare, percents, counts }
}

// The digest without its "Now:" line: the current time is context, never something to report (the
// model once gave it as the gym's start time).
const factLines = (digest) => String(digest || '').split('\n').filter((line) => !/^Now:/.test(line)).join('\n')

// True when the digest has nothing beyond the day and the time: the template says it just as well.
export const emptyDigest = (digest) => !String(digest || '').split('\n').some((line) => line.trim() && !/^(Day|Now):/.test(line))

// The model's text made safe to send, or null to send the template instead: no emoji, markdown,
// quotes or line breaks; 15–180 characters (a longer one is cut at its last sentence end, else
// rejected); and every time and percentage in it must be one the digest has.
export function cleanBriefing(text, digest) {
  if (typeof text !== 'string') return null
  let value = text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}️︎‍⃣]/gu, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.!?;:])/g, '$1') // where an emoji was taken out
    .replace(/;\s*/g, ', ') // the model likes semicolons; a notification reads better without
    .trim()
  // Quotes around the whole text.
  value = value.replace(/^["'“”‘’«»]+/, '').replace(/["'“”‘’«»]+$/, '').trim()
  if (value.length < MIN_TEXT) return null
  if (value.length > MAX_TEXT) {
    let end = -1
    for (let i = Math.min(MAX_TEXT, value.length) - 1; i >= 0; i -= 1) {
      if (/[.!?]/.test(value[i]) && (i + 1 === value.length || value[i + 1] === ' ')) {
        end = i + 1
        break
      }
    }
    if (end < MIN_TEXT) return null
    value = value.slice(0, end)
  }
  const known = numbersIn(factLines(digest))
  const said = numbersIn(value)
  for (const time of said.times12) if (!known.times12.has(time)) return null
  for (const time of said.bare) if (!known.bare.has(time)) return null
  for (const percent of said.percents) if (!known.percents.has(percent)) return null
  for (const count of said.counts) if (!known.counts.has(count)) return null
  return value
}

// usage: { input, cached, writes, output } tokens → US$ (prices: src/lib/aiPricing.js; an unknown model is
// priced as gpt-5-mini).
export function briefingCost(usage, model = 'gpt-5-mini') {
  return dollars(textCost(usage, model).micros)
}

function usageOf(payload) {
  const usage = payload?.usage
  if (!usage) return { input: 0, cached: 0, writes: 0, output: 0, reasoning: 0 }
  return {
    input: Number(usage.input_tokens) || 0,
    cached: Number(usage.input_tokens_details?.cached_tokens) || 0,
    // Input newly stored in the prompt cache (GPT-5.6+ bill it at 1.25×).
    writes: Number(usage.input_tokens_details?.cache_write_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    reasoning: Number(usage.output_tokens_details?.reasoning_tokens) || 0,
  }
}

// One call to the model (OPENAI_BRIEFING_MODEL, else OPENAI_MODEL). Throws on any failure: timeout
// (7 s), busy, refusal, incomplete or unreadable answer. → { text, usage, ms, model }
export async function generateBriefing(digest, { userId } = {}) {
  const { model, env } = modelFromEnv('OPENAI_BRIEFING_MODEL', 'OPENAI_MODEL')
  const startedAt = Date.now()
  const { result, payload } = await responsesJson({
    model,
    modelEnv: env,
    instructions: BRIEFING_INSTRUCTIONS,
    content: String(digest || ''),
    schema: BRIEFING_SCHEMA,
    name: 'briefing',
    effort: fastestEffort(model),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: TIMEOUT_MS,
    userId,
    withPayload: true,
  })
  return { text: typeof result?.text === 'string' ? result.text : '', usage: usageOf(payload), ms: Date.now() - startedAt, model }
}

// Runs at most `max` of the given async jobs at once; the rest wait their turn.
// → limit(job) → a promise of job()'s result.
export function createLimiter(max) {
  const size = Math.max(1, Math.floor(Number(max)) || 1)
  let active = 0
  const queue = []
  const next = () => {
    if (active >= size || !queue.length) return
    active += 1
    const { job, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(job)
      .then(resolve, reject)
      .finally(() => {
        active -= 1
        next()
      })
  }
  return (job) => new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject })
    next()
  })
}

function logBriefing(entry) {
  try {
    console.log(JSON.stringify({ event: 'briefing', ...entry }))
  } catch {
    // logging never matters more than the push
  }
}

// The assistant-written morning summary for one user, or the reason to send the template.
// facts: the claimed summary's summaryFacts. now: the time of the send. runStartedAt: when this cron
// run began (the budget). generate/save/limit/record are swappable for tests. Each model call is
// booked in the AI usage ledger as the morning note (record; not with dryRun).
// → { text: string | null, source: 'cached' | 'ai' | 'template' | 'off', reason }
export async function morningBriefing({
  supabase, userId, settings, facts, now = Date.now(), runStartedAt = now,
  generate = generateBriefing, save = patchSettingsAtomic, limit = (job) => job(), record = recordUsage, dryRun = false,
} = {}) {
  const startedAt = Date.now()
  const template = (reason) => ({ text: null, source: 'template', reason })
  let tried = null // the day a model call was made for, once it has been
  // A rejected or failed call leaves an empty briefing for the day, so a push that failed and is
  // retried next minute sends the template instead of paying for another call each minute.
  const markTried = async () => {
    if (!tried) return
    try {
      await save(supabase, userId, { briefing: { date: tried, text: '', at: new Date(now).toISOString() } })
    } catch (error) {
      console.error('Briefing save failed:', userId, error?.message || error)
    }
  }
  try {
    const prefs = notificationPrefs(settings)
    if (!(prefs.dailySummary && prefs.dailySummaryAi === true)) return { text: null, source: 'off', reason: 'setting' }
    if (!process.env.OPENAI_API_KEY) return { text: null, source: 'off', reason: 'no-key' }
    if (String(process.env.AI_BRIEFING || '').trim().toLowerCase() === 'off') return { text: null, source: 'off', reason: 'kill-switch' }
    if (!isObject(facts) || !isDate(facts.date)) return template('no-facts')

    // Already written today (the send failed and this is the retry): the same words again.
    const saved = settings?.briefing
    if (isObject(saved) && saved.date === facts.date && typeof saved.text === 'string' && saved.text.trim()) {
      return { text: saved.text.trim(), source: 'cached', reason: 'cached' }
    }
    // Tried today and it didn't work out: the template, without another call.
    if (isObject(saved) && saved.date === facts.date) return template('tried')
    const overBudget = () => now + (Date.now() - startedAt) - runStartedAt > BRIEFING_BUDGET_MS
    if (overBudget()) return template('budget')

    const digest = briefingDigest(facts)
    // Nothing planned: no call (the model filled an empty day with made-up plans in testing).
    if (emptyDigest(digest)) return template('empty')
    // Waiting for a free slot can use up the run's budget too.
    const result = await limit(() => {
      if (overBudget()) return null
      tried = facts.date
      return generate(digest, { userId })
    })
    if (!result) return template('budget')
    const text = cleanBriefing(result.text, digest)
    const usage = isObject(result.usage) ? result.usage : {}
    const cost = textCost(usage, result.model)
    logBriefing({ userId, source: text ? 'ai' : 'template', ...(text ? {} : { reason: 'rejected' }), ms: result.ms, model: result.model, ...usage, costUsd: Number(dollars(cost.micros).toFixed(6)) })
    // The call cost money whether or not its words are used. Never holds up the push for long.
    if (!dryRun) {
      const entry = { feature: 'brief', micros: cost.micros, ...(cost.unpriced && result.model ? { unpricedModel: String(result.model) } : {}) }
      await raceTimeout(Promise.resolve().then(() => record(supabase, userId, [entry], { day: facts.date })))
    }
    if (!text) {
      await markTried()
      return template('rejected')
    }

    try {
      // For Today's "Morning note" and a retried send; the app never writes this key.
      await save(supabase, userId, { briefing: { date: facts.date, text, at: new Date(now).toISOString() } })
    } catch (error) {
      console.error('Briefing save failed:', userId, error?.message || error)
    }
    return { text, source: 'ai', reason: 'ok' }
  } catch (error) {
    logBriefing({ userId, source: 'template', reason: 'error', error: String(error?.message || error).slice(0, 200) })
    await markTried()
    return template('error')
  }
}

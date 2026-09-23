import { getSupabase, underLimit, verifyRequestToken, verifyTokenVersion } from './db.js'
import { FOOD_MODEL, responsesJson, transcribeAudio } from './_openai.js'
import { ESTIMATE_SCHEMA, ESTIMATE_SCHEMA_NAME, buildContent, buildInstructions, estimatePlan, toClientItems, transcriptionVocabulary } from './_food-estimate.js'

// POST { action: 'estimate', text?, image? (data:image/jpeg;base64,…), audio? (base64), mimeType?,
//        date, time?, meal?, previous? (items from a prior estimate, for "Fix"), context? }
//   → { items: EstimateItem[], clarify: string|null, notFood: boolean, transcript?: string }
// Nothing is saved here: the app shows the estimate for review and logs what the user keeps.
// Errors: { error, code? } — code 'daily_limit' for this app's own daily cap (a 429 without it is
// OpenAI being busy for a moment).

const MODEL = FOOD_MODEL.model // OPENAI_FOOD_MODEL, else OPENAI_MODEL, else gpt-5-mini
const MODEL_ENV = FOOD_MODEL.env || 'OPENAI_MODEL'
const MAX_BODY_BYTES = 4.2 * 1024 * 1024 // Vercel rejects bodies over 4.5 MB with a non-JSON 413
const MAX_TEXT_CHARS = 1000 // the app sends at most this much (src/lib/food/state.js)
const DAILY_LIMIT = 200
const TIME_BUDGET_MS = 57000 // vercel.json maxDuration for this function is 60 s
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const httpError = (status, message) => Object.assign(new Error(message), { status })
const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// Like readJsonBody in db.js, but stops at a size limit so a huge photo gets a friendly JSON 413.
function readLimitedJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) return reject(httpError(413, 'That photo or recording is too large. Try a smaller one.'))
    const chunks = []
    let size = 0
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) return settle(reject, httpError(413, 'That photo or recording is too large. Try a smaller one.'))
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return settle(resolve, {})
      try {
        settle(resolve, JSON.parse(raw))
      } catch {
        settle(reject, httpError(400, 'Invalid request.'))
      }
    })
    req.on('error', (error) => settle(reject, error))
  })
}

// The newest settings row's value (favorites, time zone, units). Missing or unreadable → {}.
async function loadSettings(supabase, userId) {
  try {
    const { data, error } = await supabase.from('settings').select('value').eq('user_id', userId).order('created_at', { ascending: false }).order('id').limit(1)
    if (error) return {}
    const value = data?.[0]?.value
    return isPlainObject(value) ? value : {}
  } catch {
    return {}
  }
}

// The user's calendar date and time in their time zone (when the app didn't send them).
function localNow(timeZone) {
  const now = new Date()
  try {
    const date = now.toLocaleDateString('en-CA', { timeZone })
    const time = now.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    if (isIsoDate(date) && isTime(time)) return { date, time }
  } catch {
    // unknown time zone: fall through to UTC
  }
  return { date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 16) }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  const startedAt = Date.now()
  const debug = []
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.' })
    const decoded = verifyRequestToken(req)
    if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    const supabase = getSupabase()
    if (!(await verifyTokenVersion(supabase, decoded))) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    if (!process.env.OPENAI_API_KEY) return sendJson(res, 503, { error: 'Food estimates aren’t set up yet. Add OPENAI_API_KEY in Vercel.' })

    const body = await readLimitedJson(req, MAX_BODY_BYTES)
    if (!isPlainObject(body)) return sendJson(res, 400, { error: 'Invalid request.' })
    if ((body.action ?? 'estimate') !== 'estimate') return sendJson(res, 400, { error: 'Unknown action.' })

    const typed = typeof body.text === 'string' ? body.text.trim() : ''
    if (typed.length > MAX_TEXT_CHARS) return sendJson(res, 400, { error: `Keep descriptions under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.` })
    const image = body.image ? String(body.image) : ''
    if (image && !IMAGE_DATA_URL.test(image)) return sendJson(res, 400, { error: 'Photos must be JPEG, PNG or WebP.' })
    const audio = body.audio ? String(body.audio) : ''
    if (!typed && !image && !audio) return sendJson(res, 400, { error: 'Describe what you ate, or add a photo.' })
    const previous = Array.isArray(body.previous) ? body.previous.slice(0, 20) : null

    const [allowed, settings] = await Promise.all([
      underLimit(supabase, `food:${decoded.id}`, DAILY_LIMIT, 86400),
      loadSettings(supabase, decoded.id),
    ])
    if (!allowed) return sendJson(res, 429, { error: 'You’ve used today’s AI food estimates. Add it by hand, or try again tomorrow.', code: 'daily_limit' })

    const favorites = Array.isArray(settings.food?.favorites) ? settings.food.favorites : []
    const timeZone = typeof settings.timeZone === 'string' && settings.timeZone
      ? settings.timeZone
      : typeof body.context?.timeZone === 'string' ? body.context.timeZone.slice(0, 64) : ''
    const now = localNow(timeZone || 'UTC')
    const date = isIsoDate(body.date) ? body.date : now.date
    const time = isTime(body.time) ? body.time : date === now.date ? now.time : null
    const meal = typeof body.meal === 'string' ? body.meal.slice(0, 40) : ''

    let text = typed
    let transcript
    if (audio) {
      transcript = await transcribeAudio(audio, body.mimeType, transcriptionVocabulary(favorites))
      debug.push({ step: 'transcribed', chars: transcript.length })
      if (!transcript) return sendJson(res, 422, { error: 'I couldn’t hear anything in that recording. Try again a little closer to the mic.' })
      text = [typed, transcript].filter(Boolean).join('\n').slice(0, 2000)
    }

    const plan = estimatePlan({ model: MODEL, text, image: Boolean(image), previousCount: previous?.length || 0 })
    const result = await responsesJson({
      model: MODEL,
      modelEnv: MODEL_ENV,
      instructions: buildInstructions({ unit: settings.gym?.prefs?.unit === 'lb' ? 'lb' : 'kg' }),
      content: buildContent({ text, image, previous, favorites, meal, date, time, region: timeZone, voice: Boolean(audio) }),
      schema: ESTIMATE_SCHEMA,
      name: ESTIMATE_SCHEMA_NAME,
      effort: plan.effort,
      maxOutputTokens: plan.maxOutputTokens,
      userId: decoded.id,
      timeoutMs: TIME_BUDGET_MS - (Date.now() - startedAt),
      debug,
    })

    const items = toClientItems(result, text)
    const clarify = typeof result?.clarify === 'string' && result.clarify.trim() ? result.clarify.trim().slice(0, 300) : null
    return sendJson(res, 200, {
      items,
      clarify,
      notFood: result?.not_food === true && items.length === 0,
      ...(transcript !== undefined ? { transcript } : {}),
    })
  } catch (error) {
    const status = [400, 413, 422, 429, 502, 503, 504].includes(error?.status) ? error.status : 500
    // Never log request bodies: they can hold photos.
    if (status >= 500) console.error('Food API error:', String(error?.message || error).slice(0, 300), JSON.stringify(debug).slice(0, 1000))
    return sendJson(res, status, { error: status === 500 ? 'Couldn’t estimate that right now. Please try again.' : error.message })
  }
}

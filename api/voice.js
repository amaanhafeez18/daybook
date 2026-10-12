// Voice chats (see api/_voice.js for what each operation does).
//   POST ?op=start       mint a short-lived client secret for one call (or one more segment of it)
//   POST ?op=tools       run the function calls of one model response
//   POST ?op=confirm     a Yes / No tapped on the card in the call
//   POST ?op=checkpoint  save the transcript and bill the call's usage so far (idempotent)
//   GET  ?op=usage       the AI usage summary and the voice settings (Settings → Voice & AI cost)
// Undo chips in the call use the existing POST /api/assistant { action: 'undo' }.
// Env: OPENAI_REALTIME_MODEL (default gpt-realtime-2.1-mini), OPENAI_REALTIME_TRANSCRIBE_MODEL
// (default gpt-transcribe), VOICE_CHAT=off turns new calls off.
import { getSupabase, readJsonBody, underLimit, verifyRequestToken, verifyTokenVersion } from './db.js'
import { readClientContext } from './assistant.js'
import { checkpointOp, confirmOp, startOp, toolsOp, usageOp } from './_voice.js'

const OPS = { start: startOp, tools: toolsOp, confirm: confirmOp, checkpoint: checkpointOp }
// Starting a call (and acting in one) needs the server set up for it; saving what a call already
// used, and reading the usage, always work.
const NEEDS_SETUP = new Set(['start', 'tools', 'confirm'])

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const voiceOff = () => String(process.env.VOICE_CHAT || '').trim().toLowerCase() === 'off' || !process.env.OPENAI_API_KEY

// The GET reads the user's date from the query (?localDate=&timeZone=), like the POSTs' context.
function queryContext(query = {}) {
  const pick = (key) => (typeof query[key] === 'string' ? query[key] : Array.isArray(query[key]) ? query[key][0] : undefined)
  return { localDate: pick('localDate'), localTime: pick('localTime'), timeZone: pick('timeZone') }
}

// deps let the tests run the handler against a stand-in database and token check.
export function createVoiceHandler({ supabaseFor = getSupabase, verifyToken = verifyRequestToken, verifyVersion = verifyTokenVersion, readBody = readJsonBody } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    const debug = []
    const startedAt = Date.now()
    debug.push = (...entries) => Array.prototype.push.apply(debug, entries.map((entry) => ({ ...entry, ms: Date.now() - startedAt })))
    try {
      const op = String(req.query?.op || '')
      const isUsage = op === 'usage'
      if (isUsage ? req.method !== 'GET' : req.method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.', debug })
      if (!isUsage && !OPS[op]) return sendJson(res, 400, { error: 'Unknown voice operation.', code: 'bad_request', debug })
      if (NEEDS_SETUP.has(op) && voiceOff()) return sendJson(res, 503, { code: 'setup', error: 'Voice chat isn’t set up on the server.', debug })

      const user = verifyToken(req)
      if (!user) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      const supabase = supabaseFor()
      const account = await verifyVersion(supabase, user)
      if (!account) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      if (!(await underLimit(supabase, `voiceops:${user.id}`, 1500, 86400))) return sendJson(res, 429, { code: 'busy', error: 'Too many voice requests today. Try again tomorrow.', debug })
      if (op === 'start' && !(await underLimit(supabase, `voicestart:${user.id}`, 60, 86400))) {
        return sendJson(res, 429, { code: 'busy', error: 'That’s a lot of voice chats today. Try again tomorrow; typing still works.', debug })
      }

      const body = isUsage ? {} : await readBody(req)
      const ctx = readClientContext(isUsage ? queryContext(req.query) : body?.context)
      const run = isUsage ? usageOp : OPS[op]
      const outcome = await run({ supabase, user: { id: user.id, username: user.username || account.username || '' }, body: body || {}, ctx, debug })
      return sendJson(res, outcome.status, outcome.body)
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : error?.message === 'Invalid JSON body' ? 400 : 500
      if (status >= 500) console.error('Voice API error:', error)
      debug.push({ step: 'error', message: error.message || 'Unknown error' })
      return sendJson(res, status, { error: status === 500 ? 'Voice chat hit a problem. Please try again.' : error.message, debug })
    }
  }
}

export default createVoiceHandler()

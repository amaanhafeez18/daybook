// Shared OpenAI helpers for the api functions: one-shot structured (json_schema) Responses API calls,
// content-part builders for images/files/text, and voice transcription.

const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const FALLBACK_MODEL = 'gpt-5-mini'
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024 // Vercel caps request bodies at 4.5 MB (base64 adds a third)
const REQUEST_TIMEOUT_MS = 55000 // under vercel.json maxDuration: 60 for api/food.js
const TRANSCRIBE_TIMEOUT_MS = 30000 // a two-minute note takes a few seconds; leaves time for the reply

// The first environment variable (in order) that holds a model id, trimmed (a value pasted into
// Vercel with a trailing space or newline would otherwise be "model not found").
// → { model, env } — env is the variable's name, or null when the built-in default is used.
export function modelFromEnv(...names) {
  for (const name of names) {
    const value = typeof process.env[name] === 'string' ? process.env[name].trim() : ''
    if (value) return { model: value, env: name }
  }
  return { model: FALLBACK_MODEL, env: null }
}

// gpt-4o-mini-transcribe: $1.25 / $5 per 1M audio / text tokens, about $0.003 a minute (prices:
// src/lib/aiPricing.js).
// TODO(2026-10-12): gpt-4o-mini-transcribe shuts down on 26 Feb 2027. OpenAI's speech-to-text guide
// recommends gpt-transcribe for /v1/audio/transcriptions ($0.0045 a minute, usage type 'duration'),
// but it hasn't been tried with this request (an iPhone mp4/webm note, response_format json and the
// vocabulary prompt, whose length limit isn't documented). Try it on a Preview with
// OPENAI_TRANSCRIBE_MODEL=gpt-transcribe, then change this default well before the shutdown.
export const TRANSCRIBE_MODEL = String(process.env.OPENAI_TRANSCRIBE_MODEL || '').trim() || 'gpt-4o-mini-transcribe'
export const DEFAULT_MODEL = modelFromEnv('OPENAI_MODEL').model
// Food estimates: OPENAI_FOOD_MODEL, else OPENAI_MODEL, else the default.
export const FOOD_MODEL = modelFromEnv('OPENAI_FOOD_MODEL', 'OPENAI_MODEL')

// GPT-5 and later (gpt-6-luna, …) and the o-series reason: they take reasoning.effort and reject
// temperature. text.verbosity is a GPT-5+ setting too.
export const isReasoningModel = (model) => /^(gpt-[5-9]|o\d)/.test(String(model || ''))
export const supportsVerbosity = (model) => /^gpt-[5-9]/.test(String(model || ''))

// The quickest reasoning effort a model accepts. Only the original GPT-5 models (gpt-5, gpt-5-mini,
// gpt-5-nano and their dated snapshots) take 'minimal'; later ones (gpt-5.1+) and o-series models
// start at 'low' here. Non-reasoning models ignore effort. responsesJson also falls back to 'low'
// by itself if OpenAI rejects the effort.
export function fastestEffort(model) {
  return /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(String(model || '')) ? 'minimal' : 'low'
}

// An Error with an HTTP status and a message that is safe to show the user.
function aiError(status, message) {
  return Object.assign(new Error(message), { status })
}

// OpenAI's answer when the requested reasoning effort isn't one this model supports.
export function isEffortError(status, payload) {
  if (status !== 400) return false
  const detail = String(payload?.error?.message || '')
  return payload?.error?.param === 'reasoning.effort' || /reasoning[._ ]effort|unsupported value: '(minimal|none)'/i.test(detail)
}

// "model:effort" pairs OpenAI refused, so this warm instance goes straight to 'low' next time
// (e.g. OPENAI_REASONING_EFFORT=minimal on gpt-6-luna, which starts at 'low').
export const unsupportedEffort = new Set()
// The effort to send: the wanted one, or 'low' once OpenAI has refused it for this model.
export function effortFor(model, wanted) {
  const effort = wanted || 'low'
  return effort !== 'low' && unsupportedEffort.has(`${model}:${effort}`) ? 'low' : effort
}

// OpenAI's answer when the model doesn't take text.verbosity. The prompt-caching guide shows
// gpt-6.1-sol requests with text.verbosity, so GPT-6 should take it; a refusal is still retried
// once without it and remembered for this warm instance, just in case.
export function isVerbosityError(status, payload) {
  if (status !== 400) return false
  const param = String(payload?.error?.param || '')
  return param === 'text.verbosity' || (!param && /verbosity/i.test(String(payload?.error?.message || '')))
}
export const noVerbosity = new Set()
// supportsVerbosity, minus the models OpenAI has refused it for since this instance started.
export const wantsVerbosity = (model) => supportsVerbosity(model) && !noVerbosity.has(String(model || ''))

// ---- Content parts (Responses API user message) ---------------------------------------------------

export function textPart(text) {
  return { type: 'input_text', text: String(text ?? '') }
}

// Base64 data URL (data:image/jpeg;base64,…). 'high' is the reliable setting on patch-based models;
// cost is controlled by downscaling on the phone.
export function imagePart(dataUrl, detail = 'high') {
  return { type: 'input_image', image_url: String(dataUrl || ''), detail }
}

// PDFs and other documents as a data URL (data:application/pdf;base64,…).
export function filePart(name, dataUrl, detail = 'low') {
  return { type: 'input_file', filename: String(name || 'file').slice(0, 200), file_data: String(dataUrl || ''), detail }
}

// ---- Structured output ----------------------------------------------------------------------------

// A Responses API reply's usage in Daybook's debug shape (priced by textCost). writes: input tokens
// newly stored in the prompt cache (GPT-5.6+ bill them at 1.25×).
export function usageOf(payload) {
  const usage = payload?.usage
  return usage ? { input: usage.input_tokens, cached: usage.input_tokens_details?.cached_tokens, writes: usage.input_tokens_details?.cache_write_tokens, output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens } : null
}

// How many billed web searches a reply made. A web_search_call item can also open a page or find
// in one; only `search` actions carry the per-call fee (an item without an action counts as one).
export function webSearchCalls(output) {
  return (Array.isArray(output) ? output : []).filter((item) => item?.type === 'web_search_call' && (item.action?.type ?? 'search') === 'search').length
}

const MODEL_GONE = /(does not exist|not found|deprecated|retired|shut ?down|no longer (available|supported))/i

// A friendly error (with an HTTP status for our own reply) for a failed HTTP response from OpenAI.
// options: { model, env } — the model that was asked for and the Vercel variable that chose it.
export function httpError(status, payload, options = {}) {
  const detail = String(payload?.error?.message || '')
  const code = String(payload?.error?.code || payload?.error?.type || '')
  const model = typeof options?.model === 'string' && options.model ? options.model.slice(0, 60) : ''
  const env = typeof options?.env === 'string' && options.env ? options.env : 'OPENAI_MODEL'
  if (status === 401 || status === 403) return aiError(503, 'The server’s OpenAI key isn’t working. Check OPENAI_API_KEY in Vercel.')
  if (code === 'insufficient_quota') return aiError(503, 'The OpenAI account is out of credit. Add credit at platform.openai.com.')
  // A retired or mistyped model: every request fails until the setting changes, so say which one.
  if (code === 'model_not_found' || status === 404 || (/\bmodels?\b/i.test(detail) && MODEL_GONE.test(detail) && !/reasoning|effort/i.test(detail))) {
    return aiError(503, `The AI model${model ? ` “${model}”` : ''} isn’t available (it may have been retired). Set ${env} in Vercel to a current model, then redeploy.`)
  }
  if (status === 429) return aiError(429, 'The AI service is busy right now. Try again in a moment.')
  if (isEffortError(status, payload)) return aiError(502, `The AI model${model ? ` “${model}”` : ''} didn’t accept the reasoning setting. Please try again.`)
  if (status === 400 && /image|file|pdf|decode|unsupported/i.test(detail)) return aiError(400, 'That file couldn’t be read. Try a different photo or file.')
  if (status >= 500) return aiError(502, 'The AI service had a problem. Please try again.')
  return aiError(502, detail ? `The AI request failed: ${detail.slice(0, 200)}` : `The AI request failed (${status}).`)
}

// One POST to the Responses API → { response, payload }. Throws a friendly error when the request
// can't be made or the body isn't JSON.
async function postResponses(body, timeoutMs, debug) {
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(5000, timeoutMs)),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw aiError(504, 'The AI took too long to answer. Please try again.')
    throw aiError(502, 'Couldn’t reach the AI service. Check your connection and try again.')
  }

  const rawBody = await response.text().catch(() => '')
  let payload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    debug.push({ step: 'openai.invalid_response', httpStatus: response.status, bodyPreview: rawBody.slice(0, 300) })
    throw aiError(502, `The AI service returned an unexpected response (${response.status}). Please try again.`)
  }
  const outputTypes = (payload.output || []).map((item) => item.type)
  // model and webCalls let api/_usage.js (usageFromDebug) price the call.
  debug.push({
    step: 'openai.response',
    httpStatus: response.status,
    status: payload.status || 'unknown',
    ms: Date.now() - startedAt,
    model: body.model,
    outputTypes,
    webCalls: webSearchCalls(payload.output),
    usage: usageOf(payload),
  })
  return { response, payload }
}

// One non-streamed Responses API call whose reply must match `schema` (strict json_schema).
// `content` is the user message's content parts (textPart/imagePart/filePart). `modelEnv` names
// the Vercel variable that chose the model (for the "model not available" message). Returns the
// parsed object; throws an Error with a user-facing message and an HTTP `status` otherwise.
// `tools` (e.g. [{ type: 'web_search' }]) and `include` add hosted tools; with `withPayload` the result is
// { result, payload } so callers can read tool items (web sources).
export async function responsesJson({ model = DEFAULT_MODEL, modelEnv, instructions, content, schema, name = 'result', effort = 'low', maxOutputTokens, userId, timeoutMs = REQUEST_TIMEOUT_MS, debug = [], tools, include, withPayload = false }) {
  if (!process.env.OPENAI_API_KEY) throw aiError(503, 'AI isn’t set up on the server yet. Add OPENAI_API_KEY in Vercel.')
  const reasoning = isReasoningModel(model)
  const format = { type: 'json_schema', name: String(name).replace(/[^\w-]/g, '_').slice(0, 64), strict: true, schema }
  const body = {
    model,
    instructions,
    input: [{ role: 'user', content: Array.isArray(content) ? content : [textPart(content)] }],
    store: false,
    // Same prefix per feature and user, so repeat calls hit the prompt cache.
    // OpenAI allows at most 64 characters: "daybook-" + up to 18 of the name + "-" + a 36-character id.
    prompt_cache_key: userId ? `daybook-${format.name.slice(0, 18)}-${String(userId).slice(0, 36)}` : `daybook-${format.name.slice(0, 55)}`,
    max_output_tokens: maxOutputTokens || (reasoning ? 6000 : 2000),
    // Merge, don't replace: format and verbosity both live in `text`.
    text: wantsVerbosity(model) ? { verbosity: 'low', format } : { format },
  }
  if (reasoning) {
    body.reasoning = { effort: effortFor(model, effort) }
    // With store:false, reasoning comes back encrypted (kept for parity with the assistant).
    body.include = ['reasoning.encrypted_content']
  } else {
    body.temperature = 0.2
  }
  if (Array.isArray(tools) && tools.length) body.tools = tools
  if (Array.isArray(include) && include.length) body.include = [...new Set([...(body.include || []), ...include])]

  const budget = Number(timeoutMs) || REQUEST_TIMEOUT_MS
  const deadline = Date.now() + budget
  // A refusal comes back in well under a second, so a resend needs half the budget (at most 8 s)
  // left: short callers like the morning note (7 s) still get their retry.
  const timeToRetry = () => deadline - Date.now() > Math.min(8000, budget / 2)
  debug.push({ step: 'openai.request', model, format: format.name, effort: reasoning ? body.reasoning.effort : null, parts: body.input[0].content.map((part) => part.type) })
  let { response, payload } = await postResponses(body, deadline - Date.now(), debug)
  // A model that doesn't take this effort (e.g. 'minimal' on a newer model): remembered, and once
  // more with 'low' if there's time.
  if (reasoning && body.reasoning.effort !== 'low' && isEffortError(response.status, payload)) {
    unsupportedEffort.add(`${model}:${body.reasoning.effort}`)
    if (timeToRetry()) {
      body.reasoning = { effort: 'low' }
      debug.push({ step: 'openai.retry', reason: 'effort', effort: 'low' })
      ;({ response, payload } = await postResponses(body, deadline - Date.now(), debug))
    }
  }
  // A model that doesn't take text.verbosity: remembered, and once more without it if there's time.
  if (body.text.verbosity && isVerbosityError(response.status, payload)) {
    noVerbosity.add(String(model))
    if (timeToRetry()) {
      body.text = { format }
      debug.push({ step: 'openai.retry', reason: 'verbosity' })
      ;({ response, payload } = await postResponses(body, deadline - Date.now(), debug))
    }
  }
  if (!response.ok || payload.error) throw httpError(response.status, payload, { model, env: modelEnv })
  if (payload.status === 'failed') throw aiError(502, 'The AI couldn’t finish that. Please try again.')
  if (payload.status === 'incomplete') {
    const reason = payload.incomplete_details?.reason
    if (reason === 'content_filter') throw aiError(422, 'The AI couldn’t help with that one.')
    throw aiError(502, 'The AI ran out of room before finishing. Try a shorter description or fewer items.')
  }

  const part = (payload.output || [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content || [])
    .find((item) => item?.type === 'output_text' || item?.type === 'refusal')
  if (!part) throw aiError(502, 'The AI didn’t return an answer. Please try again.')
  if (part.type === 'refusal') throw aiError(422, String(part.refusal || '').trim().slice(0, 300) || 'The AI couldn’t help with that one.')
  let result
  try {
    result = JSON.parse(part.text)
  } catch {
    throw aiError(502, 'The AI returned an unreadable answer. Please try again.')
  }
  return withPayload ? { result, payload } : result
}

// ---- Voice ----------------------------------------------------------------------------------------

// About 4,000 bytes a second of compressed voice: the length of a recording when the app didn't say.
const secondsOfAudio = (bytes) => Math.min(130, Math.max(1, Math.round(bytes / 4000)))

// Same behaviour as api/assistant.js; errors also carry an HTTP status. With `debug`, a successful
// transcription is logged as { step: 'openai.transcribe', model, seconds, usage? } so it can be
// priced (seconds: the recording's length when known, else estimated from its size; 1–130; usage:
// OpenAI's count, which the price uses when it has one).
export async function transcribeAudio(audioBase64, mimeType, vocabulary, { debug, seconds } = {}) {
  const buffer = Buffer.from(String(audioBase64 || ''), 'base64')
  if (buffer.length < 500) throw aiError(400, 'That recording was too short. Try again.')
  if (buffer.length > MAX_AUDIO_BYTES) throw aiError(413, 'That recording is too long. Keep voice messages under two minutes.')

  const type = String(mimeType || 'audio/webm').split(';')[0]
  const extension = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }[type] || 'webm'

  const form = new FormData()
  form.append('file', new Blob([buffer], { type }), `voice.${extension}`)
  form.append('model', TRANSCRIBE_MODEL)
  form.append('response_format', 'json')
  // Names and terms from the user's data help the model spell them correctly.
  if (vocabulary) form.append('prompt', vocabulary)

  let response
  try {
    response = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw aiError(504, 'Transcribing that recording took too long. Please try again.')
    throw aiError(502, 'Couldn’t reach the AI service. Check your connection and try again.')
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    // A bad recording is the user's to retry; everything else (key, credit, busy, retired model)
    // gets the same friendly messages as the other AI calls.
    if (response.status === 400 && !/model/i.test(String(payload.error?.message || ''))) throw aiError(400, 'That recording couldn’t be read. Try recording it again.')
    throw httpError(response.status, payload, { model: TRANSCRIBE_MODEL, env: 'OPENAI_TRANSCRIBE_MODEL' })
  }
  if (Array.isArray(debug)) {
    const given = Number(seconds)
    // usage: OpenAI's own count ({ type: 'tokens', … } or { type: 'duration', seconds }), when sent.
    debug.push({
      step: 'openai.transcribe',
      model: TRANSCRIBE_MODEL,
      seconds: Number.isFinite(given) && given > 0 ? Math.min(130, Math.max(1, Math.round(given))) : secondsOfAudio(buffer.length),
      ...(payload.usage && typeof payload.usage === 'object' ? { usage: payload.usage } : {}),
    })
  }
  return String(payload.text || '').trim()
}

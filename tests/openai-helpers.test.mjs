// api/_openai.js helpers that decide what a request sends and how its cost is read back: which
// models reason and take verbosity, the quickest effort, web searches (only `search` actions are
// billed), cache writes in the usage, the verbosity retry, and voice-note usage.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRANSCRIBE_MODEL, effortFor, fastestEffort, isReasoningModel, isVerbosityError, noVerbosity, responsesJson, supportsVerbosity, transcribeAudio,
  unsupportedEffort, usageOf, wantsVerbosity, webSearchCalls,
} from '../api/_openai.js'
import { usageFromDebug } from '../api/_usage.js'

describe('model checks', () => {
  test('GPT-5 and later reason and take verbosity; older models do not', () => {
    for (const model of ['gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5.4-mini', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol']) {
      assert.equal(isReasoningModel(model), true, model)
      assert.equal(supportsVerbosity(model), true, model)
    }
    assert.equal(isReasoningModel('o4-mini'), true)
    assert.equal(supportsVerbosity('o4-mini'), false)
    for (const model of ['gpt-4.1-mini', 'gpt-4o', '', null, undefined]) {
      assert.equal(isReasoningModel(model), false, String(model))
      assert.equal(supportsVerbosity(model), false, String(model))
    }
  })

  test("fastestEffort: 'minimal' only on the original GPT-5 models", () => {
    assert.equal(fastestEffort('gpt-5-mini'), 'minimal')
    assert.equal(fastestEffort('gpt-5-nano-2025-08-07'), 'minimal')
    assert.equal(fastestEffort('gpt-6-luna'), 'low')
    assert.equal(fastestEffort('gpt-5.6-terra'), 'low')
  })
})

describe('reading a reply', () => {
  test('webSearchCalls counts only search actions', () => {
    const output = [
      { type: 'web_search_call', action: { type: 'search', query: 'oats calories' } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://example.com' } },
      { type: 'web_search_call', action: { type: 'find_in_page', pattern: 'kcal' } },
      { type: 'web_search_call' }, // no action: counted, as before
      { type: 'message', content: [] },
    ]
    assert.equal(webSearchCalls(output), 2)
    assert.equal(webSearchCalls([{ type: 'web_search_call', action: { type: 'open_page' } }]), 0)
    assert.equal(webSearchCalls(undefined), 0)
    assert.equal(webSearchCalls([null]), 0)
  })

  test('usageOf returns cache writes', () => {
    const payload = { usage: { input_tokens: 18707, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 18704 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 8 } } }
    assert.deepEqual(usageOf(payload), { input: 18707, cached: 0, writes: 18704, output: 12, reasoning: 8 })
    assert.equal(usageOf({}), null)
    assert.equal(usageOf({ usage: { input_tokens: 5, output_tokens: 1 } }).writes, undefined)
  })

  test('isVerbosityError', () => {
    assert.equal(isVerbosityError(400, { error: { param: 'text.verbosity', message: 'Unsupported parameter' } }), true)
    assert.equal(isVerbosityError(400, { error: { message: "Unsupported value: 'low' for verbosity" } }), true)
    assert.equal(isVerbosityError(400, { error: { param: 'reasoning.effort', message: 'verbosity' } }), false)
    assert.equal(isVerbosityError(429, { error: { param: 'text.verbosity' } }), false)
  })
})

// ---- requests, with fetch stubbed ------------------------------------------------------------------

const realFetch = globalThis.fetch
const realKey = process.env.OPENAI_API_KEY
let requests = []
let replies = []
beforeEach(() => {
  requests = []
  replies = []
  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    requests.push({ url, body })
    const reply = replies.shift() || { status: 200, payload: {} }
    if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay))
    return new Response(JSON.stringify(reply.payload), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = realKey
  noVerbosity.clear()
  unsupportedEffort.clear()
})

const answer = (result, extra = {}) => ({
  status: 200,
  payload: {
    status: 'completed',
    output: [...(extra.output || []), { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1800 }, output_tokens: 100 },
  },
})
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }

describe('responsesJson', () => {
  test('a gpt-6-luna request reasons (no temperature) and its debug carries writes and real searches', async () => {
    replies.push(answer({ ok: true }, { output: [{ type: 'web_search_call', action: { type: 'search' } }, { type: 'web_search_call', action: { type: 'open_page' } }] }))
    const debug = []
    const result = await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, debug })
    assert.deepEqual(result, { ok: true })
    const { body } = requests[0]
    assert.deepEqual(body.reasoning, { effort: 'low' })
    assert.equal(body.temperature, undefined)
    assert.deepEqual(body.include, ['reasoning.encrypted_content'])
    assert.equal(body.text.verbosity, 'low')
    const response = debug.find((item) => item.step === 'openai.response')
    assert.equal(response.webCalls, 1, 'the open_page action is not a billed search')
    assert.equal(response.usage.writes, 1800)
    // Priced with the cache writes: 200 × 0.10 + 1,800 × 0.125 + 100 × 0.50 + one search ($0.01).
    const [entry] = usageFromDebug(debug, { feature: 'food' })
    assert.equal(entry.micros, 20 + 225 + 50 + 10000)
  })

  test('a model that refuses text.verbosity is asked once more without it, and remembered', async () => {
    replies.push({ status: 400, payload: { error: { param: 'text.verbosity', message: "Unsupported parameter: 'text.verbosity'" } } })
    replies.push(answer({ ok: true }))
    const debug = []
    assert.deepEqual(await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, debug }), { ok: true })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].body.text.verbosity, 'low')
    assert.equal(requests[1].body.text.verbosity, undefined)
    assert.equal(requests[1].body.text.format.type, 'json_schema')
    assert.ok(debug.some((item) => item.step === 'openai.retry' && item.reason === 'verbosity'))
    assert.equal(wantsVerbosity('gpt-6-luna'), false)
    // The next call goes straight without it.
    replies.push(answer({ ok: true }))
    await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema })
    assert.equal(requests[2].body.text.verbosity, undefined)
    assert.equal(wantsVerbosity('gpt-5-mini'), true)
  })

  test('the morning note (7 s timeout) still gets the verbosity retry', async () => {
    replies.push({ status: 400, payload: { error: { param: 'text.verbosity', message: "Unsupported parameter: 'text.verbosity'" } } })
    replies.push(answer({ ok: true }))
    assert.deepEqual(await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, timeoutMs: 7000 }), { ok: true })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].body.text.verbosity, undefined)
    assert.equal(wantsVerbosity('gpt-6-luna'), false)
  })

  test('a refused effort is remembered even when there is no time left to resend', async () => {
    // A 10 ms budget and a 30 ms reply: the 400 arrives after the deadline, so no resend, but the
    // next call sends 'low'.
    replies.push({ status: 400, delay: 30, payload: { error: { param: 'reasoning.effort', message: "Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model." } } })
    await assert.rejects(responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, effort: 'minimal', timeoutMs: 10 }))
    assert.equal(requests.length, 1)
    assert.equal(effortFor('gpt-6-luna', 'minimal'), 'low')
    replies.push(answer({ ok: true }))
    await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, effort: 'minimal' })
    assert.deepEqual(requests[1].body.reasoning, { effort: 'low' })
  })

  test('the morning note (7 s timeout) gets the effort retry too', async () => {
    replies.push({ status: 400, payload: { error: { param: 'reasoning.effort', message: "Unsupported value: 'minimal'" } } })
    replies.push(answer({ ok: true }))
    const debug = []
    assert.deepEqual(await responsesJson({ model: 'gpt-6-luna', instructions: 'x', content: 'y', schema, effort: 'minimal', timeoutMs: 7000, debug }), { ok: true })
    assert.deepEqual(requests.map((r) => r.body.reasoning.effort), ['minimal', 'low'])
    assert.ok(debug.some((item) => item.step === 'openai.retry' && item.reason === 'effort'))
  })

  test('effortFor', () => {
    assert.equal(effortFor('gpt-5-mini', undefined), 'low')
    assert.equal(effortFor('gpt-5-mini', 'minimal'), 'minimal')
    unsupportedEffort.add('gpt-6-luna:minimal')
    assert.equal(effortFor('gpt-6-luna', 'minimal'), 'low')
    assert.equal(effortFor('gpt-6-luna', 'medium'), 'medium')
    assert.equal(effortFor('gpt-5-mini', 'minimal'), 'minimal', 'only the refused model')
  })
})

describe('voice notes', () => {
  const audio = Buffer.alloc(8000, 1).toString('base64')

  test("OpenAI's usage is kept and prices the note", async () => {
    assert.equal(TRANSCRIBE_MODEL, 'gpt-4o-mini-transcribe')
    replies.push({ status: 200, payload: { text: ' Buy milk ', usage: { type: 'tokens', input_tokens: 17, output_tokens: 9, total_tokens: 26, input_token_details: { audio_tokens: 17, text_tokens: 0 } } } })
    const debug = []
    assert.equal(await transcribeAudio(audio, 'audio/mp4', 'Names: Sam', { debug, seconds: 2 }), 'Buy milk')
    assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/transcriptions')
    const item = debug.find((entry) => entry.step === 'openai.transcribe')
    assert.equal(item.seconds, 2)
    assert.equal(item.usage.type, 'tokens')
    const [entry] = usageFromDebug(debug)
    assert.deepEqual(entry, { feature: 'note', micros: 66, n: 1, s: 2 }) // 17 × 1.25 + 9 × 5
  })

  test('without usage it is priced from the length, as before', async () => {
    replies.push({ status: 200, payload: { text: 'Hi' } })
    const debug = []
    await transcribeAudio(audio, 'audio/webm', '', { debug, seconds: 60 })
    const item = debug.find((entry) => entry.step === 'openai.transcribe')
    assert.equal('usage' in item, false)
    assert.deepEqual(usageFromDebug(debug), [{ feature: 'note', micros: 3000, n: 1, s: 60 }])
  })
})

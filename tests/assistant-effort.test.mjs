// The assistant's model calls within one turn: a follow-up round (after tools ran or were staged)
// sends the same reasoning effort and prefix as round 1, so OpenAI's prompt cache still covers the
// instructions, tools and conversation. Switching to 'minimal' mid-turn used to throw that away.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const { callOpenAI, followupOptions, MAX_TOOL_ROUNDS } = await import('../api/assistant.js')
const { DEFAULT_MODEL, isReasoningModel, noVerbosity, supportsVerbosity, unsupportedEffort } = await import('../api/_openai.js')

const realFetch = globalThis.fetch
let bodies = []
let replies = []
beforeEach(() => {
  bodies = []
  replies = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    bodies.push(JSON.parse(init.body))
    const reply = replies.shift() || { status: 200, payload: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] } }
    return new Response(JSON.stringify(reply.payload), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  noVerbosity.clear()
  unsupportedEffort.clear()
})

// What decides whether the prompt cache still applies, besides the input itself.
const prefix = (body) => ({ model: body.model, instructions: body.instructions, tools: body.tools, reasoning: body.reasoning, text: body.text, prompt_cache_key: body.prompt_cache_key, include: body.include })

const round1Options = (effort) => ({ instructions: 'Static rules.', input: [{ role: 'user', content: 'Add milk to my list' }], userId: 'u1', onDelta: null, effort, deadline: Date.now() + 60000 })

describe('reasoning effort across rounds', () => {
  test('a staged-clean follow-up round keeps round 1\'s effort and prefix', async () => {
    const options = round1Options(undefined)
    await callOpenAI(options, [])
    const followup = followupOptions({ ...options, input: [...options.input, { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' }] }, 1)
    await callOpenAI(followup, [])
    assert.equal(bodies.length, 2)
    assert.deepEqual(prefix(bodies[1]), prefix(bodies[0]))
    if (isReasoningModel(DEFAULT_MODEL)) {
      assert.deepEqual(bodies[0].reasoning, { effort: process.env.OPENAI_REASONING_EFFORT || 'low' })
      assert.notEqual(bodies[1].reasoning.effort, 'minimal')
    }
    assert.equal(bodies[1].tool_choice, 'auto')
  })

  test('a heavy turn (photos, PDFs) stays at medium on every round; the last round only replies', async () => {
    const options = round1Options('medium')
    await callOpenAI(options, [])
    await callOpenAI(followupOptions(options, 1), [])
    await callOpenAI(followupOptions(options, MAX_TOOL_ROUNDS - 1), [])
    if (isReasoningModel(DEFAULT_MODEL)) for (const body of bodies) assert.deepEqual(body.reasoning, { effort: 'medium' })
    assert.deepEqual(prefix(bodies[2]), prefix(bodies[0]))
    assert.equal(bodies[2].tool_choice, 'none')
  })

  test('followupOptions never changes the effort', () => {
    for (const effort of [undefined, 'low', 'medium']) {
      for (let round = 1; round < MAX_TOOL_ROUNDS; round += 1) assert.equal(followupOptions({ effort, input: [] }, round).effort, effort)
    }
  })

  test('the tool loop makes its follow-up calls through followupOptions, with no effort override', async () => {
    // The handler isn't injectable (real Supabase client), so this guards the one line that matters.
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../api/assistant.js', import.meta.url), 'utf8')
    assert.match(source, /callOpenAI\(followupOptions\(callOptions, round\), debug\)/)
    const followups = source.match(/callOpenAI\(\{ \.\.\.callOptions[^)]*\)/g) || []
    assert.deepEqual(followups.filter((text) => /effort/.test(text)), [], 'no round overrides the effort')
  })
})

describe('a refused effort', () => {
  // e.g. OPENAI_REASONING_EFFORT=minimal left in Vercel after switching to gpt-6-luna.
  test("is retried once with 'low', and every later round of the turn sends 'low' straight away", { skip: !isReasoningModel(DEFAULT_MODEL) && 'model does not reason' }, async () => {
    replies.push({ status: 400, payload: { error: { param: 'reasoning.effort', message: "Unsupported value: 'minimal' is not supported with this model." } } })
    const debug = []
    const options = round1Options('minimal')
    const payload = await callOpenAI(options, debug)
    assert.equal(payload.status, 'completed')
    assert.deepEqual(bodies.map((body) => body.reasoning.effort), ['minimal', 'low'])
    assert.ok(debug.some((item) => item.step === 'openai.retry' && item.reason === 'effort'))
    await callOpenAI(followupOptions(options, 1), [])
    assert.equal(bodies.length, 3)
    assert.deepEqual(prefix(bodies[2]), prefix(bodies[1]), 'the follow-up matches the retried round 1 (cache)')
  })

  test("a refused 'low' is not retried (it is already the floor)", { skip: !isReasoningModel(DEFAULT_MODEL) && 'model does not reason' }, async () => {
    replies.push({ status: 400, payload: { error: { param: 'reasoning.effort', message: 'Unsupported value' } } })
    await assert.rejects(callOpenAI(round1Options('low'), []))
    assert.equal(bodies.length, 1)
  })
})

describe('verbosity', () => {
  test('a model that refuses text.verbosity is asked once more without it', { skip: !supportsVerbosity(DEFAULT_MODEL) && 'model takes no verbosity' }, async () => {
    replies.push({ status: 400, payload: { error: { param: 'text.verbosity', message: "Unsupported parameter: 'text.verbosity'" } } })
    const debug = []
    const payload = await callOpenAI(round1Options(undefined), debug)
    assert.equal(payload.status, 'completed')
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[0].text, { verbosity: 'low' })
    assert.equal(bodies[1].text, undefined)
    assert.ok(debug.some((item) => item.step === 'openai.retry' && item.reason === 'verbosity'))
  })
})

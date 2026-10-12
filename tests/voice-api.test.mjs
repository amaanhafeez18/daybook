// api/voice.js end to end against the stand-in database: minting (refusals and the session sent to
// OpenAI, with fetch stubbed), the model's tool calls, card taps and the idempotent checkpoints.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { CONTEXT, ID, TODAY, TOMORROW, USER, conversationOf, databaseFor, fakeSupabase, talkOf } from './voice-fixture.mjs'
import { addToLedger, emptyLedger } from '../src/lib/aiLedger.js'

const { createVoiceHandler } = await import('../api/voice.js')

console.error = () => {} // expected noise (resolveFriend fallbacks, failed lookups)

const TALK = 'talk_abc12345xyz'

// ---- a fake request / response and a stubbed OpenAI mint --------------------------------------------

function call(handler, { method = 'POST', op, body = {}, query = {} }) {
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify({ context: CONTEXT, ...body }))])
  Object.assign(req, { method, query: { op, ...query }, headers: { authorization: 'Bearer test' } })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value },
      end(chunk) { resolve({ status: this.statusCode, body: chunk ? JSON.parse(chunk) : null }) },
    }
    handler(req, res).catch(reject)
  })
}

let mints = []
let mintReply = null
const realFetch = globalThis.fetch
beforeEach(() => {
  mints = []
  mintReply = null
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets', 'only the mint is called')
    const body = JSON.parse(options.body)
    mints.push(body)
    const reply = mintReply ? mintReply(body, mints.length) : { status: 200, json: { value: 'ek_test_secret', expires_at: 1760000060, session: { id: 'sess_1' } } }
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.json }
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.VOICE_CHAT
})

function setup(options = {}) {
  const supabase = fakeSupabase(databaseFor(options))
  const handler = createVoiceHandler({ supabaseFor: () => supabase, verifyToken: () => ({ id: USER, username: 'sam' }), verifyVersion: async () => ({ id: USER }) })
  return { supabase, run: (op, body, extra) => call(handler, { op, body, ...extra }) }
}

const ledgerWith = (entries) => ({ rev: 3, ai: entries.reduce((ai, entry) => addToLedger(ai, entry), emptyLedger(TODAY)) })
const outputOf = (reply, index = 0) => JSON.parse(reply.body.outputs[index].output)
const tool = (name, args, callId = `call_${name}`) => ({ callId, name, arguments: JSON.stringify(args) })

describe('POST ?op=start', () => {
  test('mints with an explicit model and voice, a 60 s secret and no idle timeout', async () => {
    const { run, supabase } = setup()
    const reply = await run('start', { talkId: TALK, intent: 'chat', mode: 'open' })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(mints.length, 1)
    const { expires_after: expires, session } = mints[0]
    assert.deepEqual(expires, { anchor: 'created_at', seconds: 60 })
    assert.equal(session.model, 'gpt-realtime-2.1-mini')
    assert.equal(session.audio.output.voice, 'marin')
    assert.equal(session.audio.input.turn_detection.type, 'semantic_vad')
    assert.equal(session.audio.input.turn_detection.eagerness, 'medium')
    assert.equal(session.audio.input.turn_detection.interrupt_response, false)
    assert.ok(!JSON.stringify(mints[0]).includes('idle_timeout_ms'))
    assert.match(session.audio.input.transcription.prompt, /Sara Khan/)
    const body = reply.body
    assert.equal(body.clientSecret, 'ek_test_secret')
    assert.equal(body.talkId, TALK)
    assert.equal(body.limits.sessionSec, 900)
    assert.equal(body.limits.dailyLeftSec, 1800)
    assert.equal(body.limits.silenceSec, 60)
    assert.equal(body.budget.usd, 20)
    assert.match(body.contextText, /^Daybook context/)
    assert.match(body.opening, /greeting to Sam/)
    assert.equal(body.turnDetection.hold, null)
    assert.equal(body.pending, null)
    // The ledger knows the segment before anything is billed.
    const seg = conversationOf(supabase).usage.ai.talks[TALK].segs[body.sessionId]
    assert.equal(seg.maxSec, 900)
    assert.equal(seg.u, 0)
  })

  test('hold to talk sends no turn detection; a journal call waits longer (low eagerness)', async () => {
    const { run } = setup()
    await run('start', { talkId: TALK, intent: 'journal', mode: 'hold' })
    assert.equal(mints[0].session.audio.input.turn_detection, null)
    await run('start', { talkId: 'talk_second1234', intent: 'debrief', mode: 'open' })
    assert.equal(mints[1].session.audio.input.turn_detection.eagerness, 'low')
  })

  test('the instructions and tools are the same for two calls on the same day', async () => {
    const { run } = setup()
    await run('start', { talkId: TALK, context: { ...CONTEXT, localTime: '08:05' } })
    await run('start', { talkId: 'talk_second1234', context: { ...CONTEXT, localTime: '22:40' } })
    assert.equal(mints[0].session.instructions, mints[1].session.instructions)
    assert.deepEqual(mints[0].session.tools, mints[1].session.tools)
  })

  test('refusals: off, today’s minutes used, budget used, setup', async () => {
    let reply = await setup({ settings: { voice: { enabled: false } } }).run('start', { talkId: TALK })
    assert.equal(reply.status, 403)
    assert.equal(reply.body.code, 'off')

    reply = await setup({ usage: ledgerWith([{ day: TODAY, feature: 'voice', micros: 1_000_000, s: 30 * 60 - 30 }]) }).run('start', { talkId: TALK })
    assert.equal(reply.status, 429)
    assert.equal(reply.body.code, 'daily')
    assert.match(reply.body.error, /30 voice minutes/)

    reply = await setup({ usage: ledgerWith([{ day: TODAY, feature: 'chat', micros: 20_000_000 }]) }).run('start', { talkId: TALK })
    assert.equal(reply.status, 429)
    assert.equal(reply.body.code, 'budget')
    assert.match(reply.body.error, /\$20/)

    process.env.VOICE_CHAT = 'off'
    reply = await setup().run('start', { talkId: TALK })
    assert.equal(reply.status, 503)
    assert.equal(reply.body.code, 'setup')
    assert.equal(mints.length, 0, 'nothing was minted')
  })

  test('a bad talk id is refused; without the usage column only the call length applies', async () => {
    assert.equal((await setup().run('start', { talkId: 'nope' })).status, 400)
    const reply = await setup({ usage: false }).run('start', { talkId: TALK })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ledger, false)
    assert.equal(reply.body.limits.sessionSec, 900)
  })

  test('a mint refused for the transcription prompt is retried without it; other errors are friendly', async () => {
    mintReply = (body, n) => (n === 1 ? { status: 400, json: { error: { message: 'Unknown parameter: session.audio.input.transcription.prompt', param: 'prompt' } } } : { status: 200, json: { value: 'ek_2', expires_at: 1 } })
    let reply = await setup().run('start', { talkId: TALK })
    assert.equal(reply.status, 200)
    assert.equal(mints.length, 2)
    assert.equal(mints[1].session.audio.input.transcription.prompt, undefined)
    mintReply = () => ({ status: 404, json: { error: { code: 'model_not_found', message: 'The model does not exist' } } })
    reply = await setup().run('start', { talkId: TALK })
    assert.equal(reply.status, 503)
    assert.match(reply.body.error, /OPENAI_REALTIME_MODEL/)
  })
})

describe('POST ?op=tools', () => {
  const heard = (text, item = 'item_u1') => ({ heard: text, heardItemId: item })

  test('level "changes": create_task runs at once with an Undo chip on the talk message', async () => {
    const { run, supabase } = setup({ settings: { assistantConfirm: 'changes' } })
    const reply = await run('tools', { talkId: TALK, startedAt: new Date().toISOString(), ...heard('add call mom tomorrow at 5'), calls: [tool('create_task', { text: 'Call mom', date: TOMORROW, time: '17:00', reminderMinutes: 0 })] })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    const output = outputOf(reply)
    assert.equal(output.ok, true)
    assert.equal(output.done, true)
    assert.match(output.said, /Call mom/)
    assert.match(output.ref, /^t:[0-9a-f]{8,}$/)
    assert.match(output.todayNow, /Call mom/, 'the Today lines come back with the change')
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(reply.body.outputs[0].output), 'no raw ids for the model')
    assert.equal(reply.body.dataChanged, true)
    assert.ok(supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
    const talk = talkOf(supabase, TALK)
    assert.equal(talk.role, 'assistant')
    assert.equal(talk.actions.length, 1)
    assert.ok(talk.actions[0].undoId)
    assert.equal(talk.undo[0].calls[0].tool, 'delete_task_forever')
    assert.equal(reply.body.actions[0].undoId, talk.actions[0].undoId)
  })

  test('level "all": the change is staged as a card that remembers its user turn', async () => {
    const { run, supabase } = setup()
    const reply = await run('tools', { talkId: TALK, ...heard('add call mom tomorrow'), calls: [tool('create_task', { text: 'Call mom', date: TOMORROW })] })
    const output = outputOf(reply)
    assert.equal(output.staged, true)
    assert.match(output.waiting, /Call mom/)
    assert.match(output.note, /NOT saved yet/)
    assert.ok(!supabase.db.tables.tasks.some((task) => task.text === 'Call mom'), 'nothing saved yet')
    assert.equal(reply.body.proposal.status, 'pending')
    const talk = talkOf(supabase, TALK)
    assert.equal(talk.proposal.turnId, 'item_u1')
    assert.equal(talk.proposal.staged[0].tool, 'create_task')
  })

  test('a second response in the same user turn adds to the card; a new turn replaces an older card', async () => {
    const older = { role: 'assistant', content: 'Shall I?', createdAt: new Date().toISOString(), proposal: { id: 'old-card', status: 'pending', createdAt: new Date().toISOString(), localDate: TODAY, summary: 'Old', actions: [{ label: 'Old' }], staged: [{ tool: 'save_note', args: { text: 'x' }, ref: '$1' }] } }
    const { run, supabase } = setup({ messages: [{ role: 'user', content: 'note x', createdAt: new Date().toISOString() }, older] })
    const first = await run('tools', { talkId: TALK, ...heard('add milk and eggs'), calls: [tool('create_task', { text: 'Buy eggs' })] })
    assert.deepEqual(first.body.proposalUpdate, { id: 'old-card', status: 'superseded' })
    assert.equal(conversationOf(supabase).messages.find((message) => message.proposal?.id === 'old-card').proposal.status, 'superseded')
    const second = await run('tools', { talkId: TALK, ...heard('add milk and eggs'), calls: [tool('save_note', { text: 'Eggs are free range' })] })
    assert.equal(second.body.proposal.id, first.body.proposal.id, 'same card')
    assert.equal(talkOf(supabase, TALK).proposal.staged.length, 2)
    const third = await run('tools', { talkId: TALK, ...heard('also remind me about rent', 'item_u2'), calls: [tool('create_task', { text: 'Rent reminder' })] })
    assert.notEqual(third.body.proposal.id, first.body.proposal.id)
    assert.equal(talkOf(supabase, TALK).proposal.staged.length, 1)
  })

  test('tools the call doesn’t have, bad JSON and unknown refs are refused for the model', async () => {
    const { run, supabase } = setup({ settings: { assistantConfirm: 'off' } })
    const reply = await run('tools', {
      talkId: TALK,
      ...heard('delete the dentist'),
      calls: [
        tool('delete_task_forever', { taskId: ID.dentist }),
        { callId: 'c2', name: 'create_task', arguments: '{oops' },
        tool('update_task', { taskId: 't:00000000', done: true }, 'c3'),
        tool('ask_daybook', { request: 'x' }, 'c4'),
      ],
    })
    assert.match(outputOf(reply, 0).message, /ask_daybook/)
    assert.match(outputOf(reply, 1).message, /JSON/)
    assert.match(outputOf(reply, 2).message, /Can't find that one/)
    assert.match(outputOf(reply, 3).message, /ask_daybook/)
    assert.equal(supabase.db.tables.tasks.length, 3, 'nothing changed')
  })

  test('a t: ref from the context points at the task', async () => {
    const { run, supabase } = setup({ settings: { assistantConfirm: 'off' } })
    const reply = await run('tools', { talkId: TALK, ...heard('I bought the milk'), calls: [tool('update_task', { taskId: `t:${ID.milk.replace(/-/g, '').slice(0, 8)}`, done: true })] })
    assert.equal(outputOf(reply).done, true, reply.body.outputs[0].output)
    assert.equal(supabase.db.tables.tasks.find((task) => task.id === ID.milk).done, true)
  })

  test('write_journal waits for a yes even with confirmations off', async () => {
    const { run, supabase } = setup({ settings: { assistantConfirm: 'off' } })
    const reply = await run('tools', { talkId: TALK, ...heard('that’s my day'), calls: [tool('write_journal', { date: TODAY, body: 'A calm day.', mood: 'good' })] })
    assert.equal(outputOf(reply).staged, true)
    assert.ok(!supabase.db.tables.journal_entries.some((entry) => entry.date === TODAY))
  })
})

describe('answering a card', () => {
  async function staged(settings = {}) {
    const fixture = setup({ settings })
    const reply = await fixture.run('tools', { talkId: TALK, heard: 'add call mom tomorrow', heardItemId: 'item_u1', calls: [tool('create_task', { text: 'Call mom', date: TOMORROW })] })
    return { ...fixture, card: reply.body.proposal }
  }

  test('a spoken yes in the same turn as the read-back is not trusted', async () => {
    const { run, supabase } = await staged()
    const reply = await run('tools', { talkId: TALK, heard: 'add call mom tomorrow', heardItemId: 'item_u1', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).ok, false)
    assert.ok(!supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
  })

  test('a clear spoken yes afterwards saves it and adds the chip to the talk', async () => {
    const { run, supabase, card } = await staged()
    const reply = await run('tools', { talkId: TALK, heard: 'yeah go for it', heardItemId: 'item_u2', calls: [tool('confirm_pending', { decision: 'yes' })] })
    const output = outputOf(reply)
    assert.equal(output.done, true, reply.body.outputs[0].output)
    assert.match(output.todayNow, /Call mom/)
    assert.ok(supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
    assert.deepEqual({ id: reply.body.proposalUpdate.id, status: reply.body.proposalUpdate.status }, { id: card.id, status: 'done' })
    const talk = talkOf(supabase, TALK)
    assert.equal(talk.proposal.status, 'done')
    assert.ok(talk.actions.some((action) => action.undoId))
  })

  test('"no, make it 4" with a yes from the model cancels the card as a correction', async () => {
    const { run, supabase } = await staged()
    const reply = await run('tools', { talkId: TALK, heard: 'no, make it at 4', heardItemId: 'item_u2', calls: [tool('confirm_pending', { decision: 'yes' })] })
    const output = outputOf(reply)
    assert.equal(output.correction, true)
    assert.equal(talkOf(supabase, TALK).proposal.status, 'cancelled')
  })

  test('a tapped yes runs once; a second tap finds nothing waiting', async () => {
    const { run, supabase, card } = await staged()
    const first = await run('confirm', { talkId: TALK, proposalId: card.id, decision: 'yes', tapped: true })
    assert.equal(first.body.ok, true)
    assert.equal(first.body.dataChanged, true)
    assert.equal(first.body.proposalUpdate.status, 'done')
    const second = await run('confirm', { talkId: TALK, proposalId: card.id, decision: 'yes', tapped: true })
    assert.equal(second.body.ok, false)
    assert.match(second.body.say, /Nothing is waiting/)
    assert.equal(supabase.db.tables.tasks.filter((task) => task.text === 'Call mom').length, 1)
  })

  test('a card that waited too long expires instead of running', async () => {
    const { run, supabase, card } = await staged()
    talkOf(supabase, TALK).proposal.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    const reply = await run('tools', { talkId: TALK, heard: 'yes', heardItemId: 'item_u2', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).expired, true)
    assert.deepEqual(reply.body.proposalUpdate, { id: card.id, status: 'expired' })
    assert.ok(!supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
  })

  test('a card from a hand-off (via) can be answered by voice, and its chips land on the talk', async () => {
    const now = new Date().toISOString()
    const viaCard = { id: 'via-card', status: 'pending', createdAt: now, localDate: TODAY, turnId: 'item_u4', summary: 'Add task “Plan trip”', actions: [{ label: 'Add task “Plan trip”', tool: 'create_task' }], staged: [{ tool: 'create_task', args: { text: 'Plan trip' }, ref: '$1' }] }
    const { run, supabase } = setup({ messages: [
      { role: 'user', content: 'add plan trip', createdAt: now, via: { talk: TALK } },
      { role: 'assistant', content: 'Shall I add it?', createdAt: now, via: { talk: TALK }, proposal: viaCard },
    ] })
    const reply = await run('tools', { talkId: TALK, heard: 'yes please', heardItemId: 'item_u5', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).done, true, reply.body.outputs[0].output)
    assert.ok(supabase.db.tables.tasks.some((task) => task.text === 'Plan trip'))
    assert.equal(conversationOf(supabase).messages.find((message) => message.proposal?.id === 'via-card').proposal.status, 'done')
    assert.equal(talkOf(supabase, TALK).actions.length, 1)
  })

  // A card staged by a hand-off in the same turn (or with no turn at all) never takes a spoken yes:
  // "please delete the dentist appointment" would otherwise confirm its own request.
  const deleteCard = (extra = {}) => ({ id: 'del-card', status: 'pending', createdAt: new Date().toISOString(), localDate: TODAY, summary: 'Delete “Dentist appointment” for good', actions: [{ label: 'Delete “Dentist appointment” for good', tool: 'delete_task_forever' }], staged: [{ tool: 'delete_task_forever', args: { taskId: 'task-x' }, ref: '$1' }], ...extra })
  const viaSetup = (card) => {
    const now = new Date().toISOString()
    return setup({ messages: [
      { role: 'user', content: 'delete the dentist appointment', createdAt: now, via: { talk: TALK } },
      { role: 'assistant', content: 'Delete it for good?', createdAt: now, via: { talk: TALK }, proposal: card },
    ] })
  }

  test('a hand-off card is not confirmed by the same turn that asked for it', async () => {
    const { run, supabase } = viaSetup(deleteCard({ turnId: 'item_A' }))
    const reply = await run('tools', { talkId: TALK, heard: 'please delete the dentist appointment', heardItemId: 'item_A', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).ok, false)
    assert.equal(conversationOf(supabase).messages.find((message) => message.proposal?.id === 'del-card').proposal.status, 'pending')
  })

  test('a card with no turn (typed before the call, or an unstamped hand-off) needs a tap', async () => {
    const { run, supabase } = viaSetup(deleteCard())
    const reply = await run('tools', { talkId: TALK, heard: 'yes', heardItemId: 'item_B', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).ok, false)
    assert.match(outputOf(reply).message, /tap Yes/)
    assert.equal(conversationOf(supabase).messages.find((message) => message.proposal?.id === 'del-card').proposal.status, 'pending')
    const no = await run('tools', { talkId: TALK, heard: 'no', heardItemId: 'item_C', calls: [tool('confirm_pending', { decision: 'no' })] })
    assert.equal(outputOf(no).cancelled, true, 'a spoken no still cancels it')
  })

  test('a new instruction is not a yes to the waiting card', async () => {
    const { run, supabase } = viaSetup(deleteCard({ turnId: 'item_A', summary: 'Move “Dentist appointment” to Thursday', actions: [{ label: 'Move “Dentist appointment” to Thursday', tool: 'update_task' }], staged: [{ tool: 'update_task', args: { taskId: 'task-x', date: TOMORROW }, ref: '$1' }] }))
    const reply = await run('tools', { talkId: TALK, heard: 'go with friday', heardItemId: 'item_B', calls: [tool('confirm_pending', { decision: 'yes' })] })
    assert.equal(outputOf(reply).ok, false)
    assert.notEqual(conversationOf(supabase).messages.find((message) => message.proposal?.id === 'del-card').proposal.status, 'done')
  })

  test('undo_last with a card waiting declines it; without undo words it is refused', async () => {
    const { run } = await staged()
    let reply = await run('tools', { talkId: TALK, heard: 'scratch that', heardItemId: 'item_u2', calls: [tool('undo_last', {})] })
    assert.equal(outputOf(reply).cancelled, true)
    reply = await run('tools', { talkId: TALK, heard: 'what is on today', heardItemId: 'item_u3', calls: [tool('undo_last', {})] })
    assert.match(outputOf(reply).message, /Only undo when they ask/)
  })

  test('undo_last takes back the last change that ran', async () => {
    const { run, supabase } = setup({ settings: { assistantConfirm: 'changes' } })
    await run('tools', { talkId: TALK, heard: 'add call mom', heardItemId: 'item_u1', calls: [tool('create_task', { text: 'Call mom' })] })
    assert.ok(supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
    const reply = await run('tools', { talkId: TALK, heard: 'actually undo that', heardItemId: 'item_u2', calls: [tool('undo_last', {})] })
    assert.equal(outputOf(reply).done, true, reply.body.outputs[0].output)
    assert.equal(reply.body.undone.length, 1)
    assert.ok(!supabase.db.tables.tasks.some((task) => task.text === 'Call mom'))
    assert.equal(talkOf(supabase, TALK).actions[0].undone, true)
  })
})

describe('POST ?op=checkpoint', () => {
  const tally = (scale = 1) => ({ responses: 2 * scale, textIn: 4000 * scale, textCached: 3000 * scale, audioIn: 600 * scale, audioCached: 300 * scale, textOut: 200 * scale, audioOut: 900 * scale })
  const turns = [{ id: 'item_u1', r: 'u', t: 'How is my day?', at: new Date().toISOString() }, { id: 'item_a1', r: 'a', t: 'Pretty clear: the dentist tomorrow.', at: new Date().toISOString() }]
  const voiceDay = (supabase) => conversationOf(supabase).usage.ai.days[TODAY].voice
  const ageSegment = (supabase, sessionId, seconds) => {
    conversationOf(supabase).usage.ai.talks[TALK].segs[sessionId].mintedAt = Date.now() - seconds * 1000
  }

  test('the same checkpoint twice bills once; a bigger tally bills only the difference', async () => {
    const { run, supabase } = setup()
    const { body: started } = await run('start', { talkId: TALK })
    ageSegment(supabase, started.sessionId, 120)
    const base = { talkId: TALK, sessionId: started.sessionId, startedAt: new Date().toISOString(), turns, transcribeSeconds: 10 }
    const first = await run('checkpoint', { ...base, seq: 1, seconds: 60, tally: tally() })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.billed, true)
    const after1 = structuredClone(voiceDay(supabase))
    assert.equal(after1.n, 1)
    assert.equal(after1.s, 60)
    const again = await run('checkpoint', { ...base, seq: 1, seconds: 60, tally: tally() })
    assert.equal(again.body.billed, false)
    assert.deepEqual(voiceDay(supabase), after1, 'a repeated checkpoint changes nothing')
    await run('checkpoint', { ...base, seq: 2, seconds: 90, tally: tally(2) })
    const after2 = voiceDay(supabase)
    assert.equal(after2.n, 1, 'still one call')
    assert.equal(after2.s, 90)
    assert.ok(after2.u > after1.u && after2.u < after1.u * 2.1)
    assert.ok(Math.abs(talkOf(supabase, TALK).talk.usd - after2.u / 1e6) < 0.0001)
  })

  test('seconds are clamped to the time since the mint and to the call length', async () => {
    const { run, supabase } = setup()
    const { body: started } = await run('start', { talkId: TALK })
    ageSegment(supabase, started.sessionId, 100)
    await run('checkpoint', { talkId: TALK, sessionId: started.sessionId, seq: 1, seconds: 5000, turns, tally: tally() })
    assert.ok(voiceDay(supabase).s <= 101 && voiceDay(supabase).s >= 99, `got ${voiceDay(supabase).s}`)
    const other = setup()
    const { body: two } = await other.run('start', { talkId: TALK })
    ageSegment(other.supabase, two.sessionId, 7200)
    await other.run('checkpoint', { talkId: TALK, sessionId: two.sessionId, seq: 1, seconds: 5000, turns, tally: tally() })
    assert.equal(voiceDay(other.supabase).s, 930, '15 minutes + 30 s')
  })

  test('the final checkpoint saves the talk (it survives the conversation save) and returns it', async () => {
    const { run, supabase } = setup()
    const { body: started } = await run('start', { talkId: TALK, mode: 'hold', intent: 'chat' })
    ageSegment(supabase, started.sessionId, 300)
    const reply = await run('checkpoint', { talkId: TALK, sessionId: started.sessionId, seq: 1, seconds: 240, turns, tally: tally(), final: true, end: 'quiet', mode: 'hold', intent: 'chat' })
    const message = reply.body.message
    assert.equal(message.talk.id, TALK)
    assert.equal(message.talk.end, 'quiet')
    assert.equal(message.talk.turns.length, 2)
    assert.equal(message.talk.mode, 'hold')
    assert.equal(message.talkState, undefined)
    const stored = talkOf(supabase, TALK)
    assert.ok(stored.talk.endedAt)
    assert.equal(stored.talk.seconds, 240)
    assert.ok(reply.body.monthUsd > 0)
    assert.equal(reply.body.dailyLeftSec, 1800 - 240)
  })

  test('a call where nothing was said isn’t kept in the chat, but its usage still counts', async () => {
    const { run, supabase } = setup()
    const { body: started } = await run('start', { talkId: TALK })
    ageSegment(supabase, started.sessionId, 30)
    const reply = await run('checkpoint', { talkId: TALK, sessionId: started.sessionId, seq: 1, seconds: 20, turns: [{ id: 'a0', r: 'a', t: 'Hi Sam!' }], tally: tally(), final: true })
    assert.equal(reply.body.message, undefined)
    assert.equal(talkOf(supabase, TALK), undefined)
    assert.ok(voiceDay(supabase).u > 0)
  })

  test('an unknown session from an old call saves the words but bills nothing', async () => {
    const { run, supabase } = setup()
    const reply = await run('checkpoint', { talkId: TALK, sessionId: 'not-minted', seq: 1, seconds: 20, turns, tally: tally() })
    assert.equal(reply.body.billed, false)
    assert.equal(talkOf(supabase, TALK).talk.turns.length, 2)
  })

  test('a recent call whose segment never reached the ledger is opened late and billed once', async () => {
    const { run, supabase } = setup()
    const base = { talkId: TALK, sessionId: 'late-seg', startedAt: new Date(Date.now() - 60000).toISOString(), turns, tally: tally() }
    const reply = await run('checkpoint', { ...base, seq: 1, seconds: 40 })
    assert.equal(reply.body.billed, true, JSON.stringify(reply.body))
    const after = structuredClone(voiceDay(supabase))
    assert.equal(after.n, 1)
    assert.ok(after.s >= 39 && after.s <= 41, `got ${after.s}`)
    const again = await run('checkpoint', { ...base, seq: 1, seconds: 40 })
    assert.equal(again.body.billed, false)
    assert.deepEqual(voiceDay(supabase), after, 'opening it again never resets what it billed')
  })

  test('a repeated final checkpoint keeps the end it had', async () => {
    const { run, supabase } = setup()
    const { body: started } = await run('start', { talkId: TALK })
    ageSegment(supabase, started.sessionId, 300)
    const final = { talkId: TALK, sessionId: started.sessionId, seq: 1, seconds: 240, turns, tally: tally(), final: true, end: 'quiet' }
    await run('checkpoint', final)
    const first = structuredClone(talkOf(supabase, TALK).talk)
    talkOf(supabase, TALK).talk.endedAt = '2026-01-01T00:00:00.000Z'
    await run('checkpoint', { ...final, end: 'user' })
    const stored = talkOf(supabase, TALK).talk
    assert.equal(stored.endedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(stored.end, first.end)
  })
})

describe('GET ?op=usage', () => {
  test('the summary, prefs and budget', async () => {
    const { run } = setup({ usage: ledgerWith([{ day: TODAY, feature: 'chat', micros: 120_000 }]), settings: { aiBudgetUsd: 10, voice: { dailyMinutes: 20 } } })
    const reply = await run('usage', {}, { method: 'GET', query: { localDate: TODAY, timeZone: 'UTC' } })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.available, true)
    assert.ok(Math.abs(reply.body.summary.today.total - 0.12) < 1e-9)
    assert.equal(reply.body.budgetUsd, 10)
    assert.equal(reply.body.prefs.dailyMinutes, 20)
    assert.equal(reply.body.pricesChecked, '2026-10-11')
  })

  test('without the usage column it says so', async () => {
    const reply = await setup({ usage: false }).run('usage', {}, { method: 'GET' })
    assert.equal(reply.body.available, false)
    assert.equal(reply.body.summary, null)
  })

  test('wrong method or op', async () => {
    const { run } = setup()
    assert.equal((await run('usage', {})).status, 405)
    assert.equal((await run('nope', {})).status, 400)
  })
})

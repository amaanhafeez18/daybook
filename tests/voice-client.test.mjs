import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_CAUGHT, applyEvent, createTranscript, dropItem, lastAssistantWords, latestPair, orderedTurns, seedTurns, startSegment, storedTurns, transcriptFor,
} from '../src/lib/voice/transcript.js'
import { canContinue, capCheck, clock, echoScore, isEcho, newTalkId, routeFromLabel } from '../src/lib/voice/policy.js'
import { cardWords } from '../src/components/voice/cardWords.js'

// Feeds a list of realtime events (shapes from the live probe) into a fresh transcript.
function feed(events, state = createTranscript()) {
  let now = Date.parse('2026-10-11T21:12:00Z')
  for (const event of events) applyEvent(state, event, (now += 100))
  return state
}

const userAudio = (id, previous) => [
  { type: 'input_audio_buffer.committed', item_id: id, previous_item_id: previous },
  { type: 'conversation.item.added', previous_item_id: previous, item: { id, type: 'message', role: 'user', content: [{ type: 'input_audio', transcript: null }] } },
]
const assistantReply = (responseId, id, previous, text, phase = 'final_answer') => [
  { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', response_id: responseId, item: { id, type: 'message', role: 'assistant', phase, content: [] } },
  { type: 'conversation.item.added', previous_item_id: previous, item: { id, type: 'message', role: 'assistant', phase, content: [] } },
  ...text.split(' ').map((word, index) => ({ type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: id, delta: (index ? ' ' : '') + word })),
  { type: 'response.output_audio_transcript.done', response_id: responseId, item_id: id, transcript: text },
]
const done = (responseId, status = 'completed', output = []) => ({ type: 'response.done', response: { id: responseId, status, output } })
const completed = (id, transcript, seconds = 2) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript, usage: { type: 'duration', seconds } })

describe('transcript: order', () => {
  test('a late user transcript stays before the reply it caused', () => {
    const state = feed([
      ...userAudio('item_u1', null),
      ...assistantReply('resp_1', 'item_a1', 'item_u1', 'Sure, what time?'),
      completed('item_u1', 'Add call mom tomorrow'), // arrives after the reply started (probe §4)
      done('resp_1'),
    ])
    const turns = orderedTurns(state)
    assert.deepEqual(turns.map((turn) => [turn.r, turn.text]), [['u', 'Add call mom tomorrow'], ['a', 'Sure, what time?']])
    assert.equal(turns[0].partial, false)
  })

  test('two completions out of order keep conversation order', () => {
    const state = feed([
      ...userAudio('item_u1', null),
      ...assistantReply('resp_1', 'item_a1', 'item_u1', 'Okay.'),
      done('resp_1'),
      ...userAudio('item_u2', 'item_a1'),
      ...assistantReply('resp_2', 'item_a2', 'item_u2', 'Done.'),
      done('resp_2'),
      completed('item_u2', 'second thing'),
      completed('item_u1', 'first thing'),
    ])
    assert.deepEqual(orderedTurns(state).map((turn) => turn.text), ['first thing', 'Okay.', 'second thing', 'Done.'])
  })

  test('items that only arrive through response events are appended, then placed by previous_item_id', () => {
    const state = feed([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', response_id: 'resp_1', item: { id: 'item_a1', type: 'message', role: 'assistant', content: [] } },
      ...userAudio('item_u1', null),
      { type: 'conversation.item.added', previous_item_id: 'item_u1', item: { id: 'item_a1', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_audio_transcript.done', item_id: 'item_a1', transcript: 'Hi.' },
      completed('item_u1', 'Hello'),
    ])
    assert.deepEqual(orderedTurns(state).map((turn) => turn.r), ['u', 'a'])
  })

  test('a failed transcription shows a placeholder and is not stored', () => {
    const state = feed([...userAudio('item_u1', null), { type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_u1' }])
    assert.equal(orderedTurns(state)[0].text, NOT_CAUGHT)
    assert.equal(transcriptFor(state, 'item_u1').done, true)
    assert.equal(transcriptFor(state, 'item_u1').text, '')
    assert.deepEqual(storedTurns(orderedTurns(state), { state }).turns, [])
  })
})

describe('transcript: what is kept', () => {
  test('a preamble before a tool call shows but is not stored', () => {
    const state = feed([
      ...userAudio('item_u1', null),
      completed('item_u1', 'Add a task zz-test for tomorrow'),
      ...assistantReply('resp_1', 'item_c1', 'item_u1', 'One sec.', 'commentary'),
      { type: 'response.output_item.added', response_id: 'resp_1', item: { id: 'item_f1', type: 'function_call', name: 'create_task', call_id: 'call_1', arguments: '' } },
      done('resp_1', 'completed', [{ id: 'item_f1', type: 'function_call', status: 'completed', name: 'create_task', call_id: 'call_1', arguments: '{}' }]),
      ...assistantReply('resp_2', 'item_a2', 'item_f1', 'Done, it’s on tomorrow.'),
      done('resp_2'),
    ])
    const shown = orderedTurns(state)
    assert.deepEqual(shown.map((turn) => turn.phase), [null, 'commentary', 'final_answer'])
    const { turns } = storedTurns(shown, { state })
    assert.deepEqual(turns.map((turn) => [turn.r, turn.t]), [['u', 'Add a task zz-test for tomorrow'], ['a', 'Done, it’s on tomorrow.']])
    // Function calls and their outputs are never turns.
    assert.ok(!shown.some((turn) => turn.id === 'item_f1'))
    // The screen shows the answer, not the preamble, once it's there.
    assert.equal(latestPair(shown).assistant.text, 'Done, it’s on tomorrow.')
  })

  test('a cancelled reply is marked interrupted', () => {
    const state = feed([
      ...userAudio('item_u1', null),
      ...assistantReply('resp_1', 'item_a1', 'item_u1', 'Let me tell you about'),
      done('resp_1', 'cancelled', [{ id: 'item_a1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: 'Let me tell you about' }] }]),
    ])
    const reply = orderedTurns(state).find((turn) => turn.r === 'a')
    assert.equal(reply.interrupted, true)
    assert.equal(reply.partial, false)
  })

  test('typed turns are r "t", done at once; system items are hidden', () => {
    const state = feed([
      { type: 'conversation.item.added', previous_item_id: null, item: { id: 'item_s1', type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Daybook context…' }] } },
      { type: 'conversation.item.added', previous_item_id: 'item_s1', item: { id: 'item_t1', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'log a chicken wrap' }] } },
      ...assistantReply('resp_1', 'item_a1', 'item_t1', 'Logged.'),
      done('resp_1'),
    ])
    assert.deepEqual(orderedTurns(state).map((turn) => [turn.r, turn.text]), [['t', 'log a chicken wrap'], ['a', 'Logged.']])
    assert.deepEqual(transcriptFor(state, 'item_t1'), { done: true, text: 'log a chicken wrap' })
  })

  test('an echo the client deletes leaves the transcript', () => {
    const state = feed([...userAudio('item_u1', null), completed('item_u1', 'hello there')])
    dropItem(state, 'item_u1')
    assert.deepEqual(orderedTurns(state), [])
    const deleted = feed([...userAudio('item_u2', null), { type: 'conversation.item.deleted', item_id: 'item_u2' }])
    assert.deepEqual(orderedTurns(deleted), [])
  })

  test('a continued call keeps the earlier segment and seeds saved turns', () => {
    const state = feed([...userAudio('item_u1', null), completed('item_u1', 'first part'), ...assistantReply('resp_1', 'item_a1', 'item_u1', 'Got it.'), done('resp_1')])
    startSegment(state)
    feed([...userAudio('item_u1', null), completed('item_u1', 'second part')], state) // ids restart in a new session
    assert.deepEqual(orderedTurns(state).map((turn) => turn.text), ['first part', 'Got it.', 'second part'])
    const seeded = seedTurns(createTranscript(), [{ id: 'x', r: 'u', t: 'saved before', at: '2026-10-11T21:00:00.000Z' }, { r: 'z', t: 'bad' }])
    assert.deepEqual(orderedTurns(seeded).map((turn) => turn.text), ['saved before'])
  })

  test('the last assistant words for the echo check', () => {
    const state = feed([...assistantReply('resp_1', 'item_a1', null, 'one two three four five'), done('resp_1')])
    assert.deepEqual(lastAssistantWords(state, 3), ['three', 'four', 'five'])
  })
})

describe('storedTurns caps', () => {
  const turn = (index, text = `turn ${index}`) => ({ id: `item_${index}`, r: index % 2 ? 'a' : 'u', text, at: '2026-10-11T21:00:00.000Z' })

  test('at most 150 turns, oldest dropped, with a count', () => {
    const { turns, trimmed } = storedTurns(Array.from({ length: 170 }, (_, index) => turn(index)))
    assert.equal(turns.length, 150)
    assert.equal(trimmed, 20)
    assert.equal(turns[0].t, 'turn 20')
    assert.deepEqual(Object.keys(turns[0]), ['id', 'r', 't', 'at'])
  })

  test('each turn at most 1,500 characters and 30,000 in all', () => {
    const { turns, trimmed } = storedTurns(Array.from({ length: 40 }, (_, index) => turn(index, 'x'.repeat(2000))))
    assert.ok(turns.every((item) => item.t.length === 1500))
    assert.equal(turns.length, 20)
    assert.equal(trimmed, 20)
  })

  test('the saved body stays inside a keepalive request', () => {
    const wide = 'é'.repeat(1500) // two bytes each in UTF-8
    const { turns } = storedTurns(Array.from({ length: 150 }, (_, index) => turn(index, wide)), { totalChars: 1e9 })
    const bytes = new TextEncoder().encode(JSON.stringify(turns)).length
    assert.ok(bytes <= 56000, `${bytes} bytes`)
    assert.ok(turns.length > 0)
  })
})

describe('policy: echo check', () => {
  const said = 'Okay I will add call mom tomorrow at five and remind you then'.split(' ')

  test('a piece of what Daybook just said is an echo', () => {
    assert.equal(isEcho('add call mom tomorrow at five', said), true)
    assert.ok(echoScore('I will add call mom tomorrow', said) >= 0.6)
  })

  test('a real answer is not', () => {
    assert.equal(isEcho('yes please do that', said), false)
    assert.equal(isEcho('no make it six instead', said), false)
    assert.equal(isEcho('yes add it', 'Should I add it?'.split(' ')), false)
  })

  test('short turns never count (fewer than 3 words)', () => {
    assert.equal(isEcho('tomorrow five', said), false)
    assert.equal(isEcho('', said), false)
    assert.equal(isEcho('add call mom', []), false)
  })

  test('only the last 30 words are compared', () => {
    const long = [...'call mom tomorrow at five'.split(' '), ...Array.from({ length: 40 }, (_, index) => `w${index}`)]
    assert.equal(isEcho('call mom tomorrow at five', long), false)
  })
})

describe('policy: caps', () => {
  const base = { sessionSec: 900, dailyLeftSec: 1800, budgetUsd: 20, spentUsd: 1, silenceSec: 60 }

  test('warns a minute before the call limit and ends at it', () => {
    assert.equal(capCheck({ ...base, elapsedSec: 839 }).warnTime, false)
    const warn = capCheck({ ...base, elapsedSec: 840 })
    assert.equal(warn.warnTime, true)
    assert.equal(warn.end, null)
    assert.equal(warn.leftSec, 60)
    const end = capCheck({ ...base, elapsedSec: 900 })
    assert.equal(end.end, 'cap')
    assert.equal(end.daily, false)
  })

  test('the daily limit ends the call when it is the closer one', () => {
    const check = capCheck({ ...base, dailyLeftSec: 300, elapsedSec: 300 })
    assert.equal(check.end, 'daily')
    // A checkpoint refreshed it 100 s in: 150 s left from there.
    const refreshed = capCheck({ ...base, dailyLeftSec: 150, dailyAt: 100, elapsedSec: 200 })
    assert.equal(refreshed.leftSec, 50)
    assert.equal(refreshed.warnTime, true)
    assert.equal(capCheck({ ...base, dailyLeftSec: 150, dailyAt: 100, elapsedSec: 250 }).end, 'daily')
  })

  test('budget: a heads-up at 80%, the end at 100%, nothing without a budget', () => {
    assert.equal(capCheck({ ...base, spentUsd: 15.9 }).warnBudget, false)
    assert.equal(capCheck({ ...base, spentUsd: 16 }).warnBudget, true)
    assert.equal(capCheck({ ...base, spentUsd: 16 }).end, null)
    assert.equal(capCheck({ ...base, spentUsd: 20 }).end, 'budget')
    assert.equal(capCheck({ ...base, budgetUsd: 0, spentUsd: 500 }).end, null)
    assert.equal(capCheck({ ...base, budgetUsd: 0, spentUsd: 500 }).warnBudget, false)
  })

  test('silence: "Still there?" 15 s before, then hang up; anything going on holds it', () => {
    assert.equal(capCheck({ ...base, idleSec: 44 }).warnSilence, false)
    const warn = capCheck({ ...base, idleSec: 45 })
    assert.equal(warn.warnSilence, true)
    assert.equal(warn.idleLeftSec, 15)
    assert.equal(capCheck({ ...base, idleSec: 60 }).end, 'quiet')
    const busy = capCheck({ ...base, idleSec: 70, busy: true })
    assert.equal(busy.end, null)
    assert.equal(busy.warnSilence, false)
  })

  test('the budget wins over time, time over silence; bad input is safe', () => {
    assert.equal(capCheck({ ...base, elapsedSec: 900, spentUsd: 25, idleSec: 99 }).end, 'budget')
    assert.equal(capCheck({ ...base, elapsedSec: 900, idleSec: 99 }).end, 'cap')
    assert.equal(capCheck({ elapsedSec: 'x', sessionSec: undefined, dailyLeftSec: null }).end, null)
  })

  test('continue only for limits that leave room', () => {
    assert.equal(canContinue('cap', { dailyLeftSec: 600 }), true)
    assert.equal(canContinue('quiet'), true)
    assert.equal(canContinue('background', { dailyLeftSec: 30 }), false)
    assert.equal(canContinue('daily'), false)
    assert.equal(canContinue('budget'), false)
    assert.equal(canContinue('user'), false)
    assert.equal(canContinue('network', { budgetPct: 1 }), false)
  })
})

describe('policy: helpers', () => {
  test('headphones from the mic label', () => {
    assert.equal(routeFromLabel('AirPods Pro'), 'headphones')
    assert.equal(routeFromLabel('Bluetooth Headset'), 'headphones')
    assert.equal(routeFromLabel('Beats Studio Buds'), 'headphones')
    assert.equal(routeFromLabel('iPhone Microphone'), 'speaker')
    assert.equal(routeFromLabel('Default - MacBook Pro Microphone', { touch: false }), 'desktop')
    assert.equal(routeFromLabel(''), 'speaker')
  })

  test('clock and talk ids', () => {
    assert.equal(clock(0), '0:00')
    assert.equal(clock(252), '4:12')
    assert.equal(clock(3725), '1:02:05')
    assert.match(newTalkId(), /^talk_[a-z0-9]{8,32}$/)
    assert.notEqual(newTalkId(), newTalkId())
  })
})

describe('cardWords (the voice card says what Yes does)', () => {
  const card = (...tools) => ({ actions: tools.map((tool) => ({ label: 'x', tool })) })
  test('food, a workout, a weight or a catch-up: Log it', () => {
    assert.deepEqual(cardWords(card('food_log')), { yes: 'Log it', say: 'yes, log it' })
    assert.equal(cardWords(card('food_log', 'gym_quick_log')).yes, 'Log it')
    assert.equal(cardWords(card('gym_log_workout')).yes, 'Log it')
    assert.equal(cardWords(card('log_contact')).yes, 'Log it')
  })
  test('the journal: Save entry; anything else: Save', () => {
    assert.equal(cardWords(card('write_journal')).yes, 'Save entry')
    assert.deepEqual(cardWords(card('create_task', 'food_log')), { yes: 'Save', say: 'yes, save it' })
    assert.equal(cardWords(card('update_settings')).yes, 'Save')
  })
  test('a delete, or a card without tools, keeps the plain Yes', () => {
    assert.equal(cardWords(card('delete_task')).yes, 'Yes, do it')
    assert.equal(cardWords(card('create_task', 'delete_event')).yes, 'Yes, do it')
    assert.equal(cardWords({ actions: [{ label: 'Something' }] }).yes, 'Yes, do it')
    assert.equal(cardWords(null).yes, 'Yes, do it')
  })
  test('deletes anywhere in the name keep the plain Yes; edits and goals say Save', () => {
    for (const tool of ['food_delete_entry', 'weight_delete', 'gym_delete_session', 'gym_delete_routine', 'gym_delete_exercise', 'forget', 'delete_task_forever']) {
      assert.deepEqual(cardWords(card(tool)), { yes: 'Yes, do it', say: 'yes' }, tool)
    }
    assert.equal(cardWords(card('food_log', 'food_delete_entry')).yes, 'Yes, do it')
    for (const tool of ['food_set_goals', 'food_update_entry', 'food_update_prefs', 'food_calculate_goals', 'gym_edit_session']) {
      assert.equal(cardWords(card(tool)).yes, 'Save', tool)
    }
    assert.equal(cardWords(card('gym_log_bodyweight', 'food_copy_entries')).yes, 'Log it')
  })
})

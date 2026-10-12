// The Assistant page's pure helpers (src/lib/assistantChat.js): start-screen prompts by space and by
// what's going on, which chips and cards a reply shows, Undo availability, expired cards, hand-off
// links, merging the history and the typing pace; and the chat session that outlives the page
// (src/lib/assistantSession.js).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_MAX_CHARS, PROPOSAL_TTL_MS, UNDO_TTL_MS, askAssistantHash, assistantSpace, buildSuggestions, cacheMessage, canUndo, cardExpired, collapsesCard, composerPlaceholder,
  mergeHistory, messageKey, proposalExpired, readAskHash, revealCount, setsOffer, undoRefused, visibleActions, withKeys,
  TALK_CONTINUE_MS, isTalk, talkChanges, talkContinuable, talkGist, talkLength, talkProposals, talkTitle, visibleChatMessages,
} from '../src/lib/assistantChat.js'
import {
  beginReply, clearAssistantSession, endReply, getSession, sessionWriter, stopReply, typeInto, useAssistantStreaming,
} from '../src/lib/assistantSession.js'
import { toISO } from '../src/lib/dates.js'
import { featureFigures, voiceBlocked } from '../src/lib/aiUsageClient.js'

const TODAY = '2026-10-06'
const texts = (list) => list.map((item) => item.text)

describe('start screen prompts', () => {
  const base = { tasks: [], friends: [], settings: {}, foodEntries: [], today: TODAY, hour: 10 }

  test('Plan: tasks first, then a "Remind me to…" starter and people', () => {
    const list = buildSuggestions({ ...base, tasks: [{ id: 't', text: 'x', date: '2026-10-01' }], friends: [{ id: 'f' }] })
    assert.deepEqual(texts(list), ['Reschedule my overdue task', 'What’s on my plate today?', 'Remind me to…', 'Who should I catch up with?'])
    assert.equal(list[2].fill, 'Remind me to ', 'a starter fills the composer instead of sending')
    assert.equal(list[0].fill, undefined)
  })

  test('Plan in the evening plans tomorrow; never more than four', () => {
    const list = buildSuggestions({ ...base, hour: 19, gymDay: true, settings: { food: { goals: { calories: 2000 } } } })
    assert.equal(list[0].text, 'Plan tomorrow')
    assert.equal(list.length, 4)
  })

  test('Health: log a meal, calories left, today’s workout, log my weight', () => {
    const list = buildSuggestions({ ...base, space: 'health', gymDay: true, settings: { food: { goals: { calories: 2000 } } } })
    assert.deepEqual(texts(list), ['Log a meal…', 'How many calories do I have left?', 'What’s today’s workout?', 'Log my weight…'])
    assert.equal(list[0].fill, 'I had ')
    assert.equal(list[3].fill, 'I weigh ')
  })

  test('Health respects the areas that are off', () => {
    const noFood = buildSuggestions({ ...base, space: 'health', noGymPlan: true, settings: { areas: { food: false } } })
    assert.ok(!texts(noFood).some((text) => /meal|calories/i.test(text)))
    assert.ok(texts(noFood).includes('Help me set up a gym plan'))
    const noGym = buildSuggestions({ ...base, space: 'health', gymDay: true, settings: { areas: { gym: false } } })
    assert.ok(!texts(noGym).some((text) => /workout|gym/i.test(text)))
    // Without Gym and Food there's no Health space: the Plan prompts show.
    const neither = buildSuggestions({ ...base, space: 'health', settings: { areas: { gym: false, food: false } } })
    assert.ok(texts(neither).includes('Remind me to…'))
  })

  test('space and placeholder', () => {
    assert.equal(assistantSpace('health', {}), 'health')
    assert.equal(assistantSpace('health', { gym: false, food: false }), 'plan')
    assert.equal(assistantSpace(undefined, {}), 'plan')
    assert.match(composerPlaceholder('health'), /food/)
    assert.notEqual(composerPlaceholder('plan'), composerPlaceholder('health'))
  })
})

describe('chips under a reply', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const createdAt = '2026-10-06T11:50:00Z'

  test('a chip the reply already says is hidden; failures and Undo chips stay', () => {
    const actions = [
      { tool: 'create_task', ok: true, message: 'Created task "Buy milk".' },
      { tool: 'save_note', ok: true, message: 'Saved the note.', undoId: 'u1' },
      { tool: 'update_task', ok: false, message: 'No task with that id.' },
      { tool: 'create_event', ok: true, message: 'Added "Gym" to the calendar.' },
    ]
    const reply = 'Created task “Buy milk”. Saved the note. No task with that id.'
    const shown = visibleActions(actions, reply, { createdAt, now })
    assert.deepEqual(shown.map((action) => action.tool), ['save_note', 'update_task', 'create_event'])
    assert.equal(visibleActions(actions, 'Done ✓', { createdAt, now }).length, 4)
    assert.equal(visibleActions([{ tool: 'x', ok: true, message: '' }, null], '', { now }).length, 0)
  })

  test('Undo works for an hour on actions that worked and weren’t undone', () => {
    const action = { ok: true, undoId: 'u1', message: 'Saved.' }
    assert.equal(canUndo(action, createdAt, now), true)
    assert.equal(canUndo({ ...action, undone: true }, createdAt, now), false)
    assert.equal(canUndo({ ...action, ok: false }, createdAt, now), false)
    assert.equal(canUndo({ ...action, undoId: undefined }, createdAt, now), false)
    assert.equal(canUndo(action, new Date(now - UNDO_TTL_MS - 1000).toISOString(), now), false)
    assert.equal(canUndo({ ...action, undoBlocked: true }, createdAt, now), false, 'refused for good on this visit')
  })

  test('a refusal stops the chip offering Undo only when a retry can’t help', () => {
    assert.equal(undoRefused({ status: 410 }), true)
    assert.equal(undoRefused({ status: 404 }), true)
    // Undoing what changed it (another chip, or in the app) makes it possible again.
    assert.equal(undoRefused({ status: 409, payload: { changed: true } }), false, 'changed since: not for good')
    assert.equal(undoRefused({ status: 409, payload: { gone: true } }), true)
    assert.equal(undoRefused({ status: 409, payload: {} }), false, 'couldn’t run right now')
    assert.equal(undoRefused({ status: 0 }), false, 'offline')
    assert.equal(undoRefused(null), false)
  })

  test('settled cards collapse only when they are not on the newest message', () => {
    for (const status of ['superseded', 'expired', 'cancelled']) {
      assert.equal(collapsesCard(status, false), true, status)
      assert.equal(collapsesCard(status, true), false, status)
    }
    for (const status of ['pending', 'done', 'partial', 'failed', 'interrupted', 'stale']) assert.equal(collapsesCard(status, false), false, status)
  })
})

describe('expired cards', () => {
  const now = Date.now()
  const fresh = new Date(now - 60 * 1000).toISOString()
  const old = new Date(now - PROPOSAL_TTL_MS - 60 * 1000).toISOString()

  test('a card expires after its time or once the day changes', () => {
    assert.equal(proposalExpired({ createdAt: fresh, localDate: toISO(new Date(now)) }, null, now), false)
    assert.equal(proposalExpired({ createdAt: old }, null, now), true)
    assert.equal(proposalExpired({ createdAt: fresh, localDate: '2000-01-01' }, null, now), true)
    assert.equal(proposalExpired({}, fresh, now), false, 'falls back to the message time')
  })

  test('cardExpired finds the card and reads its state', () => {
    const messages = [
      { role: 'assistant', createdAt: old, proposal: { id: 'p1', status: 'pending' } },
      { role: 'assistant', createdAt: fresh, proposal: { id: 'p2', status: 'pending' } },
      { role: 'assistant', createdAt: fresh, proposal: { id: 'p3', status: 'expired' } },
      { role: 'assistant', createdAt: old, proposal: { id: 'p4', status: 'done' } },
    ]
    assert.equal(cardExpired(messages, 'p1', now), true)
    assert.equal(cardExpired(messages, 'p2', now), false)
    assert.equal(cardExpired(messages, 'p3', now), true)
    assert.equal(cardExpired(messages, 'p4', now), false, 'a card that ran is not expired')
    assert.equal(cardExpired(messages, 'nope', now), false)
  })
})

describe('"Log my sets"', () => {
  const done = { action: 'start', name: 'Legs', when: 'done' }
  const quickCard = (status = 'pending') => ({ id: 'p1', status, actions: [{ label: 'Log Legs today', tool: 'gym_quick_log' }] })

  test('it cancels a card that is only the quick log', () => {
    assert.deepEqual(setsOffer(done, quickCard(), []), { show: true, cancels: 'p1' })
    assert.deepEqual(setsOffer(done, { id: 'p1', status: 'pending', actions: [{ label: 'Log Legs today' }] }, []), { show: true, cancels: 'p1' }, 'a cached card without tool names')
  })

  test('a card with other changes on it is never cancelled by it (the button hides)', () => {
    const mixed = { id: 'p1', status: 'pending', actions: [{ label: 'Log Legs today', tool: 'gym_quick_log' }, { label: 'Log 2 eggs', tool: 'food_log' }] }
    assert.deepEqual(setsOffer(done, mixed, []), { show: false, cancels: null })
    assert.deepEqual(setsOffer(done, { id: 'p1', status: 'pending', actions: [{ label: 'Log Legs today' }, { label: 'Log 2 eggs' }] }, []), { show: false, cancels: null }, 'a cached card without tool names')
  })

  test('a card without the quick log on it is left alone (the button still shows)', () => {
    assert.deepEqual(setsOffer(done, { id: 'p1', status: 'pending', actions: [{ label: 'Log 2 eggs', tool: 'food_log' }] }, []), { show: true, cancels: null })
  })

  test('hidden once the quick log is saved; back (cancelling nothing) once it is undone', () => {
    const chip = { tool: 'gym_quick_log', ok: true, message: 'Logged Legs today.', undoId: 'u1' }
    assert.equal(setsOffer(done, null, [chip]).show, false)
    assert.deepEqual(setsOffer(done, null, [{ ...chip, undone: true }]), { show: true, cancels: null })
    const other = { id: 'p2', status: 'pending', actions: [{ label: 'Archive task', tool: 'update_task' }] }
    assert.deepEqual(setsOffer(done, other, [{ ...chip, undone: true }]), { show: true, cancels: null })
    for (const status of ['done', 'partial', 'executing']) assert.equal(setsOffer(done, quickCard(status), []).show, false, status)
    for (const status of ['cancelled', 'expired', 'failed']) assert.deepEqual(setsOffer(done, quickCard(status), []), { show: true, cancels: null }, status)
  })

  test('a "Start … workout" button is never held back', () => {
    assert.deepEqual(setsOffer({ action: 'start', name: 'Legs', when: 'now' }, quickCard(), []), { show: true, cancels: null })
  })
})

describe('start screen prompts that fit the moment', () => {
  const base = { tasks: [], friends: [], settings: {}, foodEntries: [], today: TODAY, hour: 10 }

  test('a birthday in the coming week, a missed workout and old tasks lead the Plan prompts', () => {
    const facts = { birthdays: [{ name: 'Sam', label: 'Sat' }], missedWorkout: { name: 'Legs' }, staleCount: 9, weekday: 2 }
    assert.deepEqual(texts(buildSuggestions({ ...base, facts })), ['Plan something for Sam’s birthday (Sat)', 'Fix my gym week', 'What’s on my plate today?', 'Tidy up my 9 old tasks'])
    // A few old tasks aren't worth a prompt.
    assert.ok(!texts(buildSuggestions({ ...base, facts: { staleCount: 3 } })).some((text) => /Tidy/.test(text)))
  })

  test('Sunday evening offers a week review; other evenings don’t', () => {
    assert.equal(buildSuggestions({ ...base, hour: 18, facts: { weekday: 0 } })[0].text, 'Review my week')
    assert.ok(!texts(buildSuggestions({ ...base, hour: 18, facts: { weekday: 3 } })).includes('Review my week'))
    assert.ok(!texts(buildSuggestions({ ...base, hour: 11, facts: { weekday: 0 } })).includes('Review my week'))
  })

  test('Health: protein ideas in the evening when plenty is left, and the missed workout', () => {
    const facts = { proteinGoalG: 140, proteinLeftG: 60, missedWorkout: { name: 'Legs' } }
    const evening = buildSuggestions({ ...base, space: 'health', hour: 18, facts })
    assert.deepEqual(texts(evening), ['Log a meal…', 'Fix my gym week', 'Protein ideas for tonight', 'Log my weight…'])
    assert.ok(!texts(buildSuggestions({ ...base, space: 'health', hour: 10, facts })).includes('Protein ideas for tonight'), 'not in the morning')
    assert.ok(!texts(buildSuggestions({ ...base, space: 'health', hour: 18, facts: { proteinGoalG: 140, proteinLeftG: 10 } })).includes('Protein ideas for tonight'), 'nearly there')
  })

  test('areas that are off hide their prompts; never more than four', () => {
    const facts = { birthdays: [{ name: 'Sam', label: 'today' }], missedWorkout: { name: 'Legs' }, proteinGoalG: 140, proteinLeftG: 80, staleCount: 12, weekday: 0 }
    const off = buildSuggestions({ ...base, hour: 19, settings: { areas: { people: false, gym: false, food: false } }, facts })
    assert.ok(!texts(off).some((text) => /birthday|gym|Protein/i.test(text)))
    assert.equal(buildSuggestions({ ...base, hour: 19, facts }).length, 4)
    // Junk facts are ignored.
    assert.equal(buildSuggestions({ ...base, facts: { birthdays: [null, { name: ' ' }], staleCount: 'x' } }).length, 4)
    assert.deepEqual(buildSuggestions({ ...base, facts: null }), buildSuggestions(base))
  })
})

describe('hand-off links', () => {
  test('askAssistantHash and readAskHash round-trip, capped at 500 characters', () => {
    const text = 'Break “Write report” into steps: 50% done / due Fri #2'
    const hash = askAssistantHash(text)
    assert.match(hash, /^#\/assistant\/ask\//)
    assert.ok(!/\s/.test(hash))
    assert.equal(readAskHash(hash), text)
    const long = 'x'.repeat(800)
    assert.equal(readAskHash(askAssistantHash(long)).length, ASK_MAX_CHARS)
    assert.equal(readAskHash(`#/assistant/ask/${'y'.repeat(900)}`).length, ASK_MAX_CHARS, 'a hand-made link is capped too')
  })

  test('other hashes and odd links', () => {
    assert.equal(readAskHash('#/assistant'), null)
    assert.equal(readAskHash('#/assistant/memory'), null)
    assert.equal(readAskHash('#/tasks/ask/x'), null)
    assert.equal(readAskHash('#/assistant/ask/'), '')
    assert.equal(readAskHash('#/assistant/ask/100%25 sure'), '100% sure')
    assert.equal(readAskHash('#/assistant/ask/50% off'), '50% off', 'a stray % is kept as typed')
    assert.equal(askAssistantHash(null), '#/assistant/ask/')
  })
})

describe('keys and the history merge', () => {
  const at = (minute) => `2026-10-06T12:${String(minute).padStart(2, '0')}:00.000Z`

  test('a message is keyed by role and time; repeats get a suffix', () => {
    assert.equal(messageKey({ role: 'user', createdAt: at(1) }), `user:${at(1)}`)
    assert.equal(messageKey({ role: 'user' }, 'm0'), 'm0')
    const keyed = withKeys([{ role: 'user', createdAt: at(1) }, { role: 'user', createdAt: at(1) }, { role: 'assistant' }, null])
    assert.deepEqual(keyed.map((message) => message.id), [`user:${at(1)}`, `user:${at(1)}#2`, 'm2'])
  })

  test('unchanged messages keep their object; changed ones are replaced under the same key', () => {
    const local = withKeys([
      { role: 'user', content: 'Hi', createdAt: at(1) },
      { role: 'assistant', content: 'Hello', createdAt: at(1), proposal: { id: 'p1', status: 'pending', actions: [] } },
    ])
    const server = [
      { role: 'user', content: 'Hi', createdAt: at(1) },
      { role: 'assistant', content: 'Hello', createdAt: at(1), proposal: { id: 'p1', status: 'done', actions: [] } },
      { role: 'user', content: 'From my laptop', createdAt: at(5) },
    ]
    const merged = mergeHistory(local, server)
    assert.equal(merged[0], local[0], 'same object')
    assert.notEqual(merged[1], local[1])
    assert.equal(merged[1].id, local[1].id)
    assert.equal(merged[1].proposal.status, 'done')
    assert.equal(merged[2].id, `user:${at(5)}`)
  })

  test('a message sent from here matches the server’s copy despite its own time stamp, keeping photo previews', () => {
    const sent = { id: `user:${at(2)}`, role: 'user', content: 'Add these', createdAt: at(2), attachments: [{ kind: 'image', name: 'a.jpg', thumb: 'blob:x' }] }
    const reply = { id: `assistant:${at(2)}`, role: 'assistant', content: 'Done.', createdAt: at(2) }
    const error = { id: 'error:1', role: 'assistant', error: 'Offline', createdAt: at(3) }
    const merged = mergeHistory([sent, reply, error], [
      { role: 'user', content: 'Add these', createdAt: '2026-10-06T12:02:01.500Z', attachments: [{ kind: 'image', name: 'a.jpg' }] },
      { role: 'assistant', content: 'Done.', createdAt: '2026-10-06T12:02:09.000Z' },
    ])
    assert.deepEqual(merged.map((message) => message.id), [sent.id, reply.id], 'same keys: no remount; the error line goes')
    assert.equal(merged[0].attachments[0].thumb, 'blob:x')
    assert.equal(merged[0].createdAt, '2026-10-06T12:02:01.500Z', 'the server’s time from now on')
    // Different words: not the same message.
    assert.equal(mergeHistory([sent], [{ role: 'user', content: 'Other', createdAt: '2026-10-06T12:02:01.500Z' }])[0].id, 'user:2026-10-06T12:02:01.500Z')
    assert.deepEqual(mergeHistory(undefined, undefined), [])
  })

  test('the cached shape leaves out previews and in-flight states', () => {
    const cached = cacheMessage({ role: 'assistant', content: 'x', createdAt: at(1), streaming: true, proposal: { id: 'p', status: 'executing', actions: [{ label: 'A' }] }, attachments: [{ kind: 'image', name: 'a', thumb: 'blob:y' }] })
    assert.equal(cached.proposal.status, 'interrupted')
    assert.deepEqual(cached.attachments, [{ kind: 'image', name: 'a' }])
    assert.equal(cached.streaming, undefined)
  })
})

describe('voice chats in the chat', () => {
  const at = (minute) => `2026-10-11T21:${String(minute).padStart(2, '0')}:00.000Z`
  const talk = (extra = {}) => ({
    id: 'talk_abc12345', startedAt: at(12), endedAt: at(23), seconds: 660, segments: 1, mode: 'open', intent: 'chat', usd: 0.38, end: 'user',
    turns: [{ r: 'u', t: 'Add call mom tomorrow at 5' }, { r: 'a', t: 'Done, call mom tomorrow at 5 PM.' }, { r: 't', t: 'thanks' }, { r: 'a', t: 'Anytime.  Talk soon!' }],
    trimmed: 0,
    ...extra,
  })

  test('the cached shape keeps a voice chat (newest 30 turns, 300 characters each, 25 chips) and the call a hand-off belongs to', () => {
    const turns = Array.from({ length: 40 }, (_, index) => ({ id: `i${index}`, r: index % 2 ? 'a' : 'u', t: 'x'.repeat(500), at: at(12) }))
    const actions = Array.from({ length: 30 }, (_, index) => ({ tool: 'create_task', ok: true, message: `Added ${index}`, undoId: `u${index}`, extra: 'dropped' }))
    const cached = cacheMessage({ role: 'assistant', content: '', createdAt: at(12), talk: talk({ turns, trimmed: 2 }), actions, talkState: { turnId: 'x' } })
    assert.equal(cached.talk.turns.length, 30)
    assert.equal(cached.talk.turns[0].id, 'i10', 'the newest turns are kept')
    assert.ok(cached.talk.turns.every((turn) => turn.t.length === 300))
    assert.equal(cached.talk.trimmed, 12, 'earlier drops plus the ones the cache dropped')
    assert.equal(cached.talk.usd, 0.38)
    assert.equal(cached.actions.length, 25)
    assert.deepEqual(cached.actions[0], { tool: 'create_task', ok: true, message: 'Added 0', undoId: 'u0' })
    assert.equal(cached.talkState, undefined, 'server-only state never reaches the cache')
    // A plain reply keeps at most 10 chips, and a relayed message keeps which call it came from.
    assert.equal(cacheMessage({ role: 'assistant', content: 'x', actions }).actions.length, 10)
    assert.deepEqual(cacheMessage({ role: 'user', content: 'move my gym day', via: { talk: 'talk_abc12345', extra: 1 } }).via, { talk: 'talk_abc12345' })
    assert.equal(cacheMessage({ role: 'user', content: 'x', via: { talk: 5 } }).via, undefined)
    assert.equal(cacheMessage({ role: 'assistant', content: 'x', talk: { turns: [] } }).talk, undefined, 'a talk needs its id')
  })

  test('what a voice chat handed to the full assistant folds into its card while the card is listed', () => {
    const card = { id: 'a1', role: 'assistant', content: '', createdAt: at(12), talk: talk() }
    const asked = { id: 'u2', role: 'user', content: 'Change my gym schedule', createdAt: at(15), via: { talk: 'talk_abc12345' } }
    const answered = { id: 'a2', role: 'assistant', content: 'Here is the new plan.', createdAt: at(15), via: { talk: 'talk_abc12345' }, proposal: { id: 'p2', status: 'pending', actions: [{ label: 'Set Push / Pull / Legs' }], createdAt: at(15) } }
    const other = { id: 'u3', role: 'user', content: 'hi', createdAt: at(30) }
    const orphan = { id: 'u4', role: 'user', content: 'from an older call', createdAt: at(31), via: { talk: 'talk_zzzzzzzz' } }
    const list = [card, asked, answered, other, orphan]
    assert.deepEqual(visibleChatMessages(list).map((message) => message.id), ['a1', 'u3', 'u4'])
    const plain = [other]
    assert.equal(visibleChatMessages(plain), plain, 'nothing hidden: the same array')
    assert.deepEqual(visibleChatMessages(undefined), [])
    // The card shows its own waiting card and those of the requests it handed on, oldest first.
    const withOwn = { ...card, proposal: { id: 'p1', status: 'cancelled', actions: [], createdAt: at(13) } }
    assert.deepEqual(talkProposals([answered, withOwn, asked, other], 'talk_abc12345').map((item) => item.proposal.id), ['p1', 'p2'])
    assert.deepEqual(talkProposals(list, ''), [])
    assert.ok(isTalk(card) && !isTalk(asked) && !isTalk({ talk: { id: '' } }))
  })

  test('gist, length, title, changes and when a call can be continued', () => {
    assert.equal(talkGist(talk()), 'Anytime. Talk soon!', 'the last thing Daybook said, spaces tidied')
    assert.equal(talkGist(talk({ turns: [{ r: 'u', t: 'hello' }] })), '')
    assert.equal(talkGist(talk({ turns: [{ r: 'a', t: 'y'.repeat(400) }] })).length, 240)
    assert.equal(talkGist(null), '')
    assert.equal(talkLength(20), '1 min')
    assert.equal(talkLength(660), '11 min')
    assert.equal(talkLength(3900), '1 h 5 min')
    const now = Date.parse(at(40))
    const flat = (text) => text.replace(/\s/g, ' ') // Intl puts a narrow space before AM / PM
    assert.equal(flat(talkTitle(talk(), 'en-US', { now, timeZone: 'UTC' })), 'Voice chat · 9:12–9:23 PM · 11 min')
    assert.equal(flat(talkTitle(talk({ startedAt: '2026-10-11T11:50:00Z', endedAt: '2026-10-11T12:10:00Z', seconds: 1200 }), 'en-US', { now: Date.parse('2026-10-12T09:00:00Z'), timeZone: 'UTC' })), 'Voice chat · Oct 11, 11:50 AM–12:10 PM · 20 min')
    assert.equal(flat(talkTitle(talk({ endedAt: null, seconds: 0 }), 'en-US', { now, timeZone: 'UTC' })), 'Voice chat · 9:12 PM', 'still going: the start only')
    assert.equal(talkTitle({}, 'en-US'), 'Voice chat')
    assert.equal(talkChanges([{ ok: true }, { ok: true, undone: true }, { ok: false }, null]), 1)
    const ended = Date.parse(at(23))
    assert.equal(talkContinuable(talk({ end: 'cap' }), ended + 60000), true)
    assert.equal(talkContinuable(talk({ end: 'quiet' }), ended + TALK_CONTINUE_MS + 1), false, 'too long ago')
    assert.equal(talkContinuable(talk({ end: 'user' }), ended + 60000), false, 'hung up on purpose')
    assert.equal(talkContinuable(talk({ end: 'daily' }), ended + 60000), false, 'out of minutes for today')
    assert.equal(talkContinuable(talk({ end: 'background', endedAt: null }), ended), false)
  })

  test('the history merge matches a voice chat by its id and never to another message', () => {
    // The call screen put the voice chat in with its own time stamp; the server saved it with the call's start.
    const local = [{ id: 'talk:talk_abc12345', role: 'assistant', content: '', createdAt: at(24), talk: talk({ endedAt: null }) }]
    const server = [{ role: 'assistant', content: '', createdAt: at(12), talk: talk() }]
    const merged = mergeHistory(local, server)
    assert.equal(merged[0].id, 'talk:talk_abc12345', 'same key: no remount')
    assert.equal(merged[0].talk.endedAt, at(23))
    // An empty assistant message from the same minutes is not a voice chat's twin.
    const reply = { id: `assistant:${at(12)}`, role: 'assistant', content: '', createdAt: at(12) }
    const mixed = mergeHistory([reply], server)
    assert.equal(mixed[0].talk.id, 'talk_abc12345')
    assert.notEqual(mixed[0], reply)
    // Two different calls stay apart.
    const otherCall = [{ id: 'talk:talk_other999', role: 'assistant', content: '', createdAt: at(12), talk: talk({ id: 'talk_other999' }) }]
    assert.notEqual(mergeHistory(otherCall, server)[0].id, 'talk:talk_other999')
  })
})

describe('AI usage on this device', () => {
  const now = new Date('2026-10-11T20:00:00')
  const summary = { voiceSecondsToday: 1790, month: { total: 3 } }

  test('voice is paused by the daily minutes or the budget only from a copy fetched today', () => {
    assert.equal(voiceBlocked({}, { summary, at: now.getTime() }, now), 'daily', 'under a minute of the 30 left')
    assert.equal(voiceBlocked({ aiBudgetUsd: 2 }, { summary, at: now.getTime() }, now), 'budget')
    assert.equal(voiceBlocked({ voice: { dailyMinutes: 60 } }, { summary, at: now.getTime() }, now), null)
    assert.equal(voiceBlocked({ voice: { enabled: false } }, null, now), 'off')
    assert.equal(voiceBlocked({}, { summary, at: now.getTime() - 86400000 }, now), null, 'yesterday’s copy: the server decides')
    assert.equal(voiceBlocked({}, { summary: null, at: 0 }, now), null)
  })

  test('feature figures read the month totals and the 30-day amounts alike', () => {
    assert.deepEqual(featureFigures({ voice: { usd: 0.4, n: 2, seconds: 600, handoffUsd: 0.05 } }, 'voice'), { usd: 0.4, n: 2, seconds: 600, handoffUsd: 0.05 })
    assert.deepEqual(featureFigures({ voice: 0.2 }, 'voice'), { usd: 0.2, n: 0, seconds: 0, handoffUsd: 0 })
    assert.deepEqual(featureFigures({ chat: { u: 1500, n: 3 } }, 'chat'), { usd: 0.0015, n: 3, seconds: 0, handoffUsd: 0 })
    assert.deepEqual(featureFigures(null, 'chat'), { usd: 0, n: 0, seconds: 0, handoffUsd: 0 })
  })
})

describe('typing pace', () => {
  test('a backlog is shown within about 250 ms, at least a character a frame', () => {
    assert.equal(revealCount(0, 16), 0)
    assert.equal(revealCount(3, 16), 1)
    assert.equal(revealCount(100, 16), 7)
    assert.equal(revealCount(100, 250), 100)
    assert.equal(revealCount(100, 1000), 100)
    assert.equal(revealCount(5, 0), 1)
    // Frame by frame, 400 characters are all out within about 250 ms of 60 fps frames.
    let left = 400
    let frames = 0
    while (left > 0 && frames < 100) {
      left -= revealCount(left, 16.7)
      frames += 1
    }
    assert.ok(frames <= 60, `${frames} frames`)
  })
})

describe('the chat session outlives the page', () => {
  test('a reply belongs to the session: busy until it ends; a second one waits', () => {
    clearAssistantSession()
    const controller = beginReply({ confirmingId: 'p1' })
    assert.ok(controller)
    assert.equal(getSession().busy, true)
    assert.equal(getSession().confirmingId, 'p1')
    assert.equal(beginReply(), null)
    endReply({}) // not the one on its way
    assert.equal(getSession().busy, true)
    endReply(controller)
    assert.equal(getSession().busy, false)
    assert.equal(getSession().confirmingId, null)
    assert.equal(typeof useAssistantStreaming, 'function')
  })

  test('Stop aborts the reply; signing out also stops everything still writing to the old chat', () => {
    clearAssistantSession()
    const controller = beginReply()
    const writer = sessionWriter()
    writer.setMessages([{ id: 'a', role: 'assistant', content: '' }])
    typeInto('a', 'Hello') // no animation frames here: shown at once
    assert.equal(getSession().messages[0].content, 'Hello')
    stopReply()
    assert.equal(controller.signal.aborted, true)
    endReply(controller)

    const next = beginReply()
    const old = sessionWriter()
    clearAssistantSession()
    assert.equal(next.signal.aborted, true)
    assert.equal(getSession().busy, false)
    old.setMessages([{ id: 'late', role: 'assistant', content: 'from before' }])
    old.patchMessage('late', { content: 'x' })
    typeInto('late', 'more')
    assert.ok(!getSession().messages.some((message) => message.id === 'late'), 'a write after the reset is dropped')
    assert.equal(old.live(), false)
    endReply(next)
    assert.equal(getSession().busy, false)
  })
})

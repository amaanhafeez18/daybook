// The Assistant page's pure helpers (src/lib/assistantChat.js): start-screen prompts by space, which
// chips and cards a reply shows, Undo availability and expired cards.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROPOSAL_TTL_MS, UNDO_TTL_MS, assistantSpace, buildSuggestions, canUndo, cardExpired, collapsesCard, composerPlaceholder, proposalExpired, setsOffer, undoRefused, visibleActions,
} from '../src/lib/assistantChat.js'
import { toISO } from '../src/lib/dates.js'

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

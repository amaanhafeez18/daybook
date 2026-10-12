// The assistant's clash check: a card that adds or moves something to a time that overlaps a class, an
// event or another timed task says so ("Clashes with ECON 101 (2:30–3:45 PM)"), the tool result tells
// the model the next free start, and the card offers "Move to …" under it. It only warns: nothing is
// blocked or moved without a tap.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const { runWrite, executeTool, describeAction, clashCheck, clashMoves } = await import('../api/assistant.js')

console.warn = () => {}
console.error = () => {}

const TODAY = '2026-10-07' // a Wednesday
const THURSDAY = '2026-10-08'
const USER = 'user-a'
const ctx = (extra = {}) => ({ localDate: TODAY, localTime: '09:00', weekday: 'Wed', timeZone: 'UTC', location: null, ...extra })

// Writes succeed and change nothing; reads return no rows.
function fakeSupabase() {
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (resolve) => resolve({ data: [], error: null })
      if (typeof prop === 'symbol') return undefined
      return () => builder
    },
  })
  return { from: () => builder, rpc: async () => ({ data: null, error: null }) }
}

// Wednesday: ECON 101 2:30–3:45 PM (database shape: days + day_details), CHEM 110 11:30 AM–12:45 PM
// ([{ day, time }] shape), Advising 1:30 PM (an event with its task), an untimed essay, and a calendar
// event without a task ("Coffee with Sam" 5:00 PM). An old course that ended is still in the list.
function data(extra = {}) {
  return {
    tasks: [
      { id: 't-adv', text: 'Advising', date: TODAY, time: '13:30', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: 'e-adv' },
      { id: 't-essay', text: 'Essay draft', date: TODAY, time: '', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: 'e-essay' },
      { id: 't-done', text: 'Old call', date: TODAY, time: '18:00', details: '', priority: 'medium', done: true, archived: false, calendar_event_id: 'e-done' },
    ],
    events: [
      { id: 'e-adv', task_id: 't-adv', title: 'Advising', date: TODAY, time: '13:30' },
      { id: 'e-essay', task_id: 't-essay', title: 'Essay draft', date: TODAY, time: '' },
      { id: 'e-done', task_id: 't-done', title: 'Old call', date: TODAY, time: '18:00' },
      { id: 'e-sam', task_id: null, title: 'Coffee with Sam', date: TODAY, time: '17:00' },
    ],
    classes: [
      { id: 'c-econ', name: 'ECON 101', days: ['Mon', 'Wed'], day_details: { Mon: { time: '2:30 PM - 3:45 PM' }, Wed: { time: '2:30 PM - 3:45 PM' } } },
      { id: 'c-chem', name: 'CHEM 110', days: [{ day: 'Wed', time: '11:30 AM - 12:45 PM' }] },
      { id: 'c-old', name: 'Old course', days: ['Wed'], day_details: { Wed: { time: '7:00 PM - 9:00 PM' } }, end_date: '2026-09-01' },
    ],
    friends: [], contact_logs: [], voice_notes: [], journal_entries: [], memories: [], attachments: [],
    body_weights: [], gym_sessions: [], settings: { notifications: {} },
    ...extra,
  }
}

const detailOf = (name, args, d = data(), c = ctx()) => describeAction(name, args, d, c, {})?.detail || ''

describe('clash on the card', () => {
  test('a new task inside a class names it with its times', () => {
    assert.match(detailOf('create_task', { text: 'Dentist', date: TODAY, time: '15:00' }), /Clashes with ECON 101 \(2:30–3:45 PM\)\./)
    // Across noon both halves keep AM/PM.
    assert.match(detailOf('create_task', { text: 'Call bank', date: TODAY, time: '12:00' }), /Clashes with CHEM 110 \(11:30 AM–12:45 PM\)\./)
    // A new event too.
    assert.equal(describeAction('create_event', { title: 'Study group', date: TODAY, time: '15:00' }, data(), ctx(), {}).detail, 'Clashes with ECON 101 (2:30–3:45 PM).')
  })

  test('false positives stay quiet', () => {
    // Back to back (a class ends at 3:45) isn't a clash; before it starts isn't either.
    assert.doesNotMatch(detailOf('create_task', { text: 'Dentist', date: TODAY, time: '15:45' }), /Clashes/)
    assert.doesNotMatch(detailOf('create_task', { text: 'Dentist', date: TODAY, time: '14:00' }), /Clashes/)
    // No time, no clash; another weekday (Thursday has no classes).
    assert.doesNotMatch(detailOf('create_task', { text: 'Dentist', date: TODAY }), /Clashes/)
    assert.doesNotMatch(detailOf('create_task', { text: 'Dentist', date: THURSDAY, time: '15:00' }), /Clashes/)
    // A "remind me at 2:45" ping doesn't block time out.
    assert.doesNotMatch(detailOf('create_task', { text: 'Bring laptop', date: TODAY, time: '14:45', reminderMinutes: 0 }), /Clashes/)
    // A course whose term ended, a done task (and its event), a past date.
    assert.doesNotMatch(detailOf('create_task', { text: 'Gym', date: TODAY, time: '19:30' }), /Clashes/)
    assert.doesNotMatch(detailOf('create_task', { text: 'Gym', date: TODAY, time: '18:00' }), /Clashes/)
    assert.doesNotMatch(detailOf('create_task', { text: 'Dentist', date: '2026-10-05', time: '15:00' }, data(), ctx()), /Clashes/)
    // An untimed task on that day doesn't count; a task's own event isn't counted twice.
    const detail = detailOf('create_task', { text: 'Meeting', date: TODAY, time: '13:45' })
    assert.equal(detail.match(/Advising/g)?.length, 1)
  })

  test('moving something never clashes with itself', () => {
    // Advising 1:30 → 1:45 overlaps only its old slot: no clash.
    assert.doesNotMatch(detailOf('update_task', { taskId: 't-adv', time: '13:45' }), /Clashes/)
    assert.doesNotMatch(detailOf('update_event', { eventId: 'e-adv', time: '13:45' }), /Clashes/)
    // The essay moved to 1:30 lands on Advising (named once, as the task).
    assert.match(detailOf('update_task', { taskId: 't-essay', time: '13:30' }), /Clashes with Advising \(1:30–2:00 PM\)\./)
    // The event moved into the class.
    assert.match(detailOf('update_event', { eventId: 'e-adv', time: '15:00' }), /^Clashes with ECON 101 \(2:30–3:45 PM\)\.$/)
    // An event without a task counts.
    assert.match(detailOf('update_task', { taskId: 't-adv', time: '17:10' }), /Clashes with Coffee with Sam \(5:00–5:30 PM\)\./)
  })

  test('only a move is checked: a rename, a done or an untimed change is not', () => {
    const clashing = data()
    clashing.tasks.push({ id: 't-x', text: 'Overlap', date: TODAY, time: '15:00', details: '', priority: 'medium', done: false, archived: false })
    assert.doesNotMatch(detailOf('update_task', { taskId: 't-x', text: 'Overlapping thing' }, clashing), /Clashes/)
    assert.doesNotMatch(detailOf('update_task', { taskId: 't-x', done: true }, clashing), /Clashes/)
    assert.doesNotMatch(detailOf('update_task', { taskId: 't-x', date: TODAY, time: '' }, clashing), /Clashes/)
  })

  test('several clashes are listed briefly', () => {
    const busy = data()
    busy.tasks.push(
      { id: 'a', text: 'Call Sam', date: TODAY, time: '15:00', details: '', done: false, archived: false },
      { id: 'b', text: 'Pay rent', date: TODAY, time: '15:10', details: '', done: false, archived: false },
    )
    assert.match(detailOf('create_task', { text: 'Dentist', date: TODAY, time: '15:00' }, busy), /Clashes with ECON 101 \(2:30–3:45 PM\) and Call Sam \(3:00–3:30 PM\) and 1 more\.$/)
  })
})

describe('something held in its own class', () => {
  test('a quiz or midterm that names the class is not a clash with it, on the card or in the result', async () => {
    assert.doesNotMatch(detailOf('create_task', { text: 'ECON 101 midterm', date: TODAY, time: '14:30' }), /Clashes/)
    assert.doesNotMatch(detailOf('create_event', { title: 'Econ101 quiz 2', date: TODAY, time: '14:30' }), /Clashes/)
    assert.equal(clashCheck(data(), { date: TODAY, time: '14:30', title: 'ECON 101 quiz 2' }, ctx()), null)
    const result = await executeTool(fakeSupabase(), USER, 'create_task', { text: 'ECON 101 midterm', date: TODAY, time: '14:30' }, data(), ctx())
    assert.equal('clash' in result, false)
    // Moving it into its class: no clash; renaming and moving to it in one go reads the new name.
    const withQuiz = data()
    withQuiz.tasks.push({ id: 't-q', text: 'ECON 101 quiz', date: THURSDAY, time: '10:00', details: '', priority: 'medium', done: false, archived: false })
    assert.doesNotMatch(detailOf('update_task', { taskId: 't-q', date: TODAY, time: '14:30' }, withQuiz), /Clashes/)
    assert.match(detailOf('update_task', { taskId: 't-q', text: 'Dentist', date: TODAY, time: '14:30' }, withQuiz), /Clashes with ECON 101/)
  })

  test('anything else at class time still clashes, and the class is still busy for the move', () => {
    const clash = clashCheck(data(), { date: TODAY, time: '14:30', title: 'Dentist' }, ctx())
    assert.equal(clash.text, 'Clashes with ECON 101 (2:30–3:45 PM).')
    assert.equal(clash.nextFree, '3:45 PM')
    // Another class's quiz doesn't excuse a clash with this one.
    assert.match(clashCheck(data(), { date: TODAY, time: '14:30', title: 'CHEM 110 quiz' }, ctx()).text, /ECON 101/)
  })
})

describe('clash in the tool result', () => {
  test('the model gets the clash and the next free start', async () => {
    const result = await executeTool(fakeSupabase(), USER, 'create_task', { text: 'Dentist', date: TODAY, time: '15:00' }, data(), ctx())
    assert.equal(result.ok, true)
    assert.equal(result.clash.text, 'Clashes with ECON 101 (2:30–3:45 PM).')
    assert.equal(result.clash.nextFree, '3:45 PM')
    assert.deepEqual(result.clash.move, { plain: 'Move to 3:45 PM', titled: 'Move “Dentist” to 3:45 PM' })
    assert.match(result.clash.note, /offer_alternatives\(\["Move to 3:45 PM"\]\)/)
    assert.match(result.clash.note, /ask_choice \("Keep 3:00 PM" \/ "Move to 3:45 PM"\)/)
    // No clash, no field.
    const free = await executeTool(fakeSupabase(), USER, 'create_task', { text: 'Dentist', date: TODAY, time: '16:00' }, data(), ctx())
    assert.equal('clash' in free, false)
  })

  test('the next free start skips everything in the way', async () => {
    // 3:00 PM → ECON until 3:45; the 3:45 slot is free (Sam is at 5).
    const busy = data()
    busy.tasks.push({ id: 'n', text: 'Notes review', date: TODAY, time: '15:45', details: '', done: false, archived: false })
    const result = await executeTool(fakeSupabase(), USER, 'create_event', { title: 'Study group', date: TODAY, time: '15:00' }, busy, ctx())
    assert.equal(result.clash.nextFree, '4:15 PM')
  })

  test('nothing free later that day', async () => {
    const late = data()
    late.classes.push({ id: 'c-night', name: 'Night lab', days: ['Wed'], day_details: { Wed: { time: '9:00 PM - 11:59 PM' } } })
    const result = await executeTool(fakeSupabase(), USER, 'create_task', { text: 'Laundry', date: TODAY, time: '21:30' }, late, ctx())
    assert.equal(result.clash.nextFree, null)
    assert.equal(result.clash.move, undefined)
    assert.match(result.clash.note, /Nothing is free later that day/)
  })

  test('moves report it too, and never the item itself', async () => {
    const moved = await executeTool(fakeSupabase(), USER, 'update_task', { taskId: 't-essay', time: '15:00' }, data(), ctx())
    assert.equal(moved.clash.text, 'Clashes with ECON 101 (2:30–3:45 PM).')
    const self = await executeTool(fakeSupabase(), USER, 'update_event', { eventId: 'e-adv', time: '13:45' }, data(), ctx())
    assert.equal('clash' in self, false)
    const event = await executeTool(fakeSupabase(), USER, 'update_event', { eventId: 'e-adv', time: '15:30' }, data(), ctx())
    assert.equal(event.clash.text, 'Clashes with ECON 101 (2:30–3:45 PM).')
  })
})

describe('clash and the confirm levels', () => {
  const turn = (level, d = data()) => ({ data: d, ctx: ctx(), level, stage: { sim: null, simIds: {}, list: [], direct: 0 }, directRefs: {} })
  const write = (state, name, args) => runWrite({ supabase: fakeSupabase(), userId: USER, name, args, ...state })

  test('"ask before edits": a clashing create waits on the card with the move offered', async () => {
    const state = turn('changes')
    const { result, staged } = await write(state, 'create_task', { text: 'Dentist', date: TODAY, time: '15:00' })
    assert.equal(staged, true)
    assert.equal(result.ok, true)
    assert.match(result.detail, /Clashes with ECON 101/)
    assert.equal(result.clash.nextFree, '3:45 PM')
    assert.deepEqual(state.stage.list[0].move, { plain: 'Move to 3:45 PM', titled: 'Move “Dentist” to 3:45 PM' })
    // Nothing was written to the real data.
    assert.equal(state.data.tasks.some((task) => task.text === 'Dentist'), false)
  })

  test('"ask before edits": a create without a clash still runs at once', async () => {
    const state = turn('changes')
    const { result, staged } = await write(state, 'create_task', { text: 'Dentist', date: TODAY, time: '16:00' })
    assert.equal(staged, false)
    assert.equal(result.ok, true)
    assert.equal(result.clash, undefined)
  })

  test('the "Move to …" chips under the card', () => {
    const one = { plain: 'Move to 3:45 PM', titled: 'Move “Dentist” to 3:45 PM' }
    const two = { plain: 'Move to 4:15 PM', titled: 'Move “Study group” to 4:15 PM' }
    assert.deepEqual(clashMoves([]), [])
    assert.deepEqual(clashMoves([{ label: 'x' }, { move: one }]), ['Move to 3:45 PM'])
    // Several items moving: each is named, so a tap can't mean the wrong one.
    assert.deepEqual(clashMoves([{ move: one }, { label: 'y' }, { move: two }]), ['Move “Dentist” to 3:45 PM', 'Move “Study group” to 4:15 PM'])
    assert.deepEqual(clashMoves(null), [])
    // The check never throws on junk.
    assert.equal(clashCheck(null, { date: TODAY, time: '15:00' }, ctx()), null)
    assert.equal(clashCheck({ classes: 'x', events: {}, tasks: 5 }, { date: TODAY, time: '15:00' }, ctx()), null)
    assert.equal(clashCheck(data(), { date: 'soon', time: '3pm' }, ctx()), null)
  })

  test('confirmations off: it is saved as asked and the model is told', async () => {
    const state = turn('off')
    const { result, staged } = await write(state, 'create_task', { text: 'Dentist', date: TODAY, time: '15:00' })
    assert.equal(staged, false)
    assert.equal(result.ok, true)
    assert.equal(state.data.tasks.find((task) => task.text === 'Dentist').time, '15:00') // not moved
    assert.match(result.clash.note, /don't move it unasked/)
  })
})

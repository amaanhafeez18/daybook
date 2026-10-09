// Day words and dates in the assistant: the resolver and its developer note (api/_temporal.js), card
// labels that say where an item is and exactly what changes, the check that an edit lands on the day
// the user named, the fix for "tomorrow, Oct 7" in a reply, "No …" as a correction, the items from
// the last few replies, the hint about a similar task, and Yes binding to the latest card only.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDayWords, dayHintNote, fixRelativeDates, dayLabel } from '../api/_temporal.js'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const {
  runWrite, executeTool, buildInstructions, staticInstructions, parseDecision, findPendingProposal, isCorrection, correctionTurn, recentItemsNote,
  readChoice, describeAction, normalizeMessage, publicMessage, touchedBy,
} = await import('../api/assistant.js')

console.warn = () => {}
console.error = () => {}

const TODAY = '2026-10-07' // a Wednesday
const USER = 'user-a'
const makeCtx = (extra = {}) => ({ localDate: TODAY, localTime: '09:00', weekday: 'Wed', timeZone: 'UTC', location: null, ...extra })
const days = (text, today = TODAY) => resolveDayWords(text, { today }).map((entry) => entry.iso)

// Writes succeed and change nothing; reads return no rows (enough for staging and simple updates).
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

function emptyData(extra = {}) {
  return {
    tasks: [], events: [], friends: [], contact_logs: [], voice_notes: [], classes: [], journal_entries: [], memories: [], attachments: [],
    body_weights: [], gym_sessions: [], settings: { notifications: {} }, ...extra,
  }
}

// "Advising" today (Wed) at 1:30 PM, as an event with its task, plus an unrelated task.
function advisingData() {
  return emptyData({
    tasks: [
      { id: 't-adv', text: 'Advising', date: TODAY, time: '13:30', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: 'e-adv' },
      { id: 't-essay', text: 'Essay draft', date: TODAY, time: '', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: 'e-essay' },
    ],
    events: [
      { id: 'e-adv', task_id: 't-adv', title: 'Advising', date: TODAY, time: '13:30' },
      { id: 'e-essay', task_id: 't-essay', title: 'Essay draft', date: TODAY, time: '' },
    ],
  })
}

const turn = (level, data, ctx) => ({ data, ctx, level, stage: { sim: null, simIds: {}, list: [], direct: 0 }, directRefs: {} })
const write = (state, name, args) => runWrite({ supabase: fakeSupabase(), userId: USER, name, args, ...state })

// ---- the resolver ---------------------------------------------------------------------------------

describe('day words', () => {
  test('tomorrow and its typos and abbreviations', () => {
    for (const word of ['tomorrow', 'tomorow', 'tommorow', 'tommorrow', 'tommorw', 'tomorrw', 'tmrw', 'tmr', 'tmrow', '2moro', 'tomoro', 'Tomorrow']) {
      assert.deepEqual(days(`dentist ${word} at 3`), ['2026-10-08'], word)
    }
    assert.equal(resolveDayWords('tommorw', { today: TODAY })[0].typo, true)
    assert.equal(resolveDayWords('tomorrow', { today: TODAY })[0].typo, false)
  })

  test('today, tonight, this morning, yesterday, day after tomorrow, in N days', () => {
    assert.deepEqual(days('today'), [TODAY])
    assert.deepEqual(days('tonight'), [TODAY])
    assert.deepEqual(days('this afternoon'), [TODAY])
    assert.deepEqual(days('yesterday'), ['2026-10-06'])
    assert.deepEqual(days('the day after tomorrow'), ['2026-10-09'])
    assert.deepEqual(days('day after tmrw'), ['2026-10-09'])
    assert.deepEqual(days('in 3 days'), ['2026-10-10'])
  })

  test('weekday names, abbreviations and typos', () => {
    const thu = '2026-10-08'
    for (const word of ['Thursday', 'thursday', 'thu', 'thur', 'thurs', 'thrusday', 'Thu']) assert.deepEqual(days(`on ${word}`), [thu], word)
    for (const word of ['tue', 'tues', 'Tuesday']) assert.deepEqual(days(`on ${word}`), ['2026-10-13'], word)
    for (const word of ['fri', 'Friday']) assert.deepEqual(days(word), ['2026-10-09'], word)
    for (const word of ['mon', 'Monday']) assert.deepEqual(days(`on ${word}`), ['2026-10-12'], word)
    for (const word of ['sat', 'Sat']) assert.deepEqual(days(`on ${word}`), ['2026-10-10'], word)
    for (const word of ['sun', 'Sunday']) assert.deepEqual(days(`this ${word}`), ['2026-10-11'], word)
    // Today is Wednesday: a plain "Wednesday" is today (next week's is the alternative).
    for (const word of ['wed', 'weds', 'Wednesday', 'wendsday', 'wensday']) {
      const [entry] = resolveDayWords(`on ${word}`, { today: TODAY })
      assert.equal(entry?.iso, TODAY, word)
      assert.equal(entry.alt, '2026-10-14', word)
    }
  })

  test('the short words that are also English need a date or time nearby', () => {
    assert.deepEqual(days('Sat 3pm'), ['2026-10-10'])
    assert.deepEqual(days('dentist Wed morning'), [TODAY])
    assert.deepEqual(days('move it to Sun at 4'), ['2026-10-11'])
    assert.deepEqual(days('mon'), [], 'a bare lowercase short word is not a day')
  })

  test('no false positives', () => {
    for (const text of ['my cousin\'s wedding', 'I sat down with Sam', 'a sunny afternoon', 'the sun was out', 'money for rent', 'fries with that', 'may I add that', 'march on', 'Sat down at the table', 'gym on Mondays', 'at midday', 'a sundae', 'someday', '1/2 cup of oats', 'rated it 7/10']) {
      assert.deepEqual(days(text), [], text)
    }
  })

  test('ordinary words and names that look like days are not days', () => {
    for (const text of ['lunch at Subway', 'a subway ride', 'the monkey bars', 'Call Freddy', 'a frisky dog', 'sundry items', 'a sturdy box', 'in a moody mood', 'Sandy said hi', 'the 8th floor of the library', 'the 3rd floor', 'the 2nd time', 'Call Sun Life', 'Sun Valley trip', 'gym every Thursday', 'each Monday']) {
      assert.deepEqual(days(text), [], text)
    }
    assert.match(dayHintNote('Add lunch at Subway with Sam tomorrow at 1', TODAY), /“tomorrow” = Thu, Oct 8\. Today/)
    assert.doesNotMatch(dayHintNote('Call Freddy tomorrow at 5', TODAY), /different days/)
  })

  test('short forms and transposed typos', () => {
    for (const word of ['tmw', 'tmrrw']) assert.deepEqual(days(`gym ${word}`), ['2026-10-08'], word)
    assert.deepEqual(days('on thrus'), ['2026-10-08'])
    assert.deepEqual(days('mondya'), ['2026-10-12'])
    assert.deepEqual(days('sundy'), ['2026-10-11'])
    assert.deepEqual(days('fridy'), ['2026-10-09'])
  })

  test('next X is next week\'s (the nearer one is the alternative); last X is the one before today', () => {
    const [next] = resolveDayWords('next Thursday', { today: TODAY })
    assert.equal(next.iso, '2026-10-15')
    assert.equal(next.alt, '2026-10-08')
    assert.deepEqual(days('next Monday'), ['2026-10-12'])
    assert.equal(resolveDayWords('next Monday', { today: TODAY })[0].alt, undefined, 'next Monday is already next week')
    assert.deepEqual(days('last Friday'), ['2026-10-02'])
    // Today is Thursday: a plain Thursday is today.
    assert.deepEqual(days('Thursday', '2026-10-08'), ['2026-10-08'])
  })

  test('explicit dates', () => {
    for (const text of ['Oct 8', 'October 8th', '8 Oct', 'the 8th of October', '10/8', 'the 8th']) assert.deepEqual(days(`on ${text}`), ['2026-10-08'], text)
    assert.deepEqual(days('the 3rd'), ['2026-11-03'], 'a day of the month already past is next month')
    assert.deepEqual(days('Jan 5'), ['2027-01-05'], 'the next Jan 5')
    assert.deepEqual(days('Feb 30'), [], 'not a date')
    assert.deepEqual(days('Dec 1 2027'), ['2027-12-01'])
  })

  test('a date without a year is the next one, not one months ago', () => {
    for (const text of ['Apr 10', 'April 10th', '4/10', 'the 10th of April']) assert.deepEqual(days(`move it to ${text}`), ['2027-04-10'], text)
    assert.deepEqual(days('May 5'), ['2027-05-05'])
    assert.deepEqual(days('Oct 1'), ['2026-10-01'], 'a week ago is still this year\'s')
    assert.deepEqual(days('I went to the dentist on Apr 10'), ['2026-04-10'], 'said about the past: the last one')
    assert.match(dayHintNote('Move it to Apr 10', TODAY), /“Apr 10” = Sat, Apr 10, 2027/)
    assert.match(dayHintNote('the invoice from Oct 1', TODAY), /Thu, Oct 1 \(in the past\)/)
  })

  test('month and year roll over', () => {
    assert.deepEqual(days('tomorrow', '2026-10-31'), ['2026-11-01'])
    assert.deepEqual(days('tomorrow', '2026-12-31'), ['2027-01-01'])
    assert.deepEqual(days('Friday', '2026-12-30'), ['2027-01-01'])
    assert.equal(dayLabel('2027-01-01', '2026-12-31'), 'Fri, Jan 1, 2027')
  })
})

describe('the day note', () => {
  test('agreeing words: one day, with the typo echoed', () => {
    const note = dayHintNote('No tommorw Thursday advising 1:30pm Room 12', TODAY)
    assert.match(note, /“tommorw” = tomorrow = Thu, Oct 8; “Thursday” = Thu, Oct 8\. Today is Wed, Oct 7\./)
    assert.doesNotMatch(note, /different days/)
    assert.match(note, /misspelt/)
  })

  test('conflicting words: ask which one', () => {
    const note = dayHintNote('advising tomorrow on Friday', TODAY)
    assert.match(note, /Thu, Oct 8/)
    assert.match(note, /Fri, Oct 9/)
    assert.match(note, /different days: .*ask which one/)
  })

  test('nothing to say → null', () => {
    assert.equal(dayHintNote('add milk to my list', TODAY), null)
  })
})

// ---- card labels ----------------------------------------------------------------------------------

describe('card labels', () => {
  const ctx = makeCtx()
  test('update_event with details only names the day it is on and the details', () => {
    const { label } = describeAction('update_event', { eventId: 'e-adv', details: 'Room 12' }, advisingData(), ctx, {})
    assert.equal(label, 'Change “Advising” (today, Wed, Oct 7, 1:30 PM): details → “Room 12”')
  })

  test('update_event that moves shows from → to', () => {
    const { label } = describeAction('update_event', { eventId: 'e-adv', date: '2026-10-08', details: 'Room 12' }, advisingData(), ctx, {})
    assert.equal(label, 'Move “Advising” from today, Wed, Oct 7, 1:30 PM to tomorrow, Thu, Oct 8, 1:30 PM; details → “Room 12”')
    const sameDay = describeAction('update_event', { eventId: 'e-adv', time: '15:00' }, advisingData(), ctx, {})
    assert.equal(sameDay.label, 'Move “Advising” from 1:30 PM to 3:00 PM, today, Wed, Oct 7')
  })

  test('update_task that moves shows from → to; completing stays short', () => {
    const data = advisingData()
    assert.match(describeAction('update_task', { taskId: 't-adv', date: '2026-10-08' }, data, ctx, {}).label, /^Move “Advising” from today, Wed, Oct 7, 1:30 PM to tomorrow, Thu, Oct 8, 1:30 PM/)
    assert.equal(describeAction('update_task', { taskId: 't-adv', done: true }, data, ctx, {}).label, 'Complete “Advising”')
    assert.equal(describeAction('update_task', { taskId: 't-adv', priority: 'urgent' }, data, ctx, {}).label, 'Update “Advising” (today, Wed, Oct 7, 1:30 PM): priority urgent')
  })

  test('a long details change keeps the label short and puts the text on the detail line', () => {
    const long = 'Bring the transcript, the signed form, two pieces of ID and the printed schedule for next term please'
    const described = describeAction('update_event', { eventId: 'e-adv', title: 'Academic advising with the department office', details: long }, advisingData(), ctx, {})
    assert.ok(described.label.length <= 140, described.label)
    assert.match(described.detail, /transcript/)
  })
})

// ---- the day check --------------------------------------------------------------------------------

describe('an edit that misses the day the user named', () => {
  test('refused once with the hint, then the identical call is staged', async () => {
    const ctx = makeCtx({ userText: 'Academic advising tomorrow at 1:30 at Room 12', roundEdits: 1 })
    const state = turn('all', advisingData(), ctx)
    const first = await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })
    assert.equal(first.result.ok, false)
    assert.equal(first.staged, true, 'hidden from the user like any refused staged call')
    assert.match(first.result.message, /“tomorrow” = Thu, Oct 8/)
    assert.match(first.result.message, /is on Wed, Oct 7, 1:30 PM/)
    assert.match(first.result.message, /date 2026-10-08/)
    assert.equal(state.stage.list.length, 0)
    const again = await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })
    assert.equal(again.result.ok, true)
    assert.equal(again.result.staged, true)
  })

  test('a call that moves it to the named day is staged at once', async () => {
    const ctx = makeCtx({ userText: 'Advising tmrw 1:30', roundEdits: 1 })
    const state = turn('all', advisingData(), ctx)
    const moved = await write(state, 'update_event', { eventId: 'e-adv', date: '2026-10-08', details: 'Room 12' })
    assert.equal(moved.result.ok, true)
    assert.match(moved.result.label, /^Move “Advising” from today, Wed, Oct 7, 1:30 PM to tomorrow, Thu, Oct 8/)
  })

  test('also with confirmations off (nothing runs until the call is right)', async () => {
    const ctx = makeCtx({ userText: 'advising is tomorrow', roundEdits: 1 })
    const state = turn('off', advisingData(), ctx)
    const first = await write(state, 'update_task', { taskId: 't-adv', details: 'Room 12' })
    assert.equal(first.result.ok, false)
    assert.equal(state.data.tasks[0].details, '', 'nothing changed')
  })

  test('stays quiet when it shouldn\'t fire', async () => {
    const data = advisingData()
    // Completing something while mentioning another day.
    let state = turn('all', data, makeCtx({ userText: 'done with the essay, gym tomorrow', roundEdits: 1 }))
    assert.equal((await write(state, 'update_task', { taskId: 't-essay', done: true })).result.ok, true)
    // Two different days named: the note asks the model to clarify instead.
    state = turn('all', data, makeCtx({ userText: 'advising tomorrow or Friday', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: 'x' })).result.ok, true)
    // The day named is the day it's on.
    state = turn('all', data, makeCtx({ userText: 'advising today is in Room 12', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })).result.ok, true)
    // Several edits in the round and the title isn't in the message.
    state = turn('all', data, makeCtx({ userText: 'tomorrow I need a long day, bump these up', roundEdits: 2 }))
    assert.equal((await write(state, 'update_task', { taskId: 't-adv', priority: 'urgent' })).result.ok, true)
    // No message text at all (older callers, tests).
    state = turn('all', data, makeCtx())
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })).result.ok, true)
  })

  test('a move staged earlier in the turn counts (the follow-up edit on the same item goes through)', async () => {
    for (const second of [['update_event', { eventId: 'e-adv', details: 'Room 12' }], ['update_task', { taskId: 't-adv', details: 'Room 12' }]]) {
      const state = turn('all', advisingData(), makeCtx({ userText: 'Academic advising tomorrow at 1:30 at Room 12', roundEdits: 1 }))
      assert.equal((await write(state, 'update_event', { eventId: 'e-adv', date: '2026-10-08' })).result.ok, true)
      const out = await write(state, ...second)
      assert.equal(out.result.ok, true, `${second[0]}: ${out.result.message}`)
      assert.equal(state.stage.list.length, 2)
    }
  })

  test('two items in one message: the unrelated edit isn\'t refused when another call moves to the named day', async () => {
    const ctx = makeCtx({ userText: 'Move advising to tomorrow and bump the essay priority to urgent', roundEdits: 2, roundTargets: new Set(['2026-10-08']) })
    const state = turn('all', advisingData(), ctx)
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', date: '2026-10-08' })).result.ok, true)
    const essay = await write(state, 'update_task', { taskId: 't-essay', priority: 'urgent' })
    assert.equal(essay.result.ok, true, essay.result.message)
  })

  test('the other reading of the day counts too (next week\'s, the nearer "next Thu", the same date next year)', async () => {
    // Thursday Oct 8: "Thursday advising" may be next week's.
    let data = advisingData()
    data.events[0].date = '2026-10-15'
    data.tasks[0].date = '2026-10-15'
    let state = turn('all', data, makeCtx({ localDate: '2026-10-08', userText: 'Thursday advising is in Room 12', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })).result.ok, true)
    // "next Thursday" = Oct 15, but a move to the nearer Oct 8 is fine too.
    state = turn('all', advisingData(), makeCtx({ userText: 'move advising to next Thursday', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', date: '2026-10-08' })).result.ok, true)
    // "May 5" said in October, moved to next year's May 5.
    data = advisingData()
    state = turn('all', data, makeCtx({ userText: 'Move advising to May 5', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', date: '2027-05-05' })).result.ok, true)
    state = turn('all', advisingData(), makeCtx({ userText: 'Move advising to May 5', roundEdits: 1 }))
    const past = await write(state, 'update_event', { eventId: 'e-adv', details: 'x' })
    assert.equal(past.result.ok, false)
    assert.match(past.result.message, /date 2027-05-05/, 'never steered into the past')
  })

  test('words that only look like days don\'t trigger it', async () => {
    const data = advisingData()
    let state = turn('all', data, makeCtx({ userText: 'Change the advising room to the 8th floor of the library', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: '8th floor of the library' })).result.ok, true)
    state = turn('all', data, makeCtx({ userText: 'Add policy number 12345 to the Call Sun Life task', roundEdits: 1 }))
    assert.equal((await write(state, 'update_task', { taskId: 't-essay', details: 'Policy 12345' })).result.ok, true)
  })

  test('after one warning, the next call on that item goes through whatever its key order or extra fields', async () => {
    const state = turn('all', advisingData(), makeCtx({ userText: 'Academic advising tomorrow at 1:30 at Room 12', roundEdits: 1 }))
    assert.equal((await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })).result.ok, false)
    const again = await write(state, 'update_task', { details: 'Room 12', taskId: 't-adv', time: '13:30' })
    assert.equal(again.result.ok, true, 'its linked task counts as the same item')
  })

  test('a details-only card says "today" so it can\'t pass for tomorrow', async () => {
    const state = turn('all', advisingData(), makeCtx({ userText: 'advising tomorrow at Room 12', roundEdits: 1 }))
    await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })
    const insisted = await write(state, 'update_event', { eventId: 'e-adv', details: 'Room 12' })
    assert.equal(insisted.result.label, 'Change “Advising” (today, Wed, Oct 7, 1:30 PM): details → “Room 12”')
  })
})

// ---- the reply check ------------------------------------------------------------------------------

describe('relative words next to a date in a reply', () => {
  test('a wrong relative word is corrected', () => {
    assert.equal(fixRelativeDates('I’ll keep it tomorrow, Oct 7.', TODAY), 'I’ll keep it today, Oct 7.')
    assert.equal(fixRelativeDates('Moved to tomorrow (Oct 7).', TODAY), 'Moved to today (Oct 7).')
    assert.equal(fixRelativeDates('That’s tomorrow, Wednesday, Oct 7.', TODAY), 'That’s today, Wednesday, Oct 7.')
    assert.equal(fixRelativeDates('Set for today (Thu, Oct 8).', TODAY), 'Set for tomorrow (Thu, Oct 8).')
    assert.equal(fixRelativeDates('Set for Thu, Oct 8 (today).', TODAY), 'Set for Thu, Oct 8 (tomorrow).')
    assert.equal(fixRelativeDates('Moved to tomorrow, Oct 7 at 1:30 PM.', TODAY), 'Moved to today, Oct 7 at 1:30 PM.')
  })

  test('correct pairs and unrelated text are untouched', () => {
    for (const text of ['Moved to tomorrow, Thu, Oct 8 at 1:30 PM.', 'Today (Oct 7) is busy.', 'Tomorrow you have gym. Oct 9 is free.', 'tomorrow, Thursday, Oct 7', 'Nothing about dates here.', 'Your dentist is on Oct 9.']) {
      assert.equal(fixRelativeDates(text, TODAY), text, text)
    }
  })

  test('a word that is part of a longer phrase, a clause boundary or a range is never touched', () => {
    for (const text of [
      'Tomorrow, Oct 9 is free.', // no relative word fits Oct 9: left alone, nothing dropped
      'Moved it to tomorrow (Fri, Oct 9 at 3 PM).',
      'I can’t fit it in today — Thu, Oct 8 at 1:30 PM is open.',
      'Not today, Thu, Oct 8 works better.',
      'Not today, Oct 8.',
      'You’re free today and tomorrow — Fri, Oct 9 has the dentist at 3 PM.',
      'Your plan for today–Sun, Oct 11 is set.',
      'Not today: Oct 9 works better.',
      'Moved it to the day after tomorrow, Fri, Oct 9 at 1:30 PM.',
      'the day after tomorrow (Fri, Oct 9)',
      'That was the day before yesterday, Oct 5.',
      'A week from today (Wed, Oct 14) works.',
      'Two days from today, Oct 9, is free.',
      'You are free today and tomorrow (Oct 7–8).',
      'Busy yesterday and today (Oct 6–7)?',
    ]) assert.equal(fixRelativeDates(text, TODAY), text, text)
  })

  test('when the turn set the word\'s day, the date is fixed instead (the reply matches the card)', () => {
    const dates = ['2026-10-08']
    assert.equal(fixRelativeDates('I’ll move Advising to tomorrow, Oct 7 at 1:30 PM at Room 12. Shall I go ahead?', TODAY, { dates }), 'I’ll move Advising to tomorrow, Thu, Oct 8 at 1:30 PM at Room 12. Shall I go ahead?')
    assert.equal(fixRelativeDates('Moved to tomorrow (Oct 7).', TODAY, { dates }), 'Moved to tomorrow (Thu, Oct 8).')
    assert.equal(fixRelativeDates('Set for Oct 7 (tomorrow).', TODAY, { dates }), 'Set for Thu, Oct 8 (tomorrow).')
    // Both days set this turn: unclear which is meant, so it's left alone.
    assert.equal(fixRelativeDates('Moved to tomorrow, Oct 7.', TODAY, { dates: ['2026-10-07', '2026-10-08'] }), 'Moved to tomorrow, Oct 7.')
    // The turn set the date's day: the word is fixed as before.
    assert.equal(fixRelativeDates('Moved to tomorrow, Oct 7.', TODAY, { dates: ['2026-10-07'] }), 'Moved to today, Oct 7.')
  })
})

// ---- "No …" ---------------------------------------------------------------------------------------

describe('"No …" corrects the last answer', () => {
  const pendingAt = (createdAt = new Date().toISOString()) => ({ index: 1, proposal: { id: 'p1', status: 'pending', createdAt, localDate: TODAY, actions: [{ label: 'Change “Advising” (Wed, Oct 7, 1:30 PM): details → “Room 12”' }], staged: [{ tool: 'update_event', args: { eventId: 'e-adv', details: 'Room 12' }, ref: '$1' }] } })

  test('which replies are corrections', () => {
    for (const text of ['No tommorw Thursday advising 1:30pm Room 12', 'No, add or keep it', 'Nope, Friday', 'not today, Thursday']) assert.equal(isCorrection(text), true, text)
    for (const text of ['no', 'No thanks', 'nope', 'not now', 'no no', 'Not sure', 'yes', 'Thursday']) assert.equal(isCorrection(text), false, text)
  })

  test('sign-offs and acknowledgements are not corrections', () => {
    for (const text of [
      'No, I\'m good', 'nah im good', 'No, I don\'t want that', 'No, that\'s all', 'No that\'s all thanks', 'No thanks, that\'s it', 'nope, all good',
      'No, I changed my mind', 'Nope, that\'s everything', 'No that is fine', 'No, nothing else', 'No, it\'s fine', 'No, looks good', 'No, that\'s perfect',
      'No problem, also remind me at 5', 'No worries, and add milk too', 'Not bad! Also log my lunch', 'No, all set',
    ]) {
      assert.equal(isCorrection(text, { today: TODAY, titles: ['Advising', 'All hands'] }), false, text)
      assert.equal(correctionTurn(text, null, makeCtx()), null, text)
    }
  })

  test('a "No …" that names one of the items from the last answer is a correction', () => {
    assert.equal(isCorrection('No, the essay', { titles: ['Essay draft'] }), true)
    assert.equal(isCorrection('No, the essay'), false, 'nothing to tie it to')
    assert.equal(isCorrection('No, the other one'), true)
    // The waiting card's titles count.
    const pending = { index: 1, proposal: { id: 'p1', status: 'pending', createdAt: new Date().toISOString(), localDate: TODAY, actions: [{ label: 'Change “Essay draft” (today, Wed, Oct 7): priority urgent' }], staged: [] } }
    assert.ok(correctionTurn('No, the essay', pending, makeCtx()))
  })

  test('with a waiting card: it is declined and the model gets the correction note', () => {
    const turnNotes = correctionTurn('No, add or keep it', pendingAt(), makeCtx())
    assert.deepEqual(turnNotes.update, { index: 1, id: 'p1', status: 'cancelled' })
    assert.match(turnNotes.notes.join(' '), /said no to the proposal/)
    assert.match(turnNotes.notes.join(' '), /"tool":"update_event"/, 'the exact calls, to redo')
    assert.match(turnNotes.notes.join(' '), /not a request to delete or cancel/)
    assert.match(turnNotes.notes.join(' '), /otherwise just respond/)
  })

  test('without a card: just the note', () => {
    const turnNotes = correctionTurn('No, add or keep it', null, makeCtx())
    assert.equal(turnNotes.update, null)
    assert.equal(turnNotes.notes.length, 1)
    assert.match(turnNotes.notes[0], /corrects your last answer/)
  })

  test('a bare no stays a plain decline', () => {
    assert.equal(parseDecision('no'), 'no')
    assert.equal(parseDecision('No thanks'), 'no')
    assert.equal(correctionTurn('no', pendingAt(), makeCtx()), null)
    assert.equal(parseDecision('No, add or keep it'), null)
  })
})

// ---- Yes binds to the latest card ------------------------------------------------------------------

describe('a typed yes', () => {
  test('only the latest reply\'s card can be confirmed by a typed yes', () => {
    const card = (id) => ({ id, status: 'pending', createdAt: new Date().toISOString(), actions: [{ label: 'x' }], staged: [] })
    const history = [
      { role: 'user', content: 'move advising' },
      { role: 'assistant', content: 'Shall I?', proposal: card('old') },
      { role: 'user', content: 'what about the essay' },
      { role: 'assistant', content: 'It’s due today.' },
    ]
    assert.equal(findPendingProposal(history), null, 'an older card is never confirmed by a stray yes')
    history.push({ role: 'user', content: 'move it' }, { role: 'assistant', content: 'Shall I?', proposal: card('new') })
    assert.equal(findPendingProposal(history).proposal.id, 'new')
    assert.equal(parseDecision('yes please'), 'yes')
  })
})

// ---- items from the last few replies --------------------------------------------------------------

describe('recent items', () => {
  test('the item a card touched two replies ago, with its current date', () => {
    const data = advisingData()
    data.events[0].date = '2026-10-08' // moved since
    data.tasks[0].date = '2026-10-08'
    data.tasks[0].details = 'Room 12'
    const history = [
      { role: 'user', content: 'advising tomorrow' },
      { role: 'assistant', content: 'Shall I?', proposal: { id: 'p1', status: 'done', actions: [], staged: [{ tool: 'update_event', args: { eventId: 'e-adv', date: '2026-10-08' }, ref: '$1' }] } },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'You’re welcome.' },
    ]
    const note = recentItemsNote(history, data, makeCtx())
    assert.match(note, /“Advising” \(event e-adv \/ task t-adv, Thu, Oct 8, 1:30 PM, details: Room 12\)/)
  })

  test('creates (through their Undo calls) and edits that ran at once (touched) count too; nothing → empty', () => {
    const data = advisingData()
    const history = [
      { role: 'assistant', content: 'Done ✓', undo: [{ id: 'u1', calls: [{ tool: 'delete_task_forever', args: { taskId: 't-essay' } }] }] },
      normalizeMessage({ role: 'assistant', content: 'Done ✓', touched: touchedBy('update_event', { eventId: 'e-adv', details: 'x' }, { ok: true }) }),
    ]
    const note = recentItemsNote(history, data, makeCtx())
    assert.match(note, /^Items from the last few messages .*“Advising”.*; “Essay draft”/)
    assert.equal(recentItemsNote([{ role: 'assistant', content: 'Hi' }], data, makeCtx()), '')
    assert.equal(publicMessage(normalizeMessage(history[1])).touched, undefined, 'server-only')
  })
})

// ---- similar items --------------------------------------------------------------------------------

describe('a new task or event like one already there', () => {
  test('create_event "advising" the day after "Advising": staged with the hint', async () => {
    const ctx = makeCtx()
    const state = turn('all', advisingData(), ctx)
    const staged = await write(state, 'create_event', { title: 'advising', date: '2026-10-08', time: '13:30' })
    assert.equal(staged.result.ok, true)
    assert.match(staged.result.detail, /You already have “Advising” on Wed, Oct 7, 1:30 PM\./)
    assert.match(staged.result.similar, /update_event/)
    assert.match(staged.result.similar, /event e-adv/)
  })

  test('two similar items: both are named, the closest title first, whatever their order in the data', async () => {
    for (const reversed of [false, true]) {
      const data = advisingData()
      data.tasks.push({ id: 't-acad', text: 'Academic advising meeting', date: '2026-10-09', time: '10:00', details: '', done: false, archived: false })
      if (reversed) data.tasks.reverse()
      const out = await executeTool(fakeSupabase(), USER, 'create_event', { title: 'Academic advising', date: '2026-10-08' }, data, makeCtx())
      assert.equal(out.hint, 'You already have “Academic advising meeting” on Fri, Oct 9, 10:00 AM and “Advising” on Wed, Oct 7, 1:30 PM.', `reversed: ${reversed}`)
      assert.match(out.similar, /task t-acad.*event e-adv, task t-adv/)
    }
  })

  test('the "changes" level waits for Yes instead of adding a likely duplicate at once', async () => {
    const state = turn('changes', advisingData(), makeCtx())
    const out = await write(state, 'create_task', { text: 'Academic advising', date: '2026-10-09' })
    assert.equal(out.staged, true)
    assert.match(out.result.hint, /Advising/)
  })

  test('different titles, far-off dates, and several occurrences made in one turn don\'t warn', async () => {
    const ctx = makeCtx()
    const data = advisingData()
    assert.equal((await executeTool(fakeSupabase(), USER, 'create_event', { title: 'Dentist', date: '2026-10-08' }, data, ctx)).hint, undefined)
    assert.equal((await executeTool(fakeSupabase(), USER, 'create_event', { title: 'Advising', date: '2026-10-30' }, data, ctx)).hint, undefined)
    assert.equal((await executeTool(fakeSupabase(), USER, 'create_event', { title: 'Dentist', date: '2026-10-09' }, data, ctx)).hint, undefined, 'the one just made this turn')
  })

  test('after a move, the result says where the event is now', async () => {
    const data = advisingData()
    const moved = await executeTool(fakeSupabase(), USER, 'update_event', { eventId: 'e-adv', date: '2026-10-08' }, data, makeCtx())
    assert.equal(moved.message, 'Moved "Advising" to tomorrow, Thu, Oct 8, 1:30 PM.')
    const edited = await executeTool(fakeSupabase(), USER, 'update_event', { eventId: 'e-adv', details: 'Room 12' }, data, makeCtx())
    assert.equal(edited.message, 'Updated "Advising".')
  })
})

// ---- ask_choice and the instructions -----------------------------------------------------------------

describe('ask_choice and the constant instructions', () => {
  test('the same title twice gets each item\'s day and time', () => {
    const data = advisingData()
    data.tasks.push({ id: 't-adv2', text: 'Advising', date: '2026-10-08', time: '13:30', details: '', done: false, archived: false })
    const { choice } = readChoice({ question: 'Which one?', choices: ['Advising', 'Advising', 'Something else'] }, data, makeCtx())
    assert.deepEqual(choice.choices, ['Advising · Wed, Oct 7, 1:30 PM', 'Advising · Thu, Oct 8, 1:30 PM', 'Something else'])
    assert.deepEqual(readChoice({ question: 'Q', choices: ['A', 'B'] }).choice.choices, ['A', 'B'])
  })

  test('no guessed dates: more (or fewer) open items than chips → the model must label them itself', () => {
    const data = advisingData()
    data.tasks.push({ id: 't-adv0', text: 'Advising', date: '2026-09-30', time: '13:30', details: '', done: false, archived: false })
    data.tasks.push({ id: 't-adv2', text: 'Advising', date: '2026-10-14', time: '13:30', details: '', done: false, archived: false })
    const out = readChoice({ question: 'Which advising, this week or next?', choices: ['Advising', 'Advising'] }, data, makeCtx())
    assert.equal(out.ok, false)
    assert.match(out.message, /day and time/)
    // Repeats that aren't a task's title are just dropped, as before.
    assert.deepEqual(readChoice({ question: 'Q', choices: ['Later', 'Later', 'Now'] }, data, makeCtx()).choice.choices, ['Later', 'Now'])
  })

  test('staticInstructions is identical across dates, users and data, and carries the new rules', () => {
    const a = staticInstructions({ confirmMode: true })
    assert.equal(staticInstructions({ confirmMode: true }), a)
    const snapA = { today: '2026-10-07', tasks: [{ text: 'Advising' }] }
    const snapB = { today: '2027-03-01', tasks: [] }
    assert.equal(buildInstructions(snapA).split('\n\nSnapshot (JSON):')[0], buildInstructions(snapB).split('\n\nSnapshot (JSON):')[0])
    assert.doesNotMatch(a, /2026|2027/)
    assert.match(a, /say its weekday and date/)
    assert.match(a, /fix the call, not the words/)
    assert.match(a, /"no, Thursday" most likely means the item you just changed/)
    assert.match(a, /corrects your last answer/)
    assert.match(a, /ask_choice options that point at tasks or events include their day and time/)
  })
})

test('a short day word after "to" or "for" is a day, except "to sun"', () => {
  const days = (text) => resolveDayWords(text, { today: '2026-10-07' }).map((hit) => hit.iso)
  assert.deepEqual(days('move it to wed'), ['2026-10-07'])
  assert.deepEqual(days('push gym to sat'), ['2026-10-10'])
  assert.deepEqual(days('book it for mon'), ['2026-10-12'])
  assert.deepEqual(days('too much exposure to sun'), [])
  assert.deepEqual(days('I sat down'), [])
})

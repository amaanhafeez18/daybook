// Run: node --test tests/learn-prefs.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { LEARNED_MAX, answeredKeys, gymTimeSuggestion, leadSuggestion, leadText, learnedSuggestions, withAnswered } from '../src/lib/learnPrefs.js'
import { addDaysISO } from '../src/lib/dates.js'

const TODAY = '2026-10-10'
const prefsBase = { gym: true, gymTime: '17:00', taskLead: 15, quietHours: false, quietStart: '22:00', quietEnd: '07:00' }

// A live workout on `daysAgo` that started at local `time` (built locally: timezone-proof).
const at = (date, time) => {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(y, m - 1, d, h, mi).toISOString()
}
// Live: created when it started, finished an hour later.
const session = (daysAgo, time, extra = {}) => {
  const date = addDaysISO(TODAY, -daysAgo)
  const startedAt = time ? at(date, time) : null
  const endedAt = startedAt ? new Date(Date.parse(startedAt) + 3600000).toISOString() : null
  return { id: `s${daysAgo}`, date, name: 'Push', startedAt, endedAt, createdAt: startedAt || at(date, '20:00'), exercises: [], ...extra }
}
const evening = ['18:35', '18:40', '18:45', '18:30', '18:50', '18:40', '18:38', '18:42'].map((t, i) => session(i * 2 + 1, t))

describe('gymTimeSuggestion', () => {
  test('8 workouts around 6:40 PM, reminder at 5:00 PM → move it to 6:15 PM', () => {
    const offer = gymTimeSuggestion({ sessions: evening, prefs: prefsBase, today: TODAY })
    assert.equal(offer.kind, 'gymTime')
    assert.deepEqual(offer.patch, { gymTime: '18:15' })
    assert.deepEqual(offer.previous, { gymTime: '17:00' })
    // Keyed on the reminder questioned (5:00 PM), not the proposal.
    assert.equal(offer.key, 'gymTime:17:00')
    assert.equal(offer.text, 'Your last 8 workouts started around 6:40 PM, but the workout reminder comes at 5:00 PM. Move it to 6:15 PM?')
  })

  test('a reminder later than the usual start is moved earlier', () => {
    const offer = gymTimeSuggestion({ sessions: evening, prefs: { ...prefsBase, gymTime: '20:00' }, today: TODAY })
    assert.equal(offer.patch.gymTime, '18:15')
  })

  test('already close (under 30 min away): no offer', () => {
    assert.equal(gymTimeSuggestion({ sessions: evening, prefs: { ...prefsBase, gymTime: '18:00' }, today: TODAY }), null)
    assert.equal(gymTimeSuggestion({ sessions: evening, prefs: { ...prefsBase, gymTime: '18:30' }, today: TODAY }), null)
  })

  test('reminder off, or too few live workouts: no offer', () => {
    assert.equal(gymTimeSuggestion({ sessions: evening, prefs: { ...prefsBase, gym: false }, today: TODAY }), null)
    assert.equal(gymTimeSuggestion({ sessions: evening.slice(0, 5), prefs: prefsBase, today: TODAY }), null)
    assert.equal(gymTimeSuggestion({ sessions: [], prefs: prefsBase, today: TODAY }), null)
    assert.equal(gymTimeSuggestion({ sessions: null, prefs: prefsBase, today: TODAY }), null)
  })

  test('scattered start times: no offer', () => {
    const noisy = ['07:00', '18:40', '12:30', '20:15', '06:45', '18:30', '13:00', '21:00'].map((t, i) => session(i + 1, t))
    assert.equal(gymTimeSuggestion({ sessions: noisy, prefs: prefsBase, today: TODAY }), null)
  })

  test('mostly steady with two outliers still counts (6 of 8 close together)', () => {
    const mixed = ['18:35', '18:40', '07:00', '18:45', '18:30', '22:00', '18:40', '18:50'].map((t, i) => session(i + 1, t))
    assert.equal(gymTimeSuggestion({ sessions: mixed, prefs: prefsBase, today: TODAY }).patch.gymTime, '18:15')
  })

  test('quick logs, back-filled and old workouts are ignored', () => {
    const quick = Array.from({ length: 8 }, (_, i) => session(i + 1, null))
    const backFilled = evening.map((s) => ({ ...s, startedAt: at(addDaysISO(s.date, 1), '09:00') }))
    const old = evening.map((s, i) => session(100 + i, '18:40'))
    for (const sessions of [quick, backFilled, old]) assert.equal(gymTimeSuggestion({ sessions, prefs: prefsBase, today: TODAY }), null)
  })

  test('same-day logs after the fact are ignored (their start is when they were logged)', () => {
    // The assistant's "I trained" for today with no start time: started = created = now, no end.
    const assistantLogs = ['21:30', '21:25', '21:35', '21:30', '21:40', '21:30', '21:20', '21:30'].map((t, i) => session(i + 1, t, { endedAt: null }))
    // "Log my sets": started an hour before it was created.
    const afterApp = evening.map((s) => ({ ...s, createdAt: new Date(Date.parse(s.startedAt) + 3600000).toISOString() }))
    const flagged = evening.map((s) => ({ ...s, backfill: true }))
    for (const sessions of [assistantLogs, afterApp, flagged]) assert.equal(gymTimeSuggestion({ sessions, prefs: prefsBase, today: TODAY }), null)
    // Sessions from before createdAt was kept still count.
    const legacy = evening.map((s) => ({ ...s, createdAt: undefined }))
    assert.equal(gymTimeSuggestion({ sessions: legacy, prefs: prefsBase, today: TODAY }).patch.gymTime, '18:15')
  })

  test('"Not now" sticks when the suggested time drifts (same reminder questioned)', () => {
    const settings = { learned: withAnswered(undefined, 'gymTime:17:00', '2026-10-10T10:00:00.000Z') }
    const later = ['18:50', '18:55', '18:45', '18:50', '19:00', '18:50', '18:48', '18:52'].map((t, i) => session(i * 2 + 1, t))
    assert.equal(gymTimeSuggestion({ sessions: later, prefs: prefsBase, today: TODAY }).patch.gymTime, '18:30')
    assert.deepEqual(learnedSuggestions({ settings, prefs: prefsBase, tasks: [], gymSessions: later, today: TODAY }), [])
    // After a change the reminder is a different one, so a new habit can be offered once.
    const moved = learnedSuggestions({ settings, prefs: { ...prefsBase, gymTime: '06:30' }, tasks: [], gymSessions: later, today: TODAY })
    assert.equal(moved[0].key, 'gymTime:06:30')
  })

  test('only the latest 8 count: a recent change of habit wins over older sessions', () => {
    const older = ['07:00', '07:10', '06:50', '07:05', '07:00', '06:55'].map((t, i) => session(30 + i, t))
    const offer = gymTimeSuggestion({ sessions: [...older, ...evening], prefs: { ...prefsBase, gymTime: '06:30' }, today: TODAY })
    assert.equal(offer.patch.gymTime, '18:15')
  })

  test('a suggested time inside quiet hours is not offered', () => {
    const late = ['22:40', '22:45', '22:35', '22:50', '22:40', '22:45'].map((t, i) => session(i + 1, t))
    assert.equal(gymTimeSuggestion({ sessions: late, prefs: { ...prefsBase, quietHours: true, quietStart: '22:00', quietEnd: '07:00' }, today: TODAY }), null)
    assert.equal(gymTimeSuggestion({ sessions: late, prefs: prefsBase, today: TODAY }).patch.gymTime, '22:15')
  })
})

const task = (n, extra = {}) => ({
  id: `t${n}`, text: `ECON 101 study ${n}`, date: addDaysISO(TODAY, -n), time: '10:00', createdAt: at(addDaysISO(TODAY, -n), '08:00'), ...extra,
})

describe('leadSuggestion', () => {
  test('1 hour before on 6 of the last 8 timed tasks → make it the default', () => {
    const tasks = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, n <= 6 ? { reminderMinutes: 60 } : {}))
    const offer = leadSuggestion({ tasks, prefs: prefsBase, today: TODAY })
    assert.deepEqual(offer.patch, { taskLead: 60 })
    assert.deepEqual(offer.previous, { taskLead: 15 })
    assert.equal(offer.text, 'You picked 1 hour before on 6 of your last 8 timed tasks, but the default is 15 minutes before. Make 1 hour before the default?')
  })

  test('only 4 of 8 the same, or the same as the default: no offer', () => {
    const four = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, n <= 4 ? { reminderMinutes: 60 } : {}))
    assert.equal(leadSuggestion({ tasks: four, prefs: prefsBase, today: TODAY }), null)
    const same = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { reminderMinutes: 15 }))
    assert.equal(leadSuggestion({ tasks: same, prefs: prefsBase, today: TODAY }), null)
  })

  test('older custom picks behind 8 newer default tasks do not count', () => {
    const newer = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n))
    const older = [20, 21, 22, 23, 24, 25].map((n) => task(n, { reminderMinutes: 60 }))
    assert.equal(leadSuggestion({ tasks: [...older, ...newer], prefs: prefsBase, today: TODAY }), null)
  })

  test('too few timed tasks; untimed, friend reminders and "no reminder" picks ignored', () => {
    const few = [1, 2, 3, 4, 5].map((n) => task(n, { reminderMinutes: 60 }))
    assert.equal(leadSuggestion({ tasks: few, prefs: prefsBase, today: TODAY }), null)
    const untimed = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { time: '', reminderMinutes: 1440 }))
    assert.equal(leadSuggestion({ tasks: untimed, prefs: prefsBase, today: TODAY }), null)
    const friends = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { details: `friend-reminder:f1:${TODAY}`, reminderMinutes: 60 }))
    assert.equal(leadSuggestion({ tasks: friends, prefs: prefsBase, today: TODAY }), null)
    const off = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { reminderMinutes: -1 }))
    assert.equal(leadSuggestion({ tasks: off, prefs: prefsBase, today: TODAY }), null)
  })

  test('default turned off: says so; snake_case rows from the server work too', () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => task(n, { reminder_minutes: 30 }))
    const offer = leadSuggestion({ tasks, prefs: { ...prefsBase, taskLead: -1 }, today: TODAY })
    assert.equal(offer.patch.taskLead, 30)
    assert.match(offer.text, /new timed tasks get no reminder/)
  })
})

describe('learnedSuggestions and answers', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { reminderMinutes: 60 }))

  test('both offers, gym first; answered ones never come back', () => {
    const all = learnedSuggestions({ settings: {}, prefs: prefsBase, tasks, gymSessions: evening, today: TODAY })
    assert.deepEqual(all.map((offer) => offer.kind), ['gymTime', 'taskLead'])
    const settings = { learned: withAnswered(undefined, 'gymTime:17:00', '2026-10-10T10:00:00.000Z') }
    const left = learnedSuggestions({ settings, prefs: prefsBase, tasks, gymSessions: evening, today: TODAY })
    assert.deepEqual(left.map((offer) => offer.kind), ['taskLead'])
    // Keyed on the current default (15 min), so a different popular pick later doesn't re-ask.
    assert.equal(left[0].key, 'taskLead:15')
    const answered = { learned: withAnswered(undefined, 'taskLead:15', 'x') }
    const thirty = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(n, { reminderMinutes: 30 }))
    assert.deepEqual(learnedSuggestions({ settings: answered, prefs: prefsBase, tasks: thirty, gymSessions: [], today: TODAY }), [])
    assert.equal(learnedSuggestions({ settings: {}, prefs: prefsBase, tasks, gymSessions: evening, today: TODAY, limit: 1 }).length, 1)
  })

  test('gym area off: no workout offer', () => {
    const offers = learnedSuggestions({ settings: { areas: { gym: false } }, prefs: prefsBase, tasks, gymSessions: evening, today: TODAY })
    assert.deepEqual(offers.map((offer) => offer.kind), ['taskLead'])
  })

  test('withAnswered keeps the newest 50, no duplicates, other learned fields untouched', () => {
    let learned = { other: 1 }
    for (let i = 0; i < 60; i += 1) learned = withAnswered(learned, `k${i}`, `t${i}`)
    learned = withAnswered(learned, 'k59', 'again')
    assert.equal(learned.dismissed.length, LEARNED_MAX)
    assert.deepEqual(learned.dismissed[0], { key: 'k59', at: 'again' })
    assert.equal(learned.dismissed.filter((item) => item.key === 'k59').length, 1)
    assert.equal(learned.other, 1)
    assert.ok(answeredKeys({ learned }).has('k20'))
    assert.ok(!answeredKeys({ learned }).has('k5'))
    assert.equal(answeredKeys({ learned: { dismissed: 'junk' } }).size, 0)
  })

  test('leadText', () => {
    assert.equal(leadText(0), 'at the time')
    assert.equal(leadText(5), '5 minutes before')
    assert.equal(leadText(120), '2 hours before')
    assert.equal(leadText(1440), '1 day before')
    assert.equal(leadText(-1), 'no reminder')
  })
})

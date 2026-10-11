import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectHistory, detectRhythm, dismissRhythm, learnRhythms, readRhythms, restoreRhythm, rhythmKey, rhythmLabel,
  rhythmTitle, showTimeChip, titleMatches, usualTime, usualToday, visibleNow,
} from '../src/lib/rhythms.js'

// 2026-10-11 is a Sunday. Synthetic titles only.
const TODAY = '2026-10-11'
let nextId = 0
// A done task ticked at 6 PM local time on `day` (or on `ticked` when given).
function done(text, day, extra = {}) {
  const { ticked = day, ...rest } = extra
  const [y, m, d] = ticked.split('-').map(Number)
  return { id: `t${++nextId}`, text, date: day, time: '', priority: 'medium', done: true, archived: false, completedAt: new Date(y, m - 1, d, 18).toISOString(), ...rest }
}
const open = (text, extra = {}) => ({ id: `t${++nextId}`, text, date: '', time: '', priority: 'medium', done: false, archived: false, ...extra })
const series = (text, days, extra) => days.map((day) => done(text, day, extra))

describe('rhythmKey', () => {
  test('punctuation and dates share one key', () => {
    assert.equal(rhythmKey('Laundry'), 'laundry')
    assert.equal(rhythmKey('laundry!'), 'laundry')
    assert.equal(rhythmKey('Laundry (Oct 5)'), 'laundry')
    assert.equal(rhythmKey('Laundry 5/10'), 'laundry')
    assert.equal(rhythmKey('Laundry on Sunday'), 'laundry on')
    assert.equal(rhythmKey('Laundry tomorrow'), 'laundry')
    assert.equal(rhythmKey('Laundry 3rd'), 'laundry')
    assert.equal(rhythmKey('Laundry next week'), 'laundry')
    assert.equal(rhythmKey('Café run'), 'cafe run')
  })

  test('a short month at the end goes; the title is the tidy common part', () => {
    assert.equal(rhythmKey('Pay rent Oct'), 'pay rent')
    assert.equal(rhythmKey('Pay rent Sep'), 'pay rent')
    assert.equal(rhythmTitle([{ text: 'Pay rent Sep' }, { text: 'Pay rent Oct' }]), 'Pay rent')
  })

  test('ordinary words that look like dates stay', () => {
    assert.equal(rhythmKey('Buy sun cream'), 'buy sun cream')
    assert.equal(rhythmKey('May call back later'), 'may call back later')
  })

  test('plain numbers stay, short keys are ignored', () => {
    assert.notEqual(rhythmKey('Week 5 reading'), rhythmKey('Week 6 reading'))
    assert.equal(rhythmKey('ok'), '')
    assert.equal(rhythmKey('Oct 5'), '')
  })

  test('rhythmTitle: the most common text, ties to the latest', () => {
    assert.equal(rhythmTitle([{ text: 'Do laundry' }, { text: 'Laundry' }, { text: 'Laundry' }, { text: 'Do laundry' }]), 'Do laundry')
    assert.equal(rhythmTitle([{ text: 'Pay rent Oct' }, { text: 'Pay rent Oct' }, { text: 'Pay rent Nov' }]), 'Pay rent')
    assert.equal(rhythmTitle([{ text: 'Laundry' }, { text: 'Laundry' }, { text: 'laundry!' }]), 'Laundry')
    assert.equal(rhythmTitle([{ text: 'Laundry (Oct 4)' }, { text: 'laundry (Oct 11)' }]), 'Laundry')
  })
})

describe('weekly', () => {
  test('Sundays ×4: due on Sunday, not Monday', () => {
    const days = ['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04']
    const rhythm = detectRhythm(days, TODAY)
    assert.equal(rhythm.kind, 'weekly')
    assert.equal(rhythm.every, 1)
    assert.equal(rhythm.weekday, 0)
    assert.equal(rhythm.due, true)
    assert.equal(detectRhythm(days, '2026-10-12').due, false)
    assert.equal(rhythmLabel(rhythm), 'Every Sunday')
  })

  test('one skipped week (3 of 4) is still due', () => {
    const rhythm = detectRhythm(['2026-09-13', '2026-09-20', '2026-10-04'], TODAY)
    assert.equal(rhythm.kind, 'weekly')
    assert.equal(rhythm.every, 1)
    assert.equal(rhythm.due, true)
  })

  test('every other Friday is due only on the 14-day Fridays', () => {
    const days = ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']
    const rhythm = detectRhythm(days, '2026-10-23')
    assert.equal(rhythm.kind, 'weekly')
    assert.equal(rhythm.every, 2)
    assert.equal(rhythm.due, true)
    assert.equal(rhythmLabel(rhythm), 'Every other Friday')
    assert.equal(detectRhythm(days, '2026-10-16').due, false)
    assert.equal(detectRhythm(days, '2026-10-22').due, false)
    assert.equal(detectRhythm(days, '2026-11-06').due, true)
  })

  test('a weekly rhythm long stopped is gone', () => {
    assert.equal(detectRhythm(['2026-08-02', '2026-08-09', '2026-08-16'], TODAY), null)
  })
})

describe('every N days', () => {
  const days = ['2026-09-27', '2026-09-30', '2026-10-03', '2026-10-06', '2026-10-09']
  test('every 3 days: due 3–6 days after, not at 2, not at 7', () => {
    assert.equal(detectRhythm(days, '2026-10-11').due, false) // s = 2
    assert.equal(detectRhythm(days, '2026-10-12').due, true) // s = 3
    assert.equal(detectRhythm(days, '2026-10-13').due, true) // s = 4
    assert.equal(detectRhythm(days, '2026-10-15').due, true) // s = 6
    assert.equal(detectRhythm(days, '2026-10-16').due, false) // s = 7
    assert.equal(rhythmLabel(detectRhythm(days, '2026-10-12')), 'Every 3 days')
  })

  test('daily', () => {
    const everyOther = ['2026-09-29', '2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09']
    const found = detectRhythm(everyOther, TODAY)
    assert.equal(found.kind, 'days')
    assert.equal(found.due, true)
    const daily = Array.from({ length: 11 }, (_, index) => `2026-${index < 1 ? '09-30' : `10-${String(index).padStart(2, '0')}`}`)
    assert.equal(detectRhythm(daily, TODAY).due, true)
    assert.equal(rhythmLabel(detectRhythm(daily, TODAY)), 'Every day')
    // A 5-day exam streak isn't a habit.
    assert.equal(detectRhythm(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], TODAY), null)
    // Nor is a 7-day streak that ended 20 days ago.
    const old = detectRhythm(['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'], TODAY)
    assert.ok(!old?.due)
  })
})

describe('monthly', () => {
  test('1st / 2nd / 1st is due Nov 1 and 2, not Nov 10', () => {
    const days = ['2026-08-01', '2026-09-02', '2026-10-01']
    const rhythm = detectRhythm(days, '2026-11-01')
    assert.equal(rhythm.kind, 'monthly')
    assert.equal(rhythm.due, true)
    assert.equal(rhythmLabel(rhythm), 'Around the 1st')
    assert.equal(detectRhythm(days, '2026-11-02').due, true)
    assert.equal(detectRhythm(days, '2026-11-10').due, false)
  })

  test('the last day of the month is due on Feb 28', () => {
    const rhythm = detectRhythm(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31'], '2027-02-28')
    assert.equal(rhythm.kind, 'monthly')
    assert.equal(rhythm.due, true)
    assert.equal(rhythmLabel(rhythm), 'Around the end of the month')
  })

  test('one missed month still matches; two do not', () => {
    assert.equal(detectRhythm(['2026-07-01', '2026-08-01', '2026-10-01'], '2026-11-01')?.kind, 'monthly')
    assert.equal(detectRhythm(['2026-06-01', '2026-07-01', '2026-10-01'], '2026-11-01'), null)
  })
})

describe('false patterns', () => {
  test('irregular gaps', () => {
    assert.equal(detectRhythm(['2026-09-01', '2026-09-03', '2026-09-12', '2026-09-16', '2026-09-29'], TODAY), null)
  })
  test('Sundays mixed with random days', () => {
    const days = ['2026-09-13', '2026-09-14', '2026-09-20', '2026-09-24', '2026-09-25', '2026-09-27', '2026-10-04', '2026-10-09']
    assert.equal(detectRhythm(days, TODAY), null)
  })
  test('3 Sundays over 6 months', () => {
    assert.equal(detectRhythm(['2026-04-19', '2026-07-05', '2026-09-27'], TODAY), null)
  })
  test('only 2 occurrences', () => {
    assert.equal(detectRhythm(['2026-09-27', '2026-10-04'], TODAY), null)
  })
})

const sundays = (text = 'Laundry', extra) => series(text, ['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'], extra)

describe('exclusions', () => {
  test('a due rhythm is offered', () => {
    const list = usualToday({ tasks: sundays(), today: TODAY })
    assert.deepEqual(list.map((item) => item.title), ['Laundry'])
    assert.equal(list[0].priority, 'medium')
  })
  test('friend reminders are never learned', () => {
    const tasks = sundays('Talk to Sam', { details: 'friend-reminder:f1:2026-09-13' })
    assert.deepEqual(learnRhythms(tasks, TODAY), [])
  })
  test('an open one (for tomorrow, or undated) blocks it', () => {
    assert.deepEqual(usualToday({ tasks: [...sundays(), open('Laundry', { date: '2026-10-12' })], today: TODAY }), [])
    assert.deepEqual(usualToday({ tasks: [...sundays(), open('laundry!')], today: TODAY }), [])
  })
  test('done today blocks it', () => {
    assert.deepEqual(usualToday({ tasks: [...sundays(), done('Laundry', '', { ticked: TODAY })], today: TODAY }), [])
  })
  test('dismissed or switched off', () => {
    const tasks = sundays()
    assert.deepEqual(usualToday({ tasks, today: TODAY, rhythms: { dismissed: [{ key: 'laundry', title: 'Laundry', at: TODAY }] } }), [])
    assert.deepEqual(usualToday({ tasks, today: TODAY, rhythms: { off: true } }), [])
  })
  test('an archived open task does not block; an archived done one counts as history', () => {
    const tasks = [...sundays().map((task, index) => (index < 2 ? { ...task, archived: true } : task)), open('Laundry', { archived: true })]
    assert.deepEqual(usualToday({ tasks, today: TODAY }).map((item) => item.key), ['laundry'])
  })
})

describe('which day a task counts for', () => {
  test('dated tasks ticked in one clean-up count for their dates', () => {
    const tasks = series('Mop floor', ['2026-09-14', '2026-09-21', '2026-09-28'], { ticked: '2026-10-01' })
    const [found] = learnRhythms(tasks, TODAY)
    assert.equal(found.rhythm.kind, 'weekly')
    assert.equal(found.rhythm.weekday, 1)
    assert.equal(found.rhythm.due, false)
  })
  test('undated tasks ticked on one day are not a rhythm', () => {
    const tasks = [1, 2, 3, 4].map(() => done('Mop floor', '', { ticked: '2026-10-01' }))
    assert.deepEqual(learnRhythms(tasks, TODAY), [])
  })
  test('without completedAt the date is used', () => {
    const tasks = sundays().map(({ completedAt, ...task }) => task)
    assert.deepEqual(collectHistory(tasks, TODAY).get('laundry').days, ['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'])
  })
})

describe('usualTime', () => {
  const items = (times) => times.map((time, index) => ({ day: `2026-09-${String(10 + index).padStart(2, '0')}`, time, text: 'x' }))
  test('a steady time: the latest one', () => {
    assert.equal(usualTime(items(['17:00', '17:30', '16:45'])), '16:45')
  })
  test('scattered times', () => {
    assert.equal(usualTime(items(['09:00', '14:00', '20:00'])), null)
  })
  test('stale: the last two had no time', () => {
    assert.equal(usualTime(items(['17:00', '17:00', '17:00', '', ''])), null)
  })
  test('learned with the rhythm', () => {
    const tasks = sundays().map((task, index) => ({ ...task, time: ['17:00', '17:30', '16:45', '17:00'][index] }))
    assert.equal(learnRhythms(tasks, TODAY)[0].usualTime, '17:00')
  })
})

describe('visibleNow and showTimeChip', () => {
  const list = [{ key: 'a', usualTime: '20:00' }, { key: 'b', usualTime: null }, { key: 'c', usualTime: '17:00' }]
  test('night, day, evening', () => {
    assert.deepEqual(visibleNow(list, '03:00', '18:00'), [])
    assert.deepEqual(visibleNow(list, '12:00', '18:00').map((item) => item.key), ['a', 'b', 'c'])
    assert.deepEqual(visibleNow(list, '19:00', '18:00').map((item) => item.key), ['a'])
  })
  test('the time chip only while the time is ahead', () => {
    assert.equal(showTimeChip(list[0], '19:59'), true)
    assert.equal(showTimeChip(list[0], '20:00'), false)
    assert.equal(showTimeChip(list[1], '08:00'), false)
  })
})

describe('usualToday ranking', () => {
  test('at most 2, strongest and most repeated first', () => {
    const tasks = [
      ...series('Laundry', ['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04']),
      ...series('Water plants', ['2026-09-20', '2026-09-27', '2026-10-04']),
      ...series('Call home', ['2026-09-13', '2026-09-20', '2026-09-24', '2026-10-04']), // 3 of 4 on Sundays
      ...series('Stretch', ['2026-10-04', '2026-10-06', '2026-10-08']),
    ]
    const list = usualToday({ tasks, today: TODAY })
    assert.deepEqual(list.map((item) => item.title), ['Laundry', 'Water plants'])
    assert.equal(usualToday({ tasks, today: TODAY, limit: 5 }).length, 3)
  })
})

describe('titleMatches', () => {
  const tasks = [
    ...sundays().map((task) => ({ ...task, time: '17:00' })),
    ...series('Pay rent Oct', ['2026-08-01', '2026-09-01', '2026-10-01']),
    ...series('Lawn mowing', ['2026-09-20', '2026-09-27', '2026-10-04']),
  ]
  const learned = learnRhythms(tasks, TODAY)
  test('word prefixes', () => {
    assert.deepEqual(titleMatches(learned, 'lau').map((item) => item.title), ['Laundry'])
    assert.deepEqual(titleMatches(learned, 'la').map((item) => item.title).sort(), ['Laundry', 'Lawn mowing'])
    assert.deepEqual(titleMatches(learned, 'pay r').map((item) => item.title), ['Pay rent'])
    assert.deepEqual(titleMatches(learned, 'rent').map((item) => item.title), ['Pay rent'])
  })
  test('not the one typed in full, nor hidden ones, nor 1 character', () => {
    assert.deepEqual(titleMatches(learned, 'laundry'), [])
    assert.deepEqual(titleMatches(learned, 'Laundry!'), [])
    assert.deepEqual(titleMatches(learned, 'lau', { dismissed: [{ key: 'laundry' }] }), [])
    assert.deepEqual(titleMatches(learned, 'l'), [])
  })
})

describe('dismiss and restore', () => {
  test('newest first, no duplicates, at most 60', () => {
    let rhythms = dismissRhythm(undefined, { key: 'laundry', title: 'Laundry' }, TODAY)
    rhythms = dismissRhythm(rhythms, { key: 'pay rent', title: 'Pay rent' }, TODAY)
    rhythms = dismissRhythm(rhythms, { key: 'laundry', title: 'Laundry' }, '2026-10-12')
    assert.deepEqual(rhythms.dismissed.map((item) => item.key), ['laundry', 'pay rent'])
    assert.equal(rhythms.dismissed[0].at, '2026-10-12')
    for (let index = 0; index < 70; index += 1) rhythms = dismissRhythm(rhythms, { key: `zz-key-${index}`, title: 'x' }, TODAY)
    assert.equal(rhythms.dismissed.length, 60)
    assert.equal(rhythms.dismissed[0].key, 'zz-key-69')
  })
  test('restore removes it, and keeps the switch', () => {
    const rhythms = restoreRhythm({ off: true, dismissed: [{ key: 'laundry', title: 'Laundry', at: TODAY }, { key: 'pay rent', title: 'Pay rent', at: TODAY }] }, 'laundry')
    assert.deepEqual(rhythms, { off: true, dismissed: [{ key: 'pay rent', title: 'Pay rent', at: TODAY }] })
  })
  test('readRhythms tolerates corrupt settings', () => {
    assert.deepEqual(readRhythms(null), { off: false, dismissed: [] })
    assert.deepEqual(readRhythms({ rhythms: 'x' }), { off: false, dismissed: [] })
    assert.deepEqual(readRhythms({ rhythms: { off: 'yes', dismissed: [null, 3, { key: 5 }, { key: 'laundry' }] } }), { off: false, dismissed: [{ key: 'laundry', title: 'laundry', at: '' }] })
  })
})

describe('learned but not due', () => {
  test('a Monday rhythm is learned on Sunday but not offered', () => {
    const tasks = series('Bins out', ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'])
    const learned = learnRhythms(tasks, TODAY)
    assert.equal(learned.length, 1)
    assert.equal(learned[0].rhythm.due, false)
    assert.deepEqual(usualToday({ tasks, today: TODAY, learned }), [])
  })
  test('bad input never throws', () => {
    assert.deepEqual(learnRhythms([null, { done: true, text: 5, completedAt: 'nope' }], TODAY), [])
    assert.deepEqual(usualToday({ tasks: null, today: TODAY }), [])
  })
})

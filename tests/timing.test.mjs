import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { busySlots, clashAt, clashSlot, usualTimes } from '../src/lib/timing.js'

const TODAY = '2026-09-23'
const at = (hours, minutes = 0) => hours * 60 + minutes
let nextId = 0
const task = (date, time, extra = {}) => ({ id: `t${(nextId += 1)}`, text: 'Something', date, time, ...extra })
const times = (time, count, date = '2026-09-10', extra = {}) => Array.from({ length: count }, () => task(date, time, extra))

describe('usualTimes', () => {
  test('no history: the defaults', () => {
    assert.deepEqual(usualTimes([], TODAY), ['09:00', '12:00', '15:00', '18:00'])
  })

  test('slots used 3+ times win, rounded to :00/:30, and replace defaults within an hour', () => {
    const tasks = [...times('08:25', 2), ...times('08:35', 1), ...times('13:00', 4), ...times('17:40', 3), ...times('21:00', 5)]
    // 8:30 (3 uses), 1 PM, 5:30 PM, 9 PM: every default is within an hour of one of them.
    assert.deepEqual(usualTimes(tasks, TODAY), ['08:30', '13:00', '17:30', '21:00'])
  })

  test('a single learned time is topped up from the defaults that are not near it', () => {
    assert.deepEqual(usualTimes(times('12:30', 3), TODAY), ['09:00', '12:30', '15:00', '18:00'])
  })

  test('rarely used times, old tasks and friend reminders do not count', () => {
    const tasks = [
      ...times('07:00', 2),
      ...times('20:00', 5, '2026-05-01'), // older than 90 days
      ...times('10:00', 5, '2026-09-20', { details: 'friend-reminder:f1:2026-09-20' }),
      ...times('10:00', 3, '', {}), // undated
    ]
    assert.deepEqual(usualTimes(tasks, TODAY), ['09:00', '12:00', '15:00', '18:00'])
  })

  test('limit and clock order', () => {
    const tasks = [...times('06:00', 3), ...times('22:00', 9), ...times('19:00', 4)]
    assert.deepEqual(usualTimes(tasks, TODAY, { limit: 2 }), ['19:00', '22:00'])
    assert.deepEqual(usualTimes(tasks, TODAY), ['06:00', '09:00', '19:00', '22:00'])
  })
})

describe('busySlots and clashAt', () => {
  const classSlots = [{ id: 'c1', name: 'Economics', time: '2:30 PM - 4:30 PM' }, { id: 'c2', name: 'Lab', time: '9:00 AM' }, { id: 'c3', name: 'Seminar', time: 'TBA' }]
  const tasks = [
    task(TODAY, '18:00', { id: 'dentist', text: 'Dentist' }),
    task(TODAY, '19:00', { id: 'done', done: true }),
    task(TODAY, '', { id: 'untimed' }),
    task('2026-09-24', '10:00', { id: 'other-day' }),
    task(TODAY, '20:00', { id: 'editing' }),
  ]

  test('classes (start-only lasts an hour) and that day\'s open timed tasks, minus the one being edited', () => {
    assert.deepEqual(busySlots(classSlots, tasks, TODAY, 'editing'), [
      { start: at(9), end: at(10), label: 'Lab', kind: 'class' },
      { start: at(14, 30), end: at(16, 30), label: 'Economics', kind: 'class' },
      { start: at(18), end: at(18, 30), label: 'Dentist', kind: 'task' },
    ])
  })

  test('clashAt names what a time falls in', () => {
    const busy = busySlots(classSlots, tasks, TODAY, 'editing')
    assert.equal(clashAt('15:00', busy), 'Economics')
    assert.equal(clashAt('16:30', busy), null) // the class has ended
    assert.equal(clashAt('18:00', busy), 'Dentist')
    assert.equal(clashAt('12:00', busy), null)
    assert.equal(clashAt('', busy), null)
    assert.equal(clashSlot('09:30', busy).kind, 'class')
  })
})

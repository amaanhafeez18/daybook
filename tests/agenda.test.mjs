import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeCount, eveningLeftovers, nowNext, timePassed } from '../src/lib/agenda.js'

const TODAY = '2026-09-23'
const at = (hours, minutes = 0) => hours * 60 + minutes
const task = (id, time, extra = {}) => ({ id, text: `Task ${id}`, date: TODAY, time, done: false, ...extra })
const slot = (id, time, name = `Class ${id}`) => ({ id, name, time })

describe('nowNext', () => {
  test('a class in progress is "now", until its end', () => {
    const line = nowNext({ tasks: [task('a', '15:00')], classSlots: [slot('c1', '2:30 PM - 4:30 PM', 'Economics')], nowMinutes: at(15, 10) })
    assert.deepEqual(line, { kind: 'now', title: 'Economics', start: at(14, 30), end: at(16, 30), minutesUntil: 0, ref: { type: 'class', id: 'c1' } })
  })

  test('back-to-back classes: the second is "now" the minute the first ends', () => {
    const classSlots = [slot('c1', '13:00-14:00'), slot('c2', '14:00-15:00')]
    assert.equal(nowNext({ classSlots, nowMinutes: at(13, 59) }).ref.id, 'c1')
    assert.equal(nowNext({ classSlots, nowMinutes: at(14, 0) }).ref.id, 'c2')
    assert.equal(nowNext({ classSlots, nowMinutes: at(15, 0) }), null)
  })

  test('a class with only a start time lasts an hour', () => {
    const classSlots = [slot('c1', '9:00 AM')]
    assert.equal(nowNext({ classSlots, nowMinutes: at(9, 59) }).kind, 'now')
    assert.equal(nowNext({ classSlots, nowMinutes: at(9, 59) }).end, at(10, 0))
    assert.equal(nowNext({ classSlots, nowMinutes: at(10, 0) }), null)
  })

  test('the next thing within 3 hours is "next", with how long until it', () => {
    const line = nowNext({ tasks: [task('b', '16:00'), task('a', '14:30')], nowMinutes: at(14, 5) })
    assert.deepEqual(line, { kind: 'next', title: 'Task a', start: at(14, 30), end: at(14, 45), minutesUntil: 25, ref: { type: 'task', id: 'a' } })
    assert.equal(nowNext({ tasks: [task('a', '14:30')], nowMinutes: at(14, 30) }).minutesUntil, 0)
  })

  test('a gap over 3 hours reads "free"', () => {
    const line = nowNext({ tasks: [task('a', '18:00')], classSlots: [slot('c1', '8:00 PM')], nowMinutes: at(14, 0) })
    assert.equal(line.kind, 'free')
    assert.equal(line.title, 'Task a')
    assert.equal(line.minutesUntil, 240)
    assert.equal(nowNext({ tasks: [task('a', '17:00')], nowMinutes: at(14, 0) }).kind, 'next') // exactly 3 h
  })

  test('unreadable times, untimed, done and passed tasks are skipped', () => {
    const tasks = [task('x', 'soon'), task('y', ''), task('z', '15:00', { done: true }), task('p', '10:00')]
    assert.equal(nowNext({ tasks, classSlots: [slot('c1', 'TBA')], nowMinutes: at(12, 0) }), null)
  })

  test('nothing left today hides the line', () => {
    assert.equal(nowNext({ tasks: [], classSlots: [], nowMinutes: at(9, 0) }), null)
    assert.equal(nowNext(), null)
  })
})

describe('eveningLeftovers', () => {
  test('untimed and passed open tasks for today; a later one stays', () => {
    const tasks = [
      task('untimed', ''),
      task('passed', '14:00'),
      task('later', '21:00'),
      task('done', '', { done: true }),
      task('archived', '', { archived: true }),
      task('tomorrow', '', { date: '2026-09-24' }),
      task('unreadable', 'after lunch'),
    ]
    assert.deepEqual(eveningLeftovers(tasks, TODAY, '18:30').map((item) => item.id), ['untimed', 'passed', 'unreadable'])
    assert.deepEqual(eveningLeftovers(tasks, TODAY, '21:30').map((item) => item.id), ['untimed', 'passed', 'later', 'unreadable'])
    assert.deepEqual(eveningLeftovers([], TODAY, '18:30'), [])
  })
})

describe('timePassed', () => {
  test('only open tasks for today whose time is behind now', () => {
    assert.equal(timePassed(task('a', '14:00'), TODAY, at(14, 1)), true)
    assert.equal(timePassed(task('a', '14:00'), TODAY, at(14, 0)), false)
    assert.equal(timePassed(task('a', '14:00', { done: true }), TODAY, at(15, 0)), false)
    assert.equal(timePassed(task('a', '14:00', { date: '2026-09-24' }), TODAY, at(15, 0)), false)
    assert.equal(timePassed(task('a', ''), TODAY, at(15, 0)), false)
  })
})

describe('badgeCount', () => {
  const row = (id, date, extra = {}) => ({ id, text: `Task ${id}`, date, done: false, ...extra })

  test('overdue and due-today open tasks are counted', () => {
    const tasks = [row('old', '2026-09-01'), row('yesterday', '2026-09-22'), row('today', TODAY), row('timed', TODAY, { time: '09:00' })]
    assert.equal(badgeCount(tasks, TODAY), 4)
  })

  test('done, archived, future, undated and malformed dates are left out', () => {
    const tasks = [
      row('done', TODAY, { done: true }),
      row('archived', '2026-09-20', { archived: true }),
      row('future', '2026-09-24'),
      row('undated', ''),
      { id: 'missing', text: 'No date', done: false },
      row('short', '2026-1-5'),
      row('null', null),
      row('number', 20260923),
      row('counted', TODAY),
    ]
    assert.equal(badgeCount(tasks, TODAY), 1)
  })

  test('catch-up reminders count unless People is off', () => {
    const tasks = [row('a', TODAY), row('talk', TODAY, { details: 'friend-reminder:f1:2026-09-23' })]
    assert.equal(badgeCount(tasks, TODAY), 2)
    assert.equal(badgeCount(tasks, TODAY, { people: true }), 2)
    assert.equal(badgeCount(tasks, TODAY, { people: false }), 1)
  })

  test('a non-list is 0 and rows that are not tasks are skipped', () => {
    assert.equal(badgeCount(null, TODAY), 0)
    assert.equal(badgeCount(undefined, TODAY), 0)
    assert.equal(badgeCount({ length: 2 }, TODAY), 0)
    assert.equal(badgeCount('tasks', TODAY), 0)
    assert.equal(badgeCount([null, 5, 'x', [], row('a', TODAY)], TODAY), 1)
    assert.equal(badgeCount([], TODAY), 0)
  })

  test('the count stops at 9999', () => {
    const tasks = Array.from({ length: 10050 }, (_, i) => row(`t${i}`, TODAY))
    assert.equal(badgeCount(tasks, TODAY), 9999)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { busyOn, busySlots, clashAt, clashSlot, clashesAt, classIn, classMatchers, classSlotsFor, freeSlots, namesClass, nextFreeStart, taskClashes, usualTimes } from '../src/lib/timing.js'

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

describe('classSlotsFor', () => {
  const classes = [
    { id: 'a', name: 'ECON 101', days: ['Wed', 'Fri'], dayDetails: { Wed: { time: '2:30 PM - 3:45 PM' } }, time: '10:00 AM' },
    { id: 'b', name: 'Lab', days: [{ day: 'Wed', time: '9:00 AM' }, { day: 'Thu', time: '1 PM' }] },
    { id: 'c', name: 'Seminar', days: ['Wed'], time: 'TBA' },
    { id: 'd', name: 'Old course', days: ['Wed'], time: '8:00 AM', endDate: '2026-09-01' },
    { id: 'e', name: 'HIST 200', days: ['Wed'], day_details: { Wed: { time: '17:00-18:15' } }, end_date: '2026-12-01' },
  ]

  test('both day formats, camelCase and snake_case, start-only lasts an hour, ended terms and TBA left out', () => {
    assert.deepEqual(classSlotsFor(classes, TODAY), [
      { title: 'Lab', start: '09:00', end: '10:00' },
      { title: 'ECON 101', start: '14:30', end: '15:45' },
      { title: 'HIST 200', start: '17:00', end: '18:15' },
    ])
    assert.deepEqual(classSlotsFor(classes, '2026-09-25'), [{ title: 'ECON 101', start: '10:00', end: '11:00' }]) // Fri: the shared time
    assert.deepEqual(classSlotsFor(classes, 'not a date'), [])
    assert.deepEqual(classSlotsFor(null, TODAY), [])
  })
})

describe('clashesAt and busyOn', () => {
  const classSlots = [{ title: 'ECON 101', start: '14:30', end: '15:45' }]
  const tasks = [
    { id: 'dentist', text: 'Dentist', date: TODAY, time: '16:00' },
    { id: 'done', text: 'Done thing', date: TODAY, time: '14:45', done: true },
    { id: 'other', text: 'Other day', date: '2026-09-24', time: '14:45' },
  ]
  const events = [
    { id: 'e1', title: 'Dentist', date: TODAY, time: '16:00', taskId: 'dentist' }, // the task's own event
    { id: 'e2', title: 'Club meeting', date: TODAY, time: '18:00 - 19:30' },
    { id: 'e3', title: 'All day', date: TODAY, time: '' },
  ]

  test('a time inside a class clashes; touching ends do not', () => {
    assert.deepEqual(clashesAt({ date: TODAY, time: '15:00', classSlots }), [{ kind: 'class', title: 'ECON 101', start: '14:30', end: '15:45' }])
    assert.deepEqual(clashesAt({ date: TODAY, time: '15:45', classSlots }), [])
    assert.deepEqual(clashesAt({ date: TODAY, time: '14:00', classSlots }), []) // 2:00-2:30 ends as the class starts
    assert.equal(clashesAt({ date: TODAY, time: '14:00', minutes: 60, classSlots }).length, 1)
  })

  test('linked events count once (as their task), done and other-day tasks never', () => {
    const at4 = clashesAt({ date: TODAY, time: '16:10', classSlots, events, tasks })
    assert.deepEqual(at4, [{ kind: 'task', title: 'Dentist', start: '16:00', end: '16:30' }])
    assert.deepEqual(clashesAt({ date: TODAY, time: '14:45', tasks }), [])
    assert.deepEqual(clashesAt({ date: TODAY, time: '19:00', events }).map((item) => item.title), ['Club meeting'])
  })

  test('the item being edited never clashes with itself, task or event id', () => {
    assert.deepEqual(clashesAt({ date: TODAY, time: '16:00', events, tasks, exceptId: 'dentist' }), [])
    assert.deepEqual(clashesAt({ date: TODAY, time: '18:30', events, exceptId: 'e2' }), [])
  })

  test('unreadable input is no clash', () => {
    assert.deepEqual(clashesAt({ date: TODAY, time: 'soon', classSlots }), [])
    assert.deepEqual(clashesAt({ date: '', time: '15:00', classSlots }), [])
  })

  test('busyOn lists the day in order', () => {
    assert.deepEqual(busyOn({ date: TODAY, classSlots, events, tasks }).map((item) => `${item.kind}:${item.start}-${item.end}`), ['class:14:30-15:45', 'task:16:00-16:30', 'event:18:00-19:30'])
  })
})

describe('taskClashes', () => {
  const classes = [{ id: 'c', name: 'ECON 101', days: ['Wed'], time: '2:30 PM - 3:45 PM' }]
  test('one clash per task, classes first; past, done and untimed tasks skipped', () => {
    const tasks = [
      { id: 'a', text: 'Call Sam', date: TODAY, time: '15:00' },
      { id: 'b', text: 'Pick up parcel', date: TODAY, time: '15:15' },
      { id: 'c', text: 'Bring laptop', date: TODAY, time: '' },
      { id: 'd', text: 'Gone', date: '2026-09-16', time: '15:00' },
      { id: 'e', text: 'Done', date: TODAY, time: '15:00', done: true },
      { id: 'f', text: 'Evening walk', date: TODAY, time: '20:00' },
    ]
    const events = tasks.filter((task) => task.date && !task.done).map((task) => ({ id: `ev-${task.id}`, taskId: task.id, title: task.text, date: task.date, time: task.time }))
    const clashes = taskClashes({ tasks, events, classes, from: TODAY })
    assert.deepEqual(Object.keys(clashes).sort(), ['a', 'b'])
    assert.equal(clashes.a.title, 'ECON 101')
    assert.equal(clashes.b.kind, 'class')
  })

  test('two tasks half an hour apart do not clash; 15 minutes apart they do', () => {
    const tasks = [
      { id: 'x', text: 'Gym', date: TODAY, time: '18:00' },
      { id: 'y', text: 'Dinner', date: TODAY, time: '18:30' },
      { id: 'z', text: 'Call home', date: TODAY, time: '19:30' },
      { id: 'w', text: 'Pay rent', date: TODAY, time: '19:45' },
    ]
    const clashes = taskClashes({ tasks, from: TODAY })
    assert.deepEqual(Object.keys(clashes).sort(), ['w', 'z'])
    assert.equal(clashes.z.title, 'Pay rent')
  })

  test('an event made on the calendar without a task still counts', () => {
    const tasks = [{ id: 'm', text: 'Call the bank', date: TODAY, time: '18:30' }]
    const events = [{ id: 'e', title: 'Club meeting', date: TODAY, time: '18:00 - 19:30' }]
    assert.equal(taskClashes({ tasks, events, from: TODAY }).m.title, 'Club meeting')
  })
})

describe('freeSlots and nextFreeStart', () => {
  const busy = [{ start: '17:30', end: '18:30' }, { start: '18:15', end: '19:00' }, { start: '20:00', end: '20:30' }]

  test('gaps of at least minMinutes inside the window, overlapping busy merged', () => {
    assert.deepEqual(freeSlots({ busy, from: '17:00', to: '22:00', minMinutes: 61 }), [{ start: '20:30', end: '22:00' }])
    assert.deepEqual(freeSlots({ busy, from: '17:00', to: '22:00', minMinutes: 60 }), [{ start: '19:00', end: '20:00' }, { start: '20:30', end: '22:00' }])
    assert.deepEqual(freeSlots({ busy, from: '17:00', to: '22:00', minMinutes: 30 }), [
      { start: '17:00', end: '17:30' }, { start: '19:00', end: '20:00' }, { start: '20:30', end: '22:00' },
    ])
    assert.deepEqual(freeSlots({ busy: [], from: '17:00', to: '22:00' }), [{ start: '17:00', end: '22:00' }])
    assert.deepEqual(freeSlots({ busy: [{ start: '16:00', end: '23:00' }], from: '17:00', to: '22:00' }), [])
    // busySlots' minutes work too
    assert.deepEqual(freeSlots({ busy: [{ start: 570, end: 660 }], from: '09:00', to: '12:00', minMinutes: 60 }), [{ start: '11:00', end: '12:00' }])
  })

  test('the first start that fits, rounded up to 5 minutes', () => {
    assert.equal(nextFreeStart({ time: '16:00', minutes: 30, busy }), '16:00')
    assert.equal(nextFreeStart({ time: '17:45', minutes: 30, busy }), '19:00')
    assert.equal(nextFreeStart({ time: '19:00', minutes: 90, busy }), '20:30')
    assert.equal(nextFreeStart({ time: '15:00', minutes: 30, busy: [{ start: '14:30', end: '15:47' }] }), '15:50')
    assert.equal(nextFreeStart({ time: '21:45', minutes: 30, busy: [{ start: '21:30', end: '22:00' }] }), null)
    assert.equal(nextFreeStart({ time: 'later', busy }), null)
  })
})

describe('something held in its own class is not a clash with it', () => {
  // TODAY (2026-09-23) is a Wednesday.
  const classes = [
    { id: 'econ', name: 'ECON 101', days: [{ day: 'Wed', time: '2:30 PM - 3:45 PM' }] },
    { id: 'cs', name: 'COMPSCI 1026A', days: [{ day: 'Wed', time: '9:00 AM - 10:30 AM' }] },
  ]

  test('an in-class quiz or midterm names its class: no tag; a dentist visit still clashes', () => {
    const tasks = [
      { id: 'q', text: 'ECON 101 midterm', date: TODAY, time: '14:30' },
      { id: 'c', text: 'CS1026 quiz 2', date: TODAY, time: '09:00' },
      { id: 'd', text: 'Dentist', date: TODAY, time: '15:00' },
      { id: 'w', text: 'Pick up ECON 101 textbook', date: TODAY, time: '10:00' },
    ]
    const found = taskClashes({ tasks, classes, from: TODAY })
    assert.equal(found.q, undefined)
    assert.equal(found.c, undefined)
    assert.equal(found.d.title, 'ECON 101')
    // Naming a different class doesn't excuse a clash with this one.
    assert.equal(found.w.title, 'COMPSCI 1026A')
  })

  test('clashesAt and busyOn take the title', () => {
    const classSlots = classSlotsFor(classes, TODAY)
    assert.deepEqual(clashesAt({ date: TODAY, time: '14:30', classSlots, title: 'econ101 quiz' }), [])
    assert.equal(clashesAt({ date: TODAY, time: '14:30', classSlots, title: 'Call Sam' }).length, 1)
    assert.equal(busyOn({ date: TODAY, classSlots, title: 'ECON 101 midterm' }).length, 1)
    assert.equal(nextFreeStart({ time: '14:30', busy: busyOn({ date: TODAY, classSlots, title: 'ECON 101 midterm' }) }), '14:30')
  })

  test('namesClass: codes, short forms, and look-alikes that are not', () => {
    assert.ok(namesClass('ECON 101 midterm', 'ECON 101'))
    assert.ok(namesClass('econ-101 essay', 'ECON 101'))
    assert.ok(namesClass('CS1026 quiz', 'COMPSCI 1026A'))
    assert.ok(namesClass('COMPSCI 1026 lab', 'COMPSCI 1026A'))
    assert.ok(namesClass('Econ quiz', 'ECON 101'))
    assert.ok(!namesClass('Room 101 meeting', 'ECON 101'))
    assert.ok(!namesClass('Economy flight', 'ECON 101'))
    assert.ok(!namesClass('Dentist', 'ECON 101'))
    assert.ok(!namesClass('', 'ECON 101'))
  })
})

describe('classMatchers and classIn', () => {
  test('long subject codes match their short forms, only when one class has that number', () => {
    const matchers = classMatchers([{ id: 'cs', name: 'COMPSCI 1026A' }, { id: 'ec', name: 'ECONOMIC 1021A' }, { id: 'hi', name: 'HISTORY 2201B' }])
    assert.equal(classIn('CS1026 quiz', matchers).id, 'cs')
    assert.equal(classIn('ECON1021 final', matchers).id, 'ec')
    assert.equal(classIn('Econ 1021: quiz 3', matchers).id, 'ec')
    assert.equal(classIn('History essay', matchers).id, 'hi')
    assert.equal(classIn('Room 1021 cleanup', matchers), null)
    const shared = classMatchers([{ id: 'cs', name: 'COMPSCI 1026A' }, { id: 'ca', name: 'CALCULUS 1026' }])
    assert.equal(classIn('CS1026 quiz', shared), null)
    assert.equal(classIn('COMPSCI 1026 quiz', shared).id, 'cs')
  })

  test('a spelled-out subject: initials with the number; its everyday words are only weak', () => {
    const matchers = classMatchers([{ id: 'x', name: 'Computer Science 201' }])
    assert.deepEqual([classIn('CS 201 project', matchers).id, classIn('CS 201 project', matchers).how], ['x', 'code'])
    assert.equal(classIn('Science fair', matchers).how, 'word')
    assert.equal(classIn('Computer repair', matchers).how, 'word')
  })
})

describe('busy past midnight', () => {
  test('an event that ends after midnight is busy to the end of the day', () => {
    const events = [{ id: 'p', title: 'Party', date: TODAY, time: '11:00 PM - 1:00 AM' }]
    assert.deepEqual(busyOn({ date: TODAY, events }), [{ kind: 'event', title: 'Party', start: '23:00', end: '23:59' }])
    assert.equal(clashesAt({ date: TODAY, time: '23:30', events }).length, 1)
  })
})

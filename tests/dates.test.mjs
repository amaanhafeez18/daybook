import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dayHeading, dayPresets, daysFromNow, dueDayLabel, dueLine, dueSentence, formatDayDate, formatDue, formatTimeShort, nextWeekISO, parseQuickAdd,
  snoozeOptions, weekendISO,
} from '../src/lib/dates.js'

// Local time, like the app: Wednesday 23 September 2026, 2:30 PM.
const NOW = new Date(2026, 8, 23, 14, 30)
const TODAY = '2026-09-23'

const parse = (text, now = NOW) => {
  const { title, date, time } = parseQuickAdd(text, now)
  return { title, date, time }
}
// With the day a form already has (parseQuickAdd's options.day).
const parse3 = (text, day) => {
  const { title, date, time } = parseQuickAdd(text, NOW, { day })
  return { title, date, time }
}

describe('parseQuickAdd: days', () => {
  test('today, tomorrow and their spellings, at either end', () => {
    assert.deepEqual(parse('Finish report today'), { title: 'Finish report', date: TODAY, time: '' })
    assert.deepEqual(parse('Finish report today.'), { title: 'Finish report', date: TODAY, time: '' })
    assert.deepEqual(parse('Today: finish report'), { title: 'finish report', date: TODAY, time: '' })
    assert.deepEqual(parse('Call mom tomorrow'), { title: 'Call mom', date: '2026-09-24', time: '' })
    assert.deepEqual(parse('call mom tmrw'), { title: 'call mom', date: '2026-09-24', time: '' })
    assert.deepEqual(parse('Tomorrow buy milk'), { title: 'buy milk', date: '2026-09-24', time: '' })
    assert.deepEqual(parse('Buy tickets for tomorrow'), { title: 'Buy tickets', date: '2026-09-24', time: '' })
  })

  test('weekdays are the next one after today; "this" allows today, "next" means next week', () => {
    assert.equal(parse('Essay due friday').date, '2026-09-25')
    assert.equal(parse('Essay due fri').date, '2026-09-25')
    assert.equal(parse('Water plants wed').date, '2026-09-30') // it is Wednesday: the next one
    assert.equal(parse('Water plants this wed').date, TODAY)
    assert.equal(parse('Party next fri').date, '2026-10-02')
    assert.equal(parse('Party next monday').date, '2026-09-28')
    assert.equal(parse('Call Thurs').date, '2026-09-24')
    assert.equal(parse('Tues call').date, '2026-09-29')
    assert.equal(parse('Essay due friday').title, 'Essay')
  })

  test('next week is Monday; this weekend is Saturday (or today at the weekend)', () => {
    assert.deepEqual(parse('Pay rent next week'), { title: 'Pay rent', date: '2026-09-28', time: '' })
    assert.deepEqual(parse('Plan for next week'), { title: 'Plan', date: '2026-09-28', time: '' })
    assert.equal(parse('Pay rent next week', new Date(2026, 8, 27, 10)).date, '2026-09-28') // from a Sunday
    assert.equal(parse('Pay rent next week', new Date(2026, 8, 28, 10)).date, '2026-10-05') // from a Monday
    assert.equal(parse('Clean bike this weekend').date, '2026-09-26')
    assert.equal(parse('Clean bike this weekend', new Date(2026, 8, 27, 10)).date, '2026-09-27')
  })

  test('month and day, rolling over to next year once passed', () => {
    assert.equal(parse('Trip oct 2').date, '2026-10-02')
    assert.equal(parse('Trip on October 2nd').date, '2026-10-02')
    assert.equal(parse('Trip 2nd of october').date, '2026-10-02')
    assert.equal(parse('Renew passport jan 15').date, '2027-01-15')
    assert.equal(parse('Renew passport sep 23').date, TODAY)
    assert.deepEqual(parse('Thing feb 30'), { title: 'Thing feb 30', date: '', time: '' })
  })

  test('in N days / weeks', () => {
    assert.deepEqual(parse('Review in 3 days'), { title: 'Review', date: '2026-09-26', time: '' })
    assert.equal(parse('Review in 2 weeks').date, '2026-10-07')
    assert.equal(parse('Review in a week').date, '2026-09-30')
  })
})

describe('parseQuickAdd: times', () => {
  test('am/pm and 24-hour clocks', () => {
    assert.deepEqual(parse('Call mom tomorrow at 5pm'), { title: 'Call mom', date: '2026-09-24', time: '17:00' })
    assert.deepEqual(parse('Call mom at 5pm tomorrow'), { title: 'Call mom', date: '2026-09-24', time: '17:00' })
    assert.deepEqual(parse('tomorrow 5pm call mom'), { title: 'call mom', date: '2026-09-24', time: '17:00' })
    assert.deepEqual(parse('Dentist mon 5pm'), { title: 'Dentist', date: '2026-09-28', time: '17:00' })
    assert.deepEqual(parse('Call at 5:30 p.m. tmrw'), { title: 'Call', date: '2026-09-24', time: '17:30' })
    assert.deepEqual(parse('Ship v2 by fri 17:00'), { title: 'Ship v2', date: '2026-09-25', time: '17:00' })
    assert.equal(parse('Wake up 12am tomorrow').time, '00:00')
    assert.equal(parse('Lunch 12pm tomorrow').time, '12:00')
    assert.equal(parse('Lunch tomorrow at noon').time, '12:00')
    assert.equal(parse('Early run 06:00 tomorrow').time, '06:00')
  })

  test('a time alone means today, or tomorrow once it has passed', () => {
    assert.deepEqual(parse('Pick up parcel 5pm'), { title: 'Pick up parcel', date: TODAY, time: '17:00' })
    assert.deepEqual(parse('x 17:30'), { title: 'x', date: TODAY, time: '17:30' })
    assert.deepEqual(parse('Standup 9am'), { title: 'Standup', date: '2026-09-24', time: '09:00' })
    assert.deepEqual(parse('Lunch at noon'), { title: 'Lunch', date: '2026-09-24', time: '12:00' })
  })

  test('"at 5" without am/pm', () => {
    assert.equal(parse('Room 101 at 3').time, '15:00') // 1–6: afternoon
    assert.equal(parse('Gym at 7').time, '19:00') // 7 AM has passed today: evening
    assert.equal(parse('Gym at 7', new Date(2026, 8, 23, 6, 0)).time, '07:00')
    assert.deepEqual(parse('Gym at 7 tomorrow'), { title: 'Gym', date: '2026-09-24', time: '07:00' })
    assert.deepEqual(parse('Call at 10'), { title: 'Call', date: '2026-09-24', time: '10:00' }) // 10–11: morning
    assert.equal(parse('Walk 5:30').time, '17:30')
  })

  test('tonight, parts of the day and relative times', () => {
    assert.deepEqual(parse('Buy milk tonight'), { title: 'Buy milk', date: TODAY, time: '20:00' })
    assert.deepEqual(parse('Call at 9 tonight'), { title: 'Call', date: TODAY, time: '21:00' })
    assert.deepEqual(parse('Standup tomorrow morning'), { title: 'Standup', date: '2026-09-24', time: '09:00' })
    assert.deepEqual(parse('Call bob this morning at 10'), { title: 'Call bob', date: TODAY, time: '10:00' })
    assert.deepEqual(parse('Report in 2 hours'), { title: 'Report', date: TODAY, time: '16:30' })
    assert.deepEqual(parse('Take meds in half an hour'), { title: 'Take meds', date: TODAY, time: '15:00' })
    assert.deepEqual(parse('Take a break in 20 min'), { title: 'Take a break', date: TODAY, time: '14:50' })
    assert.deepEqual(parse('Call in an hour'), { title: 'Call', date: TODAY, time: '15:30' })
    assert.deepEqual(parse('Check oven in 2 hours', new Date(2026, 8, 23, 23, 15)), { title: 'Check oven', date: '2026-09-24', time: '01:15' })
  })
})

describe('parseQuickAdd: a time on its own keeps the day already set', () => {
  const DAY = '2026-10-20' // e.g. the calendar's selected day, or a picked "Tomorrow"

  test('hasDay says whether the words named a day', () => {
    assert.equal(parseQuickAdd('Dentist 3pm', NOW).hasDay, false)
    assert.equal(parseQuickAdd('Dentist tomorrow 3pm', NOW).hasDay, true)
    assert.equal(parseQuickAdd('Dentist fri', NOW).hasDay, true)
    assert.equal(parseQuickAdd('Buy milk tonight', NOW).hasDay, true)
    assert.equal(parseQuickAdd('Report in 2 hours', NOW).hasDay, true)
  })

  test('a time alone goes on the given day, even one that is today and already past', () => {
    assert.deepEqual(parse3('Dentist 3pm', DAY), { title: 'Dentist', date: DAY, time: '15:00' })
    assert.deepEqual(parse3('Standup 9am', TODAY), { title: 'Standup', date: TODAY, time: '09:00' })
    // Without am/pm, 7–9 are read against that day, not against the clock now.
    assert.equal(parse3('Gym at 7', DAY).time, '07:00')
    assert.equal(parse3('Gym at 7', TODAY).time, '19:00')
  })

  test('a day in the words still wins; no day given (or a bad one) behaves as before', () => {
    assert.deepEqual(parse3('Dentist tomorrow 3pm', DAY), { title: 'Dentist', date: '2026-09-24', time: '15:00' })
    assert.deepEqual(parse3('Report in 2 hours', DAY), { title: 'Report', date: TODAY, time: '16:30' })
    assert.deepEqual(parse3('Standup 9am', ''), { title: 'Standup', date: '2026-09-24', time: '09:00' })
    assert.deepEqual(parse3('Standup 9am', 'soon'), { title: 'Standup', date: '2026-09-24', time: '09:00' })
    assert.deepEqual(parse3('Read chapter 5', DAY), { title: 'Read chapter 5', date: '', time: '' })
  })
})

describe('parseQuickAdd: leaves titles alone', () => {
  const untouched = [
    "Call Friday's contact",
    'Plan the Monday meeting',
    'Lie in the sun',
    'Sun cream',
    'Gym every monday',
    'Meet from 3 to 5pm',
    'Meet 3-5pm',
    'Call 5pm-6pm',
    'Office hours 2:30 – 4 pm',
    'Book table for 8pm',
    'Buy 2 apples',
    'Call 911',
    'Email John re: Monday',
    'Read chapter 5',
  ]
  for (const text of untouched) {
    test(JSON.stringify(text), () => {
      assert.deepEqual(parseQuickAdd(text, NOW), { title: text, date: '', time: '', matched: [], hasDay: false })
    })
  }

  test('brackets around the phrase leave no stray bracket in the title', () => {
    assert.deepEqual(parse('Call mom (tomorrow)'), { title: 'Call mom', date: '2026-09-24', time: '' })
    assert.deepEqual(parse('Call mom [5pm]'), { title: 'Call mom', date: TODAY, time: '17:00' })
    assert.deepEqual(parse('(tomorrow) call mom'), { title: 'call mom', date: '2026-09-24', time: '' })
  })

  test('nothing but a date is not parsed (the title would be empty)', () => {
    assert.deepEqual(parse('tomorrow'), { title: 'tomorrow', date: '', time: '' })
    assert.deepEqual(parse('mon 5pm'), { title: 'mon 5pm', date: '', time: '' })
    assert.deepEqual(parse('   '), { title: '', date: '', time: '' })
  })

  test('"sat"/"sun" count as days next to a time or after on/this/next', () => {
    assert.deepEqual(parse('Brunch sat 10am'), { title: 'Brunch', date: '2026-09-26', time: '10:00' })
    assert.deepEqual(parse('Brunch on sat'), { title: 'Brunch', date: '2026-09-26', time: '' })
    assert.deepEqual(parse('Brunch sat'), { title: 'Brunch sat', date: '', time: '' })
  })

  test('matched spans point at the recognised words, in order', () => {
    const text = 'Call mom tomorrow at 5pm'
    const { matched } = parseQuickAdd(text, NOW)
    assert.deepEqual(matched.map((span) => span.text), ['tomorrow', 'at 5pm'])
    for (const span of matched) assert.equal(text.slice(span.start, span.end), span.text)
  })
})

describe('due labels', () => {
  test('today, tomorrow, weekday within the week, weekday + date further out', () => {
    assert.equal(dueDayLabel(TODAY, TODAY), 'Today')
    assert.equal(dueDayLabel('2026-09-24', TODAY), 'Tomorrow')
    assert.match(dueDayLabel('2026-09-25', TODAY), /fri/i)
    assert.match(dueDayLabel('2026-10-02', TODAY), /fri.*oct.*2|2.*oct/i)
    assert.match(dueDayLabel('2027-01-15', TODAY), /2027/)
    assert.equal(dueDayLabel('nope', TODAY), '')
  })

  test('chip and sentence forms', () => {
    assert.equal(formatDue('2026-09-24', '17:00', TODAY), 'Tomorrow · 5:00 PM')
    assert.equal(formatDue(TODAY, '', TODAY), 'Today')
    assert.equal(dueSentence('2026-09-24', '17:00', TODAY), 'tomorrow at 5:00 PM')
    assert.equal(dueSentence(TODAY, '', TODAY), 'today')
    assert.match(dueSentence('2026-09-25', '09:30', TODAY), /^Friday at 9:30 AM$/)
  })
})

describe('day presets: one "next week" and "weekend" for chips, Later… and quick add', () => {
  test('next week is the coming Monday; the weekend is this Saturday (today at the weekend)', () => {
    assert.equal(nextWeekISO(TODAY), '2026-09-28') // from a Wednesday
    assert.equal(nextWeekISO('2026-09-27'), '2026-09-28') // from a Sunday: tomorrow
    assert.equal(nextWeekISO('2026-09-28'), '2026-10-05') // from a Monday: a week on
    assert.equal(weekendISO(TODAY), '2026-09-26')
    assert.equal(weekendISO('2026-09-26'), '2026-09-26')
    assert.equal(weekendISO('2026-09-27'), '2026-09-27')
  })

  test('quick add agrees with the chips', () => {
    assert.equal(parse('Pay rent next week').date, dayPresets(TODAY).find((preset) => preset.id === 'next-week').date)
    assert.equal(parse('Clean bike this weekend').date, dayPresets(TODAY).find((preset) => preset.id === 'weekend').date)
  })

  test('presets name their day and skip repeats', () => {
    assert.deepEqual(dayPresets(TODAY), [
      { id: 'today', label: 'Today', date: TODAY, day: 'Wed' },
      { id: 'tomorrow', label: 'Tomorrow', date: '2026-09-24', day: 'Thu' },
      { id: 'weekend', label: 'Weekend', date: '2026-09-26', day: 'Sat' },
      { id: 'next-week', label: 'Next week', date: '2026-09-28', day: 'Mon' },
    ])
    // Friday: the weekend is tomorrow. Sunday: the weekend is today and next week is tomorrow.
    assert.deepEqual(dayPresets('2026-09-25').map((preset) => preset.id), ['today', 'tomorrow', 'next-week'])
    assert.deepEqual(dayPresets('2026-09-27').map((preset) => preset.id), ['today', 'tomorrow'])
  })
})

describe('readable due line and day headings', () => {
  test('short times and day + date', () => {
    assert.equal(formatTimeShort('18:00'), '6 PM')
    assert.equal(formatTimeShort('09:00'), '9 AM')
    assert.equal(formatTimeShort('00:00'), '12 AM')
    assert.equal(formatTimeShort('13:30'), '1:30 PM')
    assert.equal(formatDayDate('2026-10-07', TODAY), 'Wed, Oct 7')
    assert.match(formatDayDate('2027-01-15', TODAY), /2027/)
  })

  test('how far off a day is', () => {
    assert.equal(daysFromNow(TODAY, TODAY), 'today')
    assert.equal(daysFromNow('2026-09-24', TODAY), 'tomorrow')
    assert.equal(daysFromNow('2026-09-25', TODAY), 'in 2 days')
    assert.equal(daysFromNow('2026-10-14', TODAY), 'in 3 weeks')
    assert.equal(daysFromNow('2026-09-22', TODAY), 'yesterday')
    assert.equal(daysFromNow('2026-09-11', TODAY), '12 days ago')
  })

  test('the line under the Due chips', () => {
    assert.equal(dueLine('2026-09-25', '13:30', TODAY), 'Fri, Sep 25 · 1:30 PM · in 2 days')
    assert.equal(dueLine(TODAY, '', TODAY), 'Wed, Sep 23 · today')
    assert.equal(dueLine('', '', TODAY), '')
  })

  test('journal headings say the date once', () => {
    assert.deepEqual(dayHeading(TODAY, TODAY), { title: 'Today', subtitle: 'Wednesday, September 23' })
    assert.equal(dayHeading('2026-09-22', TODAY).title, 'Yesterday')
    assert.deepEqual(dayHeading('2026-09-11', TODAY), { title: 'Fri, Sep 11', subtitle: '12 days ago' })
  })
})

describe('snoozeOptions ("Later…")', () => {
  const ids = (task, now = NOW) => snoozeOptions(task, now).map((option) => option.id)

  test('a timed task due now gets every choice, soonest first', () => {
    const options = snoozeOptions({ date: TODAY, time: '14:00' }, NOW)
    assert.deepEqual(options.map((option) => option.id), ['hour', 'evening', 'tomorrow', 'weekend', 'next-week'])
    assert.deepEqual(options[0], { id: 'hour', label: 'In 1 hour', date: TODAY, time: '15:30', hint: '3:30 PM' })
    assert.deepEqual(options[1], { id: 'evening', label: 'This evening', date: TODAY, time: '18:00', hint: '6 PM' })
    // The day choices keep the task's time.
    assert.deepEqual(options[2], { id: 'tomorrow', label: 'Tomorrow', date: '2026-09-24', time: '14:00', hint: 'Thu · 2 PM' })
    assert.equal(options[3].hint, 'Sat · 2 PM')
    assert.equal(options[4].date, '2026-09-28')
  })

  test('"In 1 hour" rounds up to 5 minutes and needs a time', () => {
    assert.equal(snoozeOptions({ date: TODAY, time: '14:00' }, new Date(2026, 8, 23, 14, 32))[0].time, '15:35')
    assert.equal(snoozeOptions({ date: TODAY, time: '23:00' }, new Date(2026, 8, 23, 23, 30))[0].date, '2026-09-24')
    assert.deepEqual(ids({ date: TODAY, time: '' }), ['evening', 'tomorrow', 'weekend', 'next-week'])
    assert.deepEqual(ids({}), ['evening', 'tomorrow', 'weekend', 'next-week'])
  })

  test('"This evening" only until 5 PM', () => {
    assert.ok(!ids({ date: TODAY }, new Date(2026, 8, 23, 17, 5)).includes('evening'))
  })

  test('only choices later than when it is due', () => {
    assert.deepEqual(ids({ date: '2026-09-24' }), ['weekend', 'next-week'])
    assert.deepEqual(ids({ date: TODAY, time: '19:00' }), ['tomorrow', 'weekend', 'next-week'])
    assert.deepEqual(ids({ date: '2026-10-10' }), [])
    // Overdue: everything.
    assert.deepEqual(ids({ date: '2026-09-20', time: '09:00' }), ['hour', 'evening', 'tomorrow', 'weekend', 'next-week'])
  })
})

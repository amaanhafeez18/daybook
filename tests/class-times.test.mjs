import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { timeRangeMinutes } from '../src/lib/dates.js'
import { classOver } from '../src/lib/planner.js'

const at = (hh, mm = 0) => hh * 60 + mm

describe('timeRangeMinutes', () => {
  test('12-hour ranges as the class sheet saves them', () => {
    assert.deepEqual(timeRangeMinutes('2:30 PM - 4:30 PM'), { start: at(14, 30), end: at(16, 30) })
    assert.deepEqual(timeRangeMinutes('11:30 AM - 1:30 PM'), { start: at(11, 30), end: at(13, 30) })
    assert.deepEqual(timeRangeMinutes('8:30 AM - 9:30 AM'), { start: at(8, 30), end: at(9, 30) })
    assert.deepEqual(timeRangeMinutes('12:00 PM - 1:00 PM'), { start: at(12), end: at(13) })
  })

  test('24-hour, other dashes and "to", hours without minutes', () => {
    assert.deepEqual(timeRangeMinutes('14:30–15:50'), { start: at(14, 30), end: at(15, 50) })
    assert.deepEqual(timeRangeMinutes('2 PM - 3 PM'), { start: at(14), end: at(15) })
    assert.deepEqual(timeRangeMinutes('11 am to 1 pm'), { start: at(11), end: at(13) })
    assert.deepEqual(timeRangeMinutes('9:00 a.m. - 10:15 a.m.'), { start: at(9), end: at(10, 15) })
  })

  test('a side without AM/PM borrows the other side’s', () => {
    assert.deepEqual(timeRangeMinutes('2:30-3:30 PM'), { start: at(14, 30), end: at(15, 30) })
    assert.deepEqual(timeRangeMinutes('11:30-1:30 PM'), { start: at(11, 30), end: at(13, 30) })
    assert.deepEqual(timeRangeMinutes('11 AM - 1'), { start: at(11), end: at(13) })
    assert.deepEqual(timeRangeMinutes('10 AM - 11'), { start: at(10), end: at(11) })
  })

  test('a start only, or nothing readable', () => {
    assert.deepEqual(timeRangeMinutes('2:30 PM'), { start: at(14, 30), end: null })
    assert.deepEqual(timeRangeMinutes(''), { start: null, end: null })
    assert.deepEqual(timeRangeMinutes('after lunch'), { start: null, end: null })
    assert.deepEqual(timeRangeMinutes(null), { start: null, end: null })
  })
})

describe('classOver', () => {
  test('over at its end time', () => {
    assert.equal(classOver('2:30 PM - 4:30 PM', at(16, 29)), false)
    assert.equal(classOver('2:30 PM - 4:30 PM', at(16, 30)), true)
    assert.equal(classOver('2:30 PM - 4:30 PM', at(9)), false)
  })

  test('a start-only time counts as an hour long; no time never ends', () => {
    assert.equal(classOver('2:30 PM', at(15, 29)), false)
    assert.equal(classOver('2:30 PM', at(15, 30)), true)
    assert.equal(classOver('', at(23, 59)), false)
    assert.equal(classOver('TBA', at(23, 59)), false)
  })
})

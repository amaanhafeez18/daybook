import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addDaysISO } from '../src/lib/dates.js'
import { weightTrend } from '../src/lib/food/nutrition.js'
import { DEFAULT_WEIGHT_RANGE, WEIGHT_RANGES, rangeStart, weeklyWeights, weighInSummary } from '../src/lib/weighIn.js'

const TODAY = '2026-10-11'
const row = (daysAgo, kg, id = `w${daysAgo}`) => ({ id, date: addDaysISO(TODAY, -daysAgo), kg })
// A weigh-in every day for `days` days, losing `perDay` kg a day, ending today.
const daily = (days, start, perDay) => Array.from({ length: days }, (_, i) => row(days - 1 - i, start - perDay * i))

describe('weighInSummary', () => {
  test('nothing logged (or only future dates) → null', () => {
    assert.equal(weighInSummary([], TODAY), null)
    assert.equal(weighInSummary(null, TODAY), null)
    assert.equal(weighInSummary([{ id: 'f', date: addDaysISO(TODAY, 2), kg: 80 }], TODAY), null)
    assert.equal(weighInSummary([row(0, 80)], 'not a date'), null)
  })

  test('the change is weightTrend’s smoothed weekly change, nothing else', () => {
    const list = daily(21, 80, 0.1)
    const summary = weighInSummary(list, TODAY)
    const trend = weightTrend(list, TODAY)
    assert.equal(summary.weeklyChangeKg, trend.weeklyChangeKg)
    assert.equal(summary.latestKg, trend.latestKg)
    assert.equal(summary.latestDate, TODAY)
    assert.ok(Math.abs(summary.weeklyChangeKg - -0.7) < 1e-9)
    assert.equal(summary.direction, 'down')
  })

  test('one heavy morning moves the latest value but barely the change', () => {
    const list = daily(21, 80, 0)
    list[list.length - 1] = row(0, 82)
    const summary = weighInSummary(list, TODAY)
    assert.equal(summary.latestKg, 82)
    assert.ok(summary.weeklyChangeKg < 0.3) // 2 kg / 7 days of averaging
  })

  test('direction: up, steady when it rounds to 0, null without enough data', () => {
    assert.equal(weighInSummary(daily(21, 70, -0.05), TODAY).direction, 'up')
    assert.equal(weighInSummary(daily(21, 70, 0.001), TODAY).direction, 'steady')
    const two = weighInSummary([row(1, 70), row(0, 70.2)], TODAY)
    assert.equal(two.weeklyChangeKg, null)
    assert.equal(two.direction, null)
    assert.equal(two.noTrend, 'new')
    assert.equal(two.latestKg, 70.2)
  })

  test('direction follows the change as shown in the user’s unit (as Food → Weight does)', () => {
    const list = daily(21, 80, 0.04 / 7) // −0.04 kg a week
    const kg = weighInSummary(list, TODAY, 'kg')
    assert.ok(Math.abs(kg.weeklyChangeKg - -0.04) < 1e-9)
    assert.equal(kg.direction, 'steady') // shows as 0.0 kg
    assert.equal(weighInSummary(list, TODAY, 'lb').direction, 'down') // shows as −0.1 lb
    assert.equal(weighInSummary(list, TODAY).direction, 'steady') // kg by default
  })

  test('once-a-week weigh-ins: no weekly change, flagged as sparse, spark from the weigh-ins', () => {
    const weekly = Array.from({ length: 10 }, (_, i) => row(63 - i * 7, 85 - i * 0.5))
    const summary = weighInSummary(weekly, TODAY)
    assert.equal(summary.weeklyChangeKg, null)
    assert.equal(summary.direction, null)
    assert.equal(summary.noTrend, 'sparse')
    assert.deepEqual(summary.spark, weekly.filter((entry) => entry.date >= addDaysISO(TODAY, -29)).map((entry) => entry.kg))
    assert.ok(summary.spark.length >= 2)
    // A new daily weigher (3 days in) is 'new', not 'sparse'.
    assert.equal(weighInSummary(daily(3, 80, 0.1), TODAY).noTrend, 'new')
    // With a weekly change there's no noTrend.
    assert.equal(weighInSummary(daily(21, 80, 0.1), TODAY).noTrend, null)
  })

  test('a single weigh-in: no spark', () => {
    assert.deepEqual(weighInSummary([row(0, 80)], TODAY).spark, [])
  })

  test('the latest weigh-in can be days old; the spark covers the last 30 days only', () => {
    const list = daily(60, 90, 0.05).filter((entry) => entry.date <= addDaysISO(TODAY, -5))
    const summary = weighInSummary(list, TODAY)
    assert.equal(summary.latestDate, addDaysISO(TODAY, -5))
    assert.equal(summary.spark.length, 25) // days −29 … −5
    assert.ok(summary.spark.every((kg) => typeof kg === 'number'))
  })

  test('bad rows are ignored', () => {
    const summary = weighInSummary([row(0, 75), { date: 'x', kg: 70 }, { date: TODAY }, null, row(3, -1)], TODAY)
    assert.equal(summary.latestKg, 75)
  })
})


describe('ranges', () => {
  test('one range set for both charts', () => {
    assert.deepEqual(WEIGHT_RANGES.map((range) => range.label), ['1M', '3M', '1Y', 'All'])
    assert.ok(WEIGHT_RANGES.some((range) => range.id === DEFAULT_WEIGHT_RANGE))
  })

  test('rangeStart counts today as the last day', () => {
    assert.equal(rangeStart('1m', TODAY), addDaysISO(TODAY, -30))
    assert.equal(rangeStart('3m', TODAY), addDaysISO(TODAY, -91))
    assert.equal(rangeStart('all', TODAY), null)
    assert.equal(rangeStart('nope', TODAY), null)
  })
})

describe('weeklyWeights', () => {
  // TODAY is Sun 2026-10-11; weeks start on Monday (10-05, 09-28, …).
  test('the average of each week, newest first, with the change from the last week that had one', () => {
    const rows = [row(0, 80), row(2, 80.4), row(8, 81), row(10, 81.4), row(22, 82)]
    const weeks = weeklyWeights(rows, TODAY, 1, 4)
    assert.deepEqual(weeks.map((w) => w.weekStart), ['2026-10-05', '2026-09-28', '2026-09-21', '2026-09-14'])
    assert.ok(Math.abs(weeks[0].avgKg - 80.2) < 1e-9)
    assert.equal(weeks[0].count, 2)
    assert.ok(Math.abs(weeks[0].changeKg - -1) < 1e-9) // 80.2 vs 81.2
    assert.equal(weeks[2].avgKg, null) // no weigh-in that week
    assert.ok(Math.abs(weeks[1].changeKg - -0.8) < 1e-9) // 81.2 vs 82 (two weeks earlier)
    assert.equal(weeks[3].changeKg, null) // nothing earlier
  })

  test('a weigh-in before the window is the baseline for its oldest week; future and bad rows are ignored', () => {
    const rows = [row(0, 80), row(40, 84), { id: 'f', date: addDaysISO(TODAY, 3), kg: 70 }, { id: 'x', date: 'nope', kg: 80 }, row(1, 0)]
    const [week] = weeklyWeights(rows, TODAY, 1, 1)
    assert.equal(week.avgKg, 80)
    assert.equal(week.changeKg, -4)
    assert.deepEqual(weeklyWeights(rows, 'nope'), [])
  })

  test('the first weekday decides the weeks', () => {
    const sunday = weeklyWeights([row(0, 80), row(1, 81)], TODAY, 0, 1)
    assert.equal(sunday[0].weekStart, TODAY)
    assert.equal(sunday[0].count, 1)
  })
})

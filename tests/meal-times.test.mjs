// Run: node --test tests/meal-times.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MEALS_DEFAULT } from '../src/lib/food/nutrition.js'
import { FIXED_MEAL_TIMES, learnMealTimes, learnedMealTimes, mealClock, mealForNow, nowMeal } from '../src/lib/food/mealTimes.js'
import { addDaysISO } from '../src/lib/dates.js'

const TODAY = '2026-10-10'
const meals = [...MEALS_DEFAULT, { id: 'pre', name: 'Pre-workout' }]
let uid = 0
// createdAt on the same local day as the entry (built locally so the test is timezone-proof).
const localStamp = (date, time) => {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(y, m - 1, d, h, mi).toISOString()
}
const row = (daysAgo, meal, time, extra = {}) => {
  const date = addDaysISO(TODAY, -daysAgo)
  return { id: `e${++uid}`, date, meal, time, name: 'Food', calories: 100, source: 'manual', createdAt: 'createdAt' in extra ? extra.createdAt : localStamp(date, time), ...extra }
}

describe('learnMealTimes', () => {
  test('median time per meal from 3+ days, one count per day (its first row)', () => {
    const entries = [
      row(1, 'breakfast', '11:20'), row(1, 'breakfast', '11:40'), // same day: counts once at 11:20
      row(2, 'breakfast', '11:30'),
      row(3, 'breakfast', '11:35'),
      row(4, 'breakfast', '11:25'),
    ]
    const learned = learnMealTimes(entries, { today: TODAY, meals })
    assert.deepEqual(Object.keys(learned), ['breakfast'])
    assert.equal(learned.breakfast.days, 4)
    assert.equal(learned.breakfast.at, '11:28') // halfway between 11:25 and 11:30, rounded
  })

  test('too little data: nothing learned (fewer than 3 days)', () => {
    const entries = [row(1, 'lunch', '14:00'), row(1, 'lunch', '14:10'), row(2, 'lunch', '14:05')]
    assert.deepEqual(learnMealTimes(entries, { today: TODAY, meals }), {})
    assert.deepEqual(learnMealTimes([], { today: TODAY }), {})
    assert.deepEqual(learnMealTimes(null, { today: TODAY }), {})
  })

  test('scattered times are not a habit (snacks all over the day)', () => {
    const entries = ['09:00', '12:00', '15:30', '18:00', '21:30', '23:00'].map((t, i) => row(i + 1, 'snack', t))
    assert.equal(learnMealTimes(entries, { today: TODAY, meals }).snack, undefined)
  })

  test('skips copies, rows added on another day, old rows, future rows, unknown meals and bad times', () => {
    const date = (n) => addDaysISO(TODAY, -n)
    const entries = [
      row(1, 'dinner', '19:00', { source: 'copy' }),
      row(2, 'dinner', '19:00', { createdAt: localStamp(date(1), '09:00') }), // logged the next day
      row(3, 'dinner', '19:00', { createdAt: localStamp(date(1), '09:00') }),
      row(40, 'dinner', '19:00'), row(41, 'dinner', '19:00'), row(42, 'dinner', '19:00'), // older than 30 days
      row(-1, 'dinner', '19:00'), // tomorrow
      row(1, 'brunch', '10:00'), row(2, 'brunch', '10:00'), row(3, 'brunch', '10:00'), // not one of the meals
      row(4, 'dinner', 'noon', { createdAt: null }), row(5, 'dinner', null, { createdAt: null }), { meal: 'dinner' }, null, 'x',
    ]
    assert.deepEqual(learnMealTimes(entries, { today: TODAY, meals }), {})
  })

  test('rows without createdAt still count; custom meals are learned', () => {
    const entries = [1, 2, 3].map((n) => row(n, 'pre', '17:30', { createdAt: null }))
    assert.equal(learnMealTimes(entries, { today: TODAY, meals }).pre.at, '17:30')
  })

  test('a late snack after midnight sits with the evening, not the morning', () => {
    const entries = [row(1, 'snack', '23:40'), row(2, 'snack', '00:20'), row(3, 'snack', '23:50')]
    const learned = learnMealTimes(entries, { today: TODAY, meals })
    assert.equal(learned.snack.at, '23:50')
    assert.ok(learned.snack.spread <= 30)
  })
})

describe('mealForNow', () => {
  const late = { breakfast: { at: '11:30', minutes: 690 }, lunch: { at: '15:00', minutes: 900 }, dinner: { at: '21:00', minutes: 1260 } }

  test('no learned data: the fixed windows', () => {
    for (const [time, meal] of Object.entries({ '07:00': 'breakfast', '11:45': 'lunch', '17:00': 'dinner', '23:00': 'snack' })) {
      assert.equal(mealForNow(time, {}), meal, time)
      assert.equal(mealForNow(time, null), meal, time)
    }
    assert.equal(mealForNow('nonsense', late), 'snack')
  })

  test('breakfast logged around 11:30 stays Breakfast at 11:45', () => {
    assert.equal(mealForNow('11:45', late), 'breakfast')
    assert.equal(mealForNow(11 * 60 + 45, late), 'breakfast')
    assert.equal(mealForNow('14:00', late), 'lunch') // nearer the learned lunch
    assert.equal(mealForNow('16:30', late), 'lunch') // fixed says dinner, but lunch is learned nearer
    assert.equal(mealForNow('19:30', late), 'dinner')
  })

  test('only one meal learned: it claims just the hour around it from unlearned meals', () => {
    const one = { breakfast: { at: '11:30', minutes: 690 } }
    assert.equal(mealForNow('12:15', one), 'breakfast')
    assert.equal(mealForNow('13:00', one), 'lunch') // 90 min away and lunch has no learned time
    assert.equal(mealForNow('08:00', one), 'breakfast')
  })

  test('custom meals take their usual time; far from every learned time = fixed window', () => {
    const learned = { pre: { at: '17:30', minutes: 1050 }, dinner: { at: '20:00', minutes: 1200 } }
    assert.equal(mealForNow('17:40', learned), 'pre')
    assert.equal(mealForNow('19:00', learned), 'dinner')
    assert.equal(mealForNow('03:00', learned), 'snack')
    assert.equal(mealForNow('09:00', learned), 'breakfast')
  })

  test('explicit fallback', () => {
    assert.equal(mealForNow('03:00', {}, 'lunch'), 'lunch')
  })
})

describe('nowMeal and mealClock', () => {
  test('nowMeal maps to one of the meals', () => {
    assert.equal(nowMeal(meals, { pre: { at: '17:30', minutes: 1050 } }, '17:35'), 'pre')
    assert.equal(nowMeal(MEALS_DEFAULT, { pre: { at: '17:30', minutes: 1050 } }, '17:35'), 'snack') // meal no longer exists
    assert.equal(nowMeal(MEALS_DEFAULT, {}, '07:30'), 'breakfast')
  })

  test('mealClock: learned, then fixed, then null', () => {
    assert.equal(mealClock('breakfast', { breakfast: { at: '11:30', minutes: 690 } }), '11:30')
    assert.equal(mealClock('lunch', {}), FIXED_MEAL_TIMES.lunch)
    assert.equal(mealClock('pre', undefined), null)
  })

  test('learnedMealTimes caches per list, day and meals', () => {
    const entries = [1, 2, 3].map((n) => row(n, 'lunch', '13:30'))
    const a = learnedMealTimes(entries, meals, TODAY)
    assert.equal(a.lunch.at, '13:30')
    assert.equal(learnedMealTimes(entries, meals, TODAY), a)
    assert.notEqual(learnedMealTimes(entries, meals, addDaysISO(TODAY, 1)), a)
    assert.deepEqual(learnedMealTimes(null, meals, TODAY), {})
  })
})

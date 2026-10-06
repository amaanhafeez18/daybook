// Run: node --test tests/food-shortcuts.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MEALS_DEFAULT } from '../src/lib/food/nutrition.js'
import { addedSummary, lastMealDay, mealChips } from '../src/lib/food/shortcuts.js'
import { activityForWorkouts, planWorkoutsPerWeek } from '../src/lib/food/activity.js'
import { pastDayName, shortDay } from '../src/pages/food/format.js'

const meals = MEALS_DEFAULT
const TODAY = '2026-10-06'
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

let uid = 0
const entry = (date, name, calories, meal, extra = {}) => ({ id: `f${++uid}`, date, name, calories, meal, time: '08:00', createdAt: `${date}T08:00:00.000Z`, ...extra })

describe('mealChips', () => {
  const entries = [
    entry(addDays(TODAY, -1), 'Oatmeal', 152, 'breakfast'),
    entry(addDays(TODAY, -2), 'Oatmeal', 152, 'breakfast'),
    entry(addDays(TODAY, -3), 'Eggs', 140, 'breakfast'),
    entry(addDays(TODAY, -1), 'Coffee', 5, 'breakfast'),
    entry(addDays(TODAY, -4), 'Toast', 90, 'breakfast'),
    entry(addDays(TODAY, -1), 'Pasta', 600, 'dinner', { time: '19:00' }),
  ]

  test('foods logged in this meal before, best first, at most `limit`', () => {
    const chips = mealChips(entries, 'breakfast', { hhmm: '08:00', today: TODAY, meals })
    assert.equal(chips.length, 3)
    assert.equal(chips[0].name, 'Oatmeal')
    assert.ok(chips.every((item) => item.name !== 'Pasta'), 'never a food only logged in another meal')
    assert.equal(mealChips(entries, 'breakfast', { hhmm: '08:00', today: TODAY, meals, limit: 1 }).length, 1)
  })

  test('leaves out foods already in the meal that day', () => {
    const withToday = [...entries, entry(TODAY, 'Oatmeal', 152, 'breakfast')]
    const chips = mealChips(withToday, 'breakfast', { hhmm: '08:00', today: TODAY, meals })
    assert.ok(chips.every((item) => item.name !== 'Oatmeal'))
    assert.ok(chips.length > 0)
  })

  test('nothing for a meal never logged; tolerant of junk', () => {
    assert.deepEqual(mealChips(entries, 'snack', { hhmm: '15:30', today: TODAY, meals }), [])
    assert.deepEqual(mealChips(null, 'breakfast', { today: TODAY, meals }), [])
    assert.deepEqual(mealChips([null, 3, 'x'], 'breakfast', { today: TODAY, meals }), [])
  })
})

describe('lastMealDay', () => {
  test('the latest earlier day with the meal logged, within 14 days', () => {
    const entries = [
      entry(addDays(TODAY, -3), 'Rice', 300, 'lunch'),
      entry(addDays(TODAY, -3), 'Chicken', 250, 'lunch'),
      entry(addDays(TODAY, -5), 'Salad', 120, 'lunch'),
      entry(addDays(TODAY, -1), 'Pasta', 600, 'dinner'),
      entry(TODAY, 'Soup', 200, 'lunch'),
    ]
    const found = lastMealDay(entries, 'lunch', TODAY, meals)
    assert.equal(found.date, addDays(TODAY, -3))
    assert.deepEqual(found.rows.map((row) => row.name).sort(), ['Chicken', 'Rice'])
    assert.equal(found.kcal, 550)
  })

  test('null past the window, for an empty meal or a bad date', () => {
    const old = [entry(addDays(TODAY, -15), 'Rice', 300, 'lunch')]
    assert.equal(lastMealDay(old, 'lunch', TODAY, meals), null)
    assert.equal(lastMealDay(old, 'lunch', TODAY, meals, { days: 20 }).date, addDays(TODAY, -15))
    assert.equal(lastMealDay([], 'lunch', TODAY, meals), null)
    assert.equal(lastMealDay(old, 'lunch', 'not a date', meals), null)
  })

  test('relative to the day shown, not today', () => {
    const entries = [entry('2026-09-20', 'Rice', 300, 'lunch'), entry('2026-09-28', 'Soup', 200, 'lunch')]
    assert.equal(lastMealDay(entries, 'lunch', '2026-09-25', meals).date, '2026-09-20')
  })
})

describe('pastDayName', () => {
  test('yesterday, a weekday within the week, else a short date', () => {
    assert.equal(pastDayName(TODAY, TODAY), 'today')
    assert.equal(pastDayName(addDays(TODAY, -1), TODAY), 'yesterday')
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 9, 3))
    assert.equal(pastDayName('2026-10-03', TODAY), weekday)
    assert.equal(pastDayName('2026-09-23', TODAY), shortDay('2026-09-23'))
    assert.match(pastDayName('2026-09-23', TODAY), /\d/)
  })
})

describe('addedSummary', () => {
  test('count, calories, and the meal / date when they are all the same', () => {
    assert.deepEqual(addedSummary([
      { kcal: 152, meal: 'breakfast', date: TODAY },
      { kcal: 270, meal: 'breakfast', date: TODAY },
    ]), { count: 2, kcal: 422, meal: 'breakfast', date: TODAY })
    assert.deepEqual(addedSummary([
      { kcal: 100, meal: 'breakfast', date: TODAY },
      { kcal: null, meal: 'snack', date: TODAY },
    ]), { count: 2, kcal: 100, meal: null, date: TODAY })
    assert.deepEqual(addedSummary([]), { count: 0, kcal: 0, meal: null, date: null })
    assert.deepEqual(addedSummary(undefined), { count: 0, kcal: 0, meal: null, date: null })
  })
})

describe('gym plan → activity', () => {
  const routine = (id) => ({ kind: 'routine', routineId: id })
  const rest = { kind: 'rest' }

  test('weekly plans count their workout days', () => {
    const schedule = { versions: [{ effectiveFrom: '2026-09-01', mode: 'weekly', weekly: [rest, routine('a'), routine('b'), rest, routine('a'), routine('b'), rest] }] }
    assert.equal(planWorkoutsPerWeek(schedule, TODAY), 4)
  })

  test('rotations scale workouts per cycle to a week', () => {
    // Push, pull, legs, rest: 3 workouts every 4 days ≈ 5 a week.
    const ppl = { versions: [{ effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [routine('p'), routine('q'), routine('l'), rest] }] }
    assert.equal(planWorkoutsPerWeek(ppl, TODAY), 5)
    const easy = { versions: [{ effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [routine('a'), rest, rest, rest, rest, rest, rest] }] }
    assert.equal(planWorkoutsPerWeek(easy, TODAY), 1)
  })

  test('the version in force; a plan that starts later still counts', () => {
    const schedule = {
      versions: [
        { effectiveFrom: '2026-09-01', mode: 'weekly', weekly: [rest, routine('a'), rest, rest, rest, rest, rest] },
        { effectiveFrom: '2026-10-01', mode: 'weekly', weekly: [routine('a'), routine('a'), routine('a'), routine('a'), routine('a'), routine('a'), rest] },
      ],
    }
    assert.equal(planWorkoutsPerWeek(schedule, '2026-09-15'), 1)
    assert.equal(planWorkoutsPerWeek(schedule, TODAY), 6)
    assert.equal(planWorkoutsPerWeek(schedule, '2026-08-01'), 1)
  })

  test('no plan → null', () => {
    assert.equal(planWorkoutsPerWeek(null, TODAY), null)
    assert.equal(planWorkoutsPerWeek({ versions: [] }, TODAY), null)
    assert.equal(planWorkoutsPerWeek({ versions: [{ effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [] }] }, TODAY), null)
  })

  test('0–1 light, 2–4 moderate, 5+ very active', () => {
    assert.equal(activityForWorkouts(0), 'light')
    assert.equal(activityForWorkouts(1), 'light')
    assert.equal(activityForWorkouts(2), 'moderate')
    assert.equal(activityForWorkouts(4), 'moderate')
    assert.equal(activityForWorkouts(5), 'active')
    assert.equal(activityForWorkouts(7), 'active')
    assert.equal(activityForWorkouts(null), null)
    assert.equal(activityForWorkouts(Number.NaN), null)
    assert.equal(activityForWorkouts(-1), null)
  })
})

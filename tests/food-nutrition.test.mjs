// Run: node --test tests/food-nutrition.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_LEVELS, KCAL_PER_G, KJ_PER_KCAL, MEALS_DEFAULT, amountText, calcBmr, calcGoals, clampEstimateItem, cleanEntry, dayTotals, energyToKcal, entryCalories, entryMeal, entryTemplate, findFavorite, foodKey, formatEnergy, frequent, logStreak, macroCalories, mealForTime, mealTotals, normalizeFood, recents, remaining, scaleEntry, sortDayEntries, suggestions, unitFor, weeklyInsights, weightSeries, weightTrend, matchSavedFoods,
} from '../src/lib/food/nutrition.js'

const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`)
}

// ISO date n days after iso (UTC arithmetic, fine for tests).
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

let uid = 0
const entry = (date, name, calories, extra = {}) => ({ id: `f${++uid}`, date, name, calories, createdAt: `${date}T12:00:00.000Z`, ...extra })
const weight = (date, kg, extra = {}) => ({ id: `w${++uid}`, date, kg, createdAt: `${date}T07:00:00.000Z`, ...extra })

// ---- meals & energy ------------------------------------------------------------------------------

describe('meals and energy', () => {
  test('constants', () => {
    assert.deepEqual(MEALS_DEFAULT.map((meal) => meal.id), ['breakfast', 'lunch', 'dinner', 'snack'])
    assert.deepEqual({ ...KCAL_PER_G }, { protein: 4, carbs: 4, fat: 9, alcohol: 7, fiber: 2 })
    assert.equal(KJ_PER_KCAL, 4.184)
    assert.equal(ACTIVITY_LEVELS.find((level) => level.id === 'moderate').factor, 1.55)
  })

  test('mealForTime boundaries', () => {
    const cases = {
      '00:30': 'snack', '03:59': 'snack', '04:00': 'breakfast', '10:59': 'breakfast', '11:00': 'lunch', '15:59': 'lunch',
      '16:00': 'dinner', '21:59': 'dinner', '22:00': 'snack', '23:59': 'snack', '7:30': 'breakfast', '2:30 PM': 'lunch', '12:15 AM': 'snack',
    }
    for (const [time, meal] of Object.entries(cases)) assert.equal(mealForTime(time), meal, time)
    for (const bad of [null, undefined, '', '25:00', '12:60', 'noon', 1230, {}]) assert.equal(mealForTime(bad), 'snack')
  })

  test('macroCalories: 4P + 4(C − fiber) + 2·fiber + 9F + 7·alcohol', () => {
    assert.equal(macroCalories({ proteinG: 10, carbsG: 20, fatG: 5 }), 40 + 80 + 45)
    assert.equal(macroCalories({ proteinG: 10, carbsG: 20, fatG: 5, fiberG: 5 }), 40 + 60 + 10 + 45)
    assert.equal(macroCalories({ extra: { alcoholG: 14 } }), 98)
    assert.equal(macroCalories({ proteinG: 10, carbsG: 20, fatG: 5, fiberG: 5, extra: { alcoholG: 14 } }), 155 + 98)
    assert.equal(macroCalories({ carbsG: 4, fiberG: 10 }), 8) // fiber can't exceed carbs
    assert.equal(macroCalories({ fiberG: 10 }), null) // fiber alone isn't a macro
    assert.equal(macroCalories({ proteinG: '25' }), 100)
    assert.equal(macroCalories({ proteinG: -5, fatG: 1 }), 9)
    assert.equal(macroCalories({ name: 'tea' }), null)
    assert.equal(macroCalories(null), null)
    assert.equal(macroCalories('x'), null)
  })

  test('entryCalories: calories, else macros, else 0', () => {
    assert.equal(entryCalories({ calories: 120, proteinG: 100 }), 120)
    assert.equal(entryCalories({ calories: null, proteinG: 10 }), 40)
    assert.equal(entryCalories({ calories: '250' }), 250)
    assert.equal(entryCalories({ calories: 0 }), 0)
    assert.equal(entryCalories({ calories: -20 }), 0)
    assert.equal(entryCalories({ name: 'tea' }), 0)
    assert.equal(entryCalories(null), 0)
    assert.equal(entryCalories([1, 2]), 0)
  })

  test('dayTotals is null-safe', () => {
    const totals = dayTotals([
      { calories: 100, proteinG: 5, sodiumMg: 120.4 },
      { name: 'tea' },
      { proteinG: 10, carbsG: null, fatG: 2 },
      { calories: 50.25, fiberG: 3, sugarG: 'x' },
      null,
      'nope',
    ])
    assert.equal(totals.calories, 100 + 0 + 58 + 50.3)
    assert.equal(totals.proteinG, 15)
    assert.equal(totals.fatG, 2)
    assert.equal(totals.fiberG, 3)
    assert.equal(totals.sugarG, 0)
    assert.equal(totals.sodiumMg, 120)
    assert.equal(totals.count, 4)
    assert.equal(totals.counted, 3)
    assert.deepEqual(dayTotals(undefined), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0, count: 0, counted: 0 })
  })

  test('mealTotals groups in meal order; unknown meals go to Snacks', () => {
    const rows = [
      { id: 'a', meal: 'dinner', time: '19:00', calories: 600 },
      { id: 'b', meal: 'breakfast', time: '08:30', calories: 300 },
      { id: 'c', meal: 'breakfast', time: '07:15', calories: 100 },
      { id: 'd', meal: 'brunch', calories: 50 },
      { id: 'e', meal: 'breakfast', calories: 20 },
    ]
    const groups = mealTotals(rows)
    assert.deepEqual(groups.map((g) => g.meal.id), ['breakfast', 'lunch', 'dinner', 'snack'])
    assert.deepEqual(groups[0].entries.map((row) => row.id), ['c', 'b', 'e']) // by time, untimed last
    assert.equal(groups[0].totals.calories, 420)
    assert.equal(groups[1].entries.length, 0)
    assert.deepEqual(groups[3].entries.map((row) => row.id), ['d'])
    // Custom meals without Snacks: unknown meals go to the last one.
    const custom = [{ id: 'morning', name: 'Morning' }, { id: 'evening' }]
    const byCustom = mealTotals(rows, custom)
    assert.deepEqual(byCustom.map((g) => g.meal.id), ['morning', 'evening'])
    assert.equal(byCustom[1].meal.name, 'evening')
    assert.equal(byCustom[1].entries.length, 5)
    assert.equal(entryMeal({ meal: 'dinner' }, custom), 'evening')
    assert.deepEqual(sortDayEntries(rows).map((row) => row.id), ['c', 'b', 'e', 'a', 'd'])
  })

  test('scaleEntry scales the portion and every nutrient', () => {
    const egg = { name: 'Egg', amount: 1, unit: 'large', grams: 50, calories: 72, proteinG: 6.3, fatG: 4.8, carbsG: null, sodiumMg: 71, extra: { caffeineMg: 0, satFatG: 1.6 }, options: [{ label: 'Fried', calories: 90, proteinG: 6.3 }] }
    const two = scaleEntry(egg, 2)
    assert.equal(two.amount, 2)
    assert.equal(two.grams, 100)
    assert.equal(two.calories, 144)
    assert.equal(two.proteinG, 12.6)
    assert.equal(two.fatG, 9.6)
    assert.equal(two.carbsG, null)
    assert.equal(two.sodiumMg, 142)
    assert.deepEqual(two.extra, { caffeineMg: 0, satFatG: 3.2 })
    assert.equal(two.options[0].calories, 180)
    assert.equal(two.name, 'Egg')
    assert.equal(egg.calories, 72) // not mutated
    assert.equal(scaleEntry(egg, 1.5).amount, 1.5)
    assert.deepEqual(scaleEntry(egg, -1), egg)
    assert.deepEqual(scaleEntry(egg, 'x'), egg)
    assert.equal(scaleEntry(null, 2), null)
  })

  test('remaining: goal minus eaten, null without a goal', () => {
    const left = remaining({ calories: 2000, protein: 150, carbs: null }, { calories: 1240.4, proteinG: 62, carbsG: 90 })
    assert.deepEqual(left, { calories: 760, proteinG: 88, carbsG: null, fatG: null, fiberG: null })
    assert.equal(remaining({ calories: 2000 }, { calories: 2300 }).calories, -300)
    assert.deepEqual(remaining(null, null), { calories: null, proteinG: null, carbsG: null, fatG: null, fiberG: null })
  })

  test('formatEnergy and unit conversion', () => {
    assert.equal(formatEnergy(1240), '1,240 kcal')
    assert.equal(formatEnergy(1240, 'kJ'), '5,188 kJ')
    assert.equal(formatEnergy(999.6, 'kcal'), '1,000 kcal')
    assert.equal(formatEnergy(12, 'kcal'), '12 kcal')
    assert.equal(formatEnergy(1234567), '1,234,567 kcal')
    assert.equal(formatEnergy(-160), '−160 kcal')
    assert.equal(formatEnergy(-0.2), '0 kcal')
    assert.equal(formatEnergy(null), '—')
    assert.equal(formatEnergy('abc', 'kJ'), '—')
    assert.equal(energyToKcal(4184, 'kJ'), 1000)
    assert.equal(energyToKcal(500, 'kcal'), 500)
  })
})

// ---- goal calculator -----------------------------------------------------------------------------

describe('goal calculator', () => {
  const today = '2026-09-23'
  const male = { sex: 'male', birthYear: 1996, heightCm: 180, activity: 'moderate', goal: 'lose', rateKgPerWeek: 0.5 }

  test('worked example: male 30, 180 cm, 80 kg, moderate, lose 0.5 kg/week', () => {
    assert.equal(calcBmr({ sex: 'male', age: 30, heightCm: 180, weightKg: 80 }), 1780)
    const goals = calcGoals(male, { weightKg: 80, today })
    assert.equal(goals.bmr, 1780)
    assert.equal(goals.tdee, 2759)
    assert.equal(goals.calories, 2210)
    assert.equal(goals.protein, 160)
    assert.equal(goals.fat, 74)
    assert.equal(goals.carbs, 226)
    assert.equal(goals.fiber, 31)
    assert.equal(goals.floorApplied, false)
    assert.equal(goals.pace, -0.5)
    assert.equal(goals.method, 'mifflin')
    assert.equal(goals.source, 'calculator')
    assert.equal(goals.age, 30)
    assert.deepEqual(goals.warnings, [])
  })

  test('floor example: female 28, 165 cm, 62 kg, light, lose 0.75 kg/week', () => {
    const goals = calcGoals({ sex: 'female', birthYear: 1998, heightCm: 165, activity: 'light', goal: 'lose', rateKgPerWeek: 0.75 }, { weightKg: 62, today })
    assert.equal(goals.bmr, 1350)
    assert.equal(goals.tdee, 1857)
    assert.equal(goals.rateKgPerWeek, 0.62) // capped at 1 % of body weight
    assert.equal(goals.calories, 1200)
    assert.equal(goals.floorApplied, true)
    assert.equal(goals.pace, -0.6)
    assert.ok(goals.warnings.some((w) => /capped at 0\.62 kg\/week/i.test(w)), goals.warnings.join(' | '))
    assert.ok(goals.warnings.includes('Capped at 1,200 kcal. Expected pace ≈ 0.6 kg/week.'), goals.warnings.join(' | '))
    assert.ok(goals.warnings.some((w) => /below your BMR/.test(w)))
    assert.equal(goals.protein, 105) // 2.0 g/kg = 124 g, capped at 35 % of kcal
    assert.equal(goals.fat, 40)
    assert.equal(goals.carbs, 105)
    assert.equal(goals.fiber, 17)
  })

  test('Katch–McArdle with body fat', () => {
    assert.equal(calcBmr({ weightKg: 80, bodyFatPct: 20 }), 1752)
    assert.equal(calcBmr({ weightKg: 80, bodyFatPct: 0.2 }), 1752)
    const goals = calcGoals({ activity: 'moderate', goal: 'maintain', bodyFatPct: 20 }, { weightKg: 80, today })
    assert.equal(goals.method, 'katch')
    assert.equal(goals.bmr, 1752)
    assert.equal(goals.tdee, 2716)
    assert.equal(goals.calories, 2720)
    assert.equal(goals.protein, 128) // maintain: 1.6 g/kg
  })

  test('unspecified sex uses −78 and a 1350 kcal floor', () => {
    assert.equal(calcBmr({ age: 30, heightCm: 180, weightKg: 80 }), 1780 - 5 - 78)
    const goals = calcGoals({ birthYear: 1996, heightCm: 150, activity: 'sedentary', goal: 'lose', rateKgPerWeek: 0.5 }, { weightKg: 50, today })
    assert.equal(goals.calories, 1350)
    assert.equal(goals.floorApplied, true)
  })

  test('gain: rate capped at 0.5 % of body weight; default 0.25 kg/week', () => {
    const capped = calcGoals({ ...male, goal: 'gain', rateKgPerWeek: 0.5 }, { weightKg: 80, today })
    assert.equal(capped.rateKgPerWeek, 0.4)
    assert.equal(capped.calories, 3200) // 2759 + 440
    assert.ok(capped.warnings.some((w) => /0\.5% of your body weight/.test(w)))
    assert.equal(capped.protein, 144) // 1.8 g/kg
    const fallback = calcGoals({ ...male, goal: 'gain', rateKgPerWeek: undefined }, { weightKg: 80, today })
    assert.equal(fallback.rateKgPerWeek, 0.25)
    assert.equal(fallback.calories, 3030)
  })

  test('loss is blocked under 18, at BMI < 18.5 and for a goal weight under BMI 18.5', () => {
    const teen = calcGoals({ ...male, birthYear: 2010 }, { weightKg: 80, today })
    assert.equal(teen.blocked, true)
    assert.equal(teen.goal, 'maintain')
    assert.equal(teen.calories, Math.round(teen.tdee / 10) * 10)
    assert.ok(teen.warnings.some((w) => /under-18s/.test(w) && /doctor or dietitian/.test(w)))
    const thin = calcGoals(male, { weightKg: 58, today })
    assert.equal(thin.blocked, true)
    assert.equal(thin.goal, 'maintain')
    assert.equal(thin.bmi, 17.9)
    const lowTarget = calcGoals({ ...male, targetKg: 58 }, { weightKg: 70, today })
    assert.equal(lowTarget.blocked, true)
    assert.equal(lowTarget.goal, 'maintain')
    const fine = calcGoals({ ...male, targetKg: 72 }, { weightKg: 80, today })
    assert.equal(fine.blocked, false)
    assert.equal(fine.goal, 'lose')
    close(fine.etaWeeks, 16) // 8 kg at 0.5 kg/week
  })

  test('carbs under 50 g lower fat to 20 %', () => {
    // Very tall and heavy: the 0.6 g/kg fat minimum would leave almost no carbs at the 1500 floor.
    const goals = calcGoals({ sex: 'male', birthYear: 1990, heightCm: 250, activity: 'sedentary', goal: 'lose', rateKgPerWeek: 1, bodyFatPct: 60 }, { weightKg: 170, today })
    assert.equal(goals.calories, 1500)
    assert.equal(goals.protein, 131)
    assert.equal(goals.fat, 33)
    assert.equal(goals.carbs, 170)
  })

  test('missing inputs and malformed calls', () => {
    const empty = calcGoals({}, {})
    assert.equal(empty.calories, null)
    assert.deepEqual(empty.missing, ['weight', 'height', 'birth year'])
    assert.deepEqual(empty.warnings, ['Add your weight, height and birth year to calculate a goal.'])
    assert.equal(calcGoals(null, null).calories, null)
    assert.equal(calcGoals('x', 5).calories, null)
    assert.equal(calcBmr(null), null)
    assert.equal(calcBmr({ weightKg: 80 }), null)
    const weird = calcGoals({ sex: 'x', birthYear: 'abc', heightCm: '180', activity: 'toString', goal: 'bulk' }, { weightKg: '80', today: 'bad' })
    assert.deepEqual(weird.missing, ['birth year'])
  })
})

// ---- recents, frequent, suggestions --------------------------------------------------------------

describe('recents and suggestions', () => {
  const today = '2026-09-23'
  const rows = [
    entry('2026-09-20', 'Oats', 300, { time: '08:00', meal: 'breakfast', amount: 1, unit: 'bowl' }),
    entry('2026-09-22', 'Oats', 350, { time: '08:10', meal: 'breakfast', amount: 1.2, unit: 'bowl' }),
    entry('2026-09-21', ' oats. ', 300, { time: '07:50', meal: 'breakfast' }),
    entry('2026-09-22', 'Chicken wrap', 520, { time: '13:00', meal: 'lunch' }),
    entry('2026-09-23', 'Tea', null, { time: '09:00', meal: 'breakfast' }),
    entry('2026-09-23', '', 400, { time: '10:00', meal: 'snack' }), // unnamed: skipped
    entry('2026-05-01', 'Pizza', 800, { meal: 'dinner' }), // older than 90 days
    entry('2026-09-30', 'Cake', 400, { meal: 'snack' }), // future
    null,
  ]

  test('foodKey normalises name and brand', () => {
    assert.equal(foodKey('  Oats. ', 'Quaker '), 'oats|quaker')
    assert.equal(foodKey('Green   TEA!!', null), 'green tea|')
    assert.equal(foodKey({ name: 'Tea', brand: 'Twinings' }), 'tea|twinings')
    assert.equal(foodKey('', 'Brand'), '')
    assert.equal(foodKey(null), '')
  })

  test('recents: newest template per food, most recent first', () => {
    const items = recents(rows, today)
    assert.deepEqual(items.map((item) => item.name), ['Tea', 'Chicken wrap', 'Oats'])
    const oats = items[2]
    assert.equal(oats.key, 'oats|')
    assert.equal(oats.calories, 350)
    assert.equal(oats.amount, 1.2)
    assert.equal(oats.unit, 'bowl')
    assert.equal(oats.count, 3)
    assert.equal(oats.lastDate, '2026-09-22')
    assert.equal(oats.id, undefined)
    assert.equal(oats.date, undefined)
    assert.deepEqual(recents(rows, today, { limit: 1 }).map((item) => item.name), ['Tea'])
    assert.deepEqual(recents(rows, today, { days: 2 }).map((item) => item.name), ['Tea', 'Chicken wrap', 'Oats'])
    assert.deepEqual(recents(rows, today, { days: 1 }).map((item) => item.name), ['Tea'])
    assert.deepEqual(recents(null, today), [])
  })

  test('frequent: logged at least 3 times in 30 days', () => {
    assert.deepEqual(frequent(rows, today).map((item) => [item.name, item.count]), [['Oats', 3]])
    assert.deepEqual(frequent(rows, today, { min: 1 }).map((item) => item.name), ['Oats', 'Tea', 'Chicken wrap'])
  })

  test('suggestions: recency × meal match × time of day', () => {
    const lunch = suggestions(rows, 'lunch', '12:30', today)
    assert.deepEqual(lunch.map((item) => item.name), ['Chicken wrap', 'Oats', 'Tea'])
    close(lunch[0].score, Math.exp(-1 / 14) * 1.5, 1e-3)
    close(lunch[1].score, 0.3 * (Math.exp(-3 / 14) + Math.exp(-2 / 14) + Math.exp(-1 / 14)), 1e-3)
    close(lunch[2].score, 0.3, 1e-3)
    const breakfast = suggestions(rows, 'breakfast', '08:00', today)
    assert.deepEqual(breakfast.map((item) => item.name), ['Oats', 'Tea', 'Chicken wrap'])
    assert.equal(suggestions(rows, 'breakfast', '08:00', today, 1).length, 1)
    // No meal given: the meal for the time is used.
    assert.deepEqual(suggestions(rows, null, '12:30', today).map((item) => item.name), ['Chicken wrap', 'Oats', 'Tea'])
    // The 2-hour window wraps around midnight.
    const night = [entry('2026-09-22', 'Toast', 100, { time: '00:30', meal: 'snack' }), entry('2026-09-22', 'Milk', 100, { time: '05:00', meal: 'snack' })]
    assert.deepEqual(suggestions(night, 'snack', '23:45', today).map((item) => item.name), ['Toast', 'Milk'])
  })

  test('entryTemplate, cleanEntry and findFavorite', () => {
    const raw = { id: 'x', date: '2026-09-23', time: '7:05', meal: 'breakfast', name: '  Egg ', calories: '72', proteinG: -1, extra: { caffeineMg: 'bad', alcoholG: 2 }, source: 'weird', ai: { query: 'egg', confidence: 2, assumptions: ['a', 'a', 'b'] }, junk: 1 }
    const clean = cleanEntry(raw)
    assert.equal(clean.time, '07:05')
    assert.equal(clean.name, 'Egg')
    assert.equal(clean.calories, 72)
    assert.equal(clean.proteinG, 0)
    assert.deepEqual(clean.extra, { alcoholG: 2 })
    assert.equal(clean.source, 'manual')
    assert.deepEqual(clean.ai, { query: 'egg', confidence: 1, assumptions: ['a', 'b'] })
    assert.equal('junk' in clean, false)
    assert.deepEqual(cleanEntry({ date: '2026-02-30', time: '25:00' }).date, null)
    const template = entryTemplate(raw)
    assert.equal(template.name, 'Egg')
    assert.equal('date' in template || 'id' in template || 'meal' in template, false)
    const favorites = [{ id: 'f1', name: 'Egg', brand: null }, { id: 'f2', name: 'Tea' }]
    assert.equal(findFavorite(favorites, { name: 'egg.' }).id, 'f1')
    assert.equal(findFavorite(favorites, { name: 'Other', favoriteId: 'f2' }).id, 'f2')
    assert.equal(findFavorite(favorites, { name: 'Other' }), null)
    assert.equal(findFavorite(null, null), null)
  })
})

// ---- weight --------------------------------------------------------------------------------------

describe('weight series and trend', () => {
  test('weightSeries interpolates between weigh-ins and never extrapolates', () => {
    const series = weightSeries([weight('2026-09-01', 80), weight('2026-09-05', 78)], '2026-08-30', '2026-09-07')
    assert.deepEqual(series.map((p) => p.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'])
    assert.deepEqual(series.map((p) => p.kg), [80, 79.5, 79, 78.5, 78])
    assert.deepEqual(series.map((p) => p.real), [true, false, false, false, true])
    assert.deepEqual(weightSeries([weight('2026-09-01', 80), weight('2026-09-05', 78)], '2026-09-03', '2026-09-04').map((p) => p.kg), [79, 78.5])
  })

  test('weightSeries tolerates odd rows; the latest entry of a day wins', () => {
    const series = weightSeries([
      weight('2026-09-01', '80'),
      weight('2026-09-02', 79, { createdAt: '2026-09-02T07:00:00Z' }),
      weight('2026-09-02', 78, { createdAt: '2026-09-02T09:00:00Z' }),
      weight('2026-09-03', -1),
      weight('bad', 70),
      { date: '2026-09-04' },
      null,
    ])
    assert.deepEqual(series.map((p) => [p.date, p.kg]), [['2026-09-01', 80], ['2026-09-02', 78]])
    assert.deepEqual(weightSeries(null), [])
    assert.deepEqual(weightSeries('x', 'a', 'b'), [])
  })

  test('weightTrend: 7-day mean, weekly change, 28-day pace and ETA', () => {
    const start = '2026-08-17'
    const rows = Array.from({ length: 35 }, (_, i) => weight(addDays(start, i), 80 - 0.1 * i))
    const trend = weightTrend(rows, '2026-09-21', { targetKg: 75 })
    close(trend.trendKg, 76.9, 1e-9)
    close(trend.weeklyChangeKg, -0.7, 1e-9)
    close(trend.paceKgPerWeek, -0.7, 1e-9)
    assert.equal(trend.latestKg, 76.6)
    assert.equal(trend.latestDate, '2026-09-20')
    assert.equal(trend.weighIns28, 27)
    assert.equal(trend.reliable, true)
    assert.equal(trend.etaWeeks, 2.7)
    assert.equal(trend.etaDate, '2026-10-10')
    assert.equal(trend.points.length, 35)
    assert.deepEqual(trend.points[0], { date: start, kg: 80, trend: null, real: true })
    assert.equal(trend.points[1].trend, 79.95)
    // Heading away from the goal: no ETA.
    assert.equal(weightTrend(rows, '2026-09-21', { targetKg: 85 }).etaWeeks, null)
    // Weigh-ins after today are ignored.
    assert.equal(weightTrend(rows, '2026-09-10').latestDate, '2026-09-10')
  })

  test('weightTrend with sparse or no weigh-ins', () => {
    const weekly = [weight('2026-09-01', 80), weight('2026-09-08', 79.5), weight('2026-09-15', 79)]
    const trend = weightTrend(weekly, '2026-09-16')
    assert.equal(trend.trendKg, null) // a 7-day window never holds 2 weigh-ins
    assert.equal(trend.latestKg, 79)
    assert.equal(trend.reliable, false)
    assert.equal(trend.points.length, 15)
    assert.ok(trend.points.every((p) => p.trend === null))
    assert.equal(trend.points[1].kg, null) // interpolated days carry no raw weigh-in
    const none = weightTrend([], '2026-09-16')
    assert.equal(none.trendKg, null)
    assert.deepEqual(none.points, [])
    assert.equal(weightTrend(null, null).latestKg, null)
  })
})

// ---- streak & weekly insights -------------------------------------------------------------------

describe('streak and weekly insights', () => {
  const macro = (proteinG, carbsG, fatG) => ({ proteinG, carbsG, fatG })
  // Week of Mon 2026-09-14; "today" is Sun 2026-09-20, which stays out of the averages.
  const rows = [
    entry('2026-09-14', 'Oats', 500, macro(20, 80, 10)),
    entry('2026-09-14', 'Chicken', 1400, macro(130, 100, 50)),
    entry('2026-09-15', 'Oats', 500, macro(20, 80, 10)),
    entry('2026-09-15', 'Pizza', 1800),
    entry('2026-09-16', 'Salad', 800, macro(40, 60, 40)),
    entry('2026-09-17', 'Tea', null),
    entry('2026-09-19', 'Oats', 500, macro(20, 80, 10)),
    entry('2026-09-19', 'Steak', 1550, macro(120, 0, 100)),
    entry('2026-09-20', 'Burger', 900),
    entry('2026-09-10', 'Oats', 2000, { proteinG: 100 }), // last week
  ]
  const weights = Array.from({ length: 20 }, (_, i) => weight(addDays('2026-09-01', i), 80 - 0.1 * i))
  const goals = { calories: 2000, protein: 150, fiber: 30 }

  test('logStreak counts back from today and is never broken mid-day', () => {
    assert.deepEqual(logStreak(rows, '2026-09-20'), { current: 2, longest: 4 })
    assert.deepEqual(logStreak(rows, '2026-09-21'), { current: 2, longest: 4 }) // today still empty
    assert.deepEqual(logStreak(rows, '2026-09-22'), { current: 0, longest: 4 })
    assert.deepEqual(logStreak(rows, '2026-09-17'), { current: 4, longest: 4 }) // later days ignored
    assert.deepEqual(logStreak(null, '2026-09-17'), { current: 0, longest: 0 })
  })

  test('calories, targets and budget over the logged days', () => {
    const week = weeklyInsights(rows, weights, goals, '2026-09-14', '2026-09-20')
    assert.equal(week.weekStart, '2026-09-14')
    assert.equal(week.weekEnd, '2026-09-20')
    assert.equal(week.complete, false)
    assert.equal(week.elapsedDays, 6)
    assert.equal(week.loggedDays, 4) // the tea-only day and today don't count
    assert.equal(week.totalKcal, 7050)
    assert.equal(week.avgKcal, 1763)
    assert.equal(week.budgetKcal, 950)
    assert.equal(week.onTargetDays, 2)
    assert.equal(week.overDays, 1)
    assert.equal(week.underDays, 1)
    assert.equal(week.days.length, 7)
    const [mon, , wed, thu, , , sun] = week.days
    assert.equal(mon.calorieStatus, 'on')
    assert.equal(mon.proteinStatus, 'hit')
    assert.equal(wed.maybeIncomplete, true)
    assert.equal(thu.logged, false)
    assert.equal(thu.count, 1)
    assert.equal(sun.inProgress, true)
    assert.equal(sun.logged, true)
    assert.equal(sun.included, false)
    assert.equal(week.days[5].proteinStatus, 'close')
  })

  test('protein, macro split, foods and days', () => {
    const week = weeklyInsights(rows, weights, goals, '2026-09-14', '2026-09-20')
    assert.deepEqual(week.protein, { avgG: 87.5, targetG: 150, pct: 58, hitDays: 1, closeDays: 1 })
    assert.equal(week.fiber.avgG, 0)
    assert.equal(week.fiber.pct, 0)
    assert.deepEqual(week.macroSplit, { proteinPct: 28, carbsPct: 32, fatPct: 40, coverage: 0.74, show: true })
    assert.deepEqual(week.topFoods, [{ key: 'oats|', name: 'Oats', brand: null, count: 3, kcal: 1500 }])
    assert.deepEqual(week.biggestSources.map((food) => [food.name, food.share]), [['Pizza', 0.226], ['Steak', 0.195], ['Oats', 0.189]])
    assert.equal(week.closestDay.date, '2026-09-19')
    assert.equal(week.closestDay.diffPct, 3)
    assert.equal(week.furthestDay.date, '2026-09-16')
    assert.equal(week.highestKcalDay.date, '2026-09-15')
    assert.equal(week.highestProteinDay.date, '2026-09-14')
    assert.deepEqual(week.streak, { current: 2, longest: 4 })
  })

  test('weight, last week and the summary sentences', () => {
    const week = weeklyInsights(rows, weights, goals, '2026-09-14', '2026-09-20')
    close(week.weight.trendKg, 78.4, 1e-9)
    close(week.weight.weeklyChangeKg, -0.7, 1e-9)
    assert.equal(week.weight.weighIns, 7)
    assert.equal(week.weight.lowWeighIns, false)
    assert.deepEqual(week.vsLastWeek, { avgKcal: -237, avgProteinG: -12.5, onTargetDays: 1, trendKg: -0.7 })
    assert.deepEqual(week.summary, [
      'Averaged 1,763 kcal — 237 under goal on 4 logged days.',
      'On target 2 of 4 days.',
      'Protein 88 g (58%).',
      'Weight trend −0.7 kg this week.',
    ])
    const kj = weeklyInsights(rows, weights, goals, '2026-09-14', '2026-09-20', { energyUnit: 'kJ', weightUnit: 'lb' })
    assert.equal(kj.summary[0], 'Averaged 7,376 kJ — 992 under goal on 4 logged days.')
    assert.equal(kj.summary[3], 'Weight trend −1.5 lb this week.')
  })

  test('no goals, low macro coverage and empty weeks', () => {
    const noGoal = weeklyInsights(rows, [], {}, '2026-09-14', '2026-09-20')
    assert.equal(noGoal.budgetKcal, null)
    assert.equal(noGoal.closestDay, null)
    assert.equal(noGoal.furthestDay, null)
    assert.equal(noGoal.highestKcalDay.date, '2026-09-15')
    assert.equal(noGoal.days[0].calorieStatus, null)
    assert.equal(noGoal.vsLastWeek.onTargetDays, null)
    assert.equal(noGoal.weight.trendKg, null)
    assert.deepEqual(noGoal.summary, ['Averaged 1,763 kcal on 4 logged days.', 'Protein 88 g a day.'])

    // Most calories have no macros: no split.
    const sparse = [entry('2026-09-14', 'Pizza', 1800), entry('2026-09-15', 'Oats', 500, macro(20, 80, 10))]
    const split = weeklyInsights(sparse, [], goals, '2026-09-14', '2026-09-20').macroSplit
    assert.equal(split.show, false)
    assert.equal(split.coverage, 0.22)
    assert.equal(split.proteinPct, null)

    const empty = weeklyInsights([], [], goals, '2026-09-14', '2026-09-14')
    assert.equal(empty.loggedDays, 0)
    assert.equal(empty.avgKcal, null)
    assert.deepEqual(empty.summary, ['The week has just started — check back tomorrow.'])
    assert.deepEqual(weeklyInsights([], [], goals, '2026-09-07', '2026-09-20').summary, ['No calories were logged this week.'])

    // Default week (Monday start) and garbage input never throw.
    assert.equal(weeklyInsights(rows, weights, goals, null, '2026-09-20').weekStart, '2026-09-14')
    assert.equal(weeklyInsights(rows, weights, goals, null, '2026-09-20', { weekStart: 0 }).weekStart, '2026-09-20')
    const junk = weeklyInsights('x', 5, 'y', 'bad', 'bad', 'z')
    assert.equal(junk.days.length, 7)
    assert.ok(Array.isArray(junk.summary))
  })

  test('adaptive maintenance check needs 14+ days of logs and 8+ weigh-ins', () => {
    const food = []
    const scale = []
    for (let i = 0; i < 28; i += 1) {
      const date = addDays('2026-08-24', i)
      food.push(entry(date, 'Meals', 2200))
      scale.push(weight(date, 80 - (0.5 / 7) * i)) // −0.5 kg a week
    }
    const week = weeklyInsights(food, scale, goals, '2026-09-14', '2026-09-21')
    assert.ok(week.adaptive, 'expected an adaptive estimate')
    assert.equal(week.adaptive.avgKcal, 2200)
    assert.equal(week.adaptive.days, 22) // from the first full trend window
    assert.equal(week.adaptive.tdeeKcal, 2750) // 2200 + 0.5 kg × 7700 / 7
    assert.equal(weeklyInsights(food.slice(-10), scale, goals, '2026-09-14', '2026-09-21').adaptive, null)
  })
})

// ---- AI estimate post-processing ----------------------------------------------------------------

describe('clampEstimateItem', () => {
  const nuts = { name: 'Mixed nuts', amount: 50, unit: 'g', grams: 50, calories: 300, proteinG: 5, carbsG: 5, fatG: 5, confidence: 0.8, assumptions: [], locked: [], options: [] }

  test('energy check: locked or branded calories are kept with lower confidence', () => {
    const locked = clampEstimateItem({ ...nuts, locked: ['calories'] })
    assert.equal(locked.calories, 300)
    assert.equal(locked.confidence, 0.7)
    const branded = clampEstimateItem({ ...nuts, brand: 'Planters' })
    assert.equal(branded.calories, 300)
    assert.equal(branded.confidence, 0.7)
    assert.equal(clampEstimateItem({ ...nuts, locked: undefined, user_specified: ['Calories'] }).calories, 300)
  })

  test('energy check: otherwise calories follow the macros', () => {
    const fixed = clampEstimateItem(nuts)
    assert.equal(fixed.calories, 85)
    assert.equal(fixed.confidence, 0.8)
    // Within max(15 %, 25 kcal): unchanged.
    assert.equal(clampEstimateItem({ ...nuts, calories: 100 }).calories, 100)
    assert.equal(clampEstimateItem({ ...nuts, calories: 60 }).calories, 60)
    // Partial macros: no check.
    assert.equal(clampEstimateItem({ ...nuts, fatG: null }).calories, 300)
    // Missing calories come from the macros.
    assert.equal(clampEstimateItem({ ...nuts, calories: null }).calories, 85)
  })

  test('clamps and rounding', () => {
    const item = clampEstimateItem({
      name: '  Huge   meal ', calories: 9000.4, proteinG: -3, carbsG: 12.345, fatG: 'x', fiberG: 2.06, sodiumMg: 123.6, grams: 12.345, amount: 0,
      extra: { alcoholG: 3.33, caffeineMg: 95.5 }, confidence: 1.4, assumptions: ['a', 'b', 'c', 'd'], locked: ['calories', ' calories ', 'grams', 'proteinG', 7],
      options: [{ label: 'x', calories: 10 }, { calories: -5 }, { label: 'y' }, { label: 'z' }], mealHint: 'brunch',
    })
    assert.equal(item.name, 'Huge meal')
    assert.equal(item.calories, 5000)
    assert.equal(item.proteinG, 0)
    assert.equal(item.carbsG, 12.3)
    assert.equal(item.fatG, null)
    assert.equal(item.fiberG, 2.1)
    assert.equal(item.sodiumMg, 124)
    assert.equal(item.grams, 12.3)
    assert.equal(item.amount, null)
    assert.deepEqual(item.extra, { alcoholG: 3.3, caffeineMg: 96 })
    assert.equal(item.confidence, 1)
    assert.deepEqual(item.assumptions, ['a', 'b', 'c'])
    assert.deepEqual(item.locked, ['calories', 'grams', 'proteinG'])
    assert.equal(item.options.length, 3)
    assert.deepEqual(item.options[1], { label: 'Option', calories: 0, proteinG: null, carbsG: null, fatG: null })
    assert.equal(item.mealHint, null)
  })

  test('accepts the model snake_case shape and malformed input', () => {
    const item = clampEstimateItem({
      name: 'Latte', brand: 'Starbucks', quantity: 1, unit: 'grande', calories: 190, protein_g: 13, carbs_g: 19, fat_g: 7, sugar_g: 17,
      sodium_mg: 170, alcohol_g: null, caffeine_mg: 150, confidence: 0.9, user_specified: ['size'], meal_hint: 'breakfast',
      options: [{ label: 'Oat milk', calories: 190, protein_g: 3, carbs_g: 29, fat_g: 7 }],
    })
    assert.equal(item.amount, 1)
    assert.equal(item.proteinG, 13)
    assert.equal(item.extra.caffeineMg, 150)
    assert.equal(item.extra.alcoholG, null)
    assert.deepEqual(item.locked, ['size'])
    assert.equal(item.mealHint, 'breakfast')
    assert.equal(item.options[0].carbsG, 29)
    assert.equal(item.calories, 190)
    const blank = clampEstimateItem(null)
    assert.equal(blank.name, 'Food')
    assert.equal(blank.calories, null)
    assert.equal(blank.confidence, 0.5)
    assert.deepEqual(blank.options, [])
    assert.doesNotThrow(() => clampEstimateItem({ options: 'x', assumptions: 5, locked: {}, extra: [] }))
  })
})

// ---- settings.food ------------------------------------------------------------------------------

describe('normalizeFood', () => {
  test('defaults for missing or malformed settings', () => {
    const food = normalizeFood(undefined)
    assert.equal(normalizeFood(null), food)
    assert.equal(normalizeFood('x'), food)
    assert.deepEqual(food.goals, { calories: null, protein: null, carbs: null, fat: null, fiber: null, sugar: null, sodium: null, source: 'manual' })
    assert.equal(food.profile.activity, 'moderate')
    assert.equal(food.profile.goal, 'maintain')
    assert.equal(food.profile.rateKgPerWeek, 0.5)
    assert.equal(food.profile.fatPct, 30)
    assert.deepEqual(food.prefs.meals.map((meal) => meal.name), ['Breakfast', 'Lunch', 'Dinner', 'Snacks'])
    assert.equal(food.prefs.energyUnit, 'kcal')
    assert.deepEqual(food.prefs.nutrients, ['protein', 'carbs', 'fat'])
    assert.equal(food.prefs.ring, 'remaining')
    assert.equal(food.prefs.aiReview, 'always')
    assert.equal(food.prefs.showDetails, false)
    assert.equal(food.prefs.weekStart, 1)
    assert.deepEqual(food.favorites, [])
  })

  test('tolerates odd values and keeps identity', () => {
    const raw = {
      goals: { calories: '2210', protein: -5, fat: 'x', source: 'calculator', extra: 1 },
      profile: { sex: 'other', activity: 'toString', goal: 'bulk', heightCm: '180', birthYear: 1996.4, bodyFatPct: 90 },
      prefs: { meals: [{ id: 'a' }, { id: 'a', name: 'dup' }, 5, 'lunch', { id: 'b', name: ' Late ' }, { name: 'no id' }], nutrients: ['protein', 'x', 'protein', 'fiber'], energyUnit: 'kJ', ring: 'eaten', weekStart: 9 },
      favorites: [{ id: 'f1', name: 'Tea', calories: '5', aliases: ['chai', 3, 'chai'] }, { id: 'f1', name: 'dup' }, null, { name: 'no id' }],
      other: 'kept',
    }
    const food = normalizeFood(raw)
    assert.equal(normalizeFood(raw), food)
    assert.equal(normalizeFood(food), food)
    assert.equal(food.other, 'kept')
    assert.equal(food.goals.calories, 2210)
    assert.equal(food.goals.protein, null)
    assert.equal(food.goals.fat, null)
    assert.equal(food.goals.source, 'calculator')
    assert.equal(food.profile.sex, null)
    assert.equal(food.profile.activity, 'moderate')
    assert.equal(food.profile.goal, 'maintain')
    assert.equal(food.profile.heightCm, 180)
    assert.equal(food.profile.birthYear, 1996)
    assert.equal(food.profile.bodyFatPct, null)
    assert.deepEqual(food.prefs.meals, [{ id: 'a', name: 'a' }, { id: 'lunch', name: 'Lunch' }, { id: 'b', name: 'Late' }])
    assert.deepEqual(food.prefs.nutrients, ['protein', 'fiber'])
    assert.equal(food.prefs.energyUnit, 'kJ')
    assert.equal(food.prefs.ring, 'eaten')
    assert.equal(food.prefs.weekStart, 1)
    assert.equal(food.favorites.length, 1)
    assert.equal(food.favorites[0].calories, 5)
    assert.deepEqual(food.favorites[0].aliases, ['chai'])
    assert.equal('favoriteId' in food.favorites[0], false)
    // Unchanged parts keep their identity when another part changes.
    const next = normalizeFood({ ...raw, goals: { calories: 1800 } })
    assert.equal(next.prefs, food.prefs)
    assert.equal(next.favorites, food.favorites)
    assert.notEqual(next.goals, food.goals)
  })

  test('saved foods are capped at 400 and keep where their numbers came from', () => {
    const favorites = Array.from({ length: 450 }, (_, i) => ({ id: `f${i}`, name: `Food ${i}` }))
    assert.equal(normalizeFood({ favorites }).favorites.length, 400)
    const [fav] = normalizeFood({ favorites: [{ id: 'x', name: 'Bar', source: 'label', sourceUrl: 'https://a.example/b', barcode: '0123456789012', verifiedAt: '2026-09-23T00:00:00Z' }] }).favorites
    assert.equal(fav.source, 'label')
    assert.equal(fav.sourceUrl, 'https://a.example/b')
    assert.equal(fav.barcode, '0123456789012')
    const [bad] = normalizeFood({ favorites: [{ id: 'y', name: 'Bar', source: 'hack', sourceUrl: 'javascript:alert(1)', barcode: 'abc' }] }).favorites
    assert.equal(bad.source, null)
    assert.equal(bad.sourceUrl, null)
    assert.equal(bad.barcode, null)
  })

  test('matchSavedFoods finds foods by name, nickname or barcode', () => {
    const favorites = [
      { id: 'q', name: 'Protein bar', brand: 'Quest', aliases: ['quest bar'], updatedAt: '2026-09-20' },
      { id: 'w', name: 'Gold Standard Whey', brand: 'Optimum Nutrition', aliases: ['protein shake'], barcode: '748927028669', updatedAt: '2026-09-21' },
    ]
    assert.equal(matchSavedFoods(favorites, 'had my quest protein bar')[0].food.id, 'q')
    assert.equal(matchSavedFoods(favorites, 'protein shake after the gym')[0].food.id, 'w')
    assert.equal(matchSavedFoods(favorites, '748927028669')[0].food.id, 'w')
    assert.deepEqual(matchSavedFoods(favorites, 'a banana'), [])
  })
})

describe('portion units', () => {
  test('counted units take the plural above 1', () => {
    const cases = [
      [2, 'slice', 'slices'], [1, 'slice', 'slice'], [0.5, 'cup', 'cup'], [1.5, 'cup', 'cups'], [2, 'piece', 'pieces'],
      [2, 'serving', 'servings'], [3, 'egg', 'eggs'], [2, 'glass', 'glasses'], [2, 'sandwich', 'sandwiches'], [2, 'patty', 'patties'],
      [2, 'loaf', 'loaves'], [3, 'pc', 'pcs'], [2, 'Slice', 'Slices'], [2, 'wing', 'wings'],
      [2, 'can (355 ml)', 'cans (355 ml)'], [2, 'slice of bread', 'slices of bread'], [2, 'large egg', 'large eggs'],
      [2, 'cup cooked', 'cups cooked'], [2, 'piece(s)', 'pieces'], [2, 'serving, 30 g', 'servings, 30 g'],
    ]
    for (const [amount, unit, expected] of cases) assert.equal(unitFor(amount, unit), expected, `${amount} ${unit}`)
  })

  test('sizes, abbreviations, plurals and odd input stay as they are', () => {
    for (const unit of ['large', 'medium', 'tbsp', 'tsp', 'g', 'ml', 'oz', 'fl oz', 'lb', 'grande (16 fl oz)', 'slices', 'XL', 'fun size', 'fried']) {
      assert.equal(unitFor(2, unit), unit, unit)
    }
    assert.equal(unitFor(2, null), '')
    assert.equal(unitFor('x', 'slice'), 'slice')
    assert.equal(unitFor(2, '  slice  '), 'slices')
  })

  test('amountText', () => {
    assert.equal(amountText(2, 'can'), '2 cans')
    assert.equal(amountText(1, 'cup'), '1 cup')
    assert.equal(amountText(2, 'large'), '2 large')
    assert.equal(amountText(1.333, 'slice'), '1.33 slices')
    assert.equal(amountText(240, 'ml'), '240 ml')
    assert.equal(amountText(2, null), '2')
    assert.equal(amountText(0, 'slice'), '')
    assert.equal(amountText(null, 'slice'), '')
  })
})

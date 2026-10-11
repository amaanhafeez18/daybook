// Run: node --test tests/food-coach.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTEIN_IDEAS, maintenanceOffer, nudgePrefs, pickProteinIdea, proteinNudge, weighInNudge } from '../src/lib/food/coach.js'

const today = '2026-10-11'
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

describe('proteinNudge', () => {
  const base = {
    goals: { calories: 2000, protein: 150 },
    totals: { calories: 1200, proteinG: 100 },
    rowsToday: 3,
    nowMinutes: 19 * 60,
    entries: [],
    favorites: [],
    today,
  }

  test('shows in the evening when protein is behind', () => {
    const nudge = proteinNudge(base)
    assert.equal(nudge.leftG, 50)
    assert.equal(nudge.idea.saved, false)
    assert.equal(nudge.idea.name, 'Greek yogurt')
  })

  test('only from 18:00 until 23:00', () => {
    assert.equal(proteinNudge({ ...base, nowMinutes: 1079 }), null)
    assert.ok(proteinNudge({ ...base, nowMinutes: 1080 }))
    assert.ok(proteinNudge({ ...base, nowMinutes: 1379 }))
    assert.equal(proteinNudge({ ...base, nowMinutes: 1380 }), null)
  })

  test('needs a protein goal, 2+ rows and 40 % of the calories logged', () => {
    assert.equal(proteinNudge({ ...base, goals: { calories: 2000 } }), null)
    assert.equal(proteinNudge({ ...base, goals: { calories: 2000, protein: 0 } }), null)
    assert.equal(proteinNudge({ ...base, rowsToday: 1 }), null)
    assert.ok(proteinNudge({ ...base, rowsToday: [{}, {}] }))
    assert.equal(proteinNudge({ ...base, totals: { calories: 700, proteinG: 40 } }), null)
    // No calorie goal: 600 kcal logged is enough.
    assert.equal(proteinNudge({ ...base, goals: { protein: 150 }, totals: { calories: 500, proteinG: 40 } }), null)
    assert.ok(proteinNudge({ ...base, goals: { protein: 150 }, totals: { calories: 650, proteinG: 40 } }))
    assert.equal(proteinNudge(null), null)
  })

  test('not when nearly there; rounds to 5 g', () => {
    assert.equal(proteinNudge({ ...base, totals: { calories: 1200, proteinG: 135 } }), null) // 15 g of 150
    assert.equal(proteinNudge({ ...base, totals: { calories: 1200, proteinG: 128 } }), null) // 22 g < 22.5 g
    assert.equal(proteinNudge({ ...base, totals: { calories: 1200, proteinG: 103 } }).leftG, 45) // 47 → 45
    assert.equal(proteinNudge({ ...base, totals: { calories: 1200, proteinG: 102 } }).leftG, 50) // 48 → 50
  })

  test('suggests a saved or recent food first', () => {
    const entries = [{ id: 'e1', date: addDays(today, -2), name: 'Skyr', calories: 120, proteinG: 22, carbsG: 8, fatG: 0 }]
    const nudge = proteinNudge({ ...base, entries })
    assert.equal(nudge.idea.saved, true)
    assert.equal(nudge.idea.name, 'Skyr')
    assert.equal(nudge.idea.template.calories, 120)
  })
})

describe('pickProteinIdea', () => {
  const shake = { id: 'f1', name: 'Protein shake', calories: 130, proteinG: 25 }
  const chicken = { name: 'Chicken breast', calories: 250, proteinG: 45, count: 1 }
  const skyr = { name: 'Skyr', calories: 120, proteinG: 20, count: 6 }

  test('picks the saved food that covers the most of what is left', () => {
    assert.equal(pickProteinIdea(40, 800, [shake, chicken, skyr]).name, 'Chicken breast')
    // Both cover 20 g: the one eaten more often.
    assert.equal(pickProteinIdea(20, 800, [shake, { ...skyr, count: 2 }, { name: 'Tuna', calories: 120, proteinG: 25, count: 5 }]).name, 'Tuna')
    const pick = pickProteinIdea(40, null, [shake])
    assert.deepEqual(pick, { name: 'Protein shake', template: shake, saved: true })
  })

  test('leaves out foods that are mostly not protein', () => {
    const nuts = { name: 'Peanuts', calories: 580, proteinG: 26, count: 9 } // 18 % protein energy
    assert.equal(pickProteinIdea(30, null, [nuts]).saved, false)
    const small = { name: 'Ham slice', calories: 30, proteinG: 5 } // under 10 g
    assert.equal(pickProteinIdea(30, null, [small]).saved, false)
  })

  test('leaves out foods over the calories left (+100)', () => {
    assert.equal(pickProteinIdea(45, 100, [chicken]).saved, false)
    assert.equal(pickProteinIdea(45, 150, [chicken]).name, 'Chicken breast')
  })

  test('falls back to a generic idea that fits, or null', () => {
    assert.deepEqual(pickProteinIdea(45, 1000, []), { name: 'Greek yogurt', text: 'Greek yogurt 200 g', saved: false })
    assert.equal(pickProteinIdea(45, 25, null).name, 'Tuna') // 125 kcal of room: only the 120 kcal tuna fits
    assert.equal(pickProteinIdea(45, 10, [chicken]), null)
    assert.equal(pickProteinIdea(45, -400, []), null) // over budget already: 100 kcal of room
    assert.ok(PROTEIN_IDEAS.every((idea) => idea.proteinG >= 10 && (4 * idea.proteinG) / idea.calories >= 0.35))
  })
})

describe('weighInNudge', () => {
  const w = (date, kg = 80) => ({ id: date, date, kg })

  test('needs two weigh-in days', () => {
    assert.equal(weighInNudge([w(addDays(today, -10))], today), null)
    assert.equal(weighInNudge([w(addDays(today, -10)), w(addDays(today, -10), 81)], today), null)
    assert.equal(weighInNudge([], today), null)
    assert.equal(weighInNudge(null, today), null)
  })

  test('shows from 4 to 30 days since the last one', () => {
    const at = (days) => weighInNudge([w(addDays(today, -40)), w(addDays(today, -days))], today)
    assert.equal(at(3), null)
    assert.deepEqual(at(4), { days: 4 })
    assert.deepEqual(at(30), { days: 30 })
    assert.equal(at(31), null)
  })

  test('ignores future dates and bad rows', () => {
    const rows = [w(addDays(today, -20)), w(addDays(today, -6)), w(addDays(today, 2)), { date: 'x', kg: 80 }, { date: addDays(today, -1), kg: 0 }, null]
    assert.deepEqual(weighInNudge(rows, today), { days: 6 })
    assert.equal(weighInNudge(rows, 'bad'), null)
  })
})

describe('nudgePrefs', () => {
  test('both on by default; an explicit false turns one off', () => {
    assert.deepEqual(nudgePrefs(undefined), { protein: true, weighIn: true })
    assert.deepEqual(nudgePrefs({ prefs: {} }), { protein: true, weighIn: true })
    assert.deepEqual(nudgePrefs({ prefs: { nudges: { weighIn: false } } }), { protein: true, weighIn: false })
  })
})

describe('maintenanceOffer', () => {
  const plan = (diffKcal) => ({ calories: 2000, same: diffKcal !== null && diffKcal < 100, diffKcal })

  test('none, fits and offer', () => {
    assert.equal(maintenanceOffer(null, 2300, null, today), 'none')
    assert.equal(maintenanceOffer(plan(50), 2300, null, today), 'fits')
    assert.equal(maintenanceOffer(plan(300), 2300, null, today), 'offer')
    assert.equal(maintenanceOffer(plan(null), 2300, {}, today), 'offer')
  })

  test('"Not now" waits until the estimate moves 100 kcal or 14 days pass', () => {
    const dismissed = { dismissedOn: addDays(today, -3), dismissedKcal: 2300 }
    assert.equal(maintenanceOffer(plan(300), 2350, dismissed, today), 'snoozed')
    assert.equal(maintenanceOffer(plan(300), 2400, dismissed, today), 'offer')
    assert.equal(maintenanceOffer(plan(300), 2300, { ...dismissed, dismissedOn: addDays(today, -14) }, today), 'offer')
  })

  test('after an update, 14 days unless the goal would move 150 kcal or more', () => {
    const applied = { appliedOn: addDays(today, -5) }
    assert.equal(maintenanceOffer(plan(120), 2300, applied, today), 'snoozed')
    assert.equal(maintenanceOffer(plan(150), 2300, applied, today), 'offer')
    assert.equal(maintenanceOffer(plan(120), 2300, { appliedOn: addDays(today, -14) }, today), 'offer')
  })
})

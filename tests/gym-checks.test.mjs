// Run: node --test tests/gym-checks.test.mjs
// Weight plausibility, orphaned sessions, the plan-driven weekly goal and the workout set count.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { orphanMatches, orphanSummary, planWeeklyGoal, plausibleWeight, weeklyGoalFor } from '../src/lib/gym/stats.js'
import { toKg } from '../src/lib/gym/units.js'

const set = (weightKg, reps = 5, extra = {}) => ({ type: 'normal', weightKg, reps, done: true, ...extra })
const session = (id, date, exercises, extra = {}) => ({ id, date, name: 'Workout', routineId: null, exercises, ...extra })
const bench = (sets) => ({ exerciseId: 'bench-press', tracking: 'weight_reps', sets })

describe('plausibleWeight', () => {
  const history = [
    session('a', '2026-09-01', [bench([set(80), set(85)])]),
    session('b', '2026-09-08', [bench([set(60, 10, { type: 'warmup' }), set(87.5)])]),
  ]
  const check = (kg, extra = {}) => plausibleWeight({ kg, exerciseId: 'bench-press', sessions: history, equipment: 'barbell', tracking: 'weight_reps', ...extra })

  test('normal progress is fine', () => {
    assert.equal(check(90), null)
    assert.equal(check(120), null)
    assert.equal(check(0), null)
    assert.equal(check(null), null)
  })

  test('a slipped digit is flagged with the ÷10 suggestion', () => {
    const flag = check(850)
    assert.equal(flag.reason, 'history')
    assert.equal(flag.referenceKg, 87.5)
    assert.equal(flag.kg, 850)
    assert.equal(flag.suggestKg, 85)
  })

  test('no suggestion when ÷10 would be implausible too', () => {
    assert.equal(check(260).suggestKg, null) // 26 is far below the 87.5 kg history
    assert.equal(check(400).suggestKg, 40)
  })

  test('light history needs a real jump, not just a ratio', () => {
    const light = [session('a', '2026-09-01', [bench([set(20)])])]
    assert.equal(check(60, { sessions: light }), null)
    assert.ok(check(200, { sessions: light }))
  })

  test('without history a per-equipment ceiling applies', () => {
    assert.equal(plausibleWeight({ kg: 300, exerciseId: 'new', sessions: [], equipment: 'barbell' }), null)
    const flag = plausibleWeight({ kg: 450, exerciseId: 'new', sessions: [], equipment: 'dumbbell' })
    assert.equal(flag.reason, 'cap')
    assert.equal(flag.suggestKg, 45)
    assert.ok(plausibleWeight({ kg: 120, exerciseId: 'new', sessions: [], equipment: 'dumbbell' }))
    assert.equal(plausibleWeight({ kg: 120, exerciseId: 'new', sessions: [], equipment: 'machine' }), null)
  })

  test('the flagged session itself and kept loads are handled', () => {
    const withTypo = [...history, session('c', '2026-09-15', [bench([set(850)])])]
    assert.equal(check(850, { sessions: withTypo }), null) // compared with itself it looks fine
    assert.ok(check(850, { sessions: withTypo, excludeSessionId: 'c' }))
    assert.equal(check(850, { extraKg: [850] }), null) // already kept once in this workout
  })

  test('lb input is judged in kg and the suggestion stays exact', () => {
    const flag = check(toKg(850, 'lb'), { sessions: [session('a', '2026-09-01', [bench([set(toKg(185, 'lb'))])])] })
    assert.ok(Math.abs(flag.suggestKg - toKg(85, 'lb')) < 1e-9)
  })

  test('only weighted tracking types are checked', () => {
    assert.equal(check(850, { tracking: 'duration' }), null)
    assert.equal(check(850, { tracking: 'bodyweight_reps' }), null)
    assert.ok(check(850, { tracking: 'weighted_bodyweight' }))
  })

  test('tolerates junk', () => {
    assert.equal(plausibleWeight(), null)
    assert.equal(plausibleWeight({ kg: 'x' }), null)
    assert.equal(plausibleWeight({ kg: 50, sessions: 'nope' }), null)
  })
})

describe('orphanMatches', () => {
  const routines = [{ id: 'r-push', name: 'Push' }, { id: 'r-pull', name: '  pull day ' }, { id: 'x1', name: 'Legs' }, { id: 'x2', name: 'legs' }]
  const sessions = [
    session('s1', '2026-09-01', [], { name: 'push', routineId: 'old-push' }),
    session('s2', '2026-09-03', [], { name: 'Pull   Day', routineId: 'old-pull' }),
    session('s3', '2026-09-05', [], { name: 'Push', routineId: 'r-push' }), // still linked
    session('s4', '2026-09-06', [], { name: 'Push', routineId: null }), // never linked
    session('s5', '2026-09-07', [], { name: 'Legs', routineId: 'old-legs' }), // ambiguous
    session('s6', '2026-09-08', [], { name: 'Arms', routineId: 'old-arms' }), // no match
  ]

  test('matches by name, ignoring case and spacing', () => {
    assert.deepEqual(orphanMatches(sessions, routines), [
      { sessionId: 's1', fromRoutineId: 'old-push', routineId: 'r-push', name: 'Push' },
      { sessionId: 's2', fromRoutineId: 'old-pull', routineId: 'r-pull', name: 'pull day' },
    ])
  })

  test('can be limited to some routines', () => {
    assert.deepEqual(orphanMatches(sessions, routines, { routineIds: ['r-pull'] }).map((m) => m.sessionId), ['s2'])
  })

  test('tolerates junk', () => {
    assert.deepEqual(orphanMatches(null, routines), [])
    assert.deepEqual(orphanMatches(sessions, null), [])
    assert.deepEqual(orphanMatches([null, 4, { routineId: 'x' }], routines), [])
  })

  test('summary', () => {
    const matches = orphanMatches(sessions, routines)
    assert.equal(orphanSummary(matches.slice(0, 1)), '1 past Push workout')
    assert.equal(orphanSummary([matches[0], matches[0]]), '2 past Push workouts')
    assert.equal(orphanSummary(matches), '2 past workouts')
  })
})

describe('weekly goal from the plan', () => {
  const r = (id) => ({ kind: 'routine', routineId: id })
  const rest = { kind: 'rest' }
  const weekly = (days, effectiveFrom = '2026-09-01') => ({ id: effectiveFrom, effectiveFrom, mode: 'weekly', cycle: [], weekly: days })
  const rotation = (cycle, effectiveFrom = '2026-09-01') => ({ id: effectiveFrom, effectiveFrom, mode: 'rotation', cycle, weekly: [] })

  test('weekly plans count workout days', () => {
    assert.equal(planWeeklyGoal({ versions: [weekly([r('a'), rest, r('b'), rest, r('a'), rest, rest])] }), 3)
  })

  test('rotations scale to a week', () => {
    // Push, Pull, Legs, rest → 3 of 4 days → 5.25 a week → 5
    assert.equal(planWeeklyGoal({ versions: [rotation([r('a'), r('b'), r('c'), rest])] }), 5)
    assert.equal(planWeeklyGoal({ versions: [rotation([r('a'), rest, rest])] }), 2)
  })

  test('the newest version wins', () => {
    const schedule = { versions: [weekly([r('a'), rest, rest, rest, rest, rest, rest], '2026-10-01'), weekly([r('a'), r('b'), rest, rest, rest, rest, rest], '2026-09-01')] }
    assert.equal(planWeeklyGoal(schedule), 1)
  })

  test('no plan or no workouts → null', () => {
    assert.equal(planWeeklyGoal(null), null)
    assert.equal(planWeeklyGoal({ versions: [] }), null)
    assert.equal(planWeeklyGoal({ versions: [weekly([rest, rest, rest, rest, rest, rest, rest])] }), null)
    assert.equal(planWeeklyGoal({ versions: [rotation([])] }), null)
  })

  test('weeklyGoalFor: follows the plan unless set by hand', () => {
    const plan = { versions: [weekly([r('a'), r('b'), r('c'), r('d'), r('e'), rest, rest])] }
    assert.deepEqual(weeklyGoalFor({}, plan), { goal: 5, fromPlan: true, manual: false })
    assert.deepEqual(weeklyGoalFor({ weeklyGoal: 3 }, plan), { goal: 5, fromPlan: true, manual: false }) // the old default
    assert.deepEqual(weeklyGoalFor({ weeklyGoal: 4 }, plan), { goal: 4, fromPlan: false, manual: true })
    assert.deepEqual(weeklyGoalFor({ weeklyGoal: 3, weeklyGoalAuto: false }, plan), { goal: 3, fromPlan: false, manual: true })
    assert.deepEqual(weeklyGoalFor({ weeklyGoal: 4, weeklyGoalAuto: true }, plan), { goal: 5, fromPlan: true, manual: false })
    assert.deepEqual(weeklyGoalFor({}, null), { goal: 3, fromPlan: false, manual: false })
    assert.deepEqual(weeklyGoalFor(null, plan), { goal: 5, fromPlan: true, manual: false })
  })
})

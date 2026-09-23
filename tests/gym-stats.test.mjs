// Run: node --test tests/gym-stats.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY_TYPES, EQUIPMENT, EXERCISES, MUSCLES, TEMPLATES, TRACKING, allExercises, buildTemplate, dayTemplate, exerciseById, matchDayType,
  newRoutineExercise, parseSplit, searchExercises,
} from '../src/lib/gym/library.js'
import {
  LB, formatDistance, formatDuration, formatNumber, formatPace, formatVolume, formatWeight, fromKg, fromMeters, parseDecimal,
  parseDuration, toKg, toMeters,
} from '../src/lib/gym/units.js'
import {
  barFor, bestSet, compareSessions, computeRecords, deloadTargets, deloadWeight, e1rm, estimateMinutes, exerciseHistory, increment,
  isBackfillWorkout, isWorking, livePRs, loadStep, plannedWeight, plateBreakdown, previousSets, projectedWeight, roundDown,
  sessionDurationSec, sessionPRs, sessionReps, sessionVolume, sessionWorkingSets, sessionsToCsv, setVolume, streakWeeks, suggestNext,
  topExercises, warmupSets, weekProgress, weeklyCounts, weeklySetsByMuscle,
} from '../src/lib/gym/stats.js'
import { emptySchedule, normalizeSchedule } from '../src/lib/gym/schedule.js'

const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`)
}
const counter = () => {
  let n = 0
  return () => `id${++n}`
}

// ---- fixtures ------------------------------------------------------------------------------

let uid = 0
const set = (weightKg, reps, extra = {}) => ({ id: `s${++uid}`, type: 'normal', weightKg, reps, durationSec: null, distanceM: null, rpe: null, done: true, ...extra })
const warm = (weightKg, reps) => set(weightKg, reps, { type: 'warmup' })
const ex = (exerciseId, sets, extra = {}) => {
  const entry = exerciseById(exerciseId)
  return { id: `e${++uid}`, exerciseId, name: entry?.name ?? exerciseId, tracking: entry?.tracking ?? 'weight_reps', restSec: 120, note: '', supersetId: null, sets, ...extra }
}
const session = (id, date, exercises, extra = {}) => ({
  id, date, name: 'Workout', routineId: null, startedAt: `${date}T10:00:00.000Z`, endedAt: `${date}T11:00:00.000Z`, durationSec: 3600,
  exercises, note: '', planned: null, bodyweightKg: null, isDeload: false, createdAt: `${date}T11:00:00.000Z`, ...extra,
})
const routineEx = (exerciseId, repsMin, repsMax, count = 3, weightKg = null) => ({
  ...newRoutineExercise(exerciseById(exerciseId), counter(), count),
  sets: Array.from({ length: count }, () => ({ type: 'normal', weightKg, repsMin, repsMax, durationSec: null, distanceM: null, rpe: null })),
})

// ---- library -------------------------------------------------------------------------------

describe('library', () => {
  test('124 entries with unique ids and valid fields', () => {
    assert.equal(EXERCISES.length, 124)
    assert.equal(new Set(EXERCISES.map((e) => e.id)).size, 124)
    assert.equal(MUSCLES.length, 18)
    assert.equal(new Set(MUSCLES.map((m) => m.id)).size, 18)
    assert.equal(EQUIPMENT.length, 8)
    const muscles = new Set(MUSCLES.map((m) => m.id))
    const equipment = new Set(EQUIPMENT.map((e) => e.id))
    for (const e of EXERCISES) {
      assert.match(e.id, /^[a-z0-9-]+$/, e.id)
      assert.ok(typeof e.name === 'string' && e.name, e.id)
      assert.ok(muscles.has(e.primary), `${e.id} primary`)
      assert.ok(Array.isArray(e.secondary) && e.secondary.every((m) => muscles.has(m)), `${e.id} secondary`)
      assert.ok(equipment.has(e.equipment), `${e.id} equipment`)
      assert.ok(TRACKING[e.tracking], `${e.id} tracking`)
      assert.ok(['compound', 'isolation', 'cardio'].includes(e.category), `${e.id} category`)
      assert.ok(['push', 'pull', 'legs', 'core', 'cardio'].includes(e.movement), `${e.id} movement`)
      assert.ok(Number.isInteger(e.rest) && e.rest >= 0 && e.rest <= 600, `${e.id} rest`)
      if ('bar' in e) assert.ok(['ez', 'trap', 'landmine'].includes(e.bar), `${e.id} bar`)
      if ('bwVolume' in e) assert.equal(e.bwVolume, true)
    }
    for (const [id, info] of Object.entries(TRACKING)) {
      assert.ok(info.label && Array.isArray(info.fields) && info.fields.length, id)
    }
    assert.equal(MUSCLES.find((m) => m.id === 'upper_back').label, 'Upper back')
    assert.equal(EQUIPMENT.find((e) => e.id === 'smith_machine').label, 'Smith machine')
  })

  test('lookup and custom exercises', () => {
    const customs = [
      { id: 'custom-1', name: 'Zottman Curl', primary: 'biceps', secondary: ['forearms'], equipment: 'dumbbell', category: 'isolation', movement: 'pull', tracking: 'weight_reps', rest: 90, custom: true, hidden: false, bwVolume: false },
      { id: 'custom-2', name: 'Old Thing', primary: 'chest', secondary: [], equipment: 'machine', category: 'isolation', movement: 'push', tracking: 'weight_reps', rest: 90, custom: true, hidden: true, bwVolume: false },
      null,
      'junk',
    ]
    assert.equal(exerciseById('bench-press').name, 'Bench Press (Barbell)')
    assert.equal(exerciseById('custom-2', customs).name, 'Old Thing') // hidden still resolves for history
    assert.equal(exerciseById('nope', customs), null)
    assert.equal(exerciseById(undefined), null)
    assert.equal(exerciseById('constructor'), null)
    const all = allExercises(customs)
    assert.equal(all.length, 125)
    assert.ok(all.some((e) => e.id === 'custom-1') && !all.some((e) => e.id === 'custom-2'))
    assert.equal(allExercises('bad').length, 124)
    assert.ok(searchExercises('zottman', { customExercises: customs }).some((e) => e.id === 'custom-1'))
    assert.equal(searchExercises('old thing', { customExercises: customs }).length, 0)
  })

  test('search: tokens, prefix ranking and filters', () => {
    const bench = searchExercises('bench')
    assert.ok(bench.length >= 6)
    assert.ok(bench[0].name.startsWith('Bench'), bench[0].name)
    assert.ok(bench.findIndex((e) => e.id === 'bench-press') < bench.findIndex((e) => e.id === 'incline-bench-press'))
    // "Bench Press ..." names rank ahead of names that merely contain "bench".
    const firstOther = bench.findIndex((e) => !e.name.toLowerCase().startsWith('bench'))
    assert.ok(bench.slice(firstOther).every((e) => !e.name.toLowerCase().startsWith('bench')))
    assert.equal(searchExercises('BENCH PRESS barbell')[0].id, 'bench-press')
    assert.ok(searchExercises('pull up').some((e) => e.id === 'pull-up'))
    assert.ok(searchExercises('pullup').some((e) => e.id === 'pull-up'))
    assert.ok(searchExercises("farmer's").some((e) => e.id === 'farmers-walk'))
    // All tokens must match: "curl cable" matches the cable curls only.
    const cableCurls = searchExercises('curl cable')
    assert.ok(cableCurls.length > 0 && cableCurls.every((e) => e.equipment === 'cable' && /curl/i.test(e.name)))
    // Muscle tokens match muscle labels: "upper back" finds rows.
    assert.ok(searchExercises('upper back').some((e) => e.id === 'barbell-row'))
    const chest = searchExercises('', { muscle: 'chest' })
    assert.ok(chest.some((e) => e.id === 'close-grip-bench-press')) // secondary chest counts
    assert.ok(chest.every((e) => e.primary === 'chest' || e.secondary.includes('chest')))
    const kettlebell = searchExercises('', { equipment: 'kettlebell' })
    assert.deepEqual(kettlebell.map((e) => e.id), ['kettlebell-swing'])
    assert.deepEqual(searchExercises('squat', { muscle: 'quads', equipment: 'machine' }).map((e) => e.id), ['hack-squat'])
    assert.equal(searchExercises('').length, 124)
    assert.equal(searchExercises(null, null).length, 124)
    assert.equal(searchExercises('zzzz').length, 0)
    const all = searchExercises('')
    assert.deepEqual(all.map((e) => e.name), [...all.map((e) => e.name)].sort((a, b) => a.localeCompare(b)))
  })

  test('newRoutineExercise defaults per tracking type', () => {
    const makeId = counter()
    const bench = newRoutineExercise(exerciseById('bench-press'), makeId)
    assert.deepEqual(bench, {
      id: 'id1', exerciseId: 'bench-press', name: 'Bench Press (Barbell)', tracking: 'weight_reps', restSec: 180, note: '', supersetId: null,
      sets: Array.from({ length: 3 }, () => ({ type: 'normal', weightKg: null, repsMin: 8, repsMax: 12, durationSec: null, distanceM: null, rpe: null })),
    })
    const plank = newRoutineExercise(exerciseById('plank'), makeId, 2)
    assert.equal(plank.sets.length, 2)
    assert.deepEqual(plank.sets[0], { type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: 60, distanceM: null, rpe: null })
    assert.equal(plank.restSec, 60)
    const run = newRoutineExercise(exerciseById('treadmill'), makeId)
    assert.deepEqual(run.sets[0], { type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: null, distanceM: null, rpe: null })
    assert.equal(run.restSec, 0)
    const custom = newRoutineExercise({ id: 'custom-x', name: 'Thing', category: 'isolation', tracking: 'weight_reps' }, makeId)
    assert.equal(custom.restSec, 90)
    assert.equal(newRoutineExercise({ id: 'c', name: 'C' }, makeId).restSec, 120)
  })
})

// ---- templates -----------------------------------------------------------------------------

describe('templates', () => {
  const today = '2026-09-23'
  const expected = {
    'ppl-r': { mode: 'rotation', slots: ['Push', 'Pull', 'Legs', null] },
    ppl2: { mode: 'weekly', slots: [null, 'Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs'] },
    'upper-lower': { mode: 'weekly', slots: [null, 'Upper', 'Lower', null, 'Upper', 'Lower', null] },
    bro: { mode: 'rotation', slots: ['Chest', 'Back', 'Shoulders', 'Legs', 'Arms', null, null] },
    'full-body': { mode: 'weekly', slots: [null, 'Full Body', null, 'Full Body', null, 'Full Body', null] },
  }
  const colors = { Push: 'red', Pull: 'blue', Legs: 'green', Upper: 'indigo', Lower: 'teal', Chest: 'red', Back: 'blue', Shoulders: 'amber', Arms: 'pink', 'Full Body': 'orange' }

  test('TEMPLATES lists every template id', () => {
    assert.deepEqual(TEMPLATES.map((t) => t.id), ['ppl-r', 'ppl2', 'upper-lower', 'bro', 'full-body', 'custom'])
    for (const t of TEMPLATES) assert.ok(t.name && t.description)
  })

  for (const [id, plan] of Object.entries(expected)) {
    test(`${id} builds valid routines and a schedule that references them`, () => {
      const { routines, schedule } = buildTemplate(id, today, counter())
      const ids = new Set(routines.map((r) => r.id))
      assert.equal(ids.size, routines.length)
      assert.deepEqual(routines.map((r) => r.name), [...new Set(plan.slots.filter(Boolean))])
      for (const routine of routines) {
        assert.equal(routine.color, colors[routine.name])
        assert.equal(routine.notes, '')
        assert.equal(routine.folderId, null)
        assert.ok(routine.createdAt && routine.updatedAt)
        assert.ok(routine.exercises.length >= 4)
        for (const item of routine.exercises) {
          const entry = exerciseById(item.exerciseId)
          assert.ok(entry, item.exerciseId)
          assert.equal(item.name, entry.name)
          assert.equal(item.tracking, entry.tracking)
          assert.equal(item.restSec, entry.rest)
          assert.ok(item.sets.length >= 2)
          for (const s of item.sets) {
            assert.equal(s.type, 'normal')
            assert.equal(s.weightKg, null)
            if (entry.tracking === 'duration') assert.equal(s.durationSec, 60)
            else assert.ok(s.repsMin > 0 && s.repsMax >= s.repsMin)
          }
        }
      }
      assert.equal(schedule.versions.length, 1)
      const [version] = schedule.versions
      assert.equal(version.effectiveFrom, today)
      assert.equal(version.anchorIndex, 0)
      assert.equal(version.mode, plan.mode)
      assert.match(version.id, /^v2026-09-23/)
      const slots = plan.mode === 'rotation' ? version.cycle : version.weekly
      assert.deepEqual(plan.mode === 'rotation' ? version.weekly : version.cycle, [])
      const nameOf = (slot) => (slot.kind === 'rest' ? null : routines.find((r) => r.id === slot.routineId)?.name)
      for (const slot of slots) if (slot.kind === 'routine') assert.ok(ids.has(slot.routineId))
      assert.deepEqual(slots.map(nameOf), plan.slots)
      assert.deepEqual(normalizeSchedule(schedule), schedule) // already in the normalized shape
    })
  }

  test('template set contents', () => {
    const { routines } = buildTemplate('bro', today, counter())
    const back = routines.find((r) => r.name === 'Back')
    assert.deepEqual(back.exercises.map((e) => [e.exerciseId, e.sets.length, e.sets[0].repsMin, e.sets[0].repsMax]), [
      ['deadlift', 3, 5, 5], ['pull-up', 3, 6, 10], ['dumbbell-row', 3, 8, 10], ['lat-pulldown', 3, 10, 12], ['face-pull', 3, 12, 15],
    ])
    assert.equal(routines.find((r) => r.name === 'Chest').exercises[0].sets.length, 4)
    const fb = buildTemplate('full-body', today, counter()).routines[0]
    const plank = fb.exercises.find((e) => e.exerciseId === 'plank')
    assert.deepEqual(plank.sets, Array.from({ length: 3 }, () => ({ type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: 60, distanceM: null, rpe: null })))
    const legs = buildTemplate('ppl-r', today, counter()).routines.find((r) => r.name === 'Legs')
    assert.equal(legs.exercises.at(-1).sets.length, 4)
    assert.deepEqual([legs.exercises.at(-1).sets[0].repsMin, legs.exercises.at(-1).sets[0].repsMax], [10, 15])
  })

  test('custom and unknown templates are empty', () => {
    assert.deepEqual(buildTemplate('custom', today, counter()), { routines: [], schedule: emptySchedule() })
    assert.deepEqual(buildTemplate('constructor', today), { routines: [], schedule: emptySchedule() })
  })

  test('estimateMinutes', () => {
    const push = buildTemplate('ppl-r', today, counter()).routines[0]
    // 3×(45+180) + 3×(45+120)×2 + 3×(45+90)×3 = 2880 s = 48 min → 50
    assert.equal(estimateMinutes(push), 50)
    assert.equal(estimateMinutes({ exercises: [] }), 0)
    assert.equal(estimateMinutes(null), 0)
    assert.equal(estimateMinutes({ exercises: [{ restSec: 0, sets: [{}] }] }), 5)
    assert.equal(estimateMinutes({ exercises: [{ restSec: 'x', sets: 'nope' }, null] }), 5)
  })
})

// ---- custom splits (split wizard) ------------------------------------------------------------

describe('custom splits', () => {
  const ROUTINE_COLOR_IDS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'pink']
  const shape = (rows) => rows.map((row) => [row.exerciseId, row.sets.length, row.sets[0].repsMin ?? row.sets[0].durationSec])

  test('DAY_TYPES: unique ids and names, routine colours, rest last', () => {
    assert.deepEqual(DAY_TYPES.map((t) => t.name), [
      'Push', 'Pull', 'Legs', 'Upper', 'Lower', 'Chest', 'Back', 'Shoulders', 'Arms', 'Full Body', 'Core', 'Glutes', 'Cardio', 'Rest',
    ])
    assert.equal(new Set(DAY_TYPES.map((t) => t.id)).size, DAY_TYPES.length)
    for (const type of DAY_TYPES) {
      if (type.rest) assert.equal(type.color, null)
      else assert.ok(ROUTINE_COLOR_IDS.includes(type.color), type.id)
      assert.ok(type.hint, type.id)
    }
    assert.equal(DAY_TYPES.at(-1).id, 'rest')
  })

  test('every day type round-trips through parseSplit and matchDayType', () => {
    for (const type of DAY_TYPES) {
      assert.deepEqual(parseSplit(type.name), [type.name])
      assert.equal(matchDayType(type.name), type)
      assert.equal(matchDayType(type.name.toUpperCase()), type)
    }
  })

  test('parseSplit: separators, rest words and repeats', () => {
    const cases = {
      'push pull shoulders legs rest rest': ['Push', 'Pull', 'Shoulders', 'Legs', 'Rest', 'Rest'],
      'PPL x2 + rest': ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs', 'Rest'],
      'upper/lower/rest': ['Upper', 'Lower', 'Rest'],
      'Push, Pull, Legs then off': ['Push', 'Pull', 'Legs', 'Rest'],
      'push -> pull → legs => rest day': ['Push', 'Pull', 'Legs', 'Rest'],
      'push; pull | legs\nday off': ['Push', 'Pull', 'Legs', 'Rest'],
      'push-pull-legs-rest': ['Push', 'Pull', 'Legs', 'Rest'],
      'rest x2': ['Rest', 'Rest'],
      'push ×2': ['Push', 'Push'],
      'pplx2 rest': ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs', 'Rest'],
      '2x ppl, rest': ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs', 'Rest'],
      'push pull legs 2 rest': ['Push', 'Pull', 'Legs', 'Rest', 'Rest'],
      'ppl, rest twice': ['Push', 'Pull', 'Legs', 'Rest', 'Rest'],
      'upper lower rest x2': ['Upper', 'Lower', 'Rest', 'Upper', 'Lower', 'Rest'],
      'bro split': ['Chest', 'Back', 'Shoulders', 'Legs', 'Arms'],
      'Mon push, Tue pull, Wed legs': ['Push', 'Pull', 'Legs'],
      'active recovery': ['Rest'],
    }
    for (const [text, expected] of Object.entries(cases)) assert.deepEqual(parseSplit(text), expected, text)
  })

  test('parseSplit: multi-word days, labels and custom names', () => {
    const cases = {
      'shoulder day, legs & abs, full body, day off': ['Shoulders', 'Legs & Abs', 'Full Body', 'Rest'],
      'chest and triceps, back and biceps, legs': ['Chest & Triceps', 'Back & Biceps', 'Legs'],
      'back biceps chest tris legs': ['Back & Biceps', 'Chest & Triceps', 'Legs'],
      'legs w/ abs': ['Legs & Abs'],
      'chest & back': ['Chest & Back'],
      // "and" before a main day lists it; "&" always joins.
      'push, pull and legs': ['Push', 'Pull', 'Legs'],
      'upper a lower a rest upper b lower b rest rest': ['Upper A', 'Lower A', 'Rest', 'Upper B', 'Lower B', 'Rest', 'Rest'],
      'push1 pull1 legs1': ['Push 1', 'Pull 1', 'Legs 1'],
      'Push 2': ['Push 2'],
      'heavy legs, light push': ['Heavy Legs', 'Light Push'],
      'Full-body': ['Full Body'],
      'legday, restday': ['Legs', 'Rest'],
      'sholders, glutse': ['Shoulders', 'Glutes'],
      'push pull hot yoga legs': ['Push', 'Pull', 'Hot Yoga', 'Legs'],
      'run, swim, bike': ['Run', 'Swim', 'Bike'],
      'a push day': ['Push'],
    }
    for (const [text, expected] of Object.entries(cases)) assert.deepEqual(parseSplit(text), expected, text)
  })

  test('parseSplit: numbered lists and numbered labels', () => {
    const cases = {
      // List numbers are dropped, however they're written.
      '1. push 2. pull 3. legs 4. rest': ['Push', 'Pull', 'Legs', 'Rest'],
      '1) push 2) pull 3) legs': ['Push', 'Pull', 'Legs'],
      '1 push 2 pull 3 legs': ['Push', 'Pull', 'Legs'],
      '1: push, 2: pull, 3: legs, 4: rest': ['Push', 'Pull', 'Legs', 'Rest'],
      '1. PPL 2. rest': ['Push', 'Pull', 'Legs', 'Rest'],
      'day 1 push, day 2 pull, day 3 legs': ['Push', 'Pull', 'Legs'],
      'day 1: push, day 2: pull': ['Push', 'Pull'],
      'day1 push day2 pull': ['Push', 'Pull'],
      'push day 1, pull day 2': ['Push', 'Pull'],
      'week 1 push pull legs week 2 upper lower': ['Push', 'Pull', 'Legs', 'Upper', 'Lower'],
      // Numbers after a day are labels once one of them is ("1" always is).
      'push 1 pull 1 push 2 pull 2': ['Push 1', 'Pull 1', 'Push 2', 'Pull 2'],
      'upper 1 lower 1 upper 2 lower 2': ['Upper 1', 'Lower 1', 'Upper 2', 'Lower 2'],
      'push1 pull1 push 2 pull 2': ['Push 1', 'Pull 1', 'Push 2', 'Pull 2'],
      'push 1 pull': ['Push 1', 'Pull'],
      // The app's own "Push 1, Pull 2" text reads back unchanged.
      'Push 1, Pull 2': ['Push 1', 'Pull 2'],
      'Push 2, Pull 2': ['Push 2', 'Pull 2'],
      // Still counts.
      'push pull legs 2 rest': ['Push', 'Pull', 'Legs', 'Rest', 'Rest'],
      '1 push': ['Push'],
      '2 push 2 pull': ['Push', 'Push', 'Pull', 'Pull'],
    }
    for (const [text, expected] of Object.entries(cases)) assert.deepEqual(parseSplit(text), expected, text)
  })

  test('parseSplit: empty, junk and caps', () => {
    assert.deepEqual(parseSplit(''), [])
    assert.deepEqual(parseSplit('   , / ->'), [])
    assert.deepEqual(parseSplit(null), [])
    assert.deepEqual(parseSplit(42), [])
    assert.deepEqual(parseSplit('x2'), [])
    assert.deepEqual(parseSplit('constructor'), ['Constructor'])
    assert.equal(parseSplit('ppl x20').length, 30) // repeats are capped at 10
    assert.equal(parseSplit('ppl x9, ppl x9').length, 31) // at most 31 days
    assert.ok(parseSplit('supercalifragilistic '.repeat(10)).every((name) => name.length <= 40))
  })

  test('matchDayType: fuzzy day names', () => {
    const cases = {
      'shoulder day': 'shoulders', 'legs & abs': 'legs', 'Legs & Abs': 'legs', 'Full body': 'fullBody', 'day off': 'rest', Off: 'rest',
      'Upper A': 'upper', 'Push 2': 'push', 'Heavy Legs': 'legs', Quads: 'legs', HIIT: 'cardio', 'Glute day': 'glutes', abs: 'core',
      'Back & Biceps': 'back', Biceps: 'arms',
    }
    for (const [name, id] of Object.entries(cases)) assert.equal(matchDayType(name)?.id, id, name)
    for (const name of ['Yoga', 'Hot Yoga', '', null, 'constructor']) assert.equal(matchDayType(name), null, String(name))
  })

  test('dayTemplate: template days match the onboarding templates', () => {
    const today = '2026-09-23'
    const built = [...buildTemplate('ppl-r', today, counter()).routines, ...buildTemplate('bro', today, counter()).routines,
      ...buildTemplate('upper-lower', today, counter()).routines, ...buildTemplate('full-body', today, counter()).routines]
    for (const routine of built) {
      assert.deepEqual(shape(dayTemplate(routine.name, counter())), shape(routine.exercises), routine.name)
      assert.deepEqual(dayTemplate(routine.name, counter())[0].sets, routine.exercises[0].sets, routine.name)
    }
    assert.deepEqual(shape(dayTemplate('shoulder day', counter())), shape(built.find((r) => r.name === 'Shoulders').exercises))
  })

  test('dayTemplate: Core, Glutes and Cardio have 3-6 real exercises', () => {
    for (const name of ['Core', 'Glutes', 'Cardio']) {
      const rows = dayTemplate(name, counter())
      assert.ok(rows.length >= 3 && rows.length <= 6, name)
      for (const row of rows) {
        const entry = exerciseById(row.exerciseId)
        assert.ok(entry, row.exerciseId)
        assert.equal(row.name, entry.name)
        assert.equal(row.tracking, entry.tracking)
        assert.ok(row.sets.length >= 1)
      }
    }
    const cardio = dayTemplate('Cardio', counter())
    assert.deepEqual(cardio[0].sets, [{ type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: 1200, distanceM: null, rpe: null }])
    assert.equal(dayTemplate('Core', counter()).find((row) => row.exerciseId === 'plank').sets[0].durationSec, 60)
  })

  test('dayTemplate: a second focus adds a couple of exercises, capped at 8', () => {
    const legsAbs = dayTemplate('legs & abs', counter()).map((row) => row.exerciseId)
    assert.deepEqual(legsAbs.slice(0, 5), dayTemplate('Legs', counter()).map((row) => row.exerciseId))
    assert.deepEqual(legsAbs.slice(5), ['hanging-leg-raise', 'cable-crunch'])
    const chestTris = dayTemplate('Chest & Triceps', counter()).map((row) => row.exerciseId)
    assert.deepEqual(chestTris.slice(4), ['triceps-pushdown', 'overhead-cable-extension'])
    // Push already has pushdowns and overhead extensions: nothing is doubled.
    const pushTris = dayTemplate('Push & Triceps', counter()).map((row) => row.exerciseId)
    assert.equal(new Set(pushTris).size, pushTris.length)
    assert.ok(dayTemplate('Upper & Abs & Biceps & Calves', counter()).length <= 8)
  })

  test('dayTemplate: rest and custom names are empty; ids come from makeId', () => {
    assert.deepEqual(dayTemplate('Rest', counter()), [])
    assert.deepEqual(dayTemplate('Day off'), [])
    assert.deepEqual(dayTemplate('Hot Yoga', counter()), [])
    assert.deepEqual(dayTemplate(undefined), [])
    const rows = dayTemplate('Push', counter())
    assert.deepEqual(rows.map((row) => row.id), ['id1', 'id2', 'id3', 'id4', 'id5', 'id6'])
    assert.equal(new Set(dayTemplate('Legs', 'not a function').map((row) => row.id)).size, 5)
  })
})

// ---- units ---------------------------------------------------------------------------------

describe('units', () => {
  test('45 lb round-trips exactly', () => {
    const kg = toKg(45, 'lb')
    close(kg, 20.41165665, 1e-9)
    assert.equal(formatWeight(kg, 'lb'), '45 lb')
    assert.equal(formatWeight(kg, 'lb', { withUnit: false }), '45')
    assert.equal(formatWeight(fromKg(kg, 'lb') * LB, 'lb'), '45 lb')
    assert.equal(formatWeight(20.411657, 'lb'), '45 lb')
    assert.equal(formatWeight(102.5, 'kg'), '102.5 kg')
    assert.equal(formatWeight(100, 'kg'), '100 kg')
    assert.equal(formatWeight(null, 'kg'), '—')
    assert.equal(formatWeight('100', 'kg'), '—')
    assert.equal(formatWeight(1000, 'kg'), '1000 kg')
  })

  test('numbers, decimals and durations', () => {
    assert.equal(formatNumber(1.005), '1.01')
    assert.equal(formatNumber(2.5), '2.5')
    assert.equal(formatNumber(2.456, 1), '2.5')
    assert.equal(formatNumber(-0.001), '0')
    assert.equal(parseDecimal('12,5'), 12.5)
    assert.equal(parseDecimal(' 7 '), 7)
    assert.equal(parseDecimal('.5'), 0.5)
    assert.equal(parseDecimal(''), null)
    assert.equal(parseDecimal('abc'), null)
    assert.equal(parseDecimal('1.2.3'), null)
    assert.equal(parseDecimal(null), null)
    assert.equal(formatDuration(65), '1:05')
    assert.equal(formatDuration(0), '0:00')
    assert.equal(formatDuration(3723), '1:02:03')
    assert.equal(formatDuration(null), '—')
    assert.equal(parseDuration('1:30'), 90)
    assert.equal(parseDuration('1:02:03'), 3723)
    assert.equal(parseDuration('90'), 90)
    assert.equal(parseDuration(''), null)
    assert.equal(parseDuration('x'), null)
    assert.equal(parseDuration('1:2:3:4'), null)
  })

  test('distance, pace and volume', () => {
    assert.equal(toMeters(5, 'km'), 5000)
    close(toMeters(1, 'mi'), 1609.344)
    close(fromMeters(1609.344, 'mi'), 1)
    close(fromMeters(0.9144, 'yd'), 1)
    assert.equal(toMeters(null, 'km'), null)
    assert.equal(formatDistance(5000, 'km'), '5 km')
    assert.equal(formatDistance(400, 'm'), '400 m')
    assert.equal(formatDistance(5000, 'mi'), '3.11 mi')
    assert.equal(formatPace(300, 'km'), '5:00 /km')
    assert.equal(formatPace(300, 'mi'), '8:03 /mi')
    assert.equal(formatPace(0, 'km'), '—')
    assert.match(formatVolume(12450, 'kg'), /^12\D?450 kg$/)
    assert.match(formatVolume(12450.4, 'kg'), /^12\D?450 kg$/)
    assert.equal(formatVolume(0, 'lb'), '0 lb')
    assert.equal(formatVolume(null, 'kg'), '—')
  })
})

// ---- formulas ------------------------------------------------------------------------------

describe('e1RM and projections', () => {
  test('each formula at 100 kg × 5', () => {
    close(e1rm(100, 5), 112.5)
    close(e1rm(100, 5, 'brzycki'), 112.5)
    close(e1rm(100, 5, 'epley'), 116.6666667)
    close(e1rm(100, 5, 'lombardi'), 100 * 5 ** 0.1)
    close(e1rm(100, 5, 'lombardi'), 117.4618943)
    close(e1rm(100, 5, 'oconner'), 112.5)
    close(e1rm(100, 5, 'wathan'), 10000 / (48.8 + 53.8 * Math.exp(-0.375)))
    close(e1rm(100, 5, 'wathan'), 116.5825, 1e-3)
    close(e1rm(100, 5, 'unknown'), 112.5)
  })

  test('edge cases and RIR', () => {
    for (const formula of ['brzycki', 'epley', 'lombardi', 'oconner', 'wathan']) assert.equal(e1rm(100, 1, formula), 100)
    assert.equal(e1rm(100, 0), null)
    assert.equal(e1rm(100, 13), null)
    assert.equal(e1rm(0, 5), null)
    assert.equal(e1rm('100', 5), null)
    assert.equal(e1rm(100, '5'), null)
    close(e1rm(100, 12), 144)
    close(e1rm(100, 5, 'brzycki', 8, true), 120) // 5 + 2 RIR = 7 → 100 × 36 / 30
    close(e1rm(100, 10, 'brzycki', 6, true), 144) // 10 + 4 capped at 12
    close(e1rm(100, 5, 'brzycki', 8, false), 112.5)
    close(e1rm(100, 5, 'brzycki', null, true), 112.5)
  })

  test('projected table (Brzycki inverse)', () => {
    const table = { 1: 100, 2: 97, 3: 94, 4: 92, 5: 89, 6: 86, 7: 83, 8: 81, 9: 78, 10: 75, 12: 69 }
    for (const [reps, pct] of Object.entries(table)) assert.equal(Math.round(projectedWeight(100, Number(reps))), pct, `reps ${reps}`)
    close(projectedWeight(e1rm(100, 5), 5), 100)
    assert.equal(projectedWeight(100, 0), null)
    assert.equal(projectedWeight(null, 5), null)
  })
})

// ---- volume --------------------------------------------------------------------------------

describe('volume', () => {
  test('set volume per tracking type', () => {
    assert.equal(setVolume(set(100, 5), 'weight_reps'), 500)
    assert.equal(setVolume(set(null, 10), 'bodyweight_reps', 80, true), 800)
    assert.equal(setVolume(set(null, 10), 'bodyweight_reps', 80, false), 0)
    assert.equal(setVolume(set(null, 10), 'bodyweight_reps', null, true), 0)
    assert.equal(setVolume(set(null, 10), 'reps_only', 80, true), 0)
    assert.equal(setVolume(set(20, 5), 'weighted_bodyweight', 80, true), 500)
    assert.equal(setVolume(set(20, 5), 'weighted_bodyweight', null, true), 100)
    assert.equal(setVolume(set(20, 5), 'weighted_bodyweight', 80, false), 100)
    assert.equal(setVolume(set(30, 8), 'assisted_bodyweight', 80, true), 400)
    assert.equal(setVolume(set(90, 8), 'assisted_bodyweight', 80, true), 0)
    assert.equal(setVolume(set(30, 8), 'assisted_bodyweight', 80, false), 0)
    assert.equal(setVolume(set(20, null, { durationSec: 60 }), 'weight_duration'), 0)
    assert.equal(setVolume(set(null, null, { distanceM: 1000, durationSec: 300 }), 'distance_duration'), 0)
    assert.equal(setVolume(warm(60, 5), 'weight_reps'), 0)
    assert.equal(setVolume(set(100, 5, { done: false }), 'weight_reps'), 0)
    assert.equal(setVolume(set('100', '5'), 'weight_reps'), 0)
    assert.equal(setVolume(set(100, 5, { type: 'drop' }), 'weight_reps'), 500)
    assert.equal(setVolume(null, 'weight_reps'), 0)
  })

  test('session totals use bodyweight and bwVolume', () => {
    const s = session('v1', '2026-09-01', [
      ex('bench-press', [warm(60, 5), set(100, 5), set(100, 5, { type: 'failure' })]),
      ex('pull-up', [set(null, 10)]),
      ex('push-up', [set(null, 20)]), // no bwVolume
      ex('assisted-dip', [set(20, 10)]),
    ], { bodyweightKg: 80 })
    assert.equal(sessionVolume(s), 1000 + 800 + 0 + 600)
    assert.equal(sessionVolume(s, (id) => exerciseById(id)), 2400)
    assert.equal(sessionVolume(s, null), 1000)
    assert.equal(sessionVolume({ ...s, bodyweightKg: null }), 1000)
    assert.equal(sessionWorkingSets(s), 5)
    assert.equal(sessionReps(s), 5 + 5 + 10 + 20 + 10)
    assert.equal(sessionDurationSec(s), 3600)
    assert.equal(sessionDurationSec({ ...s, durationSec: null }), 3600)
    assert.equal(sessionDurationSec({ startedAt: null }), null)
    assert.ok(isWorking(set(1, 1)) && !isWorking(warm(1, 1)) && !isWorking(set(1, 1, { done: false })) && !isWorking(null))
  })
})

// ---- records and PRs -----------------------------------------------------------------------

describe('PRs and records', () => {
  const s1 = session('p1', '2026-09-01', [ex('bench-press', [warm(60, 5), set(100, 5), set(100, 5)])])
  const s2 = session('p2', '2026-09-03', [ex('bench-press', [set(100, 5), set(100, 5)])]) // exact tie
  const s3 = session('p3', '2026-09-05', [ex('bench-press', [set(102.5, 5), set(100, 5)])])
  const s4 = session('p4', '2026-09-07', [ex('bench-press', [warm(150, 1), set(100, 3)])]) // heavy warm-up only
  const s5 = session('p5', '2026-09-09', [ex('bench-press', [set(105, 3), set(100, 3, { done: false })])])
  const all = [s5, s3, s1, s4, s2]
  const types = (prs) => prs.map((p) => p.label).sort()

  test('first session sets the baseline, ties are not PRs', () => {
    assert.deepEqual(sessionPRs(all, s1), [])
    assert.deepEqual(sessionPRs(all, s2), [])
  })

  test('strictly greater values are PRs', () => {
    const prs = sessionPRs(all, s3)
    assert.deepEqual(types(prs), ['5RM', 'Session volume', 'Volume', 'Weight', 'e1RM'].sort())
    const e1 = prs.find((p) => p.type === 'e1rm')
    close(e1.value, 102.5 * 36 / 32)
    assert.equal(e1.exerciseId, 'bench-press')
    assert.equal(e1.name, 'Bench Press (Barbell)')
    assert.equal(prs.find((p) => p.type === 'repMax').reps, 5)
    assert.equal(prs.find((p) => p.type === 'sessionVolume').value, 1012.5)
  })

  test('warm-ups and unticked sets never count', () => {
    assert.deepEqual(sessionPRs(all, s4), []) // 150 kg warm-up ignored; first 3-rep set is only a baseline
    const prs = sessionPRs(all, s5)
    assert.deepEqual(types(prs), ['3RM', 'Weight'])
    assert.equal(prs.find((p) => p.type === 'repMax').value, 105)
  })

  test('computeRecords keeps the first session that reached a value', () => {
    const r = computeRecords(all, 'bench-press', 'weight_reps')
    assert.deepEqual(r.heaviest, { value: 105, date: '2026-09-09', sessionId: 'p5' })
    assert.deepEqual(r.repMax[5], { value: 102.5, weightKg: 102.5, reps: 5, date: '2026-09-05', sessionId: 'p3' })
    assert.equal(r.repMax[3].weightKg, 105)
    assert.equal(r.repMax[1], undefined)
    const early = computeRecords([s2, s1], 'bench-press', 'weight_reps')
    assert.equal(early.heaviest.sessionId, 'p1') // tie keeps the earlier session
    assert.equal(early.sessionVolume.value, 1000)
    assert.equal(r.mostReps, null) // not a weight_reps record
    assert.equal(computeRecords(all, 'bench-press').heaviest.value, 105) // tracking inferred
    assert.equal(computeRecords([], 'bench-press', 'weight_reps').heaviest, null)
  })

  test('earlier = by date, then startedAt', () => {
    const morning = session('m1', '2026-09-10', [ex('bench-press', [set(110, 5)])], { startedAt: '2026-09-10T08:00:00.000Z' })
    const evening = session('m2', '2026-09-10', [ex('bench-press', [set(115, 5)])], { startedAt: '2026-09-10T18:00:00.000Z' })
    // Backfilled later but dated earlier: the date decides.
    const backfill = session('m3', '2026-09-08', [ex('bench-press', [set(90, 5)])], { startedAt: '2026-09-20T18:00:00.000Z' })
    const list = [evening, morning, backfill, ...all]
    assert.ok(types(sessionPRs(list, evening)).includes('Weight'))
    assert.ok(types(sessionPRs(list, morning)).includes('Weight'))
    assert.deepEqual(sessionPRs(list, backfill), [])
    assert.ok(compareSessions(morning, evening) < 0 && compareSessions(backfill, morning) < 0)
    // An unsaved copy (no id) is compared with everything earlier.
    const draft = { ...evening, id: undefined }
    assert.ok(types(sessionPRs(list, draft)).includes('Weight'))
  })

  test('live PR labels for a just-ticked set', () => {
    const saved = [s1, s2, s3]
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', set(105, 5)), ['Weight', 'e1RM', '5RM', 'Volume'])
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', set(102.5, 5)), [])
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', set(80, 6)), []) // 480 kg of volume, e1RM 92.9, no 6-rep baseline
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', set(80, 12)), ['Volume']) // 960 > 512.5
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', warm(200, 5)), [])
    assert.deepEqual(livePRs(saved, 'bench-press', 'weight_reps', set(200, 5, { done: false })), [])
    assert.deepEqual(livePRs([], 'bench-press', 'weight_reps', set(200, 5)), [])
  })

  test('bodyweight, assisted and cardio records', () => {
    const a = session('b1', '2026-09-01', [ex('pull-up', [set(null, 8), set(null, 6)]), ex('assisted-pull-up', [set(30, 8)]), ex('treadmill', [set(null, null, { distanceM: 5000, durationSec: 1500 })])])
    const b = session('b2', '2026-09-03', [ex('pull-up', [set(null, 9), set(null, 4)]), ex('assisted-pull-up', [set(25, 8), set(20, 6)]), ex('treadmill', [set(null, null, { distanceM: 5000, durationSec: 1450 }), set(null, null, { distanceM: 300, durationSec: 30 })])])
    const prs = sessionPRs([a, b], b)
    const byExercise = (id) => types(prs.filter((p) => p.exerciseId === id))
    assert.deepEqual(byExercise('pull-up'), ['Reps']) // 9 > 8; session reps 13 < 14
    assert.deepEqual(byExercise('assisted-pull-up'), ['Assist ×8', 'Session reps']) // 6-rep count has no baseline; 14 > 8 reps
    assert.deepEqual(byExercise('treadmill'), ['Pace']) // the 300 m set is too short for pace
    const r = computeRecords([a, b], 'treadmill', 'distance_duration')
    assert.equal(r.bestPace.value, 290)
    assert.equal(r.longestDistance.value, 5000)
    assert.equal(r.longestDistance.sessionId, 'b1')
    assert.deepEqual(computeRecords([a, b], 'assisted-pull-up', 'assisted_bodyweight').leastAssist[8].value, 25)
    assert.equal(computeRecords([a, b], 'pull-up', 'bodyweight_reps').sessionReps.value, 14)
    assert.deepEqual(livePRs([a, b], 'assisted-pull-up', 'assisted_bodyweight', set(15, 6)), ['Assist ×6'])
  })

  test('bestSet picks the top set per tracking type', () => {
    assert.equal(bestSet(ex('bench-press', [set(100, 5), set(110, 1), set(90, 10)])).reps, 10) // e1RM 120 beats 112.5 and 110
    assert.equal(bestSet(ex('bench-press', [set(50, 5), set(100, 15)])).weightKg, 100)
    assert.equal(bestSet(ex('bench-press', [warm(200, 5), set(60, 5)])).weightKg, 60)
    assert.equal(bestSet(ex('pull-up', [set(null, 8), set(null, 12), set(null, 10)])).reps, 12)
    assert.equal(bestSet(ex('plank', [set(null, null, { durationSec: 60 }), set(null, null, { durationSec: 75 })])).durationSec, 75)
    assert.equal(bestSet(ex('assisted-pull-up', [set(30, 8), set(20, 8)])).weightKg, 20)
    assert.equal(bestSet(ex('bench-press', [])), null)
    assert.equal(bestSet(null), null)
  })

  test('history and previous sets', () => {
    const hist = exerciseHistory(all, 'bench-press')
    assert.deepEqual(hist.map((h) => h.session.id), ['p5', 'p4', 'p3', 'p2', 'p1'])
    const r1 = session('r1', '2026-09-10', [ex('bench-press', [warm(60, 5), set(100, 5)])], { routineId: 'push' })
    const r2 = session('r2', '2026-09-12', [ex('bench-press', [set(80, 10)])], { routineId: 'upper' })
    const list = [r1, r2]
    assert.deepEqual(previousSets(list, 'bench-press').map((s) => [s.type, s.weightKg, s.reps]), [['normal', 80, 10]])
    assert.deepEqual(previousSets(list, 'bench-press', { routineId: 'push', source: 'routine' }).map((s) => [s.type, s.weightKg]), [['warmup', 60], ['normal', 100]])
    assert.deepEqual(previousSets(list, 'bench-press', { routineId: 'push', source: 'any' })[0].weightKg, 80)
    assert.equal(previousSets(list, 'bench-press', { routineId: 'legs', source: 'routine' }), null)
    assert.equal(previousSets(list, 'deadlift'), null)
    assert.equal(previousSets(null, 'deadlift', null), null)
  })
})

// ---- progression ---------------------------------------------------------------------------

describe('progression (double progression)', () => {
  const bench = exerciseById('bench-press')
  const squat = exerciseById('back-squat')
  const prefs = { unit: 'kg', progression: true }
  const benchRoutine = routineEx('bench-press', 8, 12)
  const squatRoutine = routineEx('back-squat', 8, 10)

  test('rule 2: every set at the top of the range adds the increment', () => {
    const last = session('g1', '2026-09-01', [ex('bench-press', [warm(40, 10), set(60, 12), set(60, 12), set(60, 13)])])
    const s = suggestNext([last], benchRoutine, bench, prefs)
    assert.equal(s.weightKg, 62.5)
    assert.equal(s.reps, 8)
    assert.equal(s.increased, true)
    assert.equal(s.deload, false)
    assert.equal(s.sets.length, 3)
    const lb = suggestNext([last], benchRoutine, bench, { unit: 'lb' })
    close(lb.weightKg, 60 + 5 * LB)
    const squatLast = session('g2', '2026-09-01', [ex('back-squat', [set(100, 10), set(100, 10)])])
    assert.equal(suggestNext([squatLast], squatRoutine, squat, prefs).weightKg, 105)
    close(suggestNext([squatLast], squatRoutine, squat, { unit: 'lb' }).weightKg, 100 + 10 * LB)
    assert.equal(suggestNext([squatLast], squatRoutine, squat, prefs, { increment: 1 }).weightKg, 101)
    // Fixed reps (lo === hi)
    const fixed = routineEx('back-squat', 5, 5)
    const fiveByFive = session('g3', '2026-09-01', [ex('back-squat', [set(100, 5), set(100, 5), set(100, 5)])])
    assert.deepEqual([suggestNext([fiveByFive], fixed, squat, prefs).weightKg, suggestNext([fiveByFive], fixed, squat, prefs).reps], [105, 5])
  })

  test('rule 3: same weight, one more rep per set up to the top', () => {
    const last = session('g4', '2026-09-01', [ex('bench-press', [set(60, 10), set(60, 9), set(60, 12)])])
    const s = suggestNext([last], benchRoutine, bench, prefs)
    assert.deepEqual({ weightKg: s.weightKg, reps: s.reps, increased: s.increased, deload: s.deload }, { weightKg: 60, reps: 11, increased: false, deload: false })
    assert.deepEqual(s.sets.map((x) => x.reps), [11, 10, 12])
  })

  test('rule 1: three stalled sessions at the same top weight deload', () => {
    const stalled = [
      session('d1', '2026-09-01', [ex('back-squat', [set(100, 8), set(100, 7)])]),
      session('d2', '2026-09-03', [ex('back-squat', [set(100, 7), set(100, 6)])]),
      session('d3', '2026-09-05', [ex('back-squat', [set(100, 8), set(100, 7)])]),
    ]
    const s = suggestNext(stalled, squatRoutine, squat, prefs)
    assert.deepEqual({ weightKg: s.weightKg, reps: s.reps, increased: s.increased, deload: s.deload }, { weightKg: 90, reps: 8, increased: false, deload: true })
    const lb = suggestNext(stalled, squatRoutine, squat, { unit: 'lb' })
    close(lb.weightKg / LB, 195) // 100 kg ≈ 220.46 lb × 0.9 = 198.4 → 195 lb
    // Only two stalled sessions → rule 3.
    assert.equal(suggestNext(stalled.slice(1), squatRoutine, squat, prefs).deload, false)
    // A different top weight in one of them → no deload.
    const moved = [session('d0', '2026-09-01', [ex('back-squat', [set(97.5, 7)])]), ...stalled.slice(1)]
    assert.equal(suggestNext(moved, squatRoutine, squat, prefs).deload, false)
  })

  test('deload sessions are ignored', () => {
    const history = [
      session('i1', '2026-09-01', [ex('bench-press', [set(60, 12), set(60, 12)])]),
      session('i2', '2026-09-08', [ex('bench-press', [set(52.5, 6)])], { isDeload: true }),
    ]
    const s = suggestNext(history, benchRoutine, bench, prefs)
    assert.equal(s.weightKg, 62.5)
    assert.equal(s.increased, true)
    assert.equal(suggestNext([history[1]], benchRoutine, bench, prefs), null)
  })

  test('other tracking types, off switch and no history', () => {
    const pull = session('o1', '2026-09-01', [ex('pull-up', [set(null, 8), set(null, 7)]), ex('plank', [set(null, null, { durationSec: 60 })]), ex('treadmill', [set(null, null, { distanceM: 5000, durationSec: 1500 })])])
    const up = suggestNext([pull], routineEx('pull-up', 6, 10), exerciseById('pull-up'), prefs)
    assert.deepEqual([up.weightKg, up.reps, up.sets.map((x) => x.reps)], [null, 9, [9, 8]])
    const plank = suggestNext([pull], newRoutineExercise(exerciseById('plank'), counter()), exerciseById('plank'), prefs)
    assert.equal(plank.durationSec, 65)
    assert.equal(suggestNext([pull], newRoutineExercise(exerciseById('treadmill'), counter()), exerciseById('treadmill'), prefs), null)
    assert.equal(suggestNext([pull], routineEx('pull-up', 6, 10), exerciseById('pull-up'), { progression: false }), null)
    assert.equal(suggestNext([], benchRoutine, bench, prefs), null)
    assert.equal(suggestNext(null, null, null, null), null)
  })

  test('increment and load step tables', () => {
    const byId = (id) => exerciseById(id)
    assert.equal(increment(byId('back-squat'), 'kg'), 5)
    assert.equal(increment(byId('deadlift'), 'kg'), 5) // lower_back primary
    assert.equal(increment(byId('bench-press'), 'kg'), 2.5)
    assert.equal(increment(byId('smith-squat'), 'kg'), 5)
    assert.equal(increment(byId('dumbbell-curl'), 'kg'), 2)
    assert.equal(increment(byId('kettlebell-swing'), 'kg'), 4)
    assert.equal(increment(byId('leg-press'), 'kg'), 5)
    assert.equal(increment(byId('lat-pulldown'), 'kg'), 5)
    close(increment(byId('back-squat'), 'lb'), 10 * LB)
    close(increment(byId('bench-press'), 'lb'), 5 * LB)
    close(increment(byId('dumbbell-curl'), 'lb'), 5 * LB)
    assert.equal(increment(byId('bench-press'), 'kg', { increment: 1.25 }), 1.25)
    assert.equal(loadStep(byId('bench-press'), 'kg'), 2.5)
    assert.equal(loadStep(byId('dumbbell-curl'), 'kg'), 2)
    assert.equal(loadStep(byId('kettlebell-swing'), 'kg'), 4)
    assert.equal(loadStep(byId('cable-curl'), 'kg'), 5)
    close(loadStep(byId('leg-press'), 'lb'), 10 * LB)
    assert.equal(loadStep(null, 'kg'), 2.5)
    assert.equal(roundDown(92, 2.5), 90)
    assert.equal(roundDown(90, 2.5), 90)
    assert.equal(roundDown(100 * 0.7, 2.5), 70)
    assert.equal(roundDown(null, 2.5), null)
    assert.equal(roundDown(7, 0), 7)
  })

  test('deload targets', () => {
    const schedule = emptySchedule()
    const make = (count, weightKg, rpe = null) => ({
      ...routineEx('bench-press', 8, 12, count, weightKg),
      sets: [{ type: 'warmup', weightKg: 40, repsMin: 10, repsMax: 10, durationSec: null, distanceM: null, rpe: null },
        ...Array.from({ length: count }, () => ({ type: 'normal', weightKg, repsMin: 8, repsMax: 12, durationSec: null, distanceM: null, rpe }))],
    })
    const counts = [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]]
    for (const [n, kept] of counts) assert.equal(deloadTargets(make(n, 100), bench, schedule, prefs).sets.filter((s) => s.type !== 'warmup').length, kept, `n=${n}`)
    const out = deloadTargets(make(3, 62.5, 8), bench, schedule, prefs)
    assert.equal(out.sets[0].type, 'warmup')
    assert.equal(out.sets[0].weightKg, 40) // warm-ups untouched
    assert.equal(out.sets[1].weightKg, 55) // 56.25 → 55
    assert.equal(out.sets[1].rpe, 5)
    assert.equal(deloadTargets(make(1, 100, 9), bench, schedule, prefs).sets[1].rpe, 6)
    assert.equal(deloadTargets(make(1, 100), bench, schedule, prefs).sets[1].weightKg, 90)
    const original = make(3, 100)
    deloadTargets(original, bench, schedule, prefs)
    assert.equal(original.sets.length, 4) // input untouched
    assert.equal(deloadTargets(make(1, 100), bench, { deload: { setsFactor: 1, weightFactor: 0.8 } }, prefs).sets[1].weightKg, 80)
    assert.equal(deloadTargets(null, bench, schedule, prefs), null)
  })

  test('deload weight: one rule for targets, the Today list and workout placeholders', () => {
    const schedule = emptySchedule()
    assert.equal(deloadWeight(80, bench, 'weight_reps', schedule, prefs), 70) // 80 × 0.9 = 72, rounded down to the 2.5 step
    assert.equal(deloadWeight(62.5, bench, 'weight_reps', schedule, prefs), 55)
    assert.equal(deloadWeight(100, bench, 'weight_reps', { deload: { weightFactor: 0.8 } }, prefs), 80)
    assert.equal(deloadWeight(100, bench, 'weight_reps', { deload: { weightFactor: 7 } }, prefs), 90) // invalid factor: 0.9
    assert.equal(deloadWeight(2.5, bench, 'weight_reps', schedule, prefs), 2.5) // never below one step
    assert.equal(deloadWeight(20, exerciseById('weighted-dip'), 'weighted_bodyweight', schedule, prefs), 17.5)
    assert.equal(deloadWeight(30, exerciseById('assisted-pull-up'), 'assisted_bodyweight', schedule, prefs), 30) // assistance untouched
    assert.equal(deloadWeight(null, bench, 'weight_reps', schedule, prefs), null)
    assert.equal(deloadWeight(0, bench, 'weight_reps', schedule, prefs), 0)
    // deloadTargets uses the same rule.
    const row = routineEx('bench-press', 8, 12, 2, 80)
    assert.equal(deloadTargets(row, bench, schedule, prefs).sets[0].weightKg, deloadWeight(80, bench, 'weight_reps', schedule, prefs))
  })

  test('planned weight: suggestion, else previous top, else target; lighter in a deload week', () => {
    const schedule = emptySchedule()
    const plain = routineEx('bench-press', 8, 12) // template routines have no target weight
    const history = [session('p1', '2026-09-01', [ex('bench-press', [warm(40, 10), set(80, 10), set(77.5, 9)])])]
    // Progression suggestion first (same weight, one more rep).
    assert.deepEqual(plannedWeight(history, plain, bench, prefs, null), { weightKg: 80, source: 'suggestion', deloaded: false })
    // Deload week: the same number, lightened (80 × 0.9 = 72, rounded down to 70).
    const deload = { deload: true, schedule }
    assert.deepEqual(plannedWeight(history, plain, bench, prefs, null, deload), { weightKg: 70, source: 'suggestion', deloaded: true })
    // Progression off: the previous top working weight (warm-ups ignored).
    const off = { ...prefs, progression: false }
    assert.deepEqual(plannedWeight(history, plain, bench, off, null), { weightKg: 80, source: 'previous', deloaded: false })
    assert.deepEqual(plannedWeight(history, plain, bench, off, null, deload), { weightKg: 70, source: 'previous', deloaded: true })
    // No history: the routine target; in a deload week that target is already deload-adjusted.
    const targeted = routineEx('bench-press', 8, 12, 3, 100)
    assert.deepEqual(plannedWeight([], targeted, bench, prefs, null), { weightKg: 100, source: 'target', deloaded: false })
    assert.deepEqual(plannedWeight([], targeted, bench, prefs, null, deload), { weightKg: 90, source: 'target', deloaded: false })
    assert.deepEqual(plannedWeight([], plain, bench, prefs, null, deload), { weightKg: null, source: 'target', deloaded: false })
    // A suggestion or previous sets computed already are reused.
    assert.equal(plannedWeight([], plain, bench, prefs, null, { suggestion: { weightKg: 50 } }).weightKg, 50)
    assert.equal(plannedWeight([], plain, bench, prefs, null, { suggestion: null, previous: [set(60, 5)] }).weightKg, 60)
    // Assisted: the first working set's assistance, never lightened.
    const assisted = exerciseById('assisted-pull-up')
    const assistedHistory = [session('p2', '2026-09-01', [ex('assisted-pull-up', [set(30, 8), set(40, 6)])])]
    const assistedRow = routineEx('assisted-pull-up', 6, 10)
    assert.deepEqual(plannedWeight(assistedHistory, assistedRow, assisted, off, null, deload), { weightKg: 30, source: 'previous', deloaded: false })
    // No weight column: nothing.
    assert.deepEqual(plannedWeight(history, routineEx('pull-up', 6, 10), exerciseById('pull-up'), prefs, null), { weightKg: null, source: 'target', deloaded: false })
    // Same-routine previous source.
    const mixed = [
      session('p3', '2026-09-01', [ex('bench-press', [set(70, 8)])], { routineId: 'push' }),
      session('p4', '2026-09-03', [ex('bench-press', [set(50, 8)])], { routineId: 'upper' }),
    ]
    const sameRoutine = { ...off, previousSource: 'routine' }
    assert.equal(plannedWeight(mixed, plain, bench, sameRoutine, null, { routineId: 'push' }).weightKg, 70)
    assert.equal(plannedWeight(mixed, plain, bench, off, null, { routineId: 'push' }).weightKg, 50)
    assert.doesNotThrow(() => plannedWeight(null, null, null, null, null, null))
  })
})

// ---- plate calculator ----------------------------------------------------------------------

describe('plate calculator', () => {
  const kg = { unit: 'kg', barKg: 20, collarKg: 0, plates: [25, 20, 15, 10, 5, 2.5, 1.25], pairs: null }
  const none = { 25: 0, 20: 0, 15: 0, 10: 0, 5: 0, 2.5: 0, 1.25: 0 }

  test('unlimited plates: greedy, heaviest first', () => {
    assert.deepEqual(plateBreakdown(100, kg), { perSide: [25, 15], exact: true, below: null, above: null, belowBar: false })
    assert.deepEqual(plateBreakdown(102.5, kg).perSide, [25, 15, 1.25])
    assert.deepEqual(plateBreakdown(20, kg), { perSide: [], exact: true, below: null, above: null, belowBar: false })
    assert.deepEqual(plateBreakdown(180, kg).perSide, [25, 25, 25, 5])
    assert.deepEqual(plateBreakdown(105, { ...kg, collarKg: 2.5 }).perSide, [25, 15])
    assert.deepEqual(plateBreakdown(100, { unit: 'kg' }).perSide, [25, 15]) // defaults
  })

  test('no exact load: closest below and above', () => {
    const r = plateBreakdown(101, kg)
    assert.equal(r.exact, false)
    assert.deepEqual(r.perSide, [])
    assert.deepEqual(r.below, { total: 100, totalKg: 100, perSide: [25, 15] })
    assert.deepEqual(r.above, { total: 102.5, totalKg: 102.5, perSide: [25, 15, 1.25] })
  })

  test('limited pairs: bounded DP with the fewest plates', () => {
    // Greedy would load 25 + 10 + 5; the DP finds 20 + 20.
    assert.deepEqual(plateBreakdown(100, { ...kg, pairs: { ...none, 25: 1, 20: 2, 10: 4, 5: 4 } }).perSide, [20, 20])
    // Greedy takes the 25 and gets stuck; 15 + 15 is exact.
    const r = plateBreakdown(80, { ...kg, pairs: { ...none, 25: 1, 15: 2 } })
    assert.equal(r.exact, true)
    assert.deepEqual(r.perSide, [15, 15])
    // Not enough plates: below = everything, nothing above.
    const short = plateBreakdown(100, { ...kg, pairs: { ...none, 25: 1 } })
    assert.equal(short.exact, false)
    assert.deepEqual(short.below, { total: 70, totalKg: 70, perSide: [25] })
    assert.equal(short.above, null)
    // Zero pairs of a size: it isn't used.
    assert.deepEqual(plateBreakdown(60, { ...kg, pairs: { ...none, 10: 2 } }).perSide, [10, 10])
  })

  test('limited pairs: a size missing from the map counts as 2 pairs', () => {
    // What turning on "Limited plates" seeds, so a size added later is usable straight away.
    assert.deepEqual(plateBreakdown(60, { ...kg, pairs: { 10: 2 } }).perSide, [20])
    assert.deepEqual(plateBreakdown(140, { ...kg, pairs: { 10: 2 } }).perSide, [25, 25, 10])
    // Two of each size per side tops out at 2 × (25 + 20 + 15 + 10 + 5 + 2.5 + 1.25) = 157.5 kg a side.
    assert.equal(plateBreakdown(400, { ...kg, pairs: {} }).exact, false)
    assert.equal(plateBreakdown(335, { ...kg, pairs: {} }).exact, true)
    // Counts seeded in kg mode don't make the lb-only sizes (45, 35) unusable after switching.
    const seededInKg = { 25: 2, 20: 2, 15: 2, 10: 2, 5: 2, 2.5: 2, 1.25: 2 }
    const lb = { unit: 'lb', barKg: 45 * LB, plates: [45, 35, 25, 10, 5, 2.5], pairs: seededInKg }
    assert.deepEqual(plateBreakdown(toKg(225, 'lb'), lb).perSide, [45, 45])
    assert.deepEqual(plateBreakdown(toKg(295, 'lb'), lb).perSide, [45, 45, 35])
    // Junk counts still read as none.
    assert.deepEqual(plateBreakdown(60, { ...kg, pairs: { ...none, 20: 'x', 10: 2 } }).perSide, [10, 10])
  })

  test('below bar weight', () => {
    assert.deepEqual(plateBreakdown(15, kg), { perSide: [], exact: false, below: null, above: null, belowBar: true })
  })

  test('landmine: one sleeve carries the whole load', () => {
    const bar = barFor(exerciseById('landmine-press'), { unit: 'kg', bars: { olympic: 20, landmine: 0 } })
    assert.deepEqual(bar, { id: 'landmine', barKg: 0, sleeves: 1 })
    assert.deepEqual(plateBreakdown(40, { ...kg, barKg: bar.barKg, sleeves: bar.sleeves }).perSide, [25, 15])
    // One sleeve can take both plates of a pair.
    assert.deepEqual(plateBreakdown(40, { ...kg, barKg: 0, sleeves: 1, pairs: { ...none, 20: 1 } }).perSide, [20, 20])
  })

  test('lb mode with the 45 lb bar', () => {
    const prefs = { unit: 'lb', bars: { olympic: 20, womens: 15, ez: 10, trap: 25, smith: 15, landmine: 0 } }
    const bar = barFor(exerciseById('bench-press'), prefs)
    close(bar.barKg, 45 * LB)
    const r = plateBreakdown(toKg(225, 'lb'), { unit: 'lb', barKg: bar.barKg, plates: [45, 35, 25, 10, 5, 2.5], pairs: null })
    assert.deepEqual(r.perSide, [45, 45])
    assert.deepEqual(plateBreakdown(toKg(230, 'lb'), { unit: 'lb', barKg: bar.barKg }).perSide, [45, 45, 2.5])
    assert.equal(barFor(exerciseById('smith-squat'), prefs).id, 'smith')
    assert.equal(barFor(exerciseById('ez-bar-curl'), { unit: 'kg', bars: { ez: 12 } }).barKg, 12)
    assert.equal(barFor(exerciseById('trap-bar-deadlift'), { unit: 'kg' }).barKg, 25)
    assert.equal(barFor({ bar: 'constructor' }, null).id, 'olympic')
  })
})

// ---- warm-ups ------------------------------------------------------------------------------

describe('warm-up calculator', () => {
  const prefs = { unit: 'kg', bars: { olympic: 20 } }
  const rows = (list) => list.map((r) => [r.weightKg, r.reps])

  test('100 kg barbell', () => {
    const out = warmupSets(100, exerciseById('bench-press'), prefs)
    assert.ok(out.every((r) => r.type === 'warmup'))
    assert.deepEqual(rows(out), [[20, 10], [50, 5], [70, 3], [85, 2], [90, 1]])
    assert.deepEqual(rows(warmupSets(90, exerciseById('bench-press'), prefs)), [[20, 10], [45, 5], [62.5, 3], [75, 2]])
  })

  test('60 kg dumbbell (no bar row, 2 kg steps)', () => {
    assert.deepEqual(rows(warmupSets(60, exerciseById('dumbbell-bench-press'), prefs)), [[30, 5], [42, 3], [50, 2]])
  })

  test('light loads, other types and lb', () => {
    assert.deepEqual(rows(warmupSets(25, exerciseById('bench-press'), prefs)), [[20, 10]]) // < 1.5 × bar
    assert.deepEqual(rows(warmupSets(20, exerciseById('bench-press'), prefs)), [])
    assert.deepEqual(rows(warmupSets(40, exerciseById('bench-press'), prefs)), [[20, 10], [27.5, 3], [32.5, 2]]) // 50% clamps to the bar and is dropped
    assert.deepEqual(warmupSets(60, exerciseById('pull-up'), prefs), [])
    assert.deepEqual(warmupSets(null, exerciseById('bench-press'), prefs), [])
    const lb = warmupSets(toKg(225, 'lb'), exerciseById('bench-press'), { unit: 'lb' })
    assert.deepEqual(lb.map((r) => Math.round(r.weightKg / LB * 100) / 100), [45, 110, 155, 190, 205])
    const custom = warmupSets(100, exerciseById('bench-press'), { ...prefs, warmupScheme: [{ pct: 0.6, reps: 4 }] })
    assert.deepEqual(rows(custom), [[60, 4]])
  })
})

// ---- weekly aggregates ---------------------------------------------------------------------

describe('weekly stats across a year boundary', () => {
  const today = '2027-01-06' // Wednesday
  const quick = (id, date) => session(id, date, [], { startedAt: null, endedAt: null, durationSec: null })
  const sessions = [
    session('w1', '2026-12-15', [ex('bench-press', [set(100, 5)])]),
    session('w2', '2026-12-22', [ex('bench-press', [set(100, 5)])], { durationSec: 1800 }),
    quick('w3', '2026-12-29'),
    session('w4', '2027-01-04', [ex('back-squat', [set(100, 5), set(100, 5)])]),
    session('w5', '2027-01-05', [ex('bench-press', [set(50, 10)])], { durationSec: 1200 }),
  ]

  test('streak counts back from last week plus the current week', () => {
    assert.equal(streakWeeks(sessions, today, 1), 4) // Dec 14, 21, 28 + current
    assert.equal(streakWeeks(sessions.slice(0, 3), today, 1), 3) // current week empty: no break
    assert.equal(streakWeeks(sessions.filter((s) => s.id !== 'w2'), today, 1), 2)
    assert.equal(streakWeeks(sessions.slice(0, 2), today, 1), 0) // last week empty
    assert.equal(streakWeeks([], today, 1), 0)
    // Sunday-first: Dec 29 (Tue) and Jan 4 (Mon) sit in the weeks of Dec 27 and Jan 3.
    assert.equal(streakWeeks(sessions, today, 0), 4)
  })

  test('weekly counts, volume and minutes', () => {
    const weeks = weeklyCounts(sessions, today, 1, 4)
    assert.deepEqual(weeks.map((w) => w.weekStart), ['2026-12-14', '2026-12-21', '2026-12-28', '2027-01-04'])
    assert.deepEqual(weeks.map((w) => w.count), [1, 1, 1, 2])
    assert.deepEqual(weeks.map((w) => w.volumeKg), [500, 500, 0, 1500])
    assert.deepEqual(weeks.map((w) => w.minutes), [60, 30, 0, 80])
    assert.deepEqual(weeks.map((w) => w.timed), [1, 1, 0, 2])
    assert.equal(weeklyCounts(sessions, today, 1).length, 12)
    assert.deepEqual(weeklyCounts(sessions, today, 0, 2).map((w) => w.weekStart), ['2026-12-27', '2027-01-03'])
    assert.equal(weekProgress(sessions, today, 1), 2)
    assert.equal(weekProgress(sessions, '2027-01-03', 1), 1) // Sunday belongs to the week of Dec 28
    assert.equal(weekProgress(sessions, '2027-01-03', 0), 2) // Sunday-first: Jan 3–9 holds Jan 4 and 5
    assert.deepEqual(weeklyCounts(sessions, 'bad', 1), [])
  })

  test('sets per muscle: primary 1, secondary 0.5, cardio excluded', () => {
    const list = [
      session('m1', '2026-12-30', [ex('bench-press', [warm(60, 5), set(100, 5), set(100, 5), set(100, 5)]), ex('treadmill', [set(null, null, { distanceM: 5000, durationSec: 1500 })])]),
      session('m2', '2027-01-04', [ex('pull-up', [set(null, 8), set(null, 8)])]),
      session('m3', '2027-01-20', [ex('bench-press', [set(100, 5)])]),
    ]
    assert.deepEqual(weeklySetsByMuscle(list, '2026-12-28', '2027-01-10'), { chest: 3, triceps: 1.5, shoulders: 1.5, lats: 2, biceps: 1, upper_back: 1, forearms: 1 })
    assert.deepEqual(weeklySetsByMuscle(list, '2027-01-01', '2027-01-03'), {})
    const custom = [{ id: 'custom-1', primary: 'glutes', secondary: ['glutes', 'hamstrings', 'cardio'] }]
    const withCustom = [session('m4', '2027-01-05', [{ exerciseId: 'custom-1', sets: [set(20, 10)] }])]
    assert.deepEqual(weeklySetsByMuscle(withCustom, null, null, (id) => exerciseById(id, custom)), { glutes: 1, hamstrings: 0.5 })
  })

  test('top exercises by sessions', () => {
    const top = topExercises(sessions, 2)
    assert.deepEqual(top.map((t) => [t.exerciseId, t.count]), [['bench-press', 3], ['back-squat', 1]])
    assert.equal(top[0].lastDate, '2027-01-05')
    assert.equal(topExercises(sessions).length, 2)
  })
})

// ---- CSV -----------------------------------------------------------------------------------

describe('CSV export', () => {
  const header = 'date,start_time,end_time,workout_name,routine,exercise,exercise_id,superset,exercise_note,set_index,set_type,weight_kg,weight_lb,reps,rpe,distance_m,duration_s,session_note'
  // Minimal RFC 4180 reader for checking the output.
  function parse(csv) {
    const rows = [[]]
    let field = ''
    let quoted = false
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i]
      if (quoted) {
        if (c === '"' && csv[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
        else field += c
      } else if (c === '"') quoted = true
      else if (c === ',') { rows.at(-1).push(field); field = '' } else if (c === '\r' && csv[i + 1] === '\n') { rows.at(-1).push(field); field = ''; rows.push([]); i++ } else field += c
    }
    if (rows.at(-1).length === 0 && field === '') rows.pop()
    return rows
  }

  test('header, one row per set, escaping and weight_lb', () => {
    const start = new Date(2026, 8, 20, 17, 5).toISOString()
    const end = new Date(2026, 8, 20, 18, 10).toISOString()
    const s = session('c1', '2026-09-20', [
      ex('bench-press', [warm(20, 10), set(toKg(45, 'lb') + 40, 5, { rpe: 8.5 })], { note: 'Elbows "tucked", slow', supersetId: 'ss1' }),
      ex('treadmill', [set(null, null, { distanceM: 5000, durationSec: 1500 })], { supersetId: 'ss1' }),
    ], { name: 'Push, heavy', routineId: 'r-push', startedAt: start, endedAt: end, note: 'Line one\nline two' })
    const csv = sessionsToCsv([s, session('c0', '2026-09-18', [], { name: 'Quick', startedAt: null, endedAt: null })], 'kg', [{ id: 'r-push', name: 'Push' }])
    assert.ok(csv.startsWith(`${header}\r\n`))
    assert.ok(csv.endsWith('\r\n'))
    const rows = parse(csv)
    assert.equal(rows.length, 5)
    assert.ok(rows.every((r) => r.length === 18))
    assert.deepEqual(rows[1], ['2026-09-18', '', '', 'Quick', '', '', '', '', '', '', '', '', '', '', '', '', '', ''])
    assert.deepEqual(rows[2], ['2026-09-20', '17:05', '18:10', 'Push, heavy', 'Push', 'Bench Press (Barbell)', 'bench-press', 'A', 'Elbows "tucked", slow', '1', 'warmup', '20', '44.09', '10', '', '', '', 'Line one\nline two'])
    assert.deepEqual(rows[3].slice(9, 14), ['2', 'normal', '60.41', '133.18', '5'])
    assert.equal(rows[3][14], '8.5')
    assert.deepEqual(rows[4].slice(5, 17), ['Running (Treadmill)', 'treadmill', 'A', '', '1', 'normal', '', '', '', '', '5000', '1500'])
    assert.ok(csv.includes('"Push, heavy"') && csv.includes('"Elbows ""tucked"", slow"') && csv.includes('"Line one\nline two"'))
    const lbOnly = sessionsToCsv([session('c2', '2026-09-21', [ex('bench-press', [set(toKg(45, 'lb'), 5)])])], 'lb')
    assert.deepEqual(parse(lbOnly)[1].slice(11, 13), ['20.41', '45'])
    assert.equal(sessionsToCsv([], 'kg'), `${header}\r\n`)
  })
})

// ---- malformed data ------------------------------------------------------------------------

describe('backfilled workouts', () => {
  test('flagged, or created well after the start time they were given', () => {
    assert.equal(isBackfillWorkout({ backfill: true }), true)
    // Started for yesterday at noon, created this morning (started before the flag existed).
    assert.equal(isBackfillWorkout({ startedAt: '2026-09-22T12:00:00.000Z', createdAt: '2026-09-23T07:00:00.000Z' }), true)
    // A live workout: created when it started, even if it runs past midnight.
    assert.equal(isBackfillWorkout({ date: '2026-09-22', startedAt: '2026-09-22T23:30:00.000Z', createdAt: '2026-09-22T23:30:00.000Z' }), false)
    assert.equal(isBackfillWorkout({ backfill: false, startedAt: '2026-09-22T23:30:00.000Z', createdAt: '2026-09-22T23:30:30.000Z' }), false)
    assert.equal(isBackfillWorkout({ startedAt: 'junk', createdAt: '2026-09-23T07:00:00.000Z' }), false)
    assert.equal(isBackfillWorkout(null), false)
    assert.equal(isBackfillWorkout('x'), false)
  })
})

describe('malformed stored data never throws', () => {
  const junk = [
    null, 1, 'x', [], {},
    { exercises: 'no' },
    { date: 'not-a-date', exercises: [null, 'x', { sets: 'x' }, { exerciseId: 5, sets: [null] }] },
    { id: 'j1', date: '2026-09-01', exercises: [{ exerciseId: 'bench-press', tracking: 'constructor', sets: [null, 'x', { weightKg: '100', reps: '5', done: true }, { weightKg: 100, reps: 5, done: true, type: 'normal' }] }] },
    { id: 'j2', date: '2026-09-02', bodyweightKg: '80', exercises: [{ exerciseId: 'pull-up', sets: [{ reps: 'ten', done: true }] }] },
  ]

  test('every stats function tolerates junk sessions', () => {
    const sessions = junk
    assert.doesNotThrow(() => {
      for (const s of junk) {
        sessionVolume(s)
        sessionWorkingSets(s)
        sessionReps(s)
        sessionDurationSec(s)
        sessionPRs(sessions, s)
        bestSet(s?.exercises?.[0])
      }
      computeRecords(sessions, 'bench-press', 'weight_reps')
      computeRecords(sessions, 'bench-press', 'constructor')
      computeRecords('nope', 'bench-press')
      livePRs(sessions, 'bench-press', 'weight_reps', { weightKg: 200, reps: 1, done: true })
      exerciseHistory(sessions, 'bench-press')
      previousSets(sessions, 'bench-press')
      suggestNext(sessions, { exerciseId: 'bench-press', sets: 'x' }, null, {})
      suggestNext(sessions, { exerciseId: 'bench-press', sets: [{ repsMin: 8, repsMax: 12 }] }, null, {})
      deloadTargets({ sets: 'x' }, null, null, null)
      weeklySetsByMuscle(sessions, 1, 2, 'not a function')
      weeklyCounts(sessions, '2026-09-23', 'x', 'y')
      streakWeeks(sessions, '2026-09-23', 99)
      weekProgress(sessions, null, 1)
      topExercises(sessions, 'x')
      sessionsToCsv(sessions, 'kg', 'junk')
      estimateMinutes({ exercises: 'x' })
      plateBreakdown('x', null)
      plateBreakdown(100, { plates: 'x', pairs: { 25: 'x' } })
      warmupSets(100, null, null)
      e1rm(100, 5, 'constructor')
      bestSet({ tracking: 'constructor', sets: [{ weightKg: 100, reps: 5, done: true }] })
    })
    const records = computeRecords(sessions, 'bench-press', 'weight_reps')
    assert.equal(records.heaviest.value, 100) // the string-typed set is ignored
    assert.equal(computeRecords(sessions, 'bench-press', 'weight_reps').heaviest.sessionId, 'j1')
    assert.equal(sessionVolume(junk[7]), 500)
    assert.equal(sessionReps(junk[8]), 0)
    assert.equal(suggestNext(sessions, { exerciseId: 'bench-press', sets: [{ repsMin: 8, repsMax: 12 }] }, null, {}).weightKg, 100)
    assert.equal(plateBreakdown('x', null).exact, false)
    assert.ok(sessionsToCsv(sessions, 'kg').split('\r\n').length > 2)
  })
})

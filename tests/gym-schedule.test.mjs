import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import * as S from '../src/lib/gym/schedule.js'

// ---- fixtures ---------------------------------------------------------------------------------

const TODAY = '2026-09-23' // Wednesday
const R = (routineId) => ({ kind: 'routine', routineId })
const REST = { kind: 'rest' }
const ROUTINES = ['push', 'pull', 'legs', 'upper', 'lower', 'arms', 'chest']
  .map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), exercises: [] }))

const PAST = /only change today or future days/
const LOGGED = /already has a workout logged/

function label(slot) {
  if (slot.kind === 'routine') return ROUTINES.find((r) => r.id === slot.routineId)?.name || slot.routineId
  if (slot.kind === 'rest') return 'Rest'
  if (slot.kind === 'shifted') return 'SHIFTED'
  return 'none'
}
const gymOf = (schedule, extra = {}) => ({ schedule, routines: ROUTINES, prefs: { firstWeekday: 1 }, ...extra })
const range = (schedule, from, to, { sessions = [], today = TODAY, gym } = {}) => S.resolveRange(gym || gymOf(schedule), sessions, from, to, today)
const labels = (schedule, from, to, options) => range(schedule, from, to, options).map((day) => label(day.shown))
const day = (schedule, date, { sessions = [], today = TODAY, gym } = {}) => S.resolveDay(gym || gymOf(schedule), sessions, date, today)

// Rotation [Push, Pull, Legs, Rest] from Mon 2026-09-21, anchor 0.
const rotation = () => ({
  ...S.emptySchedule(),
  versions: [{ id: 'v1', effectiveFrom: '2026-09-21', mode: 'rotation', cycle: [R('push'), R('pull'), R('legs'), REST], anchorIndex: 0, weekly: [] }],
})
// Weekly: Sun Rest, Mon Push, Tue Pull, Wed Legs, Thu Rest, Fri Upper, Sat Lower.
const weeklyPlan = () => [REST, R('push'), R('pull'), R('legs'), REST, R('upper'), R('lower')]
const weekly = () => ({
  ...S.emptySchedule(),
  versions: [{ id: 'w1', effectiveFrom: '2026-09-21', mode: 'weekly', cycle: [], anchorIndex: 0, weekly: weeklyPlan() }],
})
// Weekly with no rest days (slot ids = weekday numbers) — makes the backlog visible.
const busyWeek = (id = 'b1', effectiveFrom = '2026-09-21') => ({ id, effectiveFrom, mode: 'weekly', cycle: [], anchorIndex: 0, weekly: [0, 1, 2, 3, 4, 5, 6].map((n) => R(`d${n}`)) })

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// Plain UTC reference helpers, independent of the module under test.
const refAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const refDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
const refWeekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const slotKey = (slot) => (slot.kind === 'routine' ? slot.routineId : slot.kind === 'shifted' ? 'SHIFTED' : slot.kind)

// The spec's pseudo-code, transcribed literally (including its unfiltered shiftsIn window).
function naivePlan(schedule, from, to) {
  const out = {}
  const shiftSet = new Set(schedule.shifts)
  const shiftsIn = (a, b) => schedule.shifts.some((s) => s >= a && s <= b)
  for (let d = from; d <= to; d = refAdd(d, 1)) out[d] = 'none'
  schedule.versions.forEach((v, i) => {
    const nextStart = schedule.versions[i + 1]?.effectiveFrom
    if (v.mode === 'rotation') {
      const n = v.cycle.length
      for (let d = v.effectiveFrom; d <= to && (!nextStart || d < nextStart); d = refAdd(d, 1)) {
        if (d < from) continue
        if (!n) { out[d] = 'none'; continue }
        if (shiftSet.has(d)) { out[d] = 'SHIFTED'; continue }
        const count = schedule.shifts.filter((s) => s >= v.effectiveFrom && s < d).length
        const k = v.anchorIndex + refDiff(v.effectiveFrom, d) - count
        out[d] = slotKey(v.cycle[((k % n) + n) % n])
      }
      return
    }
    let q = []
    for (let x = v.effectiveFrom; x <= to && (!nextStart || x < nextStart); x = refAdd(x, 1)) {
      if (!shiftsIn(refAdd(x, -6), refAdd(x, -1))) q = []
      q.push(v.weekly[refWeekday(x)])
      let shown
      if (shiftSet.has(x)) {
        shown = 'SHIFTED'
      } else {
        shown = slotKey(q.shift())
        q = q.filter((s) => s.kind !== 'rest')
      }
      if (x >= from) out[x] = shown
    }
  })
  return out
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- date helpers -----------------------------------------------------------------------------

describe('date helpers', () => {
  test('weekday, addDays and daysBetween are plain calendar math (DST-proof)', () => {
    assert.equal(S.weekday('2026-09-23'), 3)
    assert.equal(S.weekday('2026-03-08'), 0)
    assert.equal(S.weekday('2026-11-01'), 0)
    assert.equal(S.addDays('2026-03-07', 1), '2026-03-08')
    assert.equal(S.addDays('2026-03-08', 1), '2026-03-09')
    assert.equal(S.addDays('2026-03-09', -1), '2026-03-08')
    assert.equal(S.addDays('2026-10-31', 1), '2026-11-01')
    assert.equal(S.addDays('2026-11-01', 1), '2026-11-02')
    assert.equal(S.addDays('2026-11-02', -2), '2026-10-31')
    assert.equal(S.daysBetween('2026-03-01', '2026-03-31'), 30)
    assert.equal(S.daysBetween('2026-10-25', '2026-11-08'), 14)
    assert.equal(S.daysBetween('2026-11-08', '2026-10-25'), -14)
    assert.equal(S.addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(S.addDays('2028-02-28', 1), '2028-02-29')
    assert.equal(S.addDays('2100-02-28', 1), '2100-03-01')
    assert.equal(S.addDays('2000-02-28', 1), '2000-02-29')
    assert.equal(S.addDays('2026-09-23', 0), '2026-09-23')
    assert.equal(S.addDays('2026-09-23', 1.9), '2026-09-24')
    assert.equal(S.addDays('2026-09-23', 'x'), '2026-09-23')
  })

  test('early and late years round-trip; out-of-range and invalid input never throw', () => {
    assert.equal(S.addDays('0050-03-01', -1), '0050-02-28')
    assert.equal(S.addDays('0001-01-01', -1), '0000-12-31')
    assert.equal(S.weekday('0001-01-01'), 1) // proleptic Gregorian Monday
    assert.equal(S.addDays('0000-01-01', -1), null)
    assert.equal(S.addDays('9999-12-31', 1), null)
    assert.equal(S.addDays('bad', 1), null)
    assert.ok(Number.isNaN(S.daysBetween('2026-01-01', 'x')))
    assert.ok(Number.isNaN(S.weekday(null)))
    assert.equal(S.weekStart('2026-02-30'), null)
  })

  test('isIsoDate rejects impossible and non-string dates', () => {
    for (const ok of ['2026-09-23', '2028-02-29', '2000-02-29', '0000-01-01', '9999-12-31']) assert.equal(S.isIsoDate(ok), true, ok)
    for (const bad of ['2026-02-29', '2100-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-01-00', '2026-1-01', ' 2026-01-01',
      '2026-01-01T00:00', 20260101, null, undefined, {}, []]) assert.equal(S.isIsoDate(bad), false, String(bad))
  })

  test('mod and weekStart', () => {
    assert.equal(S.mod(-1, 4), 3)
    assert.equal(S.mod(5, 4), 1)
    assert.equal(S.mod(-8, 4), 0)
    assert.equal(S.weekStart('2026-09-23', 1), '2026-09-21')
    assert.equal(S.weekStart('2026-09-23'), '2026-09-21')
    assert.equal(S.weekStart('2026-09-23', 0), '2026-09-20')
    assert.equal(S.weekStart('2026-09-27', 1), '2026-09-21')
    assert.equal(S.weekStart('2026-09-27', 0), '2026-09-27')
    assert.equal(S.weekStart('2026-09-21', 1), '2026-09-21')
    assert.equal(S.weekStart('2026-09-23', 6), '2026-09-19')
    assert.equal(S.weekStart('2026-09-23', '0'), '2026-09-20')
    assert.equal(S.weekStart('2026-09-23', null), '2026-09-21')
  })

  test('gives identical answers whatever the process time zone is', () => {
    const snapshot = (M) => {
      const Rt = (id) => ({ kind: 'routine', routineId: id })
      const rest = { kind: 'rest' }
      const show = (d) => (d.shown.kind === 'routine' ? d.shown.routineId : d.shown.kind) + ':' + d.status
      const weeklyGym = { schedule: { versions: [{ id: 'w', effectiveFrom: '2026-03-02', mode: 'weekly', weekly: [rest, Rt('a'), Rt('b'), Rt('c'), rest, Rt('d'), Rt('e')] }], shifts: ['2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01'], deload: { everyWeeks: 3, programStart: '2026-03-04' } }, routines: [], prefs: { firstWeekday: 0 } }
      const rotationGym = { schedule: { versions: [{ id: 'r', effectiveFrom: '2026-03-01', mode: 'rotation', cycle: [Rt('a'), Rt('b'), rest], anchorIndex: 1 }], shifts: ['2026-03-08', '2026-11-01'] }, routines: [], prefs: {} }
      return {
        offset: new Date(2026, 0, 1).getTimezoneOffset(),
        weekday: M.weekday('2026-09-23'),
        dst: [M.addDays('2026-03-07', 1), M.addDays('2026-03-08', 1), M.addDays('2026-03-09', -1), M.addDays('2026-10-31', 1), M.addDays('2026-11-01', 1), M.addDays('2026-11-02', -1), M.daysBetween('2026-03-01', '2026-11-30')],
        weekStarts: [M.weekStart('2026-03-08', 1), M.weekStart('2026-11-01', 0), M.weekStart('2026-11-01', 1)],
        weeklySpring: M.resolveRange(weeklyGym, [], '2026-03-01', '2026-03-22', '2026-03-10').map(show),
        weeklyFall: M.resolveRange(weeklyGym, [], '2026-10-25', '2026-11-10', '2026-11-01').map(show),
        rotation: M.resolveRange(rotationGym, [], '2026-03-01', '2026-03-15', '2026-03-08').concat(M.resolveRange(rotationGym, [], '2026-10-28', '2026-11-05', '2026-11-01')).map(show),
        deload: M.resolveRange(weeklyGym, [], '2026-03-01', '2026-04-30', '2026-03-01').map((d) => d.deload),
        next: M.nextWorkout(rotationGym, [], '2026-11-01')?.date,
      }
    }
    const here = snapshot(S)
    assert.equal(here.weekday, 3)
    assert.deepEqual(here.dst, ['2026-03-08', '2026-03-09', '2026-03-08', '2026-11-01', '2026-11-02', '2026-11-01', 274])
    assert.deepEqual(here.weekStarts, ['2026-03-02', '2026-11-01', '2026-10-26'])
    const moduleUrl = new URL('../src/lib/gym/schedule.js', import.meta.url).href
    const script = `const M = await import(${JSON.stringify(moduleUrl)}); const snapshot = ${snapshot.toString()}; process.stdout.write(JSON.stringify(snapshot(M)))`
    const offsets = new Set()
    for (const tz of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
      const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }))
      offsets.add(out.offset)
      assert.deepEqual({ ...out, offset: 0 }, { ...here, offset: 0 }, tz)
    }
    assert.ok(offsets.size > 1, 'child processes should really run in different time zones')
  })
})

// ---- worked tests from the spec ---------------------------------------------------------------

describe('worked tests: rotation [Push, Pull, Legs, Rest] from Mon 09-21, today Wed 09-23', () => {
  const WED = '2026-09-23'
  const THU = '2026-09-24'
  const FRI = '2026-09-25'
  const SUN = '2026-09-27'
  const show = (d) => label(d.shown) + (d.status === 'skipped' ? ' (skipped)' : '')
  const rows = [
    ['Base', () => rotation(), ['Legs', 'Rest', 'Push', 'Pull', 'Legs']],
    ['Skip Wed', () => S.skipDay(rotation(), WED, TODAY, false), ['Legs (skipped)', 'Rest', 'Push', 'Pull', 'Legs']],
    ['Shift Wed', () => S.shiftDay(rotation(), WED, TODAY, false), ['SHIFTED', 'Legs', 'Rest', 'Push', 'Pull']],
    ['Shift Wed + Thu', () => S.shiftDay(S.shiftDay(rotation(), WED, TODAY, false), THU, TODAY, false), ['SHIFTED', 'SHIFTED', 'Legs', 'Rest', 'Push']],
    ['Shift Wed, override Fri = Arms', () => S.overrideDay(S.shiftDay(rotation(), WED, TODAY, false), FRI, R('arms'), TODAY), ['SHIFTED', 'Legs', 'Arms', 'Push', 'Pull']],
  ]
  for (const [name, build, expected] of rows) {
    test(name, () => {
      assert.deepEqual(range(build(), WED, SUN).map(show), expected)
    })
  }

  test('statuses of the base week', () => {
    assert.deepEqual(range(rotation(), '2026-09-20', SUN).map((d) => d.status), ['none', 'missed', 'missed', 'today', 'rest', 'upcoming', 'upcoming', 'upcoming'])
    assert.deepEqual(range(S.shiftDay(rotation(), WED, TODAY, false), WED, THU).map((d) => d.status), ['shifted', 'upcoming'])
  })

  test('shift Wed, then on Sat 09-26 the cycle becomes [Upper, Lower, Rest] with "today is Upper"', () => {
    const SAT = '2026-09-26'
    const shifted = S.shiftDay(rotation(), WED, TODAY, false)
    const before = range(shifted, '2026-09-21', '2026-09-25', { today: SAT })
    const edited = S.editSchedule(shifted, { mode: 'rotation', cycle: [R('upper'), R('lower'), REST], anchorIndex: 0 }, SAT, false, () => 'x')
    assert.deepEqual(labels(edited, SAT, '2026-09-28', { today: SAT }), ['Upper', 'Lower', 'Rest'])
    const oldDays = range(edited, WED, '2026-09-25', { today: SAT })
    assert.deepEqual(oldDays.map((d) => label(d.shown)), ['SHIFTED', 'Legs', 'Rest'])
    assert.deepEqual(oldDays.map((d) => d.versionId), ['v1', 'v1', 'v1'])
    assert.deepEqual(range(edited, '2026-09-21', '2026-09-25', { today: SAT }), before)
    assert.equal(S.versionFor(edited, SAT).id, 'v2026-09-26-x')
  })
})

describe('worked tests: weekly plan, today Wed 09-23', () => {
  const TUE = '2026-09-22'
  const MON = '2026-09-28'
  const rows = [
    ['Shift Wed', ['2026-09-23'], ['Pull', 'SHIFTED', 'Legs', 'Upper', 'Lower', 'Rest', 'Push']],
    ['Shift Tue + Wed', ['2026-09-22', '2026-09-23'], ['SHIFTED', 'SHIFTED', 'Pull', 'Legs', 'Upper', 'Lower', 'Push']],
    ['Shift Thu', ['2026-09-24'], ['Pull', 'Legs', 'SHIFTED', 'Rest', 'Upper', 'Lower', 'Push']],
  ]
  for (const [name, shifts, expected] of rows) {
    test(name, () => {
      assert.deepEqual(labels({ ...weekly(), shifts }, TUE, MON), expected)
    })
  }

  test('the same rows built through shiftDay (Tue shifted while it was today)', () => {
    const tueWed = S.shiftDay(S.shiftDay(weekly(), TUE, TUE, false), '2026-09-23', TUE, false)
    assert.deepEqual(labels(tueWed, TUE, MON), rows[1][2])
    assert.deepEqual(labels(S.shiftDay(weekly(), '2026-09-24', TODAY, false), TUE, MON), rows[2][2])
  })

  test('base week without shifts and weekly cycleIndex', () => {
    assert.deepEqual(labels(weekly(), TUE, MON), ['Pull', 'Legs', 'Rest', 'Upper', 'Lower', 'Rest', 'Push'])
    const s = { ...weekly(), shifts: ['2026-09-23'] }
    assert.equal(S.plannedFor(s, '2026-09-22').cycleIndex, 2)
    assert.equal(S.plannedFor(s, '2026-09-23').cycleIndex, null)
    assert.equal(S.plannedFor(s, '2026-09-24').cycleIndex, 3) // Thu shows Wed's slot
    assert.equal(S.plannedFor(s, '2026-09-25').cycleIndex, 5)
  })
})

// ---- actions ----------------------------------------------------------------------------------

describe('skip', () => {
  test('marks only that day; the rest of the plan is unchanged', () => {
    const s = S.skipDay(rotation(), TODAY, TODAY, false)
    assert.deepEqual(s.skips, { [TODAY]: {} })
    const wed = day(s, TODAY)
    assert.equal(wed.status, 'skipped')
    assert.equal(wed.skipped, true)
    assert.equal(label(wed.shown), 'Legs')
    assert.deepEqual(labels(s, '2026-09-24', '2026-09-26'), labels(rotation(), '2026-09-24', '2026-09-26'))
  })

  test('guards: past days, logged days, invalid dates', () => {
    assert.throws(() => S.skipDay(rotation(), '2026-09-22', TODAY, false), PAST)
    assert.throws(() => S.skipDay(rotation(), TODAY, TODAY, true), LOGGED)
    assert.throws(() => S.skipDay(rotation(), 'soon', TODAY, false), /valid date/)
    assert.throws(() => S.skipDay(rotation(), TODAY, undefined, false), /valid date/)
  })

  test('re-skipping keeps an existing note; clearing (undo) removes it', () => {
    const s = S.skipDay({ ...rotation(), skips: { [TODAY]: { note: 'sick' } } }, TODAY, TODAY, false)
    assert.deepEqual(s.skips[TODAY], { note: 'sick' })
    assert.equal(S.clearDay(s, TODAY, TODAY).skips[TODAY], undefined)
  })

  test('a session on the day wins over the skip', () => {
    const s = { ...rotation(), skips: { '2026-09-22': {} } }
    assert.equal(day(s, '2026-09-22', { sessions: [{ id: 'x', date: '2026-09-22' }] }).status, 'done')
  })
})

describe('shift', () => {
  test('set semantics: shifting the same day twice does nothing more', () => {
    const once = S.shiftDay(rotation(), TODAY, TODAY, false)
    const twice = S.shiftDay(once, TODAY, TODAY, false)
    assert.deepEqual(twice.shifts, [TODAY])
    assert.deepEqual(labels(twice, TODAY, '2026-09-27'), labels(once, TODAY, '2026-09-27'))
  })

  test('shifting a rest day inserts an extra rest day', () => {
    const s = S.shiftDay(rotation(), '2026-09-24', TODAY, false)
    assert.deepEqual(labels(s, TODAY, '2026-09-27'), ['Legs', 'SHIFTED', 'Rest', 'Push', 'Pull'])
  })

  test('shifts stay sorted and unique', () => {
    const s = S.shiftDay(S.shiftDay(rotation(), '2026-09-30', TODAY, false), '2026-09-25', TODAY, false)
    assert.deepEqual(s.shifts, ['2026-09-25', '2026-09-30'])
  })

  test('guards', () => {
    assert.throws(() => S.shiftDay(rotation(), '2026-09-01', TODAY, false), PAST)
    assert.throws(() => S.shiftDay(rotation(), TODAY, TODAY, true), LOGGED)
  })
})

describe('override', () => {
  test('changes only that day; tomorrow is unaffected', () => {
    const s = S.overrideDay(rotation(), TODAY, R('arms'), TODAY)
    assert.deepEqual(s.overrides[TODAY], { slot: R('arms') })
    const wed = day(s, TODAY)
    assert.equal(label(wed.planned), 'Legs')
    assert.equal(label(wed.shown), 'Arms')
    assert.equal(wed.status, 'today')
    assert.deepEqual(wed.override, { slot: R('arms') })
    assert.deepEqual(labels(s, '2026-09-24', '2026-09-26'), ['Rest', 'Push', 'Pull'])
  })

  test('override + shift on the same day: the schedule still shifts and the day shows the override', () => {
    const s = S.overrideDay(S.shiftDay(rotation(), TODAY, TODAY, false), TODAY, R('pull'), TODAY)
    const wed = day(s, TODAY)
    assert.equal(wed.planned, S.SHIFTED)
    assert.equal(wed.shifted, true)
    assert.equal(label(wed.shown), 'Pull')
    assert.equal(wed.status, 'today')
    assert.deepEqual(labels(s, '2026-09-24', '2026-09-26'), ['Legs', 'Rest', 'Push'])
  })

  test('override to rest, and re-planning a skipped day lifts the skip', () => {
    const skipped = S.skipDay(rotation(), TODAY, TODAY, false)
    const s = S.overrideDay(skipped, TODAY, { kind: 'rest' }, TODAY)
    assert.equal(s.skips[TODAY], undefined)
    assert.equal(day(s, TODAY).status, 'rest')
  })

  test('guards and slot validation', () => {
    assert.throws(() => S.overrideDay(rotation(), '2026-09-22', R('push'), TODAY), PAST)
    for (const bad of [null, 'push', { kind: 'routine' }, { kind: 'shifted' }, S.NONE, { kind: 'routine', routineId: '' }]) {
      assert.throws(() => S.overrideDay(rotation(), TODAY, bad, TODAY), /routine or Rest/)
    }
  })
})

describe('clear', () => {
  test('removes the skip, shift and override for the date', () => {
    let s = S.shiftDay(rotation(), '2026-09-25', TODAY, false)
    s = S.skipDay(s, '2026-09-25', TODAY, false)
    s = S.overrideDay(s, '2026-09-25', R('arms'), TODAY)
    s = S.skipDay(s, '2026-09-25', TODAY, false)
    const cleared = S.clearDay(s, '2026-09-25', TODAY)
    assert.deepEqual(cleared.shifts, [])
    assert.deepEqual(cleared.skips, {})
    assert.deepEqual(cleared.overrides, {})
    assert.deepEqual(labels(cleared, TODAY, '2026-09-30'), labels(rotation(), TODAY, '2026-09-30'))
    const fri = day(cleared, '2026-09-25')
    assert.equal(fri.skipped, false)
    assert.equal(fri.shifted, false)
    assert.equal(fri.override, null)
  })

  test('guard: past days cannot be cleared', () => {
    const s = { ...rotation(), shifts: ['2026-09-22'] }
    assert.throws(() => S.clearDay(s, '2026-09-22', TODAY), PAST)
  })
})

describe('move workout', () => {
  test("from becomes rest, to shows from's workout (to's own slot is replaced)", () => {
    const s = S.moveWorkout(rotation(), TODAY, '2026-09-25', TODAY, R('legs'))
    assert.deepEqual(s.overrides[TODAY], { slot: REST, movedTo: '2026-09-25' })
    assert.deepEqual(s.overrides['2026-09-25'], { slot: R('legs'), movedFrom: TODAY })
    assert.deepEqual(labels(s, TODAY, '2026-09-27'), ['Rest', 'Rest', 'Legs', 'Pull', 'Legs'])
    assert.equal(day(s, '2026-09-25').status, 'upcoming')
  })

  test('guards', () => {
    assert.throws(() => S.moveWorkout(rotation(), '2026-09-22', TODAY, TODAY, R('pull')), PAST)
    assert.throws(() => S.moveWorkout(rotation(), TODAY, '2026-09-22', TODAY, R('legs')), PAST)
    assert.throws(() => S.moveWorkout(rotation(), TODAY, TODAY, TODAY, R('legs')), /different day/)
    assert.throws(() => S.moveWorkout(rotation(), '2026-09-24', '2026-09-25', TODAY, REST), /no workout/)
    assert.throws(() => S.moveWorkout(rotation(), '2026-09-24', '2026-09-25', TODAY, S.SHIFTED), /no workout/)
  })

  test('moving lifts skips on both days; clearing one side drops the stale link on the other', () => {
    const skipped = S.skipDay(S.skipDay(rotation(), TODAY, TODAY, false), '2026-09-25', TODAY, false)
    const moved = S.moveWorkout(skipped, TODAY, '2026-09-25', TODAY, R('legs'))
    assert.deepEqual(moved.skips, {})
    const cleared = S.clearDay(moved, '2026-09-25', TODAY)
    assert.deepEqual(cleared.overrides, { [TODAY]: { slot: REST } })
    const back = S.overrideDay(moved, TODAY, R('arms'), TODAY)
    assert.deepEqual(back.overrides['2026-09-25'], { slot: R('legs') })
  })

  test('past partners keep their links', () => {
    const s = { ...rotation(), overrides: { '2026-09-22': { slot: REST, movedTo: '2026-09-24' }, '2026-09-24': { slot: R('pull'), movedFrom: '2026-09-22' } } }
    const cleared = S.clearDay(s, '2026-09-24', TODAY)
    assert.deepEqual(cleared.overrides, { '2026-09-22': { slot: REST, movedTo: '2026-09-24' } })
  })
})

// ---- resolveDay / nextWorkout -----------------------------------------------------------------

describe('resolveDay', () => {
  test('returns every contract field', () => {
    const d = day(rotation(), TODAY)
    assert.deepEqual(Object.keys(d).sort(), ['cycleIndex', 'date', 'deload', 'override', 'planned', 'routine', 'routineMissing', 'sessions', 'shifted', 'shown', 'skipped', 'status', 'versionId'].sort())
    assert.equal(d.date, TODAY)
    assert.equal(d.cycleIndex, 2)
    assert.equal(d.versionId, 'v1')
    assert.equal(d.routine, ROUTINES[2])
    assert.equal(d.routineMissing, false)
    assert.deepEqual(d.sessions, [])
  })

  test('statuses: done, skipped, shifted, rest, missed, today, upcoming, none', () => {
    let s = S.skipDay(rotation(), '2026-09-25', TODAY, false)
    s = S.shiftDay(s, '2026-09-26', TODAY, false)
    const sessions = [{ id: 'a', date: '2026-09-21', name: 'Push' }, { id: 'b', date: '2026-09-21', name: 'Extra' }]
    const status = (date) => day(s, date, { sessions }).status
    assert.equal(status('2026-09-21'), 'done')
    assert.equal(day(s, '2026-09-21', { sessions }).sessions.length, 2)
    assert.equal(status('2026-09-22'), 'missed')
    assert.equal(status(TODAY), 'today')
    assert.equal(status('2026-09-24'), 'rest')
    assert.equal(status('2026-09-25'), 'skipped')
    assert.equal(status('2026-09-26'), 'shifted')
    assert.equal(status('2026-09-27'), 'upcoming')
    assert.equal(status('2026-09-20'), 'none')
  })

  test('sessions are facts: done even without a plan', () => {
    const d = day(S.emptySchedule(), '2026-09-20', { sessions: [{ id: 'q', date: '2026-09-20', exercises: [] }] })
    assert.equal(d.status, 'done')
    assert.equal(d.shown, S.NONE)
  })

  test('an empty rotation cycle resolves to none', () => {
    const s = { versions: [{ id: 'c', effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [], anchorIndex: 0, weekly: [] }], shifts: [TODAY] }
    const d = day(s, TODAY)
    assert.equal(d.status, 'none')
    assert.equal(d.planned, S.NONE)
    assert.equal(d.versionId, 'c')
  })

  test('a slot pointing at a deleted routine is flagged, never throws', () => {
    const gym = { schedule: rotation(), routines: ROUTINES.filter((r) => r.id !== 'legs') }
    const d = S.resolveDay(gym, [], TODAY, TODAY)
    assert.equal(d.status, 'today')
    assert.equal(d.routine, null)
    assert.equal(d.routineMissing, true)
    assert.equal(S.resolveDay(gym, [], '2026-09-24', TODAY).routineMissing, false)
  })

  test('shifted days return the frozen SHIFTED constant; no plan returns NONE', () => {
    assert.ok(Object.isFrozen(S.SHIFTED) && Object.isFrozen(S.NONE))
    const s = { ...rotation(), shifts: [TODAY] }
    assert.equal(S.plannedFor(s, TODAY).slot, S.SHIFTED)
    assert.equal(S.plannedFor(s, '2026-01-01').slot, S.NONE)
    assert.equal(S.plannedFor(s, '2026-01-01').version, null)
  })
})

describe('nextWorkout', () => {
  test('first later day that shows a routine and is not skipped', () => {
    assert.equal(S.nextWorkout(gymOf(rotation()), [], TODAY).date, '2026-09-25')
    const skipped = S.skipDay(rotation(), '2026-09-25', TODAY, false)
    const next = S.nextWorkout(gymOf(skipped), [], TODAY)
    assert.equal(next.date, '2026-09-26')
    assert.equal(label(next.shown), 'Pull')
    assert.equal(S.nextWorkout(gymOf(S.overrideDay(rotation(), '2026-09-24', R('arms'), TODAY)), [], TODAY).date, '2026-09-24')
  })

  test('looks at most 60 days ahead', () => {
    const allRest = { versions: [{ id: 'r', effectiveFrom: '2026-01-01', mode: 'weekly', weekly: Array(7).fill(REST) }] }
    assert.equal(S.nextWorkout(gymOf(allRest), [], TODAY), null)
    const at60 = { ...allRest, overrides: { [S.addDays(TODAY, 60)]: { slot: R('push') } } }
    assert.equal(S.nextWorkout(gymOf(at60), [], TODAY).date, S.addDays(TODAY, 60))
    const at61 = { ...allRest, overrides: { [S.addDays(TODAY, 61)]: { slot: R('push') } } }
    assert.equal(S.nextWorkout(gymOf(at61), [], TODAY), null)
  })

  test('no plan or bad input gives null', () => {
    assert.equal(S.nextWorkout(gymOf(S.emptySchedule()), [], TODAY), null)
    assert.equal(S.nextWorkout(null, null, TODAY), null)
    assert.equal(S.nextWorkout(gymOf(rotation()), [], 'tomorrow'), null)
    assert.doesNotThrow(() => S.nextWorkout(gymOf(rotation()), [], '9999-12-30'))
  })
})

// ---- weekly queue -----------------------------------------------------------------------------

describe('weekly queue', () => {
  const schedule = (shifts, versions = [busyWeek()]) => ({ ...S.emptySchedule(), versions, shifts })
  const ids = (s, from, to) => range(s, from, to).map((d) => slotKey(d.shown))

  test('the backlog expires after 6 days without a shift', () => {
    const s = schedule(['2026-09-28'])
    assert.deepEqual(ids(s, '2026-09-27', '2026-10-06'), ['d0', 'SHIFTED', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd1', 'd2'])
  })

  test('another shift inside the window keeps the backlog alive', () => {
    const s = schedule(['2026-09-28', '2026-10-03'])
    const expected = naivePlan(S.normalizeSchedule(s), '2026-09-27', '2026-10-20')
    assert.deepEqual(ids(s, '2026-09-27', '2026-10-20'), Object.values(expected))
    assert.equal(slotKey(day(s, '2026-10-05').shown), 'd6') // still displaced two days after the 2nd shift
  })

  test('the queue never crosses a version boundary', () => {
    const one = schedule(['2026-09-30'])
    assert.deepEqual(ids(one, '2026-09-30', '2026-10-02'), ['SHIFTED', 'd3', 'd4'])
    const two = schedule(['2026-09-30'], [busyWeek('b1'), busyWeek('b2', '2026-10-01')])
    assert.deepEqual(ids(two, '2026-09-30', '2026-10-02'), ['SHIFTED', 'd4', 'd5'])
    assert.equal(day(two, '2026-10-01').versionId, 'b2')
  })

  test('shifts dated before effectiveFrom are ignored', () => {
    const w = schedule(['2026-09-19', '2026-09-20'])
    assert.deepEqual(ids(w, '2026-09-21', '2026-09-24'), ['d1', 'd2', 'd3', 'd4'])
    const r = { ...rotation(), shifts: ['2026-09-20'] }
    assert.deepEqual(labels(r, '2026-09-21', '2026-09-24'), ['Push', 'Pull', 'Legs', 'Rest'])
  })

  test('memoised simulations follow shift changes and slot contents', () => {
    const base = schedule(['2026-09-30'])
    assert.equal(slotKey(day(base, '2026-10-01').shown), 'd3')
    const more = S.shiftDay(base, '2026-10-01', TODAY, false)
    assert.deepEqual(ids(more, '2026-09-30', '2026-10-03'), ['SHIFTED', 'SHIFTED', 'd3', 'd4'])
    // same rest pattern and shifts, different routines: labels come from each version
    const other = schedule(['2026-09-30'], [{ ...busyWeek('b9'), weekly: [0, 1, 2, 3, 4, 5, 6].map((n) => R(`e${n}`)) }])
    assert.equal(slotKey(day(other, '2026-10-01').shown), 'e3')
    assert.equal(slotKey(day(base, '2026-10-01').shown), 'd3')
  })

  test('matches the literal spec pseudo-code on random schedules', () => {
    const rand = mulberry32(20260923)
    const pick = () => (rand() < 0.3 ? { kind: 'rest' } : R('abcde'[Math.floor(rand() * 5)]))
    for (let trial = 0; trial < 300; trial++) {
      const first = refAdd('2026-01-01', Math.floor(rand() * 20))
      const versions = []
      let eff = first
      const count = 1 + Math.floor(rand() * 3)
      for (let i = 0; i < count; i++) {
        if (i) eff = refAdd(eff, 1 + Math.floor(rand() * 40))
        versions.push(rand() < 0.5
          ? { id: `w${i}`, effectiveFrom: eff, mode: 'weekly', cycle: [], anchorIndex: 0, weekly: Array.from({ length: 7 }, pick) }
          : { id: `r${i}`, effectiveFrom: eff, mode: 'rotation', cycle: Array.from({ length: rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 8) }, pick), anchorIndex: Math.floor(rand() * 10), weekly: [] })
      }
      const from = refAdd(first, -10)
      const to = refAdd(eff, 60)
      const shifts = []
      const density = rand() * 0.45
      for (let d = from; d <= to; d = refAdd(d, 1)) if (rand() < density) shifts.push(d)
      const s = { versions, shifts, skips: {}, overrides: {}, deload: {} }
      const expected = naivePlan(s, from, to)
      const days = range(s, from, to)
      assert.deepEqual(days.map((d) => slotKey(d.planned)), Object.values(expected), `trial ${trial}`)
      for (const d of days.filter((_, i) => i % 17 === 0)) assert.equal(slotKey(S.plannedFor(s, d.date).slot), expected[d.date])
    }
  })
})

// ---- editing ----------------------------------------------------------------------------------

describe('editSchedule (copy-on-write)', () => {
  const history = () => ({
    versions: [
      { id: 'v0', effectiveFrom: '2026-08-03', mode: 'weekly', cycle: [], anchorIndex: 0, weekly: weeklyPlan() },
      { id: 'v1', effectiveFrom: '2026-09-14', mode: 'rotation', cycle: [R('push'), R('pull'), R('legs'), REST], anchorIndex: 2, weekly: [] },
      { id: 'v2', effectiveFrom: '2026-10-10', mode: 'rotation', cycle: [R('arms')], anchorIndex: 0, weekly: [] },
    ],
    shifts: ['2026-08-20', '2026-09-10', '2026-09-11', '2026-09-22', TODAY, '2026-09-30'],
    skips: { '2026-09-01': {}, '2026-09-25': {} },
    overrides: { '2026-09-02': { slot: R('arms') }, '2026-09-26': { slot: R('chest') } },
    deload: { everyWeeks: 3, programStart: '2026-08-03' },
  })
  const sessions = [{ id: 's1', date: '2026-09-15' }, { id: 's2', date: '2026-08-10' }, { id: 's3', date: TODAY }]
  const pastRange = (s) => range(s, '2026-07-20', '2026-09-22', { sessions })

  test('past days resolve identically after an edit', () => {
    const before = pastRange(history())
    const weeklyEdit = S.editSchedule(history(), { mode: 'weekly', weekly: [REST, R('upper'), R('lower'), REST, R('upper'), R('lower'), REST] }, TODAY, false)
    const rotationEdit = S.editSchedule(history(), { mode: 'rotation', cycle: [R('chest'), REST], anchorIndex: 1 }, TODAY, true)
    assert.deepEqual(pastRange(weeklyEdit), before)
    assert.deepEqual(pastRange(rotationEdit), before)
  })

  test('drops later versions, replaces one starting the same day, inserts the new one', () => {
    const edited = S.editSchedule(history(), { mode: 'weekly', weekly: weeklyPlan() }, TODAY, false, () => 'a')
    assert.deepEqual(edited.versions.map((v) => v.id), ['v0', 'v1', `v${TODAY}-a`])
    assert.deepEqual(edited.versions[2], { id: `v${TODAY}-a`, effectiveFrom: TODAY, mode: 'weekly', cycle: [], anchorIndex: 0, weekly: weeklyPlan() })
    const again = S.editSchedule(edited, { mode: 'rotation', cycle: [R('push')], anchorIndex: 0 }, TODAY, false, () => 'b')
    assert.deepEqual(again.versions.map((v) => v.id), ['v0', 'v1', `v${TODAY}-b`])
    // skips, shifts and overrides are kept
    assert.deepEqual(again.shifts, history().shifts)
    assert.deepEqual(again.skips, history().skips)
  })

  test('"Today is" sets today\'s slot; with a session today the version starts tomorrow one slot later', () => {
    const plan = { mode: 'rotation', cycle: [R('upper'), R('lower'), REST], anchorIndex: 0 }
    const now = S.editSchedule(rotation(), plan, TODAY, false)
    assert.deepEqual(labels(now, TODAY, '2026-09-26'), ['Upper', 'Lower', 'Rest', 'Upper'])
    const sessions = [{ id: 'done', date: TODAY }]
    const beforeToday = day(rotation(), TODAY, { sessions })
    const later = S.editSchedule(rotation(), plan, TODAY, true)
    assert.equal(later.versions.at(-1).effectiveFrom, '2026-09-24')
    assert.equal(later.versions.at(-1).anchorIndex, 1)
    assert.deepEqual(day(later, TODAY, { sessions }), beforeToday)
    assert.deepEqual(labels(later, '2026-09-24', '2026-09-26'), ['Lower', 'Rest', 'Upper'])
  })

  test('validates the plan and normalises slots', () => {
    const edit = (plan) => S.editSchedule(rotation(), plan, TODAY, false)
    assert.throws(() => edit({ mode: 'rotation', cycle: [] }), /1 and 31/)
    assert.throws(() => edit({ mode: 'rotation', cycle: Array(32).fill(REST) }), /1 and 31/)
    assert.throws(() => edit({ mode: 'rotation' }), /1 and 31/)
    assert.throws(() => edit({ mode: 'weekly', weekly: Array(6).fill(REST) }), /7 days/)
    assert.throws(() => edit({ mode: 'sometimes' }), /Rotation or Weekly/)
    assert.throws(() => edit(null), /Rotation or Weekly/)
    assert.throws(() => S.editSchedule(rotation(), { mode: 'weekly', weekly: weeklyPlan() }, 'today', false), /valid date/)
    assert.doesNotThrow(() => edit({ mode: 'rotation', cycle: Array(31).fill(REST) }))
    const s = edit({ mode: 'rotation', cycle: [R('push'), { kind: 'banana' }, null, R(7)], anchorIndex: -1 })
    const v = s.versions.at(-1)
    assert.deepEqual(v.cycle, [R('push'), REST, REST, R('7')])
    assert.equal(v.anchorIndex, 3)
    assert.deepEqual(v.weekly, [])
  })

  test('never mutates its input', () => {
    const input = deepFreeze(history())
    const copy = JSON.parse(JSON.stringify(input))
    const out = S.editSchedule(input, { mode: 'weekly', weekly: weeklyPlan() }, TODAY, false)
    assert.notEqual(out, input)
    assert.deepEqual(input, copy)
  })
})

describe('replaceRoutineWithRest', () => {
  const source = () => ({
    ...rotation(),
    versions: [
      ...rotation().versions,
      { id: 'v9', effectiveFrom: '2026-10-15', mode: 'rotation', cycle: [R('pull'), R('legs')], anchorIndex: 0, weekly: [] },
    ],
    shifts: ['2026-09-22', '2026-09-24', '2026-10-20'],
    overrides: { '2026-09-21': { slot: R('pull') }, '2026-09-26': { slot: R('pull'), movedFrom: '2026-09-25' }, '2026-09-27': { slot: R('legs') } },
  })

  test('keeps rotation alignment; past days are untouched; pull becomes rest from today', () => {
    const before = range(source(), '2026-09-01', '2026-10-31')
    const replaced = S.replaceRoutineWithRest(source(), 'pull', TODAY, false, () => 'n')
    const after = range(replaced, '2026-09-01', '2026-10-31')
    assert.equal(after.length, before.length)
    after.forEach((d, i) => {
      const b = before[i]
      if (d.date < TODAY) return assert.deepEqual(d, b, d.date)
      assert.equal(d.cycleIndex, b.cycleIndex, d.date)
      assert.equal(label(d.shown), label(b.shown) === 'Pull' ? 'Rest' : label(b.shown), d.date)
    })
    const copy = replaced.versions.find((v) => v.effectiveFrom === TODAY)
    assert.equal(copy.id, `v${TODAY}-n`)
    assert.equal(copy.anchorIndex, 1) // k(Wed) = 0 + 2 days - 1 shift
    assert.deepEqual(copy.cycle, [R('push'), REST, R('legs'), REST])
    const future = replaced.versions.find((v) => v.id === 'v9')
    assert.deepEqual(future.cycle, [REST, R('legs')])
    assert.deepEqual(replaced.overrides['2026-09-21'], { slot: R('pull') })
    assert.deepEqual(replaced.overrides['2026-09-26'], { slot: REST, movedFrom: '2026-09-25' })
    assert.deepEqual(replaced.overrides['2026-09-27'], { slot: R('legs') })
    assert.equal(S.routineInUse(replaced, 'pull', TODAY), false)
  })

  test('with a session today the change starts tomorrow and today is unchanged', () => {
    const s = rotation()
    const sessions = [{ id: 'x', date: TODAY }]
    const replaced = S.replaceRoutineWithRest(s, 'legs', TODAY, true)
    assert.deepEqual(day(replaced, TODAY, { sessions }), day(s, TODAY, { sessions }))
    assert.equal(replaced.versions.at(-1).effectiveFrom, '2026-09-24')
    assert.deepEqual(labels(replaced, '2026-09-24', '2026-10-01'), labels(s, '2026-09-24', '2026-10-01').map((l) => (l === 'Legs' ? 'Rest' : l)))
  })

  test('weekly versions: past days unchanged, future slots become rest', () => {
    const s = { ...weekly(), shifts: ['2026-09-25'] }
    const before = range(s, '2026-09-01', '2026-10-20')
    const replaced = S.replaceRoutineWithRest(s, 'upper', TODAY, false)
    const after = range(replaced, '2026-09-01', '2026-10-20')
    after.forEach((d, i) => {
      if (d.date < TODAY) assert.deepEqual(d, before[i])
      else assert.equal(label(d.shown), label(before[i].shown) === 'Upper' ? 'Rest' : label(before[i].shown), d.date)
    })
  })

  test('a routine the plan does not use adds no version; a version starting today is mapped in place', () => {
    const unused = S.replaceRoutineWithRest(rotation(), 'chest', TODAY, false)
    assert.deepEqual(unused.versions, rotation().versions)
    const startsToday = { ...rotation(), versions: [{ ...rotation().versions[0], effectiveFrom: TODAY }] }
    const mapped = S.replaceRoutineWithRest(startsToday, 'push', TODAY, false)
    assert.equal(mapped.versions.length, 1)
    assert.equal(mapped.versions[0].id, 'v1')
    assert.deepEqual(mapped.versions[0].cycle, [REST, R('pull'), R('legs'), REST])
  })

  test('never mutates its input', () => {
    const input = deepFreeze(source())
    const copy = JSON.parse(JSON.stringify(input))
    S.replaceRoutineWithRest(input, 'pull', TODAY, false)
    assert.deepEqual(input, copy)
  })
})

describe('routineInUse', () => {
  test('current or later versions and overrides from today count; past ones do not', () => {
    const s = {
      ...rotation(),
      versions: [{ id: 'old', effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [R('chest')], anchorIndex: 0, weekly: [] }, ...rotation().versions,
        { id: 'next', effectiveFrom: '2026-11-01', mode: 'weekly', weekly: [R('upper'), REST, REST, REST, REST, REST, REST] }],
      overrides: { '2026-09-20': { slot: R('arms') }, '2026-09-30': { slot: R('lower') } },
    }
    assert.equal(S.routineInUse(s, 'pull', TODAY), true)
    assert.equal(S.routineInUse(s, 'upper', TODAY), true)
    assert.equal(S.routineInUse(s, 'lower', TODAY), true)
    assert.equal(S.routineInUse(s, 'chest', TODAY), false)
    assert.equal(S.routineInUse(s, 'arms', TODAY), false)
    assert.equal(S.routineInUse(s, 'chest', '2026-09-05'), true)
    assert.equal(S.routineInUse(null, 'pull', TODAY), false)
    assert.equal(S.routineInUse(s, null, TODAY), false)
  })
})

describe('realign', () => {
  test('continues the cycle after the routine that was done, from tomorrow', () => {
    const s = { ...rotation(), versions: [...rotation().versions, { id: 'later', effectiveFrom: '2026-10-10', mode: 'rotation', cycle: [R('arms')], anchorIndex: 0, weekly: [] }] }
    const out = S.realign(s, 'push', TODAY, () => 'r')
    assert.deepEqual(out.versions.map((v) => v.id), ['v1', 'v2026-09-24-r'])
    assert.equal(out.versions[1].anchorIndex, 1)
    assert.deepEqual(labels(out, TODAY, '2026-09-28'), ['Legs', 'Pull', 'Legs', 'Rest', 'Push', 'Pull'])
    assert.equal(day(out, TODAY).versionId, 'v1')
  })

  test('prefers the first occurrence at or after today\'s position, else the first', () => {
    const ppl2 = (anchorIndex) => ({ versions: [{ id: 'p', effectiveFrom: '2026-09-21', mode: 'rotation', cycle: [R('push'), R('pull'), R('legs'), R('push'), R('pull'), R('legs'), REST], anchorIndex }] })
    // anchor 0 → today (Wed) is index 2; Pull at index 4 → tomorrow index 5 (Legs), then Rest
    assert.deepEqual(labels(S.realign(ppl2(0), 'pull', TODAY), '2026-09-24', '2026-09-26'), ['Legs', 'Rest', 'Push'])
    // anchor 3 → today is index 5; no Push at 5..6 → first Push (0) → tomorrow Pull (1)
    const wrapped = S.realign(ppl2(3), 'push', TODAY)
    assert.equal(wrapped.versions.at(-1).anchorIndex, 1)
    assert.deepEqual(labels(wrapped, '2026-09-24', '2026-09-26'), ['Pull', 'Legs', 'Push'])
  })

  test('counts shifts when finding today\'s position', () => {
    const s = { ...rotation(), shifts: ['2026-09-22'] } // today is index 1 (Pull)
    const out = S.realign(s, 'legs', TODAY)
    assert.equal(out.versions.at(-1).anchorIndex, 3)
  })

  test('returns null when not applicable', () => {
    assert.equal(S.realign(weekly(), 'push', TODAY), null)
    assert.equal(S.realign(rotation(), 'arms', TODAY), null)
    assert.equal(S.realign({ versions: [{ effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [] }] }, 'push', TODAY), null)
    assert.equal(S.realign(rotation(), 'push', '2026-09-01'), null)
    assert.equal(S.realign(rotation(), 'push', 'bad'), null)
    assert.equal(S.realign(null, 'push', TODAY), null)
    assert.equal(S.realign(rotation(), undefined, TODAY), null)
  })
})

// ---- deload -----------------------------------------------------------------------------------

describe('deload', () => {
  const every4 = () => S.setDeloadEvery(rotation(), 4, '2026-09-21')
  const weekFlags = (s, from, fw = 1) => Array.from({ length: 7 }, (_, i) => S.isDeload(s, S.addDays(from, i), fw))

  test('automatic every N weeks from programStart', () => {
    const s = every4()
    assert.equal(s.deload.everyWeeks, 4)
    assert.equal(s.deload.programStart, '2026-09-21')
    assert.deepEqual(weekFlags(s, '2026-10-12'), Array(7).fill(true))
    assert.equal(S.isDeload(s, '2026-10-11'), false)
    assert.equal(S.isDeload(s, '2026-10-19'), false)
    assert.equal(S.isDeload(s, '2026-11-09'), true)
    assert.equal(S.isDeload(s, '2026-09-14'), false) // before the program started
    assert.equal(S.isDeload(S.setDeloadEvery(s, 0, TODAY), '2026-10-12'), false)
  })

  test('setDeloadEvery keeps an existing programStart and validates', () => {
    assert.equal(S.setDeloadEvery(every4(), 2, '2026-10-01').deload.programStart, '2026-09-21')
    assert.equal(S.setDeloadEvery(rotation(), 3, TODAY).deload.programStart, TODAY)
    for (const bad of [-1, 53, 2.5, 'abc', NaN]) assert.throws(() => S.setDeloadEvery(rotation(), bad, TODAY), /Deload every/)
    assert.throws(() => S.setDeloadEvery(rotation(), 4, 'x'), /valid date/)
  })

  test('weeks follow the first-weekday setting even when programStart is mid-week', () => {
    const s = S.setDeloadEvery(rotation(), 4, TODAY) // Wed
    assert.equal(S.isDeload(s, '2026-10-11', 1), false)
    assert.equal(S.isDeload(s, '2026-10-12', 1), true)
    assert.equal(S.isDeload(s, '2026-10-18', 1), true)
    assert.equal(S.isDeload(s, '2026-10-11', 0), true)
    assert.equal(S.isDeload(s, '2026-10-17', 0), true)
    assert.equal(S.isDeload(s, '2026-10-18', 0), false)
  })

  test('manual "Deload this week" and "Skip this deload"', () => {
    const manual = S.deloadWeek(rotation(), '2026-09-30', 1, true)
    assert.deepEqual(manual.deload.manualWeeks, ['2026-09-28'])
    assert.deepEqual(weekFlags(manual, '2026-09-28'), Array(7).fill(true))
    assert.equal(S.isDeload(manual, '2026-10-05'), false)
    const off = S.deloadWeek(manual, '2026-10-04', 1, false)
    assert.deepEqual(off.deload.manualWeeks, [])
    assert.deepEqual(off.deload.cancelledWeeks, []) // not an automatic week, nothing to cancel

    const cancelled = S.deloadWeek(every4(), '2026-10-14', 1, false)
    assert.deepEqual(cancelled.deload.cancelledWeeks, ['2026-10-12'])
    assert.deepEqual(weekFlags(cancelled, '2026-10-12'), Array(7).fill(false))
    assert.equal(S.isDeload(cancelled, '2026-11-09'), true)
    const restored = S.deloadWeek(cancelled, '2026-10-15', 1, true)
    assert.deepEqual(restored.deload.cancelledWeeks, [])
    assert.deepEqual(restored.deload.manualWeeks, ['2026-10-12'])
    assert.equal(S.isDeload(restored, '2026-10-12'), true)
    assert.throws(() => S.deloadWeek(rotation(), 'x', 1, true), /valid date/)
  })

  test('falls back to the first version when programStart is missing; resolveDay uses prefs.firstWeekday', () => {
    const s = { ...rotation(), deload: { everyWeeks: 2 } }
    assert.equal(S.isDeload(s, '2026-09-28'), true)
    assert.equal(S.isDeload(s, '2026-09-27'), false)
    assert.equal(day(s, '2026-09-28').deload, true)
    const sundayWeeks = S.resolveDay(gymOf(s, { prefs: { firstWeekday: 0 } }), [], '2026-09-27', TODAY)
    assert.equal(sundayWeeks.deload, true)
  })

  test('tolerant of junk', () => {
    assert.equal(S.isDeload(null, TODAY), false)
    assert.equal(S.isDeload({ deload: 'x' }, TODAY), false)
    assert.equal(S.isDeload(every4(), 'bad'), false)
    assert.equal(S.isDeload({ deload: { everyWeeks: 'abc', manualWeeks: 'x' } }, TODAY), false)
  })
})

// ---- normalisation and robustness -------------------------------------------------------------

describe('normalizeSchedule', () => {
  test('emptySchedule shape', () => {
    assert.deepEqual(S.emptySchedule(), {
      versions: [], shifts: [], skips: {}, overrides: {},
      deload: { everyWeeks: 0, programStart: null, setsFactor: 0.5, weightFactor: 0.9, manualWeeks: [], cancelledWeeks: [] },
    })
    assert.notEqual(S.emptySchedule(), S.emptySchedule())
  })

  test('sorts versions, dedupes dates, fills both slot arrays, is idempotent', () => {
    const raw = {
      versions: [
        { id: 'b', effectiveFrom: '2026-10-01', cycle: [R('b')] },
        { id: 'a', effectiveFrom: '2026-09-01', mode: 'weekly', weekly: [R('a')] },
        { id: 'a2', effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [R('x'), REST], anchorIndex: 5 },
      ],
      shifts: ['2026-09-23', '2026-09-22', '2026-09-23', null, 5, '2026-9-1'],
      custom: { keep: true },
    }
    const s = S.normalizeSchedule(raw)
    assert.deepEqual(s.versions.map((v) => v.id), ['a2', 'b'])
    assert.equal(s.versions[0].anchorIndex, 1)
    assert.deepEqual(s.versions[1], { id: 'b', effectiveFrom: '2026-10-01', mode: 'rotation', cycle: [R('b')], anchorIndex: 0, weekly: [] })
    assert.deepEqual(s.shifts, ['2026-09-22', '2026-09-23'])
    assert.deepEqual(s.custom, { keep: true })
    assert.deepEqual(S.normalizeSchedule(s), s)
    const weeklyOnly = S.normalizeSchedule({ versions: [{ effectiveFrom: '2026-09-01', weekly: [R('a')] }] }).versions[0]
    assert.equal(weeklyOnly.mode, 'weekly')
    assert.equal(weeklyOnly.id, 'v2026-09-01')
    assert.deepEqual(weeklyOnly.weekly, [R('a'), REST, REST, REST, REST, REST, REST])
    assert.deepEqual(weeklyOnly.cycle, [])
  })

  test('duplicated shifts count once', () => {
    const s = { ...rotation(), shifts: ['2026-09-22', '2026-09-22'] }
    assert.equal(label(day(s, TODAY).shown), 'Pull')
  })

  test('never mutates the input', () => {
    const raw = deepFreeze({ versions: [{ effectiveFrom: '2026-09-02', cycle: [R('a')] }, { effectiveFrom: '2026-09-01', cycle: [] }], shifts: ['2026-09-05', '2026-09-03'] })
    const copy = JSON.parse(JSON.stringify(raw))
    S.normalizeSchedule(raw)
    for (const fn of [
      () => S.skipDay(raw, TODAY, TODAY, false), () => S.shiftDay(raw, TODAY, TODAY, false), () => S.overrideDay(raw, TODAY, REST, TODAY),
      () => S.clearDay(raw, TODAY, TODAY), () => S.moveWorkout(raw, TODAY, '2026-09-30', TODAY, R('a')), () => S.realign(raw, 'a', TODAY),
      () => S.deloadWeek(raw, TODAY, 1, true), () => S.setDeloadEvery(raw, 4, TODAY),
    ]) {
      const out = fn()
      assert.notEqual(out, raw)
    }
    assert.deepEqual(raw, copy)
  })
})

describe('malformed input never throws in read paths', () => {
  const V = (extra) => ({ id: 'm', effectiveFrom: '2026-09-21', mode: 'rotation', cycle: [R('push'), REST], anchorIndex: 0, ...extra })
  const sparse = new Array(3)
  sparse[1] = R('push')
  const cases = {
    undefined: undefined, null: null, zero: 0, number: 42, string: 'schedule', bool: true, array: [], numbers: [1, 2],
    empty: {},
    wrongTypes: { versions: 'x', shifts: 'y', skips: [], overrides: 5, deload: 'z' },
    junkVersions: { versions: [null, 1, 'v', [], {}, { effectiveFrom: 'nope' }, { effectiveFrom: '2026-02-30', cycle: [R('a')] }, { effectiveFrom: 20260921 }] },
    emptyCycle: { versions: [{ effectiveFrom: '2026-09-21', mode: 'rotation' }] },
    weirdSlots: { versions: [{ effectiveFrom: '2026-09-21', mode: 'weird', cycle: [{ kind: 'banana' }, null, { kind: 'routine' }, R(7), 'push', { kind: 'shifted' }] }] },
    shortWeek: { versions: [{ effectiveFrom: '2026-09-21', mode: 'weekly', weekly: [R('push')] }] },
    stringWeek: { versions: [{ effectiveFrom: '2026-09-21', mode: 'weekly', weekly: 'x', cycle: 'y' }] },
    longWeek: { versions: [{ effectiveFrom: '2026-09-21', mode: 'weekly', weekly: Array(10).fill(null) }], shifts: [TODAY, '2026-09-24'] },
    outOfOrder: { versions: [V({ id: 'late', effectiveFrom: '2026-10-01' }), V({ id: 'early', effectiveFrom: '2026-09-01' })] },
    textAnchor: { versions: [V({ anchorIndex: 'x' })], shifts: [TODAY, TODAY, null, 5, '2026-9-1', '2026-09-22'] },
    nanAnchor: { versions: [V({ anchorIndex: NaN })] },
    infiniteAnchor: { versions: [V({ anchorIndex: Infinity })] },
    negativeAnchor: { versions: [V({ anchorIndex: -5 })] },
    hugeAnchor: { versions: [V({ anchorIndex: 1e300 })] },
    sparseCycle: { versions: [V({ cycle: sparse })] },
    longCycle: { versions: [V({ cycle: Array(400).fill(R('push')) })] },
    oddIds: { versions: [V({ id: null }), V({ id: 5, effectiveFrom: '2026-09-25' })] },
    junkDayMaps: {
      versions: [V()],
      overrides: { '2026-09-24': { slot: { kind: 'zzz' } }, '2026-09-25': null, bad: { slot: REST }, '2026-09-26': { slot: R('x'), movedFrom: 'no', movedTo: 7 }, '2026-09-27': 'rest' },
      skips: { [TODAY]: null, '2026-09-24': 'yes', nope: {}, '2026-09-25': 0 },
    },
    junkDeload: { versions: [V()], deload: { everyWeeks: 'abc', programStart: 5, manualWeeks: 'x', cancelledWeeks: [null, '2026-09-21'], setsFactor: 7, weightFactor: -1 } },
    negativeDeload: { versions: [V()], deload: { everyWeeks: -3, manualWeeks: ['2026-09-23', 'bad'] } },
    hugeDeload: { versions: [V()], deload: { everyWeeks: 1e9, programStart: '0000-01-01' } },
    extremeDates: { versions: [{ effectiveFrom: '0000-01-01', cycle: [R('a')] }, { effectiveFrom: '9999-12-31', weekly: [R('b')] }], shifts: ['0000-01-01', '9999-12-31'] },
    protoKeys: JSON.parse('{"__proto__": {"polluted": 1}, "versions": [], "overrides": {"__proto__": {"slot": {"kind": "rest"}}}}'),
  }
  const schedules = Object.values(cases)
  const gyms = (schedule) => [
    null, undefined, 'gym', 7, [],
    { schedule },
    { schedule, routines: 'x', prefs: 'y' },
    { schedule, routines: [null, 5, { id: 5 }, {}, { id: 'push' }, { id: 'push', name: 'dupe' }], prefs: { firstWeekday: 'Mon' } },
    { schedule, routines: ROUTINES, prefs: { firstWeekday: 9 } },
  ]
  const sessionLists = [undefined, null, 'x', {}, [null, 5, 'x', [], {}, { date: 5 }, { date: '2026-13-01' }, { id: 'ok', date: TODAY }]]
  const STATUSES = new Set(['done', 'skipped', 'shifted', 'rest', 'missed', 'today', 'upcoming', 'none'])
  const KINDS = new Set(['routine', 'rest', 'shifted', 'none'])
  const DATES = ['2026-09-20', TODAY, '2026-09-26', '2026-12-31', '0000-01-01', '9999-12-31', 'bad', null, 5]

  test('every read function on every malformed shape', () => {
    for (const schedule of schedules) {
      const normalized = S.normalizeSchedule(schedule)
      assert.ok(Array.isArray(normalized.versions) && Array.isArray(normalized.shifts))
      assert.ok(normalized.skips && normalized.overrides && normalized.deload)
      for (const v of normalized.versions) {
        assert.ok(v.mode === 'rotation' || v.mode === 'weekly')
        assert.ok(Array.isArray(v.cycle) && Array.isArray(v.weekly))
        assert.equal(v.weekly.length, v.mode === 'weekly' ? 7 : 0)
        if (v.mode === 'weekly') assert.equal(v.cycle.length, 0)
        for (const slot of [...v.cycle, ...v.weekly]) assert.ok(slot.kind === 'rest' || (slot.kind === 'routine' && typeof slot.routineId === 'string'))
        assert.ok(Number.isInteger(v.anchorIndex))
      }
      assert.deepEqual(S.normalizeSchedule(normalized), normalized)
      for (const date of DATES) {
        S.versionFor(schedule, date)
        assert.ok(KINDS.has(S.plannedFor(schedule, date).slot.kind))
        assert.equal(typeof S.isDeload(schedule, date, 'x'), 'boolean')
        S.routineInUse(schedule, 'push', date)
      }
      for (const gym of gyms(schedule)) {
        for (const sessions of sessionLists) {
          for (const date of DATES) {
            const d = S.resolveDay(gym, sessions, date, TODAY)
            assert.ok(STATUSES.has(d.status), `${JSON.stringify(schedule)} ${date}`)
            assert.ok(KINDS.has(d.shown.kind) && KINDS.has(d.planned.kind))
          }
          const days = S.resolveRange(gym, sessions, '2026-09-14', '2026-10-04', TODAY)
          assert.equal(days.length, 21)
          for (const d of days) assert.ok(STATUSES.has(d.status))
          const next = S.nextWorkout(gym, sessions, TODAY)
          assert.ok(next === null || next.shown.kind === 'routine')
        }
      }
    }
    assert.equal({}.polluted, undefined)
  })

  test('specific malformed cases resolve sensibly', () => {
    const at = (schedule, date = TODAY) => S.resolveDay(gymOf(schedule), [], date, TODAY)
    // empty cycle → none
    assert.equal(at(cases.emptyCycle).status, 'none')
    // junk versions are dropped
    assert.deepEqual(S.normalizeSchedule(cases.junkVersions).versions, [])
    // unknown kinds → rest, numeric routine ids → strings, alignment kept
    assert.deepEqual(S.normalizeSchedule(cases.weirdSlots).versions[0].cycle, [REST, REST, REST, R('7'), REST, REST])
    assert.equal(S.normalizeSchedule(cases.weirdSlots).versions[0].mode, 'rotation')
    // weekly arrays are padded / cut to 7
    assert.deepEqual(S.normalizeSchedule(cases.shortWeek).versions[0].weekly, [R('push'), REST, REST, REST, REST, REST, REST])
    assert.equal(S.normalizeSchedule(cases.longWeek).versions[0].weekly.length, 7)
    // out-of-order versions are sorted
    assert.equal(S.versionFor(cases.outOfOrder, '2026-09-15').id, 'early')
    assert.equal(S.versionFor(cases.outOfOrder, '2026-10-02').id, 'late')
    // bad anchors fall back to 0; odd ones still give a valid index
    assert.equal(label(at(cases.textAnchor, '2026-09-21').shown), 'Push')
    assert.equal(label(at(cases.nanAnchor, '2026-09-21').shown), 'Push')
    assert.equal(S.normalizeSchedule(cases.negativeAnchor).versions[0].anchorIndex, 1)
    assert.ok([0, 1].includes(at(cases.hugeAnchor).cycleIndex))
    // sparse cycle holes become rest
    assert.deepEqual(S.normalizeSchedule(cases.sparseCycle).versions[0].cycle, [REST, R('push'), REST])
    // missing / numeric ids
    assert.deepEqual(S.normalizeSchedule(cases.oddIds).versions.map((v) => v.id), ['v2026-09-21', '5'])
    // malformed overrides and skips are dropped
    const junk = S.normalizeSchedule(cases.junkDayMaps)
    assert.deepEqual(junk.overrides, { '2026-09-26': { slot: R('x') } })
    assert.deepEqual(junk.skips, { '2026-09-24': {} })
    // junk deload values fall back to defaults
    const deload = S.normalizeSchedule(cases.junkDeload).deload
    assert.deepEqual([deload.everyWeeks, deload.programStart, deload.manualWeeks, deload.cancelledWeeks, deload.setsFactor, deload.weightFactor], [0, null, [], ['2026-09-21'], 0.5, 0.9])
    assert.equal(S.normalizeSchedule(cases.negativeDeload).deload.everyWeeks, 0)
    // prototype keys are ignored, never applied
    assert.deepEqual(S.normalizeSchedule(cases.protoKeys).overrides, {})
    assert.equal(Object.getPrototypeOf(S.normalizeSchedule(cases.protoKeys)), Object.prototype)
  })

  test('invalid dates and ranges', () => {
    const gym = gymOf(rotation())
    const blank = S.resolveDay(gym, [], 'bad', TODAY)
    assert.equal(blank.status, 'none')
    assert.equal(blank.shown, S.NONE)
    assert.deepEqual(blank.sessions, [])
    assert.deepEqual(S.resolveRange(gym, [], 'x', TODAY, TODAY), [])
    assert.deepEqual(S.resolveRange(gym, [], '2026-09-30', '2026-09-01', TODAY), [])
    assert.equal(S.resolveRange(gym, [], TODAY, TODAY, TODAY).length, 1)
    assert.equal(S.resolveRange(gym, [], '2000-01-01', '2099-12-31', TODAY).length, 3660)
    assert.equal(S.versionFor(rotation(), 'bad'), null)
    assert.equal(S.plannedFor(rotation(), 'bad').slot, S.NONE)
    // an unknown "today" still resolves (planned routine days read as upcoming)
    assert.equal(S.resolveDay(gym, [], TODAY, null).status, 'upcoming')
  })
})

// ---- performance ------------------------------------------------------------------------------

describe('performance', () => {
  const rand = mulberry32(7)
  const start = '2023-09-25'
  const span = refDiff(start, '2026-10-31')
  const shiftSet = new Set()
  while (shiftSet.size < 500) shiftSet.add(refAdd(start, Math.floor(rand() * span)))
  const shifts = [...shiftSet].sort()
  const sessions = Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, date: refAdd(start, Math.floor(rand() * refDiff(start, TODAY))), exercises: [] }))
  const time = (fn) => {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }

  for (const mode of ['weekly', 'rotation']) {
    test(`${mode} version from 3 years ago with 500 shifts stays fast`, () => {
      const version = mode === 'weekly'
        ? { id: 'big', effectiveFrom: start, mode, cycle: [], anchorIndex: 0, weekly: weeklyPlan() }
        : { id: 'big', effectiveFrom: start, mode, cycle: [R('push'), R('pull'), R('legs'), REST, R('upper')], anchorIndex: 0, weekly: [] }
      const schedule = { ...S.emptySchedule(), versions: [version], shifts }
      const gym = gymOf(schedule)
      const run = () => {
        S.resolveRange(gym, sessions, '2026-09-07', '2026-10-18', TODAY)
        S.nextWorkout(gym, sessions, TODAY)
      }
      const cold = time(run)
      const warm = time(() => { for (let i = 0; i < 50; i++) run() })
      assert.ok(cold < 300, `cold call took ${cold.toFixed(1)} ms`)
      assert.ok(warm < 1500, `50 warm calls took ${warm.toFixed(1)} ms`)
      // and it is still right
      const expected = naivePlan(schedule, '2026-09-07', '2026-10-18')
      assert.deepEqual(range(schedule, '2026-09-07', '2026-10-18', { sessions }).map((d) => slotKey(d.planned)), Object.values(expected))
    })
  }

  test('many different weekly schedules (cache eviction) keep giving the same answers', () => {
    const make = (seed) => {
      const r = mulberry32(seed)
      const list = []
      for (let d = '2026-08-01'; d <= '2026-10-31'; d = refAdd(d, 1)) if (r() < 0.2) list.push(d)
      return { versions: [{ id: `x${seed}`, effectiveFrom: '2026-08-01', mode: 'weekly', weekly: weeklyPlan() }], shifts: list }
    }
    const first = Array.from({ length: 60 }, (_, i) => labels(make(i), '2026-09-01', '2026-10-31'))
    const second = Array.from({ length: 60 }, (_, i) => labels(make(i), '2026-09-01', '2026-10-31'))
    assert.deepEqual(second, first)
    for (let i = 0; i < 60; i += 7) {
      const s = make(i)
      assert.deepEqual(range(s, '2026-09-01', '2026-10-31').map((d) => slotKey(d.planned)), Object.values(naivePlan(s, '2026-09-01', '2026-10-31')))
    }
  })
})

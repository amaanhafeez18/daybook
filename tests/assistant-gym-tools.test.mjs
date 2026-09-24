// The assistant's gym tools added on top of logging: editing and copying a logged workout, training
// totals, routine reordering/notes/copies, and the extra gym_log_workout arguments. Each tool runs
// once with good arguments (the fake database must reflect the change) and once with bad ones
// (a friendly ok:false, nothing written). Writes are also staged (dry run) to make sure the
// confirmation flow still works for them.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettings } from '../api/_settings.js'
import * as sched from '../src/lib/gym/schedule.js'
import * as gymLib from '../src/lib/gym/library.js'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const { TOOL_DEFS, executeTool, stageTool, LOOKUP_TOOLS } = await import('../api/assistant.js')

console.warn = () => {}
console.error = () => {}

// ---- an in-memory stand-in for the Supabase client (from assistant-modules.test.mjs) ---------------

const MISSING_TABLE = (table) => ({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
const MISSING_COLUMN = (table, column) => ({ code: 'PGRST204', message: `Could not find the '${column}' column of '${table}' in the schema cache` })
const MISSING_FUNCTION = { code: 'PGRST202', message: 'Could not find the function public.patch_settings(p_patch, p_user) in the schema cache' }

function fakeSupabase({ tables = {}, missingTables = [], missingColumns = {}, rpc = 'ok' } = {}) {
  const db = { tables: structuredClone(tables), calls: [] }
  const rowsOf = (table) => {
    if (!db.tables[table]) db.tables[table] = []
    return db.tables[table]
  }

  class Query {
    constructor(table) {
      this.table = table
      this.op = 'select'
      this.filters = []
      this.orders = []
      this.limitN = null
      this.payload = null
      this.single = false
    }
    select() { return this }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    delete() { this.op = 'delete'; return this }
    eq(column, value) { this.filters.push(['eq', column, value]); return this }
    gte(column, value) { this.filters.push(['gte', column, value]); return this }
    lte(column, value) { this.filters.push(['lte', column, value]); return this }
    in(column, values) { this.filters.push(['in', column, values]); return this }
    order(column, options) { this.orders.push([column, options?.ascending !== false]); return this }
    limit(n) { this.limitN = n; return this }
    maybeSingle() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }

    matches(row) {
      return this.filters.every(([kind, column, value]) => {
        if (kind === 'eq') return String(row[column]) === String(value)
        if (kind === 'gte') return row[column] >= value
        if (kind === 'lte') return row[column] <= value
        if (kind === 'in') return value.map(String).includes(String(row[column]))
        return true
      })
    }

    missingColumnIn(values) {
      for (const item of values) {
        for (const key of Object.keys(item)) if ((missingColumns[this.table] || []).includes(key)) return MISSING_COLUMN(this.table, key)
      }
      return null
    }

    run() {
      const call = { table: this.table, op: this.op, filters: this.filters, payload: structuredClone(this.payload) }
      db.calls.push(call)
      if (missingTables.includes(this.table)) return { data: null, error: MISSING_TABLE(this.table) }
      const rows = rowsOf(this.table)
      if (this.op === 'select') {
        let out = rows.filter((row) => this.matches(row))
        for (const [column, ascending] of [...this.orders].reverse()) {
          out = [...out].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
        }
        if (this.limitN !== null) out = out.slice(0, this.limitN)
        return { data: structuredClone(this.single ? out[0] ?? null : out), error: null }
      }
      if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload]
        const error = this.missingColumnIn(list)
        if (error) return { data: null, error }
        rows.push(...structuredClone(list))
        return { data: null, error: null }
      }
      if (this.op === 'update') {
        const error = this.missingColumnIn([this.payload])
        if (error) return { data: null, error }
        for (const row of rows) if (this.matches(row)) Object.assign(row, structuredClone(this.payload))
        return { data: null, error: null }
      }
      if (this.op === 'delete') {
        db.tables[this.table] = rows.filter((row) => !this.matches(row))
        return { data: null, error: null }
      }
      return { data: null, error: { message: 'unsupported' } }
    }
  }

  return {
    db,
    from: (table) => new Query(table),
    async rpc(name, args) {
      db.calls.push({ rpc: name, args: structuredClone(args) })
      if (rpc === 'missing') return { data: null, error: MISSING_FUNCTION }
      if (rpc === 'fail') return { data: null, error: { code: 'XX000', message: 'database is on fire' } }
      const rows = rowsOf('settings').filter((row) => row.user_id === args.p_user)
      if (rows.length) rows[0].value = mergeSettings(rows[0].value, args.p_patch)
      else rowsOf('settings').push({ id: 'new-settings', user_id: args.p_user, value: args.p_patch, created_at: '2026-09-23T00:00:00Z' })
      return { data: null, error: null }
    },
  }
}

// ---- fixtures --------------------------------------------------------------------------------------

const TODAY = '2026-09-23' // a Wednesday
const YESTERDAY = '2026-09-22'
const USER = 'user-a'
const OTHER = 'user-b'
const ctx = { localDate: TODAY, localTime: '18:00', weekday: 'Wed', timeZone: 'UTC', location: null }

let ids = 0
const nextId = (prefix) => `${prefix}-${(ids += 1)}`

const PREFS = { unit: 'kg', distanceUnit: 'km', firstWeekday: 1, weeklyGoal: 3, defaultRest: 120, e1rmFormula: 'brzycki', previousSource: 'any', progression: true, bodyweightInVolume: true }

function routineRow(exerciseId, weightKg, reps, sets = 3) {
  const row = gymLib.newRoutineExercise(gymLib.exerciseById(exerciseId), () => nextId('row'), sets)
  return { ...row, sets: row.sets.map((set) => ({ ...set, weightKg, repsMin: reps, repsMax: reps })) }
}

const pushRoutine = () => ({
  id: 'push', name: 'Push', color: 'red', notes: '', folderId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  exercises: [routineRow('bench-press', 80, 8), routineRow('overhead-press', 40, 8), routineRow('dumbbell-curl', 12, 12)],
})
const legsRoutine = () => ({ id: 'legs', name: 'Legs', color: 'blue', notes: '', folderId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', exercises: [routineRow('back-squat', 100, 5)] })

const doneSet = (weightKg, reps, extra = {}) => ({ id: nextId('set'), type: 'normal', weightKg, reps, durationSec: null, distanceM: null, rpe: null, done: true, ...extra })
const loggedExercise = (exerciseId, sets) => {
  const entry = gymLib.exerciseById(exerciseId)
  return { id: nextId('ex'), exerciseId, name: entry.name, tracking: entry.tracking, restSec: entry.rest, note: '', supersetId: null, sets }
}

// A logged workout in the app's shape (data.gym_sessions) and as a database row.
function session({ id, date, name = 'Push', routineId = 'push', exercises, startedAt = `${date}T12:00:00.000Z`, durationSec = 3600, bodyweightKg = 80, note = '' }) {
  return {
    id, date, name, routineId, startedAt, endedAt: durationSec ? new Date(Date.parse(startedAt) + durationSec * 1000).toISOString() : null,
    durationSec, exercises, note, planned: null, bodyweightKg, isDeload: false, createdAt: `${date}T13:00:00.000Z`,
  }
}
const toRow = (item, userId = USER) => ({
  id: item.id, user_id: userId, date: item.date, name: item.name, routine_id: item.routineId, started_at: item.startedAt, ended_at: item.endedAt,
  duration_sec: item.durationSec, exercises: item.exercises, note: item.note, planned: item.planned, bodyweight_kg: item.bodyweightKg, is_deload: item.isDeload, created_at: item.createdAt,
})

const benchDay = (id, date, kg) => session({ id, date, exercises: [loggedExercise('bench-press', [doneSet(kg, 8), doneSet(kg, 8), doneSet(kg, 7)]), loggedExercise('back-squat', [doneSet(100, 5), doneSet(100, 5)])] })

// The rotation Push, Legs, rest from today; the routines; a few workouts; everything both in the fake
// database and in the in-memory data the tools read.
function setup({ sessions = [], routines = [pushRoutine(), legsRoutine()], schedule = null, bodyWeights = [], missingTables = [] } = {}) {
  const gymSchedule = schedule || sched.editSchedule(sched.emptySchedule(), { mode: 'rotation', cycle: [{ kind: 'routine', routineId: 'push' }, { kind: 'routine', routineId: 'legs' }, { kind: 'rest' }], anchorIndex: 0 }, TODAY, false, () => 'v1')
  const gymSettings = { schedule: gymSchedule, routines, folders: [], exercises: [], exerciseMeta: {}, prefs: PREFS, active: null }
  const settings = { gym: gymSettings, timeZone: 'UTC' }
  const supabase = fakeSupabase({
    missingTables,
    tables: {
      settings: [{ id: 's1', user_id: USER, value: structuredClone(settings), created_at: '2026-09-01T00:00:00Z' }],
      gym_sessions: [...sessions.map((item) => toRow(item)), toRow(benchDay('theirs', YESTERDAY, 200), OTHER)],
      body_weights: bodyWeights.map((entry) => ({ id: entry.id, user_id: USER, date: entry.date, kg: entry.kg, created_at: `${entry.date}T07:00:00Z` })),
    },
  })
  const sorted = [...sessions].sort((a, b) => (a.date < b.date ? 1 : -1))
  const data = {
    settings: structuredClone(settings),
    gym: { ...structuredClone(gymSettings), schedule: sched.normalizeSchedule(gymSchedule) },
    gym_sessions: structuredClone(sorted),
    gymSessionsTruncated: false,
    gymTablesMissing: missingTables.length > 0,
    body_weights: structuredClone(bodyWeights),
    tasks: [], events: [], friends: [], classes: [], voice_notes: [], journal_entries: [], contact_logs: [], memories: [],
    foodEntries: [], foodMissing: false,
  }
  return { supabase, data }
}

const run = (supabase, data, name, args) => executeTool(supabase, USER, name, args, data, ctx)
const mine = (supabase) => supabase.db.tables.gym_sessions.filter((row) => row.user_id === USER)
const routinesIn = (supabase) => supabase.db.tables.settings[0].value.gym.routines
const def = (name) => TOOL_DEFS.find((tool) => tool.name === name)

// ---- definitions -------------------------------------------------------------------------------------

describe('gym tool definitions', () => {
  test('the new tools exist, are non-strict and gym_stats is a lookup', () => {
    for (const name of ['gym_edit_session', 'gym_duplicate_session', 'gym_stats', 'gym_duplicate_routine']) {
      const tool = def(name)
      assert.ok(tool, name)
      assert.equal(tool.strict, false)
      assert.ok(tool.description.length > 40)
    }
    assert.ok(LOOKUP_TOOLS.includes('gym_stats'))
    assert.ok(!LOOKUP_TOOLS.includes('gym_edit_session'))
    assert.deepEqual(def('gym_edit_session').parameters.required, ['session_id'])
    assert.deepEqual(def('gym_duplicate_session').parameters.required, ['session_id', 'date'])
    assert.deepEqual(def('gym_duplicate_routine').parameters.required, ['name'])
    assert.equal(TOOL_DEFS.filter((tool) => tool.name.startsWith('gym_')).length, new Set(TOOL_DEFS.filter((tool) => tool.name.startsWith('gym_')).map((tool) => tool.name)).size)
  })

  test('gym_log_workout and gym_edit_session share the set shape; the new arguments are there', () => {
    const log = def('gym_log_workout').parameters.properties
    const edit = def('gym_edit_session').parameters.properties
    assert.ok(log.start_time && log.bodyweight)
    assert.deepEqual(edit.exercises, log.exercises)
    for (const key of ['weight', 'reps', 'duration_sec', 'distance_m', 'type', 'rpe', 'count']) assert.ok(edit.exercises.items.properties.sets.items.properties[key], key)
    assert.ok(edit.remove_exercises && edit.date && edit.start_time && edit.duration_min && edit.note && edit.bodyweight)
    const changes = def('gym_edit_routine').parameters.properties.changes.properties
    assert.equal(changes.reorder.type, 'array')
    assert.deepEqual(changes.row_note.required, ['exercise', 'note'])
    assert.ok(def('gym_skip').parameters.properties.note)
  })
})

// ---- gym_log_workout: start_time and bodyweight ---------------------------------------------------------

describe('gym_log_workout start_time and bodyweight', () => {
  test('sets started_at/ended_at from the start time and stores the body weight in kg', async () => {
    const { supabase, data } = setup({ bodyWeights: [{ id: 'w1', date: '2026-09-20', kg: 82 }] })
    const result = await run(supabase, data, 'gym_log_workout', {
      date: TODAY, routine: 'Push', duration_min: 60, start_time: '06:30', bodyweight: 80.5,
      exercises: [{ name: 'Bench Press (Barbell)', sets: [{ weight: 80, reps: 8, count: 3 }] }],
    })
    assert.equal(result.ok, true, result.message)
    const [row] = mine(supabase)
    assert.equal(row.started_at, `${TODAY}T06:30:00.000Z`)
    assert.equal(row.ended_at, `${TODAY}T07:30:00.000Z`)
    assert.equal(row.duration_sec, 3600)
    assert.equal(row.bodyweight_kg, 80.5)
    assert.match(result.message, /started 6:30 AM; body weight 80\.5 kg/)
    assert.equal(data.gym_sessions[0].bodyweightKg, 80.5)
  })

  test('in lb the body weight is converted; without it the latest weigh-in is used', async () => {
    const { supabase, data } = setup({ bodyWeights: [{ id: 'w1', date: '2026-09-20', kg: 82 }] })
    data.gym.prefs.unit = 'lb'
    const result = await run(supabase, data, 'gym_log_workout', { date: YESTERDAY, bodyweight: 176.37, exercises: [{ name: 'Squat (Barbell)', sets: [{ weight: 220, reps: 5 }] }] })
    assert.equal(result.ok, true, result.message)
    assert.equal(Math.round(mine(supabase)[0].bodyweight_kg * 100) / 100, 80)
    const plain = await run(supabase, data, 'gym_log_workout', { date: YESTERDAY, exercises: [{ name: 'Squat (Barbell)', sets: [{ weight: 220, reps: 5 }] }] })
    assert.equal(plain.ok, true)
    assert.equal(mine(supabase)[1].bodyweight_kg, 82)
    assert.equal(mine(supabase)[1].started_at, `${YESTERDAY}T12:00:00.000Z`)
  })

  test('a bad start time, a start later than now, or an impossible body weight is refused', async () => {
    const { supabase, data } = setup()
    const exercises = [{ name: 'Bench Press (Barbell)', sets: [{ weight: 80, reps: 8 }] }]
    for (const args of [
      { date: TODAY, start_time: '25:00', exercises },
      { date: TODAY, start_time: '19:30', exercises }, // it is 18:00
      { date: TODAY, bodyweight: 5000, exercises },
      { date: TODAY, bodyweight: -1, exercises },
    ]) {
      const result = await run(supabase, data, 'gym_log_workout', args)
      assert.equal(result.ok, false, JSON.stringify(args))
    }
    assert.equal(mine(supabase).length, 0)
    // The same start time on an earlier day is fine.
    const ok = await run(supabase, data, 'gym_log_workout', { date: YESTERDAY, start_time: '19:30', exercises })
    assert.equal(ok.ok, true, ok.message)
    assert.equal(mine(supabase)[0].started_at, `${YESTERDAY}T19:30:00.000Z`)
  })
})

// ---- gym_edit_session ---------------------------------------------------------------------------------

describe('gym_edit_session', () => {
  test('replaces an exercise’s sets, adds and removes exercises, and changes the details in place', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', YESTERDAY, 80)] })
    const result = await run(supabase, data, 'gym_edit_session', {
      session_id: 's1',
      name: 'Push A',
      note: 'felt strong',
      duration_min: 70,
      start_time: '18:15',
      bodyweight: 81,
      exercises: [
        { name: 'Bench Press (Barbell)', sets: [{ weight: 82.5, reps: 8, count: 2 }, { weight: 82.5, reps: 6, rpe: 9 }] },
        { name: 'Bicep Curl (Dumbbell)', sets: [{ weight: 12, reps: 12, count: 3 }] },
      ],
      remove_exercises: ['squats'],
    })
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /^Updated Push from yesterday: renamed to Push A; note updated; body weight 81 kg; Bench Press \(Barbell\) now 82\.5 kg × 8, 8, 6; added Bicep Curl \(Dumbbell\) 12 kg × 12, 12, 12; removed Squat \(Barbell\); starts 6:15 PM; 70 min\.$/)
    const [row] = mine(supabase)
    assert.equal(row.name, 'Push A')
    assert.equal(row.note, 'felt strong')
    assert.equal(row.duration_sec, 4200)
    assert.equal(row.started_at, `${YESTERDAY}T18:15:00.000Z`)
    assert.equal(row.ended_at, `${YESTERDAY}T19:25:00.000Z`)
    assert.equal(row.bodyweight_kg, 81)
    assert.equal(row.date, YESTERDAY)
    assert.equal(row.routine_id, 'push')
    assert.deepEqual(row.exercises.map((exercise) => exercise.exerciseId), ['bench-press', 'dumbbell-curl'])
    const bench = row.exercises[0]
    assert.equal(bench.id, data.gym_sessions[0].exercises[0].id) // the row keeps its identity
    assert.equal(bench.restSec, 180)
    assert.deepEqual(bench.sets.map((set) => [set.weightKg, set.reps, set.rpe, set.done]), [[82.5, 8, null, true], [82.5, 8, null, true], [82.5, 6, 9, true]])
    const update = supabase.db.calls.find((call) => call.op === 'update')
    assert.ok(update.filters.some(([, column, value]) => column === 'user_id' && value === USER))
    assert.equal('id' in update.payload, false)
    assert.equal('created_at' in update.payload, false)
    // The other user's row is untouched.
    assert.equal(supabase.db.tables.gym_sessions.find((item) => item.id === 'theirs').name, 'Push')
    assert.equal(data.gym_sessions[0].name, 'Push A')
  })

  test('moving the date keeps the clock time and refreshes the body weight when there was none', async () => {
    const { supabase, data } = setup({ sessions: [{ ...benchDay('s1', YESTERDAY, 80), bodyweightKg: null }], bodyWeights: [{ id: 'w1', date: '2026-09-20', kg: 79 }] })
    const result = await run(supabase, data, 'gym_edit_session', { session_id: 's1', date: '2026-09-21' })
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /moved to Mon, Sep 21/)
    const [row] = mine(supabase)
    assert.equal(row.date, '2026-09-21')
    assert.equal(row.started_at, '2026-09-21T12:00:00.000Z')
    assert.equal(row.ended_at, '2026-09-21T13:00:00.000Z')
    assert.equal(row.bodyweight_kg, 79)
    // Weights given in lb are converted like gym_log_workout does.
    const lb = await run(supabase, data, 'gym_edit_session', { session_id: 's1', unit: 'lb', exercises: [{ name: 'bench', sets: [{ weight: 185, reps: 5 }] }] })
    assert.equal(lb.ok, true, lb.message)
    assert.equal(Math.round(mine(supabase)[0].exercises[0].sets[0].weightKg * 10) / 10, 83.9)
    assert.match(lb.message, /weights given in lb/)
  })

  test('unknown ids, future dates, other users’ workouts and empty edits are refused without writing', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', YESTERDAY, 80)] })
    const before = structuredClone(supabase.db.tables.gym_sessions)
    for (const args of [
      { session_id: 'nope', name: 'x' },
      { session_id: 'theirs', name: 'x' },
      { session_id: '' },
      { session_id: 's1' },
      { session_id: 's1', date: '2026-09-24' },
      { session_id: 's1', date: 'someday' },
      { session_id: 's1', name: '   ' },
      { session_id: 's1', start_time: '9pm' },
      { session_id: 's1', duration_min: 'long' },
      { session_id: 's1', bodyweight: 0 },
      { session_id: 's1', unit: 'stone', exercises: [{ name: 'bench', sets: [{ weight: 10, reps: 5 }] }] },
      { session_id: 's1', exercises: [{ name: 'Flying Kick', sets: [{ reps: 5 }] }] },
      { session_id: 's1', exercises: [{ name: 'Plank', sets: [{ weight: 80 }] }] }, // a timed exercise needs a time
      { session_id: 's1', remove_exercises: ['curls'] },
      { session_id: 's1', remove_exercises: ['bench', 'squat'] },
    ]) {
      const result = await run(supabase, data, 'gym_edit_session', args)
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.ok(result.message.length > 10)
    }
    assert.deepEqual(supabase.db.tables.gym_sessions, before)
    assert.equal(supabase.db.calls.some((call) => call.op === 'update'), false)
    // Missing reps follow the same rule as gym_log_workout: the routine's fixed 8-rep target fills them in.
    const filled = await run(supabase, data, 'gym_edit_session', { session_id: 's1', exercises: [{ name: 'bench', sets: [{ weight: 80, count: 3 }] }] })
    assert.equal(filled.ok, true, filled.message)
    assert.match(filled.message, /8 reps from your plan/)
    assert.deepEqual(mine(supabase)[0].exercises[0].sets.map((set) => set.reps), [8, 8, 8])
  })

  test('a workout not loaded up front is read from the database (only the user’s own)', async () => {
    const old = benchDay('old', '2026-06-01', 60)
    const { supabase, data } = setup({ sessions: [old] })
    data.gym_sessions = []
    data.gymSessionsTruncated = true
    const result = await run(supabase, data, 'gym_edit_session', { session_id: 'old', note: 'from the archive' })
    assert.equal(result.ok, true, result.message)
    assert.equal(mine(supabase).find((row) => row.id === 'old').note, 'from the archive')
    const theirs = await run(supabase, data, 'gym_edit_session', { session_id: 'theirs', note: 'x' })
    assert.equal(theirs.ok, false)
  })

  test('staging simulates the edit without writing', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', YESTERDAY, 80)] })
    const stage = { sim: null, simIds: {}, list: [] }
    const result = await stageTool(supabase, USER, 'gym_edit_session', { session_id: 's1', duration_min: 45 }, data, ctx, stage)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.staged, true)
    assert.match(result.label, /^Update Push from yesterday: 45 min/)
    assert.equal(stage.list.length, 1)
    assert.equal(supabase.db.calls.some((call) => call.op === 'update'), false)
    assert.equal(mine(supabase)[0].duration_sec, 3600)
    assert.equal(data.gym_sessions[0].durationSec, 3600)
    assert.equal(stage.sim.gym_sessions[0].durationSec, 2700)
    // A refused edit is refused when staged too.
    const bad = await stageTool(supabase, USER, 'gym_edit_session', { session_id: 'nope', duration_min: 45 }, data, ctx, stage)
    assert.equal(bad.ok, false)
    assert.equal(stage.list.length, 1)
  })
})

// ---- gym_duplicate_session ----------------------------------------------------------------------------

describe('gym_duplicate_session', () => {
  test('copies the workout to another day with fresh ids and the same time of day', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', '2026-09-20', 80)], bodyWeights: [{ id: 'w1', date: TODAY, kg: 79 }] })
    const result = await run(supabase, data, 'gym_duplicate_session', { session_id: 's1', date: 'today' })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.message, 'Logged a copy of Push from Sun, Sep 20 today: Bench Press (Barbell) 80 kg × 8, 8, 7; Squat (Barbell) 100 kg × 5, 5.')
    const rows = mine(supabase)
    assert.equal(rows.length, 2)
    const copy = rows.find((row) => row.id !== 's1')
    assert.equal(result.id, copy.id)
    assert.match(copy.id, /^[0-9a-f-]{36}$/)
    assert.equal(copy.date, TODAY)
    assert.equal(copy.name, 'Push')
    assert.equal(copy.routine_id, 'push')
    assert.equal(copy.started_at, `${TODAY}T12:00:00.000Z`)
    assert.equal(copy.ended_at, `${TODAY}T13:00:00.000Z`)
    assert.equal(copy.duration_sec, 3600)
    assert.equal(copy.bodyweight_kg, 79) // today's weigh-in, not the original's
    assert.equal(copy.is_deload, false)
    assert.deepEqual(copy.planned, { versionId: 'v2026-09-23-v1', routineId: 'push', cycleIndex: 0 })
    const source = rows.find((row) => row.id === 's1')
    assert.deepEqual(copy.exercises.map((exercise) => exercise.name), source.exercises.map((exercise) => exercise.name))
    assert.notEqual(copy.exercises[0].id, source.exercises[0].id)
    assert.notEqual(copy.exercises[0].sets[0].id, source.exercises[0].sets[0].id)
    assert.deepEqual(copy.exercises[0].sets.map((set) => set.weightKg), [80, 80, 80])
    assert.equal(data.gym_sessions[0].id, copy.id)
    // Its time of day would be in the future today: the copy is timed as ending now instead.
    const evening = { ...benchDay('s2', '2026-09-19', 70), startedAt: '2026-09-19T21:00:00.000Z', endedAt: '2026-09-19T22:00:00.000Z' }
    const { supabase: db2, data: data2 } = setup({ sessions: [evening] })
    const later = await run(db2, data2, 'gym_duplicate_session', { session_id: 's2', date: TODAY })
    assert.equal(later.ok, true, later.message)
    const copy2 = mine(db2).find((row) => row.id !== 's2')
    assert.notEqual(copy2.started_at, `${TODAY}T21:00:00.000Z`)
    assert.equal(Date.parse(copy2.ended_at) - Date.parse(copy2.started_at), 3600 * 1000)
  })

  test('a future day, an unknown or foreign id, and a missing date are refused', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', YESTERDAY, 80)] })
    for (const args of [
      { session_id: 's1', date: '2026-09-24' },
      { session_id: 'nope', date: TODAY },
      { session_id: 'theirs', date: TODAY },
      { session_id: 's1' },
      { session_id: '', date: TODAY },
    ]) {
      const result = await run(supabase, data, 'gym_duplicate_session', args).catch((error) => ({ ok: false, message: error.message }))
      assert.equal(result.ok, false, JSON.stringify(args))
    }
    assert.equal(mine(supabase).length, 1)
    const missing = setup({ sessions: [benchDay('s1', YESTERDAY, 80)], missingTables: ['gym_sessions'] })
    const result = await run(missing.supabase, missing.data, 'gym_duplicate_session', { session_id: 's1', date: TODAY })
    assert.equal(result.ok, false)
    assert.match(result.message, /gym migration/)
  })

  test('staging gives the copy a ref that a later gym_edit_session in the same turn can use', async () => {
    const { supabase, data } = setup({ sessions: [benchDay('s1', YESTERDAY, 80)] })
    const stage = { sim: null, simIds: {}, list: [] }
    const copy = await stageTool(supabase, USER, 'gym_duplicate_session', { session_id: 's1', date: TODAY }, data, ctx, stage)
    assert.equal(copy.ok, true, copy.message)
    assert.equal(copy.ref, '$1')
    assert.match(copy.label, /^Log a copy of Push from yesterday today/)
    const edit = await stageTool(supabase, USER, 'gym_edit_session', { session_id: '$1', exercises: [{ name: 'bench', sets: [{ weight: 85, reps: 5, count: 3 }] }] }, data, ctx, stage)
    assert.equal(edit.ok, true, edit.message)
    assert.equal(stage.list.length, 2)
    assert.equal(mine(supabase).length, 1)
    assert.equal(data.gym_sessions.length, 1)
    assert.equal(stage.sim.gym_sessions.length, 2)
    assert.equal(stage.sim.gym_sessions[0].exercises[0].sets[0].weightKg, 85)
  })
})

// ---- gym_stats -------------------------------------------------------------------------------------------

describe('gym_stats', () => {
  const week = (id, date, kg) => benchDay(id, date, kg)
  const history = () => [week('a', '2026-09-01', 70), week('b', '2026-09-08', 75), week('c', '2026-09-15', 80), week('d', '2026-09-22', 82.5), session({ id: 'e', date: '2026-07-01', exercises: [loggedExercise('bench-press', [doneSet(60, 10)])] })]

  test('totals for the last 4 weeks by default', async () => {
    const { supabase, data } = setup({ sessions: history() })
    const result = await run(supabase, data, 'gym_stats', {})
    assert.equal(result.ok, true, result.message)
    assert.equal(result.range, '2026-08-27 to 2026-09-23')
    assert.equal(result.workouts, 4)
    assert.equal(result.perWeek, '1/week (goal 3)')
    assert.equal(result.byWorkout, 'Push ×4')
    assert.equal(result.workingSets, 20)
    // 4 × (3 bench sets × 8, 8, 7 reps × kg + 2 × 100 × 5): 70·23 + 75·23 + 80·23 + 82.5·23 + 4·1000 = 11,072.5.
    assert.equal(result.volume, '11,073 kg')
    assert.equal(result.minutes, '240 min over 4 timed workouts (avg 60 min)')
    assert.match(result.setsPerMuscle, /^Chest 12, Quads 8, /)
    assert.equal(result.topExercises, 'Bench Press (Barbell) ×4, Squat (Barbell) ×4')
    assert.equal(result.weekly.length, 5)
    assert.equal(result.weekly[4], '2026-09-21: 1 workout, 2,898 kg, 60 min')
    assert.equal(result.streak, '4 weeks')
    assert.equal(result.thisWeek, '1/3')
    assert.ok(result.prs >= 3, `the bench went up three times (${result.prs})`)
    assert.equal(result.units, 'kg, km')
  })

  test('a custom range, an empty range and the user’s unit', async () => {
    const { supabase, data } = setup({ sessions: history() })
    data.gym.prefs.unit = 'lb'
    const july = await run(supabase, data, 'gym_stats', { from: '2026-07-01', to: '2026-07-31' })
    assert.equal(july.workouts, 1)
    assert.equal(july.volume, '1,323 lb')
    assert.equal(july.weekly.length, 5) // July spans five Monday-first weeks
    assert.equal(july.weekly[0], '2026-06-29: 1 workout, 1,323 lb, 60 min')
    const oneWeek = await run(supabase, data, 'gym_stats', { from: '2026-06-29', to: '2026-07-05' })
    assert.equal(oneWeek.weekly, undefined) // a single week: no breakdown
    const empty = await run(supabase, data, 'gym_stats', { from: '2026-08-01', to: '2026-08-15' })
    assert.equal(empty.ok, true)
    assert.equal(empty.workouts, 0)
    assert.match(empty.message, /No logged workouts between 2026-08-01 and 2026-08-15/)
    // Swapped dates are fine; a malformed one is not.
    assert.equal((await run(supabase, data, 'gym_stats', { from: '2026-07-31', to: '2026-07-01' })).workouts, 1)
    const bad = await run(supabase, data, 'gym_stats', { from: 'last month' }).catch((error) => ({ ok: false, message: error.message }))
    assert.equal(bad.ok, false)
  })

  test('one exercise: sessions, best set, e1RM, volume and first vs latest', async () => {
    const { supabase, data } = setup({ sessions: history() })
    const result = await run(supabase, data, 'gym_stats', { exercise: 'bench', from: '2026-09-01' })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.exercise, 'Bench Press (Barbell)')
    assert.equal(result.sessions, 4)
    assert.equal(result.workingSets, 12)
    assert.equal(result.totalReps, 92)
    assert.equal(result.volume, '7,073 kg')
    assert.equal(result.bestSet, '82.5 kg × 8 (2026-09-22)')
    assert.equal(result.estimated1RM, '102.4 kg (brzycki)')
    assert.equal(result.first, '2026-09-01: 70 kg × 8')
    assert.equal(result.latest, '2026-09-22: 82.5 kg × 8')
    assert.ok(result.prs >= 3, `three heavier sessions (${result.prs})`)
    const none = await run(supabase, data, 'gym_stats', { exercise: 'Plank' })
    assert.equal(none.ok, true)
    assert.equal(none.sessions, 0)
    assert.match(none.message, /No sets of Plank/)
    const unknown = await run(supabase, data, 'gym_stats', { exercise: 'Flying Kick' })
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /No exercise called "Flying Kick"/)
  })

  test('without the gym tables it explains instead of failing', async () => {
    const { supabase, data } = setup({ missingTables: ['gym_sessions', 'body_weights'] })
    const result = await run(supabase, data, 'gym_stats', {})
    assert.equal(result.ok, true)
    assert.match(result.message, /gym migration/)
  })
})

// ---- gym_edit_routine: reorder and row_note; gym_duplicate_routine ------------------------------------------

describe('gym_edit_routine reorder and row_note', () => {
  test('reorders by name (unlisted ones follow) and sets or clears an exercise note', async () => {
    const { supabase, data } = setup()
    const result = await run(supabase, data, 'gym_edit_routine', { name: 'Push', changes: { reorder: ['curls', 'overhead press'], row_note: { exercise: 'bench', note: 'pause at the chest' } } })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.message, 'Updated Push: Bench Press (Barbell) note “pause at the chest”; order: Bicep Curl (Dumbbell), Overhead Press (Barbell), Bench Press (Barbell).')
    const push = routinesIn(supabase).find((routine) => routine.id === 'push')
    assert.deepEqual(push.exercises.map((row) => row.exerciseId), ['dumbbell-curl', 'overhead-press', 'bench-press'])
    assert.equal(push.exercises[2].note, 'pause at the chest')
    assert.deepEqual(data.gym.routines.find((routine) => routine.id === 'push').exercises.map((row) => row.exerciseId), ['dumbbell-curl', 'overhead-press', 'bench-press'])
    // Sets and rest are untouched by a reorder.
    assert.equal(push.exercises[2].sets.length, 3)
    assert.equal(push.exercises[2].restSec, 180)
    const cleared = await run(supabase, data, 'gym_edit_routine', { name: 'push', changes: { row_note: [{ exercise: 'Bench Press (Barbell)', note: '' }] } })
    assert.equal(cleared.ok, true, cleared.message)
    assert.match(cleared.message, /note removed/)
    assert.equal(routinesIn(supabase).find((routine) => routine.id === 'push').exercises[2].note, '')
    // Reordering to what was added in the same call works (add first, then order).
    const both = await run(supabase, data, 'gym_edit_routine', { name: 'push', changes: { add_exercises: [{ name: 'Lateral Raise (Dumbbell)', sets: 3, reps_min: 12, reps_max: 15 }], reorder: ['lateral raise'] } })
    assert.equal(both.ok, true, both.message)
    assert.equal(routinesIn(supabase).find((routine) => routine.id === 'push').exercises[0].exerciseId, 'lateral-raise')
  })

  test('an exercise that isn’t in the routine, or an unknown routine, is refused without saving', async () => {
    const { supabase, data } = setup()
    const before = structuredClone(routinesIn(supabase))
    for (const args of [
      { name: 'Push', changes: { reorder: ['squats'] } },
      { name: 'Push', changes: { row_note: { exercise: 'squat', note: 'x' } } },
      { name: 'Pull', changes: { reorder: ['bench'] } },
      { name: 'Push', changes: { reorder: [] } },
    ]) {
      const result = await run(supabase, data, 'gym_edit_routine', args).catch((error) => ({ ok: false, message: error.message }))
      assert.equal(result.ok, false, JSON.stringify(args))
    }
    assert.deepEqual(routinesIn(supabase), before)
  })
})

describe('gym_duplicate_routine', () => {
  test('copies a routine with fresh ids, a new name and colour; it can be staged and edited by ref', async () => {
    const { supabase, data } = setup()
    const result = await run(supabase, data, 'gym_duplicate_routine', { name: 'push', new_name: 'Push B' })
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /^Created Push B as a copy of Push: Bench Press \(Barbell\) 3×8 @ 80 kg; Overhead Press \(Barbell\) 3×8 @ 40 kg; Bicep Curl \(Dumbbell\) 3×12 @ 12 kg\. It isn’t in the schedule yet\.$/)
    const routines = routinesIn(supabase)
    assert.equal(routines.length, 3)
    const copy = routines.find((routine) => routine.name === 'Push B')
    assert.equal(copy.id, result.id)
    assert.match(copy.id, /^[0-9a-f-]{36}$/)
    assert.notEqual(copy.color, 'red')
    const source = routines.find((routine) => routine.id === 'push')
    assert.deepEqual(copy.exercises.map((row) => row.exerciseId), source.exercises.map((row) => row.exerciseId))
    assert.notEqual(copy.exercises[0].id, source.exercises[0].id)
    assert.deepEqual(copy.exercises[0].sets.map((set) => set.weightKg), [80, 80, 80])
    assert.equal(data.gym.routines.length, 3)
    // The default name, and the copy is edited in the same turn through its ref.
    const stage = { sim: null, simIds: {}, list: [] }
    const staged = await stageTool(supabase, USER, 'gym_duplicate_routine', { name: 'Legs' }, data, ctx, stage)
    assert.equal(staged.ok, true, staged.message)
    assert.match(staged.label, /^Create Legs copy as a copy of Legs/)
    const edited = await stageTool(supabase, USER, 'gym_edit_routine', { name: '$1', changes: { rename: 'Legs B' } }, data, ctx, stage)
    assert.equal(edited.ok, true, edited.message)
    assert.equal(routinesIn(supabase).length, 3) // staged: nothing written
    assert.equal(stage.sim.gym.routines.find((routine) => routine.name === 'Legs B') !== undefined, true)
  })

  test('a name clash or an unknown routine is refused', async () => {
    const { supabase, data } = setup()
    for (const args of [{ name: 'Push', new_name: 'legs' }, { name: 'Pull' }, { name: '' }, {}]) {
      const result = await run(supabase, data, 'gym_duplicate_routine', args).catch((error) => ({ ok: false, message: error.message }))
      assert.equal(result.ok, false, JSON.stringify(args))
    }
    assert.equal(routinesIn(supabase).length, 2)
  })
})

// ---- gym_skip with a note ---------------------------------------------------------------------------------

describe('gym_skip note', () => {
  test('stores the reason with the skip and can add it to an existing skip', async () => {
    const { supabase, data } = setup()
    const result = await run(supabase, data, 'gym_skip', { date: 'tomorrow', note: 'sick' })
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /^Skipped Legs tomorrow \(sick\)/)
    assert.deepEqual(supabase.db.tables.settings[0].value.gym.schedule.skips, { '2026-09-24': { note: 'sick' } })
    const again = await run(supabase, data, 'gym_skip', { date: 'tomorrow', note: 'sick' })
    assert.equal(again.noop, true)
    const changed = await run(supabase, data, 'gym_skip', { date: 'tomorrow', note: 'travelling' })
    assert.equal(changed.ok, true)
    assert.match(changed.message, /Noted why/)
    assert.deepEqual(data.gym.schedule.skips['2026-09-24'], { note: 'travelling' })
    // A rest day can't be skipped; neither can yesterday.
    assert.equal((await run(supabase, data, 'gym_skip', { date: '2026-09-25', note: 'x' })).ok, false)
    const past = await run(supabase, data, 'gym_skip', { date: YESTERDAY }).catch((error) => ({ ok: false, message: error.message }))
    assert.equal(past.ok, false)
  })
})

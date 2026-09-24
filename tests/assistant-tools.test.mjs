// Crash and contract harness for every assistant tool: each tool in TOOL_DEFS runs with sensible
// arguments (the fake database must reflect the change) and with missing, wrong or unknown
// arguments (a friendly ok:false is expected). Every write tool is also staged (dry run) and must
// leave the database and the in-memory data alone. Real bugs stay as failing assertions marked
// `todo` so the suite stays green while the handler is fixed.
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
const { TOOL_DEFS, executeTool, stageTool, buildSnapshot, buildInstructions, LOOKUP_TOOLS, UI_TOOLS } = await import('../api/assistant.js')

// Expected console noise (resolveFriend fallbacks, snapshot warnings) would hide real output.
console.warn = () => {}
console.error = () => {}

// ---- an in-memory stand-in for the Supabase client -------------------------------------------------

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
      this.rangeArg = null
      this.payload = null
      this.single = false
      this.returning = false
    }
    select() { if (this.op !== 'select') this.returning = true; return this }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this }
    upsert(rows) { this.op = 'upsert'; this.payload = rows; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    delete() { this.op = 'delete'; return this }
    eq(column, value) { this.filters.push(['eq', column, value]); return this }
    neq(column, value) { this.filters.push(['neq', column, value]); return this }
    gt(column, value) { this.filters.push(['gt', column, value]); return this }
    lt(column, value) { this.filters.push(['lt', column, value]); return this }
    gte(column, value) { this.filters.push(['gte', column, value]); return this }
    lte(column, value) { this.filters.push(['lte', column, value]); return this }
    is(column, value) { this.filters.push(['is', column, value]); return this }
    in(column, values) { this.filters.push(['in', column, values]); return this }
    ilike(column, pattern) { this.filters.push(['ilike', column, pattern]); return this }
    like(column, pattern) { this.filters.push(['like', column, pattern]); return this }
    order(column, options) { this.orders.push([column, options?.ascending !== false]); return this }
    limit(n) { this.limitN = n; return this }
    range(from, to) { this.rangeArg = [from, to]; return this }
    maybeSingle() { this.single = true; return this }
    single() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }
    catch(reject) { return this.then(undefined, reject) }
    finally(callback) { return this.then().finally(callback) }

    matches(row) {
      const likeRe = (pattern, flags) => new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, flags)
      return this.filters.every(([kind, column, value]) => {
        if (kind === 'eq') return String(row[column]) === String(value)
        if (kind === 'neq') return String(row[column]) !== String(value)
        if (kind === 'gt') return row[column] > value
        if (kind === 'lt') return row[column] < value
        if (kind === 'gte') return row[column] >= value
        if (kind === 'lte') return row[column] <= value
        if (kind === 'is') return row[column] == value // eslint-disable-line eqeqeq
        if (kind === 'in') return value.map(String).includes(String(row[column]))
        if (kind === 'ilike') return likeRe(value, 'i').test(String(row[column] ?? ''))
        if (kind === 'like') return likeRe(value, '').test(String(row[column] ?? ''))
        return true
      })
    }

    missingColumnIn(values) {
      for (const item of values) {
        for (const key of Object.keys(item)) if ((missingColumns[this.table] || []).includes(key)) return MISSING_COLUMN(this.table, key)
      }
      return null
    }

    shape(list) {
      const out = structuredClone(list)
      return this.single ? out[0] ?? null : out
    }

    run() {
      db.calls.push({ table: this.table, op: this.op, filters: this.filters, payload: structuredClone(this.payload) })
      if (missingTables.includes(this.table)) return { data: null, error: MISSING_TABLE(this.table) }
      const rows = rowsOf(this.table)
      if (this.op === 'select') {
        let out = rows.filter((row) => this.matches(row))
        for (const [column, ascending] of [...this.orders].reverse()) {
          out = [...out].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
        }
        if (this.rangeArg) out = out.slice(this.rangeArg[0], this.rangeArg[1] + 1)
        if (this.limitN !== null) out = out.slice(0, this.limitN)
        return { data: this.shape(out), error: null }
      }
      if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload]
        const error = this.missingColumnIn(list)
        if (error) return { data: null, error }
        for (const item of list) {
          const index = this.op === 'upsert' ? rows.findIndex((row) => row.id === item.id) : rows.findIndex((row) => row.id !== undefined && row.id === item.id)
          if (index >= 0 && this.op === 'upsert') rows[index] = structuredClone(item)
          else if (index >= 0) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.table}_pkey"` } }
          else rows.push(structuredClone(item))
        }
        return { data: this.returning ? this.shape(list) : null, error: null }
      }
      if (this.op === 'update') {
        const error = this.missingColumnIn([this.payload])
        if (error) return { data: null, error }
        const hit = rows.filter((row) => this.matches(row))
        for (const row of hit) Object.assign(row, structuredClone(this.payload))
        return { data: this.returning ? this.shape(hit) : null, error: null }
      }
      if (this.op === 'delete') {
        const hit = rows.filter((row) => this.matches(row))
        db.tables[this.table] = rows.filter((row) => !this.matches(row))
        return { data: this.returning ? this.shape(hit) : null, error: null }
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

// ---- fixture: what loadData() + loadFood() return, and the rows behind it --------------------------

const USER = 'user-a'
const TODAY = '2026-09-24' // a Thursday
const YESTERDAY = '2026-09-23'
const TOMORROW = '2026-09-25'
const AT = '2026-09-20T10:00:00Z'
const ctx = { localDate: TODAY, localTime: '14:30', weekday: 'Thu', timeZone: 'UTC', location: null }

const CUSTOM_EXERCISES = [
  { id: 'custom-1', name: 'Cable Woodchop', primary: 'abs', secondary: [], equipment: 'cable', category: 'isolation', movement: 'core', tracking: 'weight_reps', rest: 90, custom: true, hidden: false, bwVolume: false, createdAt: AT },
  { id: 'custom-2', name: 'Sled Push', primary: 'quads', secondary: ['glutes'], equipment: 'machine', category: 'compound', movement: 'legs', tracking: 'weight_distance', rest: 120, custom: true, hidden: false, bwVolume: false, createdAt: AT },
]

// A routine row for a library or custom exercise, optionally with a fixed rep target and a weight.
function routineRow(id, exerciseId, { reps = null, weightKg = null } = {}) {
  const entry = gymLib.exerciseById(exerciseId, CUSTOM_EXERCISES)
  assert.ok(entry, `fixture: unknown exercise ${exerciseId}`)
  const row = gymLib.newRoutineExercise(entry, () => id, 3)
  if (reps !== null || weightKg !== null) row.sets = row.sets.map((set) => ({ ...set, ...(reps !== null ? { repsMin: reps, repsMax: reps } : {}), ...(weightKg !== null ? { weightKg } : {}) }))
  return row
}

const doneSet = (id, weightKg, reps, extra = {}) => ({ id, type: 'normal', weightKg, reps, durationSec: null, distanceM: null, rpe: null, done: true, ...extra })

function buildGym() {
  const push = { kind: 'routine', routineId: 'r-push' }
  const pull = { kind: 'routine', routineId: 'r-pull' }
  const legs = { kind: 'routine', routineId: 'r-legs' }
  const rest = { kind: 'rest' }
  return {
    // 4-day rotation since Sep 14 with today (10 days on) at anchor 2 → index 0 → Push. Tomorrow: Pull,
    // Sat 26: rest, Sun 27: Legs, Mon 28: Push, Tue 29: Pull, Wed 30: rest, Thu Oct 1: Legs.
    schedule: {
      versions: [{ id: 'v1', effectiveFrom: '2026-09-14', mode: 'rotation', cycle: [push, pull, rest, legs], anchorIndex: 2, weekly: [] }],
      shifts: [],
      skips: { '2026-09-29': {} }, // a Pull day, skipped
      overrides: { '2026-10-01': { slot: { kind: 'rest' } } }, // a Legs day made rest
      deload: { everyWeeks: 0 },
    },
    routines: [
      { id: 'r-push', name: 'Push', color: 'red', notes: '', folderId: null, exercises: [routineRow('row-bench', 'bench-press', { reps: 8, weightKg: 60 }), routineRow('row-ohp', 'overhead-press')], createdAt: AT, updatedAt: AT },
      { id: 'r-pull', name: 'Pull', color: 'blue', notes: '', folderId: null, exercises: [routineRow('row-lat', 'lat-pulldown')], createdAt: AT, updatedAt: AT },
      { id: 'r-legs', name: 'Legs', color: 'green', notes: '', folderId: null, exercises: [routineRow('row-squat', 'back-squat', { reps: 5, weightKg: 80 }), routineRow('row-rdl', 'romanian-deadlift'), routineRow('row-plank', 'plank'), routineRow('row-chop', 'custom-1')], createdAt: AT, updatedAt: AT },
    ],
    folders: [],
    exercises: structuredClone(CUSTOM_EXERCISES),
    exerciseMeta: { 'bench-press': { note: 'Feet flat', restSec: 150 } },
    prefs: { unit: 'kg', distanceUnit: 'km', firstWeekday: 1, weeklyGoal: 3, defaultRest: 120, e1rmFormula: 'brzycki', previousSource: 'any', progression: true, bodyweightInVolume: true },
    active: null,
  }
}

function buildSettings() {
  return {
    theme: 'sunset',
    appearance: 'system',
    displayName: 'Amaan',
    showPrayerTimes: true,
    prayerMethod: 'auto',
    prayerSchool: 0,
    assistantConfirm: 'all',
    assistantWeb: 'ask',
    timeZone: 'UTC',
    notifications: { taskLead: 15, allDayTime: '09:00', dailySummary: true, gym: true, gymTime: '17:00' },
    gym: buildGym(),
    food: {
      goals: { calories: 2200, protein: 150, carbs: 250, fat: 70, source: 'manual' },
      profile: { sex: 'male', birthYear: 1998, heightCm: 178, activity: 'moderate', goal: 'maintain' },
      prefs: { energyUnit: 'kcal' },
      favorites: [{ id: 'fav1', name: 'Protein shake', brand: '', amount: 1, unit: 'scoop', grams: 30, calories: 120, proteinG: 24, carbsG: 3, fatG: 1.5, aliases: ['my shake'], source: 'user', verifiedAt: AT, updatedAt: AT }],
    },
  }
}

const gymSessionRow = (id, date, name, routineId, exercises, extra = {}) => ({
  id, user_id: USER, date, name, routine_id: routineId, started_at: `${date}T17:00:00Z`, ended_at: `${date}T18:00:00Z`, duration_sec: 3600,
  exercises, note: '', planned: null, bodyweight_kg: 75, is_deload: false, created_at: `${date}T18:00:00Z`, ...extra,
})

const foodRow = (id, date, meal, name, calories, macros = {}) => ({
  id, user_id: USER, date, time: date === TODAY ? '08:30' : null, meal, name, brand: null, unit: 'g', amount: 100, grams: 100,
  calories, protein_g: macros.protein ?? 10, carbs_g: macros.carbs ?? 40, fat_g: macros.fat ?? 8, fiber_g: 3, sugar_g: 2, sodium_mg: 50,
  extra: {}, note: null, source: 'manual', favorite_id: null, ai: null, created_at: `${date}T09:00:00Z`,
})

function buildTables() {
  const settings = buildSettings()
  const task = (id, text, fields) => ({ id, user_id: USER, text, date: '', time: '', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: null, created_at: AT, ...fields })
  const event = (id, title, date, time, taskId = null) => ({ id, user_id: USER, title, date, time, task_id: taskId, created_at: AT })
  const friend = (id, name, fields) => ({ id, user_id: USER, name, relationship: 'friend', reminder_days: 30, organization: '', note: '', birthday: '', current_status: '', facts: '', created_at: AT, ...fields })
  return {
    tasks: [
      task('t1', 'Dentist appointment', { date: TODAY, time: '15:00', calendar_event_id: 'e1' }),
      task('t2', 'Buy milk', {}),
      task('t3', 'Submit essay', { date: '2026-09-20', done: true, completed_at: '2026-09-20T18:00:00Z' }),
      task('t4', 'Old idea', { archived: true }),
      task('t5', 'Talk to Hasan Raza', { date: TODAY, details: `friend-reminder:f1:${TODAY}`, calendar_event_id: 'e5' }),
      task('t6', 'Pay rent', { date: '2026-09-21', calendar_event_id: 'e6' }),
    ],
    events: [
      event('e1', 'Dentist appointment', TODAY, '15:00', 't1'),
      event('e2', 'Concert', '2026-09-26', '19:00'),
      event('e5', 'Talk to Hasan Raza', TODAY, '', 't5'),
      event('e6', 'Pay rent', '2026-09-21', '', 't6'),
      event('e-old', 'Summer picnic', '2026-08-01', '12:00'),
    ],
    friends: [
      friend('f1', 'Hasan Raza', { relationship: 'close_friend', reminder_days: 10, organization: 'Acme', birthday: '2000-10-01', current_status: 'new job', facts: 'Likes chess' }),
      friend('f2', 'Sarah Connor', {}),
      friend('f3', 'Ali Khan', { organization: 'Google' }),
      friend('f4', 'Ali Raza', { relationship: 'close_friend', reminder_days: 10 }),
    ],
    contact_logs: [
      { id: 'c1', user_id: USER, friend_id: 'f1', date: '2026-09-20', note: 'his new job at Shopify', created_at: AT },
      { id: 'c2', user_id: USER, friend_id: 'f2', date: TODAY, note: '', created_at: AT },
      { id: 'c3', user_id: USER, friend_id: 'f1', date: '2026-09-10', note: 'chess', created_at: AT },
    ],
    voice_notes: [
      { id: 'n1', user_id: USER, text: 'The wifi password is on the router', created_at: '2026-09-22T09:00:00Z' },
      { id: 'n2', user_id: USER, text: 'Gift ideas: a book', created_at: '2026-09-21T09:00:00Z' },
    ],
    classes: [
      { id: 'k1', user_id: USER, name: 'Algorithms', days: [{ day: 'Thu', time: '9:00 AM - 10:30 AM', room: 'B1' }, { day: 'Mon', time: '9:00 AM - 10:30 AM' }], end_date: '2026-12-10', created_at: AT },
      { id: 'k2', user_id: USER, name: 'Physics', days: ['Tue'], day_details: { Tue: { time: '2:00 PM - 3:00 PM', room: 'L2' } }, end_date: null, created_at: AT },
    ],
    journal_entries: [
      { id: 'j1', user_id: USER, date: TODAY, title: 'Good day', body: 'Went to the gym.', mood: 'good', created_at: AT },
      { id: 'j2', user_id: USER, date: '2026-09-22', title: '', body: 'x'.repeat(600), mood: '', created_at: AT },
    ],
    settings: [{ id: 's1', user_id: USER, value: settings, created_at: AT }],
    gym_sessions: [
      gymSessionRow('s1', '2026-09-22', 'Push', 'r-push', [{ id: 'se1', exerciseId: 'bench-press', name: 'Bench Press (Barbell)', tracking: 'weight_reps', restSec: 180, note: '', supersetId: null, sets: [doneSet('x1', 60, 8), doneSet('x2', 60, 8), doneSet('x3', 60, 7)] }]),
      gymSessionRow('s2', '2026-09-19', 'Legs', 'r-legs', [{ id: 'se2', exerciseId: 'back-squat', name: 'Squat (Barbell)', tracking: 'weight_reps', restSec: 180, note: '', supersetId: null, sets: [doneSet('y1', 80, 5), doneSet('y2', 80, 5)] }]),
      // In the database only (older than what loadData reads): gym_delete_session must find it there.
      gymSessionRow('s-old', '2026-03-01', 'Push', 'r-push', []),
    ],
    body_weights: [
      { id: 'bw1', user_id: USER, date: YESTERDAY, kg: 75, created_at: `${YESTERDAY}T07:00:00Z` },
      { id: 'bw2', user_id: USER, date: '2026-09-16', kg: 76, created_at: '2026-09-16T07:00:00Z' },
    ],
    assistant_memories: [
      { id: 'm1', user_id: USER, content: 'User works at Acme and finishes at 5 PM', created_at: '2026-09-01T00:00:00Z' },
      { id: 'm2', user_id: USER, content: 'User is studying computer science', created_at: '2026-09-02T00:00:00Z' },
    ],
    food_entries: [
      foodRow('fe1', TODAY, 'breakfast', 'Oats', 300, { protein: 10, carbs: 54, fat: 6 }),
      foodRow('fe2', YESTERDAY, 'lunch', 'Chicken rice', 650, { protein: 45, carbs: 70, fat: 15 }),
    ],
  }
}

// The same shapes loadData() and loadFood() build from those rows.
function buildData(tables) {
  const t = structuredClone(tables)
  const settings = t.settings[0].value
  const rawGym = settings.gym
  const session = (row) => ({ id: row.id, date: row.date, name: row.name, routineId: row.routine_id, startedAt: row.started_at, endedAt: row.ended_at, durationSec: row.duration_sec, exercises: row.exercises, note: row.note, planned: row.planned, bodyweightKg: row.bodyweight_kg, isDeload: row.is_deload, createdAt: row.created_at })
  const foodEntry = (row) => ({
    id: row.id, date: row.date, time: row.time, meal: row.meal, name: row.name, brand: row.brand, unit: row.unit, amount: row.amount, grams: row.grams,
    calories: row.calories, proteinG: row.protein_g, carbsG: row.carbs_g, fatG: row.fat_g, fiberG: row.fiber_g, sugarG: row.sugar_g, sodiumMg: row.sodium_mg,
    extra: row.extra, note: row.note, source: row.source, favoriteId: row.favorite_id, ai: row.ai, createdAt: row.created_at,
  })
  return {
    tasks: t.tasks,
    events: t.events,
    friends: t.friends.map(({ user_id, ...friend }) => friend),
    voice_notes: t.voice_notes,
    classes: t.classes,
    journal_entries: t.journal_entries,
    contact_logs: t.contact_logs.map((log) => ({ id: log.id, friend_id: log.friend_id, date: log.date, note: log.note || '', created_at: log.created_at })),
    settings,
    gym: { ...rawGym, schedule: sched.normalizeSchedule(rawGym.schedule) },
    gymTablesMissing: false,
    gym_sessions: t.gym_sessions.filter((row) => row.date >= '2026-06-01').map(session),
    gymSessionsTruncated: false,
    body_weights: t.body_weights.map((row) => ({ id: row.id, date: row.date, kg: row.kg, createdAt: row.created_at })),
    memories: t.assistant_memories.map(({ id, content, created_at }) => ({ id, content, created_at })),
    foodEntries: t.food_entries.map(foodEntry),
    foodMissing: false,
  }
}

function fixture() {
  const tables = buildTables()
  return { supabase: fakeSupabase({ tables }), data: buildData(tables) }
}

const settingsOf = (supabase) => supabase.db.tables.settings.find((row) => row.user_id === USER).value
const rows = (supabase, table) => supabase.db.tables[table] || []
const row = (supabase, table, id) => rows(supabase, table).find((item) => item.id === id)

// ---- the case table ----------------------------------------------------------------------------------
// valid: arguments that must succeed (ok:true); `check` looks at the fake database / data afterwards;
// `noop: true` for a call that reports nothing to change (ok:true, but stageTool refuses it).
// invalid: arguments that must be refused (ok:false with a message, or a thrown user message).

const CASES = [
  {
    name: 'create_task',
    valid: [
      { args: { text: 'Call the bank', date: TOMORROW, time: '10:00', reminderMinutes: 0, priority: 'urgent', details: 'ask about fees' }, check(s, d, r) {
        const task = row(s, 'tasks', r.id)
        assert.equal(task.text, 'Call the bank')
        assert.equal(task.reminder_minutes, 0)
        assert.ok(rows(s, 'events').some((event) => event.task_id === r.id && event.date === TOMORROW), 'a dated task gets a calendar event')
        assert.equal(d.tasks[0].id, r.id)
      } },
      { args: { text: 'Buy bread' }, check(s, d, r) { assert.ok(row(s, 'tasks', r.id)); assert.ok(!rows(s, 'events').some((event) => event.task_id === r.id)) } },
      { args: { text: 'Gym', date: 'tomorrow' }, check(s, d, r) { assert.equal(row(s, 'tasks', r.id).date, TOMORROW) } },
    ],
    invalid: [{}, { text: '   ' }, { text: 'x', date: 'next friday' }, { text: 'x', time: '10:00' }, { text: 'x', date: TOMORROW, time: '10am' }, { text: 'x', date: '2026-13-45' }],
    bugs: [{ args: { text: 'x', priority: 'high' }, todo: 'BUG: create_task stores any priority string (schema enum is not enforced; update_task does check it)' }],
  },
  {
    name: 'update_task',
    valid: [
      { args: { taskId: 't1', done: true }, check(s) { assert.equal(row(s, 'tasks', 't1').done, true); assert.ok(row(s, 'tasks', 't1').completed_at); assert.ok(!row(s, 'events', 'e1'), 'a completed task leaves the calendar') } },
      { args: { taskId: 't2', date: TOMORROW, time: '09:00' }, check(s) { assert.ok(rows(s, 'events').some((event) => event.task_id === 't2' && event.time === '09:00'), 'a newly dated task gets an event') } },
      { args: { taskId: 't1', text: 'Dentist', priority: 'low', details: 'bring the card' }, check(s) { assert.equal(row(s, 'events', 'e1').title, 'Dentist', 'the linked event is renamed'); assert.equal(rows(s, 'events').filter((event) => event.task_id === 't1').length, 1) } },
      { args: { taskId: 't5', done: true }, check(s, d) { assert.ok(rows(s, 'contact_logs').some((log) => log.friend_id === 'f1' && log.date === TODAY), 'completing a catch-up reminder logs the catch-up'); assert.ok(d.contact_logs.some((log) => log.friend_id === 'f1' && log.date === TODAY)) } },
      { args: { taskId: 't3', done: false }, check(s) { assert.equal(row(s, 'tasks', 't3').completed_at, null); assert.ok(rows(s, 'events').some((event) => event.task_id === 't3'), 'a reopened dated task is back on the calendar') } },
      { args: { taskId: 't4', archived: false }, check(s) { assert.equal(row(s, 'tasks', 't4').archived, false) } },
      { args: { taskId: 't1', reminderMinutes: 30 }, check(s) { assert.equal(row(s, 'tasks', 't1').reminder_minutes, 30) } },
      { args: { taskId: 't1', date: '' }, check(s) { assert.equal(row(s, 'tasks', 't1').time, ''); assert.ok(!row(s, 'events', 'e1')) } },
      { args: { taskId: 't6', date: 'today' }, check(s) { assert.equal(row(s, 'tasks', 't6').date, TODAY); assert.equal(row(s, 'events', 'e6').date, TODAY) } },
    ],
    invalid: [{}, { taskId: 'nope', done: true }, { taskId: 't1' }, { taskId: 't1', text: '' }, { taskId: 't1', priority: 'high' }, { taskId: 't1', date: 'today at 5' }, { taskId: 't2', time: '09:00' }, { taskId: 't5', details: 'x' }],
    bugs: [{ args: { taskId: 't1', done: 'yes' }, todo: 'BUG: update_task accepts a non-boolean done/archived and writes the string to a boolean column' }],
  },
  {
    name: 'update_tasks',
    valid: [
      { args: { taskIds: ['t1', 't6'], date: TOMORROW }, check(s) { assert.equal(row(s, 'tasks', 't1').date, TOMORROW); assert.equal(row(s, 'tasks', 't6').date, TOMORROW); assert.equal(row(s, 'events', 'e6').date, TOMORROW) } },
      { args: { taskIds: ['t1', 't2'], done: true }, check(s) { assert.equal(row(s, 'tasks', 't2').done, true) } },
      { args: { taskIds: ['t6'], archived: true }, check(s) { assert.equal(row(s, 'tasks', 't6').archived, true) } },
      { args: { taskIds: ['t1'], date: 'tomorrow' }, check(s) { assert.equal(row(s, 'tasks', 't1').date, TOMORROW) } },
    ],
    invalid: [{}, { taskIds: [] }, { taskIds: ['nope'], done: true }, { taskIds: ['t1'] }, { taskIds: 't1', done: true }, { taskIds: ['t1'], priority: 'high' }, { taskIds: ['t1'], date: 'soon' }],
  },
  {
    name: 'delete_task_forever',
    valid: [{ args: { taskId: 't1' }, check(s, d) { assert.ok(!row(s, 'tasks', 't1')); assert.ok(!row(s, 'events', 'e1')); assert.ok(!d.tasks.some((task) => task.id === 't1')) } }],
    invalid: [{}, { taskId: 'nope' }],
  },
  {
    name: 'create_event',
    valid: [
      { args: { title: 'Flight to Karachi', date: '2026-10-02', time: '06:45', details: 'Gate 12' }, check(s, d, r) {
        assert.equal(row(s, 'events', r.id).time, '06:45')
        const task = row(s, 'tasks', r.taskId)
        assert.equal(task.details, 'Gate 12')
        assert.equal(task.calendar_event_id, r.id)
      } },
      { args: { title: 'Party', date: 'tomorrow' }, check(s, d, r) { assert.equal(row(s, 'events', r.id).date, TOMORROW) } },
    ],
    invalid: [{}, { title: 'x' }, { title: '', date: '2026-10-02' }, { title: 'x', date: 'Friday' }, { title: 'x', date: '2026-10-02', time: '6:45pm' }],
  },
  {
    name: 'update_event',
    valid: [
      { args: { eventId: 'e2', title: 'Concert (moved)', date: '2026-09-27', time: '20:00' }, check(s) { assert.equal(row(s, 'events', 'e2').date, '2026-09-27') } },
      { args: { eventId: 'e1', time: '16:00' }, check(s) { assert.equal(row(s, 'tasks', 't1').time, '16:00', 'the linked task follows') } },
      { args: { eventId: 'e1', details: 'Room 4' }, check(s) { assert.equal(row(s, 'tasks', 't1').details, 'Room 4') } },
      { args: { eventId: 'e2', date: 'tomorrow' }, check(s) { assert.equal(row(s, 'events', 'e2').date, TOMORROW) } },
    ],
    invalid: [{}, { eventId: 'nope', title: 'x' }, { eventId: 'e2', date: '' }, { eventId: 'e2', date: '2026-9-27' }, { eventId: 'e2', time: '8pm' }],
    bugs: [{ args: { eventId: 'e2' }, todo: 'BUG: update_event with nothing to change reports "Updated" (no "Nothing to change" check like update_task)' }],
  },
  {
    name: 'delete_event',
    valid: [
      { args: { eventId: 'e2' }, check(s) { assert.ok(!row(s, 'events', 'e2')) } },
      { args: { eventId: 'e1' }, check(s, d) { assert.ok(!row(s, 'events', 'e1')); assert.equal(row(s, 'tasks', 't1').archived, true, 'its task is archived'); assert.equal(d.tasks.find((task) => task.id === 't1').archived, true) } },
    ],
    invalid: [{}, { eventId: 'nope' }],
  },
  {
    name: 'create_friend',
    valid: [
      { args: { name: 'Zaid Ahmed', relationship: 'close_friend', organization: 'Uni', birthday: '2000-03-04', currentStatus: 'exams', facts: 'Likes tea' }, check(s, d, r) {
        const friend = row(s, 'friends', r.id)
        assert.equal(friend.reminder_days, 10)
        assert.equal(friend.current_status, 'exams')
        assert.ok(d.friends.some((item) => item.id === r.id))
      } },
      { args: { name: 'Hassan' }, check(s, d, r) { assert.match(r.warning || '', /Hasan Raza/, 'a similar name is flagged') } },
    ],
    invalid: [{}, { name: '' }, { name: 'Hasan Raza' }, { name: 'X', relationship: 'bestie' }, { name: 'X', birthday: 'March 4' }, { name: 'X', birthday: '2000-02-30' }],
  },
  {
    name: 'update_friend',
    valid: [
      { args: { friendId: 'f1', currentStatus: 'moved to Toronto' }, check(s) { assert.equal(row(s, 'friends', 'f1').current_status, 'moved to Toronto') } },
      { args: { friendId: 'Sarah', addFact: 'Has a dog' }, check(s) { assert.equal(row(s, 'friends', 'f2').facts, 'Has a dog') } },
      { args: { friendId: 'f1', addFact: 'Plays chess on Sundays' }, check(s) { assert.equal(row(s, 'friends', 'f1').facts, 'Likes chess\nPlays chess on Sundays') } },
      { args: { friendId: 'Hassan', relationship: 'friend' }, check(s, d, r) { assert.equal(r.assumed, 'Hasan Raza'); assert.equal(row(s, 'friends', 'f1').reminder_days, 30) } },
      { args: { friendId: 'f1', name: 'Hasan R.', organization: 'Shopify', facts: 'new facts', birthday: '' }, check(s) { assert.equal(row(s, 'friends', 'f1').name, 'Hasan R.'); assert.equal(row(s, 'friends', 'f1').birthday, '') } },
    ],
    invalid: [{}, { friendId: 'Nobody Here', addFact: 'x' }, { friendId: 'Ali', addFact: 'x' }, { friendId: 'f1' }, { friendId: 'f1', relationship: 'enemy' }, { friendId: 'f1', birthday: '1st Jan' }, { friendId: '$1', addFact: 'x' }],
  },
  {
    name: 'log_contact',
    valid: [
      { args: { friendId: 'f1', note: 'his wedding plans' }, check(s, d) {
        assert.ok(rows(s, 'contact_logs').some((log) => log.friend_id === 'f1' && log.date === TODAY && log.note === 'his wedding plans'))
        assert.equal(row(s, 'tasks', 't5').done, true, 'the open "Talk to" reminder is completed')
        assert.ok(!row(s, 'events', 'e5'))
        assert.equal(d.tasks.find((task) => task.id === 't5').done, true)
      } },
      { args: { friendId: 'f1', date: '2026-09-20', note: 'and his move' }, check(s) { assert.equal(row(s, 'contact_logs', 'c1').note, 'his new job at Shopify\nand his move') } },
      { args: { friendId: 'f1', date: '2026-09-20', note: 'corrected note', mode: 'replace' }, check(s) { assert.equal(row(s, 'contact_logs', 'c1').note, 'corrected note') } },
      { args: { friendId: 'Sarah', date: 'yesterday' }, check(s) { assert.ok(rows(s, 'contact_logs').some((log) => log.friend_id === 'f2' && log.date === YESTERDAY)) } },
      { args: { friendId: 'f2' }, check(s) { assert.equal(rows(s, 'contact_logs').filter((log) => log.friend_id === 'f2' && log.date === TODAY).length, 1, 'one log per person per day') } },
      { args: { friendId: 'f1', date: '2026-09-20', note: 'his new job at Shopify', mode: 'replace' }, noop: true },
    ],
    invalid: [{}, { friendId: 'Nobody' }, { friendId: 'f1', date: '2026-09-30' }, { friendId: 'f1', date: 'last week' }, { friendId: 'f2', date: '2026-09-01', mode: 'replace', note: 'x' }, { friendId: 'Ali' }],
  },
  {
    name: 'person_history',
    lookup: true,
    valid: [
      { args: { friendId: 'f1' }, check(s, d, r) { assert.equal(r.total, 2); assert.equal(r.catchUps[0].date, '2026-09-20') } },
      { args: { friendId: 'Hasan', limit: 1 }, check(s, d, r) { assert.equal(r.catchUps.length, 1) } },
      { args: { friendId: 'f3' }, check(s, d, r) { assert.match(r.message, /No catch-ups/) } },
    ],
    invalid: [{}, { friendId: 'Nobody' }, { friendId: 'Ali' }],
  },
  {
    name: 'delete_contact_log',
    valid: [{ args: { friendId: 'f1', date: '2026-09-20' }, check(s, d) { assert.ok(!row(s, 'contact_logs', 'c1')); assert.ok(!d.contact_logs.some((log) => log.id === 'c1')) } }],
    invalid: [{}, { friendId: 'f1' }, { friendId: 'f1', date: '2026-09-01' }, { friendId: 'f1', date: 'yesterday' }, { friendId: 'Nobody', date: '2026-09-20' }],
  },
  {
    name: 'create_class',
    valid: [
      { args: { name: 'Databases', schedules: [{ day: 'Wed', time: '1:00 PM - 2:30 PM', room: 'C3' }], endDate: '2026-12-15' }, check(s, d, r) { assert.deepEqual(row(s, 'classes', r.id).days, [{ day: 'Wed', time: '1:00 PM - 2:30 PM', room: 'C3' }]); assert.equal(row(s, 'classes', r.id).end_date, '2026-12-15') } },
      { args: { name: 'Yoga', schedules: [{ day: 'Sat' }] }, check(s, d, r) { assert.equal(row(s, 'classes', r.id).end_date, null) } },
    ],
    invalid: [{}, { name: 'X' }, { name: 'X', schedules: [] }, { name: 'X', schedules: [{ day: 'Funday' }] }, { name: '', schedules: [{ day: 'Mon' }] }, { name: 'X', schedules: [{ day: 'Mon' }], endDate: 'December' }, { name: 'X', schedules: 'Mon' }],
  },
  {
    name: 'delete_class',
    valid: [{ args: { classId: 'k1' }, check(s, d) { assert.ok(!row(s, 'classes', 'k1')); assert.equal(d.classes.length, 1) } }],
    invalid: [{}, { classId: 'nope' }],
  },
  {
    name: 'update_class',
    valid: [
      { args: { classId: 'k1', name: 'Algorithms II' }, check(s) { assert.equal(row(s, 'classes', 'k1').name, 'Algorithms II') } },
      { args: { classId: 'k2', schedules: [{ day: 'Wed', time: '10:00 AM - 11:00 AM' }] }, check(s) { assert.deepEqual(row(s, 'classes', 'k2').days, [{ day: 'Wed', time: '10:00 AM - 11:00 AM' }]); assert.deepEqual(row(s, 'classes', 'k2').day_details, {}) } },
      { args: { classId: 'k1', endDate: '' }, check(s) { assert.equal(row(s, 'classes', 'k1').end_date, null) } },
    ],
    invalid: [{}, { classId: 'nope', name: 'x' }, { classId: 'k1' }, { classId: 'k1', name: '' }, { classId: 'k1', schedules: [] }, { classId: 'k1', endDate: 'soon' }],
  },
  {
    name: 'write_journal',
    valid: [
      { args: { body: 'Long day.' }, check(s) { assert.equal(row(s, 'journal_entries', 'j1').body, 'Went to the gym.\n\nLong day.') } },
      { args: { date: YESTERDAY, title: 'Tuesday', body: 'Rain.', mood: 'okay' }, check(s, d) { const entry = rows(s, 'journal_entries').find((item) => item.date === YESTERDAY); assert.equal(entry.mood, 'okay'); assert.equal(d.journal_entries.length, 3) } },
      { args: { mood: 'great' }, check(s) { assert.equal(row(s, 'journal_entries', 'j1').mood, 'great'); assert.equal(row(s, 'journal_entries', 'j1').body, 'Went to the gym.') } },
      { args: { date: 'yesterday', body: 'Quiet.' }, check(s) { assert.ok(rows(s, 'journal_entries').some((item) => item.date === YESTERDAY && item.body === 'Quiet.')) } },
      { args: { date: TODAY, body: 'Rewritten.', mode: 'replace' }, check(s) { assert.equal(row(s, 'journal_entries', 'j1').body, 'Rewritten.') } },
    ],
    invalid: [{}, { date: '2026-09-30', body: 'x' }, { date: 'next week', body: 'x' }, { mood: 'meh' }, { date: '2026-09-22', body: 'x', mode: 'replace' }, { body: 123 }],
  },
  {
    name: 'save_note',
    valid: [{ args: { text: 'Wifi code 1234' }, check(s, d, r) { assert.equal(row(s, 'voice_notes', r.id).text, 'Wifi code 1234'); assert.equal(d.voice_notes[0].id, r.id) } }],
    invalid: [{}, { text: '  ' }],
  },
  {
    name: 'update_note',
    valid: [{ args: { noteId: 'n1', text: 'Wifi code 5678' }, check(s, d) { assert.equal(row(s, 'voice_notes', 'n1').text, 'Wifi code 5678'); assert.equal(d.voice_notes.find((note) => note.id === 'n1').text, 'Wifi code 5678') } }],
    invalid: [{}, { noteId: 'nope', text: 'x' }, { noteId: 'n1', text: '   ' }],
  },
  {
    name: 'delete_note',
    valid: [{ args: { noteId: 'n1' }, check(s, d) { assert.ok(!row(s, 'voice_notes', 'n1')); assert.equal(d.voice_notes.length, 1) } }],
    invalid: [{}, { noteId: 'nope' }],
  },
  {
    name: 'remember',
    valid: [{ args: { content: 'User is vegetarian' }, check(s, d, r) { assert.equal(row(s, 'assistant_memories', r.id).content, 'User is vegetarian'); assert.equal(r.memoryChanged, true); assert.equal(d.memories.length, 3) } }],
    invalid: [{}, { content: '   ' }],
  },
  {
    name: 'forget',
    valid: [{ args: { memoryId: 'm1' }, check(s, d) { assert.ok(!row(s, 'assistant_memories', 'm1')); assert.equal(d.memories.length, 1) } }],
    invalid: [{}, { memoryId: 'nope' }],
  },
  {
    name: 'search',
    lookup: true,
    valid: [
      { args: { type: 'journal' }, check(s, d, r) { assert.equal(r.total, 2) } },
      { args: { type: 'journal', query: 'gym' }, check(s, d, r) { assert.equal(r.total, 1) } },
      { args: { type: 'notes', query: 'wifi' }, check(s, d, r) { assert.equal(r.items[0].id, 'n1') } },
      { args: { type: 'completed_tasks' }, check(s, d, r) { assert.deepEqual(r.items.map((item) => item.id), ['t3']) } },
      { args: { type: 'archived_tasks' }, check(s, d, r) { assert.deepEqual(r.items.map((item) => item.id), ['t4']) } },
      { args: { type: 'past_events' }, check(s, d, r) { assert.deepEqual(r.items.map((item) => item.id), ['e-old']) } },
    ],
    invalid: [],
    bugs: [
      { args: {}, todo: 'BUG: search without a type returns ok:true with an empty list instead of refusing (type is required)' },
      { args: { type: 'everything' }, todo: 'BUG: search with an unknown type returns ok:true with an empty list instead of refusing' },
    ],
  },
  {
    name: 'update_settings',
    valid: [
      { args: { theme: 'forest', appearance: 'dark' }, check(s, d) { assert.equal(settingsOf(s).theme, 'forest'); assert.equal(settingsOf(s).darkMode, true); assert.equal(d.settings.theme, 'forest'); assert.ok(settingsOf(s).gym.routines.length === 3, 'other settings survive') } },
      { args: { displayName: '' }, check(s) { assert.equal(settingsOf(s).displayName, '') } },
      { args: { notifications: { taskLead: 30, quietHours: true, quietStart: '22:00', quietEnd: '07:00' } }, check(s) { assert.equal(settingsOf(s).notifications.taskLead, 30); assert.equal(settingsOf(s).notifications.gymTime, '17:00', 'notifications merge field by field') } },
      { args: { prayerMethod: '2', prayerSchool: 1, showPrayerTimes: false }, check(s) { assert.equal(settingsOf(s).prayerSchool, 1) } },
      { args: { assistantConfirm: 'off', assistantWeb: 'always' }, check(s) { assert.equal(settingsOf(s).assistantWeb, 'always') } },
      { args: { darkMode: true }, check(s) { assert.equal(settingsOf(s).appearance, 'dark') } },
    ],
    invalid: [{}, { theme: 'purple' }, { appearance: 'blue' }, { notifications: { taskLead: '30' } }, { notifications: { dailySummaryTime: '8am' } }, { notifications: { gymTime: '' } }, { prayerMethod: '99' }, { assistantConfirm: 'sometimes' }, { notifications: {} }, { assistantWeb: 'maybe' }],
  },
  {
    name: 'food_update_prefs',
    valid: [
      { args: { energy_unit: 'kJ', ring: 'eaten' }, check(s, d) { assert.equal(settingsOf(s).food.prefs.energyUnit, 'kJ'); assert.equal(settingsOf(s).food.favorites.length, 1, 'favorites survive'); assert.equal(d.settings.food.prefs.ring, 'eaten') } },
      { args: { week_start: 0, nutrients: ['protein', 'fiber'] }, check(s) { assert.deepEqual(settingsOf(s).food.prefs.nutrients, ['protein', 'fiber']) } },
      { args: { rename_meals: [{ meal: 'Snacks', name: 'Snacks & drinks' }] }, check(s) { assert.ok(settingsOf(s).food.prefs.meals.some((meal) => meal.id === 'snack' && meal.name === 'Snacks & drinks')) } },
      { args: { ai_review: 'autoHigh', show_details: true }, check(s) { assert.equal(settingsOf(s).food.prefs.aiReview, 'autoHigh') } },
      { args: { rename_meal: { name: 'Snacks', new_name: 'Snacks & drinks' } }, check(s) { assert.ok(settingsOf(s).food.prefs.meals.some((meal) => meal.id === 'snack' && meal.name === 'Snacks & drinks')) } },
      { args: { add_meal: { name: 'Pre-workout', position: 3 } }, check(s, d) { const { meals } = settingsOf(s).food.prefs; assert.equal(meals.length, 5); assert.equal(meals[2].name, 'Pre-workout'); assert.deepEqual(meals.map((meal) => meal.id).slice(0, 2), ['breakfast', 'lunch'], 'existing ids stay'); assert.equal(d.settings.food.prefs.meals.length, 5) } },
      { args: { remove_meal: { name: 'Snacks' } }, check(s) { assert.deepEqual(settingsOf(s).food.prefs.meals.map((meal) => meal.id), ['breakfast', 'lunch', 'dinner']) } },
      { args: { remove_meal: { name: 'Breakfast', move_to: 'Lunch' } }, check(s, d) { assert.equal(row(s, 'food_entries', 'fe1').meal, 'lunch', 'today’s entries move to the named meal'); assert.equal(d.foodEntries.find((entry) => entry.id === 'fe1').meal, 'lunch'); assert.ok(!settingsOf(s).food.prefs.meals.some((meal) => meal.id === 'breakfast')) } },
      { args: { meals: [{ name: 'Breakfast' }, { name: 'Lunch' }, { name: 'Dinner' }] }, check(s) { assert.deepEqual(settingsOf(s).food.prefs.meals.map((meal) => meal.id), ['breakfast', 'lunch', 'dinner'], 'matching names keep their ids') } },
      { args: { meals: [{ name: 'Lunch' }, { name: 'Dinner' }, { name: 'Snacks' }, { name: 'Late snack' }], move_to: 'Lunch' }, check(s) { const { meals } = settingsOf(s).food.prefs; assert.equal(meals.length, 4); assert.equal(meals[0].id, 'lunch'); assert.equal(row(s, 'food_entries', 'fe1').meal, 'lunch') } },
      { args: { rename_meals: [{ meal: 'Lunch', name: 'Lunch' }] }, noop: true },
    ],
    invalid: [
      {}, { energy_unit: 'cal' }, { ring: 'both' }, { week_start: 2 }, { nutrients: ['vitamin c'] }, { nutrients: 'protein' }, { rename_meals: [{ meal: 'Elevenses', name: 'X' }] }, { rename_meals: [{ meal: 'Lunch', name: '' }] }, { ai_review: 'never' },
      { remove_meal: { name: 'Breakfast' } }, { add_meal: { name: 'Lunch' } }, { add_meal: {} }, { meals: [{ name: 'A' }, { name: 'B' }] }, { meals: 'Breakfast' }, { meals: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }, { name: 'G' }] },
      { remove_meal: { name: 'Snacks', move_to: 'Elevenses' } }, { rename_meal: { name: 'Lunch', new_name: 'Dinner' } }, { rename_meal: { name: 'Elevenses', new_name: 'X' } }, { meals: [{ name: 'Lunch' }, { name: 'Dinner' }, { name: 'Snacks' }] },
    ],
  },
  {
    name: 'food_update_profile',
    valid: [
      { args: { target_weight: 72, activity: 'active' }, check(s, d, r) { const { food } = settingsOf(s); assert.equal(food.profile.targetKg, 72); assert.equal(food.profile.activity, 'active'); assert.equal(food.profile.heightCm, 178, 'other fields stay'); assert.equal(food.goals.calories, 2200, 'goals are left alone'); assert.match(r.message, /Daily goals unchanged/); assert.equal(d.settings.food.profile.targetKg, 72) } },
      { args: { goal: 'lose', rate_per_week: 0.5 }, check(s) { assert.equal(settingsOf(s).food.profile.goal, 'lose'); assert.equal(settingsOf(s).food.profile.rateKgPerWeek, 0.5) } },
      { args: { sex: 'female', age: 30, height_cm: 170, body_fat_pct: 22 }, check(s) { const { profile } = settingsOf(s).food; assert.equal(profile.sex, 'female'); assert.equal(profile.birthYear, 1996); assert.equal(profile.bodyFatPct, 22) } },
    ],
    invalid: [{}, { activity: 'couch' }, { goal: 'shred' }, { height_cm: 50 }, { age: 5 }, { rate_per_week: 5 }, { target_weight: 5 }, { body_fat_pct: 90 }, { activity: 'moderate' }, { sex: 'other' }],
  },
  {
    name: 'food_copy_entries',
    valid: [
      { args: {}, check(s, d, r) {
        const copy = row(s, 'food_entries', r.id)
        assert.equal(copy.date, TODAY)
        assert.equal(copy.name, 'Chicken rice')
        assert.equal(copy.calories, 650)
        assert.equal(copy.meal, 'lunch', 'the entry keeps its meal')
        assert.equal(copy.source, 'copy')
        assert.equal(copy.user_id, USER)
        assert.ok(row(s, 'food_entries', 'fe2'), 'the original stays')
        assert.equal(d.foodEntries[0].id, r.id)
        assert.match(r.message, /^Copied /)
      } },
      { args: { entry_ids: ['fe1'], to_meal: 'snack' }, check(s, d, r) { const copy = row(s, 'food_entries', r.id); assert.equal(copy.meal, 'snack'); assert.equal(copy.date, TODAY); assert.equal(copy.name, 'Oats') } },
      { args: { from_date: YESTERDAY, from_meal: 'lunch', to_date: TODAY, to_meal: 'dinner' }, check(s, d, r) { assert.equal(row(s, 'food_entries', r.id).meal, 'dinner'); assert.equal(r.ids.length, 1) } },
      { args: { entry_ids: ['fe2', 'fe1'], to_date: '2026-09-20' }, check(s, d, r) { assert.equal(r.ids.length, 2); assert.ok(r.ids.every((id) => row(s, 'food_entries', id).date === '2026-09-20')) } },
    ],
    invalid: [{ to_date: 'tomorrow' }, { to_date: 'sometime' }, { from_date: '2026-09-01' }, { entry_ids: ['nope'] }, { to_meal: 'elevenses' }, { from_meal: 'elevenses' }, { from_date: TODAY, to_date: TODAY }, { from_date: '2026-09-30' }, { from_date: 'yesterday' }, { from_date: YESTERDAY, from_meal: 'dinner' }],
  },
  {
    name: 'delete_friend',
    valid: [
      { args: { friendId: 'f1' }, check(s, d, r) {
        assert.ok(!row(s, 'friends', 'f1'))
        assert.ok(!rows(s, 'contact_logs').some((log) => log.friend_id === 'f1'), 'their catch-up history goes too')
        assert.equal(row(s, 'tasks', 't5').archived, true, 'their open "Talk to" reminder is archived')
        assert.ok(!row(s, 'events', 'e5'))
        assert.ok(!d.friends.some((friend) => friend.id === 'f1'))
        assert.match(r.message, /Archived the reminder/)
      } },
      { args: { friendId: 'Sarah' }, check(s) { assert.ok(!row(s, 'friends', 'f2')); assert.equal(rows(s, 'friends').length, 3) } },
    ],
    invalid: [{}, { friendId: 'Nobody' }, { friendId: 'Ali' }],
  },
  {
    name: 'read_journal',
    lookup: true,
    valid: [
      { args: { date: TODAY }, check(s, d, r) { assert.equal(r.found, true); assert.equal(r.entry.text, 'Went to the gym.') } },
      { args: { date: 'today' }, check(s, d, r) { assert.equal(r.found, true) } },
      { args: { date: '2026-01-01' }, check(s, d, r) { assert.equal(r.found, false); assert.match(r.message, /No journal entry/) } },
    ],
    invalid: [],
    bugs: [{ args: {}, todo: 'BUG: read_journal without a date answers "No journal entry for undefined." instead of refusing' }],
  },
  {
    name: 'delete_journal_entry',
    valid: [
      { args: { date: TODAY }, check(s, d) { assert.ok(!row(s, 'journal_entries', 'j1')); assert.equal(d.journal_entries.length, 1) } },
      { args: { date: 'today' }, check(s) { assert.ok(!row(s, 'journal_entries', 'j1')) } },
    ],
    invalid: [{}, { date: '2026-01-01' }, { date: 'yesterday' }, { date: 'the entry from tuesday' }],
  },
  // Weather and prayer times need the network; with no location they refuse before any request.
  { name: 'get_weather', lookup: true, valid: [], invalid: [{}, { days: 3 }] },
  { name: 'get_prayer_times', lookup: true, valid: [], invalid: [{}, { date: TODAY }] },

  // ---- gym
  {
    name: 'gym_get_schedule',
    lookup: true,
    valid: [
      { args: { from: TODAY, to: '2026-09-30' }, check(s, d, r) { assert.equal(r.days.length, 7); assert.match(r.days[0], /Push/); assert.match(r.days[5], /Pull \(skipped\)/) } },
      { args: { from: '2026-10-01', to: '2026-10-01' }, check(s, d, r) { assert.match(r.days[0], /Rest \(changed for this day\)/) } },
      { args: { from: 'today', to: 'tomorrow' }, check(s, d, r) { assert.equal(r.days.length, 2); assert.match(r.days[1], /Pull/) } },
      { args: { from: '2026-09-19', to: '2026-09-22' }, check(s, d, r) { assert.match(r.days[0], /done: Legs/); assert.match(r.days[3], /done: Push/) } },
      { args: { from: TODAY, to: '2027-01-01' }, check(s, d, r) { assert.match(r.note, /Only the first 62 days/) } },
      { args: {}, check(s, d, r) { assert.equal(r.days.length, 7) } },
    ],
    invalid: [{ from: 'next week', to: TODAY }, { from: '2026-09-30', to: TODAY }],
  },
  {
    name: 'gym_skip',
    valid: [
      { args: { date: TODAY, note: 'sick' }, check(s, d, r) { assert.deepEqual(settingsOf(s).gym.schedule.skips[TODAY], { note: 'sick' }); assert.match(r.message, /Skipped Push today/); assert.ok(r.preview) } },
      { args: { date: 'tomorrow' }, check(s) { assert.ok(settingsOf(s).gym.schedule.skips[TOMORROW]) } },
      { args: { date: '2026-09-29', note: 'wedding' }, check(s) { assert.deepEqual(settingsOf(s).gym.schedule.skips['2026-09-29'], { note: 'wedding' }) } },
      { args: { date: '2026-09-29' }, noop: true },
    ],
    invalid: [{}, { date: 'yesterday' }, { date: '2026-09-22' }, { date: '2026-09-26' }, { date: 'someday' }],
  },
  {
    name: 'gym_shift',
    valid: [
      { args: { date: TODAY, days: 2 }, check(s, d, r) { assert.deepEqual(settingsOf(s).gym.schedule.shifts, [TODAY, TOMORROW]); assert.match(r.message, /Shifted your gym schedule forward 2 days/) } },
      { args: { date: 'tomorrow' }, check(s) { assert.deepEqual(settingsOf(s).gym.schedule.shifts, [TOMORROW]) } },
    ],
    invalid: [{}, { date: 'yesterday' }, { date: '2026-09-22' }, { date: 'whenever' }],
  },
  {
    name: 'gym_override',
    valid: [
      { args: { date: TODAY, routine: 'Legs' }, check(s, d, r) { assert.deepEqual(settingsOf(s).gym.schedule.overrides[TODAY].slot, { kind: 'routine', routineId: 'r-legs' }); assert.match(r.message, /Today is now Legs/) } },
      { args: { date: 'tomorrow', routine: 'rest' }, check(s) { assert.deepEqual(settingsOf(s).gym.schedule.overrides[TOMORROW].slot, { kind: 'rest' }) } },
      { args: { date: '2026-09-26', routine: 'r-push' }, check(s) { assert.equal(settingsOf(s).gym.schedule.overrides['2026-09-26'].slot.routineId, 'r-push') } },
      { args: { date: TODAY, routine: 'Push' }, noop: true },
    ],
    invalid: [{}, { date: TODAY, routine: 'Chest day' }, { date: 'yesterday', routine: 'Push' }, { date: TODAY }, { date: 'sometime', routine: 'Push' }],
  },
  {
    name: 'gym_undo',
    valid: [
      { args: { date: '2026-09-29' }, check(s, d, r) { assert.equal(settingsOf(s).gym.schedule.skips['2026-09-29'], undefined); assert.match(r.message, /Back to the plan/) } },
      { args: { date: '2026-10-01' }, check(s) { assert.equal(settingsOf(s).gym.schedule.overrides['2026-10-01'], undefined) } },
    ],
    invalid: [{}, { date: TODAY }, { date: 'yesterday' }, { date: 'never' }],
  },
  {
    name: 'gym_move',
    valid: [
      { args: { from: TODAY, to: '2026-09-26' }, check(s, d, r) {
        const { overrides } = settingsOf(s).gym.schedule
        assert.deepEqual(overrides[TODAY], { slot: { kind: 'rest' }, movedTo: '2026-09-26' })
        assert.deepEqual(overrides['2026-09-26'], { slot: { kind: 'routine', routineId: 'r-push' }, movedFrom: TODAY })
        assert.match(r.message, /Moved Push from today/)
      } },
      { args: { from: 'tomorrow', to: '2026-09-27', swap: true }, check(s, d, r) {
        const { overrides } = settingsOf(s).gym.schedule
        assert.equal(overrides[TOMORROW].slot.routineId, 'r-legs')
        assert.equal(overrides['2026-09-27'].slot.routineId, 'r-pull')
        assert.match(r.message, /Swapped/)
      } },
    ],
    invalid: [{}, { from: TODAY }, { from: '2026-09-22', to: TODAY }, { from: TODAY, to: TODAY }, { from: '2026-09-26', to: '2026-09-30' }, { from: 'yesterday', to: TODAY }, { from: 'mon', to: 'tue' }],
  },
  {
    name: 'gym_realign',
    valid: [{ args: { routine: 'Legs' }, check(s, d, r) { assert.equal(settingsOf(s).gym.schedule.versions.length, 2); assert.match(r.message, /continues after Legs/) } }],
    invalid: [{}, { routine: 'Chest' }, { routine: 'Ali' }],
  },
  {
    name: 'gym_list_sessions',
    lookup: true,
    valid: [
      { args: {}, check(s, d, r) { assert.equal(r.total, 2); assert.equal(r.sessions[0].id, 's1'); assert.match(r.sessions[0].exercises[0], /60 kg × 8, 8, 7/) } },
      { args: { from: '2026-09-01', to: TODAY }, check(s, d, r) { assert.equal(r.total, 2) } },
      { args: { from: TODAY, to: '2026-09-01' }, check(s, d, r) { assert.equal(r.total, 2, 'a reversed range is swapped') } },
      { args: { exercise: 'bench' }, check(s, d, r) { assert.equal(r.total, 1); assert.equal(r.sessions[0].id, 's1') } },
      { args: { exercise: 'squats' }, check(s, d, r) { assert.equal(r.total, 1); assert.equal(r.sessions[0].id, 's2') } },
      { args: { exercise: 'zzz nothing like it' }, check(s, d, r) { assert.equal(r.total, 0) } },
      { args: { from: '2026-01-01', to: '2026-01-31' }, check(s, d, r) { assert.equal(r.total, 0) } },
    ],
    invalid: [{ from: 'last month' }, { to: 'now' }],
  },
  {
    name: 'gym_quick_log',
    valid: [
      { args: { date: TODAY, routine: 'Push' }, check(s, d, r) { const session = row(s, 'gym_sessions', r.id); assert.equal(session.routine_id, 'r-push'); assert.equal(session.user_id, USER); assert.equal(d.gym_sessions[0].id, r.id) } },
      { args: { date: 'yesterday' }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', r.id).date, YESTERDAY); assert.equal(row(s, 'gym_sessions', r.id).name, 'Workout') } },
      { args: { date: '2026-09-22', routine: 'rest' }, check(s, d, r) { assert.match(r.message, /now has 2 workouts/) } },
    ],
    invalid: [{}, { date: 'tomorrow' }, { date: TODAY, routine: 'Chest' }, { date: 'sometime' }],
  },
  {
    name: 'gym_log_workout',
    valid: [
      { args: { date: TODAY, routine: 'Push', duration_min: 55, note: 'felt strong', exercises: [{ name: 'Bench Press (Barbell)', sets: [{ weight: 62.5, reps: 8, count: 3 }] }, { name: 'ohp', sets: [{ weight: 40, reps: 10 }, { weight: 40, reps: 9, type: 'failure' }] }] }, check(s, d, r) {
        const session = row(s, 'gym_sessions', r.id)
        assert.equal(session.exercises.length, 2)
        assert.equal(session.exercises[0].sets.length, 3)
        assert.equal(session.exercises[0].sets[0].weightKg, 62.5)
        assert.equal(session.exercises[1].exerciseId, 'overhead-press')
        assert.equal(session.duration_sec, 55 * 60)
        assert.match(r.message, /New PRs/, 'a heavier bench than Sep 22 is a PR')
        assert.equal(d.gym_sessions[0].id, r.id)
      } },
      { args: { date: TODAY, routine: 'Push', exercises: [{ name: 'bench', sets: [{ weight: 60, count: 3 }] }] }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', r.id).exercises[0].sets[0].reps, 8, 'reps come from the fixed target'); assert.match(r.message, /8 reps from your plan/) } },
      { args: { date: TODAY, unit: 'lb', exercises: [{ name: 'squat', sets: [{ weight: 220, reps: 5 }] }] }, check(s, d, r) { const kg = row(s, 'gym_sessions', r.id).exercises[0].sets[0].weightKg; assert.ok(Math.abs(kg - 99.79) < 0.01, `220 lb → ${kg} kg`) } },
      { args: { date: TODAY, routine: 'Legs', fill_from_routine: true, exercises: [{ name: 'squat', sets: [{ weight: 80, reps: 5 }] }] }, check(s, d, r) { const session = row(s, 'gym_sessions', r.id); assert.ok(session.exercises.length >= 2, 'the routine’s other exercises are filled in'); assert.match(r.hint || '', /gym_realign/, 'Legs on a Push day in a rotation offers realigning') } },
      { args: { date: 'yesterday', exercises: [{ name: 'Plank', sets: [{ duration_sec: 60, count: 2 }] }] }, check(s, d, r) { const session = row(s, 'gym_sessions', r.id); assert.equal(session.date, YESTERDAY); assert.equal(session.exercises[0].sets[1].durationSec, 60) } },
      { args: { date: TODAY, exercises: [{ name: 'Cable Woodchop', sets: [{ weight: 20, reps: 12 }] }] }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', r.id).exercises[0].exerciseId, 'custom-1') } },
    ],
    invalid: [
      {}, { date: 'tomorrow', exercises: [{ name: 'bench', sets: [{ weight: 60, reps: 8 }] }] }, { date: TODAY }, { date: TODAY, exercises: [] },
      { date: TODAY, exercises: [{ name: 'Nonexistent Exercise', sets: [{ reps: 5 }] }] },
      { date: TODAY, routine: 'Pull', exercises: [{ name: 'lat pulldown', sets: [{ weight: 50 }] }] },
      { date: TODAY, exercises: [{ name: 'bench', sets: [{ weight: 60 }] }] },
      { date: TODAY, unit: 'stone', exercises: [{ name: 'bench', sets: [{ weight: 5, reps: 8 }] }] },
      { date: TODAY, fill_from_routine: true, exercises: [{ name: 'bench', sets: [{ weight: 60, reps: 8 }] }] },
      { date: TODAY, exercises: 'bench 60x8' },
      { date: TODAY, exercises: [{ name: 'Plank', sets: [{ reps: 10 }] }] },
      { date: TODAY, exercises: [{ name: 'bench', sets: [] }] },
      { date: 'sometime', exercises: [{ name: 'bench', sets: [{ weight: 60, reps: 8 }] }] },
    ],
  },
  {
    name: 'gym_delete_session',
    valid: [
      { args: { session_id: 's1' }, check(s, d) { assert.ok(!row(s, 'gym_sessions', 's1')); assert.ok(!d.gym_sessions.some((session) => session.id === 's1')) } },
      { args: { session_id: 's-old' }, check(s, d, r) { assert.ok(!row(s, 'gym_sessions', 's-old'), 'a session only in the database is looked up (maybeSingle) and deleted'); assert.match(r.message, /Push workout/) } },
    ],
    invalid: [{}, { session_id: 'nope' }, { session_id: '' }],
  },
  {
    name: 'gym_create_routine',
    valid: [
      { args: { name: 'Upper', color: 'purple', notes: 'Twice a week', exercises: [{ name: 'bench', sets: 4, reps: 6, weight: 70, rest_sec: 150 }, { name: 'Lat Pulldown (Cable)', reps_min: 10, reps_max: 12 }] }, check(s, d, r) {
        const routine = settingsOf(s).gym.routines.find((item) => item.id === r.id)
        assert.equal(routine.color, 'indigo', 'purple maps to indigo')
        assert.equal(routine.exercises[0].sets.length, 4)
        assert.deepEqual([routine.exercises[0].sets[0].repsMin, routine.exercises[0].sets[0].repsMax, routine.exercises[0].sets[0].weightKg, routine.exercises[0].restSec], [6, 6, 70, 150])
        assert.deepEqual([routine.exercises[1].sets[0].repsMin, routine.exercises[1].sets[0].repsMax], [10, 12])
        assert.equal(settingsOf(s).gym.schedule.versions.length, 1, 'the schedule is untouched')
        assert.ok(d.gym.routines.some((item) => item.id === r.id))
      } },
      { args: { name: 'Cardio' }, check(s, d, r) { assert.equal(settingsOf(s).gym.routines.find((item) => item.id === r.id).exercises.length, 0) } },
    ],
    invalid: [{}, { name: '' }, { name: 'Push' }, { name: 'X', color: 'chartreuse' }, { name: 'X', exercises: [{ name: 'Nonexistent' }] }],
  },
  {
    name: 'gym_edit_routine',
    valid: [
      { args: { name: 'Push', changes: { rename: 'Push A', color: 'teal', notes: 'Chest focus' } }, check(s) { const routine = settingsOf(s).gym.routines.find((item) => item.id === 'r-push'); assert.equal(routine.name, 'Push A'); assert.equal(routine.color, 'teal') } },
      { args: { name: 'Push', changes: { set_targets: [{ exercise: 'bench', sets: 4, reps: 5, weight: 80, rest_sec: 200 }] } }, check(s) {
        const bench = settingsOf(s).gym.routines.find((item) => item.id === 'r-push').exercises[0]
        assert.equal(bench.sets.length, 4)
        assert.deepEqual([bench.sets[3].repsMin, bench.sets[3].weightKg, bench.restSec], [5, 80, 200])
      } },
      { args: { name: 'Pull', changes: { add_exercises: [{ name: 'Cable Woodchop', sets: 3, reps: 12 }], remove_exercises: ['lat pulldown'] } }, check(s) { assert.deepEqual(settingsOf(s).gym.routines.find((item) => item.id === 'r-pull').exercises.map((item) => item.exerciseId), ['custom-1']) } },
      { args: { name: 'r-legs', changes: { remove_exercises: ['Plank'] } }, check(s) { assert.ok(!settingsOf(s).gym.routines.find((item) => item.id === 'r-legs').exercises.some((item) => item.exerciseId === 'plank')) } },
      { args: { name: 'Legs', changes: { reorder: ['Plank', 'Squat'] } }, pending: true, check(s) { assert.deepEqual(settingsOf(s).gym.routines.find((item) => item.id === 'r-legs').exercises.map((item) => item.id), ['row-plank', 'row-squat', 'row-rdl', 'row-chop'], 'named ones first, the rest keep their order') } },
      { args: { name: 'Push', changes: { row_note: { exercise: 'bench', note: 'pause at the chest' } } }, pending: true, check(s) { assert.equal(settingsOf(s).gym.routines.find((item) => item.id === 'r-push').exercises[0].note, 'pause at the chest') } },
    ],
    invalid: [{}, { name: 'Push' }, { name: 'Push', changes: {} }, { name: 'Nope', changes: { rename: 'x' } }, { name: 'Push', changes: { rename: 'Pull' } }, { name: 'Push', changes: { rename: '' } }, { name: 'Push', changes: { remove_exercises: ['Squat'] } }, { name: 'Push', changes: { color: 'mauve' } }, { name: 'Push', changes: { add_exercises: [{ name: 'Zzz' }] } }, { name: 'Push', changes: { set_targets: [{ exercise: 'Squat', reps: 5 }] } }, { name: 'Push', changes: { reorder: ['Squat'] } }, { name: 'Push', changes: { row_note: { exercise: 'Zzz', note: 'x' } } }],
  },
  {
    name: 'gym_duplicate_routine',
    valid: [
      { args: { name: 'Push', new_name: 'Push B' }, pending: true, check(s, d, r) {
        const { routines } = settingsOf(s).gym
        assert.equal(routines.length, 4)
        const copy = routines.find((item) => item.id === r.id)
        const source = routines.find((item) => item.id === 'r-push')
        assert.equal(copy.name, 'Push B')
        assert.deepEqual(copy.exercises.map((item) => item.exerciseId), source.exercises.map((item) => item.exerciseId))
        assert.ok(copy.exercises.every((item, index) => item.id !== source.exercises[index].id), 'the copy has its own row ids')
        assert.equal(copy.exercises[0].sets[0].weightKg, 60, 'targets are copied')
        assert.ok(d.gym.routines.some((item) => item.id === r.id))
      } },
      { args: { name: 'r-legs' }, pending: true, check(s, d, r) { assert.equal(settingsOf(s).gym.routines.find((item) => item.id === r.id).name, 'Legs copy') } },
    ],
    invalid: [{}, { name: 'Nope' }, { name: 'Push', new_name: 'Pull' }, { name: 'Push', new_name: 'Push' }],
  },
  {
    name: 'gym_edit_session',
    valid: [
      { args: { session_id: 's1', name: 'Push A', duration_min: 70, note: 'good session', bodyweight: 74 }, check(s, d, r) {
        const session = row(s, 'gym_sessions', 's1')
        assert.equal(session.name, 'Push A')
        assert.equal(session.duration_sec, 4200)
        assert.equal(session.note, 'good session')
        assert.equal(session.bodyweight_kg, 74)
        assert.equal(session.user_id, USER)
        assert.equal(d.gym_sessions.find((item) => item.id === 's1').name, 'Push A')
        assert.match(r.message, /renamed to Push A/)
      } },
      { args: { session_id: 's1', exercises: [{ name: 'bench', sets: [{ weight: 62.5, reps: 8, count: 3 }] }] }, check(s) {
        const [bench] = row(s, 'gym_sessions', 's1').exercises
        assert.equal(bench.id, 'se1', 'the exercise row is kept')
        assert.equal(bench.sets.length, 3)
        assert.equal(bench.sets[0].weightKg, 62.5)
      } },
      { args: { session_id: 's1', exercises: [{ name: 'ohp', sets: [{ weight: 40, reps: 10 }] }] }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', 's1').exercises.length, 2); assert.match(r.message, /added Overhead Press/) } },
      { args: { session_id: 's1', exercises: [{ name: 'ohp', sets: [{ weight: 40, reps: 10 }] }], remove_exercises: ['bench'] }, check(s) { assert.deepEqual(row(s, 'gym_sessions', 's1').exercises.map((item) => item.exerciseId), ['overhead-press']) } },
      { args: { session_id: 's2', date: '2026-09-18' }, check(s, d) { const session = row(s, 'gym_sessions', 's2'); assert.equal(session.date, '2026-09-18'); assert.match(session.started_at, /^2026-09-18T/); assert.equal(d.gym_sessions.find((item) => item.id === 's2').date, '2026-09-18') } },
      { args: { session_id: 's1', start_time: '18:30' }, check(s) { const session = row(s, 'gym_sessions', 's1'); assert.equal(session.started_at, '2026-09-22T18:30:00.000Z'); assert.equal(session.ended_at, '2026-09-22T19:30:00.000Z', 'the duration is kept') } },
      { args: { session_id: 's-old', note: 'from the archive' }, check(s) { assert.equal(row(s, 'gym_sessions', 's-old').note, 'from the archive', 'a session only in the database is looked up and updated') } },
      { args: { session_id: 's1', note: '' }, check(s, d, r) { assert.match(r.message, /note removed/) } },
      { args: { session_id: 's1', unit: 'lb', exercises: [{ name: 'bench', sets: [{ weight: 135, reps: 5 }] }] }, check(s) { const kg = row(s, 'gym_sessions', 's1').exercises[0].sets[0].weightKg; assert.ok(Math.abs(kg - 61.23) < 0.01, `135 lb → ${kg} kg`) } },
    ],
    invalid: [
      {}, { session_id: 'nope', name: 'x' }, { session_id: 's1' }, { session_id: 's1', date: 'tomorrow' }, { session_id: 's1', start_time: '6pm' },
      { session_id: 's1', exercises: [{ name: 'Zzz', sets: [{ reps: 5 }] }] }, { session_id: 's1', remove_exercises: ['Squat'] }, { session_id: 's1', remove_exercises: ['bench'] },
      { session_id: 's1', unit: 'stone', exercises: [{ name: 'bench', sets: [{ weight: 5, reps: 8 }] }] }, { session_id: 's1', name: '' }, { session_id: 's1', bodyweight: 0 },
      { session_id: 's1', duration_min: 'long' }, { session_id: 's1', date: TODAY, start_time: '23:00' }, { session_id: 's1', date: 'sometime' },
      { session_id: 's1', exercises: [{ name: 'bench', sets: [] }] },
    ],
  },
  {
    name: 'gym_duplicate_session',
    valid: [
      { args: { session_id: 's1', date: TODAY }, check(s, d, r) {
        const copy = row(s, 'gym_sessions', r.id)
        assert.equal(copy.date, TODAY)
        assert.equal(copy.routine_id, 'r-push')
        assert.equal(copy.exercises.length, 1)
        assert.equal(copy.exercises[0].sets.length, 3)
        assert.notEqual(copy.exercises[0].id, 'se1', 'rows get new ids')
        assert.notEqual(copy.exercises[0].sets[0].id, 'x1')
        assert.equal(copy.bodyweight_kg, 75, 'the latest weigh-in')
        assert.ok(row(s, 'gym_sessions', 's1'), 'the original stays')
        assert.equal(d.gym_sessions[0].id, r.id)
        assert.match(r.message, /Logged a copy of Push/)
      } },
      { args: { session_id: 's2', date: 'yesterday' }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', r.id).date, YESTERDAY); assert.match(row(s, 'gym_sessions', r.id).started_at, /^2026-09-23T17:00/, 'same time of day as the original') } },
      { args: { session_id: 's-old', date: '2026-09-01' }, check(s, d, r) { assert.equal(row(s, 'gym_sessions', r.id).date, '2026-09-01') } },
    ],
    invalid: [{}, { session_id: 'nope', date: TODAY }, { session_id: 's1', date: 'tomorrow' }, { session_id: 's1' }, { session_id: 's1', date: 'sometime' }],
  },
  {
    name: 'gym_stats',
    lookup: true,
    valid: [
      { args: {}, check(s, d, r) { assert.equal(r.workouts, 2); assert.equal(r.range, `2026-08-28 to ${TODAY}`); assert.match(r.perWeek, /goal 3/); assert.equal(r.workingSets, 5); assert.match(r.volume, /kg/); assert.match(r.setsPerMuscle, /Chest/); assert.match(r.byWorkout, /Push ×1/) } },
      { args: { from: '2026-09-01', to: TODAY }, check(s, d, r) { assert.equal(r.workouts, 2) } },
      { args: { from: TODAY, to: '2026-09-01' }, check(s, d, r) { assert.equal(r.workouts, 2, 'a reversed range is swapped') } },
      { args: { from: 'today', to: 'today' }, check(s, d, r) { assert.equal(r.workouts, 0); assert.match(r.message, /No logged workouts/) } },
      { args: { exercise: 'bench' }, check(s, d, r) { assert.equal(r.sessions, 1); assert.equal(r.workingSets, 3); assert.equal(r.totalReps, 23); assert.match(r.bestSet, /60 kg × 8 \(2026-09-22\)/); assert.match(r.estimated1RM, /brzycki/) } },
      { args: { exercise: 'ohp' }, check(s, d, r) { assert.equal(r.sessions, 0); assert.match(r.message, /No sets of Overhead Press/) } },
    ],
    invalid: [{ from: 'last month' }, { to: 'now' }, { exercise: 'Zzz nothing' }],
  },
  {
    name: 'gym_delete_routine',
    valid: [
      { args: { name: 'Pull' }, check(s, d, r) { assert.ok(!settingsOf(s).gym.routines.some((item) => item.id === 'r-pull')); assert.match(r.message, /rest days/); assert.equal(sched.resolveDay(d.gym, d.gym_sessions, TOMORROW, TODAY).shown.kind, 'rest', 'its days become rest') } },
      { args: { name: 'r-legs' }, check(s) { assert.equal(settingsOf(s).gym.routines.length, 2) } },
    ],
    invalid: [{}, { name: 'Nope' }],
  },
  {
    name: 'gym_set_schedule',
    valid: [
      { args: { mode: 'rotation', slots: ['Push', 'Pull', 'rest', 'Legs', 'rest'], today_is: 'Push' }, check(s, d, r) { const version = sched.versionFor(d.gym.schedule, TODAY); assert.equal(version.cycle.length, 5); assert.equal(sched.resolveDay(d.gym, d.gym_sessions, TODAY, TODAY).shown.routineId, 'r-push'); assert.match(r.message, /5-day rotation/) } },
      { args: { mode: 'weekly', slots: ['Push', 'rest', 'Pull', 'rest', 'Legs', 'rest', 'rest'] }, check(s, d, r) { assert.equal(sched.versionFor(d.gym.schedule, TODAY).mode, 'weekly'); assert.equal(sched.resolveDay(d.gym, d.gym_sessions, TODAY, TODAY).shown.kind, 'rest', 'Thursday is rest'); assert.match(r.message, /Mon Push/) } },
      { args: { mode: 'rotation', slots: ['Push', 'Legs'], today_is: '2' }, check(s, d) { assert.equal(sched.resolveDay(d.gym, d.gym_sessions, TODAY, TODAY).shown.routineId, 'r-legs') } },
      { args: { mode: 'rotation', slots: ['r-push', 'r-pull'] }, check(s, d) { assert.equal(sched.resolveDay(d.gym, d.gym_sessions, TODAY, TODAY).shown.routineId, 'r-push', 'today keeps its current routine when it is in the cycle') } },
    ],
    invalid: [{}, { mode: 'daily', slots: ['Push'] }, { mode: 'weekly', slots: ['Push'] }, { mode: 'rotation', slots: [] }, { mode: 'rotation', slots: ['Chest'] }, { mode: 'rotation', slots: ['Push', 'Pull'], today_is: 'Legs' }, { mode: 'rotation', slots: ['Push', 'Pull'], today_is: '5' }, { mode: 'rotation', slots: 'Push' }],
  },
  {
    name: 'gym_log_bodyweight',
    valid: [
      { args: { date: TODAY, weight: 74.5 }, check(s, d, r) { const entry = rows(s, 'body_weights').find((item) => item.date === TODAY); assert.equal(entry.kg, 74.5); assert.equal(entry.user_id, USER); assert.equal(d.body_weights[0].date, TODAY); assert.match(r.message, /−0\.5 kg since yesterday/) } },
      { args: { date: YESTERDAY, weight: 75.2 }, check(s, d) { assert.equal(rows(s, 'body_weights').filter((item) => item.date === YESTERDAY).length, 1, 'one entry per day'); assert.equal(row(s, 'body_weights', 'bw1').kg, 75.2); assert.equal(d.body_weights.find((item) => item.date === YESTERDAY).kg, 75.2) } },
      { args: { date: 'yesterday', weight: 75 }, check(s, d, r) { assert.equal(row(s, 'body_weights', 'bw1').kg, 75); assert.match(r.message, /−1 kg since Wed, Sep 16/, 'compared with the entry before that day') } },
    ],
    invalid: [{}, { date: TODAY }, { date: TODAY, weight: 'heavy' }, { date: TODAY, weight: 0 }, { date: TODAY, weight: 900 }, { date: 'tomorrow', weight: 75 }, { date: 'lately', weight: 75 }],
  },
  {
    name: 'gym_exercise_records',
    lookup: true,
    valid: [
      { args: { exercise: 'Bench Press (Barbell)' }, check(s, d, r) { assert.equal(r.timesDone, 1); assert.match(r.records.heaviest, /60 kg/); assert.ok(r.nextTime, 'a routine exercise gets a suggestion') } },
      { args: { exercise: 'bench-press' }, check(s, d, r) { assert.equal(r.exercise, 'Bench Press (Barbell)') } },
      { args: { exercise: 'ohp' }, check(s, d, r) { assert.match(r.message, /No logged sets/) } },
    ],
    invalid: [{}, { exercise: 'Zzz nothing' }],
  },
  {
    name: 'gym_update_prefs',
    valid: [
      { args: { changes: { unit: 'lb', weekly_goal: 4, default_rest: 90, first_weekday: 0, progression: false, reminder: true, reminder_time: '18:30', warmup_rest: 30, e1rm_formula: 'epley', previous_source: 'routine', use_rir: true, show_rpe: false, timer_sound: true, keep_awake: true, bodyweight_in_volume: false, collar_weight: 0.5 } }, check(s, d) {
        const { prefs } = settingsOf(s).gym
        assert.equal(prefs.unit, 'lb')
        assert.equal(prefs.weeklyGoal, 4)
        assert.equal(prefs.firstWeekday, 0)
        assert.equal(prefs.e1rmFormula, 'epley')
        assert.equal(settingsOf(s).notifications.gymTime, '18:30')
        assert.equal(settingsOf(s).notifications.taskLead, 15, 'other notification fields survive')
        assert.equal(d.gym.prefs.unit, 'lb')
      } },
      { args: { changes: { reminder: false } }, check(s) { assert.equal(settingsOf(s).notifications.gym, false) } },
      { args: { changes: { distance_unit: 'mi' } }, check(s) { assert.equal(settingsOf(s).gym.prefs.distanceUnit, 'mi') } },
    ],
    invalid: [{}, { changes: {} }, { changes: { unit: 'stone' } }, { changes: { distance_unit: 'furlong' } }, { changes: { e1rm_formula: 'magic' } }, { changes: { reminder_time: '6pm' } }, { changes: { previous_source: 'everything' } }, { changes: { collar_weight: -1 } }, { changes: 'kg' }],
  },
  {
    name: 'gym_exercise_meta',
    valid: [
      { args: { exercise: 'bench', note: 'Feet flat, arch', rest_sec: 150, increment: 2.5 }, check(s, d) { const meta = settingsOf(s).gym.exerciseMeta['bench-press']; assert.equal(meta.increment, 2.5); assert.equal(meta.note, 'Feet flat, arch'); assert.equal(d.gym.exerciseMeta['bench-press'].increment, 2.5) } },
      { args: { exercise: 'bench-press', note: null, rest_sec: null, increment: null }, check(s) { assert.equal(settingsOf(s).gym.exerciseMeta['bench-press'], undefined, 'clearing everything removes the entry') } },
      { args: { exercise: 'squat', rest_sec: 180 }, check(s) { assert.equal(settingsOf(s).gym.exerciseMeta['back-squat'].restSec, 180) } },
    ],
    invalid: [{}, { exercise: 'bench' }, { exercise: 'Zzz', note: 'x' }],
  },
  {
    name: 'gym_edit_exercise',
    valid: [
      { args: { exercise: 'Cable Woodchop', rename: 'Cable Woodchop (High to Low)', primary: 'abs', secondary: ['shoulders', 'abs'], equipment: 'cable', tracking: 'weight_reps', category: 'isolation', rest_sec: 75 }, check(s, d) {
        const entry = settingsOf(s).gym.exercises.find((item) => item.id === 'custom-1')
        assert.equal(entry.name, 'Cable Woodchop (High to Low)')
        assert.deepEqual(entry.secondary, ['shoulders'], 'the primary muscle is not also secondary')
        assert.equal(entry.rest, 75)
        assert.equal(d.gym.exercises[0].name, 'Cable Woodchop (High to Low)')
      } },
      { args: { exercise: 'custom-2', rest_sec: 60 }, check(s) { assert.equal(settingsOf(s).gym.exercises.find((item) => item.id === 'custom-2').rest, 60) } },
    ],
    invalid: [{}, { exercise: 'Bench Press (Barbell)', rename: 'x' }, { exercise: 'Cable Woodchop' }, { exercise: 'Cable Woodchop', primary: 'wings' }, { exercise: 'Cable Woodchop', equipment: 'rope' }, { exercise: 'Cable Woodchop', tracking: 'vibes' }, { exercise: 'Cable Woodchop', rename: 'Bench Press (Barbell)' }, { exercise: 'Nope', rename: 'x' }, { exercise: 'Cable Woodchop', rename: '' }],
  },
  {
    name: 'gym_delete_exercise',
    valid: [
      { args: { exercise: 'Cable Woodchop' }, check(s, d, r) { assert.equal(settingsOf(s).gym.exercises.find((item) => item.id === 'custom-1').hidden, true, 'used by the Legs routine → hidden'); assert.match(r.message, /Hid/) } },
      { args: { exercise: 'custom-2' }, check(s, d, r) { assert.ok(!settingsOf(s).gym.exercises.some((item) => item.id === 'custom-2'), 'unused → deleted'); assert.match(r.message, /Deleted/); assert.equal(d.gym.exercises.length, 1) } },
    ],
    invalid: [{}, { exercise: 'Bench Press (Barbell)' }, { exercise: 'Nope' }],
  },
  {
    name: 'gym_create_exercise',
    valid: [
      { args: { name: 'Viking Press', primary: 'shoulders', equipment: 'barbell', secondary: ['chest', 'triceps', 'shoulders'], category: 'compound', rest_sec: 120 }, check(s, d, r) {
        const entry = settingsOf(s).gym.exercises.find((item) => item.id === r.id)
        assert.equal(entry.tracking, 'weight_reps')
        assert.deepEqual(entry.secondary, ['chest', 'triceps'])
        assert.ok(d.gym.exercises.some((item) => item.id === r.id))
      } },
      { args: { name: 'Box Jump', primary: 'quads', equipment: 'bodyweight' }, check(s, d, r) { assert.equal(settingsOf(s).gym.exercises.find((item) => item.id === r.id).tracking, 'bodyweight_reps') } },
      { args: { name: 'Assault Bike Intervals', primary: 'cardio', equipment: 'machine' }, check(s, d, r) { const entry = settingsOf(s).gym.exercises.find((item) => item.id === r.id); assert.equal(entry.category, 'cardio'); assert.equal(entry.tracking, 'duration') } },
    ],
    invalid: [{}, { name: 'X' }, { name: 'X', primary: 'wings', equipment: 'barbell' }, { name: 'X', primary: 'chest', equipment: 'rope' }, { name: 'Bench Press (Barbell)', primary: 'chest', equipment: 'barbell' }, { name: 'Dumbbell Bench Press', primary: 'chest', equipment: 'dumbbell' }, { name: 'Cable Woodchops', primary: 'abs', equipment: 'cable' }, { name: 'X', primary: 'chest', equipment: 'barbell', tracking: 'vibes' }],
  },
  {
    name: 'gym_deload',
    valid: [
      { args: { on: true }, check(s, d, r) { assert.deepEqual(settingsOf(s).gym.schedule.deload.manualWeeks, ['2026-09-21']); assert.match(r.message, /deload week/); assert.equal(sched.isDeload(d.gym.schedule, TODAY, 1), true) } },
      { args: { date: '2026-09-28', on: true }, check(s) { assert.deepEqual(settingsOf(s).gym.schedule.deload.manualWeeks, ['2026-09-28']) } },
      { args: { every_weeks: 4 }, check(s, d, r) { assert.equal(settingsOf(s).gym.schedule.deload.everyWeeks, 4); assert.match(r.message, /every 4 weeks/) } },
      { args: { every_weeks: 0 }, check(s, d, r) { assert.match(r.message, /off/) } },
      { args: { date: 'today', on: false }, check(s, d, r) { assert.match(r.message, /No deload/) } },
    ],
    invalid: [{}, { date: '2026-09-01', on: true }, { date: 'whenever', on: true }],
  },

  // ---- food
  {
    name: 'food_log',
    valid: [
      { args: { items: [{ name: 'Banana', amount: 1, unit: 'medium', calories: 105, carbs_g: 27, protein_g: 1.3, fat_g: 0.4 }] }, check(s, d, r) {
        const entry = row(s, 'food_entries', r.id)
        assert.equal(entry.user_id, USER)
        assert.equal(entry.calories, 105)
        assert.equal(entry.date, TODAY)
        assert.equal(entry.time, '14:30', 'today defaults to now')
        assert.equal(d.foodEntries[0].id, r.id)
      } },
      { args: { items: [{ name: 'Protein shake', saved_food_id: 'fav1', servings: 2 }], meal: 'snack', time: '16:00' }, check(s, d, r) { const entry = row(s, 'food_entries', r.id); assert.equal(entry.calories, 240, 'saved numbers × servings'); assert.equal(entry.meal, 'snack'); assert.equal(entry.favorite_id, 'fav1') } },
      { args: { items: [{ name: 'Eggs', calories: 140, protein_g: 12, fat_g: 10 }, { name: 'Toast', calories: 80 }], date: 'yesterday', meal: 'breakfast' }, check(s, d, r) { assert.equal(r.ids.length, 2); assert.equal(row(s, 'food_entries', r.id).date, YESTERDAY); assert.equal(row(s, 'food_entries', r.id).time, null) } },
      { args: { items: [{ name: 'Beer', amount: 1, unit: 'pint', calories: 210, carbs_g: 17, alcohol_g: 20 }] }, check(s, d, r) { assert.equal(row(s, 'food_entries', r.id).calories, 210); assert.equal(row(s, 'food_entries', r.id).extra.alcoholG, 20) } },
    ],
    invalid: [{}, { items: [] }, { items: [{ name: 'Toast' }] }, { items: [{ name: 'X', calories: 100 }], date: 'tomorrow' }, { items: [{ name: 'X', calories: 100 }], time: 'noon' }, { items: [{ name: 'X', calories: 100 }], meal: 'elevenses' }, { items: [{ name: 'X', saved_food_id: 'nope' }] }, { items: 'banana' }, { items: [{ name: 'X', calories: 100 }], date: '2026-9-1' }],
  },
  {
    name: 'food_day',
    lookup: true,
    valid: [
      { args: {}, check(s, d, r) { assert.equal(r.found, undefined); assert.equal(r.meals[0].entries[0].id, 'fe1'); assert.equal(r.totals.kcal, 300) } },
      { args: { date: 'yesterday' }, check(s, d, r) { assert.equal(r.totals.kcal, 650) } },
      { args: { date: '2026-01-01' }, check(s, d, r) { assert.equal(r.found, false) } },
    ],
    invalid: [{ date: 'last monday' }],
  },
  {
    name: 'food_week',
    lookup: true,
    valid: [
      { args: {}, check(s, d, r) { assert.ok(r.week.start); assert.ok(r.summary); assert.equal(r.week.days.find((day) => day.date === TODAY).kcal, 300) } },
      { args: { week_start: '2026-09-14' }, check(s, d, r) { assert.equal(r.week.start, '2026-09-14') } },
    ],
    invalid: [{ week_start: 'this week' }],
  },
  {
    name: 'food_update_entry',
    valid: [
      { args: { id: 'fe1', changes: { calories: 320 } }, check(s, d) { assert.equal(row(s, 'food_entries', 'fe1').calories, 320); assert.equal(d.foodEntries.find((entry) => entry.id === 'fe1').calories, 320) } },
      { args: { id: 'fe1', scale: 2 }, check(s) { assert.equal(row(s, 'food_entries', 'fe1').calories, 600); assert.equal(row(s, 'food_entries', 'fe1').amount, 200) } },
      { args: { id: 'fe1', changes: { meal: 'snack', time: '10:00', name: 'Overnight oats' } }, check(s) { const entry = row(s, 'food_entries', 'fe1'); assert.equal(entry.meal, 'snack'); assert.equal(entry.time, '10:00'); assert.equal(entry.name, 'Overnight oats') } },
      { args: { id: 'fe2', changes: { protein_g: 50, carbs_g: 60, fat_g: 10 } }, check(s) { assert.equal(row(s, 'food_entries', 'fe2').calories, 524, 'calories follow new macros (4·50 + 4·60 + 9·10, fibre 3 g at 2 kcal instead of 4)') } },
      { args: { id: 'fe1', changes: { date: YESTERDAY, note: 'late breakfast' } }, check(s) { assert.equal(row(s, 'food_entries', 'fe1').date, YESTERDAY) } },
    ],
    invalid: [{}, { id: 'nope', changes: { calories: 1 } }, { id: 'fe1' }, { id: 'fe1', changes: {} }, { id: 'fe1', scale: 0 }, { id: 'fe1', scale: 50 }, { id: 'fe1', changes: { calories: -5 } }, { id: 'fe1', changes: { calories: null } }, { id: 'fe1', changes: { name: '' } }, { id: 'fe1', changes: { meal: 'brunch-ish' } }, { id: 'fe1', changes: { time: 'ten' } }, { id: 'fe1', changes: { date: 'tomorrow' } }, { id: 'fe1', changes: { date: '2026-09-30' } }, { id: 'fe1', changes: { calories: 300 } }],
  },
  {
    name: 'food_delete_entry',
    valid: [
      { args: { id: 'fe1' }, check(s, d, r) { assert.ok(!row(s, 'food_entries', 'fe1')); assert.equal(d.foodEntries.length, 1); assert.match(r.message, /Deleted Oats/) } },
      { args: { id: 'fe2' }, check(s) { assert.ok(!row(s, 'food_entries', 'fe2')) } },
    ],
    invalid: [{}, { id: 'nope' }],
  },
  {
    name: 'food_set_goals',
    valid: [
      { args: { calories: 2400, protein: 170 }, check(s, d) { const { goals } = settingsOf(s).food; assert.equal(goals.calories, 2400); assert.equal(goals.carbs, 250, 'other goals stay'); assert.equal(goals.source, 'manual'); assert.equal(d.settings.food.goals.protein, 170) } },
      { args: { carbs: 0 }, check(s, d, r) { assert.equal(settingsOf(s).food.goals.carbs, null); assert.match(r.message, /Removed the carbs goal/) } },
      { args: { calories: 2000, protein: 150, carbs: 200, fat: 60 }, check(s, d, r) { assert.match(r.message, /Daily goal/) } },
    ],
    invalid: [{}, { calories: 100 }, { protein: 5000 }, { calories: 'lots' }, { sugar: 20 }],
  },
  {
    name: 'food_calculate_goals',
    valid: [
      { args: { sex: 'male', age: 28, height_cm: 178, weight: 75, activity: 'moderate', goal: 'lose', rate_per_week: 0.5 }, check(s, d, r) { const { food } = settingsOf(s); assert.equal(food.goals.source, 'calculator'); assert.equal(food.profile.goal, 'lose'); assert.ok(r.calories > 1200 && r.calories < r.tdee, `${r.calories} kcal for a cut below maintenance ${r.tdee}`); assert.equal(d.settings.food.profile.rateKgPerWeek, 0.5) } },
      { args: {}, check(s, d, r) { assert.match(r.message, /latest weigh-in/, 'everything comes from the saved profile and the weight log'); assert.ok(r.calories > 0) } },
      { args: { goal: 'gain', target_weight: 80 }, check(s) { assert.equal(settingsOf(s).food.profile.targetKg, 80) } },
    ],
    invalid: [{ sex: 'other' }, { age: 5 }, { height_cm: 50 }, { weight: 10 }, { activity: 'couch' }, { goal: 'shred' }, { rate_per_week: 5 }, { target_weight: 5 }, { body_fat_pct: 90 }],
  },
  {
    name: 'food_memory',
    valid: [
      { args: { action: 'save', name: 'Quest bar', brand: 'Quest', amount: 1, unit: 'bar', grams: 60, calories: 200, protein_g: 21, carbs_g: 21, fat_g: 8, source: 'label', aliases: ['my bar'] }, check(s, d, r) {
        const { favorites } = settingsOf(s).food
        assert.equal(favorites.length, 2)
        const saved = favorites.find((fav) => fav.id === r.id)
        assert.equal(saved.source, 'label')
        assert.deepEqual(saved.aliases, ['my bar'])
        assert.equal(d.settings.food.favorites.length, 2)
      } },
      { args: { action: 'save', entry_id: 'fe1' }, check(s, d, r) { const saved = settingsOf(s).food.favorites.find((fav) => fav.id === r.id); assert.equal(saved.name, 'Oats'); assert.equal(saved.calories, 300); assert.equal(saved.source, 'entry') } },
      { args: { action: 'save', id: 'fav1', name: 'Protein shake', calories: 130, protein_g: 25 }, check(s, d, r) { assert.equal(r.id, 'fav1'); assert.equal(settingsOf(s).food.favorites.length, 1); assert.equal(settingsOf(s).food.favorites[0].calories, 130); assert.match(r.message, /Updated/) } },
      { args: { action: 'remove', id: 'fav1' }, check(s) { assert.equal(settingsOf(s).food.favorites.length, 0) } },
      { args: { action: 'remove', name: 'my shake' }, check(s) { assert.equal(settingsOf(s).food.favorites.length, 0) } },
      { args: { action: 'save', name: 'Greek yogurt', protein_g: 10, carbs_g: 6, fat_g: 0 }, check(s, d, r) { assert.equal(settingsOf(s).food.favorites.find((fav) => fav.id === r.id).calories, 64, 'calories from the macros') } },
    ],
    invalid: [{}, { action: 'forget' }, { action: 'remove', name: 'Nothing saved here' }, { action: 'save' }, { action: 'save', name: 'Air' }, { action: 'save', entry_id: 'nope' }],
  },
  {
    name: 'food_memory_find',
    lookup: true,
    valid: [
      { args: { query: 'shake' }, check(s, d, r) { assert.equal(r.found, true); assert.equal(r.foods[0].id, 'fav1') } },
      { args: { query: 'pizza' }, check(s, d, r) { assert.equal(r.found, false) } },
    ],
    invalid: [{}, { query: '' }],
  },
  {
    name: 'weight_delete',
    valid: [
      { args: { date: YESTERDAY }, check(s, d, r) { assert.ok(!row(s, 'body_weights', 'bw1')); assert.equal(d.body_weights.length, 1); assert.match(r.message, /75 kg/) } },
      { args: { date: 'yesterday' }, check(s) { assert.ok(!row(s, 'body_weights', 'bw1')) } },
    ],
    invalid: [{}, { date: '2026-01-01' }, { date: 'never' }],
  },
]

// Tools the harness leaves out on purpose: network (web_lookup is handled by the request handler, not
// executeTool; food_barcode_lookup calls Open Food Facts) and UI-only tools.
const SKIPPED = ['web_lookup', 'food_barcode_lookup', 'ask_choice', 'offer_alternatives']

// ---- running -----------------------------------------------------------------------------------------

// A tool may refuse with a thrown user message (the request handler turns it into ok:false, exactly
// like this). A runtime crash is never a user message: that is the bug the harness looks for.
const CRASH_RE = /cannot read propert|is not a function|is not iterable|is not defined|\[object object\]|\bNaN\b|Invalid time value/i
const isCrash = (error) => ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error?.name) || CRASH_RE.test(String(error?.message))

async function run(supabase, data, name, args, refs) {
  try {
    return await executeTool(supabase, USER, name, args, data, ctx, { refs })
  } catch (error) {
    assert.ok(!isCrash(error), `${name} crashed with ${error?.name}: ${error?.message}\n${error?.stack}`)
    return { ok: false, message: error.message, threw: true }
  }
}

function assertShape(name, result, { lookup }) {
  assert.ok(result && typeof result === 'object', `${name} returned ${typeof result}`)
  assert.equal(typeof result.ok, 'boolean', `${name} returned ok=${result.ok}`)
  if (!result.ok || !lookup) assert.equal(typeof result.message, 'string', `${name}: message missing (${JSON.stringify(result)})`)
  else if (result.message !== undefined) assert.equal(typeof result.message, 'string')
  if (typeof result.message === 'string' && !result.ok) assert.ok(result.message.trim(), `${name}: empty failure message`)
}

const argsText = (args) => JSON.stringify(args).slice(0, 110)

// A case marked `pending` covers a tool (or option) whose definition is already in TOOL_DEFS but whose
// handler may not have landed yet: while it still fails, the test is reported as a todo, not a failure.
const PENDING_TODO = 'BUG: the tool (or option) is defined in TOOL_DEFS and named in the instructions, but api/assistant.js does not handle it yet'
async function stillPending(name, args) {
  const { supabase, data } = fixture()
  try {
    const result = await executeTool(supabase, USER, name, args, data, ctx, {})
    return result?.ok !== true
  } catch {
    return true
  }
}
const todoFor = async (spec, item) => (item.pending && (await stillPending(spec.name, item.args)) ? PENDING_TODO : undefined)

for (const spec of CASES) {
  for (const item of spec.valid) item.todo = await todoFor(spec, item)
  describe(spec.name, () => {
    for (const item of spec.valid) {
      test(`valid ${argsText(item.args)}`, { todo: item.todo }, async () => {
        const { supabase, data } = fixture()
        const result = await run(supabase, data, spec.name, item.args)
        assertShape(spec.name, result, spec)
        assert.equal(result.ok, true, `${spec.name} refused valid arguments: ${result.message}`)
        if (item.noop) assert.equal(result.noop, true, 'expected a no-op')
        if (item.check) item.check(supabase, data, result)
      })
    }
    for (const raw of spec.invalid) {
      const item = raw.args ? raw : { args: raw }
      test(`invalid ${argsText(item.args)}`, async () => {
        const { supabase, data } = fixture()
        const before = structuredClone(supabase.db.tables)
        const result = await run(supabase, data, spec.name, item.args)
        assertShape(spec.name, result, spec)
        assert.equal(result.ok, false, `${spec.name} accepted invalid arguments: ${result.message}`)
        if (item.match) assert.match(result.message, item.match)
        assert.deepEqual(supabase.db.tables, before, 'a refused call writes nothing')
      })
    }
    for (const item of spec.bugs || []) {
      test(`invalid ${argsText(item.args)} (was: ${item.todo})`, async () => {
        const { supabase, data } = fixture()
        const result = await run(supabase, data, spec.name, item.args)
        assertShape(spec.name, result, spec)
        assert.equal(result.ok, false, `${spec.name} accepted invalid arguments: ${result.message}`)
      })
    }
    // Non-object arguments never crash.
    test('non-object arguments are refused', async () => {
      const { supabase, data } = fixture()
      for (const args of [null, 'text', 42, ['a']]) {
        const result = await run(supabase, data, spec.name, args)
        assert.equal(result.ok, false)
        assert.equal(typeof result.message, 'string')
      }
    })
  })
}

describe('staging (dry run) every write tool', () => {
  for (const spec of CASES) {
    if (spec.lookup) continue
    for (const item of spec.valid) {
      test(`${spec.name} ${argsText(item.args)}`, { todo: item.todo }, async () => {
        const { supabase, data } = fixture()
        const tablesBefore = structuredClone(supabase.db.tables)
        const dataBefore = structuredClone(data)
        const stage = { list: [], simIds: {}, sim: null }
        const result = await stageTool(supabase, USER, spec.name, item.args, data, ctx, stage)
        assert.ok(result && typeof result === 'object' && typeof result.ok === 'boolean')
        assert.equal(typeof result.message, 'string')
        if (item.noop) {
          assert.equal(result.ok, false, 'a no-op is not staged')
          assert.match(result.message, /Nothing to change/)
          assert.equal(stage.list.length, 0)
        } else {
          assert.equal(result.ok, true, `${spec.name} refused to stage: ${result.message}`)
          assert.equal(result.staged, true)
          assert.equal(typeof result.label, 'string')
          assert.ok(result.label.trim(), 'a staged action has a label')
          assert.equal(result.ref, '$1')
          assert.equal(stage.list.length, 1)
          assert.equal(stage.list[0].tool, spec.name)
          assert.match(result.message, /NOT done yet/)
        }
        assert.deepEqual(supabase.db.tables, tablesBefore, 'staging writes nothing to the database')
        assert.ok(!supabase.db.calls.some((call) => call.rpc || ['insert', 'update', 'delete', 'upsert'].includes(call.op)), 'staging sends no writes or RPCs')
        assert.deepEqual(data, dataBefore, 'staging leaves the loaded data alone')
      })
    }
  }

  test('a staged create can be referenced by $n in the same turn; duplicates are staged once', async () => {
    const { supabase, data } = fixture()
    const stage = { list: [], simIds: {}, sim: null }
    const first = await stageTool(supabase, USER, 'create_friend', { name: 'Zaid Ahmed', relationship: 'friend' }, data, ctx, stage)
    assert.equal(first.ref, '$1')
    const second = await stageTool(supabase, USER, 'log_contact', { friendId: '$1', note: 'his new flat' }, data, ctx, stage)
    assert.equal(second.ok, true, second.message)
    assert.match(second.label, /Zaid Ahmed/)
    const third = await stageTool(supabase, USER, 'update_friend', { friendId: '$1', currentStatus: 'moving' }, data, ctx, stage)
    assert.equal(third.ok, true, third.message)
    const bad = await stageTool(supabase, USER, 'log_contact', { friendId: '$9' }, data, ctx, stage)
    assert.equal(bad.ok, false)
    const again = await stageTool(supabase, USER, 'create_friend', { name: 'Zaid Ahmed', relationship: 'friend' }, data, ctx, stage)
    assert.equal(again.duplicate, true)
    assert.equal(stage.list.length, 3)
    assert.equal(data.friends.length, 4, 'the real data is untouched')
    assert.equal(supabase.db.tables.friends.length, 4)
  })

  test('staging refuses what the tool refuses, without a card', async () => {
    const { supabase, data } = fixture()
    const stage = { list: [], simIds: {}, sim: null }
    for (const [name, args] of [['create_task', {}], ['log_contact', { friendId: 'Nobody' }], ['gym_skip', { date: 'yesterday' }], ['food_log', { items: [] }], ['update_settings', { theme: 'purple' }]]) {
      const result = await stageTool(supabase, USER, name, args, data, ctx, stage)
      assert.equal(result.ok, false, name)
      assert.equal(typeof result.message, 'string')
    }
    assert.equal(stage.list.length, 0)
  })
})

describe('coverage and definitions', () => {
  test('every tool definition is exercised or deliberately skipped', () => {
    const names = TOOL_DEFS.map((def) => def.name)
    assert.equal(new Set(names).size, names.length, 'tool names are unique')
    const covered = new Set([...CASES.map((spec) => spec.name), ...SKIPPED])
    assert.deepEqual(names.filter((name) => !covered.has(name)), [], 'tools without cases')
    assert.deepEqual([...covered].filter((name) => !names.includes(name)), [], 'cases for tools that no longer exist')
    for (const def of TOOL_DEFS) {
      assert.equal(def.type, 'function')
      assert.equal(typeof def.description, 'string')
      assert.equal(def.parameters.type, 'object')
      for (const key of def.parameters.required || []) assert.ok(def.parameters.properties[key], `${def.name}: required ${key} is not a property`)
    }
    for (const name of [...LOOKUP_TOOLS, ...UI_TOOLS]) assert.ok(names.includes(name), `${name} is listed but not defined`)
    for (const spec of CASES) assert.equal(Boolean(spec.lookup), LOOKUP_TOOLS.includes(spec.name), `${spec.name}: lookup flag must match LOOKUP_TOOLS`)
  })

  test('an unknown tool is a thrown error (the handler reports it), never a silent success', async () => {
    const { supabase, data } = fixture()
    await assert.rejects(executeTool(supabase, USER, 'no_such_tool', {}, data, ctx), /Unknown tool/)
    const staged = await stageTool(supabase, USER, 'no_such_tool', {}, data, ctx, { list: [], simIds: {}, sim: null })
    assert.equal(staged.ok, false)
  })

  test('the fixture is what the cases assume', () => {
    const { data } = fixture()
    const shown = (date) => sched.resolveDay(data.gym, data.gym_sessions, date, TODAY).shown
    assert.equal(shown(TODAY).routineId, 'r-push')
    assert.equal(shown(TOMORROW).routineId, 'r-pull')
    assert.equal(shown('2026-09-26').kind, 'rest')
    assert.equal(shown('2026-09-27').routineId, 'r-legs')
    assert.equal(sched.resolveDay(data.gym, data.gym_sessions, '2026-09-29', TODAY).status, 'skipped')
  })
})

describe('snapshot and instructions', () => {
  const RULED_TOOLS = ['create_task', 'update_task', 'create_event', 'create_class', 'update_class', 'create_friend', 'update_friend', 'log_contact', 'ask_choice', 'remember', 'forget', 'read_journal', 'get_weather', 'get_prayer_times', 'gym_skip', 'gym_shift', 'gym_move', 'gym_realign', 'gym_log_workout', 'gym_quick_log', 'gym_log_bodyweight', 'gym_edit_session', 'gym_duplicate_session', 'gym_stats', 'gym_duplicate_routine', 'gym_edit_routine', 'gym_exercise_records', 'food_log', 'food_day', 'food_set_goals', 'food_calculate_goals', 'food_memory_find', 'food_memory', 'food_barcode_lookup', 'web_lookup', 'offer_alternatives']

  test('buildSnapshot reflects the data and is JSON-serialisable', () => {
    const { data } = fixture()
    const snapshot = buildSnapshot(data, ctx, 'amaan')
    assert.equal(snapshot.user.username, 'amaan')
    assert.equal(snapshot.upcomingDays[0], `Thu ${TODAY}`)
    assert.equal(snapshot.agenda.length, 7)
    assert.match(snapshot.agenda[0], /class Algorithms/)
    assert.match(snapshot.agenda[0], /3:00 PM task Dentist appointment/)
    assert.ok(snapshot.openTasks.some((task) => task.id === 't6' && task.overdue === true))
    assert.ok(!snapshot.openTasks.some((task) => task.id === 't3'), 'done tasks are not open')
    assert.equal(snapshot.recentlyCompleted[0].id, 't3')
    assert.ok(snapshot.calendar.some((event) => event.id === 'e2'))
    assert.ok(!snapshot.calendar.some((event) => event.id === 'e-old'), 'events older than a week are left out')
    const hasan = snapshot.people.find((person) => person.id === 'f1')
    assert.equal(hasan.lastTalked, '2026-09-20')
    assert.equal(hasan.daysSinceTalked, 4)
    assert.equal(hasan.birthdayInDays, 7)
    assert.equal(hasan.lastTopic, 'his new job at Shopify')
    assert.equal(snapshot.people.find((person) => person.id === 'f2').catchUpDue, undefined)
    assert.equal(snapshot.people.find((person) => person.id === 'f3').catchUpDue, true)
    assert.equal(snapshot.journal[0].date, TODAY)
    assert.equal(snapshot.notes.length, 2)
    assert.equal(snapshot.memories.length, 2)
    assert.equal(snapshot.settings.accent, 'sunset')
    assert.equal(snapshot.settings.notifications.gymTime, '17:00')
    assert.match(snapshot.gym.today, /Push/)
    assert.match(snapshot.gym.today, /Bench Press \(Barbell\)/)
    assert.equal(snapshot.gym.next7.length, 7)
    assert.match(snapshot.gym.plan, /4-day rotation/)
    assert.equal(snapshot.gym.routines.length, 3)
    assert.match(snapshot.gym.bodyWeight, /75 kg/)
    assert.ok(snapshot.food && typeof snapshot.food === 'object', 'the food snapshot is built')
    assert.equal(snapshot.locationKnown, false)
    assert.doesNotThrow(() => JSON.stringify(snapshot))
    assert.equal(snapshot.classes.length, 2)
    assert.deepEqual(snapshot.classes[1].schedule, [{ day: 'Tue', time: '2:00 PM - 3:00 PM', room: 'L2' }], 'legacy day_details classes are flattened')
  })

  test('buildSnapshot survives an empty account', () => {
    const data = { tasks: [], events: [], friends: [], voice_notes: [], classes: [], journal_entries: [], contact_logs: [], settings: {}, gym: { schedule: sched.emptySchedule(), routines: [], folders: [], exercises: [], exerciseMeta: {}, prefs: { unit: 'kg', distanceUnit: 'km', firstWeekday: 1, weeklyGoal: 3, defaultRest: 120, e1rmFormula: 'brzycki', previousSource: 'any', progression: true, bodyweightInVolume: true }, active: null }, gymTablesMissing: true, gym_sessions: [], gymSessionsTruncated: false, body_weights: [], memories: null, foodEntries: [], foodMissing: true }
    const snapshot = buildSnapshot(data, ctx, 'new')
    assert.match(String(snapshot.gym), /not set up/)
    assert.equal(snapshot.openTasks, undefined)
    assert.doesNotThrow(() => buildInstructions(snapshot))
  })

  test('buildInstructions embeds the snapshot and the mode rules, and names every tool with a rule', () => {
    const { data } = fixture()
    const snapshot = buildSnapshot(data, ctx, 'amaan')
    const confirm = buildInstructions(snapshot, { confirmMode: true })
    const direct = buildInstructions(snapshot, { confirmMode: false })
    assert.match(confirm, /Staged: waiting for the user to confirm/)
    assert.doesNotMatch(confirm, /turned confirmations off/)
    assert.match(direct, /turned confirmations off/)
    assert.doesNotMatch(direct, /Staged: waiting/)
    assert.ok(confirm.endsWith(JSON.stringify(snapshot)), 'the snapshot JSON is the last thing in the instructions')
    assert.equal(buildInstructions(snapshot), confirm, 'confirm mode is the default')
    for (const name of RULED_TOOLS) assert.ok(confirm.includes(name), `instructions do not mention ${name}`)
    const defined = new Set(TOOL_DEFS.map((def) => def.name))
    for (const name of confirm.match(/\b(?:gym|food)_[a-z_]+\b/g) || []) assert.ok(defined.has(name), `instructions mention ${name}, which is not a tool`)
  })
})

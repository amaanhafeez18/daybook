import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeName, resolveFriend, similarFriends } from '../api/_people.js'
import { mergeSettings, patchSettingsAtomic, resetSettingsRpcMemo, writeSettingsPatch } from '../api/_settings.js'
import {
  FOOD_LOOKUP_TOOLS, FOOD_TOOL_DEFS, FOOD_TOOL_NAMES, checkFoodTool, describeFoodAction, executeFoodTool, foodSnapshot, loadFoodData,
} from '../api/_food-tools.js'
import { DEFAULT_NOTIFICATIONS, combineReminders, dueNotifications, groupDue, reminderPreview } from '../api/_reminders.js'

// ---- a small in-memory stand-in for the Supabase client ----------------------------------------------

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
        return { data: structuredClone(out), error: null }
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

// Silences the expected "function is missing" warning.
let restoreWarn = null
function quietWarnings() {
  const original = console.warn
  const original2 = console.error
  console.warn = () => {}
  console.error = () => {}
  restoreWarn = () => {
    console.warn = original
    console.error = original2
  }
}

const TODAY = '2026-09-23' // a Wednesday
const USER = 'user-a'
const OTHER = 'user-b'
const ctxAt = (localTime = '08:15', localDate = TODAY) => ({ localDate, localTime, weekday: 'Wed', timeZone: 'UTC', location: null })

// ---- people --------------------------------------------------------------------------------------

describe('resolveFriend', () => {
  const friends = [
    { id: 'f1', name: 'Hasan Raza', organization: 'Acme' },
    { id: 'f2', name: 'Muhammad Usman' },
    { id: 'f3', name: 'Ali Khan', organization: 'Google', facts: 'Works with me on the payments team' },
    { id: 'f4', name: 'Ali Raza', relationship: 'close_friend' },
    { id: 'f5', name: 'Sarah Connor' },
    { id: 'f6', name: 'Michael Scott', current_status: 'my boss at Dunder Mifflin' },
  ]

  test('ids and staged refs come first', () => {
    assert.deepEqual(resolveFriend(friends, 'f3'), { match: friends[2], how: 'id', assumed: false })
    assert.equal(resolveFriend(friends, '$1', new Map([['$1', 'f5']])).match, friends[4])
    assert.equal(resolveFriend(friends, '$2', { $2: 'f1' }).how, 'ref')
    // A staged create: the ref points at a friend-like object that isn't saved yet.
    const staged = resolveFriend(friends, '$1', { $1: { name: 'Zaid' } })
    assert.deepEqual(staged, { match: { name: 'Zaid' }, how: 'ref', assumed: false })
    assert.deepEqual(resolveFriend(friends, '$9', {}), { none: true, similar: [] })
  })

  test('Hassan ↔ Hasan is a spelling variant (matched, but assumed)', () => {
    const result = resolveFriend(friends, 'Hassan')
    assert.equal(result.match.id, 'f1')
    assert.equal(result.how, 'spelling')
    assert.equal(result.assumed, true)
    assert.equal(resolveFriend([{ id: 'x', name: 'Hassan Ali' }], 'Hasan').match.id, 'x')
  })

  test('Mohammad / Muhammad / Mohd / Mo name the same person', () => {
    for (const query of ['Mohammad', 'Mohammed', 'Muhammed', 'Mohd', 'Mo', 'mohamed usman']) {
      const result = resolveFriend(friends, query)
      assert.equal(result.match?.id, 'f2', query)
      assert.equal(result.assumed, true, query)
    }
    // Usman / Osman as the surname
    assert.equal(resolveFriend(friends, 'Osman').match.id, 'f2')
  })

  test('honorifics, fillers and possessives are ignored', () => {
    for (const query of ['hassan bhai', 'Hassan bhai’s', 'my friend Hasan', 'Uncle Hasan', 'Dr. Hasan Raza']) {
      assert.equal(resolveFriend(friends, query).match?.id, 'f1', query)
    }
    assert.equal(resolveFriend(friends, 'Hasan Raza').how, 'exact')
    assert.equal(normalizeName("Dr. Hassan Bhai's"), 'hassan')
    assert.equal(normalizeName('Mr Ali (gym)'), 'ali')
  })

  test('a first name or surname alone is a firm match', () => {
    assert.deepEqual(resolveFriend(friends, 'Sarah'), { match: friends[4], how: 'name', assumed: false })
    assert.equal(resolveFriend(friends, 'connor').match.id, 'f5')
    assert.equal(resolveFriend(friends, 'Mike').match.id, 'f6') // nickname
  })

  test('two Alis are ambiguous unless the context picks one', () => {
    const result = resolveFriend(friends, 'Ali')
    assert.deepEqual(result.ambiguous.map((friend) => friend.id).sort(), ['f3', 'f4'])
    const work = resolveFriend(friends, 'Ali from work')
    assert.equal(work.match.id, 'f3')
    assert.equal(work.narrowedBy, 'context')
    assert.equal(resolveFriend(friends, 'Ali at Google').match.id, 'f3')
    assert.equal(resolveFriend(friends, 'Ali Raza').match.id, 'f4')
  })

  test('small typos match; three-letter names need to be exact', () => {
    assert.equal(resolveFriend(friends, 'Micheal').how, 'fuzzy')
    assert.equal(resolveFriend(friends, 'Sarha').match.id, 'f5')
    assert.ok(resolveFriend([{ id: 'a', name: 'Ali' }], 'Adi').none)
    // A different surname is a different person.
    assert.ok(resolveFriend(friends, 'Ali Hamza').none)
  })

  test('descriptions match details only when no name is given', () => {
    assert.equal(resolveFriend(friends, 'my boss').match.id, 'f6')
    assert.equal(resolveFriend(friends, 'someone from Acme').how, 'org')
  })

  test('nobody: similar names are suggested, never picked', () => {
    const onlyHussain = [{ id: 'h', name: 'Hussain' }, { id: 'z', name: 'Zara' }]
    const result = resolveFriend(onlyHussain, 'Hassan')
    assert.equal(result.none, true)
    assert.deepEqual(result.similar.map((friend) => friend.id), ['h'])
    assert.deepEqual(resolveFriend(friends, 'Zaid'), { none: true, similar: [] })
    assert.deepEqual(resolveFriend(friends, ''), { none: true, similar: [] })
    assert.deepEqual(resolveFriend(null, 'Ali'), { none: true, similar: [] })
  })

  test('similarFriends warns before adding a duplicate', () => {
    assert.deepEqual(similarFriends(friends, 'Hassan').map((friend) => friend.id), ['f1'])
    assert.deepEqual(similarFriends(friends, 'Hasan Raza').map((friend) => friend.id), ['f1'])
    assert.deepEqual(similarFriends(friends, 'Ali').map((friend) => friend.id).sort(), ['f3', 'f4'])
    assert.deepEqual(similarFriends(friends, 'Ali Hamza'), [])
    assert.deepEqual(similarFriends(friends, 'Priya'), [])
  })
})

// ---- settings --------------------------------------------------------------------------------------

describe('patchSettingsAtomic', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  const settingsRows = () => [
    { id: 's1', user_id: USER, value: { theme: 'forest', food: { favorites: [{ id: 'fav', name: 'Oats' }], goals: { calories: 2000 } } }, created_at: '2026-09-01T00:00:00Z' },
    { id: 's2', user_id: USER, value: { stale: true }, created_at: '2026-08-01T00:00:00Z' },
    { id: 's3', user_id: OTHER, value: { theme: 'midnight' }, created_at: '2026-08-01T00:00:00Z' },
  ]

  test('uses the patch_settings function when it exists', async () => {
    const supabase = fakeSupabase({ tables: { settings: settingsRows() } })
    const result = await patchSettingsAtomic(supabase, USER, { food: { goals: { calories: 2500 } } })
    assert.equal(result, null) // the function returns nothing
    assert.deepEqual(supabase.db.calls, [{ rpc: 'patch_settings', args: { p_user: USER, p_patch: { food: { goals: { calories: 2500 } } } } }])
    assert.equal(writeSettingsPatch, patchSettingsAtomic)
  })

  test('without the function: read, merge one level deep, write, remove duplicates; remembered for a while', async () => {
    const supabase = fakeSupabase({ tables: { settings: settingsRows() }, rpc: 'missing' })
    const merged = await patchSettingsAtomic(supabase, USER, { food: { goals: { calories: 2500 } }, displayName: 'Amaan' })
    assert.deepEqual(merged, { theme: 'forest', displayName: 'Amaan', food: { favorites: [{ id: 'fav', name: 'Oats' }], goals: { calories: 2500 } } })
    const mine = supabase.db.tables.settings.filter((row) => row.user_id === USER)
    assert.equal(mine.length, 1)
    assert.deepEqual(mine[0].value, merged)
    assert.deepEqual(supabase.db.tables.settings.find((row) => row.user_id === OTHER).value, { theme: 'midnight' })

    // The missing function isn't called again straight away…
    supabase.db.calls.length = 0
    await patchSettingsAtomic(supabase, USER, { theme: 'sunset' })
    assert.equal(supabase.db.calls.some((call) => call.rpc), false)
    assert.equal(supabase.db.tables.settings.find((row) => row.user_id === USER).value.theme, 'sunset')
    // …but is tried again once the memory is cleared (e.g. after 10 minutes).
    resetSettingsRpcMemo()
    supabase.db.calls.length = 0
    await patchSettingsAtomic(supabase, USER, { theme: 'forest' })
    assert.equal(supabase.db.calls[0].rpc, 'patch_settings')
  })

  test('without the function and without a settings row: inserts one', async () => {
    const supabase = fakeSupabase({ rpc: 'missing' })
    const merged = await patchSettingsAtomic(supabase, USER, { theme: 'forest' })
    assert.deepEqual(merged, { theme: 'forest' })
    assert.equal(supabase.db.tables.settings.length, 1)
    assert.equal(supabase.db.tables.settings[0].user_id, USER)
  })

  test('other database errors are thrown', async () => {
    const supabase = fakeSupabase({ tables: { settings: settingsRows() }, rpc: 'fail' })
    await assert.rejects(patchSettingsAtomic(supabase, USER, { theme: 'x' }), { message: /on fire/ })
  })
})

// ---- food tools ------------------------------------------------------------------------------------

function foodRow(id, userId, fields) {
  return {
    id, user_id: userId, date: TODAY, time: '08:00', meal: 'breakfast', name: 'Oats', brand: null, amount: 60, unit: 'g', grams: 60,
    calories: 230, protein_g: 8, carbs_g: 40, fat_g: 4, fiber_g: 6, sugar_g: 1, sodium_mg: 5, extra: {}, note: null,
    source: 'manual', favorite_id: null, ai: null, created_at: `${TODAY}T08:00:00Z`, ...fields,
  }
}

function baseData(overrides = {}) {
  return {
    settings: { food: { goals: { calories: 2000, protein: 150 }, favorites: [{ id: 'fav1', name: 'Protein shake', amount: 1, unit: 'scoop', calories: 120, proteinG: 24 }] }, gym: { prefs: { unit: 'kg' } } },
    settingsRow: null,
    foodEntries: [],
    foodMissing: false,
    body_weights: [],
    ...overrides,
  }
}

describe('food tool definitions', () => {
  test('every tool is a non-strict function with a description; lookups are marked', () => {
    assert.deepEqual(FOOD_TOOL_NAMES, ['food_log', 'food_day', 'food_week', 'food_update_entry', 'food_delete_entry', 'food_set_goals', 'food_calculate_goals', 'food_memory', 'food_memory_find', 'food_barcode_lookup', 'weight_delete'])
    for (const definition of FOOD_TOOL_DEFS) {
      assert.equal(definition.type, 'function')
      assert.equal(definition.strict, false)
      assert.ok(definition.description.length > 40, definition.name)
      assert.equal(definition.parameters.type, 'object')
    }
    assert.deepEqual(FOOD_LOOKUP_TOOLS, ['food_day', 'food_week', 'food_memory_find', 'food_barcode_lookup'])
    const log = FOOD_TOOL_DEFS[0].parameters.properties.items.items.properties
    for (const key of ['name', 'amount', 'unit', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'alcohol_g', 'caffeine_mg', 'brand']) assert.ok(log[key], key)
  })
})

describe('loadFoodData', () => {
  afterEach(() => restoreWarn?.())

  test('the last 60 days of the user’s rows, in app shape', async () => {
    const supabase = fakeSupabase({
      tables: {
        food_entries: [
          foodRow('e1', USER, {}),
          foodRow('old', USER, { date: '2026-06-01' }),
          foodRow('theirs', OTHER, {}),
          foodRow('e2', USER, { date: '2026-09-20', protein_g: '12.5' }),
        ],
      },
    })
    const { foodEntries, foodMissing } = await loadFoodData(supabase, USER, ctxAt())
    assert.equal(foodMissing, false)
    assert.deepEqual(foodEntries.map((entry) => entry.id).sort(), ['e1', 'e2'])
    const e2 = foodEntries.find((entry) => entry.id === 'e2')
    assert.equal(e2.proteinG, 12.5)
    assert.equal(e2.createdAt, `${TODAY}T08:00:00Z`)
    assert.equal('protein_g' in e2, false)
  })

  test('a missing table is not an error', async () => {
    const supabase = fakeSupabase({ missingTables: ['food_entries'] })
    assert.deepEqual(await loadFoodData(supabase, USER, ctxAt()), { foodEntries: [], foodMissing: true })
  })

  test('another failure gives no entries and a note', async () => {
    quietWarnings()
    const supabase = { from: () => { throw new Error('network down') } }
    const result = await loadFoodData(supabase, USER, ctxAt())
    assert.deepEqual(result.foodEntries, [])
    assert.equal(result.foodMissing, false)
    assert.ok(result.foodError)
  })
})

describe('executeFoodTool', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('food_log clamps numbers, defaults the meal from the time and writes user-owned rows', async () => {
    const supabase = fakeSupabase()
    const data = baseData()
    const result = await executeFoodTool(supabase, USER, 'food_log', {
      items: [
        { name: 'Scrambled eggs', amount: 2, unit: 'large', calories: 99999, protein_g: 12, carbs_g: 1, fat_g: 10 },
        { name: 'Toast', amount: 1, unit: 'slice', calories: 80, protein_g: -3 },
      ],
    }, data, ctxAt('08:15'))
    assert.equal(result.ok, true, result.message)
    const rows = supabase.db.tables.food_entries
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.user_id, USER)
      assert.equal(row.source, 'assistant')
      assert.equal(row.date, TODAY)
      assert.equal(row.time, '08:15')
      assert.equal(row.meal, 'breakfast')
      assert.match(row.id, /^[0-9a-f-]{36}$/)
      assert.ok(row.created_at)
    }
    const eggs = rows.find((row) => row.name === 'Scrambled eggs')
    // 99999 kcal is clamped, then the energy check uses the macros (4·12 + 4·1 + 9·10 = 142).
    assert.equal(eggs.calories, 142)
    assert.equal(eggs.protein_g, 12)
    assert.equal(rows.find((row) => row.name === 'Toast').protein_g, 0)
    assert.equal(data.foodEntries.length, 2)
    assert.equal(data.foodEntries[0].proteinG !== undefined, true)
    assert.deepEqual(result.ids, rows.map((row) => row.id))
    assert.match(result.message, /Breakfast today/)
    assert.match(result.message, /Today: 222 \/ 2,000 kcal \(1,778 left\)/)
  })

  test('food_log saves a drink with its alcohol and full calories', async () => {
    const supabase = fakeSupabase()
    const data = baseData()
    const result = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Beer', amount: 2, unit: 'can', calories: 300, protein_g: 3, carbs_g: 26, fat_g: 0, alcohol_g: 28 }] }, data, ctxAt('20:00'))
    assert.equal(result.ok, true, result.message)
    const [row] = supabase.db.tables.food_entries
    assert.equal(row.calories, 300)
    assert.deepEqual(row.extra, { alcoholG: 28 })
  })

  test('food_log with saved_food_id uses the saved numbers exactly, scaled by servings', async () => {
    const supabase = fakeSupabase()
    const quest = { id: 'fav-quest', name: 'Quest bar cookies & cream', brand: 'Quest', amount: 1, unit: 'bar', grams: 60, calories: 200, proteinG: 21, carbsG: 21, fatG: 8, fiberG: 14, source: 'web' }
    const data = baseData()
    data.settings.food.favorites.push(quest)
    const ctx = ctxAt('15:00')
    // The model's own (wrong) numbers are ignored; 200 kcal stands although the macros suggest 240.
    const args = { items: [{ name: 'Quest bar', saved_food_id: 'fav-quest', servings: 2, calories: 999 }] }
    assert.equal(describeFoodAction('food_log', args, data, ctx), 'Log Quest bar cookies & cream (2 bars) from My foods · 400 kcal → Lunch today')
    const result = await executeFoodTool(supabase, USER, 'food_log', args, data, ctx)
    assert.equal(result.ok, true, result.message)
    const [row] = supabase.db.tables.food_entries
    assert.equal(row.calories, 400)
    assert.equal(row.protein_g, 42)
    assert.equal(row.grams, 120)
    assert.equal(row.amount, 2)
    assert.equal(row.favorite_id, 'fav-quest')
    // Amount in the saved unit works too; an unknown id is refused.
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Quest', saved_food_id: 'fav-quest', amount: 1, unit: 'bars' }] }, data, ctx), 'Log Quest bar cookies & cream (1 bar) from My foods · 200 kcal → Lunch today')
    assert.equal(checkFoodTool('food_log', { items: [{ name: 'Quest', saved_food_id: 'nope' }] }, data, ctx).ok, false)
  })

  test('food_log keeps stated calories within 30% of the macros (fibre, sugar alcohols) and names the portion once', () => {
    const data = baseData()
    const ctx = ctxAt('15:00')
    // 21·4 + 21·4 + 8·9 = 240 kcal from the macros; the published 200 kcal stands.
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Quest bar (Cookies & Cream, 1 bar)', amount: 1, unit: 'bar', calories: 200, protein_g: 21, carbs_g: 21, fat_g: 8 }] }, data, ctx), 'Log Quest bar (Cookies & Cream, 1 bar) · 200 kcal → Lunch today')
  })

  test('food_log: meal names, past days without a time and bad input', async () => {
    const supabase = fakeSupabase()
    const data = baseData()
    let result = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Biryani', calories: 700 }], date: '2026-09-22', meal: 'Supper' }, data, ctxAt('21:00'))
    assert.equal(result.ok, true)
    assert.equal(supabase.db.tables.food_entries[0].meal, 'dinner')
    assert.equal(supabase.db.tables.food_entries[0].time, null)
    result = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Crisps', calories: 150 }], date: '2026-09-21' }, data, ctxAt())
    assert.equal(supabase.db.tables.food_entries[1].meal, 'snack')
    for (const args of [
      { items: [{ name: 'Cake', calories: 300 }], date: '2026-09-24' },
      { items: [] },
      { items: [{ name: 'Mystery' }] },
      { items: [{ name: 'Tea', calories: 2 }], meal: 'elevenses' },
      { items: [{ name: 'Tea', calories: 2 }], time: '25:00' },
    ]) {
      const bad = await executeFoodTool(supabase, USER, 'food_log', args, data, ctxAt())
      assert.equal(bad.ok, false, JSON.stringify(args))
    }
    assert.equal(supabase.db.tables.food_entries.length, 2)
  })

  test('food_log without the food table explains the migration', async () => {
    const supabase = fakeSupabase({ missingTables: ['food_entries'] })
    const data = baseData()
    const result = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Tea', calories: 2 }] }, data, ctxAt())
    assert.equal(result.ok, false)
    assert.match(result.message, /2026-09-27-food\.sql/)
    assert.equal(data.foodMissing, true)
    // Known missing: nothing is tried.
    supabase.db.calls.length = 0
    const again = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Tea', calories: 2 }] }, data, ctxAt())
    assert.equal(again.ok, false)
    assert.equal(supabase.db.calls.length, 0)
    assert.equal(checkFoodTool('food_log', { items: [{ name: 'Tea', calories: 2 }] }, data, ctxAt()).ok, false)
  })

  test('food_log drops a column the database doesn’t have yet', async () => {
    const supabase = fakeSupabase({ missingColumns: { food_entries: ['favorite_id'] } })
    const result = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Protein shake', calories: 120 }] }, baseData(), ctxAt())
    assert.equal(result.ok, true)
    assert.equal('favorite_id' in supabase.db.tables.food_entries[0], false)
  })

  test('food_update_entry only touches the user’s own rows', async () => {
    const supabase = fakeSupabase({ tables: { food_entries: [foodRow('e1', USER, {}), foodRow('e2', OTHER, { name: 'Their oats' })] } })
    const data = baseData((await loadFoodData(supabase, USER, ctxAt())))
    assert.deepEqual(data.foodEntries.map((entry) => entry.id), ['e1'])

    const theirs = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'e2', changes: { calories: 1 } }, data, ctxAt())
    assert.equal(theirs.ok, false)
    assert.equal(supabase.db.tables.food_entries.find((row) => row.id === 'e2').calories, 230)
    const lookup = supabase.db.calls.find((call) => call.table === 'food_entries' && call.filters.some(([, column, value]) => column === 'id' && value === 'e2'))
    assert.ok(lookup.filters.some(([kind, column, value]) => kind === 'eq' && column === 'user_id' && value === USER))

    supabase.db.calls.length = 0
    const mine = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'e1', changes: { calories: 310, meal: 'Lunch' } }, data, ctxAt())
    assert.equal(mine.ok, true, mine.message)
    const update = supabase.db.calls.find((call) => call.op === 'update')
    assert.deepEqual(update.payload, { meal: 'lunch', calories: 310 })
    assert.ok(update.filters.some(([, column, value]) => column === 'user_id' && value === USER))
    assert.equal(data.foodEntries[0].calories, 310)
    assert.match(mine.message, /230 → 310 kcal/)

    const doubled = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'e1', scale: 2 }, data, ctxAt())
    assert.equal(doubled.ok, true)
    const row = supabase.db.tables.food_entries.find((item) => item.id === 'e1')
    assert.equal(row.calories, 620)
    assert.equal(row.amount, 120)
    assert.equal(row.protein_g, 16)

    // New macros without calories: calories follow: 4·20 + 4·(50 − 12) + 2·12 + 9·10 = 346 (fiber is 12 after doubling).
    const macros = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'e1', changes: { protein_g: 20, carbs_g: 50, fat_g: 10 } }, data, ctxAt())
    assert.equal(macros.ok, true)
    assert.equal(data.foodEntries[0].calories, 346)

    const nothing = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'e1', changes: {} }, data, ctxAt())
    assert.equal(nothing.ok, false)
  })

  test('food_delete_entry only deletes the user’s own rows', async () => {
    const supabase = fakeSupabase({ tables: { food_entries: [foodRow('e1', USER, {}), foodRow('e2', OTHER, {})] } })
    const data = baseData(await loadFoodData(supabase, USER, ctxAt()))
    const theirs = await executeFoodTool(supabase, USER, 'food_delete_entry', { id: 'e2' }, data, ctxAt())
    assert.equal(theirs.ok, false)
    assert.equal(supabase.db.tables.food_entries.length, 2)
    const mine = await executeFoodTool(supabase, USER, 'food_delete_entry', { id: 'e1' }, data, ctxAt())
    assert.equal(mine.ok, true)
    assert.deepEqual(supabase.db.tables.food_entries.map((row) => row.id), ['e2'])
    const del = supabase.db.calls.find((call) => call.op === 'delete')
    assert.ok(del.filters.some(([, column, value]) => column === 'user_id' && value === USER))
    assert.deepEqual(data.foodEntries, [])
    assert.match(mine.message, /Deleted Oats \(60 g\) \(230 kcal\) from Breakfast today/)
  })

  test('food_set_goals writes settings.food.goals through patch_settings (and its fallback)', async () => {
    const withRpc = fakeSupabase({ tables: { settings: [{ id: 's1', user_id: USER, value: baseData().settings, created_at: '2026-09-01T00:00:00Z' }] } })
    const data = baseData()
    const result = await executeFoodTool(withRpc, USER, 'food_set_goals', { calories: 2210, protein: 160, carbs: 226, fat: 74 }, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    assert.equal(result.message, 'Daily goal: 2,210 kcal · P 160 g · C 226 g · F 74 g.')
    const call = withRpc.db.calls.find((item) => item.rpc)
    assert.deepEqual(call.args.p_patch, { food: { goals: { calories: 2210, protein: 160, carbs: 226, fat: 74, source: 'manual' } } })
    // In memory: goals replaced, favorites kept.
    assert.equal(data.settings.food.goals.calories, 2210)
    assert.equal(data.settings.food.favorites.length, 1)

    const fallback = fakeSupabase({ tables: { settings: [{ id: 's1', user_id: USER, value: baseData().settings, created_at: '2026-09-01T00:00:00Z' }] }, rpc: 'missing' })
    const data2 = baseData({ settingsRow: { id: 's1', value: baseData().settings } })
    const cleared = await executeFoodTool(fallback, USER, 'food_set_goals', { protein: 0, fiber: 30 }, data2, ctxAt())
    assert.equal(cleared.ok, true)
    const saved = fallback.db.tables.settings[0].value
    assert.deepEqual(saved.food.goals, { calories: 2000, protein: null, fiber: 30, source: 'manual' })
    assert.equal(saved.food.favorites.length, 1)
    assert.equal(saved.gym.prefs.unit, 'kg')
    assert.deepEqual(data2.settings, saved)
    assert.deepEqual(data2.settingsRow.value, saved)

    for (const bad of [{}, { calories: 50 }, { protein: 'lots' }]) {
      assert.equal((await executeFoodTool(fallback, USER, 'food_set_goals', bad, data2, ctxAt())).ok, false, JSON.stringify(bad))
    }

    // Staging (a dry-run client): only the in-memory copy changes.
    const dry = Object.assign(fakeSupabase(), { dryRun: true })
    const data3 = baseData()
    const staged = await executeFoodTool(dry, USER, 'food_set_goals', { calories: 1800 }, data3, ctxAt())
    assert.equal(staged.ok, true)
    assert.equal(data3.settings.food.goals.calories, 1800)
    assert.deepEqual(dry.db.calls, [])
  })

  test('food_calculate_goals saves the profile and calculated goals, or asks for what is missing', async () => {
    const supabase = fakeSupabase({ tables: { settings: [{ id: 's1', user_id: USER, value: {}, created_at: '2026-09-01T00:00:00Z' }] } })
    const data = baseData({ settings: { gym: { prefs: { unit: 'lb' } } } })
    const missing = await executeFoodTool(supabase, USER, 'food_calculate_goals', { sex: 'male', age: 30 }, data, ctxAt())
    assert.equal(missing.ok, false)
    assert.deepEqual(missing.missing, ['weight', 'height'])
    assert.match(missing.message, /weight \(lb\) and height/)

    // 80 kg man, 180 cm, 30, moderate, lose 0.5 kg/week (1.1 lb): research §3 worked example → 2,210 kcal.
    const result = await executeFoodTool(supabase, USER, 'food_calculate_goals', {
      sex: 'male', age: 30, height_cm: 180, weight: 176.37, activity: 'moderate', goal: 'lose', rate_per_week: 1.1,
    }, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    assert.equal(result.calories, 2210)
    assert.equal(data.settings.food.goals.source, 'calculator')
    assert.equal(data.settings.food.goals.calories, 2210)
    assert.equal(data.settings.food.profile.birthYear, 1996)
    assert.equal(data.settings.food.profile.goal, 'lose')
    assert.match(result.message, /^Daily goal set: 2,210 kcal · P \d+ g · C \d+ g · F \d+ g/)
    assert.match(result.message, /lb/)
    const call = supabase.db.calls.find((item) => item.rpc)
    assert.deepEqual(Object.keys(call.args.p_patch.food).sort(), ['goals', 'profile'])
  })

  test('food_favorite saves from an entry or from numbers, and removes by name', async () => {
    const supabase = fakeSupabase({ tables: { food_entries: [foodRow('e1', USER, {})] } })
    const data = baseData(await loadFoodData(supabase, USER, ctxAt()))
    const fromEntry = await executeFoodTool(supabase, USER, 'food_memory', { action: 'save', entry_id: 'e1', name: 'Morning oats' }, data, ctxAt())
    assert.equal(fromEntry.ok, true, fromEntry.message)
    assert.equal(data.settings.food.favorites[0].name, 'Morning oats')
    assert.equal(data.settings.food.favorites[0].calories, 230)
    assert.equal(data.settings.food.favorites.length, 2)

    const updated = await executeFoodTool(supabase, USER, 'food_memory', { action: 'save', name: 'Protein shake', amount: 1, unit: 'scoop', calories: 130 }, data, ctxAt())
    assert.match(updated.message, /^Updated in My foods/)
    assert.equal(data.settings.food.favorites.length, 2)
    assert.equal(data.settings.food.favorites[0].id, 'fav1') // same favorite, moved to the top

    const removed = await executeFoodTool(supabase, USER, 'food_memory', { action: 'remove', name: 'protein shake' }, data, ctxAt())
    assert.equal(removed.ok, true)
    assert.deepEqual(data.settings.food.favorites.map((fav) => fav.name), ['Morning oats'])
    assert.equal((await executeFoodTool(supabase, USER, 'food_memory', { action: 'save', name: 'Air' }, data, ctxAt())).ok, false)
  })

  test('weight_delete removes that day’s weigh-in', async () => {
    const supabase = fakeSupabase({ tables: { body_weights: [{ id: 'w1', user_id: USER, date: '2026-09-21', kg: 80.2 }, { id: 'w2', user_id: OTHER, date: '2026-09-21', kg: 60 }] } })
    const data = baseData({ body_weights: [{ id: 'w1', date: '2026-09-21', kg: 80.2 }] })
    const result = await executeFoodTool(supabase, USER, 'weight_delete', { date: '2026-09-21' }, data, ctxAt())
    assert.equal(result.ok, true)
    assert.equal(result.message, 'Deleted your weigh-in of 80.2 kg on Mon, Sep 21.')
    assert.deepEqual(supabase.db.tables.body_weights.map((row) => row.id), ['w2'])
    assert.deepEqual(data.body_weights, [])
    assert.equal((await executeFoodTool(supabase, USER, 'weight_delete', { date: '2026-09-21' }, data, ctxAt())).ok, false)
  })

  test('food_day and food_week are lookups with ids and summaries', async () => {
    const supabase = fakeSupabase({ tables: { food_entries: [foodRow('e1', USER, {}), foodRow('e2', USER, { date: '2026-09-22', meal: 'dinner', name: 'Pasta', calories: 650 })] } })
    const data = baseData(await loadFoodData(supabase, USER, ctxAt()))
    const day = await executeFoodTool(supabase, USER, 'food_day', { date: '2026-09-22' }, data, ctxAt())
    assert.equal(day.ok, true)
    assert.equal(day.meals[0].meal, 'Dinner')
    assert.equal(day.meals[0].entries[0].id, 'e2')
    assert.equal(day.totals.kcal, 650)
    const empty = await executeFoodTool(supabase, USER, 'food_day', { date: '2026-09-10' }, data, ctxAt())
    assert.equal(empty.found, false)
    const week = await executeFoodTool(supabase, USER, 'food_week', {}, data, ctxAt())
    assert.equal(week.ok, true)
    assert.equal(week.week.start, '2026-09-21')
    assert.ok(Array.isArray(week.summary) && week.summary.length)
  })
})

describe('foodSnapshot', () => {
  test('compact: today vs goals with entry ids, the week before, usual foods and weight', () => {
    const entries = [
      { id: 'b1', date: TODAY, time: '08:00', meal: 'breakfast', name: 'Oats', amount: 60, unit: 'g', calories: 230, proteinG: 8, carbsG: 40, fatG: 4 },
      { id: 'l1', date: TODAY, time: '13:00', meal: 'lunch', name: 'Chicken wrap', calories: 520, proteinG: 35, carbsG: 50, fatG: 18 },
      { id: 'y1', date: '2026-09-22', meal: 'dinner', name: 'Pasta', calories: 650, proteinG: 20, carbsG: 90, fatG: 15 },
      { id: 'y2', date: '2026-09-20', meal: 'lunch', name: 'Chicken wrap', calories: 520, proteinG: 35, carbsG: 50, fatG: 18 },
    ]
    const bodyWeights = [
      { date: '2026-09-09', kg: 81 }, { date: '2026-09-12', kg: 80.8 }, { date: '2026-09-16', kg: 80.5 },
      { date: '2026-09-19', kg: 80.3 }, { date: '2026-09-22', kg: 80 },
    ]
    const data = baseData({ foodEntries: entries, body_weights: bodyWeights, settings: { ...baseData().settings, gym: { prefs: { unit: 'lb' } } } })
    const snapshot = foodSnapshot(data, ctxAt('14:00'))
    assert.deepEqual(snapshot.goals, { calories: 2000, protein: 150, from: 'manual' })
    assert.equal(snapshot.today.eatenKcal, 750)
    assert.equal(snapshot.today.remainingKcal, 1250)
    assert.equal(snapshot.today.protein, '43 / 150 g')
    assert.equal(snapshot.today.carbs, '90 g')
    assert.deepEqual(snapshot.today.meals.map((meal) => meal.meal), ['Breakfast', 'Lunch'])
    assert.deepEqual(snapshot.today.meals[0].items[0], { id: 'b1', name: 'Oats (60 g)', kcal: 230, time: '08:00' })
    assert.deepEqual(snapshot.last7Days.days.map((day) => day.date), ['Sun 2026-09-20', 'Tue 2026-09-22'])
    assert.equal(snapshot.last7Days.avgKcal, 585)
    assert.equal(snapshot.usualFoods[0], 'Protein shake (1 scoop) 120 kcal ★')
    assert.ok(snapshot.usualFoods.includes('Chicken wrap 520 kcal'))
    assert.match(snapshot.weight.latest, /^176\.4 lb \(yesterday\)$/)
    assert.equal(snapshot.weightUnit, 'lb')
    assert.equal('setup' in snapshot, false)
    assert.ok(JSON.stringify(snapshot).length < 2000)
  })

  test('a missing table and an empty day', () => {
    const snapshot = foodSnapshot(baseData({ foodMissing: true, settings: {} }), ctxAt())
    assert.match(snapshot.setup, /2026-09-27-food\.sql/)
    assert.equal(snapshot.today.nothingLogged, true)
    assert.equal(snapshot.today.eatenKcal, 0)
    assert.equal(snapshot.weightUnit, 'kg')
  })
})

describe('describeFoodAction', () => {
  const data = baseData({
    foodEntries: [{ id: 'e1', date: TODAY, time: '08:00', meal: 'breakfast', name: 'Oats', amount: 60, unit: 'g', calories: 230, proteinG: 8, carbsG: 40, fatG: 4 }],
    body_weights: [{ id: 'w1', date: '2026-09-21', kg: 80.2 }],
  })

  test('crisp labels', () => {
    const ctx = ctxAt('15:30')
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Tea (black)', amount: 240, unit: 'ml', calories: 2 }], meal: 'snack' }, data, ctx), 'Log Tea (black, 240 ml) · 2 kcal → Snacks today')
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Eggs', amount: 2, unit: 'large', calories: 143 }, { name: 'Toast', calories: 80 }], date: '2026-09-22', time: '08:30' }, data, ctx), 'Log Eggs (2 large), Toast · 223 kcal → Breakfast yesterday at 8:30 AM')
    assert.equal(describeFoodAction('food_set_goals', { calories: 2210, protein: 160, carbs: 226, fat: 74 }, data, ctx), 'Set daily goal: 2,210 kcal · P 160 g · C 226 g · F 74 g')
    assert.equal(describeFoodAction('food_set_goals', { calories: 0 }, baseData({ settings: { food: { goals: { calories: 2000 } } } }), ctx), 'Remove the daily calorie goal')
    assert.equal(describeFoodAction('food_update_entry', { id: 'e1', changes: { calories: 310 } }, data, ctx), 'Update Oats (60 g) (Breakfast today): 230 → 310 kcal')
    assert.equal(describeFoodAction('food_update_entry', { id: 'e1', scale: 2 }, data, ctx), 'Update Oats (60 g) (Breakfast today): portion → 120 g, 230 → 460 kcal, P 16 g · C 80 g · F 8 g')
    assert.equal(describeFoodAction('food_update_entry', { id: '$1', changes: { calories: 10 } }, data, ctx), 'Update the food entry just logged')
    assert.equal(describeFoodAction('food_delete_entry', { id: 'e1' }, data, ctx), 'Delete Oats (60 g) · 230 kcal (Breakfast today)')
    assert.equal(describeFoodAction('food_memory', { action: 'save', name: 'Chai', amount: 1, unit: 'cup', calories: 90 }, data, ctx), 'Save to My foods: Chai (1 cup) · 90 kcal (your numbers)')
    assert.equal(describeFoodAction('food_memory', { action: 'remove', name: 'protein shake' }, data, ctx), 'Remove from My foods: Protein shake')
    assert.equal(describeFoodAction('weight_delete', { date: '2026-09-21' }, data, ctx), 'Delete weigh-in: 80.2 kg on Mon, Sep 21')
    assert.equal(describeFoodAction('food_day', { date: '2026-09-22' }, data, ctx), 'Look up food yesterday')
    assert.match(describeFoodAction('food_calculate_goals', { sex: 'female', age: 30, height_cm: 165, weight: 65, activity: 'light', goal: 'lose' }, data, ctx), /^Set daily goal: [\d,]+ kcal · P \d+ g · C \d+ g · F \d+ g · Fiber \d+ g \(lose ~0\.5 kg\/week\)$/)
    assert.equal(describeFoodAction('food_calculate_goals', { goal: 'lose' }, baseData({ settings: {} }), ctx), 'Calculate daily goals (missing: weight, height, birth year)')
  })

  test('portions read in the plural', () => {
    const ctx = ctxAt('15:30')
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Toast', amount: 2, unit: 'slice', calories: 160 }], meal: 'snack' }, data, ctx), 'Log Toast (2 slices) · 160 kcal → Snacks today')
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Chai', amount: 1, unit: 'cup', calories: 90 }], meal: 'snack' }, data, ctx), 'Log Chai (1 cup) · 90 kcal → Snacks today')
  })

  test('drinks keep their alcohol calories', () => {
    const ctx = ctxAt('20:00')
    // Without alcohol_g the macros (3 g protein, 26 g carbs) explain only 116 kcal; the stated 300 stands.
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Beer', amount: 2, unit: 'can', calories: 300, protein_g: 3, carbs_g: 26, fat_g: 0 }] }, data, ctx), 'Log Beer (2 cans) · 300 kcal → Dinner today')
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Red wine', amount: 1, unit: 'glass', calories: 250, protein_g: 0.2, carbs_g: 8, fat_g: 0 }] }, data, ctx), 'Log Red wine (1 glass) · 250 kcal → Dinner today')
    // With alcohol_g the energy check agrees (4·3 + 4·26 + 7·28 = 312).
    assert.equal(describeFoodAction('food_log', { items: [{ name: 'Lager', amount: 2, unit: 'can', calories: 300, protein_g: 3, carbs_g: 26, fat_g: 0, alcohol_g: 28 }] }, data, ctx), 'Log Lager (2 cans) · 300 kcal → Dinner today')
    const withBeer = baseData({ foodEntries: [{ id: 'b1', date: TODAY, time: '20:00', meal: 'dinner', name: 'Beer', amount: 1, unit: 'can', calories: 58, proteinG: 1.5, carbsG: 13, fatG: 0, extra: {} }] })
    assert.equal(describeFoodAction('food_update_entry', { id: 'b1', changes: { alcohol_g: 14 } }, withBeer, ctx), 'Update Beer (1 can) (Dinner today): 58 → 156 kcal, alcohol 14 g')
    assert.equal(checkFoodTool('food_update_entry', { id: 'b1', changes: { alcohol_g: -1 } }, withBeer, ctx).ok, false)
  })

  test('never throws on junk', () => {
    for (const name of FOOD_TOOL_NAMES) {
      assert.equal(typeof describeFoodAction(name, null, {}, {}), 'string')
      assert.equal(typeof describeFoodAction(name, { items: 'x', id: {}, date: 5 }, null, null), 'string')
    }
    assert.equal(typeof describeFoodAction('food_log', { items: [{ name: 'Tea' }] }, data, ctxAt()), 'string')
  })

  test('checkFoodTool validates without writing', () => {
    assert.deepEqual(checkFoodTool('food_log', { items: [{ name: 'Tea', calories: 2 }] }, data, ctxAt()), { ok: true })
    assert.equal(checkFoodTool('food_log', { items: [{ name: 'Tea', calories: 2 }], date: '2026-09-30' }, data, ctxAt()).ok, false)
    assert.deepEqual(checkFoodTool('food_update_entry', { id: '$1', changes: { calories: 3 } }, data, ctxAt()), { ok: true })
    assert.equal(checkFoodTool('food_update_entry', { id: 'e1', changes: {} }, data, ctxAt()).ok, false)
    assert.equal(checkFoodTool('weight_delete', { date: '2026-09-01' }, data, ctxAt()).ok, false)
  })
})

// ---- reminders -------------------------------------------------------------------------------------

describe('reminderPreview and the late all-day reminder (B5)', () => {
  const at = (iso) => Date.parse(iso)
  const prefs = { ...DEFAULT_NOTIFICATIONS }
  const run = (tasks, nowIso, extra = {}) => dueNotifications({ settings: { timeZone: 'UTC', ...extra }, tasks, friends: [], classes: [] }, at(nowIso))

  test('timed task: its time minus the lead, in the user’s zone', () => {
    const task = { id: 't1', text: 'Call mum', date: TODAY, time: '20:00' }
    assert.deepEqual(reminderPreview(task, prefs, 'UTC', at(`${TODAY}T12:00:00Z`)), { at: at(`${TODAY}T19:45:00Z`), label: 'today 7:45 PM', warning: null })
    assert.equal(reminderPreview({ ...task, reminderMinutes: 0 }, prefs, 'UTC', at(`${TODAY}T12:00:00Z`)).label, 'today 8:00 PM')
    // Karachi is UTC+5: 20:00 local − 15 min = 14:45 UTC.
    assert.deepEqual(reminderPreview(task, prefs, 'Asia/Karachi', at(`${TODAY}T10:00:00Z`)), { at: at(`${TODAY}T14:45:00Z`), label: 'today 7:45 PM', warning: null })
    assert.equal(reminderPreview({ ...task, date: '2026-09-24', time: '09:30' }, prefs, 'UTC', at(`${TODAY}T12:00:00Z`)).label, 'tomorrow 9:15 AM')
  })

  test('untimed task added after the all-day time with an explicit reminder gets one ping soon after', () => {
    const created = `${TODAY}T15:00:00Z`
    const task = { id: 't2', text: 'Buy milk', date: TODAY, time: '', created_at: created, reminder_minutes: 0 }
    const preview = reminderPreview(task, prefs, 'UTC', at(created))
    assert.equal(preview.at, at(`${TODAY}T15:01:00Z`))
    assert.equal(preview.label, 'today 3:01 PM')
    assert.match(preview.warning, /9:00 AM, which has passed/)
    // A task being proposed (no created_at yet) is treated as created now.
    assert.equal(reminderPreview({ date: TODAY, text: 'x', reminderMinutes: 0 }, prefs, 'UTC', at(created)).label, 'today 3:01 PM')

    const due = run([task], `${TODAY}T15:02:00Z`)
    assert.equal(due.length, 1)
    assert.equal(due[0].key, `task:t2:${TODAY}:allday:day`) // the all-day key: never twice
    assert.equal(due[0].body, 'Due today')
    assert.equal(due[0].batch, 'late-allday')
    assert.deepEqual(run([task], `${TODAY}T14:59:00Z`), [])
    assert.deepEqual(run([task], `${TODAY}T16:00:00Z`), []) // outside the send window

    // Unchanged: created before the all-day time → reminded at 9:00.
    const early = { ...task, id: 't3', created_at: `${TODAY}T07:00:00Z` }
    assert.equal(run([early], `${TODAY}T09:05:00Z`)[0].key, `task:t3:${TODAY}:allday:day`)
    assert.equal(run([early], `${TODAY}T09:05:00Z`)[0].batch, undefined)
    assert.deepEqual(run([early], `${TODAY}T15:02:00Z`), [])
    // An explicit "day before" reminder on a task for tomorrow, added in the afternoon → pinged then.
    const before = { ...task, id: 't5', date: '2026-09-24', reminder_minutes: 1440 }
    assert.equal(run([before], `${TODAY}T15:02:00Z`)[0].body, 'Due tomorrow')
  })

  test('plain quick-adds after the all-day time never ping (no burst for tasks just typed)', () => {
    // Five tasks added through "+ Add to today" at 2 PM: no reminder, only the evening nudge.
    const quick = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, text: `Item ${i}`, date: TODAY, time: '', created_at: `${TODAY}T14:00:${String(i * 10).padStart(2, '0')}Z` }))
    assert.deepEqual(run(quick, `${TODAY}T14:02:00Z`), [])
    assert.deepEqual(run(quick, `${TODAY}T14:30:00Z`), [])
    const evening = run(quick, `${TODAY}T18:00:00Z`)
    assert.deepEqual(evening.map((item) => item.key), [`overdue:${TODAY}`])
    assert.equal(evening[0].body, 'Still open: Item 0, Item 1, Item 2 +2 more · Tomorrow: nothing planned yet')
    // Also within the send window of the 9:00 reminder: a task typed at 9:10 isn't pinged at 9:11.
    const morning = { id: 'q9', text: 'Morning add', date: TODAY, created_at: `${TODAY}T09:10:00Z` }
    assert.deepEqual(run([morning], `${TODAY}T09:11:00Z`), [])
    const preview = reminderPreview(morning, prefs, 'UTC', at(`${TODAY}T09:10:00Z`))
    assert.equal(preview.at, null)
    assert.match(preview.warning, /^no reminder will fire \(all-day reminders go at 9:00 AM, which had passed when it was added; give it a time/)
    // Catch-up tasks the app adds on open don't ping either.
    const catchUp = { id: 't4', text: 'Talk to Ali', date: TODAY, created_at: `${TODAY}T15:00:00Z`, details: `friend-reminder:f1:${TODAY}` }
    assert.deepEqual(run([catchUp], `${TODAY}T15:02:00Z`), [])
    // "Day before" mode by default: a plain task for tomorrow added in the afternoon isn't pinged now.
    const tomorrow = { id: 'q10', text: 'Plain', date: '2026-09-24', created_at: `${TODAY}T15:00:00Z` }
    assert.deepEqual(run([tomorrow], `${TODAY}T15:02:00Z`, { notifications: { allDayMode: 'before' } }), [])
    assert.match(reminderPreview(tomorrow, { allDayMode: 'before' }, 'UTC', at(`${TODAY}T15:00:00Z`)).warning, /9:00 AM the day before, which had passed/)
    // Added long before its date: the normal reminder on the day.
    assert.equal(run([tomorrow], '2026-09-24T09:01:00Z')[0].key, 'task:q10:2026-09-24:allday:day')
  })

  test('late explicit reminders added together go out as one notification', () => {
    const task = (id, text, second, extra = {}) => ({ id, text, date: TODAY, created_at: `${TODAY}T15:00:${second}Z`, reminder_minutes: 0, ...extra })
    const a = task('a', 'Buy milk', '10')
    const b = task('b', 'Pay rent', '40')
    const c = task('c', 'Call Ali', '50', { priority: 'urgent' })
    // At 15:01:45 a and b are due but c (fires 15:01:50) is still pending: both are held back.
    assert.deepEqual(run([a, b, c], `${TODAY}T15:01:45Z`), [])
    const due = run([a, b, c], `${TODAY}T15:02:00Z`)
    assert.deepEqual(due.map((item) => item.key), ['a', 'b', 'c'].map((id) => `task:${id}:${TODAY}:allday:day`))
    const groups = groupDue([...due, { key: 'summary', title: 'Your day', body: 'x' }])
    assert.deepEqual(groups.map((group) => group.length), [3, 1])
    assert.deepEqual(combineReminders(groups[0]), { title: '3 tasks due today', body: 'Buy milk, Pay rent, Urgent: Call Ali', url: '/#/tasks', tag: 'late-allday' })
    // One claimed item is sent as it is (tapping it opens that task); mixed days and long lists read naturally.
    assert.deepEqual(combineReminders([due[0]]), { title: 'Buy milk', body: 'Due today', url: '/#/tasks/a', tag: 'task-a' })
    assert.equal(run([task('x y/z', 'Odd id', '00', { created_at: `${TODAY}T14:50:00Z` })], `${TODAY}T15:00:00Z`)[0].url, '/#/tasks/x%20y%2Fz')
    const many = [...due, { ...due[0], title: 'D', body: 'Due tomorrow' }, { ...due[0], title: 'E' }]
    assert.deepEqual(combineReminders(many), { title: '5 tasks coming up', body: 'Buy milk, Pay rent, Urgent: Call Ali and 2 more', url: '/#/tasks', tag: 'late-allday' })
    // A pending task doesn't hold back reminders due for more than a few minutes.
    const old = task('o', 'Old', '00', { created_at: `${TODAY}T14:50:00Z` })
    const fresh = task('f', 'Fresh', '00', { created_at: `${TODAY}T14:59:30Z` })
    assert.deepEqual(run([old, fresh], `${TODAY}T15:00:00Z`).map((item) => item.key), [`task:o:${TODAY}:allday:day`])
  })

  test('the morning summary comes every day, a clear one included', () => {
    const classes = [
      { id: 'c1', name: 'ECON 1022', days: [{ day: 'Wed', time: '2:30 PM - 4:30 PM' }, { day: 'Wed', time: '4:30 PM - 5:30 PM' }] },
      { id: 'c2', name: 'CS 3331', days: ['Wed'], day_details: { Wed: { time: '11:30 AM - 1:30 PM' } } },
      { id: 'c3', name: 'Old course', days: ['Wed'], end_date: '2026-09-01' },
    ]
    const summary = (tasks, extra = {}) => dueNotifications({ settings: { timeZone: 'UTC' }, tasks, friends: [], classes: [], ...extra }, at(`${TODAY}T08:00:00Z`)).find((item) => item.tag === 'daily-summary')
    assert.deepEqual(summary([]), { key: `summary:${TODAY}`, fireAt: at(`${TODAY}T08:00:00Z`), title: 'Your Wednesday', body: 'Nothing planned. A clear day.', url: '/#/today', tag: 'daily-summary' })
    const tasks = [
      { id: 'a', text: 'Essay', date: TODAY, time: '' },
      { id: 'b', text: 'Call mom', date: TODAY, time: '19:00' },
      { id: 'c', text: 'Rent', date: '2026-09-20' },
    ]
    assert.equal(summary(tasks, { classes }).body, '2 tasks: Call mom (7:00 PM), Essay · 1 overdue · 2 classes from 11:30 AM')
    assert.equal(summary([], { classes: [classes[0]] }).body, 'ECON 1022 at 2:30 PM')
    assert.equal(summary([], { friends: [{ id: 'f', name: 'Ali', birthday: '2000-09-24' }] }).body, '🎂 Ali’s birthday tomorrow')
    // Turned off: nothing.
    assert.equal(dueNotifications({ settings: { timeZone: 'UTC', notifications: { dailySummary: false } }, tasks: [], friends: [], classes: [] }, at(`${TODAY}T08:00:00Z`)).length, 0)
  })

  test('the evening check-in recaps today and looks at tomorrow, every day', () => {
    const evening = (tasks, extra = {}) => dueNotifications({ settings: { timeZone: 'UTC' }, tasks, friends: [], classes: [], ...extra }, at(`${TODAY}T18:00:00Z`)).find((item) => item.tag === 'evening-nudge')
    const quiet = evening([])
    assert.equal(quiet.title, 'Evening check-in')
    assert.equal(quiet.body, 'Tomorrow: nothing planned yet')
    assert.equal(quiet.url, '/#/today')
    const done = [
      { id: 'a', text: 'Essay', date: TODAY, done: true },
      { id: 'b', text: 'Gym', date: TODAY, done: true },
      { id: 'c', text: 'Dentist', date: '2026-09-24', time: '11:30' },
      { id: 'd', text: 'Groceries', date: '2026-09-24' },
    ]
    const classes = [{ id: 'c1', name: 'ECON 1022', days: [{ day: 'Thu', time: '2:30 PM - 4:30 PM' }] }]
    assert.deepEqual(evening(done, { classes }), {
      key: `overdue:${TODAY}`, fireAt: at(`${TODAY}T18:00:00Z`), title: 'Evening check-in',
      body: 'All 2 done today ✓ · Tomorrow: 2 tasks (first 11:30 AM), ECON 1022 at 2:30 PM', url: '/#/today', tag: 'evening-nudge',
    })
    const mixed = evening([...done, { id: 'e', text: 'Read', date: TODAY, time: '21:00' }, { id: 'f', text: 'Old', date: '2026-09-20' }])
    assert.equal(mixed.title, 'Before the day ends')
    assert.equal(mixed.body, '2 of 3 done · Still open: Read (9:00 PM) · 1 overdue · Tomorrow: 2 tasks (first 11:30 AM)')
    assert.equal(mixed.url, '/#/tasks')
  })

  test('quiet hours move the reminder and say so', () => {
    const quiet = { ...prefs, quietHours: true, quietStart: '22:00', quietEnd: '07:00' }
    const task = { id: 't6', text: 'Late call', date: TODAY, time: '23:30' }
    const preview = reminderPreview(task, quiet, 'UTC', at(`${TODAY}T12:00:00Z`))
    assert.equal(preview.label, 'tomorrow 7:00 AM')
    assert.match(preview.warning, /quiet hours/)
    // A late all-day task pushed past its day by quiet hours gets no ping.
    const lateNight = { id: 't7', text: 'Pack', date: TODAY, created_at: `${TODAY}T23:00:00Z` }
    assert.equal(reminderPreview(lateNight, quiet, 'UTC', at(`${TODAY}T23:00:00Z`)).at, null)
    assert.deepEqual(dueNotifications({ settings: { timeZone: 'UTC', notifications: quiet }, tasks: [lateNight], friends: [], classes: [] }, at('2026-09-24T07:01:00Z')), [])
  })

  test('passed, off, and undated', () => {
    const now = at(`${TODAY}T15:00:00Z`)
    const old = { id: 't8', text: 'Pay rent', date: TODAY, created_at: '2026-09-20T10:00:00Z' }
    assert.deepEqual(reminderPreview(old, prefs, 'UTC', now), { at: null, label: null, warning: 'no reminder will fire (all-day reminders go at 9:00 AM, which has passed)' })
    assert.match(reminderPreview({ id: 't9', text: 'x', date: TODAY, time: '10:00' }, prefs, 'UTC', now).warning, /have passed/)
    assert.match(reminderPreview({ id: 't10', text: 'x', date: '2026-09-24', time: '10:00', reminderMinutes: 1440 }, prefs, 'UTC', now).warning, /reminder time, today 10:00 AM, has passed/)
    // Just past but within the send window: the next run sends it.
    const soon = reminderPreview({ id: 't11', text: 'x', date: TODAY, time: '15:10' }, prefs, 'UTC', now)
    assert.deepEqual(soon, { at: now, label: 'today 3:00 PM', warning: null })
    assert.match(reminderPreview({ text: 'x' }, prefs, 'UTC', now).warning, /no date/)
    assert.match(reminderPreview({ text: 'x', date: TODAY, time: '20:00', reminder_minutes: -1 }, prefs, 'UTC', now).warning, /turned off/)
    assert.match(reminderPreview({ text: 'x', date: TODAY }, { allDayTime: '' }, 'UTC', now).warning, /all-day reminders are off/)
    assert.deepEqual(reminderPreview({ text: 'x', date: TODAY, done: true }, prefs, 'UTC', now), { at: null, label: null, warning: null })
    assert.equal(reminderPreview({ text: 'x', date: TODAY, time: '20:00' }, prefs, 'Not/AZone', now).label, 'today 7:45 PM')
  })

  test('notification defaults match the app’s copy', () => {
    const block = (file) => {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      const body = text.slice(text.indexOf('export const DEFAULT_NOTIFICATIONS = {'))
      return Object.fromEntries([...body.slice(0, body.indexOf('\n}')).matchAll(/^\s+(\w+): ([^,\n]+),/gm)].map((match) => [match[1], match[2].trim()]))
    }
    const server = block('../api/_reminders.js')
    assert.deepEqual(block('../src/lib/notifications.js'), server)
    assert.equal(Object.keys(server).length, Object.keys(DEFAULT_NOTIFICATIONS).length)
  })
})

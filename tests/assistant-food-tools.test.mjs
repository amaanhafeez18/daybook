// The assistant's newer food tools: copying entries, the profile, meals in the prefs, saturated fat
// and the My foods link on an entry. Run with `node --test tests/`.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetSettingsRpcMemo } from '../api/_settings.js'
import { FOOD_TOOL_DEFS, FOOD_TOOL_NAMES, checkFoodTool, describeFoodAction, executeFoodTool, loadFoodData } from '../api/_food-tools.js'
import { mergeSettings } from '../api/_settings.js'

// ---- a small in-memory stand-in for the Supabase client (as in assistant-modules.test.mjs) ---------

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
const YESTERDAY = '2026-09-22'
const USER = 'user-a'
const OTHER = 'user-b'
const ctxAt = (localTime = '08:15', localDate = TODAY) => ({ localDate, localTime, weekday: 'Wed', timeZone: 'UTC', location: null })

function foodRow(id, userId, fields) {
  return {
    id, user_id: userId, date: TODAY, time: '08:00', meal: 'breakfast', name: 'Oats', brand: null, amount: 60, unit: 'g', grams: 60,
    calories: 230, protein_g: 8, carbs_g: 40, fat_g: 4, fiber_g: 6, sugar_g: 1, sodium_mg: 5, extra: {}, note: null,
    source: 'manual', favorite_id: null, ai: null, created_at: `${TODAY}T08:00:00Z`, ...fields,
  }
}

const SETTINGS = () => ({
  food: {
    goals: { calories: 2000, protein: 150, source: 'calculator' },
    profile: { sex: 'male', birthYear: 1996, heightCm: 180, activity: 'moderate', goal: 'lose', rateKgPerWeek: 0.5, targetKg: 78 },
    prefs: { energyUnit: 'kcal', meals: [{ id: 'breakfast', name: 'Breakfast' }, { id: 'lunch', name: 'Lunch' }, { id: 'dinner', name: 'Dinner' }, { id: 'snack', name: 'Snacks' }] },
    favorites: [{ id: 'fav1', name: 'Protein shake', amount: 1, unit: 'scoop', calories: 120, proteinG: 24, extra: { satFatG: 1.5 } }],
  },
  gym: { prefs: { unit: 'kg' } },
})

// Yesterday's breakfast (2 items) and lunch, plus one entry today.
const ROWS = () => [
  foodRow('y-eggs', USER, { date: YESTERDAY, time: '08:10', name: 'Scrambled eggs', amount: 2, unit: 'large', grams: 100, calories: 180, protein_g: 12, carbs_g: 1, fat_g: 14, extra: { satFatG: 4 }, favorite_id: null }),
  foodRow('y-toast', USER, { date: YESTERDAY, time: '08:12', name: 'Toast', amount: 2, unit: 'slice', grams: 60, calories: 160, protein_g: 5, carbs_g: 30, fat_g: 2, note: 'wholemeal' }),
  foodRow('y-rice', USER, { date: YESTERDAY, time: '13:00', meal: 'lunch', name: 'Chicken rice', calories: 650, protein_g: 45, carbs_g: 70, fat_g: 15 }),
  foodRow('t-oats', USER, { date: TODAY, time: '07:30', name: 'Oats', calories: 230, favorite_id: 'fav1' }),
  foodRow('theirs', OTHER, { date: YESTERDAY, name: 'Their eggs', calories: 999 }),
]

async function setup({ rows = ROWS(), settings = SETTINGS(), rpc = 'ok' } = {}) {
  const supabase = fakeSupabase({ tables: { food_entries: rows, settings: [{ id: 's1', user_id: USER, value: settings, created_at: '2026-09-01T00:00:00Z' }] }, rpc })
  const loaded = await loadFoodData(supabase, USER, ctxAt())
  const data = { settings: structuredClone(settings), settingsRow: null, body_weights: [{ id: 'w1', date: YESTERDAY, kg: 80 }], ...loaded }
  return { supabase, data }
}

const savedSettings = (supabase) => supabase.db.tables.settings.find((row) => row.user_id === USER).value
const entries = (supabase) => supabase.db.tables.food_entries

describe('tool definitions', () => {
  test('the new tools are defined, non-strict, and carry sat_fat_g and favorite_id', () => {
    for (const name of ['food_copy_entries', 'food_update_profile', 'food_update_prefs']) assert.ok(FOOD_TOOL_NAMES.includes(name), name)
    const byName = Object.fromEntries(FOOD_TOOL_DEFS.map((def) => [def.name, def]))
    for (const name of ['food_log', 'food_update_entry', 'food_memory']) {
      const props = name === 'food_log' ? byName[name].parameters.properties.items.items.properties : name === 'food_update_entry' ? byName[name].parameters.properties.changes.properties : byName[name].parameters.properties
      assert.ok(props.sat_fat_g, `${name} takes sat_fat_g`)
    }
    assert.ok(byName.food_update_entry.parameters.properties.changes.properties.favorite_id)
    assert.ok(byName.food_update_entry.parameters.properties.changes.properties.brand)
    for (const key of ['meals', 'add_meal', 'remove_meal', 'rename_meal', 'rename_meals', 'move_to', 'energy_unit', 'ring', 'week_start', 'nutrients', 'ai_review', 'show_details']) assert.ok(byName.food_update_prefs.parameters.properties[key], key)
    for (const key of ['entry_ids', 'from_date', 'from_meal', 'to_date', 'to_meal']) assert.ok(byName.food_copy_entries.parameters.properties[key], key)
    for (const def of FOOD_TOOL_DEFS) {
      assert.equal(def.strict, false)
      for (const key of def.parameters.required || []) assert.ok(def.parameters.properties[key], `${def.name}: required ${key}`)
    }
  })
})

describe('sat_fat_g', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('food_log stores it in extra, clamped; food_update_entry changes it; food_memory keeps it', async () => {
    const { supabase, data } = await setup()
    const logged = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'Butter', amount: 10, unit: 'g', calories: 72, fat_g: 8, sat_fat_g: 5.26 }, { name: 'Lard', calories: 900, fat_g: 100, sat_fat_g: 9999 }] }, data, ctxAt())
    assert.equal(logged.ok, true, logged.message)
    assert.deepEqual(entries(supabase).find((row) => row.name === 'Butter').extra, { satFatG: 5.3 })
    assert.equal(entries(supabase).find((row) => row.name === 'Lard').extra.satFatG, 500)

    const changed = await executeFoodTool(supabase, USER, 'food_update_entry', { id: logged.id, changes: { sat_fat_g: 6 } }, data, ctxAt())
    assert.equal(changed.ok, true, changed.message)
    assert.match(changed.message, /sat fat 6 g/)
    assert.deepEqual(entries(supabase).find((row) => row.id === logged.id).extra, { satFatG: 6 })
    const cleared = await executeFoodTool(supabase, USER, 'food_update_entry', { id: logged.id, changes: { sat_fat_g: null } }, data, ctxAt())
    assert.equal(cleared.ok, true)
    assert.deepEqual(entries(supabase).find((row) => row.id === logged.id).extra, {})
    assert.equal(checkFoodTool('food_update_entry', { id: logged.id, changes: { sat_fat_g: -2 } }, data, ctxAt()).ok, false)

    const saved = await executeFoodTool(supabase, USER, 'food_memory', { action: 'save', name: 'Cheddar', amount: 30, unit: 'g', calories: 120, protein_g: 7, fat_g: 10, sat_fat_g: 6.3, source: 'label' }, data, ctxAt())
    assert.equal(saved.ok, true, saved.message)
    assert.equal(data.settings.food.favorites.find((fav) => fav.id === saved.id).extra.satFatG, 6.3)
    const found = await executeFoodTool(supabase, USER, 'food_memory_find', { query: 'cheddar' }, data, ctxAt())
    assert.equal(found.foods[0].sat_fat_g, 6.3)
    // A saved food's sat fat scales with the servings eaten.
    const shake = await executeFoodTool(supabase, USER, 'food_log', { items: [{ name: 'shake', saved_food_id: 'fav1', servings: 2 }] }, data, ctxAt())
    assert.equal(entries(supabase).find((row) => row.id === shake.id).extra.satFatG, 3)
  })
})

describe('food_update_entry: brand and the My foods link', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('unlinks with null, links to a saved food by id, refuses unknown ids', async () => {
    const { supabase, data } = await setup()
    assert.equal(describeFoodAction('food_update_entry', { id: 't-oats', changes: { favorite_id: null } }, data, ctxAt()), 'Update Oats (60 g) (Breakfast today): unlinked from My foods')
    const unlinked = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 't-oats', changes: { favorite_id: null, brand: 'Quaker' } }, data, ctxAt())
    assert.equal(unlinked.ok, true, unlinked.message)
    const row = entries(supabase).find((item) => item.id === 't-oats')
    assert.equal(row.favorite_id, null)
    assert.equal(row.brand, 'Quaker')
    assert.match(unlinked.message, /brand → Quaker, unlinked from My foods/)
    const linked = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'y-eggs', changes: { favorite_id: 'fav1' } }, data, ctxAt())
    assert.equal(linked.ok, true, linked.message)
    assert.equal(entries(supabase).find((item) => item.id === 'y-eggs').favorite_id, 'fav1')
    assert.match(linked.message, /linked to My foods: Protein shake/)
    const bad = await executeFoodTool(supabase, USER, 'food_update_entry', { id: 'y-eggs', changes: { favorite_id: 'nope' } }, data, ctxAt())
    assert.equal(bad.ok, false)
    assert.match(bad.message, /No saved food with id "nope"/)
    // Already unlinked: nothing to change.
    assert.equal(checkFoodTool('food_update_entry', { id: 't-oats', changes: { favorite_id: null } }, data, ctxAt()).ok, false)
  })
})

describe('food_copy_entries', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('copies yesterday’s breakfast to today as new rows with the same numbers', async () => {
    const { supabase, data } = await setup()
    const args = { from_date: YESTERDAY, from_meal: 'breakfast' }
    assert.deepEqual(checkFoodTool('food_copy_entries', args, data, ctxAt()), { ok: true })
    assert.equal(describeFoodAction('food_copy_entries', args, data, ctxAt()), 'Copy Scrambled eggs (2 large), Toast (2 slices) from yesterday’s Breakfast → today (same meals) · 340 kcal')
    const before = entries(supabase).length
    const result = await executeFoodTool(supabase, USER, 'food_copy_entries', args, data, ctxAt('09:00'))
    assert.equal(result.ok, true, result.message)
    assert.equal(result.ids.length, 2)
    assert.equal(result.id, result.ids[0])
    assert.equal(entries(supabase).length, before + 2)
    const eggs = entries(supabase).find((row) => row.id === result.ids[0])
    assert.equal(eggs.user_id, USER)
    assert.equal(eggs.date, TODAY)
    assert.equal(eggs.meal, 'breakfast')
    assert.equal(eggs.time, '08:10', 'the original time is kept')
    assert.equal(eggs.calories, 180)
    assert.equal(eggs.protein_g, 12)
    assert.deepEqual(eggs.extra, { satFatG: 4 })
    assert.equal(eggs.source, 'copy')
    assert.equal(eggs.ai, null)
    assert.notEqual(eggs.id, 'y-eggs')
    assert.match(eggs.id, /^[0-9a-f-]{36}$/)
    assert.equal(entries(supabase).find((row) => row.id === result.ids[1]).note, 'wholemeal')
    // The originals are untouched, and the day line reflects the copies.
    assert.equal(entries(supabase).find((row) => row.id === 'y-eggs').date, YESTERDAY)
    assert.equal(data.foodEntries.filter((entry) => entry.date === TODAY).length, 3)
    assert.match(result.message, /^Copied Scrambled eggs \(2 large\), Toast \(2 slices\) from yesterday’s Breakfast → today \(same meals\) · 340 kcal\. Today: 570 \/ 2,000 kcal \(1,430 left\)\.$/)
  })

  test('by ids, into another meal and day; the label counts many items', async () => {
    const { supabase, data } = await setup()
    const args = { entry_ids: ['y-rice', 'y-toast'], to_meal: 'Dinner' }
    assert.equal(describeFoodAction('food_copy_entries', args, data, ctxAt()), 'Copy Chicken rice (60 g), Toast (2 slices) from yesterday → Dinner today · 810 kcal')
    const result = await executeFoodTool(supabase, USER, 'food_copy_entries', args, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    const copies = entries(supabase).filter((row) => result.ids.includes(row.id))
    assert.deepEqual(copies.map((row) => row.meal), ['dinner', 'dinner'])
    assert.deepEqual(copies.map((row) => row.date), [TODAY, TODAY])
    // A whole day to an earlier day: up to three items are listed in full, more become "N items (…)".
    const many = { from_date: YESTERDAY, to_date: '2026-09-20' }
    assert.equal(describeFoodAction('food_copy_entries', many, data, ctxAt()), 'Copy Scrambled eggs (2 large), Toast (2 slices), Chicken rice (60 g) from yesterday → Sun, Sep 20 (same meals) · 990 kcal')
    const six = { from_date: TODAY, to_date: '2026-09-20' }
    assert.equal(describeFoodAction('food_copy_entries', six, data, ctxAt()), 'Copy Chicken rice (60 g), Toast (2 slices), Oats (60 g) from today → Sun, Sep 20 (same meals) · 1,040 kcal')
    assert.equal((await executeFoodTool(supabase, USER, 'food_copy_entries', { from_date: YESTERDAY }, data, ctxAt())).ids.length, 3)
    assert.match(describeFoodAction('food_copy_entries', six, data, ctxAt()), /^Copy 6 items \(Scrambled eggs, Toast, Chicken rice, …\) from today → Sun, Sep 20 \(same meals\) · 2,030 kcal$/)
    const dated = await executeFoodTool(supabase, USER, 'food_copy_entries', many, data, ctxAt())
    assert.equal(dated.ok, true, dated.message)
    assert.equal(dated.ids.length, 3)
    assert.match(dated.message, /^Copied .* from yesterday → Sun, Sep 20 \(same meals\) · 990 kcal\. Sun, Sep 20: 990 \/ 2,000 kcal/)
    assert.ok(entries(supabase).filter((row) => row.date === '2026-09-20').every((row) => row.source === 'copy'))
  })

  test('refuses unknown ids, empty days, future days, same-day duplicates and bad meals; staged refs pass the check', async () => {
    const { supabase, data } = await setup()
    const bad = [
      [{ entry_ids: ['nope'] }, /No food entry with id "nope"/],
      [{ entry_ids: ['theirs'] }, /No food entry with id "theirs"/],
      [{ from_date: '2026-09-21' }, /Nothing logged on Mon, Sep 21/],
      [{ from_date: YESTERDAY, from_meal: 'dinner' }, /Nothing logged for Dinner yesterday/],
      [{ from_date: '2026-09-30' }, /future/],
      [{ to_date: '2026-09-30' }, /today or earlier/],
      [{ from_date: TODAY }, /same entries twice/],
      [{ from_date: TODAY, to_meal: 'breakfast' }, /same entries twice/],
      [{ from_date: YESTERDAY, from_meal: 'elevenses' }, /Unknown meal "elevenses"/],
      [{ from_date: YESTERDAY, to_meal: 'tea' }, /Unknown meal "tea"/],
      [{ from_date: 'yesterday' }, /YYYY-MM-DD/],
    ]
    const count = entries(supabase).length
    for (const [args, message] of bad) {
      const result = await executeFoodTool(supabase, USER, 'food_copy_entries', args, data, ctxAt())
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.match(result.message, message, JSON.stringify(args))
      assert.equal(checkFoodTool('food_copy_entries', args, data, ctxAt()).ok, false, JSON.stringify(args))
      assert.equal(typeof describeFoodAction('food_copy_entries', args, data, ctxAt()), 'string')
    }
    assert.equal(entries(supabase).length, count)
    // Same day into a different meal is a real request ("I had the same for dinner").
    assert.equal(checkFoodTool('food_copy_entries', { from_date: TODAY, from_meal: 'breakfast', to_meal: 'dinner' }, data, ctxAt()).ok, true)
    // A ref to an entry staged earlier in the turn is checked when it runs; the label stays generic.
    assert.deepEqual(checkFoodTool('food_copy_entries', { entry_ids: ['$1'], to_meal: 'snack' }, data, ctxAt()), { ok: true })
    assert.equal(describeFoodAction('food_copy_entries', { entry_ids: ['$1'], to_meal: 'snack' }, data, ctxAt()), 'Copy food entries → Snacks today')
    // A day older than the loaded window is fetched when the call runs.
    supabase.db.tables.food_entries.push(foodRow('old', USER, { date: '2026-06-01', name: 'Old soup', calories: 100 }))
    assert.deepEqual(checkFoodTool('food_copy_entries', { from_date: '2026-06-01' }, data, ctxAt()), { ok: true })
    const old = await executeFoodTool(supabase, USER, 'food_copy_entries', { from_date: '2026-06-01', to_meal: 'lunch' }, data, ctxAt())
    assert.equal(old.ok, true, old.message)
    assert.equal(entries(supabase).find((row) => row.id === old.id).name, 'Old soup')
    // An id not in memory is looked up (only the user's own rows).
    const byOld = await executeFoodTool(supabase, USER, 'food_copy_entries', { entry_ids: ['old'], to_meal: 'snack' }, data, ctxAt())
    assert.equal(byOld.ok, true, byOld.message)
  })

  test('without the food table explains the migration; a dry-run client only changes memory', async () => {
    const { data } = await setup()
    const missing = fakeSupabase({ missingTables: ['food_entries'] })
    const result = await executeFoodTool(missing, USER, 'food_copy_entries', { from_date: YESTERDAY }, data, ctxAt())
    assert.equal(result.ok, false)
    assert.match(result.message, /2026-09-27-food\.sql/)
    assert.equal(data.foodMissing, true)
    assert.equal(checkFoodTool('food_copy_entries', { from_date: YESTERDAY }, data, ctxAt()).ok, false)
  })
})

describe('food_update_profile', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('updates the profile fields only; goals stay as they were', async () => {
    const { supabase, data } = await setup()
    const args = { target_weight: 75, activity: 'active' }
    assert.equal(describeFoodAction('food_update_profile', args, data, ctxAt()), 'Update food profile: activity active, target 75 kg')
    assert.deepEqual(checkFoodTool('food_update_profile', args, data, ctxAt()), { ok: true })
    const result = await executeFoodTool(supabase, USER, 'food_update_profile', args, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /^Updated their food profile: activity active, target 75 kg\. Daily goals unchanged \(they were calculated/)
    const saved = savedSettings(supabase).food
    assert.deepEqual(saved.profile, { sex: 'male', birthYear: 1996, heightCm: 180, activity: 'active', goal: 'lose', rateKgPerWeek: 0.5, targetKg: 75 })
    assert.deepEqual(saved.goals, { calories: 2000, protein: 150, source: 'calculator' }, 'goals untouched')
    assert.equal(saved.favorites.length, 1)
    assert.equal(data.settings.food.profile.targetKg, 75)
    const call = supabase.db.calls.find((item) => item.rpc)
    assert.deepEqual(Object.keys(call.args.p_patch.food), ['profile'])
  })

  test('age, sex, height, goal (pace reset), pace, body fat; null clears target and body fat; lb unit', async () => {
    const settings = SETTINGS()
    settings.gym.prefs.unit = 'lb'
    settings.food.goals.source = 'manual'
    const { supabase, data } = await setup({ settings })
    const result = await executeFoodTool(supabase, USER, 'food_update_profile', { age: 40, sex: 'female', height_cm: 165.55, goal: 'gain', body_fat_pct: 22.44, target_weight: null }, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    const profile = savedSettings(supabase).food.profile
    assert.equal(profile.birthYear, 1986)
    assert.equal(profile.sex, 'female')
    assert.equal(profile.heightCm, 165.6)
    assert.equal(profile.goal, 'gain')
    assert.equal('rateKgPerWeek' in profile, false, 'a pace saved for losing is dropped with a new goal')
    assert.equal(profile.bodyFatPct, 22.4)
    assert.equal(profile.targetKg, null)
    assert.match(result.message, /born 1986, height 165.6 cm, goal gain, no target weight, body fat 22.4%/)
    // Weights and pace arrive in lb.
    const pace = await executeFoodTool(supabase, USER, 'food_update_profile', { rate_per_week: 1.1, target_weight: 154.3 }, data, ctxAt())
    assert.equal(pace.ok, true, pace.message)
    assert.equal(Math.round(savedSettings(supabase).food.profile.rateKgPerWeek * 100) / 100, 0.5)
    assert.equal(savedSettings(supabase).food.profile.targetKg, 69.99)
    assert.match(pace.message, /pace 1.1 lb\/week, target 154.3 lb/)
    const cleared = await executeFoodTool(supabase, USER, 'food_update_profile', { body_fat_pct: 0 }, data, ctxAt())
    assert.equal(cleared.ok, true)
    assert.equal(savedSettings(supabase).food.profile.bodyFatPct, null)
    // Without calculated goals the message doesn't suggest recalculating.
    assert.doesNotMatch(cleared.message, /calculated from/i)
  })

  test('refuses nothing, junk and no-op changes', async () => {
    const { supabase, data } = await setup()
    for (const args of [{}, { sex: 'other' }, { age: 3 }, { birth_year: 1800 }, { height_cm: 20 }, { activity: 'couch' }, { goal: 'shred' }, { rate_per_week: 9 }, { target_weight: 5 }, { body_fat_pct: 90 }, { activity: 'moderate' }, { target_weight: 78 }]) {
      const result = await executeFoodTool(supabase, USER, 'food_update_profile', args, data, ctxAt())
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.equal(typeof result.message, 'string')
      assert.equal(checkFoodTool('food_update_profile', args, data, ctxAt()).ok, false, JSON.stringify(args))
    }
    assert.equal(describeFoodAction('food_update_profile', { goal: 'shred' }, data, ctxAt()), 'Update food profile')
    assert.equal(supabase.db.calls.some((call) => call.rpc), false)
    // Staging: only memory changes.
    const dry = Object.assign(fakeSupabase(), { dryRun: true })
    const staged = await executeFoodTool(dry, USER, 'food_update_profile', { goal: 'maintain' }, data, ctxAt())
    assert.equal(staged.ok, true)
    assert.equal(data.settings.food.profile.goal, 'maintain')
    assert.deepEqual(dry.db.calls, [])
  })
})

describe('food_update_prefs', () => {
  beforeEach(() => {
    resetSettingsRpcMemo()
    quietWarnings()
  })
  afterEach(() => restoreWarn?.())

  test('display settings as before, written whole through patch_settings', async () => {
    const { supabase, data } = await setup()
    const result = await executeFoodTool(supabase, USER, 'food_update_prefs', { energy_unit: 'kJ', ring: 'eaten', week_start: 0, nutrients: ['fiber', 'protein'], ai_review: 'autoHigh', show_details: true }, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    assert.equal(result.message, 'Updated your food settings: energy in kJ, the ring shows calories eaten, weeks start on Sun, nutrients shown: protein, fiber, confident AI estimates are logged straight away, protein, carbs and fat always shown when adding food.')
    const prefs = savedSettings(supabase).food.prefs
    assert.equal(prefs.energyUnit, 'kJ')
    assert.equal(prefs.weekStart, 0)
    assert.deepEqual(prefs.nutrients, ['protein', 'fiber'])
    assert.equal(prefs.meals.length, 4, 'meals kept')
    assert.equal(savedSettings(supabase).food.favorites.length, 1, 'favorites survive')
    assert.equal(data.settings.food.prefs.ring, 'eaten')
    // Already like that: a no-op, not a card.
    const again = await executeFoodTool(supabase, USER, 'food_update_prefs', { energy_unit: 'kJ' }, data, ctxAt())
    assert.equal(again.ok, true)
    assert.equal(again.noop, true)
    assert.equal(checkFoodTool('food_update_prefs', { energy_unit: 'kJ' }, data, ctxAt()).ok, false)
    for (const args of [{}, { energy_unit: 'cal' }, { ring: 'both' }, { week_start: 2 }, { nutrients: ['vitamin c'] }, { nutrients: 'protein' }, { ai_review: 'never' }]) {
      assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', args, data, ctxAt())).ok, false, JSON.stringify(args))
      assert.equal(checkFoodTool('food_update_prefs', args, data, ctxAt()).ok, false, JSON.stringify(args))
    }
  })

  test('meals replaces the list in order, keeping ids by id or name and creating new ones', async () => {
    const { supabase, data } = await setup()
    const args = { meals: [{ name: 'Breakfast' }, { id: 'lunch', name: 'Midday' }, { name: 'Pre-workout' }, { name: 'dinner' }, { name: 'Snacks' }] }
    assert.equal(describeFoodAction('food_update_prefs', args, data, ctxAt()), 'Meals: Breakfast, Midday, Pre-workout, dinner, Snacks')
    assert.deepEqual(checkFoodTool('food_update_prefs', args, data, ctxAt()), { ok: true })
    const result = await executeFoodTool(supabase, USER, 'food_update_prefs', args, data, ctxAt())
    assert.equal(result.ok, true, result.message)
    const meals = savedSettings(supabase).food.prefs.meals
    assert.deepEqual(meals.map((meal) => meal.name), ['Breakfast', 'Midday', 'Pre-workout', 'dinner', 'Snacks'])
    assert.deepEqual([meals[0].id, meals[1].id, meals[3].id, meals[4].id], ['breakfast', 'lunch', 'dinner', 'snack'])
    assert.match(meals[2].id, /^meal-[0-9a-z]+$/)
    assert.equal(data.settings.food.prefs.meals[2].id, meals[2].id)
    assert.equal(savedSettings(supabase).food.prefs.energyUnit, 'kcal', 'other prefs kept')
    // Renaming through the list: an id keeps the meal (a new name alone would make a new meal); plain strings work.
    const renamed = await executeFoodTool(supabase, USER, 'food_update_prefs', { meals: ['Breakfast', { id: 'lunch', name: 'Lunch' }, 'Pre-workout', 'Dinner', 'Snacks'] }, data, ctxAt())
    assert.equal(renamed.ok, true, renamed.message)
    assert.deepEqual(savedSettings(supabase).food.prefs.meals.map((meal) => meal.id).slice(0, 2), ['breakfast', 'lunch'])
    assert.equal(savedSettings(supabase).food.prefs.meals[2].id, meals[2].id, 'the new meal keeps the id it got')
    assert.equal(savedSettings(supabase).food.prefs.meals[3].name, 'Dinner')
    assert.match(renamed.message, /Midday renamed to Lunch/)
    // The same list again changes nothing.
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { meals: ['Breakfast', 'Lunch', 'Pre-workout', 'Dinner', 'Snacks'] }, data, ctxAt())).noop, true)
    for (const args of [{ meals: ['A', 'B'] }, { meals: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }, { meals: 'Breakfast' }, { meals: [{ name: '' }, 'B', 'C'] }, { meals: ['Lunch', 'lunch', 'Dinner'] }]) {
      assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', args, data, ctxAt())).ok, false, JSON.stringify(args))
    }
  })

  test('add, remove (moving today’s entries) and rename one meal', async () => {
    const { supabase, data } = await setup()
    const added = await executeFoodTool(supabase, USER, 'food_update_prefs', { add_meal: { name: 'Pre-workout', position: 3 } }, data, ctxAt())
    assert.equal(added.ok, true, added.message)
    assert.deepEqual(savedSettings(supabase).food.prefs.meals.map((meal) => meal.name), ['Breakfast', 'Lunch', 'Pre-workout', 'Dinner', 'Snacks'])
    assert.equal(added.message, 'Updated your food settings: meals: Breakfast, Lunch, Pre-workout, Dinner, Snacks.')
    const atEnd = await executeFoodTool(supabase, USER, 'food_update_prefs', { add_meal: { name: 'Supper' } }, data, ctxAt())
    assert.equal(atEnd.ok, true, atEnd.message)
    assert.equal(savedSettings(supabase).food.prefs.meals.at(-1).name, 'Supper')
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { add_meal: { name: 'Brunch' } }, data, ctxAt())).ok, false, 'six is the most')
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'Supper' }, add_meal: { name: 'lunch' } }, data, ctxAt())).ok, false, 'duplicate name')

    // Breakfast has an entry today: removing it needs move_to.
    const refused = await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'breakfast' } }, data, ctxAt())
    assert.equal(refused.ok, false)
    assert.match(refused.message, /Breakfast has 1 entry today\. Pass move_to/)
    assert.equal(checkFoodTool('food_update_prefs', { remove_meal: { name: 'breakfast' } }, data, ctxAt()).ok, false)
    assert.equal(checkFoodTool('food_update_prefs', { remove_meal: { name: 'breakfast', move_to: 'Nope' } }, data, ctxAt()).ok, false)
    const moveArgs = { remove_meal: { name: 'Breakfast', move_to: 'Pre-workout' } }
    assert.equal(describeFoodAction('food_update_prefs', moveArgs, data, ctxAt()), 'Meals: Lunch, Pre-workout, Dinner, Snacks, Supper (moving 1 of today’s entries to Pre-workout)')
    const removed = await executeFoodTool(supabase, USER, 'food_update_prefs', moveArgs, data, ctxAt())
    assert.equal(removed.ok, true, removed.message)
    const meals = savedSettings(supabase).food.prefs.meals
    assert.deepEqual(meals.map((meal) => meal.name), ['Lunch', 'Pre-workout', 'Dinner', 'Snacks', 'Supper'])
    const preWorkout = meals.find((meal) => meal.name === 'Pre-workout').id
    assert.equal(entries(supabase).find((row) => row.id === 't-oats').meal, preWorkout)
    assert.equal(entries(supabase).find((row) => row.id === 'y-eggs').meal, 'breakfast', 'yesterday is left alone')
    assert.equal(data.foodEntries.find((entry) => entry.id === 't-oats').meal, preWorkout)
    const move = supabase.db.calls.find((call) => call.op === 'update' && call.table === 'food_entries')
    assert.ok(move.filters.some(([, column, value]) => column === 'user_id' && value === USER))
    // A meal without entries today just goes; the list can't drop below three.
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'Supper' } }, data, ctxAt())).ok, true)
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'snacks' } }, data, ctxAt())).ok, true)
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'Dinner' } }, data, ctxAt())).ok, false, 'at least three')
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { remove_meal: { name: 'Elevenses' } }, data, ctxAt())).ok, false)

    // Renames, both shapes.
    const rename = await executeFoodTool(supabase, USER, 'food_update_prefs', { rename_meal: { name: 'Pre-workout', new_name: 'Pre-gym' } }, data, ctxAt())
    assert.equal(rename.ok, true, rename.message)
    assert.equal(rename.message, 'Updated your food settings: Pre-workout renamed to Pre-gym.')
    assert.equal(savedSettings(supabase).food.prefs.meals.find((meal) => meal.id === preWorkout).name, 'Pre-gym')
    const renames = await executeFoodTool(supabase, USER, 'food_update_prefs', { rename_meals: [{ meal: 'lunch', name: 'Midday' }] }, data, ctxAt())
    assert.equal(renames.ok, true, renames.message)
    assert.equal(savedSettings(supabase).food.prefs.meals.find((meal) => meal.id === 'lunch').name, 'Midday')
    assert.equal(describeFoodAction('food_update_prefs', { rename_meal: { name: 'Dinner', new_name: 'Tea' }, energy_unit: 'kJ' }, data, ctxAt()), 'Energy in kJ · Dinner renamed to Tea')
    assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', { rename_meals: [{ meal: 'Midday', name: 'Midday' }] }, data, ctxAt())).noop, true)
    for (const args of [{ rename_meal: { name: 'Nope', new_name: 'X' } }, { rename_meal: { name: 'Dinner', new_name: '' } }, { rename_meal: { name: 'Dinner', new_name: 'midday' } }, { rename_meals: 'Dinner' }, { rename_meals: [{ meal: 'Dinner' }] }]) {
      assert.equal((await executeFoodTool(supabase, USER, 'food_update_prefs', args, data, ctxAt())).ok, false, JSON.stringify(args))
    }
  })

  test('replacing the list while a removed meal has entries today needs move_to; the fallback write path works', async () => {
    const { supabase, data } = await setup({ rpc: 'missing' })
    const refused = await executeFoodTool(supabase, USER, 'food_update_prefs', { meals: ['Lunch', 'Dinner', 'Snacks'] }, data, ctxAt())
    assert.equal(refused.ok, false)
    assert.match(refused.message, /Breakfast has 1 entry today/)
    const moved = await executeFoodTool(supabase, USER, 'food_update_prefs', { meals: ['Lunch', 'Dinner', 'Snacks'], move_to: 'Snacks' }, data, ctxAt())
    assert.equal(moved.ok, true, moved.message)
    assert.equal(entries(supabase).find((row) => row.id === 't-oats').meal, 'snack')
    assert.deepEqual(savedSettings(supabase).food.prefs.meals, [{ id: 'lunch', name: 'Lunch' }, { id: 'dinner', name: 'Dinner' }, { id: 'snack', name: 'Snacks' }])
    assert.equal(savedSettings(supabase).food.goals.calories, 2000)
  })

  test('never throws on junk', () => {
    const { data } = { data: { settings: SETTINGS(), foodEntries: [], foodMissing: false, body_weights: [] } }
    for (const name of ['food_copy_entries', 'food_update_profile', 'food_update_prefs']) {
      for (const args of [null, {}, { meals: 5, entry_ids: {}, add_meal: 'x', remove_meal: [], rename_meal: 1, target_weight: 'heavy', to_date: 7 }]) {
        assert.equal(typeof describeFoodAction(name, args, data, ctxAt()), 'string')
        assert.equal(typeof describeFoodAction(name, args, {}, {}), 'string')
        assert.equal(typeof checkFoodTool(name, args, data, ctxAt()).ok, 'boolean')
      }
    }
  })
})

// Food tracker tools for the assistant: tool schemas, a compact snapshot, authoritative labels for
// proposals, and execution. Entries live in food_entries (one row per food eaten); goals, profile,
// prefs and favorites in settings.food; body weight is the gym's body_weights table.
// Files starting with "_" are not deployed as their own serverless functions.
import { randomUUID } from 'crypto'
import {
  ACTIVITY_LEVELS, FAVORITES_MAX, amountText, calcGoals, clampEstimateItem, dayTotals, energyInUnit, entryCalories, entryMeal, entryTemplate,
  findFavorite, foodKey, formatEnergy, logStreak, macroCalories, mealForTime, mealTotals, normalizeFood, recents, remaining,
  scaleEntry, weeklyInsights, weightTrend,
} from '../src/lib/food/nutrition.js'
import { mergeSettings, patchSettingsAtomic } from './_settings.js'

const LOAD_DAYS = 60
const LOAD_LIMIT = 3000
const MAX_ITEMS = 20
const LB_PER_KG = 2.2046226218
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FOOD_MISSING = 'Food logging isn’t set up yet: the database needs updating (run supabase/migrations/2026-09-27-food.sql in Supabase). Nothing was saved.'
const WEIGHT_MISSING = 'The body-weight table isn’t set up yet: run the gym migration (supabase/migrations/2026-09-26-gym.sql) in Supabase.'
const MISSING_COLUMN = /Could not find the '([^']+)' column/

// Numeric entry fields: client name, column, tool argument name, upper limit, decimals.
const NUMBER_FIELDS = [
  ['amount', 'amount', 'amount', 10000, 2],
  ['grams', 'grams', 'grams', 20000, 1],
  ['calories', 'calories', 'calories', 10000, 0],
  ['proteinG', 'protein_g', 'protein_g', 2000, 1],
  ['carbsG', 'carbs_g', 'carbs_g', 2000, 1],
  ['fatG', 'fat_g', 'fat_g', 2000, 1],
  ['fiberG', 'fiber_g', 'fiber_g', 500, 1],
  ['sugarG', 'sugar_g', 'sugar_g', 2000, 1],
  ['sodiumMg', 'sodium_mg', 'sodium_mg', 50000, 0],
]
const MACRO_FIELDS = new Set(['proteinG', 'carbsG', 'fatG', 'fiberG', 'alcoholG'])

// ---- small helpers ------------------------------------------------------------------------------

const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
const nowIso = () => new Date().toISOString()
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function round(value, digits = 0) {
  const factor = 10 ** digits
  const out = Math.round(value * factor) / factor
  return Object.is(out, -0) ? 0 : out
}

function groupInt(value) {
  const n = Math.round(Math.abs(value))
  const digits = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return value < 0 && n !== 0 ? `−${digits}` : digits
}

// 'HH:MM' from 'H:MM' / 'HH:MM', else null.
function hhmm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

function addDays(iso, delta) {
  const date = new Date(`${iso}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

function todayOf(ctx) {
  return isIsoDate(ctx?.localDate) ? ctx.localDate : new Date().toISOString().slice(0, 10)
}

// 'today', 'yesterday', 'tomorrow' or 'Mon, Sep 21'.
function dayLabel(date, today) {
  if (!isIsoDate(date)) return 'that day'
  if (date === today) return 'today'
  if (date === addDays(today, -1)) return 'yesterday'
  if (date === addDays(today, 1)) return 'tomorrow'
  const day = new Date(`${date}T12:00:00Z`)
  const year = date.slice(0, 4) !== String(today).slice(0, 4) ? ` ${date.slice(0, 4)}` : ''
  return `${DAY_NAMES[day.getUTCDay()]}, ${MONTH_NAMES[day.getUTCMonth()]} ${day.getUTCDate()}${year}`
}

const onDay = (date, today) => {
  const label = dayLabel(date, today)
  return /^(today|yesterday|tomorrow)$/.test(label) ? label : `on ${label}`
}

function clock(time) {
  const value = hhmm(time)
  if (!value) return ''
  const [hour, minute] = value.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== null && value !== undefined && !(Array.isArray(value) && !value.length)))
}

function isMissingTable(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  const message = String(error.message || '')
  if (MISSING_COLUMN.test(message)) return false
  return /Could not find the table|relation .* does not exist/i.test(message)
}

// Runs a write, dropping columns the live database doesn't have yet (a migration not yet run) and
// retrying, like api/data.js. run(value) gets the rows (or patch) without those columns.
async function tolerant(run, value) {
  const dropped = new Set()
  const strip = (item) => Object.fromEntries(Object.entries(item).filter(([key]) => !dropped.has(key)))
  let current = value
  let { error } = await run(current)
  while (error) {
    const missing = MISSING_COLUMN.exec(error.message || '')
    if (!missing || dropped.has(missing[1]) || dropped.size >= 5) break
    dropped.add(missing[1])
    current = Array.isArray(value) ? value.map(strip) : strip(value)
    ;({ error } = await run(current))
  }
  if (error) throw error
}

// ---- user data ----------------------------------------------------------------------------------

const foodOf = (data) => normalizeFood(data?.settings?.food)
const entriesOf = (data) => (Array.isArray(data?.foodEntries) ? data.foodEntries : [])
const weightsOf = (data) => (Array.isArray(data?.body_weights) ? data.body_weights : [])
const unitOf = (data) => ((data?.gym?.prefs?.unit || data?.settings?.gym?.prefs?.unit) === 'lb' ? 'lb' : 'kg')
const toUnit = (kg, unit) => (unit === 'lb' ? kg * LB_PER_KG : kg)
const fromUnit = (value, unit) => (unit === 'lb' ? value / LB_PER_KG : value)
const fmtWeight = (kg, unit) => `${round(toUnit(kg, unit), 1)} ${unit}`

function signedWeight(kg, unit) {
  const value = round(toUnit(kg, unit), 1)
  return value === 0 ? `0 ${unit}` : `${value > 0 ? '+' : '−'}${Math.abs(value)} ${unit}`
}

// food_entries row → the app's entry shape (camelCase, numbers coerced).
function rowToEntry(row) {
  if (!isObj(row) || row.id === undefined || row.id === null || typeof row.date !== 'string') return null
  const entry = {
    id: row.id,
    date: row.date,
    time: typeof row.time === 'string' && row.time ? row.time : null,
    meal: typeof row.meal === 'string' && row.meal ? row.meal : null,
    name: typeof row.name === 'string' ? row.name : null,
    brand: typeof row.brand === 'string' && row.brand ? row.brand : null,
    unit: typeof row.unit === 'string' && row.unit ? row.unit : null,
  }
  for (const [field, column] of NUMBER_FIELDS) entry[field] = num(row[column] ?? row[field])
  entry.extra = isObj(row.extra) ? row.extra : {}
  entry.note = typeof row.note === 'string' && row.note ? row.note : null
  entry.source = typeof row.source === 'string' && row.source ? row.source : 'manual'
  entry.favoriteId = row.favorite_id ?? row.favoriteId ?? null
  entry.ai = isObj(row.ai) ? row.ai : null
  entry.createdAt = row.created_at ?? row.createdAt ?? null
  return entry
}

function entryToRow(entry, userId) {
  const row = {
    id: String(entry.id),
    user_id: userId,
    date: entry.date,
    time: entry.time || null,
    meal: entry.meal || null,
    name: entry.name || null,
    brand: entry.brand || null,
    unit: entry.unit || null,
  }
  for (const [field, column] of NUMBER_FIELDS) row[column] = num(entry[field])
  row.extra = isObj(entry.extra) ? entry.extra : {}
  row.note = entry.note || null
  row.source = entry.source || 'assistant'
  row.favorite_id = entry.favoriteId ?? null
  row.ai = isObj(entry.ai) ? entry.ai : null
  row.created_at = entry.createdAt || nowIso()
  return row
}

function mergeEntries(data, extra) {
  const known = new Set(entriesOf(data).map((entry) => String(entry.id)))
  const added = extra.filter((entry) => !known.has(String(entry.id)))
  if (added.length) data.foodEntries = [...entriesOf(data), ...added]
}

// Rows of one date or a date range straight from the database (older than what loadFoodData read).
async function fetchEntries(supabase, userId, from, to) {
  const { data: rows, error } = await supabase.from('food_entries').select('*').eq('user_id', userId)
    .gte('date', from).lte('date', to).order('date', { ascending: false }).limit(LOAD_LIMIT)
  if (error) throw error
  return (rows || []).map(rowToEntry).filter(Boolean)
}

// An entry by id: in memory, else the database (only the user's own rows).
async function findEntry(supabase, userId, data, id) {
  const key = String(id ?? '')
  if (!key) return null
  const known = entriesOf(data).find((entry) => String(entry.id) === key)
  if (known) return known
  const { data: rows, error } = await supabase.from('food_entries').select('*').eq('id', key).eq('user_id', userId).limit(1)
  if (error) {
    if (isMissingTable(error)) return null
    throw error
  }
  const entry = rowToEntry(rows?.[0])
  if (entry) mergeEntries(data, [entry])
  return entry
}

// Settings changed through patch_settings (or its fallback), mirrored in memory for later tools. A
// dry-run client (the assistant staging a proposal: supabase.dryRun) only changes the in-memory copy.
async function writeFood(supabase, userId, data, foodPatch) {
  const patch = { food: foodPatch }
  const merged = supabase?.dryRun ? null : await patchSettingsAtomic(supabase, userId, patch)
  const value = isObj(merged) ? merged : mergeSettings(data.settings, patch)
  data.settings = value
  if (isObj(data.settingsRow)) data.settingsRow = { ...data.settingsRow, value }
  return value
}

function latestWeightKg(data, today) {
  let best = null
  for (const entry of weightsOf(data)) {
    const kg = num(entry?.kg)
    if (!isIsoDate(entry?.date) || entry.date > today || kg === null || kg <= 0) continue
    if (!best || entry.date > best.date) best = { date: entry.date, kg }
  }
  return best
}

// ---- labels -------------------------------------------------------------------------------------

// '2 slices', '240 ml', '60 g'.
function portionText(entry) {
  const amount = num(entry.amount)
  const grams = num(entry.grams)
  if (amount !== null && amount > 0) return amountText(amount, entry.unit)
  if (grams !== null && grams > 0) return `${round(grams, 0)} g`
  return ''
}

// 'Tea (black, 240 ml)', 'Protein bar (Grenade, 60 g)', 'Oats'.
function itemLabel(entry) {
  const name = clean(entry.name, 120) || 'Quick add'
  const brand = clean(entry.brand, 60)
  const details = [brand && !name.toLowerCase().includes(brand.toLowerCase()) ? brand : '', portionText(entry)].filter(Boolean)
  if (!details.length) return name
  if (/\)$/.test(name)) return name.replace(/\)$/, `, ${details.join(', ')})`)
  return `${name} (${details.join(', ')})`
}

function mealName(id, meals) {
  const meal = meals.find((item) => item.id === entryMeal({ meal: id }, meals))
  return meal ? meal.name : 'Snacks'
}

const MEAL_SYNONYMS = { supper: 'dinner', brunch: 'breakfast', lunchtime: 'lunch', snacks: 'snack', dessert: 'snack', 'pre workout': 'snack', 'post workout': 'snack' }

// A meal id from an id or name ("Snacks", "dinner", "supper"), else null.
function resolveMeal(value, meals) {
  const wanted = clean(String(value ?? ''), 40).toLowerCase().replace(/[-_]/g, ' ')
  if (!wanted) return null
  const direct = meals.find((meal) => meal.id.toLowerCase() === wanted || meal.name.toLowerCase() === wanted)
  if (direct) return direct.id
  const singular = wanted.replace(/s$/, '')
  const loose = meals.find((meal) => meal.id.toLowerCase() === singular || meal.name.toLowerCase().replace(/s$/, '') === singular)
  if (loose) return loose.id
  const synonym = MEAL_SYNONYMS[wanted]
  return synonym && meals.some((meal) => meal.id === synonym) ? synonym : null
}

const energy = (kcal, unit) => formatEnergy(kcal, unit)
const energyNumber = (kcal, unit) => groupInt(energyInUnit(kcal, unit) ?? 0)

function goalParts(goals, unit) {
  const parts = []
  if (goals.calories) parts.push(energy(goals.calories, unit))
  if (goals.protein) parts.push(`P ${groupInt(goals.protein)} g`)
  if (goals.carbs) parts.push(`C ${groupInt(goals.carbs)} g`)
  if (goals.fat) parts.push(`F ${groupInt(goals.fat)} g`)
  if (goals.fiber) parts.push(`Fiber ${groupInt(goals.fiber)} g`)
  return parts
}

// "Today: 1,240 / 2,210 kcal (970 left)".
function dayLine(data, date, today) {
  const food = foodOf(data)
  const unit = food.prefs.energyUnit
  const totals = dayTotals(entriesOf(data).filter((entry) => entry.date === date))
  const day = dayLabel(date, today)
  const title = day.charAt(0).toUpperCase() + day.slice(1)
  const goal = food.goals.calories
  if (!goal) return `${title}: ${energy(totals.calories, unit)}.`
  const left = goal - totals.calories
  return `${title}: ${energyNumber(totals.calories, unit)} / ${energy(goal, unit)} (${left >= 0 ? `${energyNumber(left, unit)} left` : `${energyNumber(-left, unit)} over`}).`
}

// ---- plans (pure: validate and work out what a tool would write) -------------------------------

const fail = (message) => ({ ok: false, message })
const isRef = (value) => typeof value === 'string' && /^\$\d+$/.test(value)
const ALCOHOLIC = /\b(beers?|lagers?|ales?|stouts?|porters?|ipa|pilsners?|ciders?|wines?|ros[eé]|prosecco|champagne|cava|vodka|whiske?y|bourbon|scotch|rum|gin|tequila|mezcal|brandy|cognac|sake|soju|liqueurs?|cocktails?|margaritas?|mojitos?|martinis?|negronis?|spritz|sangria|mimosas?|daiquiris?|hard seltzers?|shandy|shots? of)\b/i

function planLog(args, data, ctx) {
  const today = todayOf(ctx)
  const food = foodOf(data)
  const { meals } = food.prefs
  const date = args.date ? args.date : today
  if (!isIsoDate(date)) return { error: 'Dates must be YYYY-MM-DD.' }
  if (date > today) return { error: 'Food can only be logged for today or earlier.' }
  let time = null
  if (args.time) {
    time = hhmm(args.time)
    if (!time) return { error: 'Times must be 24-hour HH:MM.' }
  } else if (date === today) {
    time = hhmm(ctx?.localTime)
  }
  let meal = null
  if (args.meal) {
    meal = resolveMeal(args.meal, meals)
    if (!meal) return { error: `Unknown meal "${args.meal}". Use one of: ${meals.map((item) => item.id).join(', ')}.` }
  } else {
    meal = entryMeal({ meal: time ? mealForTime(time) : 'snack' }, meals)
  }
  const items = Array.isArray(args.items) ? args.items.filter(isObj) : []
  if (!items.length) return { error: 'Nothing to log: pass items, each with a name and calories.' }
  if (items.length > MAX_ITEMS) return { error: `Log at most ${MAX_ITEMS} items at once.` }
  const note = clean(args.note, 1000) || null
  const rows = []
  for (const item of items) {
    const name = clean(item.name, 80)
    // The energy check recomputes calories from the macros when they disagree. A drink's alcohol
    // (7 kcal/g) is missing from those macros unless alcohol_g is given, so then the stated calories stand.
    const boozy = num(item.alcohol_g) === null && ALCOHOLIC.test(name)
    const locked = item.user_calories === true || boozy ? ['calories'] : []
    const clamped = clampEstimateItem({ ...item, name: name || 'Quick add', locked, options: [], assumptions: [] })
    if (clamped.calories === null) return { error: `Estimate the calories for "${name || 'each item'}" (kcal for the amount eaten) and try again.` }
    const extra = {}
    if (clamped.extra.alcoholG !== null) extra.alcoholG = clamped.extra.alcoholG
    if (clamped.extra.caffeineMg !== null) extra.caffeineMg = clamped.extra.caffeineMg
    const favorite = findFavorite(food.favorites, { name: clamped.name, brand: clamped.brand })
    rows.push({
      date, time, meal,
      name: clamped.name, brand: clamped.brand, amount: clamped.amount, unit: clamped.unit, grams: clamped.grams,
      calories: clamped.calories, proteinG: clamped.proteinG, carbsG: clamped.carbsG, fatG: clamped.fatG,
      fiberG: clamped.fiberG, sugarG: clamped.sugarG, sodiumMg: clamped.sodiumMg,
      extra, note, source: 'assistant', favoriteId: favorite ? String(favorite.id) : null, ai: null,
    })
  }
  return { rows, date, time, meal, food }
}

// Field names the update tool accepts (both the tool's snake_case and the app's camelCase).
const TEXT_CHANGES = { name: ['name', 120], brand: ['brand', 80], unit: ['unit', 24], note: ['note', 1000] }
const EXTRA_CHANGES = { alcohol_g: ['alcoholG', 1000, 1], caffeine_mg: ['caffeineMg', 5000, 0] }

function planUpdate(args, data, ctx, entry) {
  const today = todayOf(ctx)
  const food = foodOf(data)
  const { meals } = food.prefs
  const changes = isObj(args.changes) ? args.changes : {}
  const scale = args.scale === undefined || args.scale === null ? null : num(args.scale)
  if (args.scale !== undefined && args.scale !== null && (scale === null || scale <= 0 || scale > 20)) return { error: 'scale must be a number between 0 and 20 (e.g. 2 for double, 0.5 for half).' }
  if (!Object.keys(changes).length && scale === null) return { error: 'Nothing to change: pass changes or scale.' }

  let next = scale !== null ? scaleEntry(entry, scale) : { ...entry }
  const given = new Set()
  for (const [field, [key, max]] of Object.entries(TEXT_CHANGES)) {
    if (changes[key] === undefined) continue
    const value = clean(String(changes[key] ?? ''), max)
    if (field === 'name' && !value) return { error: 'A food entry needs a name.' }
    next[field] = value || null
    given.add(field)
  }
  for (const [field, , arg, max, digits] of NUMBER_FIELDS) {
    const raw = changes[arg] !== undefined ? changes[arg] : changes[field]
    if (raw === undefined) continue
    if (raw === null || raw === '') {
      if (field === 'calories') return { error: 'Calories can’t be removed; pass the new number.' }
      next[field] = null
    } else {
      const value = num(raw)
      if (value === null || value < 0) return { error: `${arg} must be a number of 0 or more.` }
      next[field] = round(Math.min(value, max), digits)
    }
    given.add(field)
  }
  // Alcohol and caffeine live in extra.
  for (const [arg, [key, max, digits]] of Object.entries(EXTRA_CHANGES)) {
    const raw = changes[arg] !== undefined ? changes[arg] : changes[key]
    if (raw === undefined) continue
    const extra = { ...(isObj(next.extra) ? next.extra : {}) }
    if (raw === null || raw === '' || num(raw) === 0) delete extra[key]
    else {
      const value = num(raw)
      if (value === null || value < 0) return { error: `${arg} must be a number of 0 or more.` }
      extra[key] = round(Math.min(value, max), digits)
    }
    next.extra = extra
    given.add(key)
  }
  if (changes.date !== undefined) {
    if (!isIsoDate(changes.date)) return { error: 'Dates must be YYYY-MM-DD.' }
    if (changes.date > today) return { error: 'Food can only be logged for today or earlier.' }
    next.date = changes.date
  }
  if (changes.time !== undefined) {
    if (changes.time === '' || changes.time === null) next.time = null
    else {
      const time = hhmm(changes.time)
      if (!time) return { error: 'Times must be 24-hour HH:MM.' }
      next.time = time
    }
  }
  if (changes.meal !== undefined) {
    const meal = resolveMeal(changes.meal, meals)
    if (!meal) return { error: `Unknown meal "${changes.meal}". Use one of: ${meals.map((item) => item.id).join(', ')}.` }
    next.meal = meal
  }
  // New macros without new calories: calories follow the macros.
  if (scale === null && !given.has('calories') && [...given].some((field) => MACRO_FIELDS.has(field))) {
    const fromMacros = num(next.proteinG) !== null && num(next.carbsG) !== null && num(next.fatG) !== null ? macroCalories(next) : null
    if (fromMacros !== null) next.calories = Math.round(fromMacros)
  }
  next = { ...next, id: entry.id, createdAt: entry.createdAt }

  const diff = []
  const same = (a, b) => (a ?? null) === (b ?? null) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const unit = food.prefs.energyUnit
  if (!same(next.name, entry.name)) diff.push(`name → ${next.name}`)
  if (!same(next.brand, entry.brand)) diff.push(next.brand ? `brand → ${next.brand}` : 'no brand')
  if (!same(next.amount, entry.amount) || !same(next.unit, entry.unit) || !same(next.grams, entry.grams)) diff.push(`portion → ${portionText(next) || '—'}`)
  if (!same(next.calories, entry.calories)) diff.push(`${energyNumber(entryCalories(entry), unit)} → ${energy(next.calories, unit)}`)
  const macroDiff = [['proteinG', 'P'], ['carbsG', 'C'], ['fatG', 'F'], ['fiberG', 'fiber']]
    .filter(([field]) => !same(next[field], entry[field]))
    .map(([field, short]) => `${short} ${next[field] === null ? '—' : `${round(next[field], 1)} g`}`)
  if (macroDiff.length) diff.push(macroDiff.join(' · '))
  if (!same(next.sugarG, entry.sugarG)) diff.push(`sugar ${next.sugarG === null ? '—' : `${round(next.sugarG, 1)} g`}`)
  if (!same(next.sodiumMg, entry.sodiumMg)) diff.push(`sodium ${next.sodiumMg === null ? '—' : `${round(next.sodiumMg, 0)} mg`}`)
  const extraOf = (row, key) => (isObj(row.extra) && num(row.extra[key]) !== null ? num(row.extra[key]) : null)
  for (const [key, label, suffix] of [['alcoholG', 'alcohol', 'g'], ['caffeineMg', 'caffeine', 'mg']]) {
    if (given.has(key) && !same(extraOf(next, key), extraOf(entry, key))) diff.push(`${label} ${extraOf(next, key) === null ? '—' : `${extraOf(next, key)} ${suffix}`}`)
  }
  if (!same(next.meal, entry.meal)) diff.push(`move to ${mealName(next.meal, meals)}`)
  if (!same(next.date, entry.date)) diff.push(`date → ${dayLabel(next.date, today)}`)
  if (!same(next.time, entry.time)) diff.push(next.time ? `time → ${clock(next.time)}` : 'no time')
  if (!same(next.note, entry.note)) diff.push(next.note ? 'note updated' : 'note removed')
  if (!diff.length) return { error: 'That wouldn’t change anything.' }
  return { next, diff }
}

const GOAL_LIMITS = { calories: [500, 10000], protein: [1, 1000], carbs: [1, 2000], fat: [1, 1000], fiber: [1, 300] }

function planGoals(args, data) {
  const food = foodOf(data)
  const raw = isObj(data?.settings?.food?.goals) ? data.settings.food.goals : {}
  const goals = { ...raw }
  const set = []
  const cleared = []
  for (const [key, [min, max]] of Object.entries(GOAL_LIMITS)) {
    if (args[key] === undefined) continue
    if (args[key] === null || args[key] === '' || num(args[key]) === 0) {
      goals[key] = null
      cleared.push(key)
      continue
    }
    const value = num(args[key])
    if (value === null || value < min || value > max) return { error: `${key} goal must be between ${min} and ${groupInt(max)}${key === 'calories' ? ' kcal' : ' g'} (0 removes it).` }
    goals[key] = Math.round(value)
    set.push(key)
  }
  if (!set.length && !cleared.length) return { error: 'Pass at least one goal: calories, protein, carbs, fat or fiber.' }
  goals.source = 'manual'
  const next = normalizeFood({ ...(isObj(data?.settings?.food) ? data.settings.food : {}), goals }).goals
  let note = ''
  if (next.calories && next.protein && next.carbs && next.fat) {
    const fromMacros = 4 * next.protein + 4 * next.carbs + 9 * next.fat
    if (Math.abs(fromMacros - next.calories) > 0.1 * next.calories) note = `Those macros add up to about ${energy(fromMacros, food.prefs.energyUnit)}, not ${energy(next.calories, food.prefs.energyUnit)}.`
  }
  return { goals, next, set, cleared, note }
}

const ACTIVITY_ALIASES = {
  sedentary: 'sedentary', inactive: 'sedentary', 'desk job': 'sedentary',
  light: 'light', 'lightly active': 'light', lightly: 'light',
  moderate: 'moderate', 'moderately active': 'moderate', moderately: 'moderate',
  active: 'active', 'very active': 'active',
  very: 'very', 'extremely active': 'very', extreme: 'very', 'extra active': 'very', athlete: 'very',
}

function planCalculate(args, data, ctx) {
  const today = todayOf(ctx)
  const unit = unitOf(data)
  const saved = isObj(data?.settings?.food?.profile) ? data.settings.food.profile : {}
  const profile = { ...saved }
  const year = Number(today.slice(0, 4))
  if (args.sex !== undefined && args.sex !== null && args.sex !== '') {
    const sex = String(args.sex).toLowerCase()
    if (!['male', 'female', 'm', 'f', 'man', 'woman'].includes(sex)) return { error: 'sex must be male or female (leave it out if they’d rather not say).' }
    profile.sex = ['male', 'm', 'man'].includes(sex) ? 'male' : 'female'
  }
  if (args.birth_year !== undefined || args.age !== undefined) {
    const birthYear = args.birth_year !== undefined ? num(args.birth_year) : num(args.age) === null ? null : year - num(args.age)
    if (birthYear === null || birthYear < year - 110 || birthYear > year - 10) return { error: 'That age or birth year doesn’t look right.' }
    profile.birthYear = Math.round(birthYear)
  }
  if (args.height_cm !== undefined) {
    const height = num(args.height_cm)
    if (height === null || height < 100 || height > 250) return { error: 'height_cm must be between 100 and 250 (1 in = 2.54 cm).' }
    profile.heightCm = round(height, 1)
  }
  let weightKg = null
  if (args.weight !== undefined && args.weight !== null && args.weight !== '') {
    const weight = num(args.weight)
    weightKg = weight === null ? null : fromUnit(weight, unit)
    if (weightKg === null || weightKg < 25 || weightKg > 400) return { error: `weight (in ${unit}) doesn’t look right.` }
  }
  if (args.activity !== undefined) {
    const activity = ACTIVITY_ALIASES[String(args.activity).toLowerCase().replace(/[-_]/g, ' ').trim()]
    if (!activity) return { error: `activity must be one of: ${ACTIVITY_LEVELS.map((level) => level.id).join(', ')}.` }
    profile.activity = activity
  }
  if (args.goal !== undefined) {
    const goal = String(args.goal).toLowerCase()
    const mapped = { maintain: 'maintain', maintenance: 'maintain', lose: 'lose', cut: 'lose', gain: 'gain', bulk: 'gain' }[goal]
    if (!mapped) return { error: 'goal must be maintain, lose or gain.' }
    // A pace saved for losing isn't meant for gaining: a new goal without a pace uses its default.
    if (mapped !== saved.goal && args.rate_per_week === undefined) delete profile.rateKgPerWeek
    profile.goal = mapped
  }
  if (args.rate_per_week !== undefined && args.rate_per_week !== null) {
    const rate = num(args.rate_per_week)
    const kg = rate === null ? null : fromUnit(Math.abs(rate), unit)
    if (kg === null || kg > 1.5) return { error: `rate_per_week must be at most ${round(toUnit(1.5, unit), 1)} ${unit}.` }
    profile.rateKgPerWeek = round(kg, 3)
  }
  if (args.target_weight !== undefined) {
    const target = num(args.target_weight)
    if (args.target_weight === null || target === 0) profile.targetKg = null
    else {
      const kg = target === null ? null : fromUnit(target, unit)
      if (kg === null || kg < 30 || kg > 400) return { error: `target_weight (in ${unit}) doesn’t look right.` }
      profile.targetKg = round(kg, 2)
    }
  }
  if (args.body_fat_pct !== undefined) {
    const fat = num(args.body_fat_pct)
    if (args.body_fat_pct === null || fat === 0) profile.bodyFatPct = null
    else if (fat === null || fat < 3 || fat > 60) return { error: 'body_fat_pct must be between 3 and 60.' }
    else profile.bodyFatPct = round(fat, 1)
  }
  const latest = latestWeightKg(data, today)
  const weight = weightKg ?? latest?.kg ?? null
  const result = calcGoals(profile, { weightKg: weight, today })
  if (result.missing.length) {
    const names = result.missing.map((item) => (item === 'weight' ? `weight (${unit})` : item))
    return { error: `To calculate goals I need their ${names.join(' and ')}. Ask for ${names.length > 1 ? 'them' : 'it'}, then call this again.`, missing: result.missing }
  }
  const rawGoals = isObj(data?.settings?.food?.goals) ? data.settings.food.goals : {}
  const goals = { ...rawGoals, calories: result.calories, protein: result.protein, carbs: result.carbs, fat: result.fat, fiber: result.fiber, source: 'calculator' }
  return { profile, goals, result, weightKg: weight, weightFromLog: weightKg === null, unit }
}

function paceText(result, unit) {
  if (result.goal === 'maintain' || !result.pace) return result.goal === 'maintain' ? 'maintain weight' : ''
  const value = round(toUnit(Math.abs(result.pace), unit), 2)
  return `${result.pace < 0 ? 'lose' : 'gain'} ~${value} ${unit}/week`
}

function favoriteFromArgs(args) {
  const clamped = clampEstimateItem({ ...args, options: [], assumptions: [], locked: ['calories'] })
  const extra = {}
  if (clamped.extra.alcoholG !== null) extra.alcoholG = clamped.extra.alcoholG
  if (clamped.extra.caffeineMg !== null) extra.caffeineMg = clamped.extra.caffeineMg
  return {
    name: clean(args.name, 120), brand: clamped.brand, amount: clamped.amount, unit: clamped.unit, grams: clamped.grams,
    calories: clamped.calories, proteinG: clamped.proteinG, carbsG: clamped.carbsG, fatG: clamped.fatG,
    fiberG: clamped.fiberG, sugarG: clamped.sugarG, sodiumMg: clamped.sodiumMg, extra,
  }
}

// entry: the logged entry named by entry_id (already looked up), or null.
function planFavorite(args, data, entry) {
  const food = foodOf(data)
  const favorites = food.favorites
  const action = args.action === 'remove' ? 'remove' : args.action === 'save' ? 'save' : null
  if (!action) return { error: 'action must be save or remove.' }
  if (action === 'remove') {
    const wanted = clean(args.name, 120).toLowerCase()
    const found = (args.id && favorites.find((fav) => String(fav.id) === String(args.id)))
      || findFavorite(favorites, { name: args.name, brand: args.brand })
      || favorites.find((fav) => fav.name.toLowerCase() === wanted || fav.aliases.some((alias) => alias.toLowerCase() === wanted))
    if (!found) return { error: `No favorite called "${clean(args.name, 120) || args.id || ''}".` }
    return { action, favorite: found, favorites: favorites.filter((fav) => fav.id !== found.id) }
  }
  if (args.entry_id && !entry) return { error: 'No food entry with that id.' }
  const template = entry ? { ...entryTemplate(entry), name: clean(args.name, 120) || entry.name } : favoriteFromArgs(args)
  delete template.favoriteId
  if (!template.name) return { error: 'A favorite needs a name.' }
  if (num(template.calories) === null) {
    const fromMacros = macroCalories(template)
    if (fromMacros === null) return { error: 'A favorite needs calories (for the portion) or protein, carbs and fat.' }
    template.calories = Math.round(fromMacros)
  }
  const key = foodKey(template.name, template.brand)
  const existing = findFavorite(favorites, { name: template.name, brand: template.brand })
  const aliases = [...(existing?.aliases || []), ...(Array.isArray(args.aliases) ? args.aliases : [])]
    .filter((alias) => typeof alias === 'string').map((alias) => clean(alias, 60)).filter(Boolean)
  const favorite = { ...template, id: existing?.id || randomUUID(), meal: null, aliases: [...new Set(aliases)].slice(0, 20), updatedAt: nowIso() }
  const rest = favorites.filter((fav) => fav.id !== favorite.id && foodKey(fav.name, fav.brand) !== key)
  return { action, favorite, existed: Boolean(existing), favorites: [favorite, ...rest].slice(0, FAVORITES_MAX) }
}

function planWeightDelete(args, data, ctx) {
  const today = todayOf(ctx)
  const date = args.date ? args.date : today
  if (!isIsoDate(date)) return { error: 'Dates must be YYYY-MM-DD.' }
  const rows = weightsOf(data).filter((entry) => entry?.date === date)
  return { date, rows }
}

// ---- tool definitions ---------------------------------------------------------------------------

function tool(name, description, properties, required = []) {
  return { type: 'function', name, description, strict: false, parameters: { type: 'object', properties, required, additionalProperties: false } }
}

const DATE = { type: 'string', description: 'YYYY-MM-DD in the user\'s local calendar (default today).' }
const NUTRIENTS = {
  amount: { type: 'number', description: 'How much, in `unit` (2 for "2 eggs", 240 for "240 ml").' },
  unit: { type: 'string', description: 'Unit of amount: g, ml, cup, slice, piece, large, tbsp, scoop, bowl, plate…' },
  grams: { type: 'number', description: 'Estimated total weight in grams (ml for drinks), when known.' },
  calories: { type: 'number', description: 'kcal for the whole amount.' },
  protein_g: { type: 'number' },
  carbs_g: { type: 'number', description: 'Total carbohydrate including fiber.' },
  fat_g: { type: 'number' },
  fiber_g: { type: 'number' },
  sugar_g: { type: 'number' },
  sodium_mg: { type: 'number' },
  // Without alcohol_g, a drink's calories look too high for its macros and get recomputed from them.
  alcohol_g: { type: 'number', description: 'Alcohol (g) in alcoholic drinks (a standard drink ≈ 14 g). Always give it for beer, wine, spirits and cocktails, or their calories come out far too low.' },
  caffeine_mg: { type: 'number', description: 'Caffeine (mg) in caffeinated drinks, when known.' },
  brand: { type: 'string', description: 'Brand or restaurant, if any.' },
}
const LOG_NUTRIENTS = { ...NUTRIENTS, calories: { type: 'number', description: 'kcal for the whole amount eaten (required: your best estimate).' } }
const MEAL_ARG = { type: 'string', description: 'breakfast, lunch, dinner or snack (or one of the user\'s meal names). Omit to use the time of day.' }

export const FOOD_TOOL_DEFS = [
  tool('food_log', 'Log food or drink the user ate or drank (not plans or wishes). Estimate the nutrition yourself for the whole amount eaten: calories always, protein/carbs/fat when you reasonably can, and alcohol_g for alcoholic drinks. Use a typical portion when none is given and say what you assumed. If a food matches one of the user\'s usual foods in the snapshot, reuse its numbers. One item per food ("2 eggs and toast" = 2 items). Give a time only when they said when; meal defaults from the time of day.', {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short food name, e.g. "Scrambled eggs", "Chai (milk, 1 sugar)".' },
          ...LOG_NUTRIENTS,
          user_calories: { type: 'boolean', description: 'true when the user stated the calories themselves (kept even if the macros disagree).' },
        },
        required: ['name', 'calories'],
        additionalProperties: false,
      },
    },
    date: DATE,
    meal: MEAL_ARG,
    time: { type: 'string', description: '24-hour HH:MM when they said when they ate (default now for today).' },
    note: { type: 'string', description: 'Optional note for the entries (where, how it was cooked).' },
  }, ['items']),
  tool('food_day', 'Look up what was logged on a day: entries with ids, per meal, and totals vs goals. Today is already in the snapshot.', {
    date: DATE,
  }),
  tool('food_week', 'Weekly nutrition insights: average calories vs goal, days on target, protein and fiber, macro split, top foods and biggest calorie sources, weight trend, and the change from the week before.', {
    week_start: { type: 'string', description: 'First day of the week, YYYY-MM-DD. Omit for the current week.' },
  }),
  tool('food_update_entry', 'Change a logged food entry (id from the snapshot or food_day): portion, calories, macros, name, meal, time or date. For "it was two, not one" pass scale 2 instead of recomputing. New macros without calories recompute the calories.', {
    id: { type: 'string', description: 'The entry id.' },
    changes: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        ...NUTRIENTS,
        meal: MEAL_ARG,
        time: { type: 'string', description: '24-hour HH:MM, or empty for none.' },
        date: { type: 'string', description: 'YYYY-MM-DD (today or earlier).' },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    scale: { type: 'number', description: 'Multiply the portion and every nutrient (2 = double, 0.5 = half).' },
  }, ['id']),
  tool('food_delete_entry', 'Delete a logged food entry (id from the snapshot or food_day). Only when the user asks to remove it.', {
    id: { type: 'string', description: 'The entry id.' },
  }, ['id']),
  tool('food_set_goals', 'Set daily nutrition goals directly (calories in kcal, the rest in grams). Omitted goals stay as they are; 0 removes one. To work goals out from the user\'s body and aim, use food_calculate_goals.', {
    calories: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    fiber: { type: 'number' },
  }),
  tool('food_calculate_goals', 'Work out daily calorie and macro goals from the user\'s body and aim (BMR × activity, adjusted for the goal and pace, with safe floors and caps) and save them with the profile. Fields left out come from the saved profile, and weight from the latest weigh-in; if something is still missing the result says what to ask. Weights in the user\'s unit.', {
    sex: { type: 'string', enum: ['male', 'female'] },
    birth_year: { type: 'integer' },
    age: { type: 'integer', description: 'Alternative to birth_year.' },
    height_cm: { type: 'number', description: 'Height in cm (1 in = 2.54 cm).' },
    weight: { type: 'number', description: 'Current body weight in the user\'s unit.' },
    activity: { type: 'string', enum: ACTIVITY_LEVELS.map((level) => level.id), description: ACTIVITY_LEVELS.map((level) => `${level.id} = ${level.label} (${level.detail})`).join('; ') },
    goal: { type: 'string', enum: ['maintain', 'lose', 'gain'] },
    rate_per_week: { type: 'number', description: 'Pace in the user\'s unit per week (typical: lose 0.25–1 kg, gain 0.1–0.5 kg).' },
    target_weight: { type: 'number', description: 'Goal weight in the user\'s unit (0 removes it).' },
    body_fat_pct: { type: 'number', description: 'Body fat %, only if the user knows it.' },
  }),
  tool('food_favorite', 'Save a food as a favorite (name, portion and nutrition, to log again quickly) or remove one. Save from a logged entry with entry_id, or give the numbers. Saving a name that exists updates it.', {
    action: { type: 'string', enum: ['save', 'remove'] },
    name: { type: 'string' },
    entry_id: { type: 'string', description: 'Save this logged entry as the favorite.' },
    ...NUTRIENTS,
    aliases: { type: 'array', items: { type: 'string' }, description: 'Other names the user uses for it.' },
  }, ['action']),
  tool('weight_delete', 'Delete the body-weight entry logged on a date (e.g. a mistaken weigh-in). To correct it instead, log the right weight with gym_log_bodyweight.', {
    date: DATE,
  }, ['date']),
]

export const FOOD_TOOL_NAMES = FOOD_TOOL_DEFS.map((definition) => definition.name)
export const FOOD_LOOKUP_TOOLS = ['food_day', 'food_week']
export const FOOD_TOOL_LABELS = {
  food_log: 'Logging your food',
  food_day: 'Checking your food log',
  food_week: 'Looking at your week',
  food_update_entry: 'Updating your food log',
  food_delete_entry: 'Removing a food entry',
  food_set_goals: 'Setting your goals',
  food_calculate_goals: 'Working out your goals',
  food_favorite: 'Updating your favorites',
  weight_delete: 'Removing a weigh-in',
}

// ---- loading and the snapshot -------------------------------------------------------------------

// The last 60 days of entries (app shape). A missing table (migration not run) gives
// { foodEntries: [], foodMissing: true }; another failure gives no entries plus foodError, so the
// assistant still answers everything else.
export async function loadFoodData(supabase, userId, ctx) {
  const today = todayOf(ctx)
  try {
    const { data: rows, error } = await supabase.from('food_entries').select('*').eq('user_id', userId)
      .gte('date', addDays(today, -LOAD_DAYS)).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(LOAD_LIMIT)
    if (error) {
      if (isMissingTable(error)) return { foodEntries: [], foodMissing: true }
      throw error
    }
    return { foodEntries: (rows || []).map(rowToEntry).filter(Boolean), foodMissing: false }
  } catch (error) {
    console.error('Food entries failed:', error?.message || error)
    return { foodEntries: [], foodMissing: false, foodError: 'Couldn’t load food entries right now.' }
  }
}

function usualFoods(data, today, limit = 15) {
  const food = foodOf(data)
  const unit = food.prefs.energyUnit
  const out = []
  const seen = new Set()
  const add = (item, favorite) => {
    const key = foodKey(item.name, item.brand)
    if (!key || seen.has(key) || out.length >= limit) return
    seen.add(key)
    const kcal = num(item.calories) ?? macroCalories(item)
    out.push(`${itemLabel(item)}${kcal !== null ? ` ${energy(kcal, unit)}` : ''}${favorite ? ' ★' : ''}`)
  }
  for (const favorite of food.favorites) add(favorite, true)
  for (const recent of recents(entriesOf(data), today, { days: LOAD_DAYS, limit })) add(recent, false)
  return out
}

function macroVsGoal(eaten, goal) {
  const value = round(eaten, 0)
  return goal ? `${value} / ${round(goal, 0)} g` : `${value} g`
}

// Compact food context for the assistant's snapshot: today vs goals (with entry ids), the 7 days
// before, usual foods (★ = favorite), goals and profile, and the weight trend in the user's unit.
export function foodSnapshot(data, ctx) {
  const today = todayOf(ctx)
  const food = foodOf(data)
  const unit = food.prefs.energyUnit
  const weightUnit = unitOf(data)
  const entries = entriesOf(data)
  const goals = food.goals
  const todays = entries.filter((entry) => entry.date === today)
  const totals = dayTotals(todays)
  const left = remaining(goals, totals)

  const meals = mealTotals(todays, food.prefs.meals)
    .filter((group) => group.entries.length)
    .map((group) => ({
      meal: group.meal.name,
      kcal: round(group.totals.calories, 0),
      items: group.entries.slice(0, 15).map((entry) => compact({ id: entry.id, name: itemLabel(entry), kcal: round(entryCalories(entry), 0), time: entry.time })),
    }))

  const days = []
  for (let i = 7; i >= 1; i -= 1) {
    const date = addDays(today, -i)
    const dayTotalsForDate = dayTotals(entries.filter((entry) => entry.date === date))
    if (dayTotalsForDate.counted) days.push({ date: `${DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date}`, kcal: round(dayTotalsForDate.calories, 0), proteinG: round(dayTotalsForDate.proteinG, 0) })
  }
  const avg = (field) => (days.length ? round(days.reduce((sum, day) => sum + day[field], 0) / days.length, 0) : null)

  const trend = weightTrend(weightsOf(data), today, { targetKg: food.profile.targetKg })
  const weight = trend.latestKg === null ? null : compact({
    latest: `${fmtWeight(trend.latestKg, weightUnit)} (${dayLabel(trend.latestDate, today)})`,
    trend: trend.trendKg === null ? null : fmtWeight(trend.trendKg, weightUnit),
    weeklyChange: trend.weeklyChangeKg === null ? null : `${signedWeight(trend.weeklyChangeKg, weightUnit)}/week`,
    pace28d: trend.paceKgPerWeek === null ? null : `${signedWeight(trend.paceKgPerWeek, weightUnit)}/week`,
    goalEta: trend.etaDate || null,
  })

  const profile = food.profile
  const rawProfile = isObj(data?.settings?.food?.profile) ? data.settings.food.profile : {}
  const profileOut = Object.keys(rawProfile).length ? compact({
    sex: profile.sex,
    birthYear: profile.birthYear,
    heightCm: profile.heightCm,
    activity: profile.activity,
    goal: profile.goal,
    pace: profile.goal !== 'maintain' ? `${round(toUnit(profile.rateKgPerWeek, weightUnit), 2)} ${weightUnit}/week` : null,
    target: profile.targetKg ? fmtWeight(profile.targetKg, weightUnit) : null,
    bodyFatPct: profile.bodyFatPct,
  }) : null

  const streak = logStreak(entries, today)
  return compact({
    setup: data?.foodMissing ? 'Food tables not created yet: logging food fails until supabase/migrations/2026-09-27-food.sql is run in Supabase (goals and favorites still work).' : null,
    loadError: data?.foodError || null,
    energyUnit: unit === 'kJ' ? 'user prefers kJ (numbers here are kcal; 1 kcal = 4.184 kJ)' : null,
    goals: compact({ calories: goals.calories, protein: goals.protein, carbs: goals.carbs, fat: goals.fat, fiber: goals.fiber, from: goals.calories ? goals.source : null }),
    today: compact({
      eatenKcal: round(totals.calories, 0),
      goalKcal: goals.calories,
      remainingKcal: left.calories,
      protein: macroVsGoal(totals.proteinG, goals.protein),
      carbs: macroVsGoal(totals.carbsG, goals.carbs),
      fat: macroVsGoal(totals.fatG, goals.fat),
      fiber: goals.fiber || totals.fiberG ? macroVsGoal(totals.fiberG, goals.fiber) : null,
      meals,
      nothingLogged: todays.length ? null : true,
    }),
    last7Days: days.length ? { days, avgKcal: avg('kcal'), avgProteinG: avg('proteinG'), loggedDays: days.length } : null,
    streakDays: streak.current >= 2 ? streak.current : null,
    usualFoods: usualFoods(data, today),
    profile: profileOut,
    weight,
    weightUnit,
  })
}

// ---- proposal labels ----------------------------------------------------------------------------

function logLabel(plan, data, ctx, time) {
  const today = todayOf(ctx)
  const unit = plan.food.prefs.energyUnit
  const total = plan.rows.reduce((sum, row) => sum + entryCalories(row), 0)
  const labels = plan.rows.map(itemLabel)
  const what = labels.length <= 3
    ? labels.join(', ')
    : `${labels.length} items (${plan.rows.slice(0, 3).map((row) => clean(row.name, 40)).join(', ')}, …)`
  const when = `${dayLabel(plan.date, today)}${time ? ` at ${clock(time)}` : ''}`
  return `Log ${what} · ${energy(total, unit)} → ${mealName(plan.meal, plan.food.prefs.meals)} ${when}`
}

// A short, authoritative line for a proposal card. Never throws; entries must be in memory (the
// snapshot's, or ones a lookup loaded) to be named.
export function describeFoodAction(name, args, data, ctx) {
  const input = isObj(args) ? args : {}
  const today = todayOf(ctx)
  try {
    const food = foodOf(data)
    const unit = food.prefs.energyUnit
    const meals = food.prefs.meals
    const findKnown = (id) => entriesOf(data).find((entry) => String(entry.id) === String(id ?? ''))

    if (name === 'food_log') {
      const plan = planLog(input, data, ctx)
      if (plan.error) return `Log food (${plan.error})`
      return logLabel(plan, data, ctx, input.time ? plan.time : null)
    }
    if (name === 'food_day') return `Look up food ${onDay(input.date || today, today)}`
    if (name === 'food_week') return input.week_start ? `Look up the food week of ${dayLabel(input.week_start, today)}` : 'Look up this week’s food'
    if (name === 'food_update_entry') {
      const entry = findKnown(input.id)
      if (!entry) return isRef(input.id) ? 'Update the food entry just logged' : 'Update a food entry'
      const plan = planUpdate(input, data, ctx, entry)
      const where = `${mealName(entry.meal, meals)} ${dayLabel(entry.date, today)}`
      return plan.error ? `Update ${itemLabel(entry)} (${where})` : `Update ${itemLabel(entry)} (${where}): ${plan.diff.join(', ')}`
    }
    if (name === 'food_delete_entry') {
      const entry = findKnown(input.id)
      if (!entry) return 'Delete a food entry'
      return `Delete ${itemLabel(entry)} · ${energy(entryCalories(entry), unit)} (${mealName(entry.meal, meals)} ${dayLabel(entry.date, today)})`
    }
    if (name === 'food_set_goals') {
      const plan = planGoals(input, data)
      if (plan.error) return 'Set daily goals'
      const parts = goalParts(plan.next, unit)
      const removed = plan.cleared.map((key) => `no ${key === 'calories' ? 'calorie' : key} goal`)
      if (!parts.length) return `Remove the daily ${plan.cleared.length === 1 && plan.cleared[0] === 'calories' ? 'calorie goal' : 'goals'}`
      return `Set daily goal: ${[...parts, ...removed].join(' · ')}`
    }
    if (name === 'food_calculate_goals') {
      const plan = planCalculate(input, data, ctx)
      if (plan.error) return plan.missing ? `Calculate daily goals (missing: ${plan.missing.join(', ')})` : 'Calculate daily goals'
      const pace = paceText(plan.result, plan.unit)
      return `Set daily goal: ${goalParts(plan.goals, unit).join(' · ')}${pace ? ` (${pace})` : ''}`
    }
    if (name === 'food_favorite') {
      const entry = input.entry_id ? findKnown(input.entry_id) : null
      if (input.action === 'save' && input.entry_id && !entry) return `Save ${clean(input.name, 80) || 'that entry'} as a favorite`
      const plan = planFavorite(input, data, entry)
      if (plan.error) return input.action === 'remove' ? `Remove favorite: ${clean(input.name, 80)}` : `Save favorite: ${clean(input.name, 80)}`
      if (plan.action === 'remove') return `Remove favorite: ${plan.favorite.name}`
      return `${plan.existed ? 'Update' : 'Save'} favorite: ${itemLabel(plan.favorite)} · ${energy(plan.favorite.calories, unit)}`
    }
    if (name === 'weight_delete') {
      const plan = planWeightDelete(input, data, ctx)
      if (plan.error) return 'Delete a weigh-in'
      const kg = plan.rows.length ? num(plan.rows[0].kg) : null
      return `Delete weigh-in${kg !== null ? `: ${fmtWeight(kg, unitOf(data))}` : ''} ${onDay(plan.date, today)}`
    }
  } catch {
    // fall through to the generic label
  }
  return FOOD_TOOL_LABELS[name] || 'Update food'
}

// Checks a food tool call without writing (for staging a proposal). Entries not in memory and staged
// refs ('$1') pass: they are checked again when the call runs.
export function checkFoodTool(name, args, data, ctx) {
  const input = isObj(args) ? args : {}
  const findKnown = (id) => entriesOf(data).find((entry) => String(entry.id) === String(id ?? ''))
  const result = (plan) => (plan?.error ? fail(plan.error) : { ok: true })
  if (name === 'food_log') {
    if (data?.foodMissing) return fail(FOOD_MISSING)
    return result(planLog(input, data, ctx))
  }
  if (name === 'food_day') return input.date && !isIsoDate(input.date) ? fail('Dates must be YYYY-MM-DD.') : { ok: true }
  if (name === 'food_week') return input.week_start && !isIsoDate(input.week_start) ? fail('week_start must be YYYY-MM-DD.') : { ok: true }
  if (name === 'food_update_entry' || name === 'food_delete_entry') {
    if (data?.foodMissing) return fail(FOOD_MISSING)
    if (!input.id) return fail('Pass the entry id (from the snapshot or food_day).')
    const entry = findKnown(input.id)
    if (!entry) return { ok: true }
    return name === 'food_update_entry' ? result(planUpdate(input, data, ctx, entry)) : { ok: true }
  }
  if (name === 'food_set_goals') return result(planGoals(input, data))
  if (name === 'food_calculate_goals') return result(planCalculate(input, data, ctx))
  if (name === 'food_favorite') {
    if (input.action === 'save' && input.entry_id && !findKnown(input.entry_id)) return isRef(input.entry_id) ? { ok: true } : fail('No food entry with that id.')
    return result(planFavorite(input, data, input.entry_id ? findKnown(input.entry_id) : null))
  }
  if (name === 'weight_delete') {
    const plan = planWeightDelete(input, data, ctx)
    if (plan.error) return fail(plan.error)
    // The assistant loads the latest 60 weigh-ins; with fewer, a date not among them has none.
    if (!plan.rows.length && weightsOf(data).length < 60) return fail(`No weigh-in ${onDay(plan.date, todayOf(ctx))}.`)
    return { ok: true }
  }
  return fail(`Unknown tool: ${name}`)
}

// ---- execution ----------------------------------------------------------------------------------

function entrySummary(entry, today) {
  return compact({
    id: entry.id,
    name: itemLabel(entry),
    kcal: round(entryCalories(entry), 0),
    proteinG: entry.proteinG === null ? null : round(entry.proteinG, 1),
    carbsG: entry.carbsG === null ? null : round(entry.carbsG, 1),
    fatG: entry.fatG === null ? null : round(entry.fatG, 1),
    time: entry.time ? clock(entry.time) : null,
    note: entry.note,
    source: entry.source === 'assistant' ? null : entry.source,
    date: entry.date !== today ? entry.date : null,
  })
}

async function runFoodDay(supabase, userId, input, data, ctx) {
  const today = todayOf(ctx)
  const date = input.date ? input.date : today
  if (!isIsoDate(date)) return fail('Dates must be YYYY-MM-DD.')
  if (data.foodMissing) return { ok: true, date, entries: [], message: FOOD_MISSING }
  if (date < addDays(today, -LOAD_DAYS)) mergeEntries(data, await fetchEntries(supabase, userId, date, date))
  const food = foodOf(data)
  const unit = food.prefs.energyUnit
  const entries = entriesOf(data).filter((entry) => entry.date === date)
  const totals = dayTotals(entries)
  if (!entries.length) return { ok: true, date, found: false, message: `Nothing logged ${onDay(date, today)}.` }
  return {
    ok: true,
    date,
    day: dayLabel(date, today),
    meals: mealTotals(entries, food.prefs.meals).filter((group) => group.entries.length).map((group) => ({
      meal: group.meal.name,
      kcal: round(group.totals.calories, 0),
      entries: group.entries.map((entry) => entrySummary(entry, date)),
    })),
    totals: compact({ kcal: round(totals.calories, 0), proteinG: round(totals.proteinG, 0), carbsG: round(totals.carbsG, 0), fatG: round(totals.fatG, 0), fiberG: round(totals.fiberG, 0) }),
    goals: compact({ calories: food.goals.calories, protein: food.goals.protein, carbs: food.goals.carbs, fat: food.goals.fat, fiber: food.goals.fiber }),
    remaining: compact(remaining(food.goals, totals)),
    energyUnit: unit,
  }
}

async function runFoodWeek(supabase, userId, input, data, ctx) {
  const today = todayOf(ctx)
  if (input.week_start && !isIsoDate(input.week_start)) return fail('week_start must be YYYY-MM-DD.')
  const food = foodOf(data)
  const weightUnit = unitOf(data)
  const start = input.week_start || null
  if (start && !data.foodMissing && addDays(start, -35) < addDays(today, -LOAD_DAYS)) {
    mergeEntries(data, await fetchEntries(supabase, userId, addDays(start, -35), addDays(start, 6)))
  }
  const week = weeklyInsights(entriesOf(data), weightsOf(data), food.goals, start, today, {
    targetKg: food.profile.targetKg, energyUnit: food.prefs.energyUnit, weightUnit, weekStart: food.prefs.weekStart,
  })
  const w = (kg) => (kg === null || kg === undefined ? null : fmtWeight(kg, weightUnit))
  const sw = (kg) => (kg === null || kg === undefined ? null : signedWeight(kg, weightUnit))
  return {
    ok: true,
    week: compact({
      start: week.weekStart,
      end: week.weekEnd,
      complete: week.complete,
      loggedDays: week.loggedDays,
      avgKcal: week.avgKcal,
      goalKcal: week.goalKcal,
      onTargetDays: week.goalKcal ? week.onTargetDays : null,
      overDays: week.goalKcal ? week.overDays : null,
      underDays: week.goalKcal ? week.underDays : null,
      budgetKcal: week.budgetKcal,
      protein: compact({ avgG: week.protein.avgG, goalG: week.protein.targetG, pct: week.protein.pct, hitDays: week.protein.targetG ? week.protein.hitDays : null }),
      fiber: compact({ avgG: week.fiber.avgG, goalG: week.fiber.targetG, pct: week.fiber.pct }),
      macroSplit: week.macroSplit.show ? `P ${week.macroSplit.proteinPct}% · C ${week.macroSplit.carbsPct}% · F ${week.macroSplit.fatPct}%` : null,
      days: week.days.filter((day) => !day.future).map((day) => compact({
        date: day.date, kcal: day.logged ? round(day.calories, 0) : null, proteinG: day.logged ? round(day.proteinG, 0) : null,
        status: day.calorieStatus, inProgress: day.inProgress || null, maybeIncomplete: day.maybeIncomplete || null,
      })),
      topFoods: week.topFoods.map((item) => `${item.name} ×${item.count}`),
      biggestSources: week.biggestSources.map((item) => `${item.name} ${round(item.share * 100, 0)}%`),
      weight: compact({ trend: w(week.weight.trendKg), weeklyChange: sw(week.weight.weeklyChangeKg), pacePerWeek: sw(week.weight.paceKgPerWeek), weighIns: week.weight.weighIns }),
      vsLastWeek: compact({ avgKcal: week.vsLastWeek.avgKcal, avgProteinG: week.vsLastWeek.avgProteinG, onTargetDays: week.vsLastWeek.onTargetDays, trend: sw(week.vsLastWeek.trendKg) }),
      streak: week.streak.current || null,
      adaptive: week.adaptive ? `Estimated maintenance ≈ ${groupInt(week.adaptive.tdeeKcal)} kcal from ${week.adaptive.loggedDays} logged days and ${week.adaptive.weighIns} weigh-ins (a suggestion, not applied)` : null,
    }),
    summary: week.summary,
    ...(data.foodMissing ? { note: FOOD_MISSING } : {}),
  }
}

// Runs a food tool for userId: writes food_entries rows (user_id on every row and filter),
// settings.food through patch_settings, or body_weights; keeps `data` in step so later tools and the
// snapshot see the change. → { ok, message, id?, ... }
export async function executeFoodTool(supabase, userId, name, args, data, ctx) {
  const input = isObj(args) ? args : {}
  const today = todayOf(ctx)
  const food = foodOf(data)
  const unit = food.prefs.energyUnit

  if (name === 'food_day') return runFoodDay(supabase, userId, input, data, ctx)
  if (name === 'food_week') return runFoodWeek(supabase, userId, input, data, ctx)

  if (name === 'food_log') {
    if (data.foodMissing) return fail(FOOD_MISSING)
    const plan = planLog(input, data, ctx)
    if (plan.error) return fail(plan.error)
    const createdAt = nowIso()
    const entries = plan.rows.map((row) => ({ ...row, id: randomUUID(), createdAt }))
    try {
      await tolerant((rows) => supabase.from('food_entries').insert(rows), entries.map((entry) => entryToRow(entry, userId)))
    } catch (error) {
      if (isMissingTable(error)) {
        data.foodMissing = true
        return fail(FOOD_MISSING)
      }
      throw error
    }
    data.foodEntries = [...entries, ...entriesOf(data)]
    const total = entries.reduce((sum, entry) => sum + entryCalories(entry), 0)
    const what = entries.length === 1 ? itemLabel(entries[0]) : `${entries.length} items (${entries.map((entry) => clean(entry.name, 40)).join(', ')})`
    return {
      ok: true,
      message: `Logged ${what}, ${energy(total, unit)}, to ${mealName(plan.meal, food.prefs.meals)} ${dayLabel(plan.date, today)}. ${dayLine(data, plan.date, today)}`,
      id: entries[0].id,
      ids: entries.map((entry) => entry.id),
    }
  }

  if (name === 'food_update_entry') {
    if (data.foodMissing) return fail(FOOD_MISSING)
    const entry = await findEntry(supabase, userId, data, input.id)
    if (!entry) return fail('No food entry with that id (it may have been deleted). Look it up with food_day.')
    const plan = planUpdate(input, data, ctx, entry)
    if (plan.error) return fail(plan.error)
    const row = entryToRow(plan.next, userId)
    const patch = {}
    for (const [key, value] of Object.entries(row)) {
      if (['id', 'user_id', 'created_at'].includes(key)) continue
      if (JSON.stringify(value ?? null) !== JSON.stringify(entryToRow(entry, userId)[key] ?? null)) patch[key] = value
    }
    if (Object.keys(patch).length) {
      try {
        await tolerant((values) => supabase.from('food_entries').update(values).eq('id', String(entry.id)).eq('user_id', userId), patch)
      } catch (error) {
        if (isMissingTable(error)) {
          data.foodMissing = true
          return fail(FOOD_MISSING)
        }
        throw error
      }
    }
    data.foodEntries = entriesOf(data).map((item) => (String(item.id) === String(entry.id) ? plan.next : item))
    return { ok: true, message: `Updated ${itemLabel(entry)}: ${plan.diff.join(', ')}. ${dayLine(data, plan.next.date, today)}`, id: entry.id }
  }

  if (name === 'food_delete_entry') {
    if (data.foodMissing) return fail(FOOD_MISSING)
    const entry = await findEntry(supabase, userId, data, input.id)
    if (!entry) return fail('No food entry with that id (it may already be gone).')
    const { error } = await supabase.from('food_entries').delete().eq('id', String(entry.id)).eq('user_id', userId)
    if (error) {
      if (isMissingTable(error)) {
        data.foodMissing = true
        return fail(FOOD_MISSING)
      }
      throw error
    }
    data.foodEntries = entriesOf(data).filter((item) => String(item.id) !== String(entry.id))
    return { ok: true, message: `Deleted ${itemLabel(entry)} (${energy(entryCalories(entry), unit)}) from ${mealName(entry.meal, food.prefs.meals)} ${dayLabel(entry.date, today)}. ${dayLine(data, entry.date, today)}` }
  }

  if (name === 'food_set_goals') {
    const plan = planGoals(input, data)
    if (plan.error) return fail(plan.error)
    await writeFood(supabase, userId, data, { goals: plan.goals })
    const parts = goalParts(plan.next, unit)
    const cleared = plan.cleared.length ? ` Removed the ${plan.cleared.join(', ')} goal${plan.cleared.length === 1 ? '' : 's'}.` : ''
    return { ok: true, message: `${parts.length ? `Daily goal: ${parts.join(' · ')}.` : 'No daily goals set.'}${cleared}${plan.note ? ` ${plan.note}` : ''}` }
  }

  if (name === 'food_calculate_goals') {
    const plan = planCalculate(input, data, ctx)
    if (plan.error) return { ...fail(plan.error), ...(plan.missing ? { missing: plan.missing } : {}) }
    await writeFood(supabase, userId, data, { profile: plan.profile, goals: plan.goals })
    const { result } = plan
    const pace = paceText(result, plan.unit)
    const basis = `based on ${fmtWeight(plan.weightKg, plan.unit)}${plan.weightFromLog ? ' (latest weigh-in)' : ''}`
    return {
      ok: true,
      message: `Daily goal set: ${goalParts(plan.goals, unit).join(' · ')}. Maintenance ≈ ${energy(result.tdee, unit)}, ${basis}${pace ? `; ${pace}` : ''}.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`,
      calories: result.calories,
      protein: result.protein,
      carbs: result.carbs,
      fat: result.fat,
      fiber: result.fiber,
      tdee: result.tdee,
      bmr: result.bmr,
      pacePerWeek: result.pace === null ? null : `${signedWeight(result.pace, plan.unit)}/week`,
      warnings: result.warnings,
    }
  }

  if (name === 'food_favorite') {
    let entry = null
    if (input.action === 'save' && input.entry_id) {
      entry = data.foodMissing ? null : await findEntry(supabase, userId, data, input.entry_id)
      if (!entry) return fail('No food entry with that id.')
    }
    const plan = planFavorite(input, data, entry)
    if (plan.error) return fail(plan.error)
    await writeFood(supabase, userId, data, { favorites: plan.favorites })
    if (plan.action === 'remove') return { ok: true, message: `Removed ${plan.favorite.name} from favorites.` }
    return { ok: true, message: `${plan.existed ? 'Updated' : 'Saved'} favorite: ${itemLabel(plan.favorite)}, ${energy(plan.favorite.calories, unit)}.`, id: plan.favorite.id }
  }

  if (name === 'weight_delete') {
    const plan = planWeightDelete(input, data, ctx)
    if (plan.error) return fail(plan.error)
    if (data.gymTablesMissing) return fail(WEIGHT_MISSING)
    let rows = plan.rows
    if (!rows.length) {
      const { data: found, error } = await supabase.from('body_weights').select('id, date, kg').eq('user_id', userId).eq('date', plan.date)
      if (error) {
        if (isMissingTable(error)) return fail(WEIGHT_MISSING)
        throw error
      }
      rows = found || []
    }
    if (!rows.length) return fail(`No weigh-in ${onDay(plan.date, today)}.`)
    const { error } = await supabase.from('body_weights').delete().eq('user_id', userId).eq('date', plan.date)
    if (error) {
      if (isMissingTable(error)) return fail(WEIGHT_MISSING)
      throw error
    }
    data.body_weights = weightsOf(data).filter((entry) => entry?.date !== plan.date)
    const kg = num(rows[0].kg)
    return { ok: true, message: `Deleted your weigh-in${kg !== null ? ` of ${fmtWeight(kg, unitOf(data))}` : ''} ${onDay(plan.date, today)}.` }
  }

  throw new Error(`Unknown tool: ${name}`)
}

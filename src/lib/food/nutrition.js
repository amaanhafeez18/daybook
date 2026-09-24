// Food maths: meals, totals, goals, recents, weight trend and weekly insights.
// Pure and dependency-free so the client and the API share it. Dates are local 'YYYY-MM-DD'
// strings, handled internally as UTC day numbers, so answers never depend on the machine's time
// zone. Energy is kcal and body weight kg. Read paths never throw on malformed stored data.

// ---- basics -------------------------------------------------------------------------------------

const DAY_MS = 86400000
const ERA_DAYS = 146097 // days in 400 Gregorian years
const MAX_RANGE_DAYS = 3660
const KCAL_PER_KG = 7700
const LB_PER_KG = 2.2046226218

const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value) => (typeof value === 'string' ? value : '')
const own = (object, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined)
const validId = (id) => (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id))
const list = (value) => (Array.isArray(value) ? value.filter(isObj) : [])
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const pad = (n) => String(n).padStart(2, '0')

// A finite number (numeric strings accepted, as older rows may hold them), else null.
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const nonNeg = (value) => {
  const n = num(value)
  return n === null ? null : Math.max(0, n)
}

const numIn = (value, min, max) => {
  const n = num(value)
  return n !== null && n >= min && n <= max ? n : null
}

function round(value, digits = 0) {
  const factor = 10 ** digits
  const out = Math.round(value * factor) / factor
  return Object.is(out, -0) ? 0 : out
}

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : ''
}

function strings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const clean = text(item, maxLength)
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length >= maxItems) break
  }
  return out
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

// ---- dates --------------------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// Days since 1970-01-01 for a valid ISO date, else null (400 years added keeps Date.UTC away from
// its "years 0–99 mean 1900s" rule).
function dayOf(iso) {
  if (typeof iso !== 'string') return null
  const match = ISO_RE.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  if (month < 1 || month > 12 || date < 1 || date > 31) return null
  const ms = Date.UTC(year + 400, month - 1, date)
  if (new Date(ms).getUTCDate() !== date) return null
  return ms / DAY_MS - ERA_DAYS
}

function isoOf(day) {
  const date = new Date((day + ERA_DAYS) * DAY_MS)
  const year = date.getUTCFullYear() - 400
  if (!(year >= 0 && year <= 9999)) return null
  return `${String(year).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function localTodayDay() {
  const now = new Date()
  return dayOf(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
}

const weekdayOf = (day) => (((day + 4) % 7) + 7) % 7 // 0 = Sun; 1970-01-01 was a Thursday

// Minutes after midnight for 'HH:MM' (also 'H:MM', 'HH:MM:SS' and '2:30 PM'), else null.
function minutesOf(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(str(value).trim())
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const suffix = match[3]?.toLowerCase()
  if (suffix && (hour < 1 || hour > 12)) return null
  if (suffix === 'pm' && hour < 12) hour += 12
  if (suffix === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

const hhmmOf = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

// ---- constants ----------------------------------------------------------------------------------

export const MEALS_DEFAULT = deepFreeze([
  { id: 'breakfast', name: 'Breakfast' },
  { id: 'lunch', name: 'Lunch' },
  { id: 'dinner', name: 'Dinner' },
  { id: 'snack', name: 'Snacks' },
])

export const KCAL_PER_G = deepFreeze({ protein: 4, carbs: 4, fat: 9, alcohol: 7, fiber: 2 })
export const KJ_PER_KCAL = 4.184

export const ENTRY_SOURCES = deepFreeze(['manual', 'quick', 'ai_text', 'ai_photo', 'ai_voice', 'favorite', 'recent', 'copy', 'assistant'])
export const NUTRIENTS = deepFreeze(['protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'])
export const GOAL_KEYS = deepFreeze(['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'])
export const FAVORITES_MAX = 400 // "My foods": saved foods with their exact nutrition
export const SAVED_SOURCES = ['label', 'barcode', 'web', 'user', 'estimate', 'entry']

// Research §3: activity factors for the goal calculator.
export const ACTIVITY_LEVELS = deepFreeze([
  { id: 'sedentary', factor: 1.2, label: 'Sedentary', detail: 'Desk job, little exercise' },
  { id: 'light', factor: 1.375, label: 'Lightly active', detail: '1–3 workouts a week, or on your feet some' },
  { id: 'moderate', factor: 1.55, label: 'Moderately active', detail: '3–5 workouts a week' },
  { id: 'active', factor: 1.725, label: 'Very active', detail: '6–7 workouts a week, or a physical job' },
  { id: 'very', factor: 1.9, label: 'Extremely active', detail: 'Hard training and a physical job' },
])
const ACTIVITY_FACTOR = Object.fromEntries(ACTIVITY_LEVELS.map((level) => [level.id, level.factor]))

// kg per week offered by the goal wizard (defaults: lose 0.5, gain 0.25).
export const RATE_OPTIONS = deepFreeze({ lose: [0.25, 0.5, 0.75, 1], gain: [0.1, 0.25, 0.5] })
export const PROTEIN_PER_KG = deepFreeze({ lose: 2, maintain: 1.6, gain: 1.8 })

const MEAL_IDS = MEALS_DEFAULT.map((meal) => meal.id)
const GOALS = ['maintain', 'lose', 'gain']
const DEFAULT_RATE = { lose: 0.5, gain: 0.25 }
const FLOORS = { female: 1200, male: 1500 }
const FLOOR_UNSPECIFIED = 1350
const GOAL_MAX = { calories: 20000, protein: 1000, carbs: 2000, fat: 1000, fiber: 300, sugar: 1000, sodium: 50000 }

// Numeric entry fields and their rounding (decimal places).
const ENTRY_NUMBERS = { amount: 2, grams: 1, calories: 1, proteinG: 1, carbsG: 1, fatG: 1, fiberG: 1, sugarG: 1, sodiumMg: 0 }
const TOTAL_FIELDS = ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg']
const extraDigits = (key) => (/Mg$/.test(key) ? 0 : 1)

// ---- meals --------------------------------------------------------------------------------------

// 04:00–10:59 breakfast, 11:00–15:59 lunch, 16:00–21:59 dinner, otherwise (or unreadable) snack.
export function mealForTime(hhmm) {
  const minutes = minutesOf(hhmm)
  if (minutes === null) return 'snack'
  const hour = Math.floor(minutes / 60)
  if (hour >= 4 && hour < 11) return 'breakfast'
  if (hour >= 11 && hour < 16) return 'lunch'
  if (hour >= 16 && hour < 22) return 'dinner'
  return 'snack'
}

// Up to 6 meals with unique ids; the defaults when none are usable.
function normalizeMeals(raw) {
  const out = []
  const ids = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const meal = typeof item === 'string' ? { id: item } : item
    if (!isObj(meal)) continue
    const id = text(meal.id, 40)
    if (!id || ids.has(id)) continue
    ids.add(id)
    out.push({ ...meal, id, name: text(meal.name, 40) || MEALS_DEFAULT.find((d) => d.id === id)?.name || id })
    if (out.length >= 6) break
  }
  return out.length ? out : MEALS_DEFAULT.map((meal) => ({ ...meal }))
}

const mealsCache = new WeakMap()

function mealsOf(meals) {
  if (!Array.isArray(meals) || !meals.length) return MEALS_DEFAULT
  let out = mealsCache.get(meals)
  if (!out) {
    out = normalizeMeals(meals)
    mealsCache.set(meals, out)
    mealsCache.set(out, out)
  }
  return out
}
const fallbackMeal = (meals) => (meals.find((meal) => meal.id === 'snack') || meals[meals.length - 1]).id

// The meal an entry shows under: its own when it is one of the meals, otherwise Snacks (or the
// last meal when there is no Snacks).
export function entryMeal(entry, meals) {
  const order = mealsOf(meals)
  const id = isObj(entry) ? entry.meal : null
  return order.some((meal) => meal.id === id) ? id : fallbackMeal(order)
}

function compareInMeal(a, b) {
  const ta = minutesOf(a.time)
  const tb = minutesOf(b.time)
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  }
  const ca = str(a.createdAt)
  const cb = str(b.createdAt)
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

// Entries in meal order, then by time (untimed last), then by creation.
export function sortDayEntries(entries, meals) {
  const order = mealsOf(meals)
  const rank = new Map(order.map((meal, index) => [meal.id, index]))
  return list(entries)
    .map((entry) => ({ entry, rank: rank.get(entryMeal(entry, order)) }))
    .sort((a, b) => a.rank - b.rank || compareInMeal(a.entry, b.entry))
    .map((item) => item.entry)
}

// ---- energy & totals ----------------------------------------------------------------------------

// 4P + 4(C − fiber) + 2·fiber + 9F + 7·alcohol (carbs include fiber, US label convention).
// Null when the entry has no protein, carbs, fat or alcohol.
export function macroCalories(entry) {
  if (!isObj(entry)) return null
  const protein = nonNeg(entry.proteinG)
  const carbs = nonNeg(entry.carbsG)
  const fat = nonNeg(entry.fatG)
  const alcohol = nonNeg(isObj(entry.extra) && entry.extra.alcoholG != null ? entry.extra.alcoholG : entry.alcoholG)
  if (protein === null && carbs === null && fat === null && alcohol === null) return null
  const fiberRaw = nonNeg(entry.fiberG)
  const fiber = carbs !== null && fiberRaw !== null ? Math.min(fiberRaw, carbs) : 0
  const kcal = KCAL_PER_G.protein * (protein ?? 0)
    + KCAL_PER_G.carbs * ((carbs ?? 0) - fiber)
    + KCAL_PER_G.fiber * fiber
    + KCAL_PER_G.fat * (fat ?? 0)
    + KCAL_PER_G.alcohol * (alcohol ?? 0)
  return round(kcal, 1)
}

// Stated calories, else calories from macros, else 0 (a name-only entry counts nothing).
export function entryCalories(entry) {
  if (!isObj(entry)) return 0
  const kcal = nonNeg(entry.calories)
  if (kcal !== null) return kcal
  return macroCalories(entry) ?? 0
}

const hasEnergy = (entry) => isObj(entry) && (nonNeg(entry.calories) !== null || macroCalories(entry) !== null)

// Null-safe sums. count = entries, counted = entries that carry energy.
export function dayTotals(entries) {
  const totals = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0, count: 0, counted: 0 }
  for (const entry of list(entries)) {
    totals.count += 1
    if (hasEnergy(entry)) totals.counted += 1
    totals.calories += entryCalories(entry)
    for (const field of TOTAL_FIELDS) totals[field] += nonNeg(entry[field]) ?? 0
  }
  totals.calories = round(totals.calories, 1)
  for (const field of TOTAL_FIELDS) totals[field] = round(totals[field], field === 'sodiumMg' ? 0 : 1)
  return totals
}

// [{ meal, entries, totals }] in meal order; entries whose meal isn't listed go to Snacks.
export function mealTotals(entries, meals) {
  const order = mealsOf(meals)
  const groups = new Map(order.map((meal) => [meal.id, []]))
  for (const entry of sortDayEntries(entries, order)) groups.get(entryMeal(entry, order)).push(entry)
  return order.map((meal) => ({ meal, entries: groups.get(meal.id), totals: dayTotals(groups.get(meal.id)) }))
}

// Scales the portion (amount, grams) and every nutrient, including extra.* and estimate options.
export function scaleEntry(entry, factor) {
  if (!isObj(entry)) return entry
  const k = num(factor)
  if (k === null || k < 0) return { ...entry }
  const out = { ...entry }
  for (const [field, digits] of Object.entries(ENTRY_NUMBERS)) {
    const value = num(entry[field])
    if (value !== null) out[field] = round(value * k, digits)
  }
  if (isObj(entry.extra)) {
    out.extra = {}
    for (const [key, value] of Object.entries(entry.extra)) {
      const n = num(value)
      out.extra[key] = n === null ? value : round(n * k, extraDigits(key))
    }
  }
  if (Array.isArray(entry.options)) {
    out.options = entry.options.map((option) => {
      if (!isObj(option)) return option
      const scaled = { ...option }
      for (const field of ['calories', 'proteinG', 'carbsG', 'fatG']) {
        const value = num(option[field])
        if (value !== null) scaled[field] = round(value * k, 1)
      }
      return scaled
    })
  }
  return out
}

// ---- entries ------------------------------------------------------------------------------------

function cleanExtra(raw) {
  const out = {}
  if (isObj(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const n = nonNeg(value)
      if (n !== null && key.length <= 40) out[key] = n
    }
  }
  return out
}

function cleanAi(raw) {
  if (!isObj(raw)) return null
  const out = {}
  const query = text(raw.query, 500)
  if (query) out.query = query
  const confidence = num(raw.confidence)
  if (confidence !== null) out.confidence = round(clamp(confidence, 0, 1), 2)
  const assumptions = strings(raw.assumptions, 5, 160)
  if (assumptions.length) out.assumptions = assumptions
  const model = text(raw.model, 60)
  if (model) out.model = model
  if (isObj(raw.original)) out.original = cleanExtra(raw.original)
  return out
}

// A food_entries row with only known fields, numbers coerced and clamped at 0, blank strings as
// null. id/date/time/meal are kept only when usable (null otherwise); callers fill defaults.
export function cleanEntry(raw) {
  const entry = isObj(raw) ? raw : {}
  const minutes = minutesOf(entry.time)
  const out = {
    id: validId(entry.id) ? entry.id : null,
    date: dayOf(entry.date) !== null ? entry.date : null,
    time: minutes === null ? null : hhmmOf(minutes),
    meal: text(entry.meal, 40) || null,
    name: text(entry.name, 120) || null,
    brand: text(entry.brand, 80) || null,
    unit: text(entry.unit, 24) || null,
  }
  for (const field of Object.keys(ENTRY_NUMBERS)) {
    const value = nonNeg(entry[field])
    out[field] = value === null ? null : round(value, 2)
  }
  if (out.amount === 0) out.amount = null
  out.extra = cleanExtra(entry.extra)
  out.note = typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim().slice(0, 1000) : null
  out.source = ENTRY_SOURCES.includes(entry.source) ? entry.source : 'manual'
  out.favoriteId = validId(entry.favoriteId) ? String(entry.favoriteId) : null
  out.ai = cleanAi(entry.ai)
  out.createdAt = typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : null
  return out
}

// The re-loggable part of an entry or favorite: what was eaten and how much (no id, date, meal,
// time, source or AI details).
export function entryTemplate(entry) {
  const clean = cleanEntry(entry)
  const out = { name: clean.name, brand: clean.brand, amount: clean.amount, unit: clean.unit }
  for (const field of Object.keys(ENTRY_NUMBERS)) if (field !== 'amount') out[field] = clean[field]
  out.extra = clean.extra
  out.favoriteId = clean.favoriteId
  return out
}

// ---- portion units ------------------------------------------------------------------------------

// Units that never take an s: abbreviations, sizes (a "large" egg), and foods counted by weight.
const UNIT_AS_IS = new Set([
  'g', 'gr', 'kg', 'mg', 'mcg', 'µg', 'ml', 'l', 'dl', 'cl', 'oz', 'fl', 'lb', 'lbs', 'tbsp', 'tbs', 'tsp', 'kcal', 'cal', 'kj', 'cc',
  'qt', 'pt', 'gal', 'pcs', 'x', 'each', 'ea',
  'small', 'medium', 'large', 'big', 'regular', 'mini', 'jumbo', 'extra', 'xl', 'xxl', 'xs', 'short', 'tall', 'grande', 'venti',
  'trenta', 'kids', 'kid', 'single', 'double', 'triple', 'whole', 'half', 'full', 'standard', 'size', 'sized', 'fun', 'king',
  'bread', 'rice', 'pasta', 'cheese', 'meat', 'fish', 'sushi', 'milk', 'water', 'juice', 'butter', 'oil', 'sugar', 'honey', 'salt',
  'cereal', 'oatmeal', 'popcorn', 'yogurt', 'yoghurt', 'soup', 'chicken', 'beef', 'pork', 'lamb', 'tofu', 'hummus', 'granola', 'dal',
  'daal', 'fruit', 'broccoli', 'spinach', 'lettuce', 'corn', 'garlic', 'food',
])
const UNIT_PLURALS = {
  pc: 'pcs', loaf: 'loaves', leaf: 'leaves', knife: 'knives', potato: 'potatoes', tomato: 'tomatoes', mango: 'mangoes',
  person: 'people', child: 'children', tooth: 'teeth', foot: 'feet',
}
const PARTICIPLE = /[^e]ed$/i // "cooked", "fried" (but "seed" is a noun)

// A counted English word in the plural; null when it doesn't take one (or already is plural).
function pluralWord(word) {
  const lower = word.toLowerCase()
  if (UNIT_AS_IS.has(lower) || !/^[a-z]+$/i.test(word) || word.length < 2 || word === word.toUpperCase()) return null
  if (own(UNIT_PLURALS, lower)) return word.slice(0, 1) + UNIT_PLURALS[lower].slice(1)
  if (PARTICIPLE.test(lower)) return null
  if (/ss$/.test(lower) || /(x|z|ch|sh)$/.test(lower)) return `${word}es`
  if (/s$/.test(lower)) return null // already plural ("slices") or an abbreviation
  if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

// The unit as it reads after the amount: '2 slices', '1.5 cups', '2 large', '3 tbsp', '1 slice',
// '2 cans (355 ml)', '2 slices of bread'. Only amounts above 1 take the plural; abbreviations,
// sizes and words that aren't plain English letters are left as they are.
export function unitFor(amount, unit) {
  const clean = text(unit, 60)
  const n = num(amount)
  if (!clean || n === null || n <= 1) return clean
  // The counted word is the one before a note ("can (355 ml)", "serving, 30 g") or before "of".
  const cut = clean.search(/\s*[(,;/]|\s+of\s/i)
  const head = cut >= 0 ? clean.slice(0, cut) : clean
  let tail = cut >= 0 ? clean.slice(cut) : ''
  if (!head || /\bfl\.?\s*oz\b/i.test(head)) return clean
  const words = head.split(' ')
  const last = words.length - 1
  let plural = pluralWord(words[last])
  if (plural) {
    if (/^\(s\)/i.test(tail)) tail = tail.slice(3) // "piece(s)"
    return [...words.slice(0, last), plural].join(' ') + tail
  }
  // "cup cooked": the counted word comes first.
  if (last > 0 && PARTICIPLE.test(words[last])) {
    plural = pluralWord(words[0])
    if (plural) return [plural, ...words.slice(1)].join(' ') + tail
  }
  return clean
}

// '2 slices', '1.5 cups', '250 ml': the amount (up to 2 decimals, no grouping) and its unit; ''
// when there is no amount.
export function amountText(amount, unit) {
  const n = num(amount)
  if (n === null || n <= 0) return ''
  const shown = String(round(n, 2))
  const word = unitFor(n, unit)
  return word ? `${shown} ${word}` : shown
}

// ---- settings.food ------------------------------------------------------------------------------
// Each part is memoised by the identity of its raw value, and a normalised value maps to itself,
// so unchanged parts keep their identity when another part of settings.food changes.

function memoByRef(build) {
  const cache = new WeakMap()
  let missing
  return (value) => {
    if (!value || typeof value !== 'object') {
      if (missing === undefined) missing = build(undefined)
      return missing
    }
    let out = cache.get(value)
    if (out === undefined) {
      out = build(value)
      cache.set(value, out)
      if (out && typeof out === 'object') cache.set(out, out)
    }
    return out
  }
}

const normalizeGoals = memoByRef((raw) => {
  const goals = isObj(raw) ? raw : {}
  const out = { ...goals }
  for (const key of GOAL_KEYS) {
    const value = num(goals[key])
    out[key] = value !== null && value > 0 && value <= GOAL_MAX[key] ? value : null
  }
  out.source = goals.source === 'calculator' ? 'calculator' : 'manual'
  return out
})

const normalizeProfile = memoByRef((raw) => {
  const p = isObj(raw) ? raw : {}
  const birthYear = numIn(p.birthYear, 1900, 2100)
  return {
    ...p,
    sex: p.sex === 'male' || p.sex === 'female' ? p.sex : null,
    birthYear: birthYear === null ? null : Math.round(birthYear),
    heightCm: numIn(p.heightCm, 50, 272),
    activity: own(ACTIVITY_FACTOR, p.activity) ? p.activity : 'moderate',
    goal: GOALS.includes(p.goal) ? p.goal : 'maintain',
    rateKgPerWeek: numIn(p.rateKgPerWeek, 0, 2) ?? 0.5,
    targetKg: numIn(p.targetKg, 20, 700),
    bodyFatPct: numIn(p.bodyFatPct, 3, 75),
    proteinPerKg: numIn(p.proteinPerKg, 0.8, 3.5),
    fatPct: numIn(p.fatPct, 15, 50) ?? 30,
  }
})

const normalizePrefs = memoByRef((raw) => {
  const p = isObj(raw) ? raw : {}
  const weekStart = num(p.weekStart)
  return {
    ...p,
    meals: normalizeMeals(p.meals),
    energyUnit: p.energyUnit === 'kJ' ? 'kJ' : 'kcal',
    nutrients: Array.isArray(p.nutrients) ? [...new Set(p.nutrients.filter((n) => NUTRIENTS.includes(n)))] : ['protein', 'carbs', 'fat'],
    ring: p.ring === 'eaten' ? 'eaten' : 'remaining',
    aiReview: p.aiReview === 'autoHigh' ? 'autoHigh' : 'always',
    showDetails: p.showDetails === true,
    weekStart: Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 1,
  }
})

function normalizeFavorite(raw) {
  const favorite = {
    ...raw,
    ...entryTemplate(raw),
    id: raw.id,
    name: text(raw.name, 120),
    meal: text(raw.meal, 40) || null,
    aliases: strings(raw.aliases, 20, 60),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null,
    // Where the numbers came from (a label, a barcode lookup, the web, the user…), for trust and reuse.
    source: SAVED_SOURCES.includes(raw.source) ? raw.source : null,
    sourceUrl: typeof raw.sourceUrl === 'string' && /^https?:\/\//i.test(raw.sourceUrl) ? raw.sourceUrl.slice(0, 300) : null,
    barcode: typeof raw.barcode === 'string' && /^\d{6,14}$/.test(raw.barcode) ? raw.barcode : null,
    verifiedAt: typeof raw.verifiedAt === 'string' && raw.verifiedAt ? raw.verifiedAt : null,
  }
  delete favorite.favoriteId
  return favorite
}

const normalizeFavorites = memoByRef((raw) => {
  const out = []
  const ids = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObj(item) || !validId(item.id) || ids.has(item.id)) continue
    ids.add(item.id)
    out.push(normalizeFavorite(item))
    if (out.length >= FAVORITES_MAX) break
  }
  return out
})

function buildFood(raw) {
  return {
    ...raw,
    goals: normalizeGoals(raw.goals),
    profile: normalizeProfile(raw.profile),
    prefs: normalizePrefs(raw.prefs),
    favorites: normalizeFavorites(raw.favorites),
  }
}

const foodCache = new WeakMap()
let emptyFood = null

// settings.food with every default filled in; the same object back for the same input.
export function normalizeFood(raw) {
  if (!isObj(raw)) {
    if (!emptyFood) {
      emptyFood = buildFood({})
      foodCache.set(emptyFood, emptyFood)
    }
    return emptyFood
  }
  let food = foodCache.get(raw)
  if (!food) {
    try {
      food = buildFood(raw)
    } catch {
      food = normalizeFood(null)
    }
    foodCache.set(raw, food)
    foodCache.set(food, food)
  }
  return food
}

// The favorite an entry came from (favoriteId) or matches by name and brand, else null.
export function findFavorite(favorites, entryLike) {
  if (!Array.isArray(favorites) || !isObj(entryLike)) return null
  const byId = validId(entryLike.favoriteId) ? favorites.find((fav) => isObj(fav) && fav.id === entryLike.favoriteId) : null
  if (byId) return byId
  const key = foodKey(entryLike.name, entryLike.brand)
  return key ? favorites.find((fav) => isObj(fav) && foodKey(fav.name, fav.brand) === key) || null : null
}

// Saved foods that match free text ("my protein bar", "2 scoops of gold standard", a barcode), best
// first: exact barcode, then name/brand/alias token overlap. → [{ food, score }] with score 0–1.
export function matchSavedFoods(favorites, query, { limit = 3, min = 0.6 } = {}) {
  if (!Array.isArray(favorites) || typeof query !== 'string' || !query.trim()) return []
  const digits = query.replace(/\D/g, '')
  const words = (value) => normText(value).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter((word) => word.length > 1 && !MATCH_STOP.has(word))
  const queryWords = new Set(words(query).map(singular))
  const out = []
  for (const food of favorites) {
    if (!isObj(food) || !food.name) continue
    if (food.barcode && digits.length >= 8 && digits.includes(food.barcode)) {
      out.push({ food, score: 1 })
      continue
    }
    let best = 0
    for (const label of [food.brand ? `${food.brand} ${food.name}` : food.name, food.name, ...(food.aliases || [])]) {
      const target = words(label).map(singular)
      if (!target.length) continue
      const hits = target.filter((word) => queryWords.has(word)).length
      // All of the saved name's words appear in the text (e.g. "protein bar" in "had my protein bar").
      best = Math.max(best, hits / target.length * (hits >= Math.min(2, target.length) ? 1 : 0.7))
    }
    if (best >= min) out.push({ food, score: Math.round(best * 100) / 100 })
  }
  return out.sort((a, b) => b.score - a.score || str(b.food.updatedAt).localeCompare(str(a.food.updatedAt))).slice(0, limit)
}

const MATCH_STOP = new Set(['my', 'the', 'a', 'an', 'of', 'and', 'with', 'had', 'ate', 'drank', 'some', 'one', 'two', 'three', 'cup', 'cups', 'glass', 'bowl', 'piece', 'pieces', 'slice', 'slices', 'scoop', 'scoops', 'serving', 'servings', 'today', 'just', 'for', 'in', 'on', 'at', 'from'])
const singular = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)

// ---- goal calculator ----------------------------------------------------------------------------

// Body fat as a fraction (accepts 20 or 0.2), when plausible.
function bodyFatFraction(value) {
  const n = num(value)
  if (n === null || n <= 0) return null
  const fraction = n > 1 ? n / 100 : n
  return fraction >= 0.03 && fraction <= 0.75 ? fraction : null
}

function bmrExact(input) {
  const { sex, age, heightCm, weightKg, bodyFatPct } = isObj(input) ? input : {}
  const kg = num(weightKg)
  if (kg === null || kg <= 0) return null
  const fat = bodyFatFraction(bodyFatPct)
  if (fat !== null) return 370 + 21.6 * kg * (1 - fat) // Katch–McArdle
  const cm = num(heightCm)
  const years = num(age)
  if (cm === null || cm <= 0 || years === null || years < 0) return null
  const s = sex === 'male' ? 5 : sex === 'female' ? -161 : -78 // −78: the average of the two
  return 10 * kg + 6.25 * cm - 5 * years + s // Mifflin–St Jeor
}

// kcal/day at rest (whole number), or null when the inputs aren't enough. With body fat % it uses
// Katch–McArdle, otherwise Mifflin–St Jeor.
export function calcBmr(input) {
  const bmr = bmrExact(input)
  return bmr === null ? null : Math.round(bmr)
}

const fmtInt = (value) => groupDigits(Math.round(value))
const fmtKg = (value) => String(round(value, 2))

// Research §3. Returns { calories, protein, carbs, fat, fiber, tdee, bmr, floorApplied, pace,
// warnings, … } where pace is the expected change in kg/week (negative = losing). Loss is blocked
// (maintenance instead) under 18, at BMI < 18.5 or for a goal weight under BMI 18.5; the rate is
// capped at 1 % (lose) or 0.5 % (gain) of body weight a week; the floor is 1200/1500/1350 kcal.
export function calcGoals(profile, options) {
  const raw = isObj(profile) ? profile : {}
  const p = normalizeProfile(raw)
  const opts = isObj(options) ? options : {}
  const kg = numIn(opts.weightKg, 20, 700)
  const todayDay = dayOf(opts.today)
  const year = todayDay !== null ? Number(opts.today.slice(0, 4)) : new Date().getFullYear()
  const ageRaw = p.birthYear !== null ? year - p.birthYear : null
  const age = ageRaw !== null && ageRaw >= 0 && ageRaw <= 120 ? ageRaw : null
  const heightM = p.heightCm !== null ? p.heightCm / 100 : null
  const bmi = kg !== null && heightM ? kg / (heightM * heightM) : null
  const fat = bodyFatFraction(p.bodyFatPct)
  const warnings = []
  const result = {
    calories: null, protein: null, carbs: null, fat: null, fiber: null, tdee: null, bmr: null,
    floorApplied: false, pace: null, warnings, source: 'calculator', goal: p.goal, blocked: false,
    rateKgPerWeek: 0, age, bmi: bmi === null ? null : round(bmi, 1), refKg: null, method: fat !== null ? 'katch' : 'mifflin',
    etaWeeks: null, missing: [],
  }

  if (kg === null) result.missing.push('weight')
  if (fat === null && p.heightCm === null) result.missing.push('height')
  if (fat === null && age === null) result.missing.push('birth year')
  if (result.missing.length) {
    const names = result.missing
    const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
    warnings.push(`Add your ${joined} to calculate a goal.`)
    return result
  }

  const bmr = bmrExact({ sex: p.sex, age, heightCm: p.heightCm, weightKg: kg, bodyFatPct: p.bodyFatPct })
  const tdee = bmr * ACTIVITY_FACTOR[p.activity]

  let goal = p.goal
  if (goal === 'lose') {
    const targetBmi = p.targetKg !== null && heightM ? p.targetKg / (heightM * heightM) : null
    let reason = null
    if (age !== null && age < 18) reason = 'Weight-loss targets aren’t set for under-18s.'
    else if (bmi !== null && bmi < 18.5) reason = 'Your BMI is under 18.5, so there’s no weight-loss target.'
    else if (targetBmi !== null && targetBmi < 18.5) reason = 'That goal weight is under a BMI of 18.5, so there’s no weight-loss target.'
    if (reason) {
      goal = 'maintain'
      result.blocked = true
      warnings.push(`${reason} This shows maintenance instead — talk to a doctor or dietitian about weight loss.`)
    }
  }
  result.goal = goal

  let rate = 0
  if (goal === 'lose' || goal === 'gain') {
    rate = numIn(raw.rateKgPerWeek, 0, 2) ?? DEFAULT_RATE[goal]
    const cap = round((goal === 'lose' ? 0.01 : 0.005) * kg, 2)
    if (rate > cap) {
      rate = cap
      warnings.push(`Pace capped at ${fmtKg(cap)} kg/week (${goal === 'lose' ? '1' : '0.5'}% of your body weight).`)
    }
  }
  result.rateKgPerWeek = rate

  const sign = goal === 'lose' ? -1 : goal === 'gain' ? 1 : 0
  let calories = Math.round((tdee + (sign * rate * KCAL_PER_KG) / 7) / 10) * 10
  const floor = FLOORS[p.sex] ?? FLOOR_UNSPECIFIED
  if (calories < floor) {
    calories = floor
    result.floorApplied = true
  }
  const pace = round(((calories - tdee) * 7) / KCAL_PER_KG, 2)
  if (result.floorApplied) {
    warnings.push(pace < 0
      ? `Capped at ${fmtInt(floor)} kcal. Expected pace ≈ ${fmtKg(Math.abs(pace))} kg/week.`
      : `Raised to the ${fmtInt(floor)} kcal minimum.`)
  }
  if (calories < bmr) warnings.push(`This is below your BMR (${fmtInt(bmr)} kcal), the energy your body uses at rest.`)
  if (p.targetKg !== null) {
    const toGoal = p.targetKg - kg
    if (goal === 'lose' && toGoal >= 0) warnings.push('Your goal weight isn’t below your current weight.')
    if (goal === 'gain' && toGoal <= 0) warnings.push('Your goal weight isn’t above your current weight.')
    if (pace !== 0 && toGoal !== 0 && Math.sign(pace) === Math.sign(toGoal)) result.etaWeeks = round(toGoal / pace, 1)
  }

  // Macros ("Balanced"): protein by g/kg of a reference weight capped at BMI 27, fat by % of kcal
  // with a 0.6 g/kg minimum, carbs the rest.
  const refKg = heightM ? Math.min(kg, 27 * heightM * heightM) : kg
  const perKg = p.proteinPerKg ?? PROTEIN_PER_KG[goal]
  let protein = Math.round(Math.min((0.35 * calories) / 4, Math.max(0.8 * refKg, perKg * refKg)))
  const fatShare = clamp(p.fatPct, 20, 35) / 100
  let fatG = Math.round(Math.max((fatShare * calories) / 9, 0.6 * refKg))
  let carbs = (calories - 4 * protein - 9 * fatG) / 4
  if (carbs < 50) {
    fatG = Math.round((0.2 * calories) / 9)
    carbs = (calories - 4 * protein - 9 * fatG) / 4
    if (carbs < 50) {
      protein = Math.round(Math.min(protein, 1.6 * refKg))
      carbs = (calories - 4 * protein - 9 * fatG) / 4
    }
  }

  return Object.assign(result, {
    calories,
    protein,
    carbs: Math.max(0, Math.round(carbs)),
    fat: fatG,
    fiber: Math.round((14 * calories) / 1000),
    tdee: Math.round(tdee),
    bmr: Math.round(bmr),
    pace,
    refKg: round(refKg, 1),
  })
}

// Goal minus eaten (negative = over); null where there is no goal.
export function remaining(goals, totals) {
  const g = isObj(goals) ? goals : {}
  const t = isObj(totals) ? totals : {}
  const left = (goal, eaten, digits) => {
    const target = num(goal)
    return target === null || target <= 0 ? null : round(target - (nonNeg(eaten) ?? 0), digits)
  }
  return {
    calories: left(g.calories, t.calories, 0),
    proteinG: left(g.protein ?? g.proteinG, t.proteinG, 1),
    carbsG: left(g.carbs ?? g.carbsG, t.carbsG, 1),
    fatG: left(g.fat ?? g.fatG, t.fatG, 1),
    fiberG: left(g.fiber ?? g.fiberG, t.fiberG, 1),
  }
}

// ---- recents, frequent, suggestions -------------------------------------------------------------

function normText(value) {
  let s = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  try {
    s = s.normalize('NFKC')
  } catch {
    // keep as is
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.,;:!?·•…\-–—_*~'"`’)]+$/u, '').trim()
}

// 'name|brand', normalised (lowercase, collapsed spaces, no trailing punctuation); '' without a name.
export function foodKey(name, brand) {
  if (isObj(name)) return foodKey(name.name, name.brand)
  const n = normText(name)
  return n ? `${n}|${normText(brand)}` : ''
}

// Later of two rows: by date, then time, then createdAt.
function isNewer(a, aDay, b, bDay) {
  if (aDay !== bDay) return aDay > bDay
  const ta = minutesOf(a.time) ?? -1
  const tb = minutesOf(b.time) ?? -1
  if (ta !== tb) return ta > tb
  return str(a.createdAt) > str(b.createdAt)
}

function todayDayOf(today) {
  return dayOf(today) ?? localTodayDay()
}

// Named rows dated within the `days` days ending today, grouped by foodKey.
function groupRecent(entries, todayDay, days, onRow) {
  const groups = new Map()
  for (const entry of list(entries)) {
    const day = dayOf(entry.date)
    if (day === null || day > todayDay || day <= todayDay - days) continue
    const key = foodKey(entry.name, entry.brand)
    if (!key) continue
    let group = groups.get(key)
    if (!group) {
      group = { key, entry, day, count: 0, kcal: 0, score: 0 }
      groups.set(key, group)
    } else if (isNewer(entry, day, group.entry, group.day)) {
      group.entry = entry
      group.day = day
    }
    group.count += 1
    group.kcal += entryCalories(entry)
    if (onRow) onRow(group, entry, day)
  }
  return [...groups.values()]
}

const byLastUsed = (a, b) => (isNewer(a.entry, a.day, b.entry, b.day) ? -1 : isNewer(b.entry, b.day, a.entry, a.day) ? 1 : 0)

const templateOf = (group) => ({ ...entryTemplate(group.entry), key: group.key, lastDate: group.entry.date, count: group.count })

const intOption = (value, fallback, min, max) => {
  const n = num(value)
  return n !== null && n >= min && n <= max ? Math.floor(n) : fallback
}

// Newest row per food (its portion and nutrients) from the last `days` days, most recent first.
// Items: entryTemplate fields + { key, lastDate, count }.
export function recents(entries, today, options) {
  const opts = isObj(options) ? options : {}
  const days = intOption(opts.days, 90, 1, MAX_RANGE_DAYS)
  const limit = intOption(opts.limit, 25, 0, 1000)
  return groupRecent(entries, todayDayOf(today), days).sort(byLastUsed).slice(0, limit).map(templateOf)
}

// Foods logged at least `min` times in the last `days` days, most often first.
export function frequent(entries, today, options) {
  const opts = isObj(options) ? options : {}
  const days = intOption(opts.days, 30, 1, MAX_RANGE_DAYS)
  const min = intOption(opts.min, 3, 1, 1000)
  const limit = intOption(opts.limit, 25, 0, 1000)
  return groupRecent(entries, todayDayOf(today), days)
    .filter((group) => group.count >= min)
    .sort((a, b) => b.count - a.count || byLastUsed(a, b))
    .slice(0, limit)
    .map(templateOf)
}

// Research §2.3: score = Σ exp(−ageDays/14) × (same meal ? 1 : 0.3) × (within 2 h of `hhmm` ? 1.5 : 1)
// over the last 30 days. Items: entryTemplate fields + { key, lastDate, count, score }.
export function suggestions(entries, meal, hhmm, today, limit = 3) {
  const todayDay = todayDayOf(today)
  const at = minutesOf(hhmm)
  const mealId = typeof meal === 'string' && meal ? meal : mealForTime(hhmm)
  const max = intOption(limit, 3, 0, 1000)
  const groups = groupRecent(entries, todayDay, 30, (group, entry, day) => {
    const rowTime = minutesOf(entry.time)
    const gap = at !== null && rowTime !== null ? Math.abs(rowTime - at) : null
    const near = gap !== null && Math.min(gap, 1440 - gap) <= 120
    group.score += Math.exp(-(todayDay - day) / 14) * (entry.meal === mealId ? 1 : 0.3) * (near ? 1.5 : 1)
  })
  return groups
    .sort((a, b) => b.score - a.score || b.count - a.count || byLastUsed(a, b))
    .slice(0, max)
    .map((group) => ({ ...templateOf(group), score: round(group.score, 3) }))
}

// ---- weight -------------------------------------------------------------------------------------

// One weigh-in per day (the latest createdAt wins), oldest first, none after maxDay.
function weighIns(bodyWeights, maxDay = Infinity) {
  const byDay = new Map()
  for (const entry of list(bodyWeights)) {
    const day = dayOf(entry.date)
    const kg = num(entry.kg)
    if (day === null || day > maxDay || kg === null || kg <= 0 || kg > 700) continue
    const previous = byDay.get(day)
    if (!previous || str(entry.createdAt) >= previous.createdAt) byDay.set(day, { day, kg, createdAt: str(entry.createdAt) })
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day)
}

// Daily series from the first to the last weigh-in (linear interpolation between them, nothing
// before or after), with prefix sums for the 7-day trend.
function weightModel(bodyWeights, maxDay) {
  const points = weighIns(bodyWeights, maxDay)
  if (!points.length) return null
  const last = points[points.length - 1].day
  const start = Math.max(points[0].day, last - MAX_RANGE_DAYS)
  const size = last - start + 1
  const values = new Array(size)
  const real = new Array(size)
  const sum = [0]
  const realSum = [0]
  let j = 0
  for (let day = start; day <= last; day += 1) {
    while (j + 1 < points.length && points[j + 1].day <= day) j += 1
    const a = points[j]
    const b = points[j + 1]
    const i = day - start
    real[i] = a.day === day
    values[i] = real[i] || !b ? a.kg : a.kg + ((b.kg - a.kg) * (day - a.day)) / (b.day - a.day)
    sum.push(sum[i] + values[i])
    realSum.push(realSum[i] + (real[i] ? 1 : 0))
  }
  const realBetween = (from, to) => {
    const lo = Math.max(from, start)
    const hi = Math.min(to, last)
    return hi < lo ? 0 : realSum[hi - start + 1] - realSum[lo - start]
  }
  // Mean of the series over [day − 6, day] (the days it covers), valid with ≥ 2 real weigh-ins.
  const trendAt = (day) => {
    const lo = Math.max(day - 6, start)
    const hi = Math.min(day, last)
    if (hi < lo || realBetween(lo, hi) < 2) return null
    return (sum[hi - start + 1] - sum[lo - start]) / (hi - lo + 1)
  }
  return { start, last, values, real, trendAt, realBetween }
}

// Least-squares slope of the trend over the 28 days ending at endDay, in kg/week (needs ≥ 4 trend
// points spanning at least a week).
function paceAt(model, endDay) {
  const xs = []
  const ys = []
  for (let day = Math.max(endDay - 27, model.start); day <= Math.min(endDay, model.last); day += 1) {
    const trend = model.trendAt(day)
    if (trend !== null) {
      xs.push(day)
      ys.push(trend)
    }
  }
  if (xs.length < 4 || xs[xs.length - 1] - xs[0] < 7) return null
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  return sxx ? round((sxy / sxx) * 7, 3) : null
}

function eta(trendKg, paceKgPerWeek, targetKg) {
  if (trendKg === null || targetKg === null) return null
  const toGoal = targetKg - trendKg
  if (Math.abs(toGoal) < 0.1) return 0
  if (paceKgPerWeek === null || Math.abs(paceKgPerWeek) < 0.01 || Math.sign(paceKgPerWeek) !== Math.sign(toGoal)) return null
  const weeks = toGoal / paceKgPerWeek
  return weeks > 520 ? null : round(weeks, 1)
}

// Daily kg for each day in [from, to] that lies between two weigh-ins (or on one); no
// extrapolation. [{ date, kg, real }] where real marks an actual weigh-in.
export function weightSeries(bodyWeights, from, to) {
  const model = weightModel(bodyWeights)
  if (!model) return []
  const lo = Math.max(dayOf(from) ?? model.start, model.start)
  const hi = Math.min(dayOf(to) ?? model.last, model.last)
  const out = []
  for (let day = lo; day <= hi; day += 1) {
    out.push({ date: isoOf(day), kg: round(model.values[day - model.start], 2), real: model.real[day - model.start] })
  }
  return out
}

// 7-day trend as of the latest weigh-in on or before today. points: one per day from the first to
// the last weigh-in: { date, kg (the weigh-in, null on days without one), trend (null until the
// window holds 2 weigh-ins), real }. paceKgPerWeek: 28-day least-squares slope of the trend.
// options.targetKg adds etaWeeks / etaDate (0 when already there, null when not heading there).
export function weightTrend(bodyWeights, today, options) {
  const opts = isObj(options) ? options : {}
  const todayDay = todayDayOf(today)
  const out = {
    trendKg: null, trendDate: null, weeklyChangeKg: null, weeklyChangePct: null, paceKgPerWeek: null,
    latestKg: null, latestDate: null, weighIns28: 0, reliable: false, etaWeeks: null, etaDate: null, points: [],
  }
  const model = weightModel(bodyWeights, todayDay)
  if (!model) return out
  const end = model.last
  const trend = model.trendAt(end)
  const weekAgo = model.trendAt(end - 7)
  out.latestKg = round(model.values[end - model.start], 2)
  out.latestDate = isoOf(end)
  out.trendDate = isoOf(end)
  out.trendKg = trend === null ? null : round(trend, 2)
  if (trend !== null && weekAgo !== null) {
    out.weeklyChangeKg = round(trend - weekAgo, 2)
    out.weeklyChangePct = round(((trend - weekAgo) / weekAgo) * 100, 2)
  }
  out.paceKgPerWeek = paceAt(model, end)
  out.weighIns28 = model.realBetween(todayDay - 27, todayDay)
  out.reliable = out.weighIns28 >= 12
  out.etaWeeks = eta(trend, out.paceKgPerWeek, numIn(opts.targetKg, 20, 700))
  if (out.etaWeeks !== null) out.etaDate = isoOf(todayDay + Math.ceil(out.etaWeeks * 7))
  for (let day = model.start; day <= end; day += 1) {
    const i = day - model.start
    const value = model.trendAt(day)
    out.points.push({ date: isoOf(day), kg: model.real[i] ? round(model.values[i], 2) : null, trend: value === null ? null : round(value, 2), real: model.real[i] })
  }
  return out
}

// ---- streak -------------------------------------------------------------------------------------

function streakFrom(daySet, todayDay) {
  const start = daySet.has(todayDay) ? todayDay : todayDay - 1 // an empty today doesn't break it
  let current = 0
  while (daySet.has(start - current)) current += 1
  let longest = 0
  let run = 0
  let previous = null
  for (const day of [...daySet].sort((a, b) => a - b)) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }
  return { current, longest: Math.max(longest, current) }
}

// Consecutive days with at least one entry of any kind, counted back from today (or from
// yesterday while today is still empty), and the longest such run.
export function logStreak(entries, today) {
  const todayDay = todayDayOf(today)
  const days = new Set()
  for (const entry of list(entries)) {
    const day = dayOf(entry.date)
    if (day !== null && day <= todayDay) days.add(day)
  }
  return streakFrom(days, todayDay)
}

// ---- formatting ---------------------------------------------------------------------------------

function groupDigits(value) {
  const n = Math.round(Math.abs(value))
  const digits = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return value < 0 && n !== 0 ? `−${digits}` : digits
}

// kcal in the display unit (kJ or kcal), unrounded.
export function energyInUnit(kcal, unit) {
  const n = num(kcal)
  if (n === null) return null
  return unit === 'kJ' ? n * KJ_PER_KCAL : n
}

// A value typed in the display unit, back to kcal.
export function energyToKcal(value, unit) {
  const n = num(value)
  if (n === null) return null
  return unit === 'kJ' ? n / KJ_PER_KCAL : n
}

// '1,240 kcal' | '5,188 kJ'; '—' when there is no number.
export function formatEnergy(kcal, unit) {
  const value = energyInUnit(kcal, unit)
  if (value === null) return '—'
  return `${groupDigits(value)} ${unit === 'kJ' ? 'kJ' : 'kcal'}`
}

function signed(value, digits) {
  const fixed = Math.abs(value).toFixed(digits)
  return value < 0 ? `−${fixed}` : `+${fixed}`
}

// ---- weekly insights ----------------------------------------------------------------------------

function entriesByDay(entries) {
  const byDay = new Map()
  for (const entry of list(entries)) {
    const day = dayOf(entry.date)
    if (day === null) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(entry)
  }
  return byDay
}

function nutrientStats(days, field, target) {
  const n = days.length
  const total = days.reduce((sum, day) => sum + day[field], 0)
  const avg = n ? round(total / n, 1) : null
  return {
    avgG: avg,
    targetG: target,
    pct: target && avg !== null ? Math.round((avg / target) * 100) : null,
    hitDays: target ? days.filter((day) => day[field] >= target).length : 0,
    closeDays: target ? days.filter((day) => day[field] >= 0.9 * target && day[field] < target).length : 0,
  }
}

const dayStatus = (value, target, close) => {
  if (!target) return null
  if (close) return value >= target ? 'hit' : value >= 0.9 * target ? 'close' : 'miss'
  return Math.abs(value - target) <= 0.1 * target ? 'on' : value > target ? 'over' : 'under'
}

function pickDay(days, score, direction) {
  let best = null
  for (const day of days) {
    const value = score(day)
    if (!best) best = { day, value }
    else if (direction * (value - best.value) > 1e-9 || (Math.abs(value - best.value) <= 1e-9 && day.proteinG > best.day.proteinG)) best = { day, value }
  }
  return best ? best.day : null
}

const dayRef = (day, goal) => (day
  ? { date: day.date, calories: day.calories, proteinG: day.proteinG, diffPct: goal ? Math.round(((day.calories - goal) / goal) * 100) : null }
  : null)

function weekStats(byDay, model, goals, startDay, todayDay, opts) {
  const goal = goals.calories
  const endDay = startDay + 6
  const days = []
  for (let i = 0; i < 7; i += 1) {
    const day = startDay + i
    const totals = dayTotals(byDay.get(day) || [])
    const logged = totals.counted > 0
    const included = logged && day < todayDay // today is excluded while it is still in progress
    days.push({
      date: isoOf(day),
      calories: totals.calories,
      proteinG: totals.proteinG,
      carbsG: totals.carbsG,
      fatG: totals.fatG,
      fiberG: totals.fiberG,
      count: totals.count,
      logged,
      included,
      inProgress: day === todayDay,
      future: day > todayDay,
      maybeIncomplete: !!goal && logged && totals.calories < 0.5 * goal,
      calorieStatus: logged ? dayStatus(totals.calories, goal, false) : null,
      proteinStatus: logged ? dayStatus(totals.proteinG, goals.protein, true) : null,
      fiberStatus: logged ? dayStatus(totals.fiberG, goals.fiber, true) : null,
    })
  }
  const counted = days.filter((day) => day.included)
  const loggedDays = counted.length
  const totalKcal = round(counted.reduce((sum, day) => sum + day.calories, 0), 1)
  const avgKcal = loggedDays ? Math.round(totalKcal / loggedDays) : null

  // Macro split from entries that have protein, carbs and fat; shown when they cover ≥ 50 % of kcal.
  let p = 0
  let c = 0
  let f = 0
  let coveredKcal = 0
  for (const day of counted) {
    for (const entry of byDay.get(dayOf(day.date)) || []) {
      const protein = nonNeg(entry.proteinG)
      const carbs = nonNeg(entry.carbsG)
      const fat = nonNeg(entry.fatG)
      if (protein === null || carbs === null || fat === null) continue
      p += protein
      c += carbs
      f += fat
      coveredKcal += entryCalories(entry)
    }
  }
  const energy = 4 * p + 4 * c + 9 * f
  const coverage = totalKcal > 0 ? round(Math.min(1, coveredKcal / totalKcal), 2) : 0
  const show = coverage >= 0.5 && energy > 0
  const proteinPct = show ? Math.round((400 * p) / energy) : null
  const fatPct = show ? Math.round((900 * f) / energy) : null

  // Top foods and biggest sources over the week so far (today included).
  const foods = new Map()
  let weekKcal = 0
  for (let day = startDay; day <= Math.min(endDay, todayDay); day += 1) {
    for (const entry of byDay.get(day) || []) {
      const kcal = entryCalories(entry)
      weekKcal += kcal
      const key = foodKey(entry.name, entry.brand)
      if (!key) continue
      const food = foods.get(key) || { key, name: text(entry.name, 120), brand: text(entry.brand, 80) || null, count: 0, kcal: 0 }
      food.count += 1
      food.kcal += kcal
      foods.set(key, food)
    }
  }
  const foodList = [...foods.values()].map((food) => ({ ...food, kcal: round(food.kcal, 1) }))

  // Weight as of the end of the week (or today).
  const weightEnd = Math.min(endDay, todayDay)
  const trend = model ? model.trendAt(weightEnd) : null
  const weekAgo = model ? model.trendAt(weightEnd - 7) : null
  const pace = model ? paceAt(model, weightEnd) : null
  const weighInCount = model ? model.realBetween(startDay, weightEnd) : 0

  const closest = goal ? pickDay(counted, (day) => Math.abs(day.calories - goal) / goal, -1) : null
  const furthest = goal && loggedDays > 1 ? pickDay(counted, (day) => Math.abs(day.calories - goal) / goal, 1) : null

  return {
    weekStart: isoOf(startDay),
    weekEnd: isoOf(endDay),
    complete: endDay < todayDay,
    elapsedDays: clamp(todayDay - startDay, 0, 7),
    loggedDays,
    days,
    totalKcal,
    avgKcal,
    goalKcal: goal,
    budgetKcal: goal && loggedDays ? Math.round(goal * loggedDays - totalKcal) : null,
    onTargetDays: counted.filter((day) => day.calorieStatus === 'on').length,
    overDays: counted.filter((day) => day.calorieStatus === 'over').length,
    underDays: counted.filter((day) => day.calorieStatus === 'under').length,
    protein: nutrientStats(counted, 'proteinG', goals.protein),
    fiber: nutrientStats(counted, 'fiberG', goals.fiber),
    macroSplit: { proteinPct, carbsPct: show ? 100 - proteinPct - fatPct : null, fatPct, coverage, show },
    weight: {
      trendKg: trend === null ? null : round(trend, 2),
      weeklyChangeKg: trend !== null && weekAgo !== null ? round(trend - weekAgo, 2) : null,
      weeklyChangePct: trend !== null && weekAgo !== null ? round(((trend - weekAgo) / weekAgo) * 100, 2) : null,
      paceKgPerWeek: pace,
      weighIns: weighInCount,
      lowWeighIns: weighInCount < 3,
      etaWeeks: eta(trend, pace, numIn(opts.targetKg, 20, 700)),
    },
    topFoods: foodList.filter((food) => food.count >= 2).sort((a, b) => b.count - a.count || b.kcal - a.kcal).slice(0, 5),
    biggestSources: foodList
      .filter((food) => food.kcal > 0)
      .sort((a, b) => b.kcal - a.kcal || b.count - a.count)
      .slice(0, 3)
      .map((food) => ({ ...food, share: weekKcal > 0 ? round(food.kcal / weekKcal, 3) : 0 })),
    closestDay: dayRef(closest, goal),
    furthestDay: dayRef(furthest, goal),
    highestProteinDay: dayRef(pickDay(counted, (day) => day.proteinG, 1), goal),
    highestKcalDay: dayRef(pickDay(counted, (day) => day.calories, 1), goal),
  }
}

// Adaptive maintenance check (research §5, "should-have"): over the last 14–28 days with ≥ 80 % of
// days logged and ≥ 8 weigh-ins, maintenance ≈ avg kcal − Δtrend × 7700 / days. A suggestion only.
function adaptiveCheck(byDay, model, endDay) {
  if (!model) return null
  let firstFood = Infinity
  for (const [day, entries] of byDay) if (day <= endDay && entries.some(hasEnergy)) firstFood = Math.min(firstFood, day)
  // The trend's first days average fewer weigh-ins (less lag), so start where its window is full.
  let startDay = Math.max(endDay - 27, firstFood, model.start + 6)
  if (!Number.isFinite(startDay)) return null
  while (startDay < endDay && model.trendAt(startDay) === null) startDay += 1
  const days = endDay - startDay + 1
  if (days < 14) return null
  let loggedDays = 0
  let kcal = 0
  for (let day = startDay; day <= endDay; day += 1) {
    const totals = dayTotals(byDay.get(day) || [])
    if (totals.counted > 0) {
      loggedDays += 1
      kcal += totals.calories
    }
  }
  const weighInCount = model.realBetween(startDay, endDay)
  const first = model.trendAt(startDay)
  const last = model.trendAt(endDay)
  if (loggedDays < 0.8 * days || weighInCount < 8 || first === null || last === null) return null
  const avgKcal = kcal / loggedDays
  const change = last - first
  return {
    tdeeKcal: Math.round((avgKcal - (change * KCAL_PER_KG) / (endDay - startDay)) / 10) * 10,
    days,
    loggedDays,
    weighIns: weighInCount,
    avgKcal: Math.round(avgKcal),
    trendChangeKg: round(change, 2),
  }
}

// Templated sentences (no AI), e.g. "Averaged 2,050 kcal — 160 under goal on 6 logged days."
function summarize(week, opts) {
  const unit = opts.energyUnit === 'kJ' ? 'kJ' : 'kcal'
  const lines = []
  const n = week.loggedDays
  const days = n === 1 ? 'day' : 'days'
  if (!n) {
    if (week.complete) lines.push('No calories were logged this week.')
    else lines.push(week.elapsedDays ? 'No calories logged yet this week.' : 'The week has just started — check back tomorrow.')
  } else {
    const avg = formatEnergy(week.avgKcal, unit)
    if (week.goalKcal) {
      const diff = Math.round(energyInUnit(week.avgKcal - week.goalKcal, unit))
      lines.push(diff === 0
        ? `Averaged ${avg} — right on goal over ${n} logged ${days}.`
        : `Averaged ${avg} — ${groupDigits(Math.abs(diff))} ${diff < 0 ? 'under' : 'over'} goal on ${n} logged ${days}.`)
      lines.push(`On target ${week.onTargetDays} of ${n} ${days}.`)
    } else {
      lines.push(`Averaged ${avg} on ${n} logged ${days}.`)
    }
    const { protein, fiber } = week
    if (protein.avgG > 0) lines.push(protein.pct !== null ? `Protein ${groupDigits(protein.avgG)} g (${protein.pct}%).` : `Protein ${groupDigits(protein.avgG)} g a day.`)
    if (fiber.pct !== null && fiber.avgG > 0) lines.push(`Fiber ${groupDigits(fiber.avgG)} g (${fiber.pct}%).`)
  }
  const { weight } = week
  if (weight.weeklyChangeKg !== null) {
    const lb = opts.weightUnit === 'lb'
    const change = round(lb ? weight.weeklyChangeKg * LB_PER_KG : weight.weeklyChangeKg, 1)
    lines.push(change === 0 ? 'Weight trend steady this week.' : `Weight trend ${signed(change, 1)} ${lb ? 'lb' : 'kg'} this week.`)
  } else if (weight.weighIns > 0 && weight.weighIns < 3) {
    lines.push('Weigh in 3×/week for a reliable trend.')
  }
  return lines
}

// Research §5 for the week starting weekStartIso (default: this week, starting on
// options.weekStart, Monday unless set). Today is left out of averages while it is in progress.
// options: { targetKg, energyUnit, weightUnit, weekStart }. Returns the week's metrics (see
// weekStats), vsLastWeek, streak, adaptive (or null) and summary: string[] of templated sentences.
export function weeklyInsights(entries, bodyWeights, goals, weekStartIso, today, options) {
  const opts = isObj(options) ? options : {}
  const todayDay = todayDayOf(today)
  const firstWeekday = intOption(opts.weekStart, 1, 0, 6)
  const startDay = dayOf(weekStartIso) ?? todayDay - ((((weekdayOf(todayDay) - firstWeekday) % 7) + 7) % 7)
  const g = normalizeGoals(goals)
  const byDay = entriesByDay(entries)
  const model = weightModel(bodyWeights, todayDay)
  const week = weekStats(byDay, model, g, startDay, todayDay, opts)
  const last = weekStats(byDay, model, g, startDay - 7, todayDay, opts)
  const delta = (a, b, digits = 0) => (a == null || b == null ? null : round(a - b, digits))
  return {
    ...week,
    vsLastWeek: {
      avgKcal: delta(week.avgKcal, last.avgKcal),
      avgProteinG: delta(week.protein.avgG, last.protein.avgG, 1),
      onTargetDays: g.calories ? week.onTargetDays - last.onTargetDays : null,
      trendKg: delta(week.weight.trendKg, last.weight.trendKg, 2),
    },
    streak: logStreak(entries, isoOf(todayDay)),
    adaptive: adaptiveCheck(byDay, model, Math.min(startDay + 6, todayDay - 1)),
    summary: summarize(week, opts),
  }
}

// ---- AI estimate post-processing ----------------------------------------------------------------

const ITEM_LIMITS = {
  amount: [0, 10000, 2],
  grams: [0, 20000, 1],
  calories: [0, 5000, 0],
  proteinG: [0, 1000, 1],
  carbsG: [0, 2000, 1],
  fatG: [0, 1000, 1],
  fiberG: [0, 500, 1],
  sugarG: [0, 2000, 1],
  sodiumMg: [0, 50000, 0],
  alcoholG: [0, 1000, 1],
  caffeineMg: [0, 5000, 0],
  satFatG: [0, 500, 1],
}

function clampField(value, field) {
  const n = num(value)
  if (n === null) return null
  const [min, max, digits] = ITEM_LIMITS[field]
  return round(clamp(n, min, max), digits)
}

// camelCase first, then the model's snake_case name.
const pick = (raw, camel, snake) => (raw[camel] !== undefined && raw[camel] !== null ? raw[camel] : raw[snake])

function clampOption(raw) {
  return {
    label: text(raw.label, 60) || 'Option',
    calories: clampField(raw.calories, 'calories'),
    proteinG: clampField(pick(raw, 'proteinG', 'protein_g'), 'proteinG'),
    carbsG: clampField(pick(raw, 'carbsG', 'carbs_g'), 'carbsG'),
    fatG: clampField(pick(raw, 'fatG', 'fat_g'), 'fatG'),
  }
}

// Research §4 post-processing for one estimate item (EstimateItem, or the model's snake_case
// output): clamps (kcal 0–5000, nothing negative), rounding (kcal whole, grams 0.1, mg whole) and
// the energy check — when stated kcal and 4P + 4(C − fiber) + 2·fiber + 9F + 7·alcohol differ by
// more than max(15 %, 25 kcal), locked or branded calories are kept with confidence −0.1,
// otherwise calories become the macro value. Apply once per estimate (the penalty isn't idempotent).
export function clampEstimateItem(item) {
  const raw = isObj(item) ? item : {}
  const extra = isObj(raw.extra) ? raw.extra : {}
  const positive = (value) => (value !== null && value > 0 ? value : null)
  const locked = strings(pick(raw, 'locked', 'user_specified'), 8, 20) // field names, kept as given
  const caloriesLocked = locked.some((field) => field.toLowerCase() === 'calories')
  const mealHint = pick(raw, 'mealHint', 'meal_hint')
  const confidence = num(raw.confidence)
  const out = {
    name: text(raw.name, 80) || 'Food',
    brand: text(raw.brand, 60) || null,
    amount: positive(clampField(pick(raw, 'amount', 'quantity'), 'amount')),
    unit: text(raw.unit, 30) || null,
    grams: positive(clampField(raw.grams, 'grams')),
    calories: clampField(raw.calories, 'calories'),
    proteinG: clampField(pick(raw, 'proteinG', 'protein_g'), 'proteinG'),
    carbsG: clampField(pick(raw, 'carbsG', 'carbs_g'), 'carbsG'),
    fatG: clampField(pick(raw, 'fatG', 'fat_g'), 'fatG'),
    fiberG: clampField(pick(raw, 'fiberG', 'fiber_g'), 'fiberG'),
    sugarG: clampField(pick(raw, 'sugarG', 'sugar_g'), 'sugarG'),
    sodiumMg: clampField(pick(raw, 'sodiumMg', 'sodium_mg'), 'sodiumMg'),
    extra: {
      alcoholG: clampField(pick(extra, 'alcoholG', 'alcohol_g') ?? pick(raw, 'alcoholG', 'alcohol_g'), 'alcoholG'),
      caffeineMg: clampField(pick(extra, 'caffeineMg', 'caffeine_mg') ?? pick(raw, 'caffeineMg', 'caffeine_mg'), 'caffeineMg'),
      satFatG: clampField(pick(extra, 'satFatG', 'sat_fat_g') ?? pick(raw, 'satFatG', 'sat_fat_g'), 'satFatG'),
    },
    confidence: confidence === null ? 0.5 : round(clamp(confidence, 0, 1), 2),
    assumptions: strings(raw.assumptions, 3, 140),
    locked,
    options: (Array.isArray(raw.options) ? raw.options : []).filter(isObj).slice(0, 3).map(clampOption),
    mealHint: MEAL_IDS.includes(mealHint) ? mealHint : null,
  }
  const fromMacros = out.proteinG !== null && out.carbsG !== null && out.fatG !== null ? macroCalories(out) : null
  if (out.calories === null) {
    if (fromMacros !== null) out.calories = clampField(fromMacros, 'calories')
  } else if (fromMacros !== null && Math.abs(out.calories - fromMacros) > Math.max(0.15 * out.calories, 25)) {
    if (caloriesLocked || out.brand) out.confidence = round(Math.max(0, out.confidence - 0.1), 2)
    else out.calories = clampField(fromMacros, 'calories')
  }
  return out
}

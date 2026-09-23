import { useMemo } from 'react'
import { toast } from '../../components/ui/feedback.jsx'
import { apiRequest } from '../api.js'
import { isISODate, nowTimeHHMM, todayISO } from '../dates.js'
import { getGym, useGym } from '../gym/state.js'
import { getState, newId, updateData, updateSettings, useStore } from '../store.js'
import {
  ENTRY_SOURCES, FAVORITES_MAX, GOAL_KEYS, cleanEntry, entryMeal, entryTemplate, foodKey, macroCalories, mealForTime, normalizeFood,
  sortDayEntries,
} from './nutrition.js'

// Client glue for the food tracker: tolerant reads of settings.food and the foodEntries list,
// and actions that save through the shared store (list actions return an undo). Body weight is
// the gym's bodyWeights list, re-exported here so food pages have one import.

export { addBodyWeight, deleteBodyWeight, latestBodyWeight, useBodyWeights, useToday } from '../gym/state.js'

const KEY = 'foodEntries'
const EMPTY = Object.freeze([])
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const validId = (id) => (typeof id === 'string' && id !== '') || isFiniteNumber(id)
const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)
const nowIso = () => new Date().toISOString()
const replaceAt = (list, index, item) => list.map((current, i) => (i === index ? item : current))
const insertAt = (list, index, item) => [...list.slice(0, Math.max(0, index)), item, ...list.slice(Math.max(0, index))]
const rawList = () => (Array.isArray(getState().data[KEY]) ? getState().data[KEY] : EMPTY)

// An undo function that also carries the rows it concerns (e.g. for a "Logged 3 items" toast).
const withEntries = (undo, entries) => Object.assign(undo, { entries })

// ---- settings.food ---------------------------------------------------------------------------

const rawFood = () => {
  const food = getState().data.settings?.food
  return isPlainObject(food) ? food : {}
}
const selectFood = (state) => normalizeFood(state.data.settings?.food)

export function useFood() {
  return useStore(selectFood)
}

export function getFood() {
  return selectFood(getState())
}

const LOADING = 'Still loading your data — try again in a moment.'

// Until the user's data has loaded, settings.food here is an empty stand-in; writing it would
// replace the saved goals and favorites on the server.
function requireLoaded() {
  if (!getState().hydrated) throw new Error(LOADING)
}

// patchOrFn: a partial of settings.food, or (normalisedFood) => partial. Only the direct children
// it returns (goals, profile, prefs, favorites…) are replaced, so the store sends just those.
// Does nothing until the data has loaded.
export function updateFood(patchOrFn) {
  if (!getState().hydrated) return
  const raw = rawFood()
  const patch = typeof patchOrFn === 'function' ? patchOrFn(getFood()) : patchOrFn
  if (!isPlainObject(patch) || !Object.keys(patch).some((key) => patch[key] !== raw[key])) return
  updateSettings({ food: { ...raw, ...patch } })
}

// Merges the given goal fields (undefined = keep, null or ≤ 0 = no goal). source defaults to
// 'manual'. Returns an undo.
export function setGoals(goals) {
  if (!isPlainObject(goals)) return () => {}
  const before = getFood().goals
  let changed = false
  updateFood((food) => {
    const next = { ...food.goals }
    for (const key of GOAL_KEYS) {
      if (goals[key] === undefined) continue
      const value = typeof goals[key] === 'number' || typeof goals[key] === 'string' ? Number(goals[key]) : NaN
      next[key] = Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null
    }
    next.source = goals.source === 'calculator' ? 'calculator' : 'manual'
    changed = !sameJson(next, food.goals)
    return changed ? { goals: next } : null
  })
  return () => {
    if (changed) updateFood({ goals: before })
  }
}

// ---- favorites ---------------------------------------------------------------------------------

// Saves a template (name, portion, nutrients) from an entry, estimate item or favorite. One per
// food: an existing favorite with the same name and brand (or the same id) is replaced, keeping its
// id and aliases (options.aliases adds more). Newest first, at most 150. Returns the saved favorite.
export function saveFavorite(entryLike, options) {
  requireLoaded() // callers use the returned favorite, which updateFood wouldn't produce yet
  const { aliases } = isPlainObject(options) ? options : {}
  if (!isPlainObject(entryLike)) throw new Error('Nothing to save.')
  const template = entryTemplate(entryLike)
  delete template.favoriteId
  const key = foodKey(template.name, template.brand)
  if (!key) throw new Error('Add a name to save this as a favorite.')
  let saved = null
  updateFood((food) => {
    const byId = validId(entryLike.id) ? food.favorites.findIndex((fav) => fav.id === entryLike.id) : -1
    const index = byId >= 0 ? byId : food.favorites.findIndex((fav) => foodKey(fav.name, fav.brand) === key)
    const previous = index >= 0 ? food.favorites[index] : null
    const extraAliases = [...(Array.isArray(entryLike.aliases) ? entryLike.aliases : []), ...(Array.isArray(aliases) ? aliases : [])]
    const names = [...(previous?.aliases || []), ...extraAliases]
      .filter((alias) => typeof alias === 'string')
      .map((alias) => alias.trim().slice(0, 60))
    saved = {
      ...template,
      id: previous?.id || newId(),
      meal: null,
      aliases: [...new Set(names.filter(Boolean))].slice(0, 20),
      updatedAt: nowIso(),
    }
    const rest = food.favorites.filter((fav, i) => i !== index && foodKey(fav.name, fav.brand) !== key)
    return { favorites: [saved, ...rest].slice(0, FAVORITES_MAX) }
  })
  return saved
}

// Returns an undo.
export function deleteFavorite(id) {
  const favorites = getFood().favorites
  const index = favorites.findIndex((fav) => fav.id === id)
  if (index < 0) return () => {}
  const favorite = favorites[index]
  updateFood((food) => ({ favorites: food.favorites.filter((fav) => fav.id !== id) }))
  return () => updateFood((food) => (food.favorites.some((fav) => fav.id === id) ? null : { favorites: insertAt(food.favorites, index, favorite) }))
}

// ---- entries -----------------------------------------------------------------------------------

// Rows with an id and a date string, first of each id; the same array back when all are fine.
const entryCache = new WeakMap()

function entryList(raw) {
  if (!Array.isArray(raw)) return EMPTY
  let out = entryCache.get(raw)
  if (!out) {
    const ids = new Set()
    const ok = (entry) => {
      if (!isPlainObject(entry) || !validId(entry.id) || typeof entry.date !== 'string' || ids.has(entry.id)) return false
      ids.add(entry.id)
      return true
    }
    const kept = raw.filter(ok)
    out = kept.length === raw.length ? raw : kept
    entryCache.set(raw, out)
  }
  return out
}

const selectEntries = (state) => entryList(state.data[KEY])

// All entries, in store order (newest additions first).
export function useFoodEntries() {
  return useStore(selectEntries)
}

export function getFoodEntries() {
  return selectEntries(getState())
}

// Entries of one day in meal order, then by time.
export function dayEntries(entries, date, meals) {
  return sortDayEntries(entryList(entries).filter((entry) => entry.date === date), meals)
}

export function useDayEntries(date) {
  const entries = useFoodEntries()
  const { meals } = useFood().prefs
  return useMemo(() => dayEntries(entries, date, meals), [entries, date, meals])
}

// A meal id that exists in the user's meals (Snacks, or the last meal, otherwise).
function pickMeal(id, meals) {
  return entryMeal({ meal: id }, meals)
}

// A new row from anything entry-like; null when it has neither a name nor calories. Calories
// missing but macros given: calories from the macros.
function prepareEntry(raw, { today, now, createdAt, meals, taken }) {
  if (!isPlainObject(raw)) return null
  const clean = cleanEntry(raw)
  if (clean.calories === null) {
    const fromMacros = macroCalories(clean)
    if (fromMacros !== null) clean.calories = Math.round(fromMacros)
  }
  if (!clean.name && clean.calories === null) return null
  const date = clean.date || today
  const time = clean.time || (date === today ? now : null)
  const meal = meals.some((item) => item.id === clean.meal) ? clean.meal : pickMeal(time ? mealForTime(time) : 'snack', meals)
  const id = validId(clean.id) && !taken.has(clean.id) ? clean.id : newId()
  return { ...clean, id, date, time, meal, createdAt }
}

function removeIds(ids) {
  updateData(KEY, (list) => (Array.isArray(list) && list.some((entry) => ids.has(entry?.id)) ? list.filter((entry) => !ids.has(entry?.id)) : list))
}

// Adds rows (newest first). Defaults: date today; time now when the date is today; meal from the
// time (Snacks without one); source 'manual'. Rows with neither a name nor calories are skipped.
// Returns an undo that removes exactly these rows (undo.entries = the saved rows). With toastLabel,
// shows that message with an Undo button.
export function addEntries(entries, options) {
  const { toastLabel } = isPlainObject(options) ? options : {}
  const input = Array.isArray(entries) ? entries : isPlainObject(entries) ? [entries] : []
  const context = {
    today: todayISO(),
    now: nowTimeHHMM(),
    createdAt: nowIso(),
    meals: getFood().prefs.meals,
    taken: new Set(rawList().map((entry) => entry?.id)),
  }
  const rows = []
  for (const raw of input) {
    const row = prepareEntry(raw, context)
    if (!row) continue
    context.taken.add(row.id)
    rows.push(row)
  }
  if (!rows.length) return withEntries(() => {}, [])
  updateData(KEY, (list) => [...rows, ...(Array.isArray(list) ? list : [])])
  const ids = new Set(rows.map((row) => row.id))
  const undo = () => removeIds(ids)
  if (typeof toastLabel === 'string' && toastLabel) toast(toastLabel, { action: { label: 'Undo', onClick: undo } })
  return withEntries(undo, rows)
}

// patch: fields to change, or (entry) => fields. Returns an undo (reverts only if the row is
// still as this edit left it).
export function updateEntry(id, patch) {
  const list = rawList()
  const index = list.findIndex((entry) => isPlainObject(entry) && entry.id === id)
  if (index < 0) return () => {}
  const previous = list[index]
  const changes = typeof patch === 'function' ? patch(previous) : patch
  if (!isPlainObject(changes)) return () => {}
  const merged = cleanEntry({ ...previous, ...changes })
  if (merged.calories === null && ('proteinG' in changes || 'carbsG' in changes || 'fatG' in changes || 'calories' in changes || 'extra' in changes)) {
    const fromMacros = macroCalories(merged)
    if (fromMacros !== null) merged.calories = Math.round(fromMacros)
  }
  const next = {
    ...previous,
    ...merged,
    id: previous.id,
    date: merged.date || previous.date,
    meal: merged.meal || previous.meal || null,
    createdAt: previous.createdAt ?? merged.createdAt,
  }
  if (Object.keys(next).every((key) => sameJson(next[key] ?? null, previous[key] ?? null))) return () => {}
  updateData(KEY, (current) => {
    const items = Array.isArray(current) ? current : []
    const at = items.findIndex((entry) => entry?.id === id)
    return at < 0 ? current : replaceAt(items, at, next)
  })
  return () => updateData(KEY, (current) => {
    const items = Array.isArray(current) ? current : []
    const at = items.findIndex((entry) => entry?.id === id)
    return at < 0 || items[at] !== next ? current : replaceAt(items, at, previous)
  })
}

// Returns an undo that puts the same row back (if it isn't there again already).
export function deleteEntry(id) {
  const list = rawList()
  const index = list.findIndex((entry) => entry?.id === id)
  if (index < 0) return () => {}
  const entry = list[index]
  updateData(KEY, (current) => (Array.isArray(current) ? current.filter((item) => item?.id !== id) : current))
  return () => updateData(KEY, (current) => {
    const items = Array.isArray(current) ? current : []
    return items.some((item) => item?.id === id) ? current : insertAt(items, index, entry)
  })
}

// Copies rows to another date with new ids and source 'copy' (meal and time kept unless meal given).
function copyRows(rows, to, meal) {
  const createdAt = nowIso()
  const copies = rows.map((row) => ({ ...cleanEntry(row), id: newId(), date: to, meal: meal || row.meal || null, source: 'copy', createdAt }))
  if (!copies.length) return withEntries(() => {}, [])
  updateData(KEY, (list) => [...copies, ...(Array.isArray(list) ? list : [])])
  const ids = new Set(copies.map((row) => row.id))
  return withEntries(() => removeIds(ids), copies)
}

// Copies every entry of `from` to `to`. Returns an undo (undo.entries empty: nothing to copy).
export function copyDay(from, to) {
  if (!isISODate(from) || !isISODate(to)) throw new Error('Choose a valid date.')
  const { meals } = getFood().prefs
  return copyRows(dayEntries(rawList(), from, meals), to)
}

// Copies one meal of `from` to `to` (into the same meal, or toMeal). Returns an undo.
export function copyMeal(from, meal, to, toMeal) {
  if (!isISODate(from) || !isISODate(to)) throw new Error('Choose a valid date.')
  const { meals } = getFood().prefs
  const source = pickMeal(meal, meals)
  const rows = dayEntries(rawList(), from, meals).filter((entry) => entryMeal(entry, meals) === source)
  return copyRows(rows, to, pickMeal(toMeal || source, meals))
}

// ---- AI estimates ------------------------------------------------------------------------------

// The server's own messages (JSON { error }) say what went wrong — a busy AI service, no credit, a
// retired model — so they are shown as they are. These stand in only when the reply wasn't the
// app's JSON (Vercel's own 413 page, a gateway error). A 429 means the daily cap only with
// code 'daily_limit'; otherwise OpenAI was busy for a moment.
const ESTIMATE_ERRORS = {
  413: 'That’s too large to send. Try a smaller photo or a shorter recording.',
  429: 'The AI service is busy right now. Try again in a moment.',
  503: 'AI food estimates aren’t available right now. Add it by hand for now.',
}
const DAILY_LIMIT_TEXT = 'You’ve used today’s AI food estimates. Add it by hand, or try again tomorrow.'
const ESTIMATE_TEXT_MAX = 1000 // api/food.js MAX_TEXT_CHARS

function estimateErrorMessage(error) {
  const status = typeof error?.status === 'number' ? error.status : null
  const payload = isPlainObject(error?.payload) ? error.payload : {}
  if (status === 429 && payload.code === 'daily_limit') return DAILY_LIMIT_TEXT
  const fromServer = typeof payload.error === 'string' && payload.error.trim() && !/^Server error \(/.test(payload.error) ? payload.error.trim() : ''
  return fromServer || ESTIMATE_ERRORS[status] || error?.message || 'Couldn’t estimate that. Please try again.'
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

// POST /api/food. previous: the items of an earlier estimate, for a "Fix" correction. Resolves to
// { items: EstimateItem[], clarify, notFood, transcript? }; throws an Error with a friendly
// message (and .status, .code) on failure, or the AbortError when `signal` aborts.
export async function estimateFood(input) {
  const { text, image, audio, mimeType, meal, date, previous, signal } = isPlainObject(input) ? input : {}
  const today = todayISO()
  const day = isISODate(date) ? date : today
  const body = { action: 'estimate', date: day }
  // Over the server's limit, the start goes (a clarify reply is appended to the end).
  if (typeof text === 'string' && text.trim()) body.text = text.trim().slice(-ESTIMATE_TEXT_MAX).trim()
  if (typeof image === 'string' && image) body.image = image
  if (typeof audio === 'string' && audio) {
    body.audio = audio
    if (typeof mimeType === 'string' && mimeType) body.mimeType = mimeType
  }
  if (!body.text && !body.image && !body.audio) throw new Error('Describe what you ate, or add a photo.')
  if (day === today) body.time = nowTimeHHMM()
  if (typeof meal === 'string' && meal) body.meal = meal
  if (Array.isArray(previous) && previous.length) body.previous = previous.filter(isPlainObject).slice(0, 20)
  const timeZone = localTimeZone()
  if (timeZone) body.context = { timeZone }

  let response
  try {
    response = await apiRequest('/api/food', { method: 'POST', body, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const friendly = new Error(estimateErrorMessage(error))
    friendly.status = typeof error?.status === 'number' ? error.status : null
    friendly.code = isPlainObject(error?.payload) && typeof error.payload.code === 'string' ? error.payload.code : null
    throw friendly
  }
  const result = isPlainObject(response) ? response : {}
  return {
    items: Array.isArray(result.items) ? result.items.filter(isPlainObject) : [],
    clarify: typeof result.clarify === 'string' && result.clarify.trim() ? result.clarify.trim() : null,
    notFood: result.notFood === true,
    ...(typeof result.transcript === 'string' ? { transcript: result.transcript } : {}),
  }
}

const numOrNull = (value) => (isFiniteNumber(value) ? value : null)

// Estimate items → entry rows for addEntries. meal falls back to the item's mealHint (then to
// addEntries' default); source defaults to 'ai_text'; ai keeps { query, confidence, assumptions }.
export function itemsToEntries(items, options) {
  const { date, meal, time, source, query } = isPlainObject(options) ? options : {}
  const rowSource = ENTRY_SOURCES.includes(source) ? source : 'ai_text'
  return (Array.isArray(items) ? items : []).filter(isPlainObject).map((item) => {
    const extra = {}
    if (isPlainObject(item.extra)) for (const [key, value] of Object.entries(item.extra)) if (isFiniteNumber(value)) extra[key] = value
    const ai = {}
    if (typeof query === 'string' && query.trim()) ai.query = query.trim().slice(0, 500)
    if (isFiniteNumber(item.confidence)) ai.confidence = item.confidence
    ai.assumptions = Array.isArray(item.assumptions) ? item.assumptions.filter((line) => typeof line === 'string') : []
    const row = {
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null,
      brand: typeof item.brand === 'string' && item.brand.trim() ? item.brand.trim() : null,
      amount: numOrNull(item.amount),
      unit: typeof item.unit === 'string' && item.unit ? item.unit : null,
      grams: numOrNull(item.grams),
      calories: numOrNull(item.calories),
      proteinG: numOrNull(item.proteinG),
      carbsG: numOrNull(item.carbsG),
      fatG: numOrNull(item.fatG),
      fiberG: numOrNull(item.fiberG),
      sugarG: numOrNull(item.sugarG),
      sodiumMg: numOrNull(item.sodiumMg),
      extra,
      source: rowSource,
      ai,
    }
    if (isISODate(date)) row.date = date
    const rowMeal = (typeof meal === 'string' && meal) || (typeof item.mealHint === 'string' && item.mealHint) || null
    if (rowMeal) row.meal = rowMeal
    if (typeof time === 'string' && time) row.time = time
    if (validId(item.favoriteId)) row.favoriteId = item.favoriteId
    return row
  })
}

// ---- weight unit -------------------------------------------------------------------------------

// Shared with the gym: settings.gym.prefs.unit.
export function weightUnit() {
  return getGym().prefs.unit || 'kg'
}

export function useWeightUnit() {
  return useGym().prefs.unit || 'kg'
}

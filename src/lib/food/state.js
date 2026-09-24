import { useMemo } from 'react'
import { toast } from '../../components/ui/feedback.jsx'
import { apiRequest } from '../api.js'
import { isISODate, nowTimeHHMM, todayISO } from '../dates.js'
import { getGym, useGym } from '../gym/state.js'
import { getState, newId, updateData, updateSettings, useStore } from '../store.js'
import {
  ENTRY_SOURCES, FAVORITES_MAX, GOAL_KEYS, SAVED_SOURCES, cleanEntry, entryMeal, entryTemplate, foodKey, macroCalories, mealForTime, normalizeFood,
  scaleEntry, sortDayEntries,
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

// ---- favorites ("My foods") ----------------------------------------------------------------------
// settings.food.favorites: saved foods with the numbers for their saved portion, plus where those
// numbers came from (source 'label' | 'barcode' | 'web' | 'user' | 'estimate' | 'entry', sourceUrl,
// barcode, verifiedAt). The estimate endpoint reuses them when the food is mentioned again.

const aliasList = (value) => (Array.isArray(value) ? value.filter((alias) => typeof alias === 'string') : [])

// Trimmed, unique (ignoring case), not the name itself, at most 20.
function cleanAliases(names, name) {
  const seen = new Set([typeof name === 'string' ? name.trim().toLowerCase() : ''])
  const out = []
  for (const raw of names) {
    const alias = raw.trim().slice(0, 60)
    const key = alias.toLowerCase()
    if (!alias || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
  }
  return out.slice(0, 20)
}

// The where-from fields given in `raw` (only those present; invalid values become null).
function savedMeta(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  if (raw.source !== undefined) out.source = SAVED_SOURCES.includes(raw.source) ? raw.source : null
  if (raw.sourceUrl !== undefined) out.sourceUrl = typeof raw.sourceUrl === 'string' && /^https?:\/\//i.test(raw.sourceUrl.trim()) ? raw.sourceUrl.trim().slice(0, 300) : null
  if (raw.barcode !== undefined) {
    const digits = typeof raw.barcode === 'string' || isFiniteNumber(raw.barcode) ? String(raw.barcode).replace(/\D/g, '') : ''
    out.barcode = /^\d{6,14}$/.test(digits) ? digits : null
  }
  if (raw.verifiedAt !== undefined) out.verifiedAt = typeof raw.verifiedAt === 'string' && raw.verifiedAt ? raw.verifiedAt : null
  return out
}

// A food's numbers moved to a saved food's portion when the two compare (same unit with amounts,
// or both by weight), so "2 bars" updates a food saved as "1 bar" at 1 bar; otherwise as it is.
function atPortionOf(food, saved) {
  if (!isPlainObject(saved)) return food
  const amount = (item) => (isFiniteNumber(item.amount) && item.amount > 0 ? item.amount : null)
  const grams = (item) => (isFiniteNumber(item.grams) && item.grams > 0 ? item.grams : null)
  const unit = (item) => (typeof item.unit === 'string' ? item.unit.trim().toLowerCase() : '')
  let factor = null
  if (amount(food) && amount(saved) && unit(food) === unit(saved)) factor = amount(saved) / amount(food)
  else if (!amount(food) && !amount(saved) && grams(food) && grams(saved)) factor = grams(saved) / grams(food)
  if (!factor || Math.abs(factor - 1) < 0.001) return food
  return { ...scaleEntry(food, factor), unit: food.unit ?? saved.unit }
}

// Puts a food into `list` (newest first) and returns { list, saved, previous }. It replaces the saved
// food with options.id, else the one with the same name and brand (keeping its id, aliases and
// where-from details unless options give new ones). options: { id, aliases, source, sourceUrl,
// barcode, verifiedAt, keepName (keep the saved food's name; the given name becomes an alias),
// samePortion (store the numbers at the saved food's portion when they compare) }.
function upsertFavorite(list, entryLike, options) {
  const opts = isPlainObject(options) ? options : {}
  if (!isPlainObject(entryLike)) throw new Error('Nothing to save.')
  const wantId = validId(opts.id) ? opts.id : validId(entryLike.id) ? entryLike.id : null
  const byId = wantId !== null ? list.findIndex((fav) => fav.id === wantId) : -1
  const target = byId >= 0 ? list[byId] : null
  let food = entryLike
  const extraNames = []
  if (target && opts.keepName && typeof target.name === 'string' && target.name) {
    if (typeof food.name === 'string' && food.name.trim()) extraNames.push(food.name)
    food = { ...food, name: target.name, brand: typeof food.brand === 'string' && food.brand.trim() ? food.brand : target.brand }
  }
  if (target && opts.samePortion) food = atPortionOf(food, target)
  const template = entryTemplate(food)
  delete template.favoriteId
  const key = foodKey(template.name, template.brand)
  if (!key) throw new Error('Add a name to save this as a favorite.')
  const index = byId >= 0 ? byId : list.findIndex((fav) => foodKey(fav.name, fav.brand) === key)
  const previous = index >= 0 ? list[index] : null
  const meta = savedMeta(opts)
  if (!previous && meta.source === undefined) meta.source = 'entry'
  const saved = {
    ...(previous || {}),
    ...template,
    ...meta,
    id: previous?.id || newId(),
    meal: null,
    aliases: cleanAliases([...(previous?.aliases || []), ...aliasList(entryLike.aliases), ...aliasList(opts.aliases), ...extraNames], template.name),
    updatedAt: nowIso(),
  }
  const rest = list.filter((fav, i) => i !== index && foodKey(fav.name, fav.brand) !== key)
  return { list: [saved, ...rest].slice(0, FAVORITES_MAX), saved, previous }
}

// Saves a template (name, portion, nutrients) from an entry, estimate item or favorite. One per
// food: an existing favorite with the same name and brand (or the same id) is replaced, keeping its
// id and aliases (options.aliases adds more) and where its numbers came from (unless options give
// source, sourceUrl, barcode or verifiedAt). Newest first, at most FAVORITES_MAX. Returns the saved
// favorite.
export function saveFavorite(entryLike, options) {
  requireLoaded() // callers use the returned favorite, which updateFood wouldn't produce yet
  if (!isPlainObject(entryLike)) throw new Error('Nothing to save.')
  const opts = isPlainObject(options) ? options : {}
  let saved = null
  updateFood((food) => {
    const result = upsertFavorite(food.favorites, entryLike, { ...opts, id: undefined })
    saved = result.saved
    return { favorites: result.list }
  })
  return saved
}

// Saves several foods to My foods in one settings write. requests: [{ food, id?, aliases?, source?,
// sourceUrl?, barcode?, verifiedAt?, keepName?, samePortion? }] (see upsertFavorite; one without a
// name is skipped). Returns an undo (undo.saved = the saved favorite or null, in request order)
// that puts back what each one replaced, unless it has been changed again since.
export function rememberFoods(requests) {
  requireLoaded()
  const input = Array.isArray(requests) ? requests : []
  const done = []
  if (input.length) {
    updateFood((food) => {
      let list = food.favorites
      for (const request of input) {
        let result = null
        if (isPlainObject(request) && isPlainObject(request.food)) {
          const { food: item, ...options } = request
          try {
            result = upsertFavorite(list, item, options)
            list = result.list
          } catch {
            result = null // nothing to save it by (no name)
          }
        }
        done.push(result)
      }
      return { favorites: list }
    })
  }
  const undo = () => updateFood((food) => {
    let list = food.favorites
    let changed = false
    for (const { saved, previous } of done.filter(Boolean).reverse()) {
      const at = list.findIndex((fav) => fav.id === saved.id)
      if (at < 0 || list[at].updatedAt !== saved.updatedAt) continue
      list = previous ? replaceAt(list, at, previous) : list.filter((_, i) => i !== at)
      changed = true
    }
    return changed ? { favorites: list } : null
  })
  return Object.assign(undo, { saved: done.map((result) => result?.saved ?? null) })
}

// Changes a saved food: patch is fields to change (name, brand, amount, unit, grams, nutrients,
// extra, aliases, source, sourceUrl, barcode, verifiedAt) or (favorite) => fields. Throws when the
// new name and brand belong to another saved food. Returns an undo (reverts only while the food is
// still as this edit left it).
export function updateFavorite(id, patch) {
  requireLoaded()
  const favorites = getFood().favorites
  const index = favorites.findIndex((fav) => fav.id === id)
  if (index < 0) throw new Error('That food isn’t in My foods any more.')
  const previous = favorites[index]
  const changes = typeof patch === 'function' ? patch(previous) : patch
  if (!isPlainObject(changes)) return () => {}
  const merged = { ...previous, ...changes }
  const template = entryTemplate(merged)
  delete template.favoriteId
  const key = foodKey(template.name, template.brand)
  if (!key) throw new Error('Add a name.')
  const clash = favorites.find((fav, i) => i !== index && foodKey(fav.name, fav.brand) === key)
  if (clash) throw new Error(`“${clash.name}${clash.brand ? ` (${clash.brand})` : ''}” is already in My foods.`)
  const next = {
    ...previous,
    ...template,
    ...savedMeta(changes),
    id: previous.id,
    aliases: changes.aliases !== undefined ? cleanAliases(aliasList(changes.aliases), template.name) : previous.aliases,
    updatedAt: nowIso(),
  }
  if (Object.keys(next).every((field) => field === 'updatedAt' || sameJson(next[field] ?? null, previous[field] ?? null))) return () => {}
  updateFood((food) => {
    const at = food.favorites.findIndex((fav) => fav.id === id)
    return at < 0 ? null : { favorites: replaceAt(food.favorites, at, next) }
  })
  return () => updateFood((food) => {
    const at = food.favorites.findIndex((fav) => fav.id === id)
    return at < 0 || food.favorites[at].updatedAt !== next.updatedAt ? null : { favorites: replaceAt(food.favorites, at, previous) }
  })
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

function friendlyError(error, message) {
  const friendly = new Error(message)
  friendly.status = typeof error?.status === 'number' ? error.status : null
  friendly.code = isPlainObject(error?.payload) && typeof error.payload.code === 'string' ? error.payload.code : null
  return friendly
}

// POST /api/food. previous: the items of an earlier estimate, for a "Fix" correction. skipSaved:
// estimate afresh instead of reusing My foods. Text of only 8–14 digits is looked up as a barcode
// (so is a photo sent with the text 'barcode'). Resolves to { items: EstimateItem[], clarify,
// notFood, transcript?, lookup? } — each item also carries basis ('estimate' | 'label' | 'menu' |
// 'saved' | 'barcode' | 'web'), savedFoodId, source and barcode; lookup: { type: 'barcode',
// barcode, found, url? }. Throws an Error with a friendly message (and .status, .code) on failure,
// or the AbortError when `signal` aborts.
export async function estimateFood(input) {
  const { text, image, audio, mimeType, meal, date, previous, skipSaved, signal } = isPlainObject(input) ? input : {}
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
  if (skipSaved === true) body.skipSaved = true
  const timeZone = localTimeZone()
  if (timeZone) body.context = { timeZone }

  let response
  try {
    response = await apiRequest('/api/food', { method: 'POST', body, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw friendlyError(error, estimateErrorMessage(error))
  }
  const result = isPlainObject(response) ? response : {}
  return {
    items: Array.isArray(result.items) ? result.items.filter(isPlainObject) : [],
    clarify: typeof result.clarify === 'string' && result.clarify.trim() ? result.clarify.trim() : null,
    notFood: result.notFood === true,
    ...(typeof result.transcript === 'string' ? { transcript: result.transcript } : {}),
    ...(isPlainObject(result.lookup) ? { lookup: result.lookup } : {}),
  }
}

// ---- web lookups -------------------------------------------------------------------------------

// settings.assistantWeb, shared with the assistant: 'ask' (default: search only on a tap),
// 'always' or 'off' (no web buttons at all).
export const WEB_MODES = Object.freeze(['ask', 'always', 'off'])
const WEB_OFF_TEXT = 'Web search is off in Settings.'
const selectWeb = (state) => {
  const value = state.data.settings?.assistantWeb
  return WEB_MODES.includes(value) ? value : 'ask'
}

export function useWebSetting() {
  return useStore(selectWeb)
}

export function getWebSetting() {
  return selectWeb(getState())
}

export function setWebSetting(value) {
  if (!WEB_MODES.includes(value) || getWebSetting() === value) return
  updateSettings({ assistantWeb: value })
}

// POST /api/food { action: 'web' }: exact numbers for one food from the web (costs a little per
// call, so only on an explicit tap). item: the estimate item it's for (portion and context).
// Resolves to { items (one item, basis 'web'), webFound, message }; throws a friendly Error
// (code 'web_off' when web search is turned off) or the AbortError.
export async function webLookupFood(input) {
  const { query, item, date, meal, signal } = isPlainObject(input) ? input : {}
  const words = typeof query === 'string' ? query.trim().slice(0, 500) : ''
  if (!words) throw new Error('Nothing to look up.')
  if (getWebSetting() === 'off') {
    const off = new Error(WEB_OFF_TEXT)
    off.code = 'web_off'
    throw off
  }
  const body = { action: 'web', query: words, date: isISODate(date) ? date : todayISO() }
  if (isPlainObject(item)) body.item = Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_')))
  if (typeof meal === 'string' && meal) body.meal = meal

  let response
  try {
    response = await apiRequest('/api/food', { method: 'POST', body, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const code = isPlainObject(error?.payload) ? error.payload.code : null
    throw friendlyError(error, code === 'web_off' ? WEB_OFF_TEXT : estimateErrorMessage(error))
  }
  const result = isPlainObject(response) ? response : {}
  const items = Array.isArray(result.items) ? result.items.filter(isPlainObject) : []
  return {
    items,
    webFound: result.webFound === true && items.length > 0,
    message: typeof result.message === 'string' && result.message.trim() ? result.message.trim() : null,
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
    else if (validId(item.savedFoodId)) row.favoriteId = item.savedFoodId
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

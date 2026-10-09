// One-tap food shortcuts: chips for a meal (the Food page's empty meals and the Health card),
// "Same as <day>" for a meal, and the quick-add tray's running total. Pure (no React, no store),
// so tests can run it.

import { addDaysISO } from '../dates.js'
import { entryCalories, entryMeal, foodKey, suggestions } from './nutrition.js'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [])

// meal id → Set of the food keys ever logged in it, worked out in one pass per entries list and
// shared by every meal's chips (and the Health card) until the list changes (a new array).
const mealKeysCache = new WeakMap()
function mealFoodKeys(entries, rows) {
  const cacheable = Array.isArray(entries)
  let byMeal = cacheable ? mealKeysCache.get(entries) : undefined
  if (!byMeal) {
    byMeal = new Map()
    for (const entry of rows) {
      if (!byMeal.has(entry.meal)) byMeal.set(entry.meal, new Set())
      byMeal.get(entry.meal).add(foodKey(entry.name, entry.brand))
    }
    if (cacheable) mealKeysCache.set(entries, byMeal)
  }
  return byMeal
}

// Up to `limit` foods to log into one meal with a tap: the suggestions scored for this meal and
// its usual time (hhmm) that were logged in this meal before, minus foods already in it on `date`.
export function mealChips(entries, mealId, { hhmm, today, date = today, meals, limit = 3 } = {}) {
  const rows = list(entries)
  const inMeal = mealFoodKeys(entries, rows).get(mealId) || new Set()
  const already = new Set(rows
    .filter((entry) => entry.date === date && entryMeal(entry, meals) === mealId)
    .map((entry) => foodKey(entry.name, entry.brand)))
  return suggestions(rows, mealId, hhmm, today, 8)
    .filter((item) => inMeal.has(item.key) && !already.has(item.key))
    .slice(0, Math.max(0, limit))
}

// The latest day in the `days` days before `date` with anything logged in this meal:
// { date, rows, kcal }, or null. rows are what copyMeal(day, mealId, date) copies.
export function lastMealDay(entries, mealId, date, meals, { days = 14 } = {}) {
  if (!ISO_RE.test(date || '')) return null
  const from = addDaysISO(date, -days)
  const inMeal = list(entries).filter((entry) => ISO_RE.test(entry.date || '') && entry.date < date && entry.date >= from && entryMeal(entry, meals) === mealId)
  if (!inMeal.length) return null
  const day = inMeal.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), inMeal[0].date)
  const rows = inMeal.filter((entry) => entry.date === day)
  return { date: day, rows, kcal: rows.reduce((sum, entry) => sum + entryCalories(entry), 0) }
}

// The quick-add tray's items logged since it opened ([{ kcal, meal, date }]) → { count, kcal,
// meal, date }: meal / date when every item went to the same one, else null.
export function addedSummary(items) {
  const rows = list(items)
  const same = (key) => (rows.length && rows.every((item) => item[key] === rows[0][key]) ? rows[0][key] ?? null : null)
  return {
    count: rows.length,
    kcal: rows.reduce((sum, item) => sum + (Number.isFinite(item.kcal) && item.kcal > 0 ? item.kcal : 0), 0),
    meal: same('meal'),
    date: same('date'),
  }
}

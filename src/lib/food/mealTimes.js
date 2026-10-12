// The owner's own meal times, learned from what they log: when each meal (custom meals too) is
// usually logged, so "the meal of the moment" follows their habits — breakfast logged around 11:30
// is still Breakfast at 11:45 — and per-meal suggestions on other days use that meal's usual time.
// Nothing is stored: it is worked out from the food entries. Too little data (fewer than 3 days
// with that meal) or scattered times fall back to the fixed windows (mealForTime). Pure (no React,
// no store, no browser APIs), so tests and the server can use it.

import { addDaysISO, isISODate, nowTimeHHMM, todayISO, toISO } from '../dates.js'
import { entryMeal, mealForTime } from './nutrition.js'

const DAY_START = 4 * 60 // the meal day starts at 04:00 (as in mealForTime)
const MIN_DAYS = 3 // days with the meal logged before its time counts
const MAX_SPREAD = 90 // median distance from the usual time, minutes; more scattered = not a habit
const REACH = 120 // a learned time claims the minutes up to 2 h either side of it…
const NEAR = 60 // …but only 1 h when the fixed window's meal has no learned time to compare with

// A representative time per default meal (the fallback for per-meal suggestions on other days).
export const FIXED_MEAL_TIMES = Object.freeze({ breakfast: '08:00', lunch: '12:30', dinner: '19:00', snack: '15:30' })

const pad = (n) => String(n).padStart(2, '0')
const hhmmOf = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

function minutesOf(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(typeof value === 'string' ? value.trim() : '')
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour > 23 || minute > 59 ? null : hour * 60 + minute
}

// Minutes since 04:00, so a late snack at 00:30 sorts after 23:00 rather than before breakfast.
const shift = (minutes) => (minutes - DAY_START + 1440) % 1440
const unshift = (minutes) => (Math.round(minutes) + DAY_START) % 1440

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const gap = (a, b) => {
  const d = Math.abs(a - b) % 1440
  return Math.min(d, 1440 - d)
}

// The local day an ISO timestamp falls on, or null.
function localDay(iso) {
  if (typeof iso !== 'string' || !iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : toISO(date)
}

// { [mealId]: { at: 'HH:MM', minutes, days, spread } } for meals logged on at least 3 of the last
// `days` days at a steady time. Only rows whose time is real count: copies and rows added on a
// later day (they get a stand-in time) are skipped. Each day counts once per meal, at its first row.
// meals: the user's meals (rows of other meals are ignored); omitted = any meal id.
export function learnMealTimes(entries, { days = 30, today = todayISO(), meals } = {}) {
  const ids = Array.isArray(meals) && meals.length ? new Set(meals.map((meal) => meal?.id)) : null
  const from = isISODate(today) ? addDaysISO(today, -(Math.max(1, days) - 1)) : null
  const first = new Map() // `${meal}|${date}` → earliest shifted minutes
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const { meal, date } = entry
    if (typeof meal !== 'string' || !meal || (ids && !ids.has(meal))) continue
    if (!isISODate(date) || (from && (date < from || date > today))) continue
    if (entry.source === 'copy') continue
    const minutes = minutesOf(entry.time)
    if (minutes === null) continue
    const logged = localDay(entry.createdAt)
    if (logged && logged !== date) continue
    const key = `${meal}|${date}`
    const at = shift(minutes)
    if (!first.has(key) || at < first.get(key)) first.set(key, at)
  }
  const byMeal = new Map()
  for (const [key, at] of first) {
    const meal = key.slice(0, key.lastIndexOf('|'))
    if (!byMeal.has(meal)) byMeal.set(meal, [])
    byMeal.get(meal).push(at)
  }
  const out = {}
  for (const [meal, times] of byMeal) {
    if (times.length < MIN_DAYS) continue
    const mid = median(times)
    const spread = median(times.map((t) => Math.abs(t - mid)))
    if (spread > MAX_SPREAD) continue
    const minutes = unshift(mid)
    out[meal] = { at: hhmmOf(minutes), minutes, days: times.length, spread: Math.round(spread) }
  }
  return out
}

// The meal id for a time of day (minutes after midnight, or 'HH:MM'): the meal whose learned time
// is nearest (within 2 h), else `fallback` (default: the fixed window, mealForTime). A learned
// meal only takes over from a fallback meal that has no learned time of its own when it is within
// 1 h, so a meal logged a few times doesn't swallow the hours around it.
export function mealForNow(time, learned, fallback) {
  const minutes = typeof time === 'number' && Number.isFinite(time) ? ((Math.round(time) % 1440) + 1440) % 1440 : minutesOf(time)
  const fixed = typeof fallback === 'string' && fallback ? fallback : mealForTime(minutes === null ? null : hhmmOf(minutes))
  if (minutes === null || !learned || typeof learned !== 'object') return fixed
  let best = null
  for (const [id, item] of Object.entries(learned)) {
    if (!item || !Number.isFinite(item.minutes)) continue
    const distance = gap(minutes, item.minutes)
    if (!best || distance < best.distance) best = { id, distance }
  }
  if (!best || best.distance > REACH || best.id === fixed) return fixed
  if (learned[fixed]) return best.id
  return best.distance <= NEAR ? best.id : fixed
}

// The meal of the moment, as one of `meals` (Snacks, or the last meal, when it isn't one).
export function nowMeal(meals, learned, hhmm = nowTimeHHMM()) {
  return entryMeal({ meal: mealForNow(hhmm, learned) }, meals)
}

// A meal's usual time ('HH:MM'): learned, else the fixed one for a default meal, else null.
export function mealClock(id, learned) {
  return learned?.[id]?.at || FIXED_MEAL_TIMES[id] || null
}

// learnMealTimes, worked out once per entries list (a new array after every change), day and meals.
const cache = new WeakMap()
export function learnedMealTimes(entries, meals, today = todayISO()) {
  if (!Array.isArray(entries)) return {}
  const key = `${today}|${Array.isArray(meals) ? meals.map((meal) => meal?.id).join(',') : ''}`
  const hit = cache.get(entries)
  if (hit && hit.key === key) return hit.value
  const value = learnMealTimes(entries, { today, meals })
  cache.set(entries, { key, value })
  return value
}

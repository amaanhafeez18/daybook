import { diffDays, isISODate } from '../dates.js'
import { entryCalories, foodKey, normalizeFood, recents } from './nutrition.js'

// Food coach nudges for Health → Today, and when the Goals page offers a measured-maintenance
// update. Pure (no React, no store): the cards pass in what they show.

const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}
const round5 = (value) => Math.round(value / 5) * 5

// Generic high-protein ideas, used when nothing saved or recent fits. Tapping one fills the food
// box with `text` (never sends: an AI estimate costs money).
export const PROTEIN_IDEAS = Object.freeze([
  { name: 'Greek yogurt', text: 'Greek yogurt 200 g', proteinG: 20, calories: 130 },
  { name: 'Cottage cheese', text: 'Cottage cheese 200 g', proteinG: 24, calories: 180 },
  { name: 'Protein shake', text: 'Protein shake', proteinG: 25, calories: 130 },
  { name: 'Tuna', text: 'Tuna, 1 can', proteinG: 25, calories: 120 },
  { name: 'Chicken breast', text: 'Chicken breast 150 g', proteinG: 45, calories: 250 },
  { name: '3 eggs', text: '3 eggs', proteinG: 19, calories: 215 },
  { name: 'Edamame', text: 'Edamame 150 g', proteinG: 17, calories: 180 },
].map((idea) => Object.freeze(idea)))

// { protein, weighIn }: which nudges are on (settings.food.prefs.nudges; both default on).
export function nudgePrefs(food) {
  const nudges = normalizeFood(food).prefs.nudges
  return { protein: nudges?.protein !== false, weighIn: nudges?.weighIn !== false }
}

const fitsBudget = (kcal, calLeft) => calLeft === null || kcal <= Math.max(calLeft, 0) + 100

// The best food to suggest for `leftG` grams of protein still to go with `calLeft` kcal left (null
// = no calorie goal): from `pool` (saved foods, then recent ones), items with 10 g+ protein, at
// least 35 % of their energy from protein and within the calories left (+100); closest to
// covering what's left, then most often eaten. → { name, template, saved: true }, else a generic
// idea { name, text, saved: false }, else null.
export function pickProteinIdea(leftG, calLeft, pool) {
  const left = finite(leftG) ?? 0
  const budget = finite(calLeft)
  const byKey = new Map()
  for (const item of Array.isArray(pool) ? pool : []) {
    if (!isObj(item) || typeof item.name !== 'string' || !item.name.trim()) continue
    const key = foodKey(item.name, item.brand)
    if (!key) continue
    const count = finite(item.count) ?? 0
    const seen = byKey.get(key)
    if (seen) seen.count = Math.max(seen.count, count)
    else byKey.set(key, { item, count })
  }
  const candidates = []
  for (const { item, count } of byKey.values()) {
    const protein = finite(item.proteinG) ?? 0
    const kcal = entryCalories(item)
    if (protein < 10 || !(kcal > 0) || (4 * protein) / kcal < 0.35 || !fitsBudget(kcal, budget)) continue
    candidates.push({ item, count, gap: Math.abs(Math.min(protein, left) - left) })
  }
  candidates.sort((a, b) => a.gap - b.gap || b.count - a.count)
  if (candidates.length) {
    const { item } = candidates[0]
    return { name: item.name.trim(), template: item, saved: true }
  }
  const idea = PROTEIN_IDEAS.find((option) => fitsBudget(option.calories, budget))
  return idea ? { name: idea.name, text: idea.text, saved: false } : null
}

// The evening protein nudge: null, or { leftG (rounded to 5), idea (pickProteinIdea or null) }.
// Shows from 18:00 until 23:00 when there's a protein goal, at least 2 rows are logged today with
// at least 40 % of the calorie goal (or 600 kcal without one), and at least max(20 g, 15 % of the
// goal) is still to go. totals: dayTotals of today; nowMinutes: minutes since midnight.
export function proteinNudge(input) {
  const { goals, totals, rowsToday, nowMinutes, entries, favorites, today } = isObj(input) ? input : {}
  const goal = finite(goals?.protein)
  if (goal === null || goal <= 0) return null
  const minutes = finite(nowMinutes)
  if (minutes === null || minutes < 1080 || minutes >= 1380) return null
  const rows = Array.isArray(rowsToday) ? rowsToday.length : finite(rowsToday) ?? 0
  if (rows < 2) return null
  const eaten = finite(totals?.calories) ?? 0
  const calGoal = finite(goals?.calories)
  const hasCalGoal = calGoal !== null && calGoal > 0
  if (hasCalGoal ? eaten < 0.4 * calGoal : eaten < 600) return null
  const left = goal - (finite(totals?.proteinG) ?? 0)
  if (left < Math.max(20, 0.15 * goal)) return null
  const leftG = round5(left)
  const pool = [...(Array.isArray(favorites) ? favorites : []), ...recents(entries, today, { days: 30, limit: 200 })]
  return { leftG, idea: pickProteinIdea(leftG, hasCalGoal ? calGoal - eaten : null, pool) }
}

// The weigh-in reminder: { days } since the last weigh-in when that's 4–30 days ago and there
// have been at least 2 weigh-in days (future dates ignored), else null.
export function weighInNudge(bodyWeights, today) {
  if (!isISODate(today)) return null
  const days = new Set()
  for (const row of Array.isArray(bodyWeights) ? bodyWeights : []) {
    if (!isObj(row) || !isISODate(row.date) || row.date > today) continue
    const kg = finite(row.kg)
    if (kg !== null && kg > 0) days.add(row.date)
  }
  if (days.size < 2) return null
  const latest = [...days].sort().pop()
  const since = diffDays(latest, today)
  return since >= 4 && since <= 30 ? { days: since } : null
}

const isDay = (value) => typeof value === 'string' && isISODate(value)

// Whether the Goals card offers "Update my goal" for `plan` (goalFromMaintenance) and measured
// maintenance `kcal`: 'none' (no plan), 'fits' (under 100 kcal from the goal), 'snoozed' (after
// "Not now", until the estimate moves 100 kcal or 14 days pass; after an update, 14 days unless
// the goal would move 150 kcal or more) or 'offer'. maintenance: settings.food.coach.maintenance.
export function maintenanceOffer(plan, kcal, maintenance, today) {
  if (!isObj(plan)) return 'none'
  if (plan.same) return 'fits'
  const state = isObj(maintenance) ? maintenance : {}
  const valid = isDay(today)
  const diff = finite(plan.diffKcal)
  if (valid && isDay(state.appliedOn) && diffDays(state.appliedOn, today) < 14 && diff !== null && diff < 150) return 'snoozed'
  const dismissedKcal = finite(state.dismissedKcal)
  const measured = finite(kcal)
  if (valid && isDay(state.dismissedOn) && diffDays(state.dismissedOn, today) < 14
    && (dismissedKcal === null || measured === null || Math.abs(measured - dismissedKcal) < 100)) return 'snoozed'
  return 'offer'
}

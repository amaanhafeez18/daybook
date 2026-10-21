import { addDaysISO, isISODate } from './dates.js'
import { weightTrend } from './food/nutrition.js'
import { addDays, weekStart } from './gym/schedule.js'
import { fromKg } from './gym/units.js'

// One weigh-in, the same everywhere (Health Today, Food Today, Gym Today, Gym Progress, Food → Weight):
// the latest weigh-in, its date, and ONE change figure — the smoothed weekly trend from weightTrend
// (7-day average now vs a week earlier), so every screen shows the same number for the same morning.
// Pure: no React, no browser APIs. Weights in kg; the screens convert to the user's unit.

// The ranges both weight charts offer (Food → Weight and Gym → Progress).
export const WEIGHT_RANGES = [
  { id: '1m', label: '1M', days: 31 },
  { id: '3m', label: '3M', days: 92 },
  { id: '1y', label: '1Y', days: 366 },
  { id: 'all', label: 'All', days: null },
]
export const DEFAULT_WEIGHT_RANGE = '3m'

// First day (ISO) a range shows, counting today as its last day; null for 'all' (or unknown ids).
export function rangeStart(rangeId, today) {
  const days = WEIGHT_RANGES.find((range) => range.id === rangeId)?.days
  if (!days || !isISODate(today)) return null
  return addDaysISO(today, -(days - 1))
}

const SPARK_DAYS = 30
// Weigh-ins spanning this many days with still no weekly change means they're too far apart
// (the trend needs 2 weigh-ins in each 7-day window), not that the person has only just started.
const SPARSE_SPAN_DAYS = 14

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

// The summary the shared WeighIn component shows, or null with no weigh-in on or before today.
//   latestKg / latestDate  the newest weigh-in (as logged, not smoothed)
//   weeklyChangeKg         weightTrend's smoothed weekly change (null until there's enough data)
//   direction              'down' | 'up' | 'steady' | null (no change yet), decided by the change
//                          as shown (rounded to 0.1 in `unit`), so it agrees with Food → Weight
//   noTrend                why there's no change yet: 'new' (just started) | 'sparse' (weigh-ins
//                          too far apart) | null (there is one)
//   spark                  the smoothed trend over the last 30 days, oldest first (kg); without a
//                          trend line, the weigh-ins themselves from those 30 days
export function weighInSummary(bodyWeights, today, unit = 'kg') {
  if (!isISODate(today)) return null
  const trend = weightTrend(bodyWeights, today)
  if (!isNum(trend.latestKg) || !trend.latestDate) return null
  const change = isNum(trend.weeklyChangeKg) ? trend.weeklyChangeKg : null
  const shown = change === null ? null : Math.round(fromKg(change, unit) * 10) / 10
  const from = addDaysISO(today, -(SPARK_DAYS - 1))
  const recent = trend.points.filter((point) => point.date >= from)
  let spark = recent.filter((point) => isNum(point.trend)).map((point) => point.trend)
  if (spark.length < 2) spark = recent.filter((point) => point.real && isNum(point.kg)).map((point) => point.kg)
  const first = trend.points[0]?.date
  const sparse = Boolean(first) && first <= addDaysISO(trend.latestDate, -SPARSE_SPAN_DAYS)
  return {
    latestKg: trend.latestKg,
    latestDate: trend.latestDate,
    weeklyChangeKg: change,
    direction: shown === null ? null : shown === 0 ? 'steady' : shown < 0 ? 'down' : 'up',
    noTrend: change !== null ? null : sparse ? 'sparse' : 'new',
    spark: spark.length >= 2 ? spark : [],
  }
}

// Body weight week by week (Gym → Progress): the average of each week's weigh-ins for the last
// `weeks` weeks, newest first, as [{ weekStart, avgKg, count, changeKg }]. A week without a
// weigh-in has avgKg null; changeKg compares with the nearest earlier week that has one (null for
// the first). Averages smooth out day-to-day water swings, so the weekly change is the honest one.
export function weeklyWeights(bodyWeights, today, firstWeekday = 1, weeks = 8) {
  if (!isISODate(today)) return []
  const total = Number.isInteger(weeks) && weeks > 0 ? Math.min(weeks, 104) : 8
  const current = weekStart(today, firstWeekday)
  const oldest = addDays(current, -7 * (total - 1))
  const sums = new Map()
  for (const row of Array.isArray(bodyWeights) ? bodyWeights : []) {
    const kg = Number(row?.kg)
    if (!row || !isISODate(row.date) || !(kg > 0) || row.date > today) continue
    const week = weekStart(row.date, firstWeekday)
    const bucket = sums.get(week) || { sum: 0, count: 0 }
    bucket.sum += kg
    bucket.count += 1
    sums.set(week, bucket)
  }
  // The week before the window counts as a baseline for the oldest week's change.
  let previous = null
  const before = [...sums.keys()].filter((week) => week < oldest).sort().pop()
  if (before) previous = sums.get(before).sum / sums.get(before).count
  const out = []
  for (let i = total - 1; i >= 0; i--) {
    const week = addDays(current, -7 * i)
    const bucket = sums.get(week)
    const avgKg = bucket ? bucket.sum / bucket.count : null
    out.push({ weekStart: week, avgKg, count: bucket ? bucket.count : 0, changeKg: avgKg !== null && previous !== null ? avgKg - previous : null })
    if (avgKg !== null) previous = avgKg
  }
  return out.reverse()
}

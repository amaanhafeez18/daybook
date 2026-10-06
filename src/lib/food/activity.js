// The goal wizard's activity level, suggested from the gym plan (read-only). Pure.

import { normalizeSchedule, versionFor } from '../gym/schedule.js'

const isWorkout = (slot) => slot?.kind === 'routine'

// Workouts a week in the plan in force on `date` (or the first one, when the plan starts later):
// weekly → its workout days; rotation → workouts per cycle scaled to 7 days. null without a plan.
export function planWorkoutsPerWeek(schedule, date) {
  const { versions } = normalizeSchedule(schedule)
  if (!versions.length) return null
  const version = versionFor(schedule, date) || versions[0]
  if (version.mode === 'weekly') return version.weekly.filter(isWorkout).length
  if (!version.cycle.length) return null
  return Math.round((version.cycle.filter(isWorkout).length * 7) / version.cycle.length)
}

// ACTIVITY_LEVELS id for a number of workouts a week: 0–1 light, 2–4 moderate, 5+ very active.
export function activityForWorkouts(perWeek) {
  if (typeof perWeek !== 'number' || !Number.isFinite(perWeek) || perWeek < 0) return null
  return perWeek >= 5 ? 'active' : perWeek >= 2 ? 'moderate' : 'light'
}

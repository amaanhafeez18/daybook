// Pure helpers for the Settings hub rows (a status line under each area in "What you use"). No
// browser or React code, so tests/setup.test.mjs can check them.
import { versionFor } from './gym/schedule.js'

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const list = (value) => (Array.isArray(value) ? value : [])

// The gym plan in a few words for Settings ("Push, Pull, Legs" or "Push, Pull, Legs +2"): the
// routines on today's schedule in order, else every routine. '' without any.
export function gymPlanSummary(gym, today) {
  const routines = list(gym?.routines).filter((routine) => isObject(routine) && routine.id != null)
  const nameOf = new Map(routines.map((routine) => [String(routine.id), typeof routine.name === 'string' && routine.name.trim() ? routine.name.trim() : 'Workout']))
  let ids = []
  try {
    const version = gym?.schedule ? versionFor(gym.schedule, today) : null
    const slots = version ? (version.mode === 'weekly' ? version.weekly : version.cycle) : []
    ids = slots.filter((slot) => slot?.kind === 'routine').map((slot) => String(slot.routineId))
  } catch {
    ids = []
  }
  const names = [...new Set((ids.length ? ids : [...nameOf.keys()]).map((id) => nameOf.get(id)).filter(Boolean))]
  if (!names.length) return ''
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')
}

// The calorie goal for Settings ("2,100 kcal a day", or kJ for people who count those), '' without one.
export function calorieGoalText(food) {
  const kcal = Number(food?.goals?.calories)
  if (!Number.isFinite(kcal) || kcal <= 0) return ''
  const kj = food?.prefs?.energyUnit === 'kJ'
  return `${Math.round(kj ? kcal * 4.184 : kcal).toLocaleString('en-US')} ${kj ? 'kJ' : 'kcal'} a day`
}

// "12 saved" / '' for My foods (settings.food.favorites).
export function savedFoodsText(food) {
  const count = list(food?.favorites).length
  return count ? `${count.toLocaleString('en-US')} saved` : ''
}

import { useMemo } from 'react'
import Icon from './ui/Icon.jsx'
import { resolveDay } from '../lib/gym/schedule.js'
import { hasPlan, useActiveWorkout, useGym, useGymSessions } from '../lib/gym/state.js'
import { dayEntries, useFood, useFoodEntries } from '../lib/food/state.js'
import { dayTotals } from '../lib/food/nutrition.js'
import { fmtEnergy } from '../pages/food/format.js'
import { workoutName } from './WorkoutPill.jsx'
import './today.css'

// Plan → Today's one-glance Health card: a line for the gym and one for food, each opening the
// Health space (its Today has the full cards: start a workout, log a meal, weigh in). Loaded as
// its own chunk, like the food card was, so the first bundle stays small.

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function gymLine({ gym, sessions, active, today }) {
  if (active) return { icon: 'dumbbell', main: `${workoutName(active, gym)} in progress`, sub: 'Resume', href: '#/gym/workout', live: true }
  if (!hasPlan(gym)) return { icon: 'dumbbell', main: 'Gym', sub: 'Set up your plan', href: '#/health' }
  let day
  try {
    day = resolveDay(gym, sessions, today, today)
  } catch {
    return { icon: 'dumbbell', main: 'Gym', sub: 'Open', href: '#/health' }
  }
  switch (day.status) {
    case 'done': {
      const names = [...new Set(day.sessions.map((session) => text(session.name) || 'Workout'))]
      return { icon: 'check', main: `Done: ${names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(' + ')}`, sub: 'Nice work', href: '#/health', done: true }
    }
    case 'today': {
      const routine = day.routine
      const name = routine ? text(routine.name) || 'Workout' : 'Workout day'
      const count = routine?.exercises?.length || 0
      return { icon: 'dumbbell', main: /\bday$/i.test(name) ? name : `${name} Day`, sub: count ? `${plural(count, 'exercise')} · Start on Health` : 'No exercises yet', href: '#/health' }
    }
    case 'rest':
      return { icon: 'dumbbell', main: 'Rest day', sub: 'Gym', href: '#/health' }
    case 'skipped':
      return { icon: 'dumbbell', main: 'Skipped today', sub: 'Gym', href: '#/health' }
    case 'shifted':
      return { icon: 'dumbbell', main: 'Shifted', sub: 'Your plan moved forward a day', href: '#/health' }
    default:
      return { icon: 'dumbbell', main: 'Nothing planned today', sub: 'Gym', href: '#/health' }
  }
}

function foodLine({ food, entries, today }) {
  const { meals, energyUnit: unit } = food.prefs
  const eaten = dayTotals(dayEntries(entries, today, meals)).calories
  const goal = Number(food.goals.calories) > 0 ? Number(food.goals.calories) : null
  if (eaten > 0) {
    const left = goal ? goal - eaten : null
    return {
      icon: 'utensils',
      main: goal ? `${fmtEnergy(eaten, unit)} of ${fmtEnergy(goal, unit)}` : `${fmtEnergy(eaten, unit)} logged`,
      sub: left === null ? 'Food' : left >= 0 ? `${fmtEnergy(left, unit)} left` : `${fmtEnergy(-left, unit)} over`,
      href: '#/health',
    }
  }
  return { icon: 'utensils', main: 'Nothing logged yet', sub: goal ? `${fmtEnergy(goal, unit)} goal · Log on Health` : 'Log a meal on Health', href: '#/health' }
}

export default function HealthGlance({ today, areas, loaded }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const active = useActiveWorkout()
  const food = useFood()
  const entries = useFoodEntries()
  const rows = useMemo(() => [
    areas.gym && gymLine({ gym, sessions, active, today }),
    areas.food && foodLine({ food, entries, today }),
  ].filter(Boolean), [areas.gym, areas.food, gym, sessions, active, food, entries, today])

  if (!loaded || !rows.length) return null
  return (
    <section className="card td-headline td-health" aria-label="Health">
      {rows.map((row) => (
        <a key={row.icon} className={`td-hl-line td-health-row ${row.live ? 'is-live' : ''}`} href={row.href}>
          <span className={`td-hl-icon is-soft ${row.done ? 'is-done' : ''}`}><Icon name={row.icon} size={18} /></span>
          <span className="td-hl-text">
            <span className="td-hl-main">{row.main}</span>
            <span className="td-hl-sub">{row.sub}</span>
          </span>
          <span className="td-health-chev"><Icon name="chevronRight" size={18} strokeWidth={2.2} /></span>
        </a>
      ))}
    </section>
  )
}

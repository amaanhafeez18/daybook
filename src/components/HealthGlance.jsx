import { useEffect, useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { haptic } from '../lib/haptics.js'
import { resolveDay } from '../lib/gym/schedule.js'
import { hasPlan, useActiveWorkout, useGym, useGymSessions } from '../lib/gym/state.js'
import { dayTotals, entryMeal } from '../lib/food/nutrition.js'
import { lastMealDay } from '../lib/food/shortcuts.js'
import { learnedMealTimes } from '../lib/food/mealTimes.js'
import { copyMeal, dayEntries, useFood, useFoodEntries } from '../lib/food/state.js'
import { copiedText, defaultMeal, fmtEnergy, mealName, pastDayName } from '../pages/food/format.js'
import { loadStart, missedWorkout, startRoutine } from './gymStart.js'
import { workoutName } from './WorkoutPill.jsx'
import './today.css'
import './food-quick.css' // the Health glance's pill rows (see the end of that file)

// Plan → Today's one-glance Health card: a line for the gym and one for food, each opening the
// Health space (its Today has the full cards: log a meal, weigh in). A line can carry one pill for
// the obvious next step, so it happens right here: Start today's workout, "Do it today" for
// yesterday's missed one, or "Same as <day>" for the meal of the moment while it's empty. Loaded
// as its own chunk, like the food card was, so the first bundle stays small.

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// action: { kind: 'start' | 'missed', routine, date } for the pill, else none.
function gymLine({ gym, sessions, active, today }) {
  if (active) return { id: 'gym', icon: 'dumbbell', main: `${workoutName(active, gym)} in progress`, sub: 'Resume', href: '#/gym/workout', live: true }
  // Setting up happens on the Gym page itself, so go straight there.
  if (!hasPlan(gym)) return { id: 'gym', icon: 'dumbbell', main: 'Gym', sub: 'Set up your plan', href: '#/gym' }
  let day
  try {
    day = resolveDay(gym, sessions, today, today)
  } catch {
    return { id: 'gym', icon: 'dumbbell', main: 'Gym', sub: 'Open', href: '#/health' }
  }
  switch (day.status) {
    case 'done': {
      const names = [...new Set(day.sessions.map((session) => text(session.name) || 'Workout'))]
      return { id: 'gym', icon: 'check', main: `Done: ${names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(' + ')}`, sub: 'Nice work', href: '#/health', done: true }
    }
    case 'today': {
      const routine = day.routine
      const name = routine ? text(routine.name) || 'Workout' : 'Workout day'
      const count = routine?.exercises?.length || 0
      return {
        id: 'gym',
        icon: 'dumbbell',
        main: /\bday$/i.test(name) ? name : `${name} Day`,
        sub: count ? plural(count, 'exercise') : 'No exercises yet',
        href: '#/health',
        action: count ? { kind: 'start', routine, label: 'Start', icon: 'play', aria: `Start ${name}` } : null,
      }
    }
    case 'rest':
    case 'none': {
      const missed = missedWorkout({ gym, sessions, today, active })
      if (missed) {
        return {
          id: 'gym',
          icon: 'dumbbell',
          main: `Missed ${missed.name} yesterday`,
          sub: day.status === 'rest' ? 'Rest day today' : 'Nothing planned today',
          href: '#/health',
          action: { kind: 'missed', routine: missed.routine, label: 'Do it today', aria: `Do ${missed.name} today` },
        }
      }
      return day.status === 'rest'
        ? { id: 'gym', icon: 'dumbbell', main: 'Rest day', sub: 'Gym', href: '#/health' }
        : { id: 'gym', icon: 'dumbbell', main: 'Nothing planned today', sub: 'Gym', href: '#/health' }
    }
    case 'skipped':
      return { id: 'gym', icon: 'dumbbell', main: 'Skipped today', sub: 'Gym', href: '#/health' }
    case 'shifted':
      return { id: 'gym', icon: 'dumbbell', main: 'Shifted', sub: 'Your plan moved forward a day', href: '#/health' }
    default:
      return { id: 'gym', icon: 'dumbbell', main: 'Nothing planned today', sub: 'Gym', href: '#/health' }
  }
}

// action: { kind: 'same', same, meal } to copy the meal of the moment from its last day.
function foodLine({ food, entries, today }) {
  const { meals, energyUnit: unit } = food.prefs
  const rows = dayEntries(entries, today, meals)
  const eaten = dayTotals(rows).calories
  const goal = Number(food.goals.calories) > 0 ? Number(food.goals.calories) : null
  // The meal of the moment, while it's still empty: "Same as <day>" copies it in one tap.
  const nowMeal = defaultMeal(meals, learnedMealTimes(entries, meals, today))
  const same = rows.some((entry) => entryMeal(entry, meals) === nowMeal) ? null : lastMealDay(entries, nowMeal, today, meals)
  const sameName = same ? pastDayName(same.date, today) : ''
  const action = same ? {
    kind: 'same',
    same,
    meal: nowMeal,
    label: `Same as ${sameName}`,
    aria: `${mealName(meals, nowMeal)} same as ${sameName}: ${plural(same.rows.length, 'item')}, ${fmtEnergy(same.kcal, unit)}`,
  } : null
  if (eaten > 0) {
    const left = goal ? goal - eaten : null
    return {
      id: 'food',
      icon: 'utensils',
      main: goal ? `${fmtEnergy(eaten, unit)} of ${fmtEnergy(goal, unit)}` : `${fmtEnergy(eaten, unit)} logged`,
      sub: left === null ? 'Food' : left >= 0 ? `${fmtEnergy(left, unit)} left` : `${fmtEnergy(-left, unit)} over`,
      href: '#/health',
      action,
    }
  }
  return { id: 'food', icon: 'utensils', main: 'Nothing logged yet', sub: goal ? `${fmtEnergy(goal, unit)} goal · Log on Health` : 'Log a meal on Health', href: '#/health', action }
}

export default function HealthGlance({ today, areas, loaded }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const active = useActiveWorkout()
  const food = useFood()
  const entries = useFoodEntries()
  const [starting, setStarting] = useState(false)
  const rows = useMemo(() => [
    areas.gym && gymLine({ gym, sessions, active, today }),
    areas.food && foodLine({ food, entries, today }),
  ].filter(Boolean), [areas.gym, areas.food, gym, sessions, active, food, entries, today])

  // A Start / "Do it today" pill: fetch the workout module now, so the tap starts it at once.
  const offersStart = loaded && rows.some((row) => row.action && row.action.kind !== 'same')
  useEffect(() => {
    if (offersStart) loadStart()
  }, [offersStart])

  if (!loaded || !rows.length) return null

  function run(action) {
    if (action.kind === 'same') {
      try {
        const undo = copyMeal(action.same.date, action.meal, today)
        if (undo.entries.length) haptic()
        toast(copiedText(undo.entries.length, mealName(food.prefs.meals, action.meal), pastDayName(action.same.date, today)), { action: { label: 'Undo', onClick: undo } })
      } catch (error) {
        toast(error.message, { tone: 'error' })
      }
      return
    }
    if (starting) return
    // Yesterday's missed routine is done today; the schedule itself stays as it is.
    setStarting(true)
    Promise.resolve(startRoutine({ gym, sessions, routine: action.routine, date: today, today })).finally(() => setStarting(false))
  }

  return (
    <section className="card td-headline td-health" aria-label="Health">
      {rows.map((row) => (
        <div key={row.id} className={`td-hl-line td-health-row${row.live ? ' is-live' : ''}${row.action ? ' has-pill' : ''}`}>
          <a className="td-health-link" href={row.href}>
            <span className={`td-hl-icon is-soft ${row.done ? 'is-done' : ''}`}><Icon name={row.icon} size={18} /></span>
            <span className="td-hl-text">
              <span className="td-hl-main">{row.main}</span>
              <span className="td-hl-sub">{row.sub}</span>
            </span>
            {!row.action && <span className="td-health-chev"><Icon name="chevronRight" size={18} strokeWidth={2.2} /></span>}
          </a>
          {row.action && (
            <Button
              variant="secondary"
              size="sm"
              className="td-health-pill"
              icon={row.action.icon}
              loading={row.action.kind !== 'same' && starting}
              onClick={() => run(row.action)}
              aria-label={row.action.aria}
            >
              {row.action.label}
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}

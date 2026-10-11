import { useEffect, useMemo, useState } from 'react'
import { toast } from './ui/feedback.jsx'
import { readPref, writePref } from '../lib/api.js'
import { addDays, resolveDay, weekStart } from '../lib/gym/schedule.js'
import { getState } from '../lib/store.js'

// Starting a workout from a card (Health's gym card, Plan → Today's gym line, the Gym page's
// "Missed … yesterday" banner), spotting yesterday's missed workout, and the once-a-week
// "Weekly goal done" moment.
//
// startWorkout.js (exercise library + rest timer) loads on demand: ask for it with loadStart()
// as soon as a Start button shows, so the tap can call beginWorkout synchronously. beginWorkout
// unlocks audio for the rest-timer beep, which iOS only allows inside the tap itself.

let startModule = null
let startRequest = null

export function loadStart() {
  if (!startRequest) {
    startRequest = import('../pages/gym/startWorkout.js')
      .then((module) => (startModule = module))
      .catch(() => {
        startRequest = null // offline and not cached yet: try again next time
        return null
      })
  }
  return startRequest
}

// true once a tap can start a workout straight away (no wait for the module).
export const startReady = () => !!startModule

// Starts `routine` on `date` and opens the workout. Call it inside the tap. Resolves once it has
// started (or failed, with a toast); when the module wasn't loaded yet it starts once it arrives
// (the workout screen unlocks audio on its first tap), so a caller can show a spinner meanwhile.
export function startRoutine({ gym, sessions, routine, date, today }) {
  const args = { gym, sessions, bodyWeights: getState().data.bodyWeights, routine, date: date || today, today }
  const run = (module) => module.beginWorkout(args).catch(() => toast('Couldn’t start the workout.', { tone: 'error' }))
  if (startModule) return run(startModule)
  return loadStart().then((module) => {
    if (module) return run(module)
    toast('Couldn’t start the workout. Check your connection and try again.', { tone: 'error' })
    return null
  })
}

const MISSED_PREF = 'gym.missedSeen'

// Yesterday's planned workout that was neither done nor skipped, while today has no workout of
// its own (a rest day or nothing planned): { date, routine, name }, else null. Only yesterday is
// checked, so it never nags about older days, and "Let it go" (letMissedGo) hides it for good.
// The schedule itself is never changed; after the workout, its summary offers to realign.
export function missedWorkout({ gym, sessions, today, active = null }) {
  if (active || !today) return null
  const yesterday = addDays(today, -1)
  if (!yesterday || readPref(MISSED_PREF, null) === yesterday) return null
  try {
    const now = resolveDay(gym, sessions, today, today)
    if (now.status !== 'rest' && now.status !== 'none') return null
    const before = resolveDay(gym, sessions, yesterday, today)
    const routine = before.status === 'missed' ? before.routine : null
    if (!routine?.exercises?.length) return null
    const name = typeof routine.name === 'string' && routine.name.trim() ? routine.name.trim() : 'your workout'
    return { date: yesterday, routine, name }
  } catch {
    return null
  }
}

// "Let it go": stop offering yesterday's missed workout (stored per device, by its date).
export function letMissedGo(date) {
  writePref(MISSED_PREF, date)
}

const GOAL_PREF = 'gym.goalDone'

// The weekly goal was met today: this week's workouts reach `goal` and the ones before today
// didn't. → { week (its first day), count }, else null.
export function goalMetToday(sessions, today, firstWeekday, goal) {
  const start = weekStart(today, firstWeekday)
  const end = start ? addDays(start, 6) : null
  if (!end || !(goal > 0)) return null
  const week = (Array.isArray(sessions) ? sessions : []).filter((session) => session && session.date >= start && session.date <= end)
  const before = week.filter((session) => session.date < today).length
  return week.length >= goal && before < goal && week.some((session) => session.date === today) ? { week: start, count: week.length } : null
}

// Meeting the weekly goal, celebrated once per week (stored per device): a toast, and true for
// the ring that shows it to play its burst. Only the first card on screen after it happens says so.
export function useGoalMoment({ sessions, today, firstWeekday, goal }) {
  const met = useMemo(() => goalMetToday(sessions, today, firstWeekday, goal), [sessions, today, firstWeekday, goal])
  const [burst, setBurst] = useState(false)
  const week = met?.week ?? null
  useEffect(() => {
    if (!week || readPref(GOAL_PREF, null) === week) return
    writePref(GOAL_PREF, week)
    setBurst(true)
    toast(`Weekly goal done · ${met.count} of ${goal}`)
  }, [week]) // eslint-disable-line react-hooks/exhaustive-deps
  return burst
}

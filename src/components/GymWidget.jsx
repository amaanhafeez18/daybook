import { Fragment, useEffect, useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { toast } from './ui/feedback.jsx'
import { WEEKDAY_SHORT, diffDays, formatDateShort, formatDuration as formatMinutes, relativeDay, weekdayIndex } from '../lib/dates.js'
import { addDays, nextWorkout, resolveDay, weekStart } from '../lib/gym/schedule.js'
import { hasPlan, routineColor, slotLabel, useActiveWorkout, useGym, useGymSessions } from '../lib/gym/state.js'
import { navigate } from '../lib/router.js'
import { getState } from '../lib/store.js'
import { QuietBoundary, prefetchGym, startedMs, useClock, workoutClock, workoutColor, workoutName, workoutWhen } from './WorkoutPill.jsx'
import './gym-widget.css'
import './today.css'

// Today-page card for the gym: today's planned workout, rest day, a finished or running workout,
// or a nudge to set up a plan. The card's main area opens the Gym page; on a workout day with
// nothing running, a trailing "Start" pill starts today's routine in one tap.

// stats.js carries the exercise library, so it loads as its own chunk (asked for as soon as this
// module runs, alongside the first render) instead of growing the first bundle.
let statsModule = null
let statsRequest = null

function loadStats() {
  if (!statsRequest) {
    statsRequest = import('../lib/gym/stats.js')
      .then((module) => (statsModule = module))
      .catch(() => {
        statsRequest = null // offline and not cached yet: try again next time
        return null
      })
  }
  return statsRequest
}
if (typeof window !== 'undefined') loadStats()

// startWorkout.js (exercise library + rest timer) loads on demand too: requested as soon as the
// card offers "Start", so the tap can call beginWorkout synchronously. beginWorkout unlocks audio
// for the rest-timer beep, which iOS only allows inside the tap itself.
let startModule = null
let startRequest = null

function loadStart() {
  if (!startRequest) {
    startRequest = import('../pages/gym/startWorkout.js')
      .then((module) => (startModule = module))
      .catch(() => {
        startRequest = null
        return null
      })
  }
  return startRequest
}

// pending only while the first load is in flight; after a failed load the card shows what it can.
function useStats() {
  const [state, setState] = useState(() => ({ stats: statsModule, pending: !statsModule }))
  useEffect(() => {
    if (state.stats) return undefined
    let live = true
    loadStats().then((module) => {
      if (live) setState({ stats: module, pending: false })
    })
    return () => {
      live = false
    }
  }, [state.stats])
  return state
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// 'Tomorrow', 'Thu' within the week ahead, else 'Oct 3'.
function shortDay(iso, today) {
  const delta = diffDays(today, iso)
  if (delta === 1) return 'Tomorrow'
  if (delta > 1 && delta < 7) return WEEKDAY_SHORT[weekdayIndex(iso)]
  return formatDateShort(iso)
}

function nextPart(next, gym, today) {
  return next ? { text: `Next: ${slotLabel(next.shown, gym)} (${shortDay(next.date, today)})` } : { text: 'Nothing else planned yet' }
}

function weekCount(sessions, today, firstWeekday) {
  const start = weekStart(today, firstWeekday)
  if (!start) return 0
  const end = addDays(start, 6)
  return sessions.filter((session) => session.date >= start && session.date <= end).length
}

function doneParts(stats, sessions, todays, formula) {
  let seconds = 0
  let sets = 0
  let prs = 0
  for (const session of todays) {
    seconds += stats.sessionDurationSec(session) || 0
    sets += stats.sessionWorkingSets(session)
    prs += stats.sessionPRs(sessions, session, formula).length
  }
  const parts = []
  if (todays.length > 1) parts.push({ text: plural(todays.length, 'workout') })
  const minutes = Math.round(seconds / 60)
  if (minutes >= 1) parts.push({ text: formatMinutes(minutes) })
  else if (sets > 0) parts.push({ text: plural(sets, 'set') })
  if (prs > 0) parts.push({ text: plural(prs, 'PR'), pr: true })
  if (!parts.length) parts.push({ text: 'Marked as trained' })
  return parts
}

// Everything the card shows. parts: subtitle pieces joined by ' · ' (null = still loading).
function describe({ day, next, active, gym, sessions, stats, pending, now, today, planned }) {
  if (active) {
    const clock = workoutClock(active, now, today)
    return {
      tone: 'routine',
      color: workoutColor(active, gym),
      live: true,
      title: `${workoutName(active, gym)} in progress`,
      deload: active.isDeload === true,
      parts: [{ text: clock || workoutWhen(active, today) }, { text: 'Resume', accent: true }],
      target: 'gym/workout',
    }
  }

  switch (day.status) {
    case 'done': {
      const todays = day.sessions
      const names = [...new Set(todays.map((session) => text(session.name) || 'Workout'))]
      return {
        tone: 'routine',
        color: workoutColor(todays[0], gym) || (day.routine ? routineColor(day.routine) : null),
        done: true,
        title: `Done: ${names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(' + ')}`,
        parts: stats ? doneParts(stats, sessions, todays, gym.prefs.e1rmFormula) : pending ? null : [{ text: plural(todays.length, 'workout') }],
        target: 'gym',
      }
    }
    case 'today': {
      const routine = day.routine
      if (!routine) {
        return { tone: 'neutral', title: 'Workout day', parts: [{ text: 'Its routine was deleted' }, { text: 'Choose one', accent: true }], target: 'gym' }
      }
      const name = text(routine.name) || 'Workout'
      const count = routine.exercises.length
      let parts
      if (!count) parts = [{ text: 'No exercises yet' }, { text: 'Add some', accent: true }]
      else if (stats) parts = [{ text: plural(count, 'exercise') }, { text: `~${stats.estimateMinutes(routine)} min` }]
      else parts = pending ? null : [{ text: plural(count, 'exercise') }]
      return {
        tone: 'routine',
        color: routineColor(routine),
        title: /\bday$/i.test(name) ? name : `${name} Day`,
        deload: day.deload,
        parts,
        target: count ? 'gym' : `gym/routine/${encodeURIComponent(routine.id)}`,
      }
    }
    case 'rest':
      return { tone: 'neutral', title: 'Rest day', parts: [nextPart(next, gym, today)], target: 'gym' }
    case 'skipped': {
      if (day.shown.kind !== 'routine') return { tone: 'neutral', title: 'Rest day', parts: [nextPart(next, gym, today)], target: 'gym' }
      return {
        tone: 'neutral',
        title: day.routineMissing ? 'Skipped workout' : `Skipped ${slotLabel(day.shown, gym)}`,
        parts: [nextPart(next, gym, today)],
        target: 'gym',
      }
    }
    case 'shifted': {
      const when = next ? relativeDay(next.date, today) : ''
      return {
        tone: 'neutral',
        title: 'Shifted',
        parts: [{ text: next ? `${slotLabel(next.shown, gym)} moves to ${when === 'Tomorrow' ? 'tomorrow' : when}` : 'Your plan moved forward a day' }],
        target: 'gym',
      }
    }
    default:
      if (!planned) return { tone: 'setup', title: 'Set up your gym plan', parts: [{ text: 'Pick a split to get started' }], target: 'gym' }
      return {
        tone: 'neutral',
        title: 'Nothing planned today',
        parts: [next ? nextPart(next, gym, today) : { text: 'Set up your schedule', accent: true }],
        target: next ? 'gym' : 'gym/routines',
      }
  }
}

export default function GymWidget({ today, loaded = true }) {
  return (
    <QuietBoundary>
      <Widget today={today} loaded={loaded} />
    </QuietBoundary>
  )
}

function Widget({ today, loaded }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const active = useActiveWorkout()
  const { stats, pending } = useStats()
  const now = useClock(!!active, startedMs(active) ?? 0)
  const planned = hasPlan(gym)
  const { firstWeekday, weeklyGoal } = gym.prefs

  const day = useMemo(() => resolveDay(gym, sessions, today, today), [gym, sessions, today])
  const needsNext = !active && ['rest', 'skipped', 'shifted', 'none'].includes(day.status)
  const next = useMemo(() => (needsNext ? nextWorkout(gym, sessions, today) : null), [needsNext, gym, sessions, today])
  const week = useMemo(() => weekCount(sessions, today, firstWeekday), [sessions, today, firstWeekday])
  // Finished-workout numbers (PRs scan every session) only change with the sessions, not each tick.
  const doneView = useMemo(
    () => (!active && day.status === 'done' ? describe({ day, gym, sessions, stats, pending, today, planned }) : null),
    [active, day, gym, sessions, stats, pending, today, planned],
  )

  // "Start" shows on a planned workout day whose routine has exercises, while nothing is running.
  const startRoutine = !active && day.status === 'today' && day.routine?.exercises?.length ? day.routine : null
  const canStart = loaded && !!startRoutine
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (canStart) loadStart()
  }, [canStart])

  if (!loaded) return <WidgetSkeleton />

  function start() {
    if (starting || !startRoutine) return
    const args = { gym, sessions, bodyWeights: getState().data.bodyWeights, routine: startRoutine, date: today, today }
    const run = (module) => module.beginWorkout(args).catch(() => toast('Couldn’t start the workout.', { tone: 'error' }))
    if (startModule) {
      run(startModule)
      return
    }
    // Not loaded yet (slow network): start once it arrives; the workout screen unlocks audio on its first tap.
    setStarting(true)
    loadStart().then((module) => {
      setStarting(false)
      if (module) run(module)
      else toast('Couldn’t start the workout. Check your connection and try again.', { tone: 'error' })
    })
  }

  const view = doneView || describe({ day, next, active, gym, sessions, stats, pending, now, today, planned })
  const label = [
    `Gym: ${view.title}${view.deload ? ', deload week' : ''}`,
    view.parts ? view.parts.map((part) => part.text).join(', ') : '',
    planned ? `${week} of ${weeklyGoal} workouts this week` : '',
  ].filter(Boolean).join('. ')

  return (
    <div
      className={`card gymw-card td-gymw${view.color ? ' has-color' : ''}${view.live ? ' is-live' : ''}${startRoutine ? ' has-start' : ''}`}
      style={view.color ? { '--gymw-color': view.color } : undefined}
    >
      <button type="button" className="gymw-main" onPointerDown={prefetchGym} onClick={() => navigate(view.target)} aria-label={label}>
        <span className={`gymw-tile is-${view.tone}${view.live ? ' is-live' : ''}`} aria-hidden="true">
          <Icon name="dumbbell" size={24} strokeWidth={2} />
          {view.done && (
            <span className="gymw-tile-badge">
              <Icon name="check" size={11} strokeWidth={3.4} />
            </span>
          )}
        </span>
        <span className="gymw-text" aria-hidden="true">
          <span className="gymw-title">
            <span className="gymw-title-text">{view.title}</span>
            {view.deload && <span className="gymw-badge">Deload</span>}
          </span>
          <span className="gymw-sub">
            {view.parts ? view.parts.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="gymw-sep"> · </span>}
                <span className={part.accent ? 'gymw-accent' : part.pr ? 'gymw-pr' : undefined}>
                  {part.pr && <Icon name="trophy" size={13} strokeWidth={2.2} />}
                  {part.text}
                </span>
              </Fragment>
            )) : <span className="skeleton gymw-skel gymw-skel-sub" />}
          </span>
        </span>
        {planned && <GoalRing count={week} goal={weeklyGoal} />}
        <Icon name="chevronRight" size={18} strokeWidth={2.2} className="gymw-chevron" />
      </button>
      {startRoutine && (
        <button
          type="button"
          className="td-gymw-start"
          onPointerDown={prefetchGym}
          onClick={start}
          disabled={starting}
          aria-busy={starting || undefined}
          aria-label={`Start ${text(startRoutine.name) || 'workout'}`}
        >
          {starting ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={14} strokeWidth={2.4} />}
          Start
        </button>
      )}
    </div>
  )
}

const RING_R = 16
const RING_C = 2 * Math.PI * RING_R

function GoalRing({ count, goal }) {
  const progress = goal > 0 ? Math.min(1, count / goal) : 0
  const fraction = `${count}/${goal}`
  return (
    <span className={`gymw-goal${count >= goal ? ' is-met' : ''}`} aria-hidden="true">
      <span className="gymw-goal-caption">this week</span>
      <span className="gymw-goal-ring">
        <svg viewBox="0 0 40 40" width="40" height="40">
          <circle className="gymw-goal-track" cx="20" cy="20" r={RING_R} />
          {progress > 0 && (
            <circle
              className="gymw-goal-bar"
              cx="20"
              cy="20"
              r={RING_R}
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress)}
              transform="rotate(-90 20 20)"
            />
          )}
        </svg>
        <span className={`gymw-goal-count${fraction.length > 3 ? ' is-long' : ''}`}>{fraction}</span>
      </span>
    </span>
  )
}

function WidgetSkeleton() {
  return (
    <div className="card gymw-card is-loading" aria-hidden="true">
      <span className="gymw-tile is-neutral" />
      <span className="gymw-text">
        <span className="skeleton gymw-skel gymw-skel-title" />
        <span className="skeleton gymw-skel gymw-skel-sub" />
      </span>
    </div>
  )
}

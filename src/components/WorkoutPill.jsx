import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Icon from './ui/Icon.jsx'
import { formatTime, nowTimeHHMM, relativeDay, todayISO } from '../lib/dates.js'
import { routineById, routineColor, updateActive, useActiveWorkout, useGym } from '../lib/gym/state.js'
import { formatDuration } from '../lib/gym/units.js'
import { navigate } from '../lib/router.js'
import './gym-widget.css'

// Floating "Push · 23:14 ›" capsule above the tab bar while a workout is in progress and the
// workout screen isn't showing. It sets html.has-workout-pill so the page, toasts and the assistant
// composer make room for it (see gym-widget.css, which also hides it under sheets and while typing).
// It isn't shown on the gym tab views (they have their own Resume banner) or where a tap on it
// would throw away unsaved edits: the routine editor, and a session being edited (SessionDetail
// sets html.gym-editing). It still runs there, unseen, to end a rest that runs out (beep + clear).

// Gym views (#/gym/<view>) that show the pill; the others are the tab views, the workout itself
// and the routine editor. A missing or unknown view is the Today tab, as in GymPage.
const GYM_PILL_VIEWS = new Set(['session', 'exercise', 'stats'])
const EDITING_CLASS = 'gym-editing'
// Longer than this reads as a forgotten workout rather than a running clock.
const LIVE_LIMIT_SEC = 6 * 60 * 60
const REST_OVER_SHOWN_MS = 2 * 60 * 1000
const LATE_BEEP_MS = 3000

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

// ---- shared with GymWidget -------------------------------------------------------------------

// Re-renders on every whole second counted from anchorMs (so a timer never skips or repeats a
// second), and at once when the app comes back to the foreground (iOS pauses timers meanwhile).
export function useClock(enabled, anchorMs = 0) {
  const [now, setNow] = useState(() => Date.now())
  const anchor = isFiniteNumber(anchorMs) ? anchorMs : 0
  useEffect(() => {
    if (!enabled) return undefined
    let timer = null
    const tick = () => {
      const current = Date.now()
      setNow(current)
      const phase = (((current - anchor) % 1000) + 1000) % 1000
      timer = setTimeout(tick, 1000 - phase + 12)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      tick()
    }
    tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, anchor])
  return now
}

export function startedMs(active) {
  const ms = typeof active?.startedAt === 'string' ? Date.parse(active.startedAt) : NaN
  return Number.isFinite(ms) ? ms : null
}

// A workout started for an earlier day ('Add past workout') rather than one running now (which
// may well run past midnight). Same rule as stats.js isBackfillWorkout, kept here so the main
// bundle doesn't load stats.js.
export function isBackfill(active) {
  if (!active || typeof active !== 'object') return false
  if (active.backfill === true) return true
  const created = typeof active.createdAt === 'string' ? Date.parse(active.createdAt) : NaN
  const started = startedMs(active)
  return Number.isFinite(created) && started !== null && created - started > 60000
}

// 'm:ss' / 'h:mm:ss' since the start, or null when there is no believable running clock: a
// backfilled past workout, or one left running for hours. A live one past midnight keeps its clock.
export function workoutClock(active, now) {
  const started = startedMs(active)
  if (started === null || isBackfill(active)) return null
  const sec = Math.max(0, Math.floor((now - started) / 1000))
  return sec < LIVE_LIMIT_SEC ? formatDuration(sec) : null
}

// Stands in for the clock: 'Started 9:05 AM' today, else 'Yesterday' / 'Sep 20'.
export function workoutWhen(active, today, { short = false } = {}) {
  const started = startedMs(active)
  if (active?.date === today && started !== null) {
    const time = formatTime(nowTimeHHMM(new Date(started)))
    return short ? time : `Started ${time}`
  }
  return relativeDay(active?.date, today) || 'In progress'
}

export function workoutName(active, gym) {
  return text(active?.name) || text(routineById(gym, active?.routineId)?.name) || 'Workout'
}

// Routine colour for a workout or session; null (the accent is used) for an empty workout.
export function workoutColor(item, gym) {
  const routine = routineById(gym, item?.routineId)
  return routine ? routineColor(routine) : null
}

// Warms the Gym page chunk on touch-down, so the page is usually ready by the time the tap lands.
export function prefetchGym() {
  import('../pages/GymPage.jsx').catch(() => {})
}

// A crash in a small add-on (widget, pill) must never take the page or the app shell with it.
export class QuietBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('Gym add-on crashed:', error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

// ---- the pill --------------------------------------------------------------------------------

const subscribeHash = (listener) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}
const readHash = () => window.location.hash

const subscribeEditing = (listener) => {
  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const readEditing = () => document.documentElement.classList.contains(EDITING_CLASS)

// '#/gym/workout' → 'workout', '#/gym' → '' (the Today tab); null outside the gym.
function gymView(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  return parts[0] === 'gym' ? parts[1] || '' : null
}

function restState(active, now) {
  const rest = active?.rest
  const endAt = Number(rest?.endAt)
  if (!rest || !Number.isFinite(endAt)) return null
  const left = Math.ceil((endAt - now) / 1000)
  if (left > 0) {
    const total = Number(rest.durationSec)
    return { over: false, endAt, left, fraction: total > 0 ? Math.min(1, left / total) : null }
  }
  return now - endAt < REST_OVER_SHOWN_MS ? { over: true, endAt } : null
}

export default function WorkoutPill() {
  return (
    <QuietBoundary>
      <Pill />
    </QuietBoundary>
  )
}

function Pill() {
  const active = useActiveWorkout()
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '')
  // The workout screen runs its own rest timer; everywhere else the pill watches the rest.
  if (!active || gymView(hash) === 'workout') return null
  return <PillBody active={active} />
}

function PillBody({ active }) {
  const gym = useGym()
  // Tick in step with whichever countdown is on screen: the rest while resting, else the workout.
  const restEnd = Number(active.rest?.endAt)
  const now = useClock(true, Number.isFinite(restEnd) && restEnd > Date.now() ? restEnd : startedMs(active) ?? 0)
  // Read here, so the every-second tick also picks up a hash set without a hashchange event (the
  // app restoring its last page with history.replaceState on launch).
  const view = gymView(useSyncExternalStore(subscribeHash, readHash, () => ''))
  const editing = useSyncExternalStore(subscribeEditing, readEditing, () => false)
  const visible = !editing && (view === null || GYM_PILL_VIEWS.has(view))

  useEffect(() => {
    if (!visible) return undefined
    const root = document.documentElement
    root.classList.add('has-workout-pill')
    return () => root.classList.remove('has-workout-pill')
  }, [visible])
  // A rest this pill ended (below) keeps showing 'Rest over' for a while.
  const [overEnd, setOverEnd] = useState(null)
  const rest = restState(active, now) || (overEnd !== null && now - overEnd < REST_OVER_SHOWN_MS ? { over: true, endAt: overEnd } : null)
  const soundOn = gym.prefs.timerSound !== false

  // A rest that runs out while the workout screen (which normally ends it) is closed: once per rest
  // and only if this pill saw it running, alert (never late; shared with the rest timer, so going
  // straight back to the workout doesn't beep twice) and clear it. Also while the pill is unseen.
  const sawRunning = useRef(null)
  const handled = useRef(null)
  if (rest && !rest.over) sawRunning.current = rest.endAt
  useEffect(() => {
    if (!rest?.over || handled.current === rest.endAt || sawRunning.current !== rest.endAt) return
    const endAt = rest.endAt
    handled.current = endAt
    setOverEnd(endAt)
    updateActive((current) => (current.rest && current.rest.endAt === endAt ? { ...current, rest: null } : current))
    if (Date.now() - endAt > LATE_BEEP_MS) return
    import('../pages/gym/RestTimer.jsx')
      .then((module) => module.beepOnce?.(endAt, soundOn))
      .catch(() => {})
  }, [rest?.over, rest?.endAt, soundOn])

  if (!visible) return null

  const name = workoutName(active, gym)
  const color = workoutColor(active, gym)
  const today = todayISO()
  const clock = workoutClock(active, now)
  const when = clock || workoutWhen(active, today, { short: true })
  const restText = rest ? (rest.over ? 'Rest over' : `Rest ${formatDuration(rest.left)}`) : ''
  const label = [`Resume ${name}`, clock ? `${clock} elapsed` : when, rest ? (rest.over ? 'rest over' : `rest ${formatDuration(rest.left)} left`) : '']
    .filter(Boolean)
    .join(', ')

  return (
    <button
      type="button"
      className={`gymw-pill${rest ? (rest.over ? ' is-rest-over' : ' is-resting') : ''}`}
      style={color ? { '--gymw-color': color } : undefined}
      onPointerDown={prefetchGym}
      onClick={() => navigate('gym/workout')}
      aria-label={label}
      title="Back to your workout"
    >
      <span className="gymw-pill-dot" aria-hidden="true" />
      <span className="gymw-pill-name">{name}</span>
      <span className="gymw-pill-time">{when}</span>
      {rest && (
        <span className="gymw-pill-rest">
          <Icon name={rest.over ? 'check' : 'timer'} size={14} strokeWidth={2.2} />
          {restText}
        </span>
      )}
      <Icon name="chevronRight" size={16} strokeWidth={2.2} className="gymw-pill-chevron" />
      {rest && !rest.over && rest.fraction !== null && (
        <span className="gymw-pill-progress" style={{ transform: `scaleX(${rest.fraction})` }} aria-hidden="true" />
      )}
    </button>
  )
}

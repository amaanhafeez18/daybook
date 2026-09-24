import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { confirmAction } from '../../components/ui/feedback.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { relativeDay } from '../../lib/dates.js'
import { isBackfillWorkout, sessionVolume, sessionWorkingSets } from '../../lib/gym/stats.js'
import { discardActive, updateActive, useActiveWorkout, useGym, useGymSessions } from '../../lib/gym/state.js'
import { formatDuration, formatVolume } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { GymEmpty } from './common.jsx'
import ExerciseLog, { volumeLookup } from './ExerciseLog.jsx'
import FinishSheet from './FinishSheet.jsx'
import RestTimer, { audioReady, unlockAudio } from './RestTimer.jsx'
import WorkoutSummary from './WorkoutSummary.jsx'
import './workout.css'

// The in-gym screen: header with the live clock and Finish, running totals, the exercise log,
// the rest timer, and the summary once the workout is saved.

const FINISHED_KEY = 'daybook.gym.finishedId' // survives a reload while the summary is showing

function readFinished() {
  try {
    return sessionStorage.getItem(FINISHED_KEY)
  } catch {
    return null
  }
}

function writeFinished(id) {
  try {
    if (id) sessionStorage.setItem(FINISHED_KEY, id)
    else sessionStorage.removeItem(FINISHED_KEY)
  } catch {
    // storage unavailable
  }
}

function useTick(ms, enabled) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    const tick = () => setNow(Date.now())
    tick()
    const timer = setInterval(tick, ms)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ms, enabled])
  return now
}

// Keeps the screen on during the workout (iOS 16.4+). The lock drops whenever the app is hidden,
// so it is asked for again each time it comes back.
function useWakeLock(enabled) {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.wakeLock?.request) return undefined
    let lock = null
    let cancelled = false
    const request = async () => {
      if (cancelled || document.visibilityState !== 'visible' || (lock && !lock.released)) return
      try {
        const next = await navigator.wakeLock.request('screen')
        if (cancelled) next.release?.().catch?.(() => {})
        else lock = next
      } catch {
        // denied, low battery or unsupported: the screen just sleeps as usual
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') request()
    }
    request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      try {
        lock?.release?.()?.catch?.(() => {})
      } catch {
        // already released
      }
    }
  }, [enabled])
}

// iOS only plays sound after a tap in this page load. After a reload or relaunch mid-rest the Start
// and ✓ taps that normally unlock audio haven't happened, so any tap on the screen does it.
function useAudioUnlock() {
  useEffect(() => {
    if (audioReady()) return undefined
    const events = ['pointerup', 'touchend', 'keydown']
    const stop = () => events.forEach((type) => document.removeEventListener(type, unlock, true))
    function unlock() {
      unlockAudio()
      if (audioReady()) stop()
    }
    events.forEach((type) => document.addEventListener(type, unlock, true))
    return stop
  }, [])
}

function Elapsed({ startedAt }) {
  const now = useTick(1000, true)
  const start = Date.parse(startedAt)
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0
  return <time className="gym-wo-clock" aria-live="off">{formatDuration(seconds)}</time>
}

// Compact rest countdown in the header: shown only while typing on a phone, when the floating
// rest bar is hidden behind the keyboard.
function HeaderRest({ rest }) {
  const endAt = typeof rest?.endAt === 'number' ? rest.endAt : 0
  const now = useTick(500, endAt > 0)
  const left = Math.ceil((endAt - now) / 1000)
  if (!endAt || left <= 0) return null
  return (
    <span className="gym-wo-rest-chip" aria-hidden="true">
      <Icon name="timer" size={13} strokeWidth={2.2} />
      {formatDuration(left)}
    </span>
  )
}

function NameField({ value }) {
  const [text, setText] = useState(value || '')
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value || '')
  }, [value])
  return (
    <input
      className="gym-wo-name"
      value={text}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        updateActive((current) => (current.name === next ? current : { ...current, name: next }))
      }}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        const tidy = text.trim()
        if (tidy !== text) setText(tidy)
        updateActive((current) => (current.name === tidy ? current : { ...current, name: tidy }))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      placeholder="Workout name"
      aria-label="Workout name"
      autoComplete="off"
      autoCorrect="off"
      enterKeyHint="done"
      maxLength={80}
    />
  )
}

export default function WorkoutScreen({ today }) {
  const workout = useActiveWorkout()
  const gym = useGym()
  const sessions = useGymSessions()
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishedId, setFinishedId] = useState(readFinished)
  const finishedRef = useRef(null)

  const finished = finishedId
    ? sessions.find((session) => session.id === finishedId) || (finishedRef.current?.id === finishedId ? finishedRef.current : null)
    : null

  // A different workout started since this summary: show that one instead.
  useEffect(() => {
    if (workout && finishedId && workout.id !== finishedId) {
      writeFinished(null)
      setFinishedId(null)
    }
  }, [workout, finishedId])

  // The summary is shown once; leaving the screen dismisses it.
  useEffect(() => () => writeFinished(null), [])

  // A past workout being typed in needs no wake lock (nor a clock or rest timers).
  const backfill = isBackfillWorkout(workout)
  useWakeLock(!!workout && !finished && !backfill && gym.prefs.keepAwake)
  useAudioUnlock()

  const onChange = useCallback((next) => {
    updateActive(typeof next === 'function' ? next : () => next)
  }, [])

  const lookup = useMemo(() => volumeLookup(gym), [gym])
  const doneSets = workout ? sessionWorkingSets(workout) : 0
  const volume = useMemo(() => (workout ? sessionVolume(workout, lookup) : 0), [workout, lookup])

  const onFinished = useCallback((session) => {
    finishedRef.current = session
    writeFinished(session?.id || null)
    setFinishedId(session?.id || null)
    setFinishOpen(false)
    window.scrollTo({ top: 0 })
  }, [])

  const doneWithSummary = useCallback(() => {
    writeFinished(null)
    setFinishedId(null)
    navigate('gym')
  }, [])

  async function discard() {
    const ok = await confirmAction({
      title: 'Discard workout?',
      message: 'Everything logged in this workout will be deleted. This can’t be undone.',
      confirmLabel: 'Discard workout',
      tone: 'danger',
    })
    if (!ok) return
    discardActive()
    navigate('gym')
  }

  if (finished) return <WorkoutSummary session={finished} onDone={doneWithSummary} />

  if (!workout) {
    return (
      <div className="gym-workout is-empty">
        <GymEmpty
          icon="dumbbell"
          title="No workout in progress"
          action={<Button icon="chevronLeft" onClick={() => navigate('gym')}>Back to Gym</Button>}
        >
          Start today’s routine or an empty workout from the Gym tab, and it will show up here.
        </GymEmpty>
      </div>
    )
  }

  const unit = gym.prefs.unit

  return (
    <div className="gym-workout">
      <h1 className="sr-only">Workout in progress</h1>
      <header className="gym-wo-bar">
        <button type="button" className="icon-btn gym-wo-min" onClick={() => navigate('gym')} aria-label="Minimise workout" title="Minimise">
          <Icon name="chevronDown" size={24} strokeWidth={2.2} />
        </button>
        <div className="gym-wo-title">
          <NameField value={workout.name} />
          <span className="gym-wo-sub">
            {backfill ? (
              <span className="gym-wo-date">
                <Icon name="calendar" size={13} strokeWidth={2.2} />
                {relativeDay(workout.date, today)}
              </span>
            ) : (
              <>
                <Icon name="timer" size={13} strokeWidth={2.2} />
                <Elapsed startedAt={workout.startedAt} />
              </>
            )}
            <HeaderRest rest={workout.rest} />
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-sm gym-wo-finish" onClick={() => setFinishOpen(true)}>Finish</button>
      </header>

      <div className="gym-wo-stats" role="group" aria-label="So far">
        <div className="gym-wo-stat">
          <span>Sets</span>
          <strong>{doneSets}</strong>
        </div>
        <div className="gym-wo-stat">
          <span>Weight lifted</span>
          <strong>{formatVolume(volume, unit)}</strong>
        </div>
        {workout.isDeload && (
          <span className="gym-wo-deload" title="Lighter week: fewer sets and about 90% of your usual weights">
            <Icon name="layers" size={15} strokeWidth={2.2} />
            Deload
          </span>
        )}
      </div>

      <ExerciseLog workout={workout} onChange={onChange} mode="live" gym={gym} sessions={sessions} />

      <div className="gym-wo-end">
        <button type="button" className="btn btn-ghost gym-wo-discard" onClick={discard}>
          <Icon name="trash" size={18} />
          Discard workout
        </button>
      </div>

      <RestTimer workout={workout} />
      <FinishSheet open={finishOpen} onClose={() => setFinishOpen(false)} workout={workout} onFinished={onFinished} />
    </div>
  )
}

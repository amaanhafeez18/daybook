import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { updateActive, useGym } from '../../lib/gym/state.js'
import { formatDuration } from '../../lib/gym/units.js'
import './workout.css'

// Rest countdown for the active workout. The rest is stored as an endAt timestamp on the workout,
// so it survives backgrounding and reloads; this component only ticks, shows it and ends it.

const OVER_BANNER_MS = 4000
const BEEP_LATE_MS = 3000 // a rest that ended longer ago than this ends silently
const BANNER_LATE_MS = 60000
const RING_RADIUS = 96
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

// ---- audio -------------------------------------------------------------------------------------
// iOS only lets a page make sound once audio was started inside a tap, so unlockAudio() runs on
// the Start / ✓ taps and plays a silent buffer; the beep at the end of a rest then just works.

let audioContext = null

function getContext() {
  if (audioContext) return audioContext
  if (typeof window === 'undefined') return null
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioCtor) return null
  try {
    audioContext = new AudioCtor()
  } catch {
    audioContext = null
  }
  return audioContext
}

function resume(context) {
  try {
    if (context.state === 'suspended' || context.state === 'interrupted') context.resume?.()?.catch?.(() => {})
  } catch {
    // resume can throw outside a gesture on older WebKit
  }
}

export function unlockAudio() {
  try {
    const context = getContext()
    if (!context) return
    resume(context)
    const source = context.createBufferSource()
    source.buffer = context.createBuffer(1, 1, 22050)
    source.connect(context.destination)
    source.start(0)
  } catch {
    // no audio on this device
  }
}

// True once sound can play (or when there is no Web Audio to unlock).
export function audioReady() {
  if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return true
  return audioContext?.state === 'running'
}

// Two short ~880 Hz sine tones.
export function playBeep() {
  try {
    const context = getContext()
    if (!context) return
    resume(context)
    const start = context.currentTime + 0.03
    for (const offset of [0, 0.24]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(offset ? 988 : 880, start + offset)
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.17)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + 0.2)
    }
  } catch {
    // never let a sound break the workout
  }
}

// The rest-over alert (beep when `sound` is on, plus a short buzz), played once per rest by
// whichever of this timer and the floating workout pill sees the rest end first.
// → false when that rest was already alerted.
let alertedEndAt = 0

export function beepOnce(endAt, sound = true) {
  if (!isNum(endAt) || alertedEndAt === endAt) return false
  alertedEndAt = endAt
  if (sound) playBeep()
  try {
    navigator.vibrate?.(200)
  } catch {
    // vibration is optional
  }
  return true
}

// ---- timer -------------------------------------------------------------------------------------

function restOf(workout) {
  const rest = workout?.rest
  return rest && isNum(rest.endAt) ? rest : null
}

export default function RestTimer({ workout }) {
  const gym = useGym()
  const rest = restOf(workout)
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)
  const [overAt, setOverAt] = useState(0)
  const handled = useRef(0)
  const sound = useRef(gym.prefs.timerSound)
  sound.current = gym.prefs.timerSound
  const lastShown = useRef(null)

  const endAt = rest?.endAt ?? 0
  const remainingMs = rest ? endAt - now : 0
  const running = !!rest && remainingMs > 0
  if (running) lastShown.current = { rest, workout }

  // Tick while a rest exists; catch up at once when the app comes back to the foreground.
  useEffect(() => {
    if (!endAt) return undefined
    const tick = () => setNow(Date.now())
    tick()
    const timer = setInterval(tick, 250)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', tick)
    }
  }, [endAt])

  // At zero: beep, buzz, show the banner and clear the rest (once per rest). A rest the pill
  // already alerted (the user tapped it straight back here) ends quietly.
  useEffect(() => {
    if (!endAt || endAt > now || handled.current === endAt) return
    handled.current = endAt
    const late = Date.now() - endAt
    const alertedElsewhere = alertedEndAt === endAt
    if (late < BEEP_LATE_MS) beepOnce(endAt, sound.current)
    if (late < BANNER_LATE_MS && !alertedElsewhere) setOverAt(Date.now())
    setExpanded(false)
    updateActive((current) => (current.rest && current.rest.endAt === endAt ? { ...current, rest: null } : current))
  }, [endAt, now])

  useEffect(() => {
    if (!overAt) return undefined
    const timer = setTimeout(() => setOverAt(0), OVER_BANNER_MS)
    return () => clearTimeout(timer)
  }, [overAt])

  const showBanner = !!overAt && !running
  const floating = running || showBanner

  // Toasts move up while the bar is on screen, so they never cover it.
  useEffect(() => {
    if (!floating) return undefined
    const root = document.documentElement
    root.classList.add('gym-has-float')
    return () => root.classList.remove('gym-has-float')
  }, [floating])

  function adjust(deltaSec) {
    updateActive((current) => {
      const currentRest = restOf(current)
      if (!currentRest) return current
      const nextEnd = currentRest.endAt + deltaSec * 1000
      if (nextEnd <= Date.now() + 500) {
        handled.current = currentRest.endAt
        return { ...current, rest: null }
      }
      const total = Math.max(1, Math.round((isNum(currentRest.durationSec) ? currentRest.durationSec : 0) + deltaSec))
      return { ...current, rest: { ...currentRest, endAt: nextEnd, durationSec: Math.min(3600, total) } }
    })
  }

  function skip() {
    setExpanded(false)
    if (rest) handled.current = rest.endAt
    updateActive((current) => (current.rest ? { ...current, rest: null } : current))
  }

  const view = running ? { rest, workout } : lastShown.current
  const viewRest = view?.rest
  const leftSec = running ? Math.min(Math.ceil(remainingMs / 1000), Math.max(1, Math.round(viewRest?.durationSec || Infinity))) : 0
  const totalMs = Math.max(1000, (isNum(viewRest?.durationSec) ? viewRest.durationSec : 0) * 1000)
  const fraction = running ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0
  const exerciseName = viewRest
    ? (Array.isArray(view.workout?.exercises) ? view.workout.exercises : []).find((exercise) => String(exercise?.id) === String(viewRest.exerciseId))?.name || ''
    : ''
  const time = formatDuration(leftSec)

  return (
    <>
      {running && (
        <div className="gym-rest-bar" role="group" aria-label="Rest timer">
          <button type="button" className="gym-rest-adj" onClick={() => adjust(-15)} aria-label="15 seconds less">−15</button>
          <button type="button" className="gym-rest-main" onClick={() => setExpanded(true)} aria-label={`Rest, ${time} left. Open the timer`}>
            <span className="gym-rest-label">
              <Icon name="timer" size={13} strokeWidth={2.2} />
              <span>{exerciseName ? `Rest · ${exerciseName}` : 'Rest'}</span>
            </span>
            <span className="gym-rest-time" aria-live="off">{time}</span>
            <span className="gym-rest-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${fraction})` }} />
            </span>
          </button>
          <button type="button" className="gym-rest-adj" onClick={() => adjust(15)} aria-label="15 seconds more">+15</button>
          <button type="button" className="gym-rest-skip" onClick={skip}>Skip</button>
        </div>
      )}

      <div className="gym-rest-status" role="status">
        {showBanner && (
          <div className="gym-rest-over">
            <Icon name="check" size={20} strokeWidth={2.6} />
            <span>Rest over</span>
          </div>
        )}
      </div>

      <Sheet open={expanded && running} onClose={() => setExpanded(false)} title="Rest" description={exerciseName || undefined} size="sm" initialFocus={false}>
        <div className="gym-rest-ring" role="timer" aria-label={`${time} left`}>
          <svg viewBox="0 0 220 220" aria-hidden="true">
            <circle className="gym-ring-track" cx="110" cy="110" r={RING_RADIUS} />
            <circle
              className="gym-ring-fill"
              cx="110"
              cy="110"
              r={RING_RADIUS}
              style={{ strokeDasharray: RING_LENGTH, strokeDashoffset: RING_LENGTH * (1 - fraction) }}
            />
          </svg>
          <div className="gym-rest-ring-text" aria-hidden="true">
            <strong>{time}</strong>
            <span>of {formatDuration(isNum(viewRest?.durationSec) ? viewRest.durationSec : 0)}</span>
          </div>
        </div>
        <div className="gym-rest-controls">
          <button type="button" className="btn btn-secondary" onClick={() => adjust(-15)}>−15 s</button>
          <button type="button" className="btn btn-primary" onClick={skip}>
            <Icon name="skipForward" size={18} />
            Skip
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => adjust(15)}>+15 s</button>
        </div>
      </Sheet>
    </>
  )
}

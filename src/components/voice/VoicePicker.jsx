import { useEffect, useState } from 'react'
import Sheet from '../ui/Sheet.jsx'
import Icon from '../ui/Icon.jsx'
import { haptic } from '../../lib/haptics.js'
import { VOICE_NAMES, VOICE_RECOMMENDED } from '../../lib/voice/prefs.js'

// Settings → Voice & AI cost → Voice: every realtime voice, the current one ticked, a ▶ per voice
// that plays a short sample (public/voices/<id>.mp3, made once by scripts/make_voice_samples.mjs and
// fetched only when tapped, never precached). One player for the whole sheet: a new ▶ stops the
// last one, and closing the sheet stops it. Picking a voice saves at once; it's used from the next
// call (a call can't change voice once it has spoken). Every voice costs the same.

export const voiceLabel = (id) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : '')
export const voiceSampleUrl = (id) => `/voices/${id}.mp3`

let player = null // the one <audio> the samples play through
const listeners = new Set()
let playing = null // id of the sample playing, or null
let failed = null // id of a sample that couldn't play

function setPlaying(id, error = null) {
  playing = id
  failed = error
  for (const listener of listeners) listener()
}

export function stopSample() {
  if (player) {
    player.pause()
    player.removeAttribute('src')
    player.load?.()
  }
  setPlaying(null)
}

// Starts inside the tap (iOS plays audio only from a user gesture).
function playSample(id) {
  if (playing === id) {
    stopSample()
    return
  }
  if (typeof Audio !== 'function') return
  if (!player) {
    player = new Audio()
    player.preload = 'none'
    player.addEventListener('ended', () => setPlaying(null))
  }
  player.pause()
  player.src = voiceSampleUrl(id)
  setPlaying(id)
  const started = player.play()
  if (started?.catch) {
    started.catch((error) => {
      if (error?.name === 'AbortError' || playing !== id) return // replaced by another ▶
      setPlaying(null, id)
    })
  }
}

function useSample() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick((n) => n + 1)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])
  return { playing, failed }
}

export default function VoicePicker({ open, onClose, value, onChange }) {
  const sample = useSample()
  const current = VOICE_NAMES.includes(value) ? value : VOICE_NAMES[0]

  // A radio group: one tab stop (the chosen voice); the arrow keys move and choose.
  const onKeyDown = (event) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    if (!step || !event.target.closest?.('[role="radio"]')) return
    event.preventDefault()
    const next = VOICE_NAMES[(VOICE_NAMES.indexOf(current) + step + VOICE_NAMES.length) % VOICE_NAMES.length]
    onChange(next)
    const list = event.currentTarget
    requestAnimationFrame(() => list.querySelector(`[data-voice="${next}"]`)?.focus())
  }

  // Closing the sheet (or leaving Settings) stops a sample.
  useEffect(() => {
    if (!open) stopSample()
    return undefined
  }, [open])
  useEffect(() => () => stopSample(), [])

  return (
    <Sheet open={open} onClose={onClose} title="Voice" size="sm">
      <div className="voice-picker">
        <ul className="voice-picker-list" role="radiogroup" aria-label="Voice" onKeyDown={onKeyDown}>
          {VOICE_NAMES.map((id) => {
            const chosen = id === value
            const isPlaying = sample.playing === id
            const name = voiceLabel(id)
            return (
              <li key={id} role="none" className={`voice-picker-row ${chosen ? 'is-chosen' : ''}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  tabIndex={id === current ? 0 : -1}
                  data-voice={id}
                  className="voice-picker-choose"
                  onClick={() => {
                    if (chosen) return
                    haptic('light')
                    onChange(id)
                  }}
                >
                  <span className="voice-picker-radio" aria-hidden="true">{chosen && <Icon name="check" size={14} strokeWidth={3} />}</span>
                  <span className="voice-picker-name">{name}</span>
                  {VOICE_RECOMMENDED.includes(id) && <span className="voice-picker-tag">Recommended</span>}
                </button>
                <button
                  type="button"
                  className={`voice-picker-play ${isPlaying ? 'is-playing' : ''}`}
                  onClick={() => playSample(id)}
                  aria-label={isPlaying ? `Stop the ${name} sample` : `Play a sample of ${name}`}
                  aria-pressed={isPlaying}
                >
                  <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
                </button>
              </li>
            )
          })}
        </ul>
        {sample.failed && <p className="voice-picker-note is-error" role="status">Couldn’t play the {voiceLabel(sample.failed)} sample. Check your connection and try again.</p>}
        <p className="voice-picker-note">Same price for every voice. Your choice applies to your next call.</p>
      </div>
    </Sheet>
  )
}

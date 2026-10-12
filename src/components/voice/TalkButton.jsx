import { useEffect, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import Sheet from '../ui/Sheet.jsx'
import { Button, Switch } from '../ui/primitives.jsx'
import { toast } from '../ui/feedback.jsx'
import { updateSettings, useData } from '../../lib/store.js'
import { navigate } from '../../lib/router.js'
import { voicePrefs } from '../../lib/voice/prefs.js'
import { VOICE_PREFETCH, startVoice, supportsVoice } from '../../lib/voice/session.js'
import '../settings.css'
import './talk.css'

// Every way into a voice chat: the Talk button in the Assistant's composer, the start screen's
// "Talk it through" row, Journal's "Talk about today" and Today's evening "Talk about your day".
// startVoice runs inside the tap itself (iPhone only lets a tap start the microphone and sound).
// Voice switched off: nothing is removed, the tap opens a small sheet to switch it on. A browser
// without live audio (no WebRTC) shows no button: the voice note and typing still work.
//
// variant: 'composer' (pill in the message bar) | 'row' (full-width row, with `label` and `sub`) |
// 'chip' (a pill on Today) | 'inline' (a small text button, Journal).
// blocked: 'daily' | 'budget' | null, worked out by the caller from the usage on this device;
// a blocked tap explains instead of starting (the server checks again either way).

const BLOCKED_TEXT = {
  daily: 'You’ve used today’s voice minutes. Typing still works.',
  budget: 'This month’s AI budget is used up, so voice is paused. Typing still works.',
}

// The call screen's code loads ahead (a press, or a quiet moment on the Assistant), so the call opens at once.
let prefetched = false
export function prefetchVoice() {
  if (prefetched) return
  prefetched = true
  try {
    VOICE_PREFETCH().catch(() => { prefetched = false })
  } catch {
    prefetched = false
  }
}

export function voiceAvailable() {
  try {
    return supportsVoice()
  } catch {
    return false
  }
}

export default function TalkButton({ intent = 'chat', from = 'assistant', variant = 'composer', label, sub, blocked = null, className = '' }) {
  const settings = useData('settings')
  const prefs = voicePrefs(settings)
  const online = useOnline()
  const [offOpen, setOffOpen] = useState(false)
  if (!voiceAvailable()) return null

  function start() {
    startVoice({ intent, from })
  }

  // Runs in the tap (no await before startVoice).
  function onClick() {
    if (!prefs.enabled) {
      setOffOpen(true)
      return
    }
    if (blocked && BLOCKED_TEXT[blocked]) {
      toast(BLOCKED_TEXT[blocked], { action: { label: 'Settings', onClick: () => navigate('settings/voice') } })
      return
    }
    start()
  }

  const offline = !online
  const common = {
    type: 'button',
    onClick,
    onPointerDown: prefetchVoice,
    onFocus: prefetchVoice,
    disabled: offline,
    title: offline ? 'Needs a connection' : undefined,
  }
  const text = label || 'Talk'
  let button
  if (variant === 'row') {
    button = (
      <button {...common} className={`talk-row ${blocked ? 'is-blocked' : ''} ${className}`}>
        <span className="talk-row-disc" aria-hidden="true"><Icon name="waveform" size={20} strokeWidth={2.2} /></span>
        <span className="talk-row-text">
          <strong>{text}</strong>
          {sub && <small>{sub}</small>}
        </span>
        <Icon name="chevronRight" size={18} className="talk-row-chevron" />
      </button>
    )
  } else if (variant === 'chip') {
    button = (
      <button {...common} className={`talk-chip ${className}`}>
        <Icon name="waveform" size={16} strokeWidth={2.2} />
        <span>{text}</span>
      </button>
    )
  } else if (variant === 'inline') {
    button = (
      <button {...common} className={`talk-inline ${className}`}>
        <Icon name="waveform" size={16} strokeWidth={2.2} />
        <span>{text}</span>
      </button>
    )
  } else {
    button = (
      <button {...common} className={`talk-pill ${blocked ? 'is-blocked' : ''} ${className}`} aria-label={offline ? 'Voice chat needs a connection' : blocked ? 'Talk: voice is paused' : 'Talk: start a voice chat'}>
        <Icon name="waveform" size={18} strokeWidth={2.4} />
        <span aria-hidden="true">{text}</span>
      </button>
    )
  }

  return (
    <>
      {button}
      <VoiceOffSheet open={offOpen} onClose={() => setOffOpen(false)} onStart={() => { setOffOpen(false); start() }} />
    </>
  )
}

// "Voice chats are off": the switch, what it costs, and (once on) a button to start right away.
export function VoiceOffSheet({ open, onClose, onStart }) {
  const settings = useData('settings')
  const prefs = voicePrefs(settings)
  const setEnabled = (enabled) => updateSettings({ voice: { ...rawVoice(settings), enabled } })
  return (
    <Sheet open={open} onClose={onClose} title={prefs.enabled ? 'Voice chats are on' : 'Voice chats are off'} description="Talk with the assistant like a phone call." size="sm" grouped>
      <div className="card set-list talk-off-card">
        <div className="set-row is-switch">
          <Switch label="Voice chat" description="About 4–5¢ a minute. Off costs nothing." checked={prefs.enabled} onChange={setEnabled} />
        </div>
      </div>
      <p className="talk-off-note">Daily minutes, call length and a monthly budget are in Settings → Voice &amp; AI cost.</p>
      <div className="talk-off-actions">
        {prefs.enabled && onStart && <Button icon="waveform" className="btn-grow" onClick={onStart}>Start talking</Button>}
        <Button variant="secondary" className={prefs.enabled ? '' : 'btn-grow'} onClick={() => { onClose(); navigate('settings/voice') }}>Settings</Button>
      </div>
    </Sheet>
  )
}

// settings.voice as saved (missing fields mean the defaults), for a field-level change.
export const rawVoice = (settings) => (settings?.voice && typeof settings.voice === 'object' && !Array.isArray(settings.voice) ? settings.voice : {})

// Whether the device is online (navigator.onLine, kept up to date).
function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

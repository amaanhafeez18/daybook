import React, { Suspense, lazy, useEffect } from 'react'
import VoiceIntro from './VoiceIntro.jsx'
import { subscribeRoute } from '../../lib/router.js'
import { VOICE_PREFETCH, closeVoice, flushUnsent, useVoice } from '../../lib/voice/session.js'

// Mounted once in the app shell. The call screen's code loads only when a call starts (or ahead,
// in a quiet moment on the Assistant); the first-time intro is a sheet. At launch it sends a
// checkpoint the app couldn't send before it was closed, so the last minute of a call is saved.
const VoiceView = lazy(VOICE_PREFETCH)

const idle = (fn) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 2500))

export default function VoiceHost() {
  const voice = useVoice()

  useEffect(() => {
    const timer = setTimeout(() => flushUnsent().catch(() => {}), 1500)
    return () => clearTimeout(timer)
  }, [])

  // On the Assistant (where Talk is), the call screen's code is fetched once things are quiet.
  useEffect(() => {
    let done = false
    const check = () => {
      if (done || !/^#\/?assistant(?:[/?]|$)/.test(window.location.hash)) return
      done = true
      idle(() => VOICE_PREFETCH().catch(() => { done = false }))
    }
    check()
    return subscribeRoute(check)
  }, [])

  const open = voice.status !== 'idle'
  return (
    <>
      <VoiceIntro open={!!voice.intro} />
      {open && (
        <VoiceBoundary>
          <Suspense fallback={<div className="voice-loading" style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'var(--bg)' }} aria-busy="true" />}>
            <VoiceView />
          </Suspense>
        </VoiceBoundary>
      )}
    </>
  )
}

// A call screen that fails to load (a new version replaced its file, or offline) never takes the
// app down: a small layer explains, and closing it ends the call.
class VoiceBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Voice chat screen failed:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alertdialog" aria-label="Voice chat" style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'var(--bg)', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <p style={{ marginBottom: 16 }}>Couldn’t open the voice chat. Reloading Daybook usually fixes this.</p>
          <button type="button" className="btn btn-primary" onClick={() => {
            this.setState({ error: null })
            closeVoice()
          }}>Close</button>
        </div>
      </div>
    )
  }
}

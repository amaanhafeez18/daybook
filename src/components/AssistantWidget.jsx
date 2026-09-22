import { useEffect, useRef, useState } from 'react'
import { getToken, todayISO } from '../lib/storage.js'

const MAX_RECORDING_SECONDS = 120
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const canRecord = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

export default function AssistantWidget({ onDataChanged, suggestions = [] }) {
  const [messages, setMessages] = useState([])
  const [memories, setMemories] = useState([])
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [debugEntries, setDebugEntries] = useState([])
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [speakReplies, setSpeakReplies] = useState(() => {
    try { return localStorage.getItem('daybook.assistant.speak') === 'true' } catch { return false }
  })
  const recorderRef = useRef(null)
  const timerRef = useRef(null)
  const discardRef = useRef(false)
  const endRef = useRef(null)

  useEffect(() => {
    request('/api/assistant')
      .then((response) => {
        setMessages(response.messages || [])
        setMemories(response.memories || [])
        setMemoryEnabled(response.memoryEnabled !== false)
      })
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, loading])

  // Stop the mic and any speech if the tab is closed mid-recording.
  useEffect(() => () => {
    discardRef.current = true
    recorderRef.current?.state === 'recording' && recorderRef.current.stop()
    clearInterval(timerRef.current)
    window.speechSynthesis?.cancel()
  }, [])

  async function send(payload, pendingText) {
    setError('')
    setDebugEntries([])
    setLoading(true)
    const pendingId = `pending-${Date.now()}`
    setMessages((current) => [...current, { id: pendingId, role: 'user', content: pendingText, pending: true, voice: !!payload.audio }])

    try {
      const response = await request('/api/assistant', {
        method: 'POST',
        body: JSON.stringify({ ...payload, context: clientContext() }),
      })
      setMessages((current) => [
        ...current.map((message) => message.id === pendingId
          ? { role: 'user', content: response.transcript || message.content, voice: message.voice }
          : message),
        { role: 'assistant', content: response.reply },
      ])
      if (response.memories) setMemories(response.memories)
      if (response.dataChanged) onDataChanged?.()
      if (speakReplies && response.reply) speak(response.reply)
    } catch (err) {
      setMessages((current) => current.filter((message) => message.id !== pendingId))
      if (!payload.audio) setText(pendingText)
      setError(err.message)
      setDebugEntries(err.debug || [])
    } finally {
      setLoading(false)
    }
  }

  function sendText(event, preset) {
    event?.preventDefault()
    const message = (preset ?? text).trim()
    if (!message || loading || recording) return
    setText('')
    send({ message }, message)
  }

  async function startRecording() {
    if (!canRecord) {
      setError('Voice recording isn’t supported in this browser.')
      return
    }
    setError('')
    window.speechSynthesis?.cancel()
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError('Microphone access was blocked. Allow it in your browser settings to talk to Daybook.')
      return
    }

    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
    const chunks = []
    discardRef.current = false
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      clearInterval(timerRef.current)
      setRecording(false)
      if (discardRef.current) return
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      if (blob.size < 2000) {
        setError('That was too short. Hold on a moment longer before tapping send.')
        return
      }
      send({ audio: await blobToBase64(blob), mimeType: blob.type }, 'Voice message…')
    }

    recorderRef.current = recorder
    recorder.start()
    setSeconds(0)
    setRecording(true)
    timerRef.current = setInterval(() => {
      setSeconds((value) => {
        if (value + 1 >= MAX_RECORDING_SECONDS) stopRecording()
        return value + 1
      })
    }, 1000)
  }

  function stopRecording(discard = false) {
    discardRef.current = discard
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  async function newChat() {
    try {
      await request('/api/assistant', { method: 'DELETE' })
      setMessages([])
      setDebugEntries([])
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }

  async function forgetMemory(memory) {
    try {
      await request(`/api/assistant?memoryId=${encodeURIComponent(memory.id)}`, { method: 'DELETE' })
      setMemories((current) => current.filter((item) => item.id !== memory.id))
    } catch (err) {
      setError(err.message)
    }
  }

  function toggleSpeak(event) {
    const enabled = event.target.checked
    setSpeakReplies(enabled)
    if (!enabled) window.speechSynthesis?.cancel()
    try { localStorage.setItem('daybook.assistant.speak', String(enabled)) } catch { /* ignore */ }
  }

  return (
    <section className="assistant-panel assistant-panel-embedded" aria-label="Daybook Assistant">
      <header className="assistant-header">
        <div>
          <strong>Daybook Assistant</strong>
          <span>Knows your tasks, calendar, people and notes</span>
        </div>
        <label className="assistant-speak-toggle"><input type="checkbox" checked={speakReplies} onChange={toggleSpeak} /> Read replies aloud</label>
        <button className="assistant-new-chat" type="button" onClick={newChat} disabled={loading}>New chat</button>
      </header>

      <details className="assistant-memories">
        <summary>What I remember ({memories.length})</summary>
        {!memoryEnabled ? (
          <p className="empty-note">Memory isn’t set up yet. Run the assistant_memories migration in Supabase.</p>
        ) : memories.length === 0 ? (
          <p className="empty-note">Nothing yet. Tell me about yourself (“my sister is Sara”, “I’m vegetarian”) and I’ll remember it.</p>
        ) : (
          <ul>
            {memories.map((memory) => (
              <li key={memory.id}>
                <span>{memory.content}</span>
                <button type="button" className="row-delete" aria-label={`Forget: ${memory.content}`} onClick={() => forgetMemory(memory)}>×</button>
              </li>
            ))}
          </ul>
        )}
      </details>

      <div className="assistant-messages">
        {messages.length === 0 && !loading && (
          <p className="assistant-welcome">Talk to me like a person. Ask what’s on today, tell me about your day, or say things like “move the dentist to Friday at 3” or “Ali just started at Google, I talked to him today.” Tap the mic to speak.</p>
        )}
        {messages.map((message, index) => (
          <div className={`assistant-message ${message.role} ${message.pending ? 'is-pending' : ''}`} key={message.id || `${message.createdAt || 'm'}-${index}`}>
            {message.voice && <span className="assistant-voice-tag" aria-label="Voice message">🎤 </span>}
            {message.content}
          </div>
        ))}
        {loading && <div className="assistant-message assistant-loading">{messages.at(-1)?.voice ? 'Listening and thinking…' : 'Thinking…'}</div>}
        <div ref={endRef} />
      </div>

      {messages.length === 0 && suggestions.length > 0 && (
        <div className="assistant-suggestions">
          {suggestions.map((suggestion) => <button type="button" key={suggestion} disabled={loading} onClick={() => sendText(null, suggestion)}>{suggestion}</button>)}
        </div>
      )}

      {error && <p className="assistant-error">{error}</p>}
      {error && debugEntries.length > 0 && (
        <details className="assistant-debug">
          <summary>Details</summary>
          <pre>{debugEntries.map((entry) => JSON.stringify(entry)).join('\n')}</pre>
        </details>
      )}

      {recording ? (
        <div className="assistant-composer assistant-recording">
          <button type="button" className="btn-small btn-ghost" onClick={() => stopRecording(true)}>Cancel</button>
          <span className="assistant-recording-label"><i aria-hidden="true" /> Recording {formatSeconds(seconds)}</span>
          <button type="button" className="btn-small" onClick={() => stopRecording(false)}>Send</button>
        </div>
      ) : (
        <form className="assistant-composer" onSubmit={sendText}>
          <textarea
            rows="2"
            value={text}
            placeholder="Message Daybook…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendText(event)
              }
            }}
          />
          {canRecord && (
            <button type="button" className="assistant-icon assistant-mic" aria-label="Record a voice message" disabled={loading} onClick={startRecording}>
              <MicIcon />
            </button>
          )}
          <button type="submit" className="btn-small" disabled={loading || !text.trim()}>Send</button>
        </form>
      )}
    </section>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

function speak(text) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
}

function clientContext() {
  const now = new Date()
  return {
    localDate: todayISO(),
    localTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

function formatSeconds(total) {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('Could not read the recording.'))
    reader.readAsDataURL(blob)
  })
}

async function request(url, options = {}) {
  const token = getToken()
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const raw = await response.text()
  let payload
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    const error = new Error(`The server returned an unexpected response (${response.status}). Please try again.`)
    error.debug = [{ step: 'browser.response', httpStatus: response.status, bodyPreview: raw.slice(0, 300) }]
    throw error
  }
  if (!response.ok) {
    const error = new Error(payload.error || 'Assistant request failed')
    error.debug = payload.debug
    throw error
  }
  return payload
}

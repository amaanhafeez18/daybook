import { useEffect, useRef, useState } from 'react'
import { getToken } from '../lib/storage.js'

const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export default function AssistantWidget({ onDataChanged, embedded = false, suggestions = [] }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const [debugEntries, setDebugEntries] = useState([])
  const [speakReplies, setSpeakReplies] = useState(() => {
    try { return localStorage.getItem('daybook.assistant.speak') === 'true' } catch { return false }
  })
  const recognitionRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => {
    if ((!open && !embedded) || messages.length > 0) return
    loadHistory()
  }, [open, embedded, messages.length])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => () => recognitionRef.current?.stop(), [])

  async function loadHistory() {
    try {
      const response = await request('/api/assistant')
      setMessages(response.messages || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function sendMessage(event, presetText) {
    event?.preventDefault()
    const message = (presetText ?? text).trim()
    if (!message || loading) return
    setText('')
    setError('')
    setMessages((current) => [...current, { role: 'user', content: message }])
    setLoading(true)

    try {
      const response = await request('/api/assistant', {
        method: 'POST',
        body: JSON.stringify({ message }),
      })
      setMessages((current) => [...current, { role: 'assistant', content: response.reply || 'I received your message, but no text response was returned.' }])
      setDebugEntries(response.debug || [])
      if (speakReplies && typeof window !== 'undefined' && 'speechSynthesis' in window && response.reply) {
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(response.reply))
      }
      if (response.results?.some((result) => result.ok)) onDataChanged?.()
    } catch (err) {
      setError(err.message)
      setDebugEntries(err.debug || [{ step: 'browser.error', message: err.message }])
    } finally {
      setLoading(false)
    }
  }

  function toggleListening() {
    if (!SpeechRecognition) return
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join('')
      setText(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  async function newChat() {
    try {
      await request('/api/assistant', { method: 'DELETE' })
      setMessages([])
      setDebugEntries([])
      setError('')
    } catch (err) {
      setError(err.message)
      setDebugEntries(err.debug || [{ step: 'browser.error', message: err.message }])
    }
  }

  const panel = (
    <>
      {(open || embedded) && (
        <section className={`assistant-panel ${embedded ? 'assistant-panel-embedded' : ''}`} aria-label="Daybook Assistant">
          <header className="assistant-header">
            <div>
              <strong>Daybook Assistant</strong>
              <span>Tasks, people, plans, and notes</span>
            </div>
            <button className="assistant-new-chat" type="button" onClick={newChat}>New chat</button>
            <label className="assistant-speak-toggle"><input type="checkbox" checked={speakReplies} onChange={(event) => {
              setSpeakReplies(event.target.checked)
              if (!event.target.checked) window.speechSynthesis?.cancel()
              try { localStorage.setItem('daybook.assistant.speak', String(event.target.checked)) } catch { /* ignore */ }
            }} /> Speak</label>
            {!embedded && <button className="row-delete" aria-label="Close assistant" onClick={() => setOpen(false)}>×</button>}
          </header>

          <div className="assistant-messages">
            {messages.length === 0 && <p className="assistant-welcome">I can chat normally, help you think through something, or manage Daybook. Try “test”, “help me plan my week”, or “remind me to email Alex tomorrow at 9 AM.”</p>}
            {messages.map((message, index) => (
              <div className={`assistant-message ${message.role}`} key={`${message.createdAt || 'message'}-${index}`}>
                {message.content}
              </div>
            ))}
            {loading && <div className="assistant-message assistant-loading">Working on it…</div>}
            <div ref={endRef} />
          </div>

          {embedded && messages.length === 0 && (
            <div className="assistant-suggestions">
              {suggestions.map((suggestion) => <button type="button" key={suggestion} disabled={loading} onClick={() => sendMessage(null, suggestion)}>{suggestion}</button>)}
            </div>
          )}

          {error && <p className="assistant-error">{error}</p>}
          <details className="assistant-debug" open={!!error && debugEntries.length > 0}>
            <summary>Diagnostics {debugEntries.length ? `(${debugEntries.length} entries)` : ''}</summary>
            <pre>{debugEntries.length ? formatDebug(debugEntries) : 'Send a message to inspect the request.'}</pre>
          </details>
          <form className="assistant-composer" onSubmit={sendMessage}>
            <textarea
              rows="2"
              value={text}
              placeholder="Ask Daybook to do something..."
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  sendMessage(event)
                }
              }}
            />
            {SpeechRecognition && <button type="button" className={`assistant-icon ${listening ? 'is-listening' : ''}`} aria-label="Use voice input" onClick={toggleListening}>{listening ? '■' : '●'}</button>}
            <button type="submit" className="btn-small" disabled={loading || !text.trim()}>Send</button>
          </form>
        </section>
      )}
      {!embedded && <button className="assistant-fab" aria-label={open ? 'Close Daybook Assistant' : 'Open Daybook Assistant'} onClick={() => setOpen((value) => !value)}>
        {open ? '×' : '✦'}
      </button>}
    </>
  )

  return embedded ? panel : panel
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
    const error = new Error(`Server returned non-JSON (${response.status}): ${raw.slice(0, 500)}`)
    error.debug = [{ step: 'browser.response', httpStatus: response.status, contentType: response.headers.get('content-type'), bodyPreview: raw.slice(0, 500) }]
    throw error
  }
  if (!response.ok) {
    const error = new Error(payload.error || 'Assistant request failed')
    error.debug = payload.debug
    throw error
  }
  return payload
}

function formatDebug(entries) {
  return `Debug trace\n${entries.map((entry) => JSON.stringify(entry)).join('\n')}`
}

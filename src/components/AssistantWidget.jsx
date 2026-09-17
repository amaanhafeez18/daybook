import { useEffect, useRef, useState } from 'react'
import { getToken } from '../lib/storage.js'

const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export default function AssistantWidget({ onDataChanged }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const recognitionRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => {
    if (!open || messages.length > 0) return
    loadHistory()
  }, [open, messages.length])

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

  async function sendMessage(event) {
    event?.preventDefault()
    const message = text.trim()
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
      setMessages((current) => [...current, { role: 'assistant', content: response.reply }])
      if (response.debug?.length) {
        setMessages((current) => [...current, { role: 'debug', content: formatDebug(response.debug) }])
      }
      if (response.results?.some((result) => result.ok)) onDataChanged?.()
    } catch (err) {
      setError(err.message)
      if (err.debug?.length) {
        setMessages((current) => [...current, { role: 'debug', content: formatDebug(err.debug) }])
      }
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

  return (
    <>
      {open && (
        <section className="assistant-panel" aria-label="Daybook Assistant">
          <header className="assistant-header">
            <div>
              <strong>Daybook Assistant</strong>
              <span>Tasks, people, plans, and notes</span>
            </div>
            <button className="row-delete" aria-label="Close assistant" onClick={() => setOpen(false)}>×</button>
          </header>

          <div className="assistant-messages">
            {messages.length === 0 && <p className="assistant-welcome">Tell me what you want to add or find. For example: “Remind me to email Alex tomorrow at 9 AM.”</p>}
            {messages.map((message, index) => (
              <div className={`assistant-message ${message.role}`} key={`${message.createdAt || 'message'}-${index}`}>
                {message.content}
              </div>
            ))}
            {loading && <div className="assistant-message assistant-loading">Working on it…</div>}
            <div ref={endRef} />
          </div>

          {error && <p className="assistant-error">{error}</p>}
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
      <button className="assistant-fab" aria-label={open ? 'Close Daybook Assistant' : 'Open Daybook Assistant'} onClick={() => setOpen((value) => !value)}>
        {open ? '×' : '✦'}
      </button>
    </>
  )
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
  const payload = await response.json()
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

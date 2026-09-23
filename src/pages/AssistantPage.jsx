import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { AutoTextarea, IconButton } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import { SESSION_EXPIRED_EVENT, apiRequest, getToken, readJson, readPref, writeJson, writePref } from '../lib/api.js'
import { refresh } from '../lib/store.js'
import { nowTimeHHMM, todayISO } from '../lib/dates.js'

const CHAT_CACHE = 'daybook.chat'
const MAX_RECORDING_SECONDS = 120
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const canRecord = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

const SUGGESTIONS = [
  { icon: 'sun', text: 'What’s on my plate today?' },
  { icon: 'calendar', text: 'Help me plan the rest of my week' },
  { icon: 'people', text: 'Who should I catch up with?' },
  { icon: 'moon', text: 'What are today’s prayer times?' },
]

let messageId = 0
const nextId = () => `m${Date.now()}-${++messageId}`

export default function AssistantPage({ displayName }) {
  const [messages, setMessages] = useState(() => (readJson(CHAT_CACHE, []) || []).map((message) => ({ ...message, id: nextId() })))
  const [memories, setMemories] = useState([])
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [speak, setSpeak] = useState(() => readPref('speakReplies', false))
  // Screen readers hear the finished reply once, not every streamed token.
  const [announcement, setAnnouncement] = useState('')
  const endRef = useRef(null)
  const abortRef = useRef(null)
  const busyRef = useRef(false)
  const followRef = useRef(true) // keep the newest message in view unless the user scrolled up
  const jumpRef = useRef(true) // next scroll is instant (first render, loaded history)

  // Server history (source of truth) and memories.
  useEffect(() => {
    apiRequest('/api/assistant')
      .then((response) => {
        const history = (response.messages || []).map((message) => ({ ...message, id: nextId() }))
        jumpRef.current = true
        followRef.current = true
        setMessages((current) => (current.some((message) => message.streaming || message.pending) ? current : history))
        writeJson(CHAT_CACHE, response.messages || [])
        setMemories(response.memories || [])
        setMemoryEnabled(response.memoryEnabled !== false)
      })
      .catch(() => {})
    return () => {
      abortRef.current?.abort()
      window.speechSynthesis?.cancel()
    }
  }, [])

  useEffect(() => {
    const onScroll = () => {
      const end = endRef.current
      if (end) followRef.current = end.getBoundingClientRect().bottom <= window.innerHeight + 150
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // While a reply streams in, jump rather than restart a smooth scroll on every token.
  useEffect(() => {
    if (!followRef.current) return
    const behavior = jumpRef.current || busy ? 'auto' : 'smooth'
    jumpRef.current = false
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior }))
    return () => cancelAnimationFrame(frame)
  }, [messages, busy])

  // Cache the finished conversation so it shows instantly next time.
  useEffect(() => {
    if (busy) return
    const finished = messages.filter((message) => !message.error && !message.streaming && !message.pending)
    writeJson(CHAT_CACHE, finished.map(({ role, content, voice, actions }) => ({ role, content, ...(voice ? { voice } : {}), ...(actions?.length ? { actions } : {}) })).slice(-40))
  }, [messages, busy])

  function patchMessage(id, patch) {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)))
  }

  async function send(payload, shownText) {
    if (busyRef.current) return
    busyRef.current = true
    window.speechSynthesis?.cancel()
    if (speak) unlockSpeech()
    const userId = nextId()
    const replyId = nextId()
    const hasAudio = !!payload.audio
    const isVoice = hasAudio || !!payload.spoken
    setBusy(true)
    setAnnouncement('')
    followRef.current = true
    setMessages((current) => [
      ...current.filter((message) => !message.error),
      { id: userId, role: 'user', content: shownText, voice: isVoice, pending: hasAudio },
      { id: replyId, role: 'assistant', content: '', streaming: true, status: hasAudio ? 'Listening…' : 'Thinking…', actions: [] },
    ])

    const controller = new AbortController()
    abortRef.current = controller
    let acted = false // something was saved, so the request must not simply be sent again
    let transcript = ''
    try {
      const done = await streamAssistant({ ...payload, context: clientContext() }, controller.signal, (event) => {
        if (event.type === 'status') patchMessage(replyId, { status: event.text })
        else if (event.type === 'transcript') {
          transcript = event.text
          patchMessage(userId, { content: event.text, pending: false })
        } else if (event.type === 'delta') patchMessage(replyId, (message) => ({ content: message.content + event.text, status: '' }))
        else if (event.type === 'action') {
          if (event.ok) acted = true
          patchMessage(replyId, (message) => ({ actions: [...message.actions, { tool: event.tool, ok: event.ok, message: event.message }] }))
        }
      })
      patchMessage(userId, { pending: false, ...(done.transcript ? { content: done.transcript } : {}) })
      patchMessage(replyId, { content: done.reply, streaming: false, status: '', actions: (done.results || []).filter((result) => !['search', 'read_journal', 'get_weather', 'get_prayer_times'].includes(result.tool) || !result.ok) })
      if (done.memories) setMemories(done.memories)
      if (done.dataChanged) refresh().catch(() => {})
      if (speak) speakText(done.reply)
      else setAnnouncement(plainText(done.reply || ''))
    } catch (error) {
      if (error.name === 'AbortError') {
        // Stopped by the user: keep whatever arrived so far.
        patchMessage(replyId, (message) => ({ streaming: false, status: '', content: message.content || 'Stopped.' }))
        patchMessage(userId, { pending: false })
        setAnnouncement('Stopped.')
        if (acted) refresh().catch(() => {})
        return
      }
      if (acted) {
        // Keep the reply and its action chips, load what was saved, and offer no retry
        // (it would repeat those actions).
        patchMessage(replyId, () => ({ streaming: false, status: '' }))
        patchMessage(userId, { pending: false })
        refresh().catch(() => {})
        setMessages((current) => current.concat({ id: nextId(), role: 'assistant', error: `${error.message} Some changes were already made.` }))
        return
      }
      // Once a voice message is transcribed, a retry sends the text instead of the audio again.
      const retry = transcript ? { payload: { message: transcript, spoken: true }, shownText: transcript, userId } : { payload, shownText, userId }
      setMessages((current) => current
        .filter((message) => message.id !== replyId && !(message.id === userId && hasAudio && message.pending))
        .concat({ id: nextId(), role: 'assistant', error: error.message, retry }))
    } finally {
      abortRef.current = null
      busyRef.current = false
      setBusy(false)
    }
  }

  function submitText(event, preset) {
    event?.preventDefault()
    const message = (preset ?? text).trim()
    if (!message || busy) return
    setText('')
    send({ message }, message)
  }

  function retry(message) {
    // Drop the error and the message that failed; send() adds the message back.
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id)
      const previous = current[index - 1]
      const failedId = message.retry.userId ?? (previous?.role === 'user' && previous.content === message.retry.shownText ? previous.id : null)
      return current.filter((item, position) => position !== index && item.id !== failedId)
    })
    send(message.retry.payload, message.retry.shownText)
  }

  // Stable across renders, so unchanged messages don't re-render while a reply streams.
  const retryRef = useRef(retry)
  retryRef.current = retry
  const onRetry = useCallback((message) => retryRef.current(message), [])

  async function newChat() {
    if (messages.length && !(await confirmAction({ title: 'Start a new chat?', message: 'This clears the conversation. What I remember about you is kept.', confirmLabel: 'New chat', tone: 'default' }))) return
    try {
      await apiRequest('/api/assistant', { method: 'DELETE' })
      setMessages([])
      writeJson(CHAT_CACHE, [])
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  function toggleSpeak() {
    const next = !speak
    setSpeak(next)
    writePref('speakReplies', next)
    if (next) unlockSpeech()
    else window.speechSynthesis?.cancel()
    toast(next ? 'Replies will be read aloud' : 'Replies won’t be read aloud')
  }

  const empty = messages.length === 0

  return (
    <div className="assistant">
      <header className="assistant-header">
        <div>
          <h1>Assistant</h1>
          <p className="page-subtitle">Knows your tasks, calendar, people and notes</p>
        </div>
        <div className="assistant-tools">
          <IconButton icon={speak ? 'volume' : 'volumeOff'} label={speak ? 'Stop reading replies aloud' : 'Read replies aloud'} active={speak} onClick={toggleSpeak} />
          <button type="button" className="icon-btn has-badge" onClick={() => setMemoryOpen(true)} aria-label={`What I remember (${memories.length})`} title="What I remember">
            <Icon name="bookmark" size={20} />
            {memories.length > 0 && <span className="badge-count">{memories.length}</span>}
          </button>
          <IconButton icon="message" label="New chat" onClick={newChat} disabled={busy} />
        </div>
      </header>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="chat">
        {empty ? (
          <div className="chat-welcome">
            <span className="assistant-avatar assistant-avatar-lg" aria-hidden="true"><Icon name="sparkles" size={30} /></span>
            <h2>Hi {displayName.split(' ')[0]}, how can I help?</h2>
            <p>Ask about your day, tell me what’s going on, or say things like “move the dentist to Friday at 3” or “Ali started a new job — we had coffee today.”</p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion.text} type="button" className="suggestion" onClick={() => submitText(null, suggestion.text)} disabled={busy}>
                  <Icon name={suggestion.icon} size={18} />
                  <span>{suggestion.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : messages.map((message) => <Message key={message.id} message={message} onRetry={onRetry} />)}
        <div ref={endRef} className="chat-end" />
      </div>

      <div className="composer-dock">
        <Composer
          text={text}
          setText={setText}
          busy={busy}
          onSubmit={submitText}
          onAudio={(audio, mimeType) => send({ audio, mimeType }, 'Voice message')}
          onStop={() => abortRef.current?.abort()}
        />
      </div>

      <MemorySheet open={memoryOpen} onClose={() => setMemoryOpen(false)} memories={memories} setMemories={setMemories} enabled={memoryEnabled} />
    </div>
  )
}

const Message = memo(function Message({ message, onRetry }) {
  if (message.error) {
    return (
      <div className="msg msg-assistant msg-error" role="alert">
        <span className="assistant-avatar" aria-hidden="true"><Icon name="alert" size={16} /></span>
        <div className="msg-body">
          <p>{message.error}</p>
          {message.retry && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRetry(message)}><Icon name="refresh" size={16} />Try again</button>}
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className={`msg msg-user ${message.pending ? 'is-pending' : ''}`}>
        <div className="msg-bubble">
          {message.voice && <Icon name="mic" size={15} />}
          {message.pending ? <span className="typing" aria-label="Transcribing"><i /><i /><i /></span> : message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="msg msg-assistant">
      <span className="assistant-avatar" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
      <div className="msg-body">
        {message.content ? <RichText text={message.content} /> : null}
        {message.streaming && !message.content && (
          <p className="msg-status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{message.status}</p>
        )}
        {message.streaming && message.content && message.status && <p className="msg-status">{message.status}</p>}
        {message.actions?.length > 0 && (
          <ul className="action-chips">
            {message.actions.map((action, index) => (
              <li key={index} className={action.ok ? 'is-ok' : 'is-failed'}>
                <Icon name={action.ok ? 'check' : 'alert'} size={14} />
                {action.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
})

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/

// Minimal, safe markdown: paragraphs, bullet/numbered lists, **bold**, *italic*, `code`.
// A block can mix text and list lines (e.g. an intro line followed by bullets).
function RichText({ text }) {
  const blocks = text.trim().split(/\n{2,}/)
  return blocks.flatMap((block, index) => {
    const groups = []
    for (const line of block.split('\n')) {
      const isItem = LIST_ITEM.test(line)
      const last = groups[groups.length - 1]
      if (last && last.isItem === isItem) last.lines.push(line)
      else groups.push({ isItem, lines: [line] })
    }
    return groups.map(({ isItem, lines }, groupIndex) => {
      const key = `${index}-${groupIndex}`
      if (isItem) {
        const ordered = /^\s*\d/.test(lines[0])
        const List = ordered ? 'ol' : 'ul'
        return <List key={key} start={ordered ? parseInt(lines[0], 10) || 1 : undefined}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(LIST_ITEM, ''))}</li>)}</List>
      }
      return <p key={key}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{inline(line)}</Fragment>)}</p>
    })
  })
}

function inline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g)
  return parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>
    return part
  })
}

function Composer({ text, setText, busy, onSubmit, onAudio, onStop }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [levels, setLevels] = useState(() => Array(28).fill(0.08))
  const [micError, setMicError] = useState('')
  const recorderRef = useRef(null)
  const discardRef = useRef(false)
  const cleanupRef = useRef(null)
  const mountedRef = useRef(false)
  const startingRef = useRef(false)
  // The recording finishes later; send it with the latest handler, not the one from when it started.
  const onAudioRef = useRef(onAudio)
  onAudioRef.current = onAudio

  useEffect(() => {
    mountedRef.current = true // set here too, for StrictMode's unmount/remount
    return () => {
      mountedRef.current = false
      discardRef.current = true
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      cleanupRef.current?.()
    }
  }, [])

  async function start() {
    if (startingRef.current || recorderRef.current?.state === 'recording') return
    startingRef.current = true
    try {
      await startRecording()
    } finally {
      startingRef.current = false
    }
  }

  async function startRecording() {
    setMicError('')
    window.speechSynthesis?.cancel()
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setMicError('Microphone access is blocked. Allow it in your browser settings to talk to Daybook.')
      return
    }
    // Left the page while the permission prompt was open: release the microphone.
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    let raf = 0
    let audioContext = null
    let timer = null
    const cleanup = () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
      stream.getTracks().forEach((track) => track.stop())
      audioContext?.close().catch(() => {})
    }
    cleanupRef.current = cleanup

    // Live level meter.
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
      audioContext.resume?.().catch(() => {}) // iOS starts audio contexts suspended
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      audioContext.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      let lastPush = 0
      const tick = (time) => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
        if (time - lastPush > 70) {
          lastPush = time
          setLevels((current) => [...current.slice(1), Math.max(0.08, level)])
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      // meter is decorative
    }

    const chunks = []
    let recorder
    try {
      const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = async () => {
        cleanup()
        setRecording(false)
        setLevels(Array(28).fill(0.08))
        if (discardRef.current) return
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        if (blob.size < 2000) {
          setMicError('That was too short — hold on a moment longer before sending.')
          return
        }
        try {
          onAudioRef.current(await blobToBase64(blob), blob.type)
        } catch (error) {
          setMicError(error.message)
        }
      }
      discardRef.current = false
      recorderRef.current = recorder
      recorder.start()
    } catch {
      cleanup()
      setLevels(Array(28).fill(0.08))
      setMicError('Recording isn’t supported in this browser.')
      return
    }

    setSeconds(0)
    setRecording(true)
    let elapsed = 0
    timer = setInterval(() => {
      elapsed += 1
      setSeconds(elapsed)
      if (elapsed >= MAX_RECORDING_SECONDS && recorder.state === 'recording') recorder.stop()
    }, 1000)
  }

  function stop(discard) {
    discardRef.current = discard
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  if (recording) {
    return (
      <div className="composer is-recording">
        <button type="button" className="icon-btn" onClick={() => stop(true)} aria-label="Cancel recording"><Icon name="close" /></button>
        <div className="recorder" aria-label={`Recording, ${formatSeconds(seconds)}`}>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">{formatSeconds(seconds)}</span>
          <span className="waveform" aria-hidden="true">
            {levels.map((level, index) => <i key={index} style={{ transform: `scaleY(${level})` }} />)}
          </span>
        </div>
        <button type="button" className="send-btn" onClick={() => stop(false)} aria-label="Send voice message"><Icon name="send" size={20} strokeWidth={2.2} /></button>
      </div>
    )
  }

  return (
    <>
      {micError && <p className="composer-error" role="alert">{micError}</p>}
      <form className="composer" onSubmit={onSubmit}>
        <AutoTextarea
          className="composer-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
              event.preventDefault()
              onSubmit(event)
            }
          }}
          placeholder="Message Daybook…"
          aria-label="Message"
          minRows={1}
          maxRows={6}
          maxLength={4000}
        />
        {busy ? (
          <button type="button" className="send-btn is-stop" onClick={onStop} aria-label="Stop"><span className="stop-square" /></button>
        ) : text.trim() ? (
          <button type="submit" className="send-btn" aria-label="Send"><Icon name="send" size={20} strokeWidth={2.2} /></button>
        ) : canRecord ? (
          <button type="button" className="send-btn is-mic" onClick={start} aria-label="Record a voice message"><Icon name="mic" size={20} /></button>
        ) : (
          <button type="submit" className="send-btn" aria-label="Send" disabled><Icon name="send" size={20} strokeWidth={2.2} /></button>
        )}
      </form>
    </>
  )
}

function MemorySheet({ open, onClose, memories, setMemories, enabled }) {
  async function forget(memory) {
    try {
      await apiRequest(`/api/assistant?memoryId=${encodeURIComponent(memory.id)}`, { method: 'DELETE' })
      setMemories((current) => current.filter((item) => item.id !== memory.id))
      toast('Forgotten')
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="What I remember" description="Facts you’ve told me. I use them in every conversation." initialFocus={false}>
      {!enabled ? (
        <p className="muted">Memory isn’t switched on yet: the assistant_memories table needs to be created in Supabase.</p>
      ) : memories.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon"><Icon name="bookmark" size={24} /></span>
          <h3>Nothing yet</h3>
          <p>Tell me things like “my sister is Sara” or “I’m vegetarian” and I’ll remember them.</p>
        </div>
      ) : (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <span>{memory.content}</span>
              <button type="button" className="icon-btn icon-btn-sm" onClick={() => forget(memory)} aria-label={`Forget: ${memory.content}`}><Icon name="close" size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

// POST with stream:true and read newline-delimited JSON events as they arrive.
async function streamAssistant(payload, signal, onEvent) {
  const token = getToken()
  const response = await fetch('/api/assistant', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ...payload, stream: true }),
  }).catch((error) => {
    if (error.name === 'AbortError') throw error
    throw new Error('You’re offline — the assistant needs a connection.')
  })

  if (!response.ok || !(response.headers.get('content-type') || '').includes('ndjson')) {
    const raw = await response.text()
    let data = {}
    try { data = JSON.parse(raw) } catch { /* not JSON */ }
    // Only when the session that sent this is still the current one.
    if (response.status === 401 && token && getToken() === token) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    throw new Error(data.error || `The assistant is unavailable right now (${response.status}).`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = null
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (error) {
      // iOS reports a dropped connection as a bare "Load failed".
      if (error.name === 'AbortError') throw error
      throw new Error('The connection dropped before the reply finished. Please try again.')
    }
    const { value, done: finished } = chunk
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const event = JSON.parse(line)
      if (event.type === 'error') throw new Error(event.error || 'The assistant ran into a problem.')
      if (event.type === 'done') done = event
      else onEvent(event)
    }
  }
  if (!done) throw new Error('The connection dropped before the reply finished. Please try again.')
  return done
}

// Local date/time/zone so "today" is right, plus the last known location for weather and prayer times.
function clientContext() {
  const location = readPref('location', null)
  return {
    localDate: todayISO(),
    localTime: nowTimeHHMM(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(location ? { location: { lat: location.lat, lon: location.lon } } : {}),
  }
}

// iOS Safari only speaks after a user gesture; an empty utterance during the tap unlocks it for the
// reply that arrives seconds later.
function unlockSpeech() {
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
  } catch {
    // not supported
  }
}

// Reply text without markdown symbols, for speech and screen readers.
const plainText = (text) => text.replace(/[*`_#>]/g, '').replace(/^\s*[-•]\s+/gm, '')

function speakText(text) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(text)))
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

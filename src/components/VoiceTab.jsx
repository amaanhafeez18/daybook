import { useEffect, useRef, useState } from 'react'
import { load, save, uid } from '../lib/storage.js'

const SpeechRecognition =
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export default function VoiceTab() {
  const [notes, setNotes] = useState([])
  const [listening, setListening] = useState(false)
  const [draft, setDraft] = useState('')
  const [manualText, setManualText] = useState('')
  const recognitionRef = useRef(null)

  useEffect(() => {
    let active = true
    load('voiceNotes', []).then((data) => {
      if (active) setNotes(data)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!SpeechRecognition) return
    const rec = new SpeechRecognition()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    rec.onresult = (event) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript
      }
      setDraft(text)
    }
    rec.onend = () => setListening(false)
    recognitionRef.current = rec

    return () => rec.stop()
  }, [])

  function persist(next) {
    setNotes(next)
    save('voiceNotes', next)
  }

  function startListening() {
    if (!recognitionRef.current) return
    setDraft('')
    recognitionRef.current.start()
    setListening(true)
  }

  function stopListening() {
    recognitionRef.current?.stop()
    setListening(false)
    if (draft.trim()) {
      persist([{ id: uid(), text: draft.trim(), createdAt: Date.now() }, ...notes])
      setDraft('')
    }
  }

  function saveManual(e) {
    e.preventDefault()
    const trimmed = manualText.trim()
    if (!trimmed) return
    persist([{ id: uid(), text: trimmed, createdAt: Date.now() }, ...notes])
    setManualText('')
  }

  function remove(id) {
    persist(notes.filter((n) => n.id !== id))
  }

  return (
    <section className="tab-panel">
      {SpeechRecognition ? (
        <div className="voice-record">
          <button
            className={`mic-btn ${listening ? 'is-listening' : ''}`}
            onClick={listening ? stopListening : startListening}
            aria-label={listening ? 'Stop recording' : 'Start recording'}
          >
            {listening ? '■' : '●'}
          </button>
          <p className="voice-hint">
            {listening ? 'Listening — tap to stop and save' : 'Tap to speak a note'}
          </p>
          {listening && draft && <p className="voice-draft">{draft}</p>}
        </div>
      ) : (
        <div className="voice-unsupported">
          <p className="empty-note">
            Speech-to-text isn't supported in this browser. Type your note instead — on iPhone, use the
            keyboard's built-in dictation (mic icon on the keyboard) to speak it in.
          </p>
          <form className="add-row" onSubmit={saveManual}>
            <input
              type="text"
              placeholder="Type or dictate a note"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
            />
            <button type="submit" className="btn-accent">Save</button>
          </form>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="empty-note">No voice notes yet.</p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id} className="note-row">
              <div>
                <p className="note-text">{n.text}</p>
                <span className="note-date">{new Date(n.createdAt).toLocaleString()}</span>
              </div>
              <button className="row-delete" aria-label="Delete note" onClick={() => remove(n.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

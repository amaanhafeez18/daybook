import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { AutoTextarea, Button, EmptyState, Segmented } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import { getState, retryUnsaved, useData } from '../lib/store.js'
import { MOODS, addNote, deleteJournalEntry, deleteNote, moodEmoji, saveJournalEntry } from '../lib/planner.js'
import { addDaysISO, formatDateLong, formatDateShort, relativeDay, todayISO } from '../lib/dates.js'
import '../components/journal.css'

const AUTOSAVE_MS = 700

export default function JournalPage() {
  const [tab, setTab] = useState('journal')
  const notes = useData('voiceNotes')
  return (
    <div className="journal-page">
      <header className="page-header page-header-row">
        <div>
          <h1>Journal</h1>
          <p className="page-subtitle">A private space for your days and notes</p>
        </div>
      </header>
      <Segmented
        options={[{ id: 'journal', label: 'Entries', icon: 'journal' }, { id: 'notes', label: notes.length ? `Notes · ${notes.length}` : 'Notes', icon: 'note' }]}
        value={tab}
        onChange={setTab}
        label="Journal section"
        className="journal-tabs"
      />
      {tab === 'journal' ? <JournalEditor /> : <NotesList notes={notes} />}
    </div>
  )
}

function JournalEditor() {
  const entries = useData('journalEntries')
  const today = todayISO()
  const [date, setDate] = useState(today)
  const entry = entries.find((item) => item.date === date) || null
  const [draft, setDraft] = useState({ title: '', body: '', mood: '' })
  const [saveState, setSaveState] = useState('idle') // idle | pending | saved
  const timer = useRef(null)
  const pending = useRef(null)
  const baseId = useRef(null) // id of the entry the draft was loaded from

  // Show the entry for the selected date. Also picks up the entry when data arrives (or changes on
  // another device) — but never while the user has unsaved typing.
  const shownDate = useRef(date)
  useEffect(() => {
    const dateChanged = shownDate.current !== date
    shownDate.current = date
    if (!dateChanged && pending.current) return
    baseId.current = entry?.id || null
    setDraft({ title: entry?.title || '', body: entry?.body || '', mood: entry?.mood || '' })
    if (dateChanged) setSaveState('idle')
  }, [date, entry?.id, entry?.title, entry?.body, entry?.mood]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // iOS may suspend or kill the app once it's hidden: save the draft and send it right away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      flush()
      retryUnsaved()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function flush() {
    clearTimeout(timer.current)
    if (pending.current) {
      const { date: pendingDate, fields, baseId: draftBase } = pending.current
      pending.current = null
      // An entry for this date arrived from elsewhere while typing: keep both texts.
      const current = getState().data.journalEntries.find((item) => item.date === pendingDate)
      let out = fields
      if (current && current.id !== draftBase && (current.body || current.title)) {
        out = { title: fields.title || current.title || '', mood: fields.mood || current.mood || '', body: [current.body, fields.body].filter(Boolean).join('\n\n') }
      }
      saveJournalEntry(pendingDate, out)
      baseId.current = getState().data.journalEntries.find((item) => item.date === pendingDate)?.id || null
      setSaveState('saved')
    }
  }

  function update(field, value) {
    const next = { ...draft, [field]: value }
    setDraft(next)
    pending.current = { date, fields: next, baseId: baseId.current }
    setSaveState('pending')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, field === 'mood' ? 0 : AUTOSAVE_MS)
  }

  function goTo(nextDate) {
    flush()
    if (nextDate) setDate(nextDate)
  }

  async function remove() {
    if (!entry) return
    const ok = await confirmAction({ title: 'Delete this entry?', message: `Your journal entry for ${formatDateLong(date)} will be removed.`, confirmLabel: 'Delete' })
    if (!ok) return
    pending.current = null
    clearTimeout(timer.current)
    const undo = deleteJournalEntry(entry.id)
    baseId.current = null
    setDraft({ title: '', body: '', mood: '' })
    setSaveState('idle')
    toast('Entry deleted', { action: { label: 'Undo', onClick: () => { undo(); setDate(date) } } })
  }

  const history = useMemo(() => [...entries].sort((a, b) => b.date.localeCompare(a.date)), [entries])
  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0

  return (
    <div className="journal-layout">
      <section className="card journal-editor">
        <div className="journal-date-bar">
          <button type="button" className="icon-btn" onClick={() => goTo(addDaysISO(date, -1))} aria-label="Previous day"><Icon name="chevronLeft" /></button>
          <label className="journal-date">
            <strong>{relativeDay(date, today)}</strong>
            <span>{formatDateLong(date)}</span>
            <input type="date" value={date} max={today} onChange={(event) => goTo(event.target.value)} aria-label="Choose a date" />
          </label>
          <button type="button" className="icon-btn" onClick={() => goTo(addDaysISO(date, 1))} aria-label="Next day" disabled={date >= today}><Icon name="chevronRight" /></button>
        </div>

        <div className="mood-picker" role="radiogroup" aria-label="Mood">
          {MOODS.map((mood) => (
            <button
              key={mood.id}
              type="button"
              role="radio"
              aria-checked={draft.mood === mood.id}
              className={`mood ${draft.mood === mood.id ? 'is-active' : ''}`}
              onClick={() => update('mood', draft.mood === mood.id ? '' : mood.id)}
            >
              <span aria-hidden="true">{mood.emoji}</span>
              <small>{mood.label}</small>
            </button>
          ))}
        </div>

        <input
          className="journal-title"
          value={draft.title}
          onChange={(event) => update('title', event.target.value)}
          placeholder="Give today a title"
          aria-label="Entry title"
        />
        <AutoTextarea
          className="journal-body"
          value={draft.body}
          onChange={(event) => update('body', event.target.value)}
          placeholder={date === today ? 'What happened today? How are you feeling?' : 'What happened this day?'}
          aria-label="Entry"
          minRows={8}
          maxRows={30}
        />

        <footer className="journal-footer">
          <span className="journal-status" aria-live="polite">
            {saveState === 'pending' ? 'Saving…' : saveState === 'saved' || entry ? <><Icon name="check" size={14} /> Saved</> : 'Starts saving as you type'}
            {words > 0 && <span className="muted"> · {words} word{words === 1 ? '' : 's'}</span>}
          </span>
          {entry && <Button variant="ghost" size="sm" icon="trash" onClick={remove}>Delete</Button>}
        </footer>
      </section>

      <section className="journal-history">
        <h2 className="group-title">Past entries <span className="count">{history.length}</span></h2>
        {history.length === 0 ? (
          <EmptyState icon="journal" title="Your journal is empty">Write a few lines about today — it only takes a minute.</EmptyState>
        ) : (
          <ul className="entry-list">
            {history.map((item) => {
              const rel = relativeDay(item.date, today)
              const short = formatDateShort(item.date)
              return (
                <li key={item.id}>
                  <button type="button" className={`entry-card ${item.date === date ? 'is-active' : ''}`} onClick={() => goTo(item.date)}>
                    <span className="entry-mood" aria-hidden="true">{moodEmoji(item.mood) || '📝'}</span>
                    <span className="entry-text">
                      <small>{rel}{rel !== short ? ` · ${short}` : ''}</small>
                      <strong>{item.title || 'Untitled entry'}</strong>
                      {item.body && <span>{item.body.slice(0, 140)}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function NotesList({ notes }) {
  const [text, setText] = useState('')
  const sorted = useMemo(() => [...notes].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), [notes])

  function submit(event) {
    event.preventDefault()
    if (!text.trim()) return
    addNote(text)
    setText('')
  }

  function remove(note) {
    const undo = deleteNote(note.id)
    toast('Note deleted', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <div className="notes">
      <form className="card note-composer" onSubmit={submit}>
        <AutoTextarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Jot something down…" aria-label="New note" minRows={2} maxRows={8} />
        <div className="note-composer-actions">
          <span className="field-hint">Tip: the assistant saves notes here when you ask it to.</span>
          <Button type="submit" size="sm" disabled={!text.trim()}>Save note</Button>
        </div>
      </form>
      {sorted.length === 0 ? (
        <EmptyState icon="note" title="No notes yet">Quick thoughts, ideas and things to remember live here.</EmptyState>
      ) : (
        <ul className="note-list">
          {sorted.map((note) => (
            <li key={note.id} className="card note-card">
              <p className="preserve-lines">{note.text}</p>
              <footer>
                <small>{note.createdAt ? new Date(note.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</small>
                <button type="button" className="icon-btn icon-btn-sm" onClick={() => remove(note)} aria-label="Delete note"><Icon name="trash" size={16} /></button>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

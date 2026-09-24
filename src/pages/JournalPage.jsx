import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import { AutoTextarea, Button, EmptyState, Segmented } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import AttachmentStrip from '../components/AttachmentStrip.jsx'
import { getState, retryUnsaved, useData } from '../lib/store.js'
import { MOODS, addNote, deleteJournalEntry, deleteNote, moodEmoji, saveJournalEntry } from '../lib/planner.js'
import { attachmentSummary, useAttachmentsFor } from '../lib/attachments.js'
import { addDaysISO, formatDateLong, formatDateShort, relativeDay, todayISO } from '../lib/dates.js'
import '../components/journal.css'

const AUTOSAVE_MS = 700
// Search appears once there's enough to search through.
const SEARCH_FROM = 4

const matches = (query, ...fields) => {
  const needle = query.trim().toLowerCase()
  return !needle || fields.some((field) => String(field || '').toLowerCase().includes(needle))
}

// What a past entry is called in the list. Titles are optional (they sit under "Mood & title"),
// so most entries are named by their first line, and only an entry with no words at all is
// "Untitled".
const HEADING_MAX = 70
const PLACEHOLDER_TITLE = 'untitled entry' // saved by older versions when the title was left blank
function entryPreview(item) {
  const raw = (item.title || '').trim()
  const title = raw.toLowerCase() === PLACEHOLDER_TITLE ? '' : raw
  const body = (item.body || '').trim()
  if (title) return { heading: title, text: body.slice(0, 140) }
  if (!body) return { heading: 'Untitled entry', text: '' }
  const [firstLine, ...rest] = body.split('\n')
  const line = firstLine.trim()
  const heading = line.length > HEADING_MAX ? `${line.slice(0, HEADING_MAX - 1).trimEnd()}…` : line
  const text = line.length > HEADING_MAX ? body.slice(0, 140) : rest.join('\n').trim().slice(0, 140)
  return { heading, text }
}

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
  const [query, setQuery] = useState('')
  const entry = entries.find((item) => item.date === date) || null
  const [draft, setDraft] = useState({ title: '', body: '', mood: '' })
  const [saveState, setSaveState] = useState('idle') // idle | pending | saved
  const timer = useRef(null)
  const pending = useRef(null)
  const baseId = useRef(entry?.id || null) // id of the entry the draft was loaded from
  // Remounts "Mood & title" (so it can open by itself) when an entry for the shown day comes from
  // elsewhere — not when this editor's own autosave creates it: that would drop focus (and the
  // keyboard) out of the title field mid-word.
  const [extrasKey, setExtrasKey] = useState(0)

  // Show the entry for the selected date. Also picks up the entry when data arrives (or changes on
  // another device) — but never while the user has unsaved typing.
  const shownDate = useRef(date)
  useEffect(() => {
    const dateChanged = shownDate.current !== date
    shownDate.current = date
    if (!dateChanged && pending.current) return
    if (!dateChanged && entry?.id && entry.id !== baseId.current) setExtrasKey((key) => key + 1)
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

  // Deleting is undoable from the toast, so there's no "are you sure?" first.
  function remove() {
    if (!entry) return
    pending.current = null
    clearTimeout(timer.current)
    const undo = deleteJournalEntry(entry.id)
    baseId.current = null
    setDraft({ title: '', body: '', mood: '' })
    setSaveState('idle')
    toast(`Deleted your entry for ${formatDateShort(date)}`, { duration: 8000, action: { label: 'Undo', onClick: () => { undo(); setDate(date) } } })
  }

  const history = useMemo(() => [...entries].sort((a, b) => b.date.localeCompare(a.date)), [entries])
  const shown = useMemo(() => history.filter((item) => matches(query, item.title, item.body, formatDateLong(item.date), relativeDay(item.date, today))), [history, query, today])
  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0
  const mood = MOODS.find((item) => item.id === draft.mood)
  const extrasSummary = [mood ? `${mood.emoji} ${mood.label}` : '', draft.title.trim()].filter(Boolean).join(' · ')
  // The draft is loaded a render after the date changes, so whether the day already has a mood or
  // title is read from the saved entry too (that's what decides if "Mood & title" starts open).
  const extrasSet = !!extrasSummary || !!(entry?.mood || (entry?.title || '').trim())

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

        {/* Keyed by the day (and by entries arriving from elsewhere), so a day that already has a mood or title opens it by itself. */}
        <Disclosure key={`${date}:${extrasKey}`} id="journal-extras" label="Mood & title" summary={extrasSummary} hasValues={extrasSet} className="journal-extras">
          <div className="mood-picker" role="radiogroup" aria-label="Mood">
            {MOODS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={draft.mood === item.id}
                className={`mood ${draft.mood === item.id ? 'is-active' : ''}`}
                onClick={() => update('mood', draft.mood === item.id ? '' : item.id)}
              >
                <span aria-hidden="true">{item.emoji}</span>
                <small>{item.label}</small>
              </button>
            ))}
          </div>
          <input
            className="journal-title"
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
            placeholder="Give the day a title"
            aria-label="Entry title"
          />
        </Disclosure>

        <AutoTextarea
          className="journal-body"
          value={draft.body}
          onChange={(event) => update('body', event.target.value)}
          placeholder={date === today ? 'What happened today? How are you feeling?' : 'What happened this day?'}
          aria-label="Entry"
          minRows={7}
          maxRows={30}
        />

        <footer className="journal-footer">
          <span className="journal-status" aria-live="polite">
            {saveState === 'pending' ? 'Saving…' : saveState === 'saved' || entry ? <><Icon name="check" size={14} /> Saved</> : 'Saves as you type'}
            {words > 0 && <span className="muted"> · {words} word{words === 1 ? '' : 's'}</span>}
          </span>
          {entry && <Button variant="ghost" size="sm" icon="trash" onClick={remove}>Delete</Button>}
        </footer>
      </section>

      <section className="journal-history">
        <div className="group-title-row journal-history-head">
          <h2 className="group-title">Past entries <span className="count">{history.length}</span></h2>
        </div>
        {(history.length >= SEARCH_FROM || query) && (
          <label className="search-field search-field-wide journal-search">
            <Icon name="search" size={18} />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search entries" aria-label="Search entries" />
          </label>
        )}
        {history.length === 0 ? (
          <EmptyState icon="journal" title="Your journal is empty">Write a few lines about today — it only takes a minute.</EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon="search" title="No matches">Try a different word or a date.</EmptyState>
        ) : (
          <ul className="entry-list">
            {shown.map((item) => {
              const rel = relativeDay(item.date, today)
              const short = formatDateShort(item.date)
              const preview = entryPreview(item)
              return (
                <li key={item.id}>
                  <button type="button" className={`entry-card ${item.date === date ? 'is-active' : ''}`} onClick={() => goTo(item.date)}>
                    <span className="entry-mood" aria-hidden="true">{moodEmoji(item.mood) || '📝'}</span>
                    <span className="entry-text">
                      <small>{rel}{rel !== short ? ` · ${short}` : ''}</small>
                      <strong>{preview.heading}</strong>
                      {preview.text && <span>{preview.text}</span>}
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
  const [query, setQuery] = useState('')
  const sorted = useMemo(() => [...notes].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), [notes])
  const shown = useMemo(() => sorted.filter((note) => matches(query, note.text)), [sorted, query])

  function submit(event) {
    event.preventDefault()
    if (!text.trim()) return
    addNote(text)
    setText('')
    toast('Note saved')
  }

  return (
    <div className="notes">
      <form className="card note-composer" onSubmit={submit}>
        <AutoTextarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
          }}
          placeholder="Jot something down…"
          aria-label="New note"
          minRows={2}
          maxRows={8}
        />
        <div className="note-composer-actions">
          <Button type="submit" size="sm" disabled={!text.trim()}>Save note</Button>
        </div>
      </form>
      {(sorted.length >= SEARCH_FROM || query) && (
        <label className="search-field search-field-wide journal-search">
          <Icon name="search" size={18} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes" />
        </label>
      )}
      {sorted.length === 0 ? (
        <EmptyState icon="note" title="No notes yet">Ideas, lists, things to remember: jot them down above. The assistant can save notes here too.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="search" title="No matches">Try a different word.</EmptyState>
      ) : (
        <ul className="note-list">
          {shown.map((note) => <NoteCard key={note.id} note={note} />)}
        </ul>
      )}
    </div>
  )
}

// A note with its photos and files: the strip shows once there are any; the paperclip adds one.
function NoteCard({ note }) {
  const strip = useRef(null)
  const files = useAttachmentsFor('note', note.id)

  async function remove() {
    // Undo brings a note back, but not its files: the server deletes those with it. So ask first.
    if (files.length) {
      const ok = await confirmAction({ title: 'Delete this note?', message: `Its ${attachmentSummary(files)} will be deleted for good.`, confirmLabel: 'Delete' })
      if (!ok) return
      deleteNote(note.id)
      toast('Note deleted')
      return
    }
    const undo = deleteNote(note.id)
    toast('Note deleted', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <li className="card note-card">
      <p className="preserve-lines">{note.text}</p>
      <AttachmentStrip ref={strip} targetType="note" targetId={note.id} compact label="Photos and files on this note" />
      <footer>
        <small>{note.createdAt ? new Date(note.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</small>
        <span className="note-card-actions">
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => strip.current?.pick()} aria-label="Add a photo or PDF to this note" title="Add a photo or PDF"><Icon name="paperclip" size={16} /></button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={remove} aria-label="Delete note" title="Delete note"><Icon name="trash" size={16} /></button>
        </span>
      </footer>
    </li>
  )
}

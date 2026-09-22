import { useEffect, useMemo, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

// Built on demand so a tab left open past midnight doesn't default to yesterday.
const emptyEntry = (date = todayISO()) => ({ date, title: '', body: '', mood: '' })

export default function JournalTab() {
  const [entries, setEntries] = useState([])
  const [selectedDate, setSelectedDate] = useState(todayISO())
  const [form, setForm] = useState(() => emptyEntry())
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState(true)

  useEffect(() => {
    let active = true
    load('journalEntries', []).then((data) => {
      if (!active) return
      setEntries(data)
      const todayEntry = data.find((entry) => entry.date === todayISO())
      if (todayEntry) setForm(todayEntry)
    })
    return () => { active = false }
  }, [])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.date === selectedDate),
    [entries, selectedDate]
  )

  function chooseDate(date) {
    setSelectedDate(date)
    const entry = entries.find((item) => item.date === date)
    setForm(entry ? { ...entry } : emptyEntry(date))
    setEditing(date === todayISO())
    setStatus('')
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function saveEntry(event) {
    event.preventDefault()
    if (!editing) return
    const nextEntry = {
      id: form.id || uid(),
      date: form.date,
      title: form.title.trim() || 'Untitled entry',
      body: form.body.trim(),
      mood: form.mood,
      createdAt: form.createdAt || new Date().toISOString(),
    }
    const next = [nextEntry, ...entries.filter((entry) => entry.date !== nextEntry.date)]
      .sort((a, b) => b.date.localeCompare(a.date))
    setEntries(next)
    setForm(nextEntry)
    save('journalEntries', next)
    setStatus('Journal entry saved.')
  }

  function removeEntry() {
    if (!selectedEntry || !window.confirm('Delete this journal entry permanently?')) return
    const next = entries.filter((entry) => entry.id !== selectedEntry.id)
    setEntries(next)
    setForm(emptyEntry(selectedDate))
    save('journalEntries', next)
    setStatus('Journal entry removed.')
  }

  return (
    <section className="tab-panel journal-panel">
      <div className="journal-heading">
        <div>
          <p className="eyebrow">Private space</p>
          <h2>Journal</h2>
        </div>
        <input type="date" value={selectedDate} onChange={(event) => chooseDate(event.target.value)} aria-label="Journal date" />
      </div>

      <form className="journal-editor" onSubmit={saveEntry}>
        <input type="hidden" value={form.date} readOnly />
        <input type="text" placeholder="Entry title" value={form.title} disabled={!editing} onChange={(event) => update('title', event.target.value)} />
        <div className="journal-meta-row">
          <select value={form.mood} disabled={!editing} onChange={(event) => update('mood', event.target.value)} aria-label="Mood">
            <option value="">Mood</option>
            <option value="great">Great</option>
            <option value="good">Good</option>
            <option value="okay">Okay</option>
            <option value="low">Low</option>
            <option value="rough">Rough</option>
          </select>
          <span className="journal-date-label">{formatJournalDate(form.date)}</span>
        </div>
        <textarea rows="12" placeholder="What happened today?" disabled={!editing} value={form.body} onChange={(event) => update('body', event.target.value)} />
        <div className="journal-actions">
          <button type="submit" className="btn-accent" disabled={!editing}>Save entry</button>
          {selectedEntry && <button type="button" className="btn-small btn-ghost" onClick={() => setEditing((value) => !value)}>{editing ? 'Lock entry' : 'Edit entry'}</button>}
          {selectedEntry && <button type="button" className="btn-small btn-ghost" onClick={removeEntry}>Delete entry</button>}
        </div>
        {status && <p className="settings-status">{status}</p>}
      </form>

      <div className="journal-history">
        <h2 className="section-label">Past entries</h2>
        {entries.length === 0 ? <p className="empty-note">Your journal is empty. Start with today.</p> : (
          <div className="journal-entry-list">
            {entries.map((entry) => (
              <button className={`journal-entry-preview ${entry.date === selectedDate ? 'is-selected' : ''}`} key={entry.id} onClick={() => chooseDate(entry.date)}>
                <span>{formatJournalDate(entry.date)}</span>
                <strong>{entry.title}</strong>
                <small>{entry.body || 'No writing yet'}{entry.mood ? ` · ${entry.mood}` : ''}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function formatJournalDate(iso) {
  const date = new Date(`${iso}T12:00:00`)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

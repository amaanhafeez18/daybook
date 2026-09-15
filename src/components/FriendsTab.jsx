import { useMemo, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

export default function FriendsTab() {
  const [friends, setFriends] = useState(() => load('friends', []))
  const [logs, setLogs] = useState(() => load('contactLogs', []))
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [addingFor, setAddingFor] = useState(null)
  const [customDate, setCustomDate] = useState(todayISO())

  function persistFriends(next) {
    setFriends(next)
    save('friends', next)
  }

  function persistLogs(next) {
    setLogs(next)
    save('contactLogs', next)
  }

  function addFriend(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    persistFriends([...friends, { id: uid(), name: trimmed, note: note.trim() }])
    setName('')
    setNote('')
  }

  function removeFriend(id) {
    persistFriends(friends.filter((f) => f.id !== id))
    persistLogs(logs.filter((l) => l.friendId !== id))
  }

  function logContact(friendId, date) {
    persistLogs([...logs, { id: uid(), friendId, date }])
    setAddingFor(null)
  }

  const lastContactByFriend = useMemo(() => {
    const map = {}
    for (const l of logs) {
      if (!map[l.friendId] || l.date > map[l.friendId]) map[l.friendId] = l.date
    }
    return map
  }, [logs])

  const sorted = useMemo(() => {
    return [...friends].sort((a, b) => {
      const da = lastContactByFriend[a.id] || ''
      const db = lastContactByFriend[b.id] || ''
      return da.localeCompare(db) // longest since contact (or never) first
    })
  }, [friends, lastContactByFriend])

  return (
    <section className="tab-panel">
      <form className="add-row friend-add-row" onSubmit={addFriend}>
        <input
          type="text"
          placeholder="Friend's name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="btn-accent">Add friend</button>
      </form>

      {friends.length === 0 && (
        <p className="empty-note">No friends added yet. Add someone you want to keep in touch with.</p>
      )}

      <ul className="friend-list">
        {sorted.map((f) => {
          const last = lastContactByFriend[f.id]
          return (
            <li key={f.id} className="friend-row">
              <div className="friend-info">
                <span className="friend-name">{f.name}</span>
                {f.note && <span className="friend-note">{f.note}</span>}
                <span className="friend-last">
                  {last ? `Last talked ${sinceLabel(last)}` : 'No contact logged yet'}
                </span>
              </div>
              <div className="friend-actions">
                <button className="btn-small" onClick={() => logContact(f.id, todayISO())}>
                  Talked today
                </button>
                <button
                  className="btn-small btn-ghost"
                  onClick={() => setAddingFor(addingFor === f.id ? null : f.id)}
                >
                  Backdate
                </button>
                <button className="row-delete" aria-label="Remove friend" onClick={() => removeFriend(f.id)}>×</button>
              </div>
              {addingFor === f.id && (
                <div className="backdate-row">
                  <input
                    type="date"
                    value={customDate}
                    max={todayISO()}
                    onChange={(e) => setCustomDate(e.target.value)}
                  />
                  <button className="btn-small" onClick={() => logContact(f.id, customDate)}>Save</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function sinceLabel(iso) {
  const then = new Date(iso + 'T00:00:00')
  const now = new Date()
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago`
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`
  return `${Math.floor(days / 365)} year${Math.floor(days / 365) > 1 ? 's' : ''} ago`
}

import { useEffect, useMemo, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

const EMPTY_FORM = {
  name: '',
  relationship: 'friend',
  organization: '',
  imageUrl: '',
  birthday: '',
  currentStatus: '',
  facts: '',
}

export default function FriendsTab() {
  const [friends, setFriends] = useState([])
  const [logs, setLogs] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [addingFor, setAddingFor] = useState(null)
  const [customDate, setCustomDate] = useState(todayISO())

  useEffect(() => {
    let active = true
    Promise.all([
      load('friends', []),
      load('contactLogs', []),
    ]).then(([friendsData, logsData]) => {
      if (!active) return
      setFriends(friendsData)
      setLogs(logsData)
    })
    return () => { active = false }
  }, [])

  function persistFriends(next) {
    setFriends(next)
    save('friends', next)
  }

  function persistLogs(next) {
    setLogs(next)
    save('contactLogs', next)
  }

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function addFriend(e) {
    e.preventDefault()
    const trimmed = form.name.trim()
    if (!trimmed) return

    const friend = {
      id: uid(),
      name: trimmed,
      relationship: form.relationship,
      organization: form.relationship === 'acquaintance' ? form.organization.trim() : '',
      note: form.facts.trim(),
      photoUrl: form.imageUrl.trim(),
      birthday: form.birthday,
      currentStatus: form.currentStatus.trim(),
      facts: form.facts.trim(),
    }

    persistFriends([...friends, friend])
    setForm(EMPTY_FORM)
    setShowAdd(false)
  }

  function removeFriend(id) {
    persistFriends(friends.filter((f) => f.id !== id))
    persistLogs(logs.filter((l) => (l.friendId || l.friend_id) !== id))
  }

  function logContact(friendId, date) {
    persistLogs([...logs, { id: uid(), friendId, date }])
    setAddingFor(null)
  }

  const lastContactByFriend = useMemo(() => {
    const map = {}
    for (const item of logs) {
      const friendId = item.friendId || item.friend_id
      const date = item.date
      if (!friendId || !date) continue
      if (!map[friendId] || date > map[friendId]) map[friendId] = date
    }
    return map
  }, [logs])

  const grouped = useMemo(() => {
    const sections = {
      recent: [],
      month: [],
      stale: [],
      never: [],
    }

    for (const friend of friends) {
      const last = lastContactByFriend[friend.id]
      if (!last) {
        sections.never.push(friend)
        continue
      }

      const days = daysSince(last)
      if (days <= 14) sections.recent.push(friend)
      else if (days <= 30) sections.month.push(friend)
      else sections.stale.push(friend)
    }

    return sections
  }, [friends, lastContactByFriend])

  return (
    <section className="tab-panel">
      <div className="friends-header">
        <h2 className="section-label">People</h2>
        <button className="btn-accent" onClick={() => setShowAdd(true)}>Add friend</button>
      </div>

      {showAdd && (
        <div className="friend-modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="friend-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add friend</h3>
              <button type="button" className="row-delete" onClick={() => setShowAdd(false)}>×</button>
            </div>

            <form className="friend-form" onSubmit={addFriend}>
              <input
                type="text"
                placeholder="Name"
                value={form.name}
                onChange={(e) => updateForm('name', e.target.value)}
              />
              <select value={form.relationship} onChange={(e) => updateForm('relationship', e.target.value)}>
                <option value="friend">Friend</option>
                <option value="acquaintance">Acquaintance</option>
              </select>
              {form.relationship === 'acquaintance' && (
                <input type="text" placeholder="Business or organization (optional)" value={form.organization} onChange={(e) => updateForm('organization', e.target.value)} />
              )}
              <input
                type="url"
                placeholder="Image URL (optional)"
                value={form.imageUrl}
                onChange={(e) => updateForm('imageUrl', e.target.value)}
              />
              <input
                type="date"
                value={form.birthday}
                onChange={(e) => updateForm('birthday', e.target.value)}
              />
              <input
                type="text"
                placeholder="What are they doing right now?"
                value={form.currentStatus}
                onChange={(e) => updateForm('currentStatus', e.target.value)}
              />
              <textarea
                rows="3"
                placeholder="Other facts"
                value={form.facts}
                onChange={(e) => updateForm('facts', e.target.value)}
              />
              <div className="friend-modal-actions">
                <button type="button" className="btn-small btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn-small">Save friend</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {friends.length === 0 && (
        <p className="empty-note">No friends added yet. Add someone you want to keep in touch with.</p>
      )}

      {renderGroup('Last 2 weeks', grouped.recent)}
      {renderGroup('Last month', grouped.month)}
      {renderGroup('6+ months', grouped.stale)}
      {renderGroup('No contact logged', grouped.never)}
    </section>
  )

  function renderGroup(title, items) {
    if (items.length === 0) return null

    return (
      <div className="friend-group" key={title}>
        <h3 className="friend-group-title">{title}</h3>
        <ul className="friend-list">
          {items.map((friend) => {
            const last = lastContactByFriend[friend.id]
            const initials = getInitials(friend.name)

            return (
              <li key={friend.id} className="friend-row">
                <div className="friend-card-head">
                  <div className="friend-avatar">
                    {friend.photoUrl ? (
                      <img src={friend.photoUrl} alt={friend.name} />
                    ) : (
                      <span>{initials}</span>
                    )}
                  </div>

                  <div className="friend-info">
                    <span className="friend-name">{friend.name}</span>
                    <span className="friend-note">{friend.relationship === 'acquaintance' ? `Acquaintance${friend.organization ? ` · ${friend.organization}` : ''}` : 'Friend'}</span>
                    <span className="friend-last">
                      {last ? `Last talked ${sinceLabel(last)}` : 'No contact logged yet'}
                    </span>
                    {friend.currentStatus && <span className="friend-note">{friend.currentStatus}</span>}
                  </div>
                </div>

                <div className="friend-meta">
                  {friend.birthday && <span>🎂 {formatBirthday(friend.birthday)}</span>}
                  {friend.facts && <span>✦ {friend.facts}</span>}
                </div>

                <div className="friend-actions">
                  <button className="btn-small" onClick={() => logContact(friend.id, todayISO())}>Talked today</button>
                  <button className="btn-small btn-ghost" onClick={() => setAddingFor((current) => current === friend.id ? null : friend.id)}>Backdate</button>
                  <button className="row-delete" aria-label="Remove friend" onClick={() => removeFriend(friend.id)}>×</button>
                </div>

                {addingFor === friend.id && (
                  <div className="backdate-row">
                    <input
                      type="date"
                      value={customDate}
                      max={todayISO()}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                    <button className="btn-small" onClick={() => logContact(friend.id, customDate)}>Save</button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
}

function daysSince(iso) {
  const then = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(then.getTime())) return 9999
  return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24))
}

function sinceLabel(iso) {
  const days = daysSince(iso)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 14) return `${days} days ago`
  if (days <= 30) return 'last month'
  return `${days} days ago`
}

function getInitials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'F'
}

function formatBirthday(iso) {
  if (!iso) return ''
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

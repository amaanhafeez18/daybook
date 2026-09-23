import { useEffect, useMemo, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { AutoTextarea, Avatar, Button, EmptyState, Field, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import { useData } from '../lib/store.js'
import { RELATIONSHIPS, addFriend, friendStatus, lastContactMap, logContact, relationshipLabel, removeContactLog, removeFriend, updateFriend } from '../lib/planner.js'
import { formatDateShort, relativeDay, timeAgo, todayISO } from '../lib/dates.js'

export default function PeoplePage({ loaded }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)
  const [adding, setAdding] = useState(false)
  const today = todayISO()

  const lastById = useMemo(() => lastContactMap(contactLogs), [contactLogs])
  const people = useMemo(() => friends
    .filter((friend) => !query.trim() || `${friend.name} ${friend.organization || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .map((friend) => ({ friend, status: friendStatus(friend, lastById, today) })), [friends, lastById, today, query])

  const due = people.filter(({ status }) => status.due).sort((a, b) => (b.status.daysSince ?? 9999) - (a.status.daysSince ?? 9999))
  const others = people.filter(({ status }) => !status.due).sort((a, b) => a.friend.name.localeCompare(b.friend.name))
  const birthdays = people.filter(({ status }) => status.daysToBirthday !== null && status.daysToBirthday <= 30).sort((a, b) => a.status.daysToBirthday - b.status.daysToBirthday)

  function talked(friend) {
    const undo = logContact(friend.id)
    toast(`Logged a catch-up with ${friend.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <div className="people-page">
      <header className="page-header page-header-row">
        <div>
          <h1>People</h1>
          <p className="page-subtitle">{friends.length === 0 ? 'Keep track of the people who matter' : `${friends.length} ${friends.length === 1 ? 'person' : 'people'}${due.length ? ` · ${due.length} to catch up with` : ''}`}</p>
        </div>
        <Button icon="plus" onClick={() => setAdding(true)}>Add person</Button>
      </header>

      {friends.length > 3 && (
        <label className="search-field search-field-wide">
          <Icon name="search" size={18} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people" aria-label="Search people" />
        </label>
      )}

      {!loaded ? <Skeleton lines={4} /> : friends.length === 0 ? (
        <EmptyState icon="people" title="Nobody here yet" action={<Button icon="plus" onClick={() => setAdding(true)}>Add someone</Button>}>
          Add the people you want to stay close to. Daybook reminds you when it’s been a while.
        </EmptyState>
      ) : (
        <>
          {birthdays.length > 0 && !query && (
            <section className="birthday-strip" aria-label="Upcoming birthdays">
              {birthdays.map(({ friend, status }) => (
                <button key={friend.id} type="button" className="birthday-chip" onClick={() => setOpenId(friend.id)}>
                  <Icon name="cake" size={16} />
                  <span><strong>{friend.name.split(' ')[0]}</strong> {status.daysToBirthday === 0 ? 'today! 🎉' : relativeDay(status.nextBirthday, today)}</span>
                </button>
              ))}
            </section>
          )}

          {due.length > 0 && (
            <section className="task-group">
              <h2 className="group-title is-accent">Time to catch up <span className="count">{due.length}</span></h2>
              <ul className="person-list card-list">
                {due.map(({ friend, status }) => <PersonRow key={friend.id} friend={friend} status={status} onOpen={() => setOpenId(friend.id)} onTalked={() => talked(friend)} />)}
              </ul>
            </section>
          )}

          {others.length > 0 && (
            <section className="task-group">
              <h2 className="group-title">{due.length ? 'Everyone else' : 'Everyone'} <span className="count">{others.length}</span></h2>
              <ul className="person-list card-list">
                {others.map(({ friend, status }) => <PersonRow key={friend.id} friend={friend} status={status} onOpen={() => setOpenId(friend.id)} onTalked={() => talked(friend)} />)}
              </ul>
            </section>
          )}

          {people.length === 0 && <EmptyState icon="search" title="No matches">Try a different name.</EmptyState>}
        </>
      )}

      <button type="button" className="fab" onClick={() => setAdding(true)} aria-label="Add person">
        <Icon name="plus" size={26} />
      </button>

      <PersonSheet friendId={openId} onClose={() => setOpenId(null)} />
      <AddPersonSheet open={adding} onClose={() => setAdding(false)} onAdded={(friend) => { setAdding(false); setOpenId(friend.id) }} />
    </div>
  )
}

function PersonRow({ friend, status, onOpen, onTalked }) {
  const tone = status.due ? 'danger' : status.soon ? 'warning' : status.last ? 'success' : 'muted'
  const lastLabel = status.last ? `Talked ${timeAgo(status.last)}` : 'No catch-up logged'
  return (
    <li className="person-row">
      <button type="button" className="person-main" onClick={onOpen}>
        <Avatar name={friend.name} src={friend.photoUrl} size={44} />
        <span className="person-text">
          <strong>{friend.name}</strong>
          <small>
            <i className={`status-dot is-${tone}`} aria-hidden="true" />
            {lastLabel} · {relationshipLabel(friend.relationship)}
          </small>
          {friend.currentStatus && <small className="person-status">{friend.currentStatus}</small>}
        </span>
      </button>
      <button type="button" className="icon-btn icon-btn-soft" onClick={onTalked} aria-label={`Log a catch-up with ${friend.name} today`} title="Talked today">
        <Icon name="check" size={18} />
      </button>
    </li>
  )
}

function PersonForm({ value, onChange }) {
  const set = (field) => (event) => onChange({ ...value, [field]: event.target.value })
  return (
    <>
      <Field label="Name">
        {(id) => <input id={id} className="input input-lg" value={value.name} onChange={set('name')} autoComplete="off" data-autofocus />}
      </Field>
      <div className="field">
        <span className="field-label">Relationship</span>
        <Segmented options={RELATIONSHIPS.map((item) => ({ id: item.id, label: item.label }))} value={value.relationship} onChange={(relationship) => onChange({ ...value, relationship })} label="Relationship" />
        <p className="field-hint">{RELATIONSHIPS.find((item) => item.id === value.relationship)?.reminderDays ? `You’ll get a nudge after ${RELATIONSHIPS.find((item) => item.id === value.relationship).reminderDays} days without a catch-up.` : 'No catch-up reminders for acquaintances.'}</p>
      </div>
      <div className="field-row">
        <Field label="Birthday">
          {(id) => <input id={id} className="input" type="date" value={value.birthday} onChange={set('birthday')} />}
        </Field>
        <Field label="Works / studies at">
          {(id) => <input id={id} className="input" value={value.organization} onChange={set('organization')} autoComplete="off" />}
        </Field>
      </div>
      <Field label="What they’re up to">
        {(id) => <input id={id} className="input" value={value.currentStatus} onChange={set('currentStatus')} placeholder="e.g. Just started at Google" autoComplete="off" />}
      </Field>
      <Field label="Things to remember">
        {(id) => <AutoTextarea id={id} value={value.facts} onChange={set('facts')} placeholder="Kids’ names, favourite food, what you talked about…" minRows={3} />}
      </Field>
      <Field label="Photo URL" hint="Optional link to a picture.">
        {(id) => <input id={id} className="input" type="url" value={value.photoUrl} onChange={set('photoUrl')} autoComplete="off" />}
      </Field>
    </>
  )
}

const EMPTY_PERSON = { name: '', relationship: 'friend', birthday: '', organization: '', currentStatus: '', facts: '', photoUrl: '' }

function AddPersonSheet({ open, onClose, onAdded }) {
  const [form, setForm] = useState(EMPTY_PERSON)
  useEffect(() => { if (open) setForm(EMPTY_PERSON) }, [open])

  function submit(event) {
    event.preventDefault()
    if (!form.name.trim()) return
    const friend = addFriend(form)
    toast(`Added ${friend.name}`)
    onAdded(friend)
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add a person" footer={<Button type="submit" form="add-person" className="btn-grow" disabled={!form.name.trim()}>Add person</Button>}>
      <form id="add-person" className="form-stack" onSubmit={submit}>
        <PersonForm value={form} onChange={setForm} />
      </form>
    </Sheet>
  )
}

function PersonSheet({ friendId, onClose }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const friend = friends.find((item) => item.id === friendId) || null
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(EMPTY_PERSON)
  const [backdate, setBackdate] = useState('')
  const today = todayISO()

  useEffect(() => {
    setEditing(false)
    setBackdate('')
  }, [friendId])

  const logs = useMemo(() => (friend ? contactLogs.filter((log) => (log.friendId || log.friend_id) === friend.id).sort((a, b) => (b.date || '').localeCompare(a.date || '')) : []), [contactLogs, friend])
  const status = friend ? friendStatus(friend, lastContactMap(contactLogs), today) : null

  function startEdit() {
    setForm({ ...EMPTY_PERSON, ...Object.fromEntries(Object.keys(EMPTY_PERSON).map((key) => [key, friend[key] || EMPTY_PERSON[key]])) })
    setEditing(true)
  }

  function save(event) {
    event.preventDefault()
    if (!form.name.trim()) return
    updateFriend(friend.id, { ...form, name: form.name.trim() })
    setEditing(false)
    toast('Saved')
  }

  function logOn(date) {
    const undo = logContact(friend.id, date)
    setBackdate('')
    toast(date === today ? `Logged a catch-up with ${friend.name}` : `Logged a catch-up on ${formatDateShort(date)}`, { action: { label: 'Undo', onClick: undo } })
  }

  function remove() {
    const name = friend.name
    const undo = removeFriend(friend.id)
    onClose()
    toast(`Removed ${name}`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <Sheet
      open={!!friend}
      onClose={onClose}
      title={editing ? 'Edit person' : friend?.name}
      description={editing ? undefined : friend ? `${relationshipLabel(friend.relationship)}${friend.organization ? ` · ${friend.organization}` : ''}` : undefined}
      footer={editing ? (
        <>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          <Button type="submit" form="edit-person" className="btn-grow">Save</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" icon="trash" onClick={remove}>Remove</Button>
          <Button variant="secondary" icon="pencil" onClick={startEdit}>Edit</Button>
          <Button icon="check" className="btn-grow" onClick={() => logOn(today)}>Talked today</Button>
        </>
      )}
      initialFocus={editing}
    >
      {friend && (editing ? (
        <form id="edit-person" className="form-stack" onSubmit={save}>
          <PersonForm value={form} onChange={setForm} />
        </form>
      ) : (
        <div className="person-detail">
          <div className="person-hero">
            <Avatar name={friend.name} src={friend.photoUrl} size={64} />
            <div className="person-facts-grid">
              <div><span>Last catch-up</span><strong>{status.last ? timeAgo(status.last) : 'Never'}</strong></div>
              <div><span>Reminder</span><strong>{status.interval ? `Every ${status.interval} days` : 'Off'}</strong></div>
              <div><span>Birthday</span><strong>{friend.birthday ? formatDateShort(friend.birthday) : '—'}</strong></div>
            </div>
          </div>

          {friend.currentStatus && (
            <section className="detail-block">
              <h3>What they’re up to</h3>
              <p>{friend.currentStatus}</p>
            </section>
          )}
          {(friend.facts || friend.note) && (
            <section className="detail-block">
              <h3>Things to remember</h3>
              <p className="preserve-lines">{friend.facts || friend.note}</p>
            </section>
          )}

          <section className="detail-block">
            <div className="detail-block-header">
              <h3>Catch-ups</h3>
              <label className="backdate">
                <span className="sr-only">Log an earlier catch-up</span>
                <input type="date" className="input input-sm" max={today} value={backdate} onChange={(event) => setBackdate(event.target.value)} />
                <Button variant="secondary" size="sm" disabled={!backdate} onClick={() => logOn(backdate)}>Log</Button>
              </label>
            </div>
            {logs.length === 0 ? <p className="muted">No catch-ups logged yet.</p> : (
              <ul className="history-list">
                {logs.slice(0, 12).map((log) => (
                  <li key={log.id}>
                    <span>{formatDateShort(log.date)}</span>
                    <small>{timeAgo(log.date)}</small>
                    <button type="button" className="icon-btn icon-btn-sm" onClick={() => removeContactLog(log.id)} aria-label={`Remove catch-up on ${formatDateShort(log.date)}`}>
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ))}
    </Sheet>
  )
}

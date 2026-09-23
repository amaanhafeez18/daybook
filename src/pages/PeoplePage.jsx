import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { AutoTextarea, Avatar, Button, EmptyState, Field, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import { useData, useStore } from '../lib/store.js'
import {
  CONTACT_NOTE_MAX, RELATIONSHIPS, addFriend, contactTopic, friendStatus, lastCatchUpMap, lastContactMap, logContact, relationshipLabel,
  removeContactLog, removeFriend, updateContactNote, updateFriend,
} from '../lib/planner.js'
import { addDaysISO, formatDateShort, isISODate, relativeDay, timeAgo, todayISO } from '../lib/dates.js'
import '../components/people.css'

const NOTE_INPUT_MAX = 2000
const LOGS_SHOWN = 12

const firstName = (name = '') => name.trim().split(/\s+/)[0] || name
const capitalize = (text = '') => (text ? text[0].toUpperCase() + text.slice(1) : text)
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

// "Due Friday", "Due tomorrow", "Due Oct 12".
function dueLabel(iso, today) {
  const day = relativeDay(iso, today)
  return `Due ${day === 'Tomorrow' || day === 'Today' ? day.toLowerCase() : day}`
}

// Once per app session: shown when a save reports that the database has no column for catch-up
// notes yet (supabase/migrations/2026-09-27-food.sql not run). The store keeps the notes on this
// device meanwhile and saves them once the column exists.
let noteNoticeShown = false
const selectNotesHeld = (state) => !!state.droppedFields?.contactLogs?.includes('note')

// "his new job" reads as "about his new job"; anything else is shown as written.
function aboutTopic(topic) {
  return /^(his|her|their|our|my|your|the|a|an|its|some|how|what|why|when|where|whether)\b/.test(topic) ? `about ${topic}` : topic
}

export default function PeoplePage({ loaded }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)
  const [adding, setAdding] = useState(false)
  // The catch-up sheet gets a new key per opening, so its fields start fresh each time.
  const [catchUp, setCatchUp] = useState(null)
  const [catchUpKey, setCatchUpKey] = useState(0)
  const notesHeld = useStore(selectNotesHeld)
  const today = todayISO()

  useEffect(() => {
    if (!notesHeld || noteNoticeShown) return
    noteNoticeShown = true
    toast('Catch-up notes will be saved once the database is updated. Until then they’re kept on this device.', { duration: 8000 })
  }, [notesHeld])

  const lastById = useMemo(() => lastContactMap(contactLogs), [contactLogs])
  const lastCatchUps = useMemo(() => lastCatchUpMap(contactLogs), [contactLogs])
  const people = useMemo(() => friends
    .filter((friend) => !query.trim() || `${friend.name} ${friend.organization || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .map((friend) => ({ friend, status: friendStatus(friend, lastById, today) })), [friends, lastById, today, query])

  const due = people.filter(({ status }) => status.due).sort((a, b) => (b.status.daysSince ?? 9999) - (a.status.daysSince ?? 9999))
  const others = people.filter(({ status }) => !status.due).sort((a, b) => a.friend.name.localeCompare(b.friend.name))
  const birthdays = people.filter(({ status }) => status.daysToBirthday !== null && status.daysToBirthday <= 30).sort((a, b) => a.status.daysToBirthday - b.status.daysToBirthday)

  function openCatchUp(friendId, mode = 'today') {
    setCatchUpKey((key) => key + 1)
    setCatchUp({ friendId, mode })
  }

  const row = ({ friend, status }) => (
    <PersonRow
      key={friend.id}
      friend={friend}
      status={status}
      topic={contactTopic(lastCatchUps[friend.id]?.note)}
      onOpen={() => setOpenId(friend.id)}
      onTalked={() => openCatchUp(friend.id)}
    />
  )

  return (
    <div className="people-page">
      <header className="page-header page-header-row">
        <div>
          <h1>People</h1>
          <p className="page-subtitle">{friends.length === 0 ? 'Keep track of the people who matter' : `${friends.length} ${friends.length === 1 ? 'person' : 'people'}${due.length ? ` · ${due.length} to catch up with` : ''}`}</p>
        </div>
        <Button icon="plus" onClick={() => setAdding(true)}>Add person</Button>
      </header>

      {(friends.length > 3 || query) && (
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
                  <span><strong>{firstName(friend.name)}</strong> {status.daysToBirthday === 0 ? 'today! 🎉' : relativeDay(status.nextBirthday, today)}</span>
                </button>
              ))}
            </section>
          )}

          {due.length > 0 && (
            <section className="task-group">
              <h2 className="group-title is-accent">Time to catch up <span className="count">{due.length}</span></h2>
              <ul className="person-list card-list">{due.map(row)}</ul>
            </section>
          )}

          {others.length > 0 && (
            <section className="task-group">
              <h2 className="group-title">{due.length ? 'Everyone else' : 'Everyone'} <span className="count">{others.length}</span></h2>
              <ul className="person-list card-list">{others.map(row)}</ul>
            </section>
          )}

          {people.length === 0 && <EmptyState icon="search" title="No matches">Try a different name.</EmptyState>}
        </>
      )}

      <PersonSheet friendId={openId} onClose={() => setOpenId(null)} onCatchUp={openCatchUp} />
      <AddPersonSheet open={adding} onClose={() => setAdding(false)} onAdded={(friend) => { setAdding(false); setOpenId(friend.id) }} />
      <CatchUpSheet key={catchUpKey} request={catchUp} onClose={() => setCatchUp(null)} />
    </div>
  )
}

function PersonRow({ friend, status, topic, onOpen, onTalked }) {
  const tone = status.due ? 'danger' : status.soon ? 'warning' : status.last ? 'success' : 'muted'
  const lastLabel = status.last ? `Talked ${timeAgo(status.last)}` : 'No catch-up logged'
  const talkedToday = status.daysSince === 0
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
          {friend.currentStatus ? <small className="person-status">{friend.currentStatus}</small>
            : topic ? <small className="person-status ppl-topic"><span>Last:</span> {topic}</small> : null}
        </span>
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn-soft ppl-talk${talkedToday ? ' is-logged' : ''}`}
        onClick={onTalked}
        aria-label={talkedToday ? `Add to today’s catch-up with ${friend.name}` : `Log a catch-up with ${friend.name} today`}
        title={talkedToday ? 'Talked today' : 'Talked today?'}
      >
        <Icon name="check" size={20} strokeWidth={talkedToday ? 2.6 : 2.2} />
      </button>
    </li>
  )
}

// Adding shows only the essentials; `full` (editing) shows every field.
function PersonForm({ value, onChange, full = false }) {
  const [more, setMore] = useState(full)
  const set = (field) => (event) => onChange({ ...value, [field]: event.target.value })
  const relationship = RELATIONSHIPS.find((item) => item.id === value.relationship)
  const birthday = (
    <Field label="Birthday">
      {(id) => <input id={id} className="input" type="date" value={value.birthday} onChange={set('birthday')} />}
    </Field>
  )
  const organization = (
    <Field label="Works / studies at">
      {(id) => <input id={id} className="input" value={value.organization} onChange={set('organization')} autoComplete="off" />}
    </Field>
  )
  return (
    <>
      <Field label="Name">
        {(id) => <input id={id} className="input input-lg" value={value.name} onChange={set('name')} autoComplete="off" autoCapitalize="words" data-autofocus />}
      </Field>
      <div className="field">
        <span className="field-label">Relationship</span>
        <Segmented options={RELATIONSHIPS.map((item) => ({ id: item.id, label: item.label }))} value={value.relationship} onChange={(next) => onChange({ ...value, relationship: next })} label="Relationship" />
        <p className="field-hint">{relationship?.reminderDays ? `You’ll get a nudge after ${relationship.reminderDays} days without a catch-up.` : 'No catch-up reminders for acquaintances.'}</p>
      </div>
      {full ? <div className="field-row">{birthday}{organization}</div> : birthday}
      {!more && (
        <button type="button" className="ppl-more" aria-expanded="false" onClick={() => setMore(true)}>
          More details
          <Icon name="chevronDown" size={18} strokeWidth={2.2} />
        </button>
      )}
      {more && (
        <>
          {!full && organization}
          <Field label="What they’re up to">
            {(id) => <input id={id} className="input" value={value.currentStatus} onChange={set('currentStatus')} placeholder="e.g. Just started at Google" autoComplete="off" />}
          </Field>
          <Field label="Things to remember">
            {(id) => <AutoTextarea id={id} value={value.facts} onChange={set('facts')} placeholder="Kids’ names, favourite food, allergies…" minRows={3} />}
          </Field>
          <Field label="Photo URL" hint="Optional link to a picture.">
            {(id) => <input id={id} className="input" type="url" inputMode="url" value={value.photoUrl} onChange={set('photoUrl')} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
          </Field>
        </>
      )}
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

function PersonSheet({ friendId, onClose, onCatchUp }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  // Keeps showing the last person while the sheet animates closed.
  const [shownId, setShownId] = useState(friendId)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(EMPTY_PERSON)
  const today = todayISO()

  useEffect(() => {
    if (friendId) setShownId(friendId)
    setEditing(false)
  }, [friendId])

  const friend = friends.find((item) => item.id === (friendId || shownId)) || null
  const logs = useMemo(() => (friend ? contactLogs.filter((log) => (log.friendId || log.friend_id) === friend.id).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')) : []), [contactLogs, friend])
  const status = friend ? friendStatus(friend, lastContactMap(logs), today) : null
  const topic = friend ? contactTopic(lastCatchUpMap(logs)[friend.id]?.note) : ''

  function startEdit() {
    // Older people store their notes in `note`; show them here so they can be edited.
    setForm({ ...EMPTY_PERSON, ...Object.fromEntries(Object.keys(EMPTY_PERSON).map((key) => [key, friend[key] || EMPTY_PERSON[key]])), facts: friend.facts || friend.note || '' })
    setEditing(true)
  }

  function save(event) {
    event.preventDefault()
    if (!form.name.trim()) return
    const patch = { ...form, name: form.name.trim() }
    // Keep a legacy note in step, so clearing the field doesn't bring it back.
    if (friend.note) patch.note = form.facts
    // The sheet switches back to showing the person with the changes: no toast needed.
    updateFriend(friend.id, patch)
    setEditing(false)
  }

  function remove() {
    const name = friend.name
    const undo = removeFriend(friend.id)
    onClose()
    toast(`Removed ${name}`, { action: { label: 'Undo', onClick: undo } })
  }

  const tone = status?.due ? 'danger' : status?.soon ? 'warning' : status?.last ? 'success' : 'muted'

  return (
    <Sheet
      open={!!friendId && !!friend}
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
          <Button icon="check" className="btn-grow" onClick={() => onCatchUp(friend.id, 'today')}>Talked today</Button>
        </>
      )}
      initialFocus={editing}
    >
      {friend && (editing ? (
        <form id="edit-person" className="form-stack" onSubmit={save}>
          <PersonForm value={form} onChange={setForm} full />
        </form>
      ) : (
        <div className="person-detail">
          <div className="ppl-hero">
            <Avatar name={friend.name} src={friend.photoUrl} size={64} />
            <div className="ppl-last">
              <span className="ppl-label">Last catch-up</span>
              <p className="ppl-last-line">
                <i className={`status-dot is-${tone}`} aria-hidden="true" />
                <strong>{status.last ? capitalize(timeAgo(status.last)) : 'None yet'}</strong>
                {topic && <span className="ppl-last-topic"> · {aboutTopic(topic)}</span>}
              </p>
            </div>
          </div>
          <div className="ppl-facts">
            <div>
              <span className="ppl-label">Reminder</span>
              <strong>{status.interval ? `Every ${status.interval} days` : 'Off'}</strong>
              {status.interval && status.last ? <small>{status.due ? 'Due now' : dueLabel(addDaysISO(status.last, status.interval), today)}</small> : null}
            </div>
            <div>
              <span className="ppl-label">Birthday</span>
              <strong>{friend.birthday ? formatDateShort(friend.birthday) : '—'}</strong>
              {status.daysToBirthday !== null && status.daysToBirthday <= 30 ? <small>{status.daysToBirthday === 0 ? 'Today 🎉' : status.daysToBirthday === 1 ? 'Tomorrow' : `In ${status.daysToBirthday} days`}</small> : null}
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
              <Button variant="secondary" size="sm" icon="calendar" className="ppl-earlier" onClick={() => onCatchUp(friend.id, 'earlier')}>Log earlier</Button>
            </div>
            {logs.length === 0 ? <p className="muted">No catch-ups logged yet. Tap “Talked today” after you speak.</p> : <CatchUpList key={friend.id} logs={logs} />}
          </section>
        </div>
      ))}
    </Sheet>
  )
}

function CatchUpList({ logs }) {
  const [openId, setOpenId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? logs : logs.slice(0, LOGS_SHOWN)

  function toggle(log) {
    if (openId === log.id) {
      setOpenId(null)
      setEditingId(null)
      return
    }
    setOpenId(log.id)
    // Nothing to read yet, so go straight to writing.
    setEditingId((log.note || '').trim() ? null : log.id)
  }

  function saveNote(log, text) {
    const hadNote = !!(log.note || '').trim()
    const undo = updateContactNote(log.id, text)
    setEditingId(null)
    if (!text.trim()) setOpenId(null)
    if (text.trim() || hadNote) toast(text.trim() ? 'Note saved' : 'Note removed', { action: { label: 'Undo', onClick: undo } })
  }

  function removeLog(log) {
    const undo = removeContactLog(log.id)
    toast('Catch-up removed', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <>
      <ul className="ppl-logs">
        {shown.map((log, index) => (
          <CatchUpItem
            key={log.id}
            log={log}
            open={openId === log.id}
            editing={editingId === log.id}
            showAddHint={index === 0}
            onToggle={() => toggle(log)}
            onEdit={() => setEditingId(log.id)}
            onCancel={() => { setEditingId(null); if (!(log.note || '').trim()) setOpenId(null) }}
            onSave={(text) => saveNote(log, text)}
            onRemove={() => removeLog(log)}
          />
        ))}
      </ul>
      {logs.length > LOGS_SHOWN && (
        <button type="button" className="ppl-show-all" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show all ${logs.length} catch-ups`}
        </button>
      )}
    </>
  )
}

function CatchUpItem({ log, open, editing, showAddHint, onToggle, onEdit, onCancel, onSave, onRemove }) {
  const note = (log.note || '').trim()
  return (
    <li className={`ppl-log${open ? ' is-open' : ''}`}>
      <div className="ppl-log-row">
        <button type="button" className="ppl-log-main" onClick={onToggle} aria-expanded={open}>
          <span className="ppl-log-head">
            <strong>{formatDateShort(log.date)}</strong>
            <small>{capitalize(timeAgo(log.date))}</small>
          </span>
          {note && !editing ? <span className={`ppl-log-note${open ? '' : ' is-clamped'}`}>{note}</span>
            : !note && !editing && showAddHint ? <span className="ppl-log-add"><Icon name="plus" size={14} strokeWidth={2.4} /> Add what you talked about</span> : null}
        </button>
        <button type="button" className="icon-btn ppl-log-remove" onClick={onRemove} aria-label={`Remove catch-up on ${formatDateShort(log.date)}`}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {open && !editing && note && (
        <div className="ppl-log-actions">
          <button type="button" className="link-btn" onClick={onEdit}><Icon name="pencil" size={15} /> Edit note</button>
        </div>
      )}
      {editing && <NoteEditor note={note} label={`Note for the catch-up on ${formatDateShort(log.date)}`} onCancel={onCancel} onSave={onSave} />}
    </li>
  )
}

// Mounted per edit, so the draft starts from the saved note each time.
function NoteEditor({ note, label, onCancel, onSave }) {
  const [draft, setDraft] = useState(note)
  const caretPlaced = useRef(false)

  function submit(event) {
    event.preventDefault()
    if (draft.trim() !== note) onSave(draft)
  }

  return (
    <form className="ppl-log-editor" onSubmit={submit}>
      <AutoTextarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
          if (event.key === 'Escape') {
            // Closes the editor, not the whole sheet (the sheet listens on document).
            event.stopPropagation()
            onCancel()
          }
        }}
        onFocus={(event) => {
          // The first (automatic) focus puts the caret after the text.
          if (caretPlaced.current) return
          caretPlaced.current = true
          const end = event.target.value.length
          event.target.setSelectionRange(end, end)
        }}
        placeholder="What did you talk about?"
        aria-label={label}
        maxLength={CONTACT_NOTE_MAX}
        minRows={2}
        maxRows={8}
        enterKeyHint="enter"
        autoFocus
      />
      <div className="ppl-log-editor-actions">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={draft.trim() === note}>Save</Button>
      </div>
    </form>
  )
}

// "Talked today" and "Log earlier": an optional note on what you talked about. Skip logs the
// catch-up without one; closing the sheet logs nothing. Other pages can reuse it:
// <CatchUpSheet key={n} request={{ friendId, mode: 'today' | 'earlier' } | null} onClose />.
export function CatchUpSheet({ request, onClose }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  // Keeps the content while the sheet animates closed (request is null by then).
  const lastRequest = useRef(request)
  if (request) lastRequest.current = request
  const current = request || lastRequest.current
  const earlier = current?.mode === 'earlier'
  const today = todayISO()
  const [date, setDate] = useState(() => (earlier ? addDaysISO(today, -1) : today))
  const [note, setNote] = useState('')

  const friend = current ? friends.find((item) => item.id === current.friendId) || null : null
  const validDate = isISODate(date) && date <= today
  const existing = friend && validDate ? contactLogs.find((log) => (log.friendId || log.friend_id) === friend.id && log.date === date) : null
  const existingNote = existing ? contactTopic(existing.note) : ''
  const when = date === today ? 'today' : `on ${formatDateShort(date)}`
  const first = friend ? firstName(friend.name) : ''

  const saved = useRef(false)

  function save(withNote) {
    // Once per opening (a double tap on Save mustn't log twice).
    if (!friend || !validDate || saved.current) return
    saved.current = true
    const text = withNote ? note.trim() : ''
    const undo = logContact(friend.id, date, text)
    onClose()
    const suffix = date === today ? '' : ` on ${formatDateShort(date)}`
    const message = text ? `Saved your catch-up with ${first}${suffix}` : existing ? `Already logged ${when}` : `Logged a catch-up with ${first}${suffix}`
    toast(message, { action: { label: 'Undo', onClick: undo } })
  }

  function onKeyDown(event) {
    // Return saves (it's a short answer); Shift+Return adds a line on a keyboard.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (earlier) save(true)
    else if (note.trim()) save(true)
  }

  // Frozen while closing, so saving doesn't flash "Already logged" as the sheet slides away.
  const hintRef = useRef('')
  if (request) {
    hintRef.current = existing
      ? existingNote ? `Already logged ${when}: “${truncate(existingNote, 90)}”. This adds to it.` : `Already logged ${when}. This adds a note to it.`
      : 'Optional. It’s saved with this catch-up.'
  }
  const hint = hintRef.current

  return (
    <Sheet
      open={!!request && !!friend}
      onClose={onClose}
      size="sm"
      title={friend ? `Catch-up with ${first}` : undefined}
      description={friend ? (earlier ? 'Log a catch-up from an earlier day' : `Today · ${formatDateShort(today)}`) : undefined}
      footer={earlier ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="ppl-catch-up" className="btn-grow" disabled={!validDate}>Log catch-up</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={() => save(false)}>Skip</Button>
          <Button type="submit" form="ppl-catch-up" className="btn-grow" disabled={!note.trim()}>Save</Button>
        </>
      )}
    >
      {friend && (
        <form id="ppl-catch-up" className="form-stack ppl-catch-up" onSubmit={(event) => { event.preventDefault(); save(true) }}>
          {earlier && (
            <Field label="When" error={date && !validDate ? 'Pick today or an earlier day.' : undefined}>
              {(id) => <input id={id} className="input" type="date" max={today} value={date} onChange={(event) => setDate(event.target.value)} required />}
            </Field>
          )}
          <Field label="What did you talk about?" hint={hint}>
            {(id) => (
              <AutoTextarea
                id={id}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="e.g. new job, trip plans, exams"
                maxLength={NOTE_INPUT_MAX}
                minRows={2}
                maxRows={6}
                enterKeyHint="done"
                data-autofocus
              />
            )}
          </Field>
        </form>
      )}
    </Sheet>
  )
}

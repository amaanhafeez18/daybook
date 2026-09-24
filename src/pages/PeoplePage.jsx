import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import { AutoTextarea, Avatar, Button, EmptyState, Field, IconButton, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import { useData, useStore } from '../lib/store.js'
import {
  CONTACT_NOTE_MAX, RELATIONSHIPS, addFriend, contactTopic, friendStatus, lastCatchUpMap, lastContactMap, logContact, relationshipLabel,
  removeContactLog, removeFriend, updateContactNote, updateFriend,
} from '../lib/planner.js'
import { addDaysISO, formatDateShort, isISODate, relativeDay, timeAgo, todayISO } from '../lib/dates.js'
import { imageToAvatarDataUrl, isInlinePhoto, photoAccept } from '../lib/media.js'
import '../components/people.css'

const NOTE_INPUT_MAX = 2000
const EARLIER_SHOWN = 5
// Custom catch-up intervals offered in the form, besides the relationship's usual one and "off".
const REMINDER_CHOICES = [7, 14, 30, 60, 90]

// A web link to a picture (older people, or "Use a link instead"), as opposed to a picked photo.
const isPhotoLink = (value) => !!(value || '').trim() && !isInlinePhoto(value)

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
        <Avatar key={friend.photoUrl || 'none'} name={friend.name} src={friend.photoUrl} size={44} />
        <span className="person-text">
          <strong>{friend.name}</strong>
          <small>
            <i className={`status-dot is-${tone}`} aria-hidden="true" />
            {lastLabel} · {relationshipLabel(friend.relationship)}
          </small>
          {/* What you talked about last time comes first; what they're up to otherwise. */}
          {topic ? <small className="person-status ppl-topic"><Icon name="message" size={13} strokeWidth={2} /><span className="sr-only">Last time: </span>{topic}</small>
            : friend.currentStatus ? <small className="person-status">{friend.currentStatus}</small> : null}
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

// Choosing a photo: on an iPhone the picker offers Photo Library, Take Photo and Choose File (no
// `capture`, which would allow only the camera). The photo is cropped to a square and shrunk on
// the device (imageToAvatarDataUrl), then onPhoto(dataUrl) runs. Render `input` once, anywhere.
function usePhotoPicker(onPhoto, onError) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onPick(event) {
    const file = event.target.files?.[0]
    event.target.value = '' // so choosing the same photo again still counts
    if (!file) return
    setBusy(true)
    setError('')
    try {
      onPhoto(await imageToAvatarDataUrl(file))
    } catch (problem) {
      const message = problem?.message || 'Couldn’t use that photo — try another one.'
      if (onError) onError(message)
      else setError(message)
    } finally {
      setBusy(false)
    }
  }

  function open() {
    if (busy) return
    setError('')
    inputRef.current?.click()
  }

  const input = <input ref={inputRef} type="file" accept={photoAccept} className="ppl-photo-input" tabIndex={-1} aria-hidden="true" onChange={onPick} />
  return { input, open, busy, error, clearError: () => setError('') }
}

// The avatar with its "no name yet" silhouette. Keyed by the photo, so a new photo replaces one
// that failed to load.
function PersonAvatar({ name, src, size }) {
  if (!src && !name.trim()) {
    return <span className="avatar ppl-avatar-blank" style={{ width: size, height: size }} aria-hidden="true"><Icon name="user" size={Math.round(size * 0.44)} strokeWidth={1.6} /></span>
  }
  return <Avatar key={src || 'none'} name={name} src={src} size={size} />
}

// A typed photo link is previewed once typing pauses and it looks like a whole web address, so a
// half-typed one ("h", "https://exa…") isn't fetched on every keystroke. Picked photos show at once.
function useLinkPreview(photo) {
  const link = isPhotoLink(photo)
  const [settled, setSettled] = useState(photo)
  useEffect(() => {
    if (!link) return undefined
    const timer = setTimeout(() => setSettled(photo), 450)
    return () => clearTimeout(timer)
  }, [photo, link])
  if (!link) return photo
  return settled === photo && /^https?:\/\/[^\s/]+\/\S/i.test(photo.trim()) ? photo : ''
}

// Top of the person form: the photo, tap to add or change it, like Contacts.
function PhotoField({ name, photo, picker, onRemove, onUseLink }) {
  const label = photo ? 'Change photo' : 'Add photo'
  const preview = useLinkPreview(photo)
  const actionRef = useRef(null)
  function remove(event) {
    // The Remove button goes away: keep keyboard focus on the photo button next to it.
    const hadFocus = document.activeElement === event.currentTarget
    onRemove()
    if (hadFocus) actionRef.current?.focus()
  }
  return (
    <div className="ppl-photo">
      <button type="button" className="ppl-photo-pick" onClick={picker.open} aria-label={label} aria-busy={picker.busy || undefined}>
        <PersonAvatar name={name} src={preview} size={96} />
        {(!photo || picker.busy) && (
          <span className={`ppl-photo-badge${picker.busy ? ' is-busy' : ''}`} aria-hidden="true">
            {picker.busy ? <span className="spinner" /> : <Icon name="camera" size={16} strokeWidth={2.2} />}
          </span>
        )}
      </button>
      <div className="ppl-photo-actions">
        <button ref={actionRef} type="button" className="ppl-photo-action" onClick={picker.open} disabled={picker.busy}>{picker.busy ? 'Preparing photo…' : label}</button>
        {photo && !picker.busy && <button type="button" className="ppl-photo-action is-danger" onClick={remove}>Remove</button>}
        {!photo && !picker.busy && onUseLink && <button type="button" className="ppl-photo-action is-quiet" onClick={onUseLink}>Use a link</button>}
      </div>
      {picker.error && <p className="field-error ppl-photo-error" role="alert">{picker.error}</p>}
    </div>
  )
}

// The form's catch-up reminder value: '' = the usual interval for the relationship, '0' = no
// reminders, otherwise a number of days (as a string, for the select).
function reminderFormValue(friend) {
  const days = friend.reminderDays
  if (days === undefined || days === null || days === '') return ''
  const usual = RELATIONSHIPS.find((item) => item.id === friend.relationship)?.reminderDays ?? 0
  return Number(days) === usual ? '' : String(Number(days))
}

// The intervals the catch-up reminder select offers: the usual choices without the relationship's
// own (that's the first option), plus the current value when it's some other number of days.
export function reminderOptions(usual, current, choices = REMINDER_CHOICES) {
  const days = Number(current)
  const extra = current !== '' && current !== null && current !== undefined && Number.isFinite(days) && days > 0 && days !== usual && !choices.includes(days) ? [days] : []
  return [...choices.filter((item) => item !== usual), ...extra].sort((a, b) => a - b)
}

// A custom reminder is saved after the rest: updateFriend/addFriend set the relationship's usual
// interval whenever the relationship is in the patch, which would undo it in the same call.
function applyReminder(id, form) {
  if (form.reminderDays === '') return
  updateFriend(id, { reminderDays: Number(form.reminderDays) })
}

// What's set inside "More options", shown on the closed disclosure.
function moreSummary(value) {
  const parts = []
  if (value.organization.trim()) parts.push(value.organization.trim())
  if (value.birthday) parts.push(`Birthday ${formatDateShort(value.birthday)}`)
  if (value.currentStatus.trim()) parts.push(truncate(value.currentStatus.trim(), 30))
  if (value.facts.trim()) parts.push('Things to remember')
  if (value.reminderDays === '0') parts.push('No reminders')
  else if (value.reminderDays) parts.push(`Every ${value.reminderDays} days`)
  return parts.join(' · ')
}

// Photo, name and relationship; everything else (birthday, workplace, what they're up to, things
// to remember, the catch-up interval) under "More options". `onChange` is the form's state setter
// (it also takes an updater function). onBusyChange(true) while a picked photo is still being
// prepared, so the sheet can hold off saving until it's in the form.
function PersonForm({ value, onChange, onBusyChange }) {
  // The link field is for people who already have a web link, or who ask for one.
  const [linkOpen, setLinkOpen] = useState(() => isPhotoLink(value.photoUrl))
  const setPhoto = (photoUrl) => onChange((current) => ({ ...current, photoUrl }))
  const picker = usePhotoPicker((dataUrl) => {
    setPhoto(dataUrl)
    setLinkOpen(false)
  })
  useEffect(() => {
    if (!picker.busy) return undefined
    onBusyChange?.(true)
    return () => onBusyChange?.(false) // also when the form closes mid-way
  }, [picker.busy]) // eslint-disable-line react-hooks/exhaustive-deps
  const photo = (value.photoUrl || '').trim()
  const set = (field) => (event) => onChange({ ...value, [field]: event.target.value })
  const relationship = RELATIONSHIPS.find((item) => item.id === value.relationship)
  const usual = relationship?.reminderDays ?? null
  const summary = moreSummary(value)
  // The assistant can set any interval ("every 21 days"): show it rather than a wrong option.
  const reminderChoices = reminderOptions(usual, value.reminderDays)
  return (
    <>
      <PhotoField
        name={value.name}
        photo={photo}
        picker={picker}
        onRemove={() => {
          setPhoto('')
          picker.clearError()
        }}
        onUseLink={linkOpen ? null : () => setLinkOpen(true)}
      />
      {linkOpen && (
        <Field label="Photo link" hint="A web address of a picture. Choosing a photo above replaces it.">
          {(id) => (
            <input
              id={id}
              className="input"
              type="url"
              inputMode="url"
              value={isPhotoLink(value.photoUrl) ? value.photoUrl : ''}
              onChange={(event) => setPhoto(event.target.value)}
              placeholder="https://"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus={!isPhotoLink(value.photoUrl)}
            />
          )}
        </Field>
      )}
      <Field label="Name">
        {(id) => <input id={id} className="input input-lg" value={value.name} onChange={set('name')} autoComplete="off" autoCapitalize="words" data-autofocus />}
      </Field>
      <div className="field">
        <span className="field-label">Relationship</span>
        <Segmented options={RELATIONSHIPS.map((item) => ({ id: item.id, label: item.label }))} value={value.relationship} onChange={(next) => onChange({ ...value, relationship: next })} label="Relationship" />
        <p className="field-hint">
          {value.reminderDays === '0' ? 'No catch-up reminders.'
            : value.reminderDays ? `You’ll get a nudge after ${value.reminderDays} days without a catch-up.`
              : usual ? `You’ll get a nudge after ${usual} days without a catch-up.` : 'No catch-up reminders for acquaintances.'}
        </p>
      </div>
      <Disclosure id="person-more" label="More options" summary={summary} hasValues={!!summary}>
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
          {(id) => <AutoTextarea id={id} value={value.facts} onChange={set('facts')} placeholder="Kids’ names, favourite food, allergies…" minRows={3} />}
        </Field>
        <Field label="Catch-up reminder" hint="A “Talk to …” task appears on Today when it’s been this long.">
          {(id) => (
            <select id={id} className="input" value={value.reminderDays} onChange={set('reminderDays')}>
              <option value="">{usual ? `Every ${usual} days (usual for a ${relationship.label.toLowerCase()})` : 'None (usual for an acquaintance)'}</option>
              {reminderChoices.map((days) => <option key={days} value={String(days)}>Every {days} days</option>)}
              {usual ? <option value="0">No reminders</option> : null}
            </select>
          )}
        </Field>
      </Disclosure>
      {picker.input}
    </>
  )
}

const EMPTY_PERSON = { name: '', relationship: 'friend', birthday: '', organization: '', currentStatus: '', facts: '', photoUrl: '', reminderDays: '' }

function AddPersonSheet({ open, onClose, onAdded }) {
  const [form, setForm] = useState(EMPTY_PERSON)
  const [photoBusy, setPhotoBusy] = useState(false)
  useEffect(() => { if (open) setForm(EMPTY_PERSON) }, [open])

  function submit(event) {
    event.preventDefault()
    if (!form.name.trim() || photoBusy) return
    const { reminderDays, ...fields } = form
    const friend = addFriend(fields)
    applyReminder(friend.id, { reminderDays })
    toast(`Added ${friend.name}`)
    onAdded(friend)
  }

  const blocked = !form.name.trim() ? 'Give them a name to add them.' : photoBusy ? 'Preparing the photo…' : ''
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a person"
      footer={(
        <>
          {blocked && <span className="ppl-footer-hint" aria-live="polite">{blocked}</span>}
          <Button type="submit" form="add-person" className="btn-grow" disabled={!!blocked}>Add person</Button>
        </>
      )}
    >
      <form id="add-person" className="form-stack ppl-form" onSubmit={submit}>
        <PersonForm value={form} onChange={setForm} onBusyChange={setPhotoBusy} />
      </form>
    </Sheet>
  )
}

// A short list of actions for the ⋯ button: destructive ones last, in red.
function ActionSheet({ open, onClose, title, items }) {
  return (
    <Sheet open={open} onClose={onClose} size="sm" title={title} initialFocus={false}>
      <ul className="ppl-actions">
        {items.filter(Boolean).map((item) => (
          <li key={item.label}>
            <button
              type="button"
              className={`ppl-action${item.danger ? ' is-danger' : ''}`}
              onClick={() => {
                onClose()
                item.onClick()
              }}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

function PersonSheet({ friendId, onClose, onCatchUp }) {
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  // Keeps showing the last person while the sheet animates closed.
  const [shownId, setShownId] = useState(friendId)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_PERSON)
  const [photoBusy, setPhotoBusy] = useState(false)
  const contentRef = useRef(null)
  const switched = useRef(false)
  const today = todayISO()

  useEffect(() => {
    if (friendId) setShownId(friendId)
    setEditing(false)
    setMenuOpen(false)
  }, [friendId])

  // Switching between the person and the edit form removes the focused button (Edit, Save,
  // Cancel): keep focus in the sheet rather than letting it fall back to the page.
  useEffect(() => {
    if (!switched.current) {
      switched.current = true
      return
    }
    if (!friendId) return // closing: the sheet hands focus back itself
    const panel = contentRef.current?.closest('[role="dialog"]')
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
  }, [editing])

  const friend = friends.find((item) => item.id === (friendId || shownId)) || null
  const logs = useMemo(() => (friend ? contactLogs.filter((log) => (log.friendId || log.friend_id) === friend.id).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')) : []), [contactLogs, friend])
  const status = friend ? friendStatus(friend, lastContactMap(logs), today) : null
  // "Last time" is the latest day's catch-up; if that day somehow has two, the one with a note
  // (the People list previews the same note).
  const latest = logs.find((log) => log.date === logs[0].date && (log.note || '').trim()) || logs[0]
  const earlier = logs.filter((log) => log !== latest)

  // The hero photo's picker lives here, so the ⋯ menu can open it too.
  const heroPicker = usePhotoPicker((photoUrl) => {
    if (!friend) return
    const previous = friend.photoUrl || ''
    updateFriend(friend.id, { photoUrl })
    toast(previous ? 'Photo changed' : 'Photo added', { action: { label: 'Undo', onClick: () => updateFriend(friend.id, { photoUrl: previous }) } })
  }, (message) => toast(message))

  function startEdit() {
    // Older people store their notes in `note`; show them here so they can be edited.
    setForm({
      ...EMPTY_PERSON,
      ...Object.fromEntries(Object.keys(EMPTY_PERSON).map((key) => [key, friend[key] || EMPTY_PERSON[key]])),
      facts: friend.facts || friend.note || '',
      reminderDays: reminderFormValue(friend),
    })
    setEditing(true)
  }

  function save(event) {
    event.preventDefault()
    if (!form.name.trim() || photoBusy) return
    const { reminderDays, ...fields } = form
    const patch = { ...fields, name: form.name.trim() }
    // Keep a legacy note in step, so clearing the field doesn't bring it back.
    if (friend.note) patch.note = form.facts
    // The sheet switches back to showing the person with the changes: no toast needed.
    updateFriend(friend.id, patch)
    applyReminder(friend.id, { reminderDays })
    setEditing(false)
  }

  function remove() {
    const name = friend.name
    const undo = removeFriend(friend.id)
    onClose()
    toast(`Removed ${name}`, { action: { label: 'Undo', onClick: undo } })
  }

  const tone = status?.due ? 'danger' : status?.soon ? 'warning' : status?.last ? 'success' : 'muted'
  const nextLine = !status ? '' : !status.interval ? 'No catch-up reminders'
    : status.due ? 'Time to catch up'
      : `Next catch-up ${dueLabel(addDaysISO(status.last, status.interval), today).replace(/^Due/, 'due')}`

  return (
    <Sheet
      open={!!friendId && !!friend}
      onClose={onClose}
      title={editing ? 'Edit person' : friend?.name}
      description={editing ? undefined : friend ? `${relationshipLabel(friend.relationship)}${friend.organization ? ` · ${friend.organization}` : ''}` : undefined}
      // Keyed, so React doesn't turn the tapped Edit button into the Save (submit) button while
      // the tap is still being handled: the browser would then submit the form and leave editing.
      footer={editing ? (
        <Fragment key="editing">
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          {!form.name.trim() && <span className="ppl-footer-hint" aria-live="polite">A name is needed.</span>}
          <Button type="submit" form="edit-person" className="btn-grow" disabled={photoBusy || !form.name.trim()}>Save</Button>
        </Fragment>
      ) : (
        <Fragment key="viewing">
          <IconButton icon="more" label="More actions" className="ppl-menu-btn" aria-haspopup="dialog" onClick={() => setMenuOpen(true)} />
          <Button variant="secondary" icon="pencil" onClick={startEdit}>Edit</Button>
          <Button icon="check" className="btn-grow" onClick={() => onCatchUp(friend.id, 'today')}>Talked today</Button>
        </Fragment>
      )}
      initialFocus={editing}
    >
      {friend && (editing ? (
        <form ref={contentRef} id="edit-person" className="form-stack ppl-form" onSubmit={save}>
          <PersonForm value={form} onChange={setForm} onBusyChange={setPhotoBusy} />
        </form>
      ) : (
        <div ref={contentRef} className="person-detail">
          <ActionSheet
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            title={friend.name}
            items={[
              { icon: 'calendar', label: 'Log an earlier catch-up', onClick: () => onCatchUp(friend.id, 'earlier') },
              { icon: 'camera', label: (friend.photoUrl || '').trim() ? 'Change photo' : 'Add photo', onClick: heroPicker.open },
              { icon: 'trash', label: 'Remove person', danger: true, onClick: remove },
            ]}
          />
          <div className="ppl-hero">
            <HeroPhoto friend={friend} picker={heroPicker} />
            <div className="ppl-last">
              <p className="ppl-last-line">
                <i className={`status-dot is-${tone}`} aria-hidden="true" />
                <strong>{status.last ? `Talked ${timeAgo(status.last)}` : 'No catch-ups yet'}</strong>
              </p>
              <small className={`ppl-next${status.due ? ' is-due' : ''}`}>{nextLine}</small>
            </div>
          </div>

          <LastTime key={latest?.id || 'none'} log={latest} onCatchUp={(mode) => onCatchUp(friend.id, mode)} />

          <div className="ppl-facts">
            <div>
              <span className="ppl-label">Reminder</span>
              <strong>{status.interval ? `Every ${status.interval} days` : 'Off'}</strong>
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

          {latest && (
            <section className="detail-block">
              <div className="detail-block-header">
                <h3>Earlier catch-ups</h3>
                <Button variant="secondary" size="sm" icon="calendar" className="ppl-earlier" onClick={() => onCatchUp(friend.id, 'earlier')}>Log earlier</Button>
              </div>
              {earlier.length ? <CatchUpList key={friend.id} logs={earlier} /> : <p className="muted ppl-none-earlier">Nothing before {formatDateShort(latest.date)} yet.</p>}
            </section>
          )}
        </div>
      ))}
    </Sheet>
  )
}

// The person's photo in their sheet: tap it to choose a new one (saved straight away, with Undo).
function HeroPhoto({ friend, picker }) {
  const has = !!(friend.photoUrl || '').trim()
  return (
    <span className="ppl-hero-photo">
      <button type="button" className="ppl-photo-pick" onClick={picker.open} aria-label={has ? `Change ${friend.name}’s photo` : `Add a photo of ${friend.name}`} aria-busy={picker.busy || undefined}>
        <PersonAvatar name={friend.name} src={friend.photoUrl} size={72} />
        {(!has || picker.busy) && (
          <span className={`ppl-photo-badge is-small${picker.busy ? ' is-busy' : ''}`} aria-hidden="true">
            {picker.busy ? <span className="spinner" /> : <Icon name="camera" size={14} strokeWidth={2.2} />}
          </span>
        )}
      </button>
      {picker.input}
    </span>
  )
}

// "Last time": what you talked about at the latest catch-up, near the top of the person's sheet.
// The note is the catch-up's own (contact_logs.note), edited in place.
function LastTime({ log, onCatchUp }) {
  const [editing, setEditing] = useState(false)
  const cardRef = useRef(null)
  const wasEditing = useRef(false)
  const note = (log?.note || '').trim()

  // Saving or cancelling removes the focused text box: keep focus on this card (for VoiceOver and
  // keyboards) instead of dropping it to the top of the page.
  useEffect(() => {
    const closed = wasEditing.current && !editing
    wasEditing.current = editing
    const card = cardRef.current
    if (closed && card && (!document.activeElement || document.activeElement === document.body)) card.focus({ preventScroll: true })
  }, [editing])

  if (!log) {
    return (
      <section className="ppl-lasttime is-empty" aria-labelledby="ppl-lasttime-title">
        <h3 id="ppl-lasttime-title" className="ppl-label">Last time</h3>
        <p className="ppl-lasttime-empty">After you talk, tap Talked today and jot down what it was about. It shows up here next time.</p>
        <button type="button" className="ppl-lasttime-add" onClick={() => onCatchUp('earlier')}>
          <Icon name="calendar" size={16} strokeWidth={2.2} /> Log an earlier catch-up
        </button>
      </section>
    )
  }

  function save(text) {
    const undo = updateContactNote(log.id, text)
    setEditing(false)
    toast(text.trim() ? 'Note saved' : 'Note removed', { action: { label: 'Undo', onClick: undo } })
  }

  function remove() {
    const undo = removeContactLog(log.id)
    toast('Catch-up removed', { action: { label: 'Undo', onClick: undo } })
  }

  const when = `${formatDateShort(log.date)} · ${timeAgo(log.date)}`
  return (
    <section ref={cardRef} tabIndex={-1} className={`ppl-lasttime${note ? '' : ' is-blank'}`} aria-labelledby="ppl-lasttime-title">
      <div className="ppl-lasttime-head">
        <h3 id="ppl-lasttime-title" className="ppl-label">Last time</h3>
        <span className="ppl-lasttime-date">{when}</span>
        {note && !editing && (
          <button type="button" className="icon-btn ppl-lasttime-edit" onClick={() => setEditing(true)} aria-label={`Edit what you talked about on ${formatDateShort(log.date)}`}>
            <Icon name="pencil" size={17} />
          </button>
        )}
      </div>
      {editing ? (
        <NoteEditor note={note} label={`What you talked about on ${formatDateShort(log.date)}`} onCancel={() => setEditing(false)} onSave={save} onRemove={remove} />
      ) : note ? (
        <p className="ppl-lasttime-note">{note}</p>
      ) : (
        <>
          <p className="ppl-lasttime-empty">No notes from last time.</p>
          <button type="button" className="ppl-lasttime-add" onClick={() => setEditing(true)}>
            <Icon name="plus" size={16} strokeWidth={2.4} /> Add what you talked about
          </button>
        </>
      )}
    </section>
  )
}

function CatchUpList({ logs }) {
  const [openId, setOpenId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? logs : logs.slice(0, EARLIER_SHOWN)

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
      {logs.length > EARLIER_SHOWN && (
        <button type="button" className="ppl-show-all" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show all ${logs.length} earlier catch-ups`}
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

// Mounted per edit, so the draft starts from the saved note each time. onRemove (optional) adds a
// button that removes the whole catch-up.
function NoteEditor({ note, label, onCancel, onSave, onRemove }) {
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
        {onRemove && <button type="button" className="ppl-log-editor-remove" onClick={onRemove} aria-label="Remove this catch-up">Remove</button>}
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

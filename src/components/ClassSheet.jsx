import { useEffect, useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import Sheet from './ui/Sheet.jsx'
import Disclosure from './ui/Disclosure.jsx'
import { Button, Field } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { classSchedule, deleteClass, saveClass } from '../lib/planner.js'
import { formatDateShort, formatTime, timeToMinutes } from '../lib/dates.js'
import './class-sheet.css'

// Add a class (item = {}) or edit one (item = the class record); item = null closes the sheet.
// Opened from Settings, the Today card and the calendar agenda.
// Name, days and one time per day show first; rooms, extra times on a day and the last day of
// classes sit behind "More options" (open by itself once any of them is set).

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function toHHMM(minutes) {
  if (minutes === null || minutes === undefined) return ''
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// `raw` keeps the original text (e.g. "2 PM - 3 PM" from the assistant), which the time pickers
// may not be able to show; it is saved unchanged unless that day's times are edited.
function splitRange(text) {
  const raw = String(text || '').trim()
  const [start, end] = raw.split(/\s*[-–]\s*/)
  return { start: toHHMM(timeToMinutes(start)), end: toHHMM(timeToMinutes(end)), raw }
}

let keyCounter = 0
const nextKey = () => `slot-${keyCounter += 1}`

const rangeText = (start, end) => (start ? `${formatTime(start)}${end ? ` - ${formatTime(end)}` : ''}` : '')

export default function ClassSheet({ item, onClose }) {
  const open = !!item
  // Keep the last class while the sheet animates closed, so it doesn't switch to "Add a class".
  const shown = useRef(item)
  if (item) shown.current = item
  const shownItem = item || shown.current
  const editing = shownItem?.id ? shownItem : null
  const [name, setName] = useState('')
  const [endDate, setEndDate] = useState('')
  // Every meeting of the class: a day can have more than one (e.g. a lecture and a lab on Thursday).
  const [slots, setSlots] = useState([]) // [{ key, day, start, end, room, raw }]
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setName(editing?.name || '')
    setEndDate(editing?.endDate || '')
    setSlots((editing ? classSchedule(editing) : []).map((slot) => ({ key: nextKey(), day: slot.day, ...splitRange(slot.time), room: slot.room || '' })))
  }, [open, editing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasDay = (day) => slots.some((slot) => slot.day === day)
  const chosenDays = DAY_ORDER.filter(hasDay)
  // A new day copies the times (and room) of the first meeting: most classes keep the same hours.
  const toggleDay = (day) => setSlots((current) => {
    if (current.some((slot) => slot.day === day)) return current.filter((slot) => slot.day !== day)
    const model = current[0] || { start: '', end: '', room: '', raw: null }
    return [...current, { key: nextKey(), day, start: model.start, end: model.end, room: model.room, raw: model.raw }]
  })
  const addTime = (day) => setSlots((current) => [...current, { key: nextKey(), day, start: '', end: '', room: current.find((slot) => slot.day === day)?.room || '', raw: null }])
  const removeTime = (key) => setSlots((current) => current.filter((slot) => slot.key !== key))
  const setSlot = (key, field, value) => setSlots((current) => current.map((slot) => (slot.key === key
    ? { ...slot, [field]: value, ...(field === 'start' || field === 'end' ? { raw: null } : {}) }
    : slot)))

  // Rows in weekday order; a day with several meetings numbers them ("Thu", "Thu 2").
  const rows = chosenDays.flatMap((day) => {
    const times = slots.filter((slot) => slot.day === day)
    return times.map((slot, index) => ({ slot, day, index, count: times.length }))
  })
  const hasExtra = rows.some((row) => row.count > 1)
  const rooms = [...new Set(slots.map((slot) => slot.room.trim()).filter(Boolean))]
  const summary = [
    rooms.length ? `${rooms.length === 1 ? 'Room' : 'Rooms'} ${rooms.join(', ')}` : '',
    endDate ? `Ends ${formatDateShort(endDate)}` : '',
  ].filter(Boolean).join(' · ')

  function submit(event) {
    event.preventDefault()
    if (!name.trim()) return setError('Give the class a name.')
    if (!slots.length) return setError('Pick at least one day.')
    // Saved as a list of meetings ({ day, time, room }), which allows several on one day.
    const days = DAY_ORDER.flatMap((day) => slots.filter((slot) => slot.day === day).map(({ start, end, room, raw }) => {
      const time = raw != null ? raw : rangeText(start, end)
      return { day, ...(time ? { time } : {}), ...(room.trim() ? { room: room.trim() } : {}) }
    }))
    saveClass({
      ...(editing || {}), name: name.trim(), days, endDate,
      // The older one-per-day details are replaced by the list; clear them (and legacy per-class
      // time/room) only when present, so databases without these columns still save.
      dayDetails: editing?.dayDetails && Object.keys(editing.dayDetails).length ? {} : undefined,
      time: editing?.time ? null : undefined,
      room: editing?.room ? null : undefined,
    })
    onClose()
  }

  function remove() {
    const undo = deleteClass(editing.id)
    onClose()
    toast(`Removed ${editing.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  const rowLabel = ({ day, index, count }) => (count > 1 ? `${day} ${index + 1}` : day)

  // Only a new class starts in the name field: tapping a class row on Today or in the calendar
  // shouldn't bring up the keyboard.
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit class' : 'New class'}
      initialFocus={!editing}
      footer={(
        <>
          {editing && <Button variant="ghost" icon="trash" onClick={remove}>Remove</Button>}
          <Button type="submit" form="class-form" className="btn-grow">{editing ? 'Save' : 'Add class'}</Button>
        </>
      )}
    >
      <form id="class-form" className="form-stack" onSubmit={submit}>
        <Field label="Class" error={error}>
          {(id) => <input id={id} className="input input-lg" value={name} onChange={(event) => { setName(event.target.value); setError('') }} placeholder="e.g. Biology" autoComplete="off" data-autofocus />}
        </Field>
        <div className="field">
          <span className="field-label">Days</span>
          <div className="chip-row">
            {DAY_ORDER.map((day) => (
              <button key={day} type="button" className={`chip ${hasDay(day) ? 'is-active' : ''}`} aria-pressed={hasDay(day)} onClick={() => toggleDay(day)}>{day}</button>
            ))}
          </div>
        </div>

        {rows.length > 0 && (
          <div className="field cs-times">
            <span className="field-label">Times</span>
            <div className={`cs-grid ${hasExtra ? 'has-extra' : ''}`} role="group" aria-label="Class times">
              <span className="cs-head" aria-hidden="true" />
              <span className="cs-head" aria-hidden="true">Starts</span>
              <span className="cs-head" aria-hidden="true">Ends</span>
              {hasExtra && <span className="cs-head" aria-hidden="true" />}
              {rows.map((row) => {
                const { slot } = row
                const label = rowLabel(row)
                return (
                  <div key={slot.key} className="cs-row">
                    <span className="cs-day">{label}</span>
                    <input className="input" type="time" value={slot.start} onChange={(event) => setSlot(slot.key, 'start', event.target.value)} aria-label={`${label} starts`} />
                    <input className="input" type="time" value={slot.end} onChange={(event) => setSlot(slot.key, 'end', event.target.value)} aria-label={`${label} ends`} />
                    {hasExtra && (row.count > 1 ? (
                      <button type="button" className="icon-btn icon-btn-sm cs-remove" onClick={() => removeTime(slot.key)} aria-label={`Remove ${label}`} title="Remove this time">
                        <Icon name="close" size={16} />
                      </button>
                    ) : <span />)}
                    {slot.raw && slot.raw !== rangeText(slot.start, slot.end) && <p className="field-hint cs-raw">Currently: {slot.raw}</p>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <Disclosure key={editing?.id || 'new'} id="class-more" label="More options" summary={summary} hasValues={!!summary}>
          {rows.length > 0 ? (
            <div className="field">
              <span className="field-label">{rows.length === 1 ? 'Room' : 'Rooms'}</span>
              <div className="cs-rooms">
                {rows.map((row) => {
                  const { slot } = row
                  const label = rowLabel(row)
                  const when = slot.start ? `${label} · ${formatTime(slot.start)}` : label
                  return (
                    <label key={slot.key} className="cs-room">
                      {rows.length > 1 && <span className="cs-room-when">{when}</span>}
                      <input className="input" value={slot.room} onChange={(event) => setSlot(slot.key, 'room', event.target.value)} placeholder="e.g. SEB 1200" aria-label={rows.length > 1 ? `Room for ${when}` : 'Room'} autoComplete="off" />
                    </label>
                  )
                })}
              </div>
            </div>
          ) : (
            <p className="field-hint">Pick a day to set a room or extra times.</p>
          )}
          {chosenDays.length > 0 && (
            <div className="field">
              <span className="field-label">Add another time on</span>
              <div className="chip-row">
                {chosenDays.map((day) => (
                  <button key={day} type="button" className="chip chip-sm" onClick={() => addTime(day)} aria-label={`Add another time on ${day}`}>+ {day}</button>
                ))}
              </div>
            </div>
          )}
          <Field label="Last day of classes" hint="Optional — the class stops showing after this date.">
            {(id) => <input id={id} className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />}
          </Field>
        </Disclosure>
      </form>
    </Sheet>
  )
}

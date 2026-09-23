import { useEffect, useRef, useState } from 'react'
import Sheet from './ui/Sheet.jsx'
import { Button, Field } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { classSchedule, deleteClass, saveClass } from '../lib/planner.js'
import { formatTime, timeToMinutes } from '../lib/dates.js'

// Add a class (item = {}) or edit one (item = the class record); item = null closes the sheet.
// Opened from Settings, the Today card and the calendar agenda.

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
  const [slots, setSlots] = useState({}) // day -> { start, end, room }
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setName(editing?.name || '')
    setEndDate(editing?.endDate || '')
    const next = {}
    for (const slot of editing ? classSchedule(editing) : []) next[slot.day] = { ...splitRange(slot.time), room: slot.room || '' }
    setSlots(next)
  }, [open, editing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDay = (day) => setSlots((current) => {
    const next = { ...current }
    if (next[day]) delete next[day]
    else next[day] = { ...(Object.values(current)[0] || { start: '', end: '', room: '' }) }
    return next
  })
  const setSlot = (day, field, value) => setSlots((current) => ({ ...current, [day]: { ...current[day], [field]: value, ...(field === 'start' || field === 'end' ? { raw: null } : {}) } }))

  function submit(event) {
    event.preventDefault()
    const days = DAY_ORDER.filter((day) => slots[day])
    if (!name.trim()) return setError('Give the class a name.')
    if (!days.length) return setError('Pick at least one day.')
    const dayDetails = Object.fromEntries(days.map((day) => {
      const { start, end, room, raw } = slots[day]
      const time = raw != null ? raw : rangeText(start, end)
      return [day, { time, room: room.trim() }]
    }))
    saveClass({
      ...(editing || {}), name: name.trim(), days, dayDetails, endDate,
      // Clear legacy per-class time/room (null serializes; undefined is dropped). Only when present,
      // so databases without these columns still save.
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

  // Only a new class starts in the name field: tapping a class row on Today or in the calendar
  // shouldn't bring up the keyboard.
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit class' : 'Add a class'}
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
              <button key={day} type="button" className={`chip ${slots[day] ? 'is-active' : ''}`} aria-pressed={!!slots[day]} onClick={() => toggleDay(day)}>{day}</button>
            ))}
          </div>
        </div>
        {DAY_ORDER.filter((day) => slots[day]).map((day) => (
          <fieldset key={day} className="slot">
            <legend>{day}</legend>
            <div className="field-row field-row-3">
              <label className="mini-field"><span>Starts</span><input className="input" type="time" value={slots[day].start} onChange={(event) => setSlot(day, 'start', event.target.value)} /></label>
              <label className="mini-field"><span>Ends</span><input className="input" type="time" value={slots[day].end} onChange={(event) => setSlot(day, 'end', event.target.value)} /></label>
              <label className="mini-field"><span>Room</span><input className="input" value={slots[day].room} onChange={(event) => setSlot(day, 'room', event.target.value)} placeholder="Optional" /></label>
            </div>
            {slots[day].raw && slots[day].raw !== rangeText(slots[day].start, slots[day].end) && <p className="field-hint">Currently: {slots[day].raw}</p>}
          </fieldset>
        ))}
        <Field label="Last day of classes" hint="Optional — classes stop showing after this date.">
          {(id) => <input id={id} className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />}
        </Field>
      </form>
    </Sheet>
  )
}

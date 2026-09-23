import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { Button, Checkbox, EmptyState, Field } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { useData } from '../lib/store.js'
import { classSchedule, createEvent, deleteEvent, setTaskDone, updateEvent } from '../lib/planner.js'
import { WEEKDAY_SHORT, compareTimes, formatDateLong, formatMonthYear, formatTime, isISODate, todayISO, toISO } from '../lib/dates.js'

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function CalendarPage() {
  const events = useData('events')
  const tasks = useData('tasks')
  const classes = useData('classes')
  const friends = useData('friends')
  const today = todayISO()
  const [selected, setSelected] = useState(today)
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }))
  const [eventSheet, setEventSheet] = useState(null) // { event } | { date }
  const [taskEditing, setTaskEditing] = useState(null)
  const touchStart = useRef(null)

  const tasksById = useMemo(() => Object.fromEntries(tasks.map((task) => [task.id, task])), [tasks])

  // Everything shown on the calendar for the visible month, grouped by day.
  const itemsByDay = useMemo(() => {
    const map = {}
    const push = (date, item) => { (map[date] ||= []).push(item) }
    const monthPrefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`
    for (const event of events) {
      if (!event.date?.startsWith(monthPrefix)) continue
      const task = event.taskId ? tasksById[event.taskId] : null
      if (task?.archived) continue
      push(event.date, { kind: 'event', key: `e-${event.id}`, time: event.time, title: event.title, event, task })
    }
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
    for (const item of classes) {
      const schedule = classSchedule(item)
      if (!schedule.length) continue
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = toISO(new Date(cursor.year, cursor.month, day))
        if (item.endDate && date > item.endDate) break
        const weekday = WEEKDAY_SHORT[new Date(cursor.year, cursor.month, day).getDay()]
        for (const entry of schedule.filter((slot) => slot.day === weekday)) {
          push(date, { kind: 'class', key: `c-${item.id}-${date}-${entry.time}`, time: entry.time, title: item.name, room: entry.room })
        }
      }
    }
    for (const friend of friends) {
      if (!isISODate(friend.birthday)) continue
      const date = `${cursor.year}-${friend.birthday.slice(5)}`
      if (date.startsWith(monthPrefix) && isISODate(date)) push(date, { kind: 'birthday', key: `b-${friend.id}`, time: '', title: `${friend.name}’s birthday` })
    }
    for (const list of Object.values(map)) list.sort((a, b) => compareTimes(a.time, b.time))
    return map
  }, [events, tasksById, classes, friends, cursor])

  // Keep the selected day inside the visible month when paging.
  useEffect(() => {
    const prefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`
    if (!selected.startsWith(prefix)) setSelected(today.startsWith(prefix) ? today : `${prefix}-01`)
  }, [cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  const cells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1).getDay()
    const count = new Date(cursor.year, cursor.month + 1, 0).getDate()
    return [...Array(first).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)]
  }, [cursor])

  function shiftMonth(delta) {
    setCursor(({ year, month }) => {
      const date = new Date(year, month + delta, 1)
      return { year: date.getFullYear(), month: date.getMonth() }
    })
  }

  function goToday() {
    setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 })
    setSelected(today)
  }

  const dayItems = itemsByDay[selected] || []
  const isCurrentMonth = today.startsWith(`${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`)

  return (
    <div className="calendar-page">
      <header className="page-header page-header-row">
        <div>
          <h1>{formatMonthYear(cursor.year, cursor.month)}</h1>
          <p className="page-subtitle">{Object.values(itemsByDay).reduce((sum, list) => sum + list.length, 0)} items this month</p>
        </div>
        <div className="month-nav">
          {!isCurrentMonth && <Button variant="secondary" size="sm" onClick={goToday}>Today</Button>}
          <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><Icon name="chevronLeft" /></button>
          <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><Icon name="chevronRight" /></button>
        </div>
      </header>

      <div className="calendar-layout">
        <section
          className="card month-card"
          onTouchStart={(event) => { touchStart.current = event.touches[0].clientX }}
          onTouchEnd={(event) => {
            if (touchStart.current === null) return
            const delta = event.changedTouches[0].clientX - touchStart.current
            touchStart.current = null
            if (Math.abs(delta) > 60) shiftMonth(delta < 0 ? 1 : -1)
          }}
        >
          <div className="month-weekdays" aria-hidden="true">
            {WEEKDAY_INITIALS.map((day, index) => <span key={index}>{day}</span>)}
          </div>
          <div className="month-grid" role="grid" aria-label={formatMonthYear(cursor.year, cursor.month)}>
            {cells.map((day, index) => {
              if (!day) return <span key={`blank-${index}`} className="day-cell is-blank" />
              const iso = toISO(new Date(cursor.year, cursor.month, day))
              const items = itemsByDay[iso] || []
              const kinds = [...new Set(items.map((item) => item.kind))].slice(0, 3)
              return (
                <button
                  key={iso}
                  type="button"
                  className={`day-cell ${iso === selected ? 'is-selected' : ''} ${iso === today ? 'is-today' : ''} ${iso < today ? 'is-past' : ''}`}
                  onClick={() => setSelected(iso)}
                  aria-label={`${formatDateLong(iso)}${items.length ? `, ${items.length} item${items.length === 1 ? '' : 's'}` : ''}`}
                  aria-pressed={iso === selected}
                >
                  <span className="day-number">{day}</span>
                  <span className="day-dots" aria-hidden="true">
                    {kinds.map((kind) => <i key={kind} className={`dot dot-${kind}`} />)}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="calendar-legend" aria-hidden="true">
            <span><i className="dot dot-event" />Tasks & events</span>
            <span><i className="dot dot-class" />Classes</span>
            <span><i className="dot dot-birthday" />Birthdays</span>
          </div>
        </section>

        <section className="agenda">
          <div className="agenda-header">
            <h2>{selected === today ? 'Today' : formatDateLong(selected)}</h2>
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setEventSheet({ date: selected })}>Add</Button>
          </div>
          {dayItems.length === 0 ? (
            <EmptyState icon="calendar" title="Nothing planned">
              Tap “Add” to put something on {selected === today ? 'today' : 'this day'}.
            </EmptyState>
          ) : (
            <ul className="agenda-list">
              {dayItems.map((item) => (
                <li key={item.key} className={`agenda-item agenda-${item.kind} ${item.task?.done ? 'is-done' : ''}`}>
                  <span className="agenda-time">{item.time ? (item.kind === 'class' ? item.time.split('-')[0].trim() : formatTime(item.time)) : 'All day'}</span>
                  <span className="agenda-bar" aria-hidden="true" />
                  {item.kind === 'event' ? (
                    <>
                      {item.task && <Checkbox checked={!!item.task.done} onChange={(done) => setTaskDone(item.task.id, done)} label={`Complete ${item.title}`} />}
                      <button type="button" className="agenda-body" onClick={() => (item.task ? setTaskEditing(item.task) : setEventSheet({ event: item.event }))}>
                        <strong>{item.title}</strong>
                        {item.task?.details && !item.task.details.startsWith('friend-reminder:') && <small>{item.task.details}</small>}
                      </button>
                    </>
                  ) : (
                    <div className="agenda-body is-static">
                      <strong>
                        {item.kind === 'birthday' && <Icon name="cake" size={15} />}
                        {item.kind === 'class' && <Icon name="graduation" size={15} />}
                        {item.title}
                      </strong>
                      {item.kind === 'class' && <small>{[item.time, item.room].filter(Boolean).join(' · ')}</small>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <EventSheet state={eventSheet} onClose={() => setEventSheet(null)} />
      <TaskSheet open={!!taskEditing} task={taskEditing} onClose={() => setTaskEditing(null)} />
    </div>
  )
}

function EventSheet({ state, onClose }) {
  const editing = state?.event || null
  const [form, setForm] = useState({ title: '', date: '', time: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!state) return
    setError('')
    setForm(editing ? { title: editing.title, date: editing.date, time: editing.time || '' } : { title: '', date: state.date, time: '' })
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  function submit(event) {
    event.preventDefault()
    if (!form.title.trim()) return setError('Give it a name.')
    if (!isISODate(form.date)) return setError('Pick a date.')
    if (editing) {
      updateEvent(editing.id, { title: form.title.trim(), date: form.date, time: form.time })
      toast('Event updated')
    } else {
      createEvent({ title: form.title.trim(), date: form.date, time: form.time })
      toast('Added to your calendar')
    }
    onClose()
  }

  function remove() {
    const undo = deleteEvent(editing.id)
    onClose()
    toast('Event removed', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <Sheet
      open={!!state}
      onClose={onClose}
      title={editing ? 'Edit event' : 'New event'}
      footer={(
        <>
          {editing && <Button variant="ghost" icon="trash" onClick={remove}>Delete</Button>}
          <Button type="submit" form="event-form" className="btn-grow">{editing ? 'Save' : 'Add to calendar'}</Button>
        </>
      )}
    >
      <form id="event-form" className="form-stack" onSubmit={submit}>
        <Field label="What" error={error}>
          {(id) => <input id={id} className="input input-lg" value={form.title} onChange={(event) => { setForm({ ...form, title: event.target.value }); setError('') }} placeholder="e.g. Dentist, Coffee with Sara" autoComplete="off" data-autofocus />}
        </Field>
        <div className="field-row">
          <Field label="Date">
            {(id) => <input id={id} className="input" type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />}
          </Field>
          <Field label="Time" hint="Leave empty for all day">
            {(id) => <input id={id} className="input" type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />}
          </Field>
        </div>
        <p className="field-hint">Events also appear in Tasks so you can check them off.</p>
      </form>
    </Sheet>
  )
}

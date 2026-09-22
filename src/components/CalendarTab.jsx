import { useEffect, useMemo, useState } from 'react'
import { formatTime12, load, save, uid, todayISO } from '../lib/storage.js'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function isoOf(year, month, day) {
  const m = String(month + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${year}-${m}-${d}`
}

export default function CalendarTab() {
  const [events, setEvents] = useState([])
  const [classes, setClasses] = useState([])
  const [friends, setFriends] = useState([])
  const [cursor, setCursor] = useState(() => {
    const t = new Date()
    return { year: t.getFullYear(), month: t.getMonth() }
  })

  useEffect(() => {
    let active = true
    Promise.all([load('events', []), load('classes', []), load('friends', [])]).then(([eventData, classData, friendData]) => {
      if (!active) return
      setEvents(eventData)
      setClasses(classData)
      setFriends(friendData)
    })
    return () => { active = false }
  }, [])
  const [selected, setSelected] = useState(todayISO())
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('')

  function persist(next) {
    setEvents(next)
    save('events', next)
  }

  const grid = useMemo(() => {
    const { year, month } = cursor
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    return cells
  }, [cursor])

  const calendarItems = useMemo(() => [
    ...events,
    ...classes.flatMap((item) => getClassEvents(item, cursor.year, cursor.month)),
    ...friends.flatMap((friend) => getBirthdayEvents(friend, cursor.year)),
  ], [events, classes, friends, cursor])

  const eventsByDay = useMemo(() => {
    const map = {}
    for (const ev of calendarItems) {
      if (!map[ev.date]) map[ev.date] = []
      map[ev.date].push(ev)
    }
    for (const k in map) map[k].sort((a, b) => sortableTime(a.time).localeCompare(sortableTime(b.time)))
    return map
  }, [calendarItems])

  function changeMonth(delta) {
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  function addEvent(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    const eventId = uid()
    const taskId = uid()
    persist([...events, { id: eventId, taskId, date: selected, time, title: trimmed }])
    load('tasks', []).then((tasks) => save('tasks', [
      { id: taskId, text: trimmed, details: '', done: false, archived: false, createdAt: Date.now(), date: selected, time, priority: 'medium', calendarEventId: eventId },
      ...tasks,
    ]))
    setTitle('')
    setTime('')
  }

  function remove(id) {
    const event = events.find((item) => item.id === id)
    if (!event) return
    const message = event.taskId
      ? `Delete "${event.title}" from the calendar? Its task will be archived (restore it from Settings).`
      : `Delete "${event.title}"?`
    if (!window.confirm(message)) return
    persist(events.filter((ev) => ev.id !== id))
    if (event.taskId) {
      load('tasks', []).then((tasks) => {
        if (tasks.some((task) => task.id === event.taskId)) save('tasks', tasks.map((task) => task.id === event.taskId ? { ...task, archived: true } : task))
      })
    }
  }

  const dayEvents = eventsByDay[selected] || []

  return (
    <section className="tab-panel">
      <div className="cal-nav">
        <button className="nav-arrow" onClick={() => changeMonth(-1)} aria-label="Previous month">‹</button>
        <span className="cal-month-label">{MONTH_NAMES[cursor.month]} {cursor.year}</span>
        <button className="nav-arrow" onClick={() => changeMonth(1)} aria-label="Next month">›</button>
      </div>

      <div className="cal-weekdays">
        {WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}
      </div>

      <div className="cal-grid">
        {grid.map((d, i) => {
          if (d === null) return <span key={i} className="cal-cell is-empty" />
          const iso = isoOf(cursor.year, cursor.month, d)
          const has = !!eventsByDay[iso]
          const isToday = iso === todayISO()
          const isSelected = iso === selected
          return (
            <button
              key={i}
              className={`cal-cell ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}`}
              onClick={() => setSelected(iso)}
            >
              {d}
              {has && <span className="cal-dot" />}
            </button>
          )
        })}
      </div>

      <div className="cal-day-detail">
        <h2 className="section-label">{formatLong(selected)}</h2>

        {dayEvents.length === 0 && <p className="empty-note">No events yet.</p>}

        <ul className="event-list">
          {dayEvents.map((ev) => (
            <li key={ev.id} className="event-row">
              {ev.time && <span className="event-time">{formatTime12(ev.time)}</span>}
              <span className="event-title">{ev.title}</span>
              {!ev.isClass && !ev.isBirthday && (
                <button className="row-delete" aria-label="Delete event" onClick={() => remove(ev.id)}>×</button>
              )}
            </li>
          ))}
        </ul>

        <form className="add-row cal-add-row" onSubmit={addEvent}>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Time"
          />
          <input
            type="text"
            placeholder="Add an event"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" className="btn-accent">Add</button>
        </form>
      </div>
    </section>
  )
}

function formatLong(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function getClassEvents(item, year, month) {
  const result = []
  const days = item.days || []
  const daysByName = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day)
    const dayName = Object.keys(daysByName).find((name) => daysByName[name] === date.getDay())
    const dayConfig = getDayConfig(item, dayName)
    const isoDate = isoOf(year, month, day)
    if (dayConfig && (!item.endDate || isoDate <= item.endDate)) {
      result.push({ id: `class-${item.id}-${day}`, date: isoDate, time: dayConfig.time || item.time || '', title: `${item.name}${dayConfig.room || item.room ? ` · ${dayConfig.room || item.room}` : ''}`, isClass: true })
    }
  }
  return result
}

function getDayConfig(item, dayName) {
  if ((item.days || []).some((day) => typeof day === 'string' && (day === dayName || day === dayName.slice(0, 3)))) {
    return item.dayDetails?.[dayName] || { time: item.time, room: item.room }
  }
  return (item.days || []).find((day) => day?.day === dayName || day?.day === dayName.slice(0, 3)) || null
}

function getBirthdayEvents(friend, year) {
  if (!friend.birthday) return []
  const [, month, day] = friend.birthday.split('-').map(Number)
  if (!month || !day) return []
  return [{ id: `birthday-${friend.id}-${year}`, date: isoOf(year, month - 1, day), time: '', title: `${friend.name}'s birthday`, isBirthday: true }]
}

// Class times are free text like "9:00 AM - 10:30 AM"; turn the start into HH:MM so they sort with "14:00"-style times.
function sortableTime(value) {
  if (!value) return '99:99'
  const match = String(value).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!match) return '99:98'
  let hour = Number(match[1])
  const suffix = match[3]?.toUpperCase()
  if (suffix === 'PM' && hour < 12) hour += 12
  if (suffix === 'AM' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${match[2]}`
}

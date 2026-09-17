import { useEffect, useMemo, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

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
  const [cursor, setCursor] = useState(() => {
    const t = new Date()
    return { year: t.getFullYear(), month: t.getMonth() }
  })

  useEffect(() => {
    let active = true
    Promise.all([load('events', []), load('classes', [])]).then(([eventData, classData]) => {
      if (!active) return
      setEvents(eventData)
      setClasses(classData)
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
  ], [events, classes, cursor])

  const eventsByDay = useMemo(() => {
    const map = {}
    for (const ev of calendarItems) {
      if (!map[ev.date]) map[ev.date] = []
      map[ev.date].push(ev)
    }
    for (const k in map) map[k].sort((a, b) => (a.time || '').localeCompare(b.time || ''))
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
    persist([...events, { id: uid(), date: selected, time, title: trimmed }])
    setTitle('')
    setTime('')
  }

  function remove(id) {
    persist(events.filter((ev) => ev.id !== id))
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
              {ev.time && <span className="event-time">{ev.time}</span>}
              <span className="event-title">{ev.title}</span>
              <button className="row-delete" aria-label="Delete event" onClick={() => remove(ev.id)}>×</button>
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
    if (days.includes(dayName) || days.includes(dayName?.slice(0, 3))) {
      result.push({ id: `class-${item.id}-${day}`, date: isoOf(year, month, day), time: item.time || '', title: `${item.name}${item.room ? ` · ${item.room}` : ''}`, isClass: true })
    }
  }
  return result
}

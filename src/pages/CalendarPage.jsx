import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { Button, Checkbox, EmptyState, Field } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import ClassSheet from '../components/ClassSheet.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { readPref, writePref } from '../lib/api.js'
import { useData } from '../lib/store.js'
import { classSchedule, deleteEvent, setTaskDone, updateEvent } from '../lib/planner.js'
import { WEEKDAY_SHORT, addDaysISO, compareTimes, formatDateLong, formatMonthYear, formatTime, isISODate, toISO, weekdayIndex } from '../lib/dates.js'
import { useNow } from '../lib/environment.js'
import '../components/calendar.css'

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const SWIPE_PX = 50
const MORPH_MS = 340
const MORPH_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)' // the iOS sheet curve (--ios-sheet)
// Below 1000px the month sits above the agenda, so it can fold to one week (remembered per device).
const STACKED_QUERY = '(max-width: 999px)'
const VIEW_PREF = 'calendarView'

const pad = (value) => String(value).padStart(2, '0')
const monthKeyOf = (year, month) => `${year}-${pad(month + 1)}`
const monthOf = (iso) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 })
const weekStartOf = (iso) => addDaysISO(iso, -weekdayIndex(iso)) // weeks start on Sunday
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Which row of its month grid a day sits in, and how many rows that grid has.
function monthRowOf(iso) {
  const { year, month } = monthOf(iso)
  const offset = new Date(year, month, 1).getDay()
  const days = new Date(year, month + 1, 0).getDate()
  return { row: Math.floor((offset + Number(iso.slice(8, 10)) - 1) / 7), rows: Math.ceil((offset + days) / 7) }
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return undefined
    const update = () => setMatches(list.matches)
    update()
    if (list.addEventListener) list.addEventListener('change', update)
    else list.addListener?.(update)
    return () => {
      if (list.removeEventListener) list.removeEventListener('change', update)
      else list.removeListener?.(update)
    }
  }, [query])
  return matches
}

// Everything shown on the calendar from `start` to `end` (inclusive ISO dates), grouped by day.
function collectItems({ start, end, events, tasksById, classes, friends }) {
  const map = {}
  const push = (date, item) => { (map[date] ||= []).push(item) }
  for (const event of events) {
    if (typeof event.date !== 'string' || event.date < start || event.date > end) continue
    const task = event.taskId ? tasksById[event.taskId] : null
    if (task?.archived) continue
    push(event.date, { kind: 'event', key: `e-${event.id}`, time: event.time, title: event.title, event, task })
  }
  const days = []
  for (let date = start; date <= end && days.length < 42; date = addDaysISO(date, 1)) days.push(date)
  for (const record of classes) {
    const schedule = classSchedule(record)
    if (!schedule.length) continue
    for (const date of days) {
      if (record.endDate && date > record.endDate) break
      const weekday = WEEKDAY_SHORT[weekdayIndex(date)]
      schedule.forEach((slot, index) => {
        if (slot.day === weekday) push(date, { kind: 'class', key: `c-${record.id}-${date}-${index}`, time: slot.time, title: record.name, room: slot.room, record })
      })
    }
  }
  // A week can cross into the next year.
  const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])]
  for (const friend of friends) {
    if (!isISODate(friend.birthday)) continue
    for (const year of years) {
      let date = `${year}-${friend.birthday.slice(5)}`
      if (!isISODate(date)) date = `${year}-03-01` // Feb 29 in a non-leap year
      if (date >= start && date <= end) push(date, { kind: 'birthday', key: `b-${friend.id}-${year}`, time: '', title: `${friend.name}’s birthday` })
    }
  }
  for (const list of Object.values(map)) list.sort((a, b) => compareTimes(a.time, b.time))
  return map
}

export default function CalendarPage() {
  const events = useData('events')
  const tasks = useData('tasks')
  const classes = useData('classes')
  const friends = useData('friends')
  // Ticks every minute, so the "today" ring and the Today/Tomorrow titles move on at midnight.
  const today = toISO(useNow(60000))
  const stacked = useMediaQuery(STACKED_QUERY)
  const [weekPref, setWeekPref] = useState(() => readPref(VIEW_PREF, 'month') === 'week')
  const view = stacked && weekPref ? 'week' : 'month'
  const [selected, setSelected] = useState(today)
  const [cursor, setCursor] = useState(() => monthOf(today)) // the month in the title (and grid)
  const [taskSheet, setTaskSheet] = useState(null) // { task } edits one, { defaults } adds one
  const [eventEditing, setEventEditing] = useState(null) // an old event without a linked task
  const [classEditing, setClassEditing] = useState(null)
  const swipe = useRef(null)
  const ignoreClickUntil = useRef(0)
  const motion = useRef(null) // how the next grid change animates: next | prev | collapse | expand
  const clipRef = useRef(null)
  const gridRef = useRef(null)
  const clipHeight = useRef(0)
  const morphTimer = useRef(0)

  const monthKey = monthKeyOf(cursor.year, cursor.month)
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
  const weekStart = weekStartOf(selected)
  const rangeStart = view === 'week' ? weekStart : `${monthKey}-01`
  const rangeEnd = view === 'week' ? addDaysISO(weekStart, 6) : `${monthKey}-${pad(daysInMonth)}`
  const gridKey = view === 'week' ? `w-${weekStart}` : `m-${monthKey}`

  const tasksById = useMemo(() => Object.fromEntries(tasks.map((task) => [task.id, task])), [tasks])
  const itemsByDay = useMemo(
    () => collectItems({ start: rangeStart, end: rangeEnd, events, tasksById, classes, friends }),
    [rangeStart, rangeEnd, events, tasksById, classes, friends],
  )

  // Month: blanks before the 1st, then each day. Week: the seven days around the selected one.
  const cells = useMemo(() => {
    if (view === 'week') return Array.from({ length: 7 }, (_, index) => addDaysISO(weekStart, index))
    const first = new Date(cursor.year, cursor.month, 1).getDay()
    return [...Array(first).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => `${monthKey}-${pad(index + 1)}`)]
  }, [view, weekStart, cursor, monthKey, daysInMonth])

  // Keep the last settled height of the grid, so the next change can animate from it.
  useEffect(() => {
    const clip = clipRef.current
    if (!clip || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      if (!clip.getAnimations?.().length) clipHeight.current = clip.getBoundingClientRect().height
    })
    observer.observe(clip)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => clearTimeout(morphTimer.current), [])

  // Paging slides the new month/week in; folding to a week slides the selected row up while the
  // grid shrinks, and unfolding does the reverse.
  useLayoutEffect(() => {
    const clip = clipRef.current
    const grid = gridRef.current
    const move = motion.current
    motion.current = null
    if (!clip || !grid) return
    const running = clip.getAnimations?.() || []
    let from = clipHeight.current
    if (running.length) {
      from = clip.getBoundingClientRect().height
      running.forEach((animation) => animation.cancel())
    }
    const to = clip.getBoundingClientRect().height
    clipHeight.current = to
    if (!move || typeof clip.animate !== 'function' || prefersReducedMotion()) return
    const options = { duration: MORPH_MS, easing: MORPH_EASE }
    clip.classList.add('is-morphing')
    clearTimeout(morphTimer.current)
    morphTimer.current = setTimeout(() => clip.classList.remove('is-morphing'), MORPH_MS + 40)
    if (from && Math.abs(from - to) > 1) clip.animate([{ height: `${from}px` }, { height: `${to}px` }], options)
    if (move.kind === 'next' || move.kind === 'prev') {
      const offset = move.kind === 'next' ? 28 : -28
      grid.animate([{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'none' }], options)
    } else if (move.kind === 'collapse') {
      grid.animate([{ transform: `translateY(${move.row * 100}%)` }, { transform: 'none' }], options)
    } else if (move.kind === 'expand') {
      grid.animate([{ transform: `translateY(${(-move.row / move.rows) * 100}%)` }, { transform: 'none' }], options)
    }
  }, [gridKey])
  // A move that didn't change the grid (e.g. "Today" within the same month) is dropped here.
  useLayoutEffect(() => { motion.current = null })

  function showDate(iso, direction = 0) {
    motion.current = direction ? { kind: direction > 0 ? 'next' : 'prev' } : null
    setSelected(iso)
    setCursor(monthOf(iso))
  }

  // Arrows and swipes page by week in week view, by month otherwise.
  function shift(delta) {
    if (view === 'week') {
      showDate(addDaysISO(selected, delta * 7), delta)
      return
    }
    const date = new Date(cursor.year, cursor.month + delta, 1)
    const key = monthKeyOf(date.getFullYear(), date.getMonth())
    showDate(today.startsWith(key) ? today : `${key}-01`, delta)
  }

  function goToday() {
    showDate(today, today < rangeStart ? -1 : 1)
  }

  function selectDay(iso) {
    if (performance.now() < ignoreClickUntil.current) return
    setSelected(iso)
    // A week can hold the first days of the next month (or the last of the previous one).
    if (!iso.startsWith(monthKey)) setCursor(monthOf(iso))
  }

  function toggleView() {
    const next = view === 'week' ? 'month' : 'week'
    motion.current = { kind: next === 'week' ? 'collapse' : 'expand', ...monthRowOf(selected) }
    setCursor(monthOf(selected))
    setWeekPref(next === 'week')
    writePref(VIEW_PREF, next)
  }

  // Completing removes the task from the calendar, so offer a way back.
  function completeTask(item, done) {
    setTaskDone(item.task.id, done)
    if (done) toast(`Completed “${item.title}”`, { action: { label: 'Undo', onClick: () => setTaskDone(item.task.id, false) } })
  }

  // Mostly-sideways swipes (≥ 50 px) page; vertical drags still scroll the page.
  const swipeHandlers = {
    onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    },
    onPointerUp(event) {
      const start = swipe.current
      swipe.current = null
      if (!start || start.id !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return
      ignoreClickUntil.current = performance.now() + 400
      shift(dx < 0 ? 1 : -1)
    },
    onPointerCancel() {
      swipe.current = null
    },
    onKeyDown(event) {
      if (event.key !== 'PageUp' && event.key !== 'PageDown') return
      event.preventDefault()
      shift(event.key === 'PageDown' ? 1 : -1)
    },
  }

  const week = view === 'week'
  const dayItems = itemsByDay[selected] || []
  const shownCount = Object.values(itemsByDay).reduce((sum, list) => sum + list.length, 0)
  const showsToday = week ? cells.includes(today) : today.startsWith(monthKey)
  const tomorrow = addDaysISO(today, 1)
  const dayTitle = selected === today ? 'Today' : selected === tomorrow ? 'Tomorrow' : formatDateLong(selected)
  const legend = (
    <>
      <span><i className="dot dot-event" />Tasks & events</span>
      <span><i className="dot dot-class" />Classes</span>
      <span><i className="dot dot-birthday" />Birthdays</span>
    </>
  )

  return (
    <div className="calendar-page">
      <header className="page-header page-header-row">
        <div>
          <h1 aria-live="polite">{formatMonthYear(cursor.year, cursor.month)}</h1>
          <p className="page-subtitle">{`${shownCount} item${shownCount === 1 ? '' : 's'} this ${week ? 'week' : 'month'}`}</p>
        </div>
        <div className="month-nav">
          {!showsToday && <Button variant="secondary" size="sm" onClick={goToday}>Today</Button>}
          <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label={week ? 'Previous week' : 'Previous month'}><Icon name="chevronLeft" /></button>
          <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label={week ? 'Next week' : 'Next month'}><Icon name="chevronRight" /></button>
        </div>
      </header>

      <div className="calendar-layout">
        <section className="card month-card cal-card" {...swipeHandlers}>
          <div className="month-weekdays" aria-hidden="true">
            {WEEKDAY_INITIALS.map((day, index) => <span key={index}>{day}</span>)}
          </div>
          <div ref={clipRef} className="cal-clip">
            <div
              ref={gridRef}
              key={gridKey}
              className="month-grid"
              role="grid"
              aria-label={week ? `Week of ${formatDateLong(weekStart)}` : formatMonthYear(cursor.year, cursor.month)}
            >
              {cells.map((iso, index) => {
                if (!iso) return <span key={`blank-${index}`} className="day-cell is-blank" />
                const items = itemsByDay[iso] || []
                const kinds = [...new Set(items.map((item) => item.kind))].slice(0, 3)
                return (
                  <button
                    key={iso}
                    type="button"
                    className={`day-cell ${iso === selected ? 'is-selected' : ''} ${iso === today ? 'is-today' : ''} ${iso < today ? 'is-past' : ''}`}
                    onClick={() => selectDay(iso)}
                    aria-label={`${formatDateLong(iso)}${items.length ? `, ${items.length} item${items.length === 1 ? '' : 's'}` : ''}`}
                    aria-pressed={iso === selected}
                  >
                    <span className="day-number">{Number(iso.slice(8, 10))}</span>
                    <span className="day-dots" aria-hidden="true">
                      {kinds.map((kind) => <i key={kind} className={`dot dot-${kind}`} />)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="cal-foot">
            <div className="calendar-legend cal-legend" aria-hidden="true">{legend}</div>
            {stacked && (
              <button
                type="button"
                className="cal-fold"
                onClick={toggleView}
                aria-expanded={!week}
                aria-label={week ? 'Show the whole month' : 'Show one week'}
              >
                <Icon name="chevronDown" size={16} strokeWidth={2.4} className="cal-fold-chevron" />
                {week ? 'Month' : 'Week'}
              </button>
            )}
          </div>
        </section>

        <section className="agenda">
          <div className="agenda-header">
            <h2>{dayTitle}</h2>
            <Button size="sm" icon="plus" onClick={() => setTaskSheet({ defaults: { date: selected } })}>Add event</Button>
          </div>
          {dayItems.length === 0 ? (
            <>
              <EmptyState icon="calendar" title="Nothing planned">
                Tap “Add event” to put something on {selected === today ? 'today' : 'this day'}.
              </EmptyState>
              <p className="cal-legend-line" aria-hidden="true">{legend}</p>
            </>
          ) : (
            <ul className="agenda-list">
              {dayItems.map((item) => (
                <li key={item.key} className={`agenda-item agenda-${item.kind} ${item.task?.done ? 'is-done' : ''}`}>
                  {/* A class shows the start of its range ("2:30 PM - 4:30 PM", "14:30–15:50", "11 am to 1 pm"). */}
                  <span className="agenda-time">{item.time ? (item.kind === 'class' ? item.time.split(/\s*(?:[-–—]|\bto\b)\s*/i)[0].trim() : formatTime(item.time)) : 'All day'}</span>
                  <span className="agenda-bar" aria-hidden="true" />
                  {item.kind === 'event' ? (
                    <>
                      {item.task && <Checkbox checked={!!item.task.done} onChange={(done) => completeTask(item, done)} label={`Complete ${item.title}`} />}
                      <button type="button" className="agenda-body" onClick={() => (item.task ? setTaskSheet({ task: item.task }) : setEventEditing(item.event))}>
                        <strong>{item.title}</strong>
                        {item.task?.details && !item.task.details.startsWith('friend-reminder:') && <small>{item.task.details}</small>}
                      </button>
                    </>
                  ) : item.kind === 'class' ? (
                    <button type="button" className="agenda-body" onClick={() => setClassEditing(item.record)}>
                      <strong><Icon name="graduation" size={15} />{item.title}</strong>
                      <small>{[item.time, item.room].filter(Boolean).join(' · ')}</small>
                    </button>
                  ) : (
                    <div className="agenda-body is-static">
                      <strong><Icon name="cake" size={15} />{item.title}</strong>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <TaskSheet open={!!taskSheet} task={taskSheet?.task || null} defaults={taskSheet?.defaults || { date: selected }} noun="event" onClose={() => setTaskSheet(null)} />
      <EventSheet event={eventEditing} onClose={() => setEventEditing(null)} />
      <ClassSheet item={classEditing} onClose={() => setClassEditing(null)} />
    </div>
  )
}

// Only for old calendar events that have no linked task; everything else opens the task form.
function EventSheet({ event, onClose }) {
  // Keep the last event while the sheet animates closed.
  const lastEvent = useRef(event)
  if (event) lastEvent.current = event
  const editing = event || lastEvent.current
  const [form, setForm] = useState({ title: '', date: '', time: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!event) return
    setError('')
    setForm({ title: event.title || '', date: event.date || '', time: event.time || '' })
  }, [event])

  function submit(submitEvent) {
    submitEvent.preventDefault()
    if (!form.title.trim()) return setError('Give it a name.')
    if (!isISODate(form.date)) return setError('Pick a date.')
    updateEvent(editing.id, { title: form.title.trim(), date: form.date, time: form.time })
    onClose()
  }

  function remove() {
    const undo = deleteEvent(editing.id)
    onClose()
    toast('Event removed', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <Sheet
      open={!!event}
      onClose={onClose}
      title="Edit event"
      initialFocus={false}
      footer={(
        <>
          <Button variant="ghost" icon="trash" onClick={remove}>Remove</Button>
          <Button type="submit" form="event-form" className="btn-grow">Save</Button>
        </>
      )}
    >
      <form id="event-form" className="form-stack" onSubmit={submit}>
        <Field label="Event" error={error}>
          {(id) => <input id={id} className="input input-lg" value={form.title} onChange={(changeEvent) => { setForm({ ...form, title: changeEvent.target.value }); setError('') }} placeholder="e.g. Dentist, Coffee with Sara" autoComplete="off" data-autofocus />}
        </Field>
        <div className="field-row">
          <Field label="Date">
            {(id) => <input id={id} className="input" type="date" value={form.date} onChange={(changeEvent) => setForm({ ...form, date: changeEvent.target.value })} />}
          </Field>
          <Field label="Time" hint="Leave empty for all day">
            {(id) => <input id={id} className="input" type="time" value={form.time} onChange={(changeEvent) => setForm({ ...form, time: changeEvent.target.value })} />}
          </Field>
        </div>
      </form>
    </Sheet>
  )
}

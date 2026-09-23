import { useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { WEEKDAY_SHORT, diffDays, formatDateLong, formatMonthYear, isISODate } from '../../lib/dates.js'
import { addDays, resolveRange, weekStart } from '../../lib/gym/schedule.js'
import { hasPlan, routineById, routineColor, slotLabel, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import DaySheet from './DaySheet.jsx'
import './history.css'

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SWIPE_PX = 50

const pad = (n) => String(n).padStart(2, '0')
const monthOf = (iso) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 })
const sessionStart = (session) => (typeof session.startedAt === 'string' && session.startedAt) || (typeof session.createdAt === 'string' ? session.createdAt : '')
const byStart = (a, b) => sessionStart(a).localeCompare(sessionStart(b))

// ---- routine abbreviations ------------------------------------------------------------------
// 1–2 characters, unique among the user's routines (in their order): the first letter, then the
// first letters of later words ('Upper B' → 'UB'), then the first letter plus a later consonant,
// digit or vowel ('Push' → 'P', 'Pull' → 'Pl').

const ALNUM = /[\p{L}\p{N}]/u
const LETTER = /\p{L}/u
const DIGIT = /\p{N}/u
const VOWEL = /[aeiouyàáâäãåæèéêëìíîïòóôöõøùúûüÿ]/i

function abbreviationOptions(name) {
  const text = String(name || '').trim()
  const chars = [...text].filter((char) => ALNUM.test(char))
  if (!chars.length) return []
  const first = chars[0].toLocaleUpperCase()
  const options = [first]
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const word of words.slice(1)) options.push(first + [...word][0].toLocaleUpperCase())
  const rest = chars.slice(1).map((char) => char.toLocaleLowerCase())
  const consonants = rest.filter((char) => LETTER.test(char) && !VOWEL.test(char))
  const digits = rest.filter((char) => DIGIT.test(char))
  const vowels = rest.filter((char) => VOWEL.test(char))
  for (const char of [...consonants, ...digits, ...vowels]) options.push(first + char)
  return [...new Set(options)]
}

export function routineAbbreviations(routines) {
  const used = new Set()
  const out = new Map()
  for (const routine of Array.isArray(routines) ? routines : []) {
    const options = abbreviationOptions(routine.name)
    if (!options.length) {
      out.set(routine.id, '•') // no letters or digits to use
      continue
    }
    let pick = options.find((option) => !used.has(option.toLocaleUpperCase()))
    for (let n = 2; n <= 9 && !pick; n++) {
      const candidate = `${[...options[0]][0]}${n}`
      if (!used.has(candidate.toLocaleUpperCase())) pick = candidate
    }
    pick = pick || options[0]
    used.add(pick.toLocaleUpperCase())
    out.set(routine.id, pick)
  }
  return out
}

// ---- calendar ---------------------------------------------------------------------------------

export default function CalendarTab({ today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const gym = useGym()
  const sessions = useGymSessions()
  const firstWeekday = gym.prefs.firstWeekday
  const [cursor, setCursor] = useState(() => monthOf(today))
  const [direction, setDirection] = useState(0)
  const [sheet, setSheet] = useState({ open: false, date: null })
  const swipe = useRef(null)
  const ignoreClickUntil = useRef(0)

  const monthKey = `${cursor.year}-${pad(cursor.month + 1)}`
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
  const gridStart = weekStart(`${monthKey}-01`, firstWeekday)
  const gridEnd = addDays(weekStart(`${monthKey}-${pad(daysInMonth)}`, firstWeekday), 6)
  const days = useMemo(() => resolveRange(gym, sessions, gridStart, gridEnd, today), [gym, sessions, gridStart, gridEnd, today])
  const abbr = useMemo(() => routineAbbreviations(gym.routines), [gym.routines])
  const title = formatMonthYear(cursor.year, cursor.month)
  const isCurrent = today.startsWith(monthKey)
  const weekdays = Array.from({ length: 7 }, (_, index) => (firstWeekday + index) % 7)

  const monthWorkouts = useMemo(() => sessions.filter((session) => session.date.startsWith(monthKey)).length, [sessions, monthKey])
  const lastDate = useMemo(() => sessions.find((session) => isISODate(session.date) && session.date <= today)?.date ?? null, [sessions, today])
  const sinceLast = lastDate ? diffDays(lastDate, today) : null

  // Routines that appear in this month, for the key under the grid.
  const monthRoutines = useMemo(() => {
    const ids = new Set()
    for (const day of days) {
      if (!day.date.startsWith(monthKey)) continue
      if (day.status === 'done') {
        for (const session of day.sessions) if (session.routineId != null) ids.add(session.routineId)
      } else if (day.shown.kind === 'routine' && day.status !== 'skipped') {
        ids.add(day.shown.routineId)
      }
    }
    return gym.routines.filter((routine) => ids.has(routine.id))
  }, [days, monthKey, gym.routines])

  function shiftMonth(delta) {
    setDirection(delta)
    setCursor(({ year, month }) => {
      const date = new Date(year, month + delta, 1)
      return { year: date.getFullYear(), month: date.getMonth() }
    })
  }

  function goToday() {
    const target = monthOf(today)
    setDirection(Math.sign(target.year * 12 + target.month - (cursor.year * 12 + cursor.month)))
    setCursor(target)
  }

  function openDay(date) {
    if (performance.now() < ignoreClickUntil.current) return
    setSheet({ open: true, date })
  }

  // Horizontal swipe (mostly sideways, ≥ 50 px) changes the month; vertical drags still scroll.
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
      shiftMonth(dx < 0 ? 1 : -1)
    },
    onPointerCancel() {
      swipe.current = null
    },
    onKeyDown(event) {
      if (event.key === 'PageUp') {
        event.preventDefault()
        shiftMonth(-1)
      } else if (event.key === 'PageDown') {
        event.preventDefault()
        shiftMonth(1)
      }
    },
  }

  const noSchedule = !gym.schedule.versions.length

  return (
    <div className="gym-cal">
      <div className="gym-cal-head">
        <h2 className="gym-cal-title" aria-live="polite">{title}</h2>
        <div className="month-nav">
          {!isCurrent && <Button variant="secondary" size="sm" onClick={goToday}>Today</Button>}
          <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month">
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month">
            <Icon name="chevronRight" />
          </button>
        </div>
      </div>

      <div className="gym-cal-stats">
        <span className="stat">
          <Icon name="calendarCheck" size={15} />
          <span><strong>{monthWorkouts}</strong> workout{monthWorkouts === 1 ? '' : 's'} {isCurrent ? 'this month' : `in ${title}`}</span>
        </span>
        <span className="stat">
          <Icon name="history" size={15} />
          {sinceLast === null ? (
            <span>No workouts logged yet</span>
          ) : sinceLast <= 0 ? (
            <span>Last workout <strong>today</strong></span>
          ) : (
            <span><strong>{sinceLast}</strong> rest day{sinceLast === 1 ? '' : 's'} since last workout</span>
          )}
        </span>
      </div>

      {noSchedule && (
        <div className="card gym-cal-hint">
          <span className="gym-cal-hint-icon" aria-hidden="true"><Icon name="calendarCheck" size={20} /></span>
          <div className="gym-cal-hint-text">
            <strong>No schedule yet</strong>
            <span>Plan your split and upcoming workouts show up here.</span>
          </div>
          <Button size="sm" onClick={() => navigate(hasPlan(gym) ? 'gym/routines' : 'gym')}>Set up</Button>
        </div>
      )}

      <section className="card gym-cal-card" aria-label={`${title} training calendar`} {...swipeHandlers}>
        <div className="gym-cal-weekdays" aria-hidden="true">
          {weekdays.map((weekday) => <span key={weekday} title={WEEKDAY_LONG[weekday]}>{WEEKDAY_SHORT[weekday].charAt(0)}</span>)}
        </div>
        <div key={monthKey} className={`gym-cal-grid${direction > 0 ? ' from-next' : direction < 0 ? ' from-prev' : ''}`}>
          {days.map((day) => (day.date.startsWith(monthKey)
            ? <DayCell key={day.date} day={day} gym={gym} abbr={abbr} today={today} onOpen={openDay} />
            : <span key={day.date} className="gym-cal-cell is-outside" aria-hidden="true" />))}
        </div>
        <Legend routines={monthRoutines} abbr={abbr} />
      </section>

      <DaySheet
        open={sheet.open}
        date={sheet.date}
        today={today}
        onClose={() => setSheet((current) => ({ ...current, open: false }))}
      />
    </div>
  )
}

const STATUS_WORDS = { skipped: 'skipped', missed: 'missed', today: 'planned', upcoming: 'planned' }

function DayCell({ day, gym, abbr, today, onOpen }) {
  const { status } = day
  const isToday = day.date === today
  const done = status === 'done' ? [...day.sessions].sort(byStart) : []
  const routineAbbr = day.routine ? abbr.get(day.routine.id) || '•' : '?'
  let color = null
  let accent = false
  let mark = null
  let text

  if (status === 'done') {
    const routine = routineById(gym, done[0].routineId)
    if (routine) color = routineColor(routine)
    else accent = true
    mark = done.slice(1, 4).map((session) => {
      const extra = routineById(gym, session.routineId)
      return <i key={session.id} className="gym-cal-dot" style={{ '--dot': extra ? routineColor(extra) : 'var(--accent)' }} />
    })
    const names = done.map((session) => session.name?.trim() || 'Workout')
    text = `${names.join(', ')}, ${done.length > 1 ? `${done.length} workouts done` : 'done'}`
  } else if (status === 'skipped') {
    mark = <span className="gym-cal-abbr">{day.shown.kind === 'routine' ? routineAbbr : '–'}</span>
  } else if (status === 'shifted') {
    mark = <Icon name="arrowRight" size={12} strokeWidth={2.6} />
    text = 'shifted'
  } else if (status === 'missed') {
    mark = <i className="gym-cal-dot is-missed" />
  } else if (status === 'today' || status === 'upcoming') {
    color = day.routine ? routineColor(day.routine) : 'var(--gym-c-none)'
    mark = <span className="gym-cal-abbr">{routineAbbr}</span>
  } else if (status === 'rest') {
    text = 'rest day'
  } else {
    text = 'no plan'
  }
  if (!text) text = `${slotLabel(day.shown, gym)}, ${STATUS_WORDS[status] || status}`

  const label = `${formatDateLong(day.date)}, ${text}${day.override ? ', changed' : ''}${isToday ? ', today' : ''}`
  const classes = [
    'gym-cal-cell',
    `st-${status}`,
    isToday && 'is-today',
    day.date < today && 'is-past',
    accent && 'is-accent',
    day.routineMissing && status !== 'done' && 'is-missing',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={classes}
      style={color ? { '--gym-dot': color } : undefined}
      onClick={() => onOpen(day.date)}
      aria-label={label}
    >
      <span className="gym-cal-num">{Number(day.date.slice(8, 10))}</span>
      <span className="gym-cal-mark" aria-hidden="true">{mark}</span>
      {day.override && (
        <span className="gym-cal-edit" aria-hidden="true"><Icon name="pencil" size={8} strokeWidth={2.8} /></span>
      )}
    </button>
  )
}

function Legend({ routines, abbr }) {
  return (
    <div className="gym-cal-foot" aria-hidden="true">
      <div className="gym-cal-legend">
        <span><i className="gym-key gym-key-done" />Done</span>
        <span><i className="gym-key gym-key-planned" />Planned</span>
        <span><i className="gym-key gym-key-today" />Today</span>
        <span><i className="gym-key gym-key-missed" />Missed</span>
        <span><span className="gym-key-struck">A</span>Skipped</span>
        <span><Icon name="arrowRight" size={12} strokeWidth={2.6} />Shifted</span>
        <span><span className="gym-key-edit"><Icon name="pencil" size={8} strokeWidth={2.8} /></span>Changed</span>
      </div>
      {routines.length > 0 && (
        <div className="gym-cal-routines">
          {routines.map((routine) => (
            <span key={routine.id} className="gym-cal-rkey" style={{ '--gym-dot': routineColor(routine) }}>
              <b>{abbr.get(routine.id) || '•'}</b>
              {routine.name.trim() || 'Untitled routine'}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

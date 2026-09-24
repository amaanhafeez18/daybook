import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { diffDays, formatDuration as formatMinutesText, formatMonthYear, formatTime, isISODate, nowTimeHHMM, parseISO } from '../../lib/dates.js'
import { exerciseById } from '../../lib/gym/library.js'
import { resolveDay } from '../../lib/gym/schedule.js'
import { bestSet, sessionDurationSec, sessionPRs, sessionVolume, sessionsToCsv } from '../../lib/gym/stats.js'
import { routineById, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatDistance, formatDuration, formatNumber, formatPace, formatVolume, formatWeight } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { GymEmpty, RoutineDot } from './common.jsx'
import { beginWorkout } from './startWorkout.js'
import './history.css'

// ---- shared helpers (also used by CalendarTab, DaySheet and SessionDetail) -----------------

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

export const errorMessage = (error) => error?.message || 'Something went wrong.'

export function showError(error) {
  toast(errorMessage(error), { tone: 'error' })
}

// Library/custom entry by id. With "Count body weight in volume" off, no entry adds body weight.
export function useExerciseLookup(gym) {
  const customs = gym.exercises
  const withBodyweight = gym.prefs.bodyweightInVolume !== false
  return useMemo(() => {
    const cache = new Map()
    return (id) => {
      if (!cache.has(id)) {
        const entry = exerciseById(id, customs)
        cache.set(id, entry && !withBodyweight ? { ...entry, bwVolume: false } : entry)
      }
      return cache.get(id)
    }
  }, [customs, withBodyweight])
}

// Volume per session object, cached for as long as the lookup lives.
export function useVolumeOf(lookup) {
  return useMemo(() => {
    const cache = new WeakMap()
    return (session) => {
      if (!cache.has(session)) cache.set(session, sessionVolume(session, lookup))
      return cache.get(session)
    }
  }, [lookup])
}

// PRs per session against the whole list (recomputed only when the list or formula changes).
export function usePrsOf(sessions, formula) {
  return useMemo(() => {
    const cache = new WeakMap()
    return (session) => {
      if (!cache.has(session)) cache.set(session, sessionPRs(sessions, session, formula))
      return cache.get(session)
    }
  }, [sessions, formula])
}

const repsText = (n) => `${formatNumber(n, 0)} rep${n === 1 ? '' : 's'}`

// One set as text for its tracking type: '80 kg × 8', '+20 kg × 6', '12 reps', '1:30', '5 km · 25:00'.
export function formatSetValue(set, tracking, unit, distanceUnit) {
  if (!set) return '—'
  const w = isNum(set.weightKg) ? set.weightKg : null
  const r = isNum(set.reps) ? set.reps : null
  const d = isNum(set.durationSec) && set.durationSec > 0 ? set.durationSec : null
  const m = isNum(set.distanceM) && set.distanceM > 0 ? set.distanceM : null
  const kg = (value) => formatWeight(value, unit)
  const join = (...parts) => parts.filter(Boolean).join(' · ') || '—'
  const longUnit = distanceUnit === 'mi' ? 'mi' : 'km'
  const shortUnit = distanceUnit === 'mi' ? 'yd' : 'm'
  switch (tracking) {
    case 'bodyweight_reps':
    case 'reps_only':
      return r !== null ? repsText(r) : '—'
    case 'weighted_bodyweight':
      if (r === null) return w ? `+${kg(w)}` : '—'
      return w ? `+${kg(w)} × ${formatNumber(r, 0)}` : repsText(r)
    case 'assisted_bodyweight':
      if (r === null) return w ? `−${kg(w)}` : '—'
      return w ? `−${kg(w)} × ${formatNumber(r, 0)}` : repsText(r)
    case 'duration':
      return d !== null ? formatDuration(d) : '—'
    case 'weight_duration':
      return join(w !== null && kg(w), d !== null && formatDuration(d))
    case 'distance_duration':
      return join(m !== null && formatDistance(m, longUnit), d !== null && formatDuration(d))
    case 'weight_distance':
      return join(w !== null && kg(w), m !== null && formatDistance(m, shortUnit))
    default:
      if (r === null) return w !== null ? kg(w) : '—'
      return w !== null ? `${kg(w)} × ${formatNumber(r, 0)}` : repsText(r)
  }
}

// A PR entry's value in display units.
export function formatPrValue(pr, unit, distanceUnit) {
  switch (pr?.type) {
    case 'setVolume':
    case 'sessionVolume':
      return formatVolume(pr.value, unit)
    case 'mostReps':
    case 'sessionReps':
      return repsText(pr.value)
    case 'longestDuration':
      return formatDuration(pr.value)
    case 'longestDistance':
      return formatDistance(pr.value, distanceUnit === 'mi' ? 'mi' : 'km')
    case 'bestPace':
      return formatPace(pr.value, distanceUnit)
    default:
      return formatWeight(pr?.value, unit)
  }
}

// '52 min', '1 h 5 min', '<1 min'; null when unknown.
export function formatMinutes(sec) {
  if (!isNum(sec) || sec <= 0) return null
  if (sec < 60) return '<1 min'
  return formatMinutesText(Math.round(sec / 60))
}

// Local wall-clock time of a timestamp: '6:10 PM' ('' when unknown).
export function clockLabel(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? formatTime(nowTimeHHMM(new Date(ms))) : ''
}

const dateFormats = new Map()

// 'Mon, Sep 14' ('Mon, Sep 14, 2025' in another year).
export function weekdayDate(iso, today) {
  if (!isISODate(iso)) return iso || ''
  const withYear = !today || iso.slice(0, 4) !== today.slice(0, 4)
  const key = withYear ? 'year' : 'plain'
  if (!dateFormats.has(key)) {
    dateFormats.set(key, new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }))
  }
  return dateFormats.get(key).format(parseISO(iso))
}

// 'Today', 'Yesterday', else 'Mon, Sep 14'.
export function sessionDay(session, today) {
  if (isISODate(session.date) && isISODate(today)) {
    const ago = diffDays(session.date, today)
    if (ago === 0) return 'Today'
    if (ago === 1) return 'Yesterday'
  }
  return weekdayDate(session.date, today)
}

// Routine colour dot; accent for a workout without a routine, dashed grey if the routine is gone.
export function SessionDot({ session, gym, size = 10 }) {
  const routine = routineById(gym, session.routineId)
  if (!routine && session.routineId == null) {
    return <span className="gym-dot" style={{ width: size, height: size, '--gym-dot': 'var(--accent)' }} aria-hidden="true" />
  }
  return <RoutineDot routine={routine} size={size} />
}

// iOS grouped-list row: tinted icon, label (+ hint) and a chevron. Put inside ul.gym-hl-list > li.
export function ActionRow({ icon, label, hint, onClick, danger = false, chevron = true, disabled = false }) {
  return (
    <button type="button" className={`gym-hl-row${danger ? ' is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="gym-hl-icon" aria-hidden="true"><Icon name={icon} size={17} strokeWidth={2} /></span>
      <span className="gym-hl-text">
        <span className="gym-hl-label">{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      {chevron && <Icon name="chevronRight" size={18} className="gym-hl-chevron" />}
    </button>
  )
}

// Shares the file where the device can (iPhone share sheet), else downloads it.
export async function shareOrDownload(text, filename, type = 'text/csv') {
  const blob = new Blob([text], { type })
  try {
    const file = new File([blob], filename, { type })
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    }
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled'
    // Sharing refused (e.g. no user gesture left): fall back to a download.
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return 'downloaded'
}

// ---- history tab -------------------------------------------------------------------------------

const PAGE = 30
const TOP_SETS = 3

const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function HistoryTab({ today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const gym = useGym()
  const sessions = useGymSessions()
  const { unit, distanceUnit, e1rmFormula: formula } = gym.prefs
  const lookup = useExerciseLookup(gym)
  const volumeOf = useVolumeOf(lookup)
  const prsOf = usePrsOf(sessions, formula)
  const [query, setQuery] = useState('')
  const [routineFilter, setRoutineFilter] = useState('all')
  const [limit, setLimit] = useState(PAGE)
  const sentinel = useRef(null)

  const routinesUsed = useMemo(() => {
    const ids = new Set(sessions.map((session) => session.routineId).filter((id) => id != null))
    return gym.routines.filter((routine) => ids.has(routine.id))
  }, [sessions, gym.routines])
  const filter = routineFilter !== 'all' && routinesUsed.some((routine) => routine.id === routineFilter) ? routineFilter : 'all'

  // Folded text per session: name, routine, exercises and note.
  const haystack = useMemo(() => {
    const cache = new WeakMap()
    return (session) => {
      if (!cache.has(session)) {
        const parts = [session.name, routineById(gym, session.routineId)?.name, session.note, ...session.exercises.map((exercise) => exercise.name)]
        cache.set(session, fold(parts.filter(Boolean).join(' ')))
      }
      return cache.get(session)
    }
  }, [gym])

  const filtered = useMemo(() => {
    const tokens = fold(query).split(/\s+/).filter(Boolean)
    return sessions.filter((session) => {
      if (filter !== 'all' && session.routineId !== filter) return false
      if (!tokens.length) return true
      const text = haystack(session)
      return tokens.every((token) => text.includes(token))
    })
  }, [sessions, filter, query, haystack])

  useEffect(() => setLimit(PAGE), [query, filter])

  const monthCounts = useMemo(() => {
    const counts = new Map()
    for (const session of filtered) {
      const key = session.date.slice(0, 7)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }, [filtered])

  const shown = filtered.slice(0, limit)
  const hasMore = filtered.length > shown.length
  const groups = []
  for (const session of shown) {
    const key = session.date.slice(0, 7)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(session)
    else groups.push({ key, items: [session] })
  }

  // Load the next page before the end of the list scrolls into view.
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + PAGE)
    }, { rootMargin: '600px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, limit])

  async function exportCsv() {
    if (!sessions.length) return
    const csv = sessionsToCsv(sessions, unit, gym.routines)
    const filename = `daybook-workouts-${today}.csv`
    const result = await shareOrDownload(csv, filename)
    if (result === 'downloaded') toast(`Exported ${sessions.length} workout${sessions.length === 1 ? '' : 's'}`, { tone: 'success' })
  }

  function startFirst() {
    const day = resolveDay(gym, sessions, today, today)
    beginWorkout({ routine: day.shown.kind === 'routine' ? day.routine : null, date: today, today })
  }

  if (!sessions.length) {
    return (
      <div className="gym-hist">
        <GymEmpty
          icon="history"
          title="No workouts yet"
          action={<Button icon="play" onClick={startFirst}>Start a workout</Button>}
        >
          Finished workouts land here with their top sets, weight lifted and personal records.
        </GymEmpty>
      </div>
    )
  }

  const searching = query.trim() !== '' || filter !== 'all'
  const total = sessions.length

  return (
    <div className="gym-hist">
      <div className="gym-hist-top">
        <p className="gym-hist-count">
          {searching ? `${filtered.length} of ${total} workouts` : `${total} workout${total === 1 ? '' : 's'}`}
        </p>
        <div className="gym-hist-actions">
          <Button variant="secondary" size="sm" icon="chart" onClick={() => navigate('gym/stats')}>Stats</Button>
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv} aria-label="Export CSV">Export</Button>
        </div>
      </div>

      <label className="search-field gym-hist-search">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search workouts or exercises"
          aria-label="Search workouts or exercises"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="gym-hist-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={14} strokeWidth={2.4} />
          </button>
        )}
      </label>

      {routinesUsed.length > 0 && (
        <div className="gym-hist-filters" role="group" aria-label="Filter by routine">
          <button type="button" className={`chip${filter === 'all' ? ' is-active' : ''}`} aria-pressed={filter === 'all'} onClick={() => setRoutineFilter('all')}>
            All
          </button>
          {routinesUsed.map((routine) => (
            <button
              key={routine.id}
              type="button"
              className={`chip gym-hist-chip${filter === routine.id ? ' is-active' : ''}`}
              aria-pressed={filter === routine.id}
              onClick={() => setRoutineFilter(filter === routine.id ? 'all' : routine.id)}
            >
              <RoutineDot routine={routine} size={8} />
              {routine.name.trim() || 'Untitled routine'}
            </button>
          ))}
        </div>
      )}

      {!filtered.length ? (
        <GymEmpty
          icon="search"
          title="No matching workouts"
          action={<Button variant="secondary" onClick={() => { setQuery(''); setRoutineFilter('all') }}>Clear search</Button>}
        >
          Try another name or exercise.
        </GymEmpty>
      ) : (
        groups.map((group) => {
          const count = monthCounts.get(group.key) || group.items.length
          return (
            <section key={group.key} className="gym-hist-group" aria-label={formatMonthYear(Number(group.key.slice(0, 4)), Number(group.key.slice(5, 7)) - 1)}>
              <h3 className="gym-hist-month">
                <span>{formatMonthYear(Number(group.key.slice(0, 4)), Number(group.key.slice(5, 7)) - 1)}</span>
                <span className="gym-hist-month-count">{count} workout{count === 1 ? '' : 's'}</span>
              </h3>
              <ul className="gym-hist-list">
                {group.items.map((session) => (
                  <li key={session.id}>
                    <HistoryCard
                      session={session}
                      gym={gym}
                      today={today}
                      unit={unit}
                      distanceUnit={distanceUnit}
                      formula={formula}
                      volume={volumeOf(session)}
                      prCount={session.exercises.length ? prsOf(session).length : 0}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )
        })
      )}

      {hasMore && (
        <div ref={sentinel} className="gym-hist-more-wrap">
          <Button variant="secondary" onClick={() => setLimit((current) => current + PAGE)}>Show more</Button>
        </div>
      )}
    </div>
  )
}

function HistoryCard({ session, gym, today, unit, distanceUnit, formula, volume, prCount }) {
  const quick = !session.exercises.length
  const time = clockLabel(session.startedAt)
  const minutes = formatMinutes(sessionDurationSec(session))
  const exercises = session.exercises.filter((exercise) => Array.isArray(exercise.sets) && exercise.sets.length)
  const top = exercises.slice(0, TOP_SETS)

  return (
    <button type="button" className="gym-hist-card" onClick={() => navigate(`gym/session/${encodeURIComponent(session.id)}`)}>
      <span className="gym-hist-head">
        <SessionDot session={session} gym={gym} />
        <strong className="gym-hist-name">{session.name?.trim() || 'Workout'}</strong>
        <span className="gym-hist-when">
          {sessionDay(session, today)}
          {time && ` · ${time}`}
        </span>
      </span>

      {quick ? (
        <span className="gym-hist-quick">Logged without details</span>
      ) : (
        <>
          <span className="gym-hist-meta">
            {minutes && <span><Icon name="clock" size={14} />{minutes}</span>}
            {volume > 0 && <span title="Weight lifted"><Icon name="dumbbell" size={14} /><span className="sr-only">Weight lifted </span>{formatVolume(volume, unit)}</span>}
            {session.isDeload && <span><Icon name="arrowDown" size={14} />Deload</span>}
            {prCount > 0 && (
              <span className="gym-pr-badge">
                <Icon name="trophy" size={12} strokeWidth={2.2} />
                {prCount} PR{prCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
          {top.length > 0 && (
            <span className="gym-hist-sets">
              {top.map((exercise, index) => (
                <span key={exercise.id ?? index} className="gym-hist-set">
                  <span className="gym-hist-ex">{exercise.name || 'Exercise'}</span>
                  <span className="gym-hist-val">{formatSetValue(bestSet(exercise, formula), exercise.tracking, unit, distanceUnit)}</span>
                </span>
              ))}
              {exercises.length > TOP_SETS && <span className="gym-hist-more">+{exercises.length - TOP_SETS} more</span>}
            </span>
          )}
        </>
      )}
    </button>
  )
}

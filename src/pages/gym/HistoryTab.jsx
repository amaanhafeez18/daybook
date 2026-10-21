import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { ActionSheet } from '../../components/ui/ActionSheet.jsx'
import { SwipeRow } from '../../components/ui/SwipeRow.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { diffDays, formatDuration as formatMinutesText, formatMonthYear, formatTime, isISODate, nowTimeHHMM, parseISO } from '../../lib/dates.js'
import { exerciseById } from '../../lib/gym/library.js'
import { resolveDay } from '../../lib/gym/schedule.js'
import { sessionDurationSec, sessionPRs, sessionVolume, sessionsToCsv } from '../../lib/gym/stats.js'
import { deleteSession, routineById, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatDistance, formatDuration, formatNumber, formatPace, formatVolume, formatWeight } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { shareOrDownload } from '../../lib/share.js'
import { GymEmpty, RoutineDot, goBack } from './common.jsx'
import { beginWorkout } from './startWorkout.js'
import './exercises.css'
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
// withUnit: false drops the weight unit, for rows under a 'kg × reps' header ('80 × 8').
export function formatSetValue(set, tracking, unit, distanceUnit, { withUnit = true } = {}) {
  if (!set) return '—'
  const w = isNum(set.weightKg) ? set.weightKg : null
  const r = isNum(set.reps) ? set.reps : null
  const d = isNum(set.durationSec) && set.durationSec > 0 ? set.durationSec : null
  const m = isNum(set.distanceM) && set.distanceM > 0 ? set.distanceM : null
  const kg = (value) => formatWeight(value, unit, { withUnit })
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

// ---- one workout in a list -----------------------------------------------------------------------

// A compact row (Gym → Progress and All workouts): routine dot, name, when, how long, records and
// the exercises in one line; the whole row opens the workout.
export function WorkoutRow({ session, gym, today, prCount = 0, showDate = true }) {
  const quick = !session.exercises.length
  const minutes = formatMinutes(sessionDurationSec(session))
  const names = session.exercises.filter((exercise) => Array.isArray(exercise.sets) && exercise.sets.length).map((exercise) => exercise.name || 'Exercise')
  const when = showDate ? sessionDay(session, today) : clockLabel(session.startedAt)
  const meta = [when, minutes].filter(Boolean).join(' · ')
  return (
    <button type="button" className="gym-wr" onClick={() => navigate(`gym/session/${encodeURIComponent(session.id)}`)}>
      <SessionDot session={session} gym={gym} size={10} />
      <span className="gym-wr-text">
        <span className="gym-wr-top">
          <strong className="gym-wr-name">{session.name?.trim() || 'Workout'}</strong>
          {prCount > 0 && (
            <span className="gym-pr-badge">
              <Icon name="trophy" size={12} strokeWidth={2.2} />
              {prCount}
              <span className="sr-only"> personal record{prCount === 1 ? '' : 's'}</span>
            </span>
          )}
        </span>
        <small className="gym-wr-meta">{meta}</small>
        <small className="gym-wr-ex">{quick ? 'Logged without details' : names.join(', ')}</small>
      </span>
      <Icon name="chevronRight" size={18} className="gym-wr-chevron" />
    </button>
  )
}

// A workout in a list, as an <li>: swipe left to delete (with Undo), press and hold for a peek with
// Open, Start again and Delete.
export function WorkoutItem({ session, gym, today, prCount = 0 }) {
  const [peek, setPeek] = useState(false)
  const name = session.name?.trim() || 'Workout'
  const quick = !session.exercises.length
  const remove = () => {
    const undo = deleteSession(session.id)
    toast(`Deleted “${name}”`, { action: { label: 'Undo', onClick: undo } })
  }
  const again = () => {
    beginWorkout({ fromSession: quick ? null : session, routine: routineById(gym, session.routineId) || null, date: today, today })
  }
  const minutes = formatMinutes(sessionDurationSec(session))
  const names = session.exercises.filter((exercise) => Array.isArray(exercise.sets) && exercise.sets.length).map((exercise) => `${exercise.name || 'Exercise'} · ${exercise.sets.length} set${exercise.sets.length === 1 ? '' : 's'}`)
  // The peek sits outside the row: React events bubble through portals, and the row's swipe
  // handlers mustn't see taps in the sheet.
  return (
    <>
      <SwipeRow onDelete={remove} onLongPress={() => setPeek(true)}>
        <WorkoutRow session={session} gym={gym} today={today} prCount={prCount} />
      </SwipeRow>
      <ActionSheet
        open={peek}
        onClose={() => setPeek(false)}
        title={name}
        preview={(
          <>
            <span className="peek-meta">{[weekdayDate(session.date, today), clockLabel(session.startedAt), minutes].filter(Boolean).join(' · ')}{prCount ? ` · ${prCount} record${prCount === 1 ? '' : 's'}` : ''}</span>
            <p>{quick ? 'Logged without details' : names.slice(0, 6).join('\n')}{names.length > 6 ? `\n+${names.length - 6} more` : ''}</p>
          </>
        )}
        actions={[
          [
            { id: 'open', label: 'Open', icon: 'chevronRight', onClick: () => navigate(`gym/session/${encodeURIComponent(session.id)}`) },
            { id: 'again', label: 'Start again', icon: 'play', hint: 'Repeat this workout today', onClick: again },
          ],
          [{ id: 'delete', label: 'Delete workout', icon: 'trash', danger: true, onClick: remove }],
        ]}
      />
    </>
  )
}

// ---- all workouts (#/gym/workouts) -----------------------------------------------------------------

const PAGE = 30

const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Every workout, newest first, by month, with one search box (name, routine, exercise or note).
export default function AllWorkouts({ today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const gym = useGym()
  const sessions = useGymSessions()
  const { unit, e1rmFormula: formula } = gym.prefs
  const prsOf = usePrsOf(sessions, formula)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const sentinel = useRef(null)

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
    if (!tokens.length) return sessions
    return sessions.filter((session) => {
      const text = haystack(session)
      return tokens.every((token) => text.includes(token))
    })
  }, [sessions, query, haystack])

  useEffect(() => setLimit(PAGE), [query])

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
    const result = await shareOrDownload(csv, `daybook-workouts-${today}.csv`)
    if (result === 'downloaded') toast(`Exported ${sessions.length} workout${sessions.length === 1 ? '' : 's'}`, { tone: 'success' })
  }

  function startFirst() {
    const day = resolveDay(gym, sessions, today, today)
    beginWorkout({ routine: day.shown.kind === 'routine' ? day.routine : null, date: today, today })
  }

  const total = sessions.length

  return (
    <div className="gym-hist">
      <div className="gym-xd-top">
        <button type="button" className="gym-xd-back" onClick={() => goBack('gym/history')}>
          <Icon name="chevronLeft" size={22} />
          Progress
        </button>
      </div>
      <header className="gym-hist-headline">
        <h1>All workouts</h1>
        {total > 0 && <p className="page-subtitle">{query.trim() ? `${filtered.length} of ${total}` : `${total} workout${total === 1 ? '' : 's'}`}</p>}
      </header>

      {!total ? (
        <GymEmpty icon="history" title="No workouts yet" action={<Button icon="play" onClick={startFirst}>Start a workout</Button>}>
          Finished workouts land here with their time, exercises and personal records.
        </GymEmpty>
      ) : (
        <>
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

          {!filtered.length ? (
            <GymEmpty icon="search" title="No matching workouts" action={<Button variant="secondary" onClick={() => setQuery('')}>Clear search</Button>}>
              Try another name or exercise.
            </GymEmpty>
          ) : (
            groups.map((group) => {
              const title = formatMonthYear(Number(group.key.slice(0, 4)), Number(group.key.slice(5, 7)) - 1)
              return (
                <section key={group.key} className="gym-hist-group" aria-label={title}>
                  <h3 className="gym-hist-month">{title}</h3>
                  <ul className="card-list gym-wr-list">
                    {group.items.map((session) => (
                      <WorkoutItem key={session.id} session={session} gym={gym} today={today} prCount={session.exercises.length ? prsOf(session).length : 0} />
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

          <button type="button" className="link-btn gym-hist-export" onClick={exportCsv}>
            <Icon name="download" size={16} />
            Export all workouts (CSV)
          </button>
        </>
      )}
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Disclosure from '../../components/ui/Disclosure.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { WEEKDAY_SHORT, addDaysISO, diffDays, formatDateShort, formatDuration as formatMinutesText, relativeDay, weekdayIndex } from '../../lib/dates.js'
import { MUSCLES, exerciseById } from '../../lib/gym/library.js'
import { resolveDay, weekStart } from '../../lib/gym/schedule.js'
import { streakWeeks, topExercises, weekSummary, weeklyCounts } from '../../lib/gym/stats.js'
import { routineById, routineColor, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatNumber } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { useSessionState } from '../../lib/sessionState.js'
import { useAnimatedNumber } from '../../lib/useAnimatedNumber.js'
import BodyWeightCard, { weekLabel } from './BodyWeightCard.jsx'
import ProgressPhotos from './ProgressPhotos.jsx'
import { GymEmpty, SectionHeader } from './common.jsx'
import { WorkoutItem, useExerciseLookup, usePrsOf } from './HistoryTab.jsx'
import { beginWorkout } from './startWorkout.js'
import './exercises.css'
import './history.css'
import './progress.css'

// Gym → Progress (the History tab, merged with Stats): one week at a time, newest first.
// The week card answers "did I hit it?": workouts against the weekly goal, the days trained, time,
// working sets, records and the muscles worked (every muscle one tap away); ‹ › or a swipe steps
// through weeks, and the last 12 weeks are bars you can tap. Then that week's workouts, body
// weight week by week, your most-done exercises, and every workout one tap away (#/gym/workouts).
const BARS = 12
const SWIPE_PX = 50
const MUSCLE_CHIPS = 4
const TRAINED = MUSCLES.filter((muscle) => muscle.id !== 'cardio')
const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))

const plural = (n, word) => `${formatNumber(n, 1)} ${word}${n === 1 ? '' : 's'}`
const sets = (n) => formatNumber(n, 1)

export default function ProgressTab({ today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const gym = useGym()
  const sessions = useGymSessions()
  const { firstWeekday, weeklyGoal: goal, e1rmFormula: formula, unit } = gym.prefs
  const lookup = useExerciseLookup(gym)
  const prsOf = usePrsOf(sessions, formula)
  const current = weekStart(today, firstWeekday)

  // Weeks back from this one (0 = this week), as far as the first workout.
  const [page, setPage] = useSessionState('gym.progress.week', 0)
  const [direction, setDirection] = useState(0) // the way the last week change went, for its slide
  const oldest = useMemo(() => sessions.reduce((min, session) => (session.date < min ? session.date : min), today), [sessions, today])
  const minPage = -Math.max(0, Math.round(diffDays(weekStart(oldest, firstWeekday), current) / 7))
  const shown = Math.min(0, Math.max(minPage, page))
  const from = addDaysISO(current, shown * 7)

  const week = useMemo(() => weekSummary(sessions, from, { lookup, formula }), [sessions, from, lookup, formula])
  const bars = useMemo(() => weeklyCounts(sessions, today, firstWeekday, BARS), [sessions, today, firstWeekday])
  const streak = useMemo(() => streakWeeks(sessions, today, firstWeekday), [sessions, today, firstWeekday])
  const allTime = useMemo(() => {
    let seconds = 0
    for (const session of sessions) seconds += Number(session.durationSec) > 0 ? Number(session.durationSec) : 0
    return { count: sessions.length, hours: seconds / 3600 }
  }, [sessions])

  if (!sessions.length) {
    const start = () => {
      const day = resolveDay(gym, sessions, today, today)
      beginWorkout({ routine: day.shown.kind === 'routine' ? day.routine : null, date: today, today })
    }
    return (
      <div className="gym-pg">
        <div className="card gym-pg-empty">
          <GymEmpty icon="chart" title="Your progress starts here" action={<Button icon="play" onClick={start}>Start a workout</Button>}>
            Finish a workout and each week shows up here: workouts against your goal, time, sets, records and the muscles you worked.
          </GymEmpty>
        </div>
        <BodyWeightCard today={today} unit={unit} firstWeekday={firstWeekday} />
        <ProgressPhotos today={today} unit={unit} />
      </div>
    )
  }

  const go = (to) => {
    const next = Math.min(0, Math.max(minPage, to))
    if (next !== shown) setDirection(next > shown ? 1 : -1)
    setPage(next)
  }

  return (
    <div className="gym-pg">
      <WeekCard
        week={week}
        gym={gym}
        today={today}
        goal={goal}
        streak={shown === 0 ? streak : null}
        title={weekLabel(from, today, firstWeekday)}
        canBack={shown > minPage}
        canForward={shown < 0}
        onStep={(step) => go(shown + step)}
        bars={bars}
        selected={from}
        onPick={(start) => go(Math.round(diffDays(current, start) / 7))}
        direction={direction}
      />

      <SectionHeader title={shown === 0 ? 'This week’s workouts' : 'Workouts that week'} />
      {week.sessions.length ? (
        <ul className="card-list gym-wr-list">
          {week.sessions.map((session) => (
            <WorkoutItem key={session.id} session={session} gym={gym} today={today} prCount={session.exercises.length ? prsOf(session).length : 0} />
          ))}
        </ul>
      ) : (
        <p className="gym-pg-none">{shown === 0 ? 'Nothing logged yet this week.' : 'No workouts that week.'}</p>
      )}

      <BodyWeightCard today={today} unit={unit} firstWeekday={firstWeekday} />
      <ProgressPhotos today={today} unit={unit} />

      <TopExercises sessions={sessions} gym={gym} today={today} />

      <ul className="card-list gym-br-links gym-pg-links">
        <li>
          <button type="button" className="gym-as-row" onClick={() => navigate('gym/workouts')}>
            <Icon name="history" size={20} />
            <span className="gym-as-label">
              All workouts
              <small>{plural(allTime.count, 'workout')}{allTime.hours >= 1 ? ` · ${formatNumber(allTime.hours, 0)} h trained` : ''} · search and export</small>
            </span>
            <Icon name="chevronRight" size={18} className="gym-br-chevron" />
          </button>
        </li>
      </ul>
    </div>
  )
}

// ---- the week ----------------------------------------------------------------------------------

function WeekCard({ week, gym, today, goal, streak, title, canBack, canForward, onStep, bars, selected, onPick, direction = 0 }) {
  const swipe = useRef(null)
  const done = week.count
  const met = done >= goal
  // The week's numbers count to their new values when the week changes.
  const shownDone = Math.round(useAnimatedNumber(done))
  const shownSets = Math.round(useAnimatedNumber(week.sets))
  const shownMinutes = Math.round(useAnimatedNumber(week.minutes))
  const range = `${formatDateShort(week.weekStart)} – ${formatDateShort(week.weekEnd)}`
  const muscles = Object.entries(week.muscles)
    .filter(([id, count]) => id !== 'cardio' && count > 0)
    .sort((a, b) => b[1] - a[1] || MUSCLE_LABEL[a[0]]?.localeCompare(MUSCLE_LABEL[b[0]]))

  let line
  if (streak !== null) line = met ? 'Goal reached this week' : `${goal - done} more to hit your goal`
  else line = met ? 'Goal reached' : done ? `${goal - done} short of your goal` : 'No workouts'

  const swipeHandlers = {
    onPointerDown(event) {
      if (event.pointerType === 'mouse') return
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    },
    onPointerUp(event) {
      const start = swipe.current
      swipe.current = null
      if (!start || start.id !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return
      if (dx > 0 && canBack) onStep(-1)
      else if (dx < 0 && canForward) onStep(1)
    },
    onPointerCancel() {
      swipe.current = null
    },
  }

  return (
    <section className="card gym-pg-week" aria-label={`${title}, ${range}`} {...swipeHandlers}>
      <div className="gym-pg-week-head">
        <button type="button" className="icon-btn" onClick={() => onStep(-1)} disabled={!canBack} aria-label="Previous week">
          <Icon name="chevronLeft" size={22} />
        </button>
        <div className="gym-pg-week-title" aria-live="polite">
          <h2>{title}</h2>
          <small>{range}</small>
        </div>
        <button type="button" className="icon-btn" onClick={() => onStep(1)} disabled={!canForward} aria-label="Next week">
          <Icon name="chevronRight" size={22} />
        </button>
      </div>

      <div key={week.weekStart} className={`gym-pg-week-body${direction > 0 ? ' from-next' : direction < 0 ? ' from-prev' : ''}`}>
        <div className="gym-pg-goal">
          <Ring value={done} shown={shownDone} goal={goal} />
          <div className="gym-pg-goal-text">
            <strong><span className="num-display">{shownDone}</span> of {goal} workouts</strong>
            <small>{line}</small>
            {streak > 0 && (
              <small className="gym-pg-streak"><Icon name="flame" size={14} strokeWidth={2.2} />{streak}-week streak</small>
            )}
          </div>
        </div>

        <Days week={week} gym={gym} today={today} />

        <dl className="gym-pg-nums">
          <div><dt>Time</dt><dd>{week.minutes ? formatMinutesText(Math.max(1, shownMinutes)) : '—'}</dd></div>
          <div><dt>Sets</dt><dd>{week.sets ? shownSets : '—'}</dd></div>
          <div><dt>Records</dt><dd>{week.prs ? <><Icon name="trophy" size={15} strokeWidth={2.2} />{week.prs}</> : '—'}</dd></div>
        </dl>

        {muscles.length > 0 && (
          <div className="gym-pg-muscles">
            <ul className="gym-pg-chips" aria-label="Muscles worked, sets">
              {muscles.slice(0, MUSCLE_CHIPS).map(([id, count]) => (
                <li key={id} className="chip chip-sm">{MUSCLE_LABEL[id] || id} <strong>{sets(count)}</strong></li>
              ))}
            </ul>
            <Disclosure id="gym-progress-muscles" label="Sets per muscle" className="gym-pg-disclosure">
              <MuscleTable muscles={week.muscles} />
            </Disclosure>
          </div>
        )}

      </div>

      <Bars bars={bars} goal={goal} selected={selected} today={today} onPick={onPick} />
    </section>
  )
}

function Ring({ value, shown = value, goal }) {
  const r = 30
  const c = 2 * Math.PI * r
  const pct = goal > 0 ? Math.min(1, value / goal) : 0
  return (
    <svg className={`gym-td-ring gym-pg-ring${pct >= 1 ? ' is-met' : ''}`} width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
      <circle className="gym-td-ring-track" cx="36" cy="36" r={r} />
      <circle className="gym-td-ring-value" cx="36" cy="36" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 36 36)" />
      {pct >= 1 ? <path className="gym-td-ring-check" d="m26 37 7 7 13-14" /> : <text x="36" y="42" textAnchor="middle" className="gym-pg-ring-num">{shown}</text>}
    </svg>
  )
}

// The week's seven days: a filled dot in the routine's colour on a day with a workout.
function Days({ week, gym, today }) {
  const byDate = new Map()
  for (const session of week.sessions) if (!byDate.has(session.date)) byDate.set(session.date, session)
  return (
    <ol className="gym-pg-days">
      {Array.from({ length: 7 }, (_, i) => {
        const date = addDaysISO(week.weekStart, i)
        const session = byDate.get(date)
        const routine = session ? routineById(gym, session.routineId) : null
        const label = `${relativeDay(date, today)}${session ? `: ${session.name?.trim() || 'Workout'}` : ''}`
        return (
          <li key={date} className={`${session ? 'is-done' : ''}${date === today ? ' is-today' : ''}${date > today ? ' is-future' : ''}`} title={label}>
            <span className="gym-pg-day-wd" aria-hidden="true">{WEEKDAY_SHORT[weekdayIndex(date)].charAt(0)}</span>
            <span className="gym-pg-day-dot" style={routine ? { '--dot': routineColor(routine) } : undefined}>
              {session && <Icon name="check" size={12} strokeWidth={3.2} />}
            </span>
            <span className="sr-only">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

// The last 12 weeks as bars (workouts each week); tap one to show that week. The dashed line is
// the weekly goal.
function Bars({ bars, goal, selected, today, onPick }) {
  const max = Math.max(goal, ...bars.map((bar) => bar.count), 1)
  return (
    <div className="gym-pg-bars-wrap">
      <ol className="gym-pg-bars" aria-label="Workouts per week, last 12 weeks">
        <span className="gym-pg-goal-line" style={{ bottom: `${(goal / max) * 100}%` }} aria-hidden="true" />
        {bars.map((bar) => {
          const label = `Week of ${formatDateShort(bar.weekStart)}: ${plural(bar.count, 'workout')}`
          return (
            <li key={bar.weekStart}>
              <button
                type="button"
                className={`gym-pg-bar${bar.weekStart === selected ? ' is-selected' : ''}${bar.count >= goal ? ' is-met' : ''}`}
                onClick={() => onPick(bar.weekStart)}
                aria-label={label}
                aria-pressed={bar.weekStart === selected}
              >
                <span style={{ height: `${Math.max(bar.count ? 6 : 2, (bar.count / max) * 100)}%` }} />
              </button>
            </li>
          )
        })}
      </ol>
      <div className="gym-pg-bars-axis" aria-hidden="true">
        <span>{formatDateShort(bars[0]?.weekStart || today)}</span>
        <span>This week</span>
      </div>
    </div>
  )
}

function MuscleTable({ muscles }) {
  const rows = TRAINED.map((muscle) => ({ ...muscle, sets: muscles[muscle.id] || 0 })).filter((row) => row.sets > 0).sort((a, b) => b.sets - a.sets)
  return (
    <>
      <table className="gym-st-table">
        <thead>
          <tr><th scope="col">Muscle</th><th scope="col" className="is-num">Sets</th><th scope="col"><span className="sr-only">Progress toward 10–20 sets</span></th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td className="is-num">{sets(row.sets)}</td>
              <td className="gym-st-meter-cell">
                <span className="gym-st-meter" aria-hidden="true">
                  <span className="gym-st-meter-band" />
                  <span className="gym-st-meter-fill" style={{ width: `${Math.min(100, (row.sets / 24) * 100)}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gym-st-note">A working set counts 1 for its main muscle and ½ for each muscle it also works. The shaded band is a common weekly target of 10–20 sets.</p>
    </>
  )
}

// ---- most-done exercises -----------------------------------------------------------------------

function TopExercises({ sessions, gym, today }) {
  const top = useMemo(() => topExercises(sessions, 5), [sessions])
  if (!top.length) return null
  return (
    <>
      <SectionHeader title="Your top exercises" action={<button type="button" className="link-btn" onClick={() => navigate('gym/exercises')}>All</button>} />
      <ol className="card-list gym-st-top">
        {top.map((item, i) => (
          <li key={item.exerciseId}>
            <button type="button" className="gym-st-top-row" onClick={() => navigate(`gym/exercise/${item.exerciseId}`)}>
              <span className="gym-st-rank" aria-hidden="true">{i + 1}</span>
              <span className="gym-st-top-text">
                <span>{exerciseById(item.exerciseId, gym.exercises)?.name || item.name || 'Exercise'}</span>
                <small>{plural(item.count, 'workout')}{item.lastDate ? ` · last ${relativeDay(item.lastDate, today).replace(/^(Today|Yesterday)$/, (word) => word.toLowerCase())}` : ''}</small>
              </span>
              <Icon name="chevronRight" size={16} className="gym-lib-chevron" />
            </button>
          </li>
        ))}
      </ol>
    </>
  )
}

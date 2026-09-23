import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { Button, IconButton, Segmented } from '../../components/ui/primitives.jsx'
import { addDaysISO, formatDateShort, isISODate, relativeDay } from '../../lib/dates.js'
import { MUSCLES, exerciseById } from '../../lib/gym/library.js'
import { addDays, weekStart } from '../../lib/gym/schedule.js'
import { addBodyWeight, deleteBodyWeight, useBodyWeights, useGym, useGymSessions } from '../../lib/gym/state.js'
import { sessionDurationSec, sessionVolume, streakWeeks, topExercises, weekProgress, weeklyCounts, weeklySetsByMuscle } from '../../lib/gym/stats.js'
import { formatNumber, formatVolume, fromKg } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { BarChart, LineChart } from './charts.jsx'
import { GymEmpty, SectionHeader, Stat, WeightInput, goBack } from './common.jsx'
import './exercises.css'

const TRAINED_MUSCLES = MUSCLES.filter((muscle) => muscle.id !== 'cardio')
const MUSCLE_WEEKS = 9
const BW_RANGES = [
  { id: '3m', label: '3M', days: 92 },
  { id: '1y', label: '1Y', days: 366 },
  { id: 'all', label: 'All', days: null },
]

let intFormat = null
const formatInt = (value) => {
  if (!intFormat) intFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  return intFormat.format(Math.round(value))
}
// "today", "yesterday", "Monday", "Sep 20": relative words mid-sentence, names as they are.
const inSentence = (date, today) => {
  const text = relativeDay(date, today)
  return ['Today', 'Yesterday', 'Tomorrow'].includes(text) ? text.toLowerCase() : text
}
const plural = (n, word) => `${formatNumber(n, 1)} ${word}${n === 1 ? '' : 's'}`

export default function StatsView({ today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const prefs = gym.prefs
  const unit = prefs.unit
  const firstWeekday = prefs.firstWeekday
  const customs = gym.exercises

  // Muscles always come from the library; bodyweight volume only when the setting is on.
  const lookup = useMemo(() => (id) => exerciseById(id, customs), [customs])
  const volumeLookup = useMemo(() => (prefs.bodyweightInVolume ? lookup : () => null), [prefs.bodyweightInVolume, lookup])

  const summary = useMemo(() => {
    const weeks = weeklyCounts(sessions, today, firstWeekday, 12, volumeLookup)
    const timed = weeks.reduce((sum, week) => sum + week.timed, 0)
    const minutes = weeks.reduce((sum, week) => sum + week.minutes, 0)
    const monthFrom = addDaysISO(today, -29)
    let volume30 = 0
    let totalSec = 0
    for (const session of sessions) {
      if (session.date >= monthFrom && session.date <= today) volume30 += sessionVolume(session, volumeLookup)
      totalSec += sessionDurationSec(session) || 0
    }
    return {
      weeks,
      avgMinutes: timed ? Math.round(minutes / timed) : null,
      volume30,
      totalHours: totalSec / 3600,
      thisWeek: weekProgress(sessions, today, firstWeekday),
      streak: streakWeeks(sessions, today, firstWeekday),
    }
  }, [sessions, today, firstWeekday, volumeLookup])

  const goal = prefs.weeklyGoal
  const hasSessions = sessions.length > 0

  return (
    <div className="gym-st">
      <div className="gym-xd-top">
        <button type="button" className="gym-xd-back" onClick={() => goBack('gym')}>
          <Icon name="chevronLeft" size={22} />
          Gym
        </button>
      </div>
      <header className="gym-st-head">
        <h1>Stats</h1>
        <p className="page-subtitle">Your training at a glance</p>
      </header>

      <div className="gym-stat-grid gym-st-tiles">
        <Stat label="Workouts" value={formatInt(sessions.length)} sub="all time" />
        <Stat
          label="This week"
          value={`${summary.thisWeek}/${goal}`}
          sub={summary.thisWeek >= goal ? 'Goal reached' : `${goal - summary.thisWeek} to go`}
        />
        <Stat label="Streak" value={`${summary.streak} wk`} sub={summary.streak === 1 ? 'week in a row' : 'weeks in a row'} />
        <Stat label="Avg duration" value={summary.avgMinutes === null ? '—' : `${summary.avgMinutes} min`} sub="last 12 weeks" />
        <Stat label="Volume" value={formatVolume(summary.volume30, unit)} sub="last 30 days" />
        <Stat label="Time trained" value={`${formatNumber(summary.totalHours, summary.totalHours < 10 ? 1 : 0)} h`} sub="all time" />
      </div>

      {!hasSessions ? (
        <div className="card gym-st-card">
          <GymEmpty icon="chart" title="Your charts start here" action={<Button onClick={() => navigate('gym')}>Go to today’s workout</Button>}>
            Finish a workout and your weekly workouts, volume and sets per muscle will show up here.
          </GymEmpty>
        </div>
      ) : (
        <>
          <SectionHeader title="Workouts per week" />
          <section className="card gym-st-card">
            <BarChart
              bars={summary.weeks.map((week) => ({
                key: week.weekStart,
                label: formatDateShort(week.weekStart),
                value: week.count,
                sub: week.minutes ? `${week.minutes} min` : undefined,
              }))}
              formatValue={(value) => plural(value, 'workout')}
              formatTick={(value) => formatNumber(value, 1)}
              height={170}
              ariaLabel="Workouts per week, last 12 weeks"
            />
            <p className="gym-st-note">Weeks start on {firstWeekday === 0 ? 'Sunday' : firstWeekday === 1 ? 'Monday' : 'your first weekday'}. Your goal is {plural(goal, 'workout')} a week.</p>
          </section>

          <SectionHeader title="Volume per week" />
          <section className="card gym-st-card">
            <BarChart
              bars={summary.weeks.map((week) => ({
                key: week.weekStart,
                label: formatDateShort(week.weekStart),
                value: fromKg(week.volumeKg, unit),
                sub: plural(week.count, 'workout'),
              }))}
              formatValue={(value) => `${formatInt(value)} ${unit}`}
              height={170}
              ariaLabel={`Volume per week in ${unit}, last 12 weeks`}
            />
            <p className="gym-st-note">Weight × reps of every working set; warm-ups don’t count.</p>
          </section>

          <MuscleSets sessions={sessions} today={today} firstWeekday={firstWeekday} lookup={lookup} />

          <TopExercises sessions={sessions} customs={customs} today={today} />
        </>
      )}

      <BodyWeight unit={unit} today={today} />
    </div>
  )
}

// ---- sets per muscle ------------------------------------------------------------------------

function MuscleSets({ sessions, today, firstWeekday, lookup }) {
  const weeks = useMemo(() => {
    const current = weekStart(today, firstWeekday)
    return Array.from({ length: MUSCLE_WEEKS }, (_, i) => {
      const start = addDays(current, -7 * (MUSCLE_WEEKS - 1 - i))
      return { start, sets: weeklySetsByMuscle(sessions, start, addDays(start, 6), lookup) }
    })
  }, [sessions, today, firstWeekday, lookup])

  const thisWeek = weeks[weeks.length - 1].sets
  const rows = useMemo(
    () => TRAINED_MUSCLES.map((muscle) => ({ ...muscle, sets: thisWeek[muscle.id] || 0 })).sort((a, b) => b.sets - a.sets || a.label.localeCompare(b.label)),
    [thisWeek],
  )
  const fallback = useMemo(() => {
    if (rows[0]?.sets > 0) return rows[0].id
    const totals = {}
    for (const week of weeks) for (const [id, sets] of Object.entries(week.sets)) totals[id] = (totals[id] || 0) + sets
    const top = Object.entries(totals).filter(([id]) => id !== 'cardio').sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : 'chest'
  }, [rows, weeks])
  const [picked, setPicked] = useState(null)
  const muscle = picked || fallback
  const label = TRAINED_MUSCLES.find((item) => item.id === muscle)?.label || 'Muscle'
  const chipsRef = useRef(null)

  // Keep the chosen muscle's chip in view (the row scrolls sideways).
  useEffect(() => {
    const row = chipsRef.current
    const chip = row?.querySelector('[aria-checked="true"]')
    if (!row || !chip) return
    const left = chip.offsetLeft
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth - 24) {
      row.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' })
    }
  }, [muscle])

  return (
    <>
      <SectionHeader title="Sets per muscle" />
      <section className="card gym-st-card">
        <div className="gym-st-chips" role="radiogroup" aria-label="Muscle" ref={chipsRef}>
          {TRAINED_MUSCLES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={muscle === item.id}
              className={`chip chip-sm${muscle === item.id ? ' is-active' : ''}`}
              onClick={() => setPicked(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <BarChart
          bars={weeks.map((week, i) => ({
            key: week.start,
            label: formatDateShort(week.start),
            value: week.sets[muscle] || 0,
            sub: i === weeks.length - 1 ? 'this week' : undefined,
          }))}
          formatValue={(value) => plural(value, 'set')}
          formatTick={(value) => formatNumber(value, 1)}
          band={[10, 20]}
          bandLabel="10–20 sets"
          height={170}
          ariaLabel={`Weekly sets for ${label}, this week and the previous 8`}
        />
        <p className="gym-st-note">Completed working sets: 1 for the main muscle, ½ for each muscle it also works. The shaded band is a common target of 10–20 sets a week.</p>
      </section>

      <section className="card gym-st-card gym-st-muscles" aria-labelledby="gym-st-muscles-title">
        <h3 id="gym-st-muscles-title" className="gym-st-card-title">This week</h3>
        <table className="gym-st-table">
          <thead>
            <tr><th scope="col">Muscle</th><th scope="col" className="is-num">Sets</th><th scope="col"><span className="sr-only">Progress toward 10–20 sets</span></th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`${row.sets ? '' : 'is-zero'}${row.id === muscle ? ' is-current' : ''}`}>
                <th scope="row">
                  <button type="button" className="gym-st-muscle" onClick={() => setPicked(row.id)} aria-pressed={row.id === muscle}>{row.label}</button>
                </th>
                <td className="is-num">{formatNumber(row.sets, 1)}</td>
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
      </section>
    </>
  )
}

// ---- top exercises --------------------------------------------------------------------------

function TopExercises({ sessions, customs, today }) {
  const top = useMemo(() => topExercises(sessions, 5), [sessions])
  if (!top.length) return null
  return (
    <>
      <SectionHeader title="Top exercises" />
      <ol className="card-list gym-st-top">
        {top.map((item, i) => {
          const entry = exerciseById(item.exerciseId, customs)
          return (
            <li key={item.exerciseId}>
              <button type="button" className="gym-st-top-row" onClick={() => navigate(`gym/exercise/${item.exerciseId}`)}>
                <span className="gym-st-rank" aria-hidden="true">{i + 1}</span>
                <span className="gym-st-top-text">
                  <span>{entry?.name || item.name || 'Exercise'}</span>
                  <small>{plural(item.count, 'workout')}{item.lastDate ? ` · last ${inSentence(item.lastDate, today)}` : ''}</small>
                </span>
                <Icon name="chevronRight" size={16} className="gym-lib-chevron" />
              </button>
            </li>
          )
        })}
      </ol>
    </>
  )
}

// ---- body weight ----------------------------------------------------------------------------

function BodyWeight({ unit, today }) {
  const entries = useBodyWeights()
  const weight = (kg) => `${formatNumber(fromKg(kg, unit), 1)} ${unit}`
  const [date, setDate] = useState(today)
  const [kg, setKg] = useState(null)
  const [range, setRange] = useState('3m')
  const [showAll, setShowAll] = useState(false)

  const latest = entries[0] || null
  const days = BW_RANGES.find((item) => item.id === range)?.days
  const from = days ? addDaysISO(today, -days) : null
  const points = useMemo(
    () => entries.filter((entry) => !from || entry.date >= from).slice().reverse().map((entry) => ({ x: entry.date, y: fromKg(entry.kg, unit) })),
    [entries, from, unit],
  )

  // Change over roughly the last 30 days: latest vs the newest entry at least 30 days older.
  const trend = useMemo(() => {
    if (!latest) return null
    const cutoff = addDaysISO(latest.date, -30)
    const older = entries.find((entry) => entry.date <= cutoff)
    return older ? { delta: latest.kg - older.kg, since: older.date } : null
  }, [entries, latest])

  const add = (event) => {
    event.preventDefault()
    if (!isISODate(date) || date > today) {
      toast('Pick a date up to today.', { tone: 'error' })
      return
    }
    if (!(typeof kg === 'number' && kg > 0)) {
      toast('Enter your body weight first.', { tone: 'error' })
      return
    }
    try {
      addBodyWeight(date, kg)
      toast(`Saved ${weight(kg)} for ${inSentence(date, today)}`, { tone: 'success' })
      setKg(null)
      setDate(today)
    } catch (err) {
      toast(err?.message || 'Could not save that weight.', { tone: 'error' })
    }
  }

  const remove = (entry) => {
    const undo = deleteBodyWeight(entry.id)
    toast(`Removed ${weight(entry.kg)} from ${formatDateShort(entry.date)}`, { action: { label: 'Undo', onClick: undo } })
  }

  const list = showAll ? entries : entries.slice(0, 7)

  return (
    <>
      <SectionHeader
        title="Body weight"
        action={points.length >= 2 ? <Segmented options={BW_RANGES} value={range} onChange={setRange} label="Body weight range" size="sm" className="gym-st-range" /> : null}
      />
      <section className="card gym-st-card">
        {latest && (
          <div className="gym-st-bw-now">
            <strong>{weight(latest.kg)}</strong>
            <span>
              {relativeDay(latest.date, today)}
              {trend && Math.abs(trend.delta) > 1e-9 && ` · ${trend.delta > 0 ? '+' : '−'}${weight(Math.abs(trend.delta))} since ${formatDateShort(trend.since)}`}
            </span>
          </div>
        )}
        {entries.length === 1 && <p className="gym-st-note gym-st-bw-first">Log another weigh-in to start your trend line.</p>}
        {entries.length > 1 && (
          <LineChart
            points={points}
            formatY={(value) => `${formatNumber(value, 1)} ${unit}`}
            formatTick={(value) => formatNumber(value, 1)}
            height={180}
            ariaLabel={`Body weight in ${unit}`}
            emptyText="Only one weigh-in in this range. Try a longer range."
          />
        )}

        <form className="gym-st-bw-form" onSubmit={add}>
          <label className="gym-st-bw-field">
            <span className="gym-st-bw-label">Date</span>
            <input type="date" className="input" value={date} max={today} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="gym-st-bw-field">
            <span className="gym-st-bw-label">Weight ({unit})</span>
            <WeightInput
              valueKg={kg}
              unit={unit}
              onChange={setKg}
              placeholder={latest ? latest.kg : undefined}
              ariaLabel={`Body weight in ${unit}`}
              className="gym-st-bw-input"
            />
          </label>
          <Button type="submit" icon="plus" className="gym-st-bw-add">Log</Button>
        </form>
        <p className="gym-st-note">Your latest weight on or before a workout is used for bodyweight exercise volume. Logging a date again replaces that day.</p>

        {entries.length > 0 && (
          <ul className="gym-st-bw-list">
            {list.map((entry, i) => {
              const previous = entries[i + 1]
              const delta = previous ? entry.kg - previous.kg : null
              return (
                <li key={entry.id}>
                  <span className="gym-st-bw-date">{relativeDay(entry.date, today)}{relativeDay(entry.date, today) !== formatDateShort(entry.date) ? ` · ${formatDateShort(entry.date)}` : ''}</span>
                  <strong>{weight(entry.kg)}</strong>
                  <span className="gym-st-bw-delta">
                    {delta === null || Math.abs(delta) < 1e-9 ? '' : `${delta > 0 ? '+' : '−'}${formatNumber(Math.abs(fromKg(delta, unit)), 1)}`}
                  </span>
                  <IconButton icon="trash" label={`Delete ${weight(entry.kg)} on ${formatDateShort(entry.date)}`} size={17} className="gym-st-bw-delete" onClick={() => remove(entry)} />
                </li>
              )
            })}
          </ul>
        )}
        {entries.length > 7 && (
          <button type="button" className="link-btn gym-st-more" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Show fewer' : `Show all ${entries.length} entries`}
          </button>
        )}
      </section>
    </>
  )
}

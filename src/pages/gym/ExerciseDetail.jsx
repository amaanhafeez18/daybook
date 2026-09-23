import { useEffect, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { AutoTextarea, Button, IconButton, Segmented } from '../../components/ui/primitives.jsx'
import { addDaysISO, formatDateShort, relativeDay } from '../../lib/dates.js'
import { exerciseById } from '../../lib/gym/library.js'
import { deleteCustomExercise, getGym, setExerciseMeta, useGym, useGymSessions } from '../../lib/gym/state.js'
import { bestSet, computeRecords, e1rm, exerciseHistory, increment, isWorking, projectedWeight } from '../../lib/gym/stats.js'
import { formatDistance, formatDuration, formatNumber, formatPace, formatWeight, fromKg, fromMeters, toKg } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { LineChart } from './charts.jsx'
import { GymEmpty, SetTypeBadge, goBack } from './common.jsx'
import CustomExerciseSheet, { CATEGORY_OPTIONS, restChoices, restText, trackingName } from './CustomExerciseSheet.jsx'
import { equipmentLabel, muscleLabel } from './ExercisePicker.jsx'
import ToolsSheet from './ToolsSheet.jsx'
import './exercises.css'

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const pos = (value) => (isNum(value) && value > 0 ? value : null)
const WEIGHTED = new Set(['weight_reps', 'weighted_bodyweight'])
// Estimates (e1RM, projections) read better with one decimal.
const estimate = (kg, unit) => `${formatNumber(fromKg(kg, unit), 1)} ${unit}`

let intFormat = null
const formatInt = (value) => {
  if (!intFormat) intFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  return intFormat.format(Math.round(value))
}

// ---- set text ---------------------------------------------------------------------------------

// "60 kg × 8", "+20 kg × 6", "12 reps", "1:30", "5 km · 25:00", with " @ 8" for RPE.
export function setText(set, tracking, unit, distanceUnit) {
  const w = isNum(set.weightKg) ? set.weightKg : null
  const r = isNum(set.reps) ? set.reps : null
  const d = isNum(set.durationSec) ? set.durationSec : null
  const m = isNum(set.distanceM) ? set.distanceM : null
  const weight = (kg) => formatWeight(kg, unit)
  const reps = r === null ? '—' : String(r)
  const shortDistance = distanceUnit === 'mi' ? 'yd' : 'm'
  const join = (...parts) => parts.filter(Boolean).join(' · ') || '—'
  let text
  switch (tracking) {
    case 'bodyweight_reps':
    case 'reps_only':
      text = r === null ? '—' : `${r} rep${r === 1 ? '' : 's'}`
      break
    case 'weighted_bodyweight':
      text = `${w ? `+${weight(w)}` : 'Bodyweight'} × ${reps}`
      break
    case 'assisted_bodyweight':
      text = `${w ? `−${weight(w)}` : 'Bodyweight'} × ${reps}`
      break
    case 'duration':
      text = d === null ? '—' : formatDuration(d)
      break
    case 'weight_duration':
      text = join(w !== null ? weight(w) : null, d !== null ? formatDuration(d) : null)
      break
    case 'distance_duration':
      text = join(m !== null ? formatDistance(m, distanceUnit) : null, d !== null ? formatDuration(d) : null)
      break
    case 'weight_distance':
      text = join(w !== null ? weight(w) : null, m !== null ? formatDistance(m, shortDistance) : null)
      break
    default:
      text = `${w === null ? '—' : weight(w)} × ${reps}`
  }
  if (isNum(set.rpe)) text += ` @ ${formatNumber(set.rpe, 1)}`
  return text
}

// ---- chart metrics ----------------------------------------------------------------------------

const METRICS = {
  e1rm: { label: 'e1RM', title: 'Estimated 1RM', kind: 'weight' },
  heaviest: { label: 'Heaviest', title: 'Heaviest weight', kind: 'weight' },
  added: { label: 'Added weight', title: 'Heaviest added weight', kind: 'weight' },
  setVolume: { label: 'Best set', title: 'Best set volume', kind: 'volume' },
  sessionVolume: { label: 'Volume', title: 'Session volume', kind: 'volume' },
  totalReps: { label: 'Total reps', title: 'Total reps', kind: 'reps' },
  maxReps: { label: 'Max reps', title: 'Most reps in a set', kind: 'reps' },
  longest: { label: 'Longest', title: 'Longest duration', kind: 'duration' },
  totalDuration: { label: 'Duration', title: 'Total duration', kind: 'duration' },
  distance: { label: 'Distance', title: 'Total distance', kind: 'distance' },
  pace: { label: 'Pace', title: 'Best pace', kind: 'pace' },
}
const METRICS_BY_TRACKING = {
  weight_reps: ['e1rm', 'heaviest', 'setVolume', 'sessionVolume', 'totalReps'],
  weighted_bodyweight: ['added', 'maxReps', 'totalReps'],
  assisted_bodyweight: ['maxReps', 'totalReps'],
  bodyweight_reps: ['maxReps', 'totalReps'],
  reps_only: ['maxReps', 'totalReps'],
  duration: ['longest'],
  weight_duration: ['heaviest', 'longest'],
  distance_duration: ['distance', 'pace', 'totalDuration'],
  weight_distance: ['heaviest', 'distance'],
}
const SUMS = new Set(['sessionVolume', 'totalReps', 'totalDuration', 'distance'])
const RANGES = [
  { id: '1m', label: '1M', days: 31 },
  { id: '3m', label: '3M', days: 92 },
  { id: '1y', label: '1Y', days: 366 },
  { id: 'all', label: 'All', days: null },
]

// One value per session from its working sets (kg, reps, seconds, metres or s/km); null = none.
function metricValue(metric, sets, formula) {
  let best = null
  let sum = 0
  let any = false
  const take = (value, lower = false) => {
    if (value === null || !isNum(value)) return
    if (best === null || (lower ? value < best : value > best)) best = value
  }
  const add = (value) => {
    sum += value
    any = true
  }
  for (const set of sets) {
    if (!isWorking(set)) continue
    const w = pos(set.weightKg)
    const r = pos(set.reps)
    const d = pos(set.durationSec)
    const m = pos(set.distanceM)
    switch (metric) {
      case 'e1rm': if (w && r) take(e1rm(w, r, formula)); break
      case 'heaviest': case 'added': if (w) take(w); break
      case 'setVolume': if (w && r) take(w * r); break
      case 'sessionVolume': if (w && r) add(w * r); break
      case 'totalReps': if (r) add(r); break
      case 'maxReps': if (r) take(r); break
      case 'longest': if (d) take(d); break
      case 'totalDuration': if (d) add(d); break
      case 'distance': if (m) add(m); break
      case 'pace': if (d && m) take(d / (m / 1000), true); break
      default: break
    }
  }
  return SUMS.has(metric) ? (any ? sum : null) : best
}

// Display conversion and formatting per value kind.
function kindFormat(kind, unit, distanceUnit) {
  const du = distanceUnit === 'mi' ? 'mi' : 'km'
  switch (kind) {
    case 'weight': return { toY: (v) => fromKg(v, unit), formatY: (y) => `${formatNumber(y, 1)} ${unit}`, formatTick: (y) => formatNumber(y, 1) }
    case 'volume': return { toY: (v) => fromKg(v, unit), formatY: (y) => `${formatInt(y)} ${unit}` }
    case 'reps': return { toY: (v) => v, formatY: (y) => `${formatNumber(y, 1)} reps`, formatTick: (y) => formatNumber(y, 1) }
    case 'duration': return { toY: (v) => v, formatY: (y) => formatDuration(y), formatTick: (y) => formatDuration(y) }
    case 'distance': return { toY: (v) => fromMeters(v, du), formatY: (y) => `${formatNumber(y, 2)} ${du}`, formatTick: (y) => formatNumber(y, 2) }
    case 'pace': return {
      toY: (v) => (du === 'mi' ? v * 1.609344 : v),
      formatY: (y) => `${formatDuration(y)} /${du}`,
      formatTick: (y) => formatDuration(y),
    }
    default: return { toY: (v) => v, formatY: (y) => formatNumber(y, 2) }
  }
}

// ---- page -------------------------------------------------------------------------------------

const TABS = [
  { id: 'history', label: 'History' },
  { id: 'chart', label: 'Chart' },
  { id: 'records', label: 'Records' },
]
let lastTab = 'history'

export default function ExerciseDetail({ param, today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const exerciseId = typeof param === 'string' ? param : ''
  const [tab, setTab] = useState(lastTab)
  const [editing, setEditing] = useState(false)
  const [tools, setTools] = useState(false)

  useEffect(() => {
    lastTab = tab
  }, [tab])

  // Sessions containing it (newest first), several entries of the same exercise merged.
  const history = useMemo(() => {
    const out = []
    const bySession = new Map()
    for (const { session, exercise } of exerciseHistory(sessions, exerciseId)) {
      let item = bySession.get(session.id)
      if (!item) {
        item = { session, entries: [], sets: [] }
        bySession.set(session.id, item)
        out.push(item)
      }
      item.entries.push(exercise)
      item.sets.push(...(Array.isArray(exercise.sets) ? exercise.sets.filter((set) => set && typeof set === 'object') : []))
    }
    return out
  }, [sessions, exerciseId])

  // Library or custom entry; a stray id that only exists in history uses the logged snapshot.
  const exercise = useMemo(() => {
    const entry = exerciseById(exerciseId, gym.exercises)
    if (entry) return entry
    const snapshot = history[0]?.entries[0]
    return snapshot ? { id: exerciseId, name: snapshot.name || 'Exercise', tracking: snapshot.tracking || 'weight_reps', primary: null, secondary: [], equipment: null, category: null, rest: snapshot.restSec ?? 120, missing: true } : null
  }, [exerciseId, gym.exercises, history])

  if (!exercise) {
    return (
      <div className="gym-xd">
        <DetailTop />
        <GymEmpty icon="dumbbell" title="Exercise not found" action={<Button onClick={() => navigate('gym/exercises')}>Browse exercises</Button>}>
          It may have been deleted, or the link is out of date.
        </GymEmpty>
      </div>
    )
  }

  const tracking = exercise.tracking || history[0]?.entries[0]?.tracking || 'weight_reps'
  const meta = gym.exerciseMeta[exercise.id] || {}
  const prefs = gym.prefs
  const barbell = exercise.equipment === 'barbell' || exercise.equipment === 'smith_machine'

  return (
    <div className="gym-xd">
      <DetailTop>
        {WEIGHTED.has(tracking) && (
          <IconButton icon="calculator" label="Calculators" className="gym-xd-action" onClick={() => setTools(true)} />
        )}
        {exercise.custom && !exercise.missing && (
          <IconButton icon="pencil" label="Edit exercise" className="gym-xd-action" onClick={() => setEditing(true)} />
        )}
      </DetailTop>

      <header className="gym-xd-head">
        <h1 className="gym-xd-title">{exercise.name}</h1>
        {exercise.primary && (
          <p className="gym-xd-muscles">
            <strong>{muscleLabel(exercise.primary)}</strong>
            {Array.isArray(exercise.secondary) && exercise.secondary.length > 0 && (
              <span> · also {exercise.secondary.map(muscleLabel).join(', ')}</span>
            )}
          </p>
        )}
        <div className="gym-xd-tags">
          {exercise.equipment && <span className="meta-chip">{equipmentLabel(exercise.equipment)}</span>}
          <span className="meta-chip">{trackingName(tracking)}</span>
          {exercise.category && <span className="meta-chip">{CATEGORY_OPTIONS.find((item) => item.id === exercise.category)?.label || exercise.category}</span>}
          {exercise.custom && <span className="meta-chip is-accent">Custom</span>}
          {exercise.hidden && <span className="meta-chip">Hidden from list</span>}
        </div>
      </header>

      <Facts history={history} exercise={exercise} tracking={tracking} sessions={sessions} prefs={prefs} today={today} />

      {!exercise.missing && <PinnedNote exerciseId={exercise.id} note={typeof meta.note === 'string' ? meta.note : ''} />}

      <Segmented options={TABS} value={tab} onChange={setTab} label="Exercise view" className="gym-xd-tabs" />

      {tab === 'history' && <HistoryList history={history} tracking={tracking} prefs={prefs} today={today} />}
      {tab === 'chart' && <ChartPanel history={history} tracking={tracking} prefs={prefs} today={today} />}
      {tab === 'records' && <RecordsPanel sessions={sessions} exerciseId={exercise.id} tracking={tracking} prefs={prefs} hasHistory={history.length > 0} />}

      {!exercise.missing && <ExerciseSettings exercise={exercise} tracking={tracking} meta={meta} unit={prefs.unit} />}

      {exercise.custom && !exercise.missing && <DeleteCustom exercise={exercise} used={history.length > 0} />}

      {exercise.custom && (
        <CustomExerciseSheet open={editing} onClose={() => setEditing(false)} exercise={exercise} />
      )}
      <ToolsSheet
        open={tools}
        onClose={() => setTools(false)}
        initialTab={barbell ? 'plates' : '1rm'}
        initialKg={lastTopWeight(history)}
        exercise={exercise}
      />
    </div>
  )
}

function lastTopWeight(history) {
  for (const item of history) {
    const top = Math.max(0, ...item.sets.filter(isWorking).map((set) => (isNum(set.weightKg) ? set.weightKg : 0)))
    if (top > 0) return top
  }
  return undefined
}

function DetailTop({ children }) {
  return (
    <div className="gym-xd-top">
      <button type="button" className="gym-xd-back" onClick={() => goBack('gym/exercises')}>
        <Icon name="chevronLeft" size={22} />
        Exercises
      </button>
      {children && <div className="gym-xd-actions">{children}</div>}
    </div>
  )
}

// Workouts, last done and the headline record, in a compact strip.
function Facts({ history, exercise, tracking, sessions, prefs, today }) {
  const records = useMemo(
    () => computeRecords(sessions, exercise.id, tracking, prefs.e1rmFormula),
    [sessions, exercise.id, tracking, prefs.e1rmFormula],
  )
  if (!history.length) {
    return <p className="gym-xd-first">You haven’t logged this yet. Add it to a routine or a workout and your history, chart and records show up here.</p>
  }
  const unit = prefs.unit
  let best = null
  if (records.e1rm) best = { label: 'Best e1RM', value: estimate(records.e1rm.value, unit) }
  else if (records.heaviest) best = { label: tracking === 'weighted_bodyweight' ? 'Most added' : 'Heaviest', value: formatWeight(records.heaviest.value, unit) }
  else if (records.mostReps) best = { label: 'Most reps', value: String(records.mostReps.value) }
  else if (records.longestDistance) best = { label: 'Longest', value: formatDistance(records.longestDistance.value, prefs.distanceUnit) }
  else if (records.longestDuration) best = { label: 'Longest', value: formatDuration(records.longestDuration.value) }
  const last = history[0].session.date
  return (
    <dl className="gym-xd-facts">
      <div><dt>Workouts</dt><dd>{history.length}</dd></div>
      <div><dt>Last done</dt><dd>{relativeDay(last, today)}</dd></div>
      {best && <div><dt>{best.label}</dt><dd>{best.value}</dd></div>}
    </dl>
  )
}

// ---- pinned note ------------------------------------------------------------------------------

function PinnedNote({ exerciseId, note }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note)

  useEffect(() => {
    if (!editing) setDraft(note)
  }, [note, editing])

  const save = () => {
    setExerciseMeta(exerciseId, { note: draft.trim() })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="gym-note is-editing">
        <label className="gym-note-label" htmlFor={`gym-note-${exerciseId}`}><Icon name="pin" size={15} /> Pinned note</label>
        <AutoTextarea
          id={`gym-note-${exerciseId}`}
          className="gym-note-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Form cues, seat height, grip…"
          minRows={2}
          maxRows={8}
          maxLength={500}
          autoFocus
        />
        <div className="gym-note-actions">
          {note && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setExerciseMeta(exerciseId, { note: '' }); setEditing(false) }}>Remove</button>
          )}
          <span className="gym-note-spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDraft(note); setEditing(false) }}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button>
        </div>
      </div>
    )
  }

  if (!note) {
    return (
      <button type="button" className="gym-note-add" onClick={() => setEditing(true)}>
        <Icon name="pin" size={16} />
        <span>Add a pinned note <small>Shows every time you log this exercise</small></span>
      </button>
    )
  }

  return (
    <button type="button" className="gym-note" onClick={() => setEditing(true)} aria-label={`Pinned note: ${note}. Tap to edit.`}>
      <span className="gym-note-label"><Icon name="pin" size={15} /> Pinned note</span>
      <span className="gym-note-text">{note}</span>
      <Icon name="pencil" size={15} className="gym-note-edit" />
    </button>
  )
}

// ---- history ----------------------------------------------------------------------------------

const PAGE = 20

function HistoryList({ history, tracking, prefs, today }) {
  const [shown, setShown] = useState(PAGE)
  if (!history.length) {
    return (
      <GymEmpty icon="history" title="No history yet" action={<Button variant="secondary" onClick={() => navigate('gym')}>Go to today’s workout</Button>}>
        Every workout that includes this exercise will be listed here with its sets.
      </GymEmpty>
    )
  }
  const unit = prefs.unit
  return (
    <>
      <ul className="gym-xd-history">
        {history.slice(0, shown).map(({ session, entries, sets }) => {
          const top = bestSet({ tracking, sets }, prefs.e1rmFormula)
          const notes = entries.map((entry) => (typeof entry.note === 'string' ? entry.note.trim() : '')).filter(Boolean)
          let normal = 0
          return (
            <li key={session.id}>
              <a className="gym-xd-session" href={`#/gym/session/${session.id}`}>
                <span className="gym-xd-session-head">
                  <span className="gym-xd-session-name">{session.name || 'Workout'}</span>
                  <time dateTime={session.date}>{relativeDay(session.date, today)}{relativeDay(session.date, today) !== formatDateShort(session.date) ? ` · ${formatDateShort(session.date)}` : ''}</time>
                  <Icon name="chevronRight" size={16} className="gym-xd-session-chevron" />
                </span>
                <ol className="gym-xd-sets">
                  {sets.filter((set) => set.done !== false).map((set, i) => {
                    if (!set.type || set.type === 'normal') normal += 1
                    const isTop = set === top
                    const est = tracking === 'weight_reps' && isWorking(set) ? e1rm(set.weightKg, set.reps, prefs.e1rmFormula) : null
                    return (
                      <li key={set.id || i} className={isTop ? 'is-top' : ''}>
                        <SetTypeBadge type={set.type} number={!set.type || set.type === 'normal' ? normal : undefined} />
                        <span className="gym-xd-set-text">{setText(set, tracking, unit, prefs.distanceUnit)}</span>
                        {isTop && <span className="gym-xd-top-tag">Best</span>}
                        {est !== null && <span className="gym-xd-set-est">{formatNumber(fromKg(est, unit), 1)}</span>}
                      </li>
                    )
                  })}
                </ol>
                {notes.length > 0 && <span className="gym-xd-session-note">{notes.join(' · ')}</span>}
              </a>
            </li>
          )
        })}
      </ul>
      {tracking === 'weight_reps' && <p className="gym-xd-footnote">Numbers on the right are each set’s estimated 1RM in {unit}.</p>}
      {history.length > shown && (
        <Button variant="secondary" className="btn-block gym-xd-more" onClick={() => setShown((count) => count + PAGE)}>
          Show more ({history.length - shown} older)
        </Button>
      )}
    </>
  )
}

// ---- chart ------------------------------------------------------------------------------------

let lastMetric = {}
let lastRange = '3m'

function ChartPanel({ history, tracking, prefs, today }) {
  const options = METRICS_BY_TRACKING[tracking] || METRICS_BY_TRACKING.weight_reps
  const [metric, setMetric] = useState(() => (options.includes(lastMetric[tracking]) ? lastMetric[tracking] : options[0]))
  const [range, setRange] = useState(lastRange)

  useEffect(() => {
    lastMetric = { ...lastMetric, [tracking]: metric }
    lastRange = range
  }, [metric, range, tracking])

  const format = kindFormat(METRICS[metric].kind, prefs.unit, prefs.distanceUnit)
  const from = RANGES.find((item) => item.id === range)?.days ? addDaysISO(today, -RANGES.find((item) => item.id === range).days) : null

  const points = useMemo(() => {
    const out = []
    for (let i = history.length - 1; i >= 0; i--) {
      const { session, sets } = history[i]
      if (from && session.date < from) continue
      const value = metricValue(metric, sets, prefs.e1rmFormula)
      if (value === null) continue
      out.push({
        x: session.date,
        y: format.toY(value),
        label: session.name || 'Workout',
        onClick: () => navigate(`gym/session/${session.id}`),
      })
    }
    return out
  }, [history, metric, from, prefs.e1rmFormula, prefs.unit, prefs.distanceUnit]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!history.length) {
    return (
      <GymEmpty icon="chart" title="Nothing to chart yet">
        Log this exercise in two or more workouts to see your progress over time.
      </GymEmpty>
    )
  }

  const olderExist = from && points.length < 2 && history.some(({ session }) => session.date < from)
  const lower = metric === 'pace'
  let change = null
  if (points.length >= 2) {
    const delta = points[points.length - 1].y - points[0].y
    const values = points.map((point) => point.y)
    const bestY = lower ? Math.min(...values) : Math.max(...values)
    change = { delta, best: bestY, since: points[0].x }
  }
  const deltaText = (delta) => {
    if (Math.abs(delta) < 1e-9) return 'No change'
    const sign = delta > 0 ? '+' : '−'
    return `${sign}${format.formatY(Math.abs(delta))}`
  }

  return (
    <section className="card gym-xd-chart" aria-label={METRICS[metric].title}>
      <div className="gym-xd-metrics" role="radiogroup" aria-label="Metric">
        {options.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={metric === id} className={`chip chip-sm${metric === id ? ' is-active' : ''}`} onClick={() => setMetric(id)}>
            {METRICS[id].label}
          </button>
        ))}
      </div>
      <div className="gym-xd-chart-head">
        <div>
          <span className="gym-xd-chart-title">{METRICS[metric].title}</span>
          {change && (
            <span className="gym-xd-chart-change">
              <strong>{deltaText(change.delta)}</strong> since {formatDateShort(change.since)} · {lower ? 'best' : 'peak'} {format.formatY(change.best)}
            </span>
          )}
        </div>
        <Segmented options={RANGES} value={range} onChange={setRange} label="Time range" size="sm" className="gym-xd-range" />
      </div>
      <LineChart
        points={points}
        formatY={format.formatY}
        formatTick={format.formatTick}
        height={200}
        ariaLabel={`${METRICS[metric].title} per workout`}
        actionLabel="View workout"
        timeAxis={METRICS[metric].kind === 'duration' || METRICS[metric].kind === 'pace'}
        emptyText={olderExist ? 'Only one workout in this range. Try a longer range.' : 'Log 2+ workouts to see a trend'}
      />
    </section>
  )
}

// ---- records ----------------------------------------------------------------------------------

function RecordsPanel({ sessions, exerciseId, tracking, prefs, hasHistory }) {
  const records = useMemo(
    () => computeRecords(sessions, exerciseId, tracking, prefs.e1rmFormula),
    [sessions, exerciseId, tracking, prefs.e1rmFormula],
  )
  if (!hasHistory) {
    return (
      <GymEmpty icon="trophy" title="No records yet">
        Your first workout with this exercise sets the baseline. Beat it next time for a PR.
      </GymEmpty>
    )
  }
  const unit = prefs.unit
  const du = prefs.distanceUnit
  const rows = [
    ['heaviest', tracking === 'weighted_bodyweight' ? 'Heaviest added weight' : 'Heaviest weight', (v) => formatWeight(v, unit)],
    ['e1rm', 'Best estimated 1RM', (v) => estimate(v, unit)],
    ['setVolume', 'Best set volume', (v) => `${formatInt(fromKg(v, unit))} ${unit}`],
    ['sessionVolume', 'Best workout volume', (v) => `${formatInt(fromKg(v, unit))} ${unit}`],
    ['mostReps', 'Most reps in a set', (v) => `${v} reps`],
    ['sessionReps', 'Most reps in a workout', (v) => `${v} reps`],
    ['longestDuration', 'Longest set', (v) => formatDuration(v)],
    ['longestDistance', 'Longest distance', (v) => formatDistance(v, tracking === 'weight_distance' ? (du === 'mi' ? 'yd' : 'm') : du)],
    ['bestPace', 'Best pace (400 m+)', (v) => formatPace(v, du)],
  ].filter(([key]) => records[key])

  const open = (record) => {
    if (record?.sessionId) navigate(`gym/session/${record.sessionId}`)
  }

  return (
    <div className="gym-xd-records">
      {records.e1rm && (
        <div className="card gym-xd-onerm">
          <span className="gym-xd-onerm-label">Estimated one-rep max</span>
          <strong>{estimate(records.e1rm.value, unit)}</strong>
          <span className="gym-xd-onerm-sub">From your best set · {formatDateShort(records.e1rm.date)}</span>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="card-list gym-xd-record-list">
          {rows.map(([key, label, format]) => (
            <li key={key}>
              <button type="button" className="gym-xd-record" onClick={() => open(records[key])}>
                <span className="gym-xd-record-icon"><Icon name="trophy" size={16} /></span>
                <span className="gym-xd-record-text">
                  <span>{label}</span>
                  <small>{formatDateShort(records[key].date)}</small>
                </span>
                <strong>{format(records[key].value)}</strong>
                <Icon name="chevronRight" size={16} className="gym-lib-chevron" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {tracking === 'weight_reps' && <RepMaxTable records={records} unit={unit} onOpen={open} />}
      {tracking === 'weighted_bodyweight' && <LoggedRepMax title="Best added weight by reps" table={records.repMax} unit={unit} sign="+" onOpen={open} />}
      {tracking === 'assisted_bodyweight' && <LoggedRepMax title="Least assistance by reps" table={records.leastAssist} unit={unit} sign="−" onOpen={open} />}
    </div>
  )
}

// 1–12 reps: the logged best, or the Brzycki projection from the best e1RM when that's higher.
function RepMaxTable({ records, unit, onOpen }) {
  const oneRm = records.e1rm?.value ?? null
  const rows = Array.from({ length: 12 }, (_, i) => {
    const reps = i + 1
    const actual = records.repMax?.[reps] || null
    const projected = oneRm ? projectedWeight(oneRm, reps) : null
    const useActual = actual && (projected === null || actual.value >= projected - 1e-6)
    return { reps, actual, projected, useActual }
  }).filter((row) => row.actual || row.projected)
  if (!rows.length) return null
  return (
    <section className="card gym-xd-repmax" aria-labelledby="gym-xd-repmax-title">
      <h2 id="gym-xd-repmax-title" className="gym-xd-card-title">Rep maxes</h2>
      <table className="gym-xd-table">
        <thead>
          <tr><th scope="col">Reps</th><th scope="col" className="is-num">Best</th><th scope="col">Source</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reps} className={row.useActual ? 'is-actual' : 'is-projected'}>
              <th scope="row">{row.reps}RM</th>
              <td className="is-num">
                {row.useActual ? formatWeight(row.actual.value, unit) : estimate(row.projected, unit)}
              </td>
              <td>
                {row.useActual ? (
                  <button type="button" className="gym-xd-source is-actual" onClick={() => onOpen(row.actual)}>
                    <Icon name="check" size={13} strokeWidth={2.6} /> Logged {formatDateShort(row.actual.date)}
                  </button>
                ) : (
                  <span className="gym-xd-source">
                    Estimated{row.actual ? ` · logged ${formatWeight(row.actual.value, unit)}` : ''}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gym-xd-footnote">Estimates use the Brzycki formula from your best estimated 1RM. A logged set replaces the estimate once it’s heavier.</p>
    </section>
  )
}

function LoggedRepMax({ title, table, unit, sign, onOpen }) {
  const rows = Object.values(table || {}).filter((row) => row && isNum(row.reps)).sort((a, b) => a.reps - b.reps)
  if (!rows.length) return null
  return (
    <section className="card gym-xd-repmax" aria-label={title}>
      <h2 className="gym-xd-card-title">{title}</h2>
      <table className="gym-xd-table">
        <thead><tr><th scope="col">Reps</th><th scope="col" className="is-num">Weight</th><th scope="col">Date</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reps} className="is-actual">
              <th scope="row">{row.reps}</th>
              <td className="is-num">{row.value > 0 ? `${sign}${formatWeight(row.value, unit)}` : 'Bodyweight'}</td>
              <td><button type="button" className="gym-xd-source is-actual" onClick={() => onOpen(row)}>{formatDateShort(row.date)}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ---- per-exercise settings --------------------------------------------------------------------

const INCREMENTS = { kg: [0.5, 1, 1.25, 2, 2.5, 4, 5, 10], lb: [1, 2.5, 5, 10, 15, 20] }

function ExerciseSettings({ exercise, tracking, meta, unit }) {
  const defaultRest = isNum(exercise.rest) ? exercise.rest : 120
  const restValue = isNum(meta.restSec) ? String(meta.restSec) : ''
  const showIncrement = WEIGHTED.has(tracking)
  const defaultIncrement = increment(exercise, unit, null)
  const incrementShown = isNum(meta.increment) && meta.increment > 0 ? Number(formatNumber(fromKg(meta.increment, unit), 2)) : null
  const incrementChoices = [...new Set([...INCREMENTS[unit], ...(incrementShown ? [incrementShown] : [])])].sort((a, b) => a - b)

  return (
    <section className="gym-xd-settings" aria-labelledby="gym-xd-settings-title">
      <h2 className="group-title" id="gym-xd-settings-title">Settings for this exercise</h2>
      <div className="card gym-xd-settings-card">
        <label className="gym-xd-setting">
          <span className="gym-xd-setting-text">
            <span>Rest timer</span>
            <small>Default for new routines and workouts</small>
          </span>
          <select
            className="input"
            value={restValue}
            onChange={(event) => setExerciseMeta(exercise.id, { restSec: event.target.value === '' ? null : Number(event.target.value) })}
          >
            <option value="">Default ({restText(defaultRest)})</option>
            {restChoices(isNum(meta.restSec) ? meta.restSec : undefined).map((sec) => <option key={sec} value={String(sec)}>{restText(sec)}</option>)}
          </select>
        </label>
        {showIncrement && (
          <label className="gym-xd-setting">
            <span className="gym-xd-setting-text">
              <span>Weight increase</span>
              <small>Added when you hit the top of your rep range</small>
            </span>
            <select
              className="input"
              value={incrementShown === null ? '' : String(incrementShown)}
              onChange={(event) => setExerciseMeta(exercise.id, { increment: event.target.value === '' ? null : toKg(Number(event.target.value), unit) })}
            >
              <option value="">Default (+{formatWeight(defaultIncrement, unit)})</option>
              {incrementChoices.map((value) => <option key={value} value={String(value)}>+{formatNumber(value, 2)} {unit}</option>)}
            </select>
          </label>
        )}
      </div>
    </section>
  )
}

// ---- delete (custom only) ---------------------------------------------------------------------

function DeleteCustom({ exercise, used }) {
  const remove = () => {
    const undo = deleteCustomExercise(exercise.id)
    const kept = getGym().exercises.some((item) => item.id === exercise.id)
    toast(kept ? `${exercise.name} removed from your list. Its history is kept.` : `${exercise.name} deleted`, {
      action: { label: 'Undo', onClick: undo },
    })
    goBack('gym/exercises')
  }
  return (
    <div className="gym-xd-danger">
      <Button variant="ghost" icon="trash" className="gym-xd-delete" onClick={remove}>
        {used ? 'Remove from my exercises' : 'Delete exercise'}
      </Button>
      {used && <p className="gym-xd-footnote">It stays in the workouts you logged, but won’t show up in the list or picker.</p>}
    </div>
  )
}

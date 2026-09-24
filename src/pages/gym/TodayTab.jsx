import { useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { EmptyState, IconButton } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { WEEKDAY_SHORT, addDaysISO, formatDateShort, formatDuration as formatMinutes, relativeDay, weekdayIndex } from '../../lib/dates.js'
import { TRACKING, exerciseById, newRoutineExercise } from '../../lib/gym/library.js'
import { deloadWeek, nextWorkout, resolveDay, resolveRange } from '../../lib/gym/schedule.js'
import {
  deloadTargets, estimateMinutes, increment, plannedWeight, previousSets, sessionDurationSec, sessionPRs,
  sessionVolume, sessionWorkingSets, streakWeeks, suggestNext, weekProgress,
} from '../../lib/gym/stats.js'
import {
  addBodyWeight, clearDay, deleteBodyWeight, getGym, routineById, routineColor, saveRoutine, slotLabel, updateGym,
  useActiveWorkout, useBodyWeights, useGym, useGymSessions,
} from '../../lib/gym/state.js'
import { formatDistance, formatDuration, formatNumber, formatVolume, formatWeight, fromKg, fromMeters, toMeters } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { ActionSheet, DurationInput, NumberInput, RoutineChip, RoutineDot, SectionHeader, WeightInput } from './common.jsx'
import ChangeWorkoutSheet from './ChangeWorkoutSheet.jsx'
import ScheduleEditor from './ScheduleEditor.jsx'
import SkipSheet from './SkipSheet.jsx'
import { beginWorkout } from './startWorkout.js'
import './gym.css'

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const same = (a, b) => (a == null && b == null) || (num(a) !== null && num(b) !== null && Math.abs(a - b) < 1e-9)
const isWorkingType = (set) => set.type !== 'warmup'
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function trackingOf(row, entry) {
  if (TRACKING[row.tracking]) return row.tracking
  return TRACKING[entry?.tracking] ? entry.tracking : 'weight_reps'
}

function fieldsOf(tracking) {
  return TRACKING[tracking]?.fields || ['weight', 'reps']
}

function routineTitle(routine) {
  const name = routine?.name?.trim() || 'Untitled routine'
  return /\bday\b/i.test(name) ? name : `${name} Day`
}

function minutesText(sec) {
  if (sec === null || sec === undefined) return null
  return sec < 60 ? '<1 min' : formatMinutes(Math.round(sec / 60))
}

// ---- what the Today list shows per exercise -------------------------------------------------

function rangeText(set) {
  const lo = num(set?.repsMin)
  const hi = num(set?.repsMax)
  if (lo !== null && hi !== null) return lo === hi ? `${lo}` : `${Math.min(lo, hi)}–${Math.max(lo, hi)}`
  if (lo !== null || hi !== null) return `${lo ?? hi}`
  return ''
}

function weightText(kg, tracking, unit) {
  if (num(kg) === null) return ''
  if (tracking === 'weighted_bodyweight') return kg > 0 ? `+${formatWeight(kg, unit)}` : 'bodyweight'
  if (tracking === 'assisted_bodyweight') return kg > 0 ? `−${formatWeight(kg, unit)}` : ''
  return formatWeight(kg, unit)
}

const shortDistanceUnit = (distanceUnit) => (distanceUnit === 'mi' ? 'yd' : 'm')

function distanceText(m, tracking, distanceUnit) {
  if (num(m) === null) return ''
  return formatDistance(m, tracking === 'weight_distance' ? shortDistanceUnit(distanceUnit) : distanceUnit)
}

// "60 kg × 10, 10, 9" when the load is the same, else "60 × 10 · 57.5 × 9".
function describeSets(sets, tracking, unit, distanceUnit) {
  if (!sets?.length) return ''
  const fields = fieldsOf(tracking)
  if (fields.includes('reps')) {
    const weights = sets.map((set) => num(set.weightKg))
    const loaded = fields.length > 1 && weights.some((w) => w !== null && w > 0)
    if (!loaded) return `${sets.map((set) => num(set.reps) ?? '–').join(', ')} reps`
    if (weights.every((w) => same(w, weights[0]))) return `${weightText(weights[0], tracking, unit)} × ${sets.map((set) => num(set.reps) ?? '–').join(', ')}`
    return sets.map((set) => {
      const w = num(set.weightKg)
      return `${w !== null && w > 0 ? weightText(w, tracking, unit).replace(/ (kg|lb)$/, '') : 'BW'} × ${num(set.reps) ?? '–'}`
    }).join(' · ')
  }
  return sets.map((set) => [
    fields.includes('weight') ? weightText(num(set.weightKg), tracking, unit) : '',
    fields.includes('distance') ? distanceText(set.distanceM, tracking, distanceUnit) : '',
    fields.includes('duration') && num(set.durationSec) !== null ? formatDuration(set.durationSec) : '',
  ].filter(Boolean).join(' ')).filter(Boolean).join(' · ')
}

function planRow(row, { gym, sessions, routineId, deload }) {
  const { prefs } = gym
  const unit = prefs.unit
  const entry = exerciseById(row.exerciseId, gym.exercises)
  const meta = gym.exerciseMeta[row.exerciseId]
  const tracking = trackingOf(row, entry)
  const fields = fieldsOf(tracking)
  const shown = deload ? deloadTargets(row, entry, gym.schedule, prefs) : row
  const working = (shown?.sets || []).filter(isWorkingType)
  const warmups = (shown?.sets || []).length - working.length
  const first = working[0] || null
  const suggestion = prefs.progression ? suggestNext(sessions, row, entry, prefs, meta) : null
  const previous = row.exerciseId ? previousSets(sessions, row.exerciseId, { routineId, source: prefs.previousSource }) : null
  const lastWorking = (previous || []).filter(isWorkingType)

  // Weight: progression suggestion, else what was used last time, else the routine target (lighter
  // in a deload week). The same helper pre-fills the workout, so the list and the grid agree.
  const { weightKg } = plannedWeight(sessions, row, entry, prefs, meta, { routineId, deload, schedule: gym.schedule, suggestion, previous })

  const reps = fields.includes('reps') ? (num(suggestion?.reps) !== null ? String(suggestion.reps) : rangeText(first)) : ''
  const durationSec = fields.includes('duration') ? num(suggestion?.durationSec) ?? num(lastWorking[0]?.durationSec) ?? num(first?.durationSec) : null
  const distanceM = fields.includes('distance') ? num(lastWorking[0]?.distanceM) ?? num(first?.distanceM) : null

  const count = working.length
  const load = weightText(weightKg, tracking, unit)
  let line
  if (!count) line = 'No sets yet'
  else if (fields.includes('reps')) line = `${count} × ${reps || '—'}${load ? ` @ ${load}` : ''}`
  else if (tracking === 'distance_duration') {
    const parts = [distanceText(distanceM, tracking, prefs.distanceUnit), durationSec !== null ? formatDuration(durationSec) : ''].filter(Boolean)
    line = `${count} × ${parts.join(' in ') || '—'}`
  } else {
    const main = tracking === 'weight_distance' ? distanceText(distanceM, tracking, prefs.distanceUnit) : durationSec !== null ? formatDuration(durationSec) : ''
    line = `${count} × ${main || '—'}${load ? ` @ ${load}` : ''}`
  }

  let badge = null
  if (suggestion?.increased && !deload) {
    badge = { kind: 'up', icon: 'arrowUp', text: `+${formatWeight(increment(entry, unit, meta), unit)}`, title: 'Progression: all reps hit last time, so the weight goes up' }
  } else if (suggestion?.deload && !deload) {
    badge = { kind: 'down', icon: 'arrowDown', text: '−10%', title: 'Three sessions under target: reset 10% lighter and build back up' }
  }

  let suggestionText = ''
  if (suggestion) {
    if (num(suggestion.weightKg) !== null && fields.includes('reps')) suggestionText = `${weightText(suggestion.weightKg, tracking, unit)} × ${suggestion.reps}`
    else if (num(suggestion.reps) !== null) suggestionText = `${suggestion.reps} reps`
    else if (num(suggestion.durationSec) !== null) suggestionText = formatDuration(suggestion.durationSec)
  }

  return {
    row,
    entry,
    tracking,
    name: (entry?.custom ? entry.name : '') || row.name || entry?.name || 'Exercise',
    line,
    warmups,
    badge,
    lastText: describeSets(lastWorking, tracking, unit, prefs.distanceUnit),
    suggestionText,
  }
}

// Consecutive rows sharing a supersetId → 'A1', 'A2', 'B1'…
function supersetLabels(rows) {
  const labels = new Map()
  let group = 0
  for (let i = 0; i < rows.length;) {
    const id = rows[i].supersetId
    let j = i + 1
    while (id != null && j < rows.length && rows[j].supersetId === id) j++
    if (j - i > 1) {
      const letter = String.fromCharCode(65 + (group % 26))
      group += 1
      for (let k = i; k < j; k++) labels.set(rows[k].id, `${letter}${k - i + 1}`)
    }
    i = j
  }
  return labels
}

// ---- writing routine targets -------------------------------------------------------------------

function editRow(routineId, rowId, change) {
  const routine = routineById(getGym(), routineId)
  if (!routine) return
  let changed = false
  const exercises = routine.exercises.map((row) => {
    if (row.id !== rowId) return row
    const next = change(row)
    if (next !== row) changed = true
    return next
  })
  if (changed) saveRoutine({ ...routine, exercises })
}

// Working sets that share the first working set's value take the new one, so drop sets or a
// pyramid keep their own numbers.
function withWorkingField(row, field, value) {
  const first = row.sets.find(isWorkingType)
  if (!first) return row
  const old = first[field]
  if (same(old, value)) return row
  return { ...row, sets: row.sets.map((set) => (!isWorkingType(set) || !same(set[field], old) ? set : { ...set, [field]: value })) }
}

function withWorkingCount(row, count, tracking) {
  const working = row.sets.filter(isWorkingType)
  if (count === working.length || count < 1) return row
  if (count > working.length) {
    const template = working[working.length - 1] || newRoutineExercise({ tracking }, () => 'set', 1).sets[0]
    const added = Array.from({ length: count - working.length }, () => ({ ...template, type: template.type === 'drop' ? 'normal' : template.type }))
    return { ...row, sets: [...row.sets, ...added] }
  }
  let remove = working.length - count
  const sets = [...row.sets]
  for (let i = sets.length - 1; i >= 0 && remove > 0; i--) {
    if (isWorkingType(sets[i])) {
      sets.splice(i, 1)
      remove -= 1
    }
  }
  return { ...row, sets }
}

// ---- the tab -------------------------------------------------------------------------------------

export default function TodayTab({ today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const active = useActiveWorkout()
  const { prefs } = gym
  const [sheet, setSheet] = useState(null) // 'menu' | 'skip' | 'change' | 'schedule' | 'pick' | 'another'

  const day = useMemo(() => resolveDay(gym, sessions, today, today), [gym, sessions, today])
  const week = useMemo(() => resolveRange(gym, sessions, today, addDaysISO(today, 6), today), [gym, sessions, today])
  const next = useMemo(() => nextWorkout(gym, sessions, today), [gym, sessions, today])
  const weekCount = useMemo(() => weekProgress(sessions, today, prefs.firstWeekday), [sessions, today, prefs.firstWeekday])
  const streak = useMemo(() => streakWeeks(sessions, today, prefs.firstWeekday), [sessions, today, prefs.firstWeekday])
  const hasSchedule = gym.schedule.versions.length > 0

  function undoable(action, message) {
    try {
      const undo = action()
      toast(message, undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  function toggleDeload(on) {
    const current = getGym().schedule
    const before = current.deload
    try {
      updateGym({ schedule: deloadWeek(current, today, prefs.firstWeekday, on) })
    } catch (error) {
      toast(error.message, { tone: 'error' })
      return
    }
    toast(on ? 'This week is a deload week' : 'Deload skipped this week', {
      action: { label: 'Undo', onClick: () => updateGym((gymNow) => ({ schedule: { ...gymNow.schedule, deload: before } })) },
    })
  }

  // Everything else you can do with today lives behind the hero's one ⋯ menu: the plan changes
  // (skip, shift, change, an empty workout), then the schedule itself (deload, edit).
  const startEmpty = () => beginWorkout({ routine: null, date: today })
  const skipItem = { id: 'skip', label: 'Skip or shift…', hint: 'Take today off, or shift the whole plan a day later', icon: 'skipForward', onClick: () => setSheet('skip') }
  const shiftItem = { id: 'shift', label: 'Shift schedule…', hint: 'Add an extra rest day; everything after moves a day later', icon: 'arrowRight', onClick: () => setSheet('skip') }
  const changeItem = { id: 'change', label: 'Change today’s workout…', hint: 'Another routine or rest, today only', icon: 'shuffle', onClick: () => setSheet('change') }
  const emptyItem = { id: 'empty', label: 'Start empty workout', hint: 'Add exercises as you go', icon: 'plus', onClick: startEmpty }

  let planItems = []
  if (day.status === 'today') planItems = day.routineMissing ? [emptyItem] : [skipItem, changeItem, emptyItem]
  else if (day.status === 'rest') planItems = [changeItem, shiftItem]
  else if (day.status === 'skipped' || day.status === 'shifted') planItems = [changeItem, emptyItem]
  else if (day.status === 'none' && hasSchedule) planItems = [changeItem]

  const scheduleItems = [
    hasSchedule && (day.deload
      ? { id: 'deload', label: 'Skip this deload', hint: 'Back to full sets and weights this week', icon: 'zap', onClick: () => toggleDeload(false) }
      : { id: 'deload', label: 'Deload this week', hint: 'A lighter week: half the sets, about 10% less weight', icon: 'arrowDown', onClick: () => toggleDeload(true) }),
    { id: 'schedule', label: hasSchedule ? 'Edit schedule' : 'Set up schedule', hint: 'Which routine falls on which day', icon: 'calendar', onClick: () => setSheet('schedule') },
  ]
  const menu = [planItems, scheduleItems]
  const hasMenu = planItems.length + scheduleItems.filter(Boolean).length > 0

  return (
    <div className="gym-td">
      {hasSchedule && <WeekStrip days={week} today={today} gym={gym} />}

      <Hero day={day} next={next} week={week} gym={gym} sessions={sessions} today={today} active={active} hasSchedule={hasSchedule} onMenu={hasMenu ? () => setSheet('menu') : null} onSheet={setSheet} onUndoable={undoable} />

      {day.status === 'today' && day.routine && (
        <section className="gym-td-section">
          <SectionHeader
            title="Exercises"
            action={<button type="button" className="link-btn" onClick={() => navigate(`gym/routine/${encodeURIComponent(day.routine.id)}`)}>Edit routine</button>}
          />
          <ExerciseList routine={day.routine} gym={gym} sessions={sessions} deload={day.deload} />
        </section>
      )}

      <div className="gym-td-tiles">
        <button type="button" className="card gym-td-tile" onClick={() => navigate('gym/stats')} aria-label={`Weekly goal: ${weekCount} of ${prefs.weeklyGoal} workouts this week. Open stats`}>
          <GoalRing value={weekCount} goal={prefs.weeklyGoal} />
          <span className="gym-td-tile-text">
            <small className="gym-td-tile-label">This week</small>
            <strong>{weekCount}<span className="gym-td-tile-of">/{prefs.weeklyGoal}</span></strong>
            <small>{weekCount >= prefs.weeklyGoal ? 'Goal reached' : `${prefs.weeklyGoal - weekCount} more to go`}</small>
          </span>
        </button>
        <button type="button" className={`card gym-td-tile${streak ? ' has-streak' : ''}`} onClick={() => navigate('gym/stats')} aria-label={`Streak: ${plural(streak, 'week')} in a row. Open stats`}>
          <span className="gym-td-flame" aria-hidden="true"><Icon name="flame" size={24} /></span>
          <span className="gym-td-tile-text">
            <small className="gym-td-tile-label">Streak</small>
            <strong>{streak}</strong>
            <small>{streak ? `week${streak === 1 ? '' : 's'} in a row` : 'Train this week to start one'}</small>
          </span>
        </button>
      </div>

      <BodyWeightCard today={today} unit={prefs.unit} />

      <ActionSheet open={sheet === 'menu'} onClose={() => setSheet(null)} title="Today" description="Change what happens today, or the plan itself." actions={menu} />
      <SkipSheet open={sheet === 'skip'} onClose={() => setSheet(null)} date={today} />
      <ChangeWorkoutSheet open={sheet === 'change'} onClose={() => setSheet(null)} date={today} />
      <ScheduleEditor open={sheet === 'schedule'} onClose={() => setSheet(null)} today={today} />
      <RoutinePickerSheet
        open={sheet === 'pick' || sheet === 'another'}
        onClose={() => setSheet(null)}
        title={sheet === 'another' ? 'Log another workout' : 'Train anyway'}
        gym={gym}
        today={today}
        planned={day.routine}
      />
    </div>
  )
}

// ---- hero status card -----------------------------------------------------------------------------

function Hero({ day, next, week, gym, sessions, today, active, hasSchedule, onMenu, onSheet, onUndoable }) {
  const routine = day.routine
  const sessionRoutine = day.sessions.length ? routineById(gym, day.sessions[0].routineId) : null
  const tint = day.status === 'done' ? sessionRoutine || routine : day.status === 'today' ? routine : null
  const style = tint ? { '--gym-rc': routineColor(tint) } : undefined
  const override = day.override
  const badges = []
  if (day.deload) badges.push(<span key="deload" className="gym-td-badge is-deload" title="Fewer sets and about 10% less weight this week"><Icon name="arrowDown" size={12} strokeWidth={2.4} />Deload week</span>)
  if (override?.movedFrom) badges.push(<span key="moved" className="gym-td-badge"><Icon name="arrowRight" size={12} strokeWidth={2.4} />Moved from {WEEKDAY_SHORT[weekdayIndex(override.movedFrom)]}</span>)
  else if (override?.movedTo) badges.push(<span key="moved" className="gym-td-badge"><Icon name="arrowRight" size={12} strokeWidth={2.4} />Moved to {WEEKDAY_SHORT[weekdayIndex(override.movedTo)]}</span>)
  else if (override) badges.push(<span key="changed" className="gym-td-badge" title={`Planned: ${slotLabel(day.planned, gym)}`}><Icon name="pencil" size={12} strokeWidth={2.2} />Changed</span>)

  const top = (eyebrow, icon) => (
    <div className="gym-td-hero-top">
      <span className="gym-td-hero-eyebrow">
        {tint ? <RoutineDot routine={tint} size={9} /> : icon ? <Icon name={icon} size={14} strokeWidth={2.2} /> : null}
        {eyebrow}
      </span>
      {badges.length > 0 && <span className="gym-td-hero-badges">{badges}</span>}
      {onMenu && (
        <span className="gym-td-menu-wrap">
          <IconButton icon="more" label="More options for today" className="gym-td-more" aria-haspopup="dialog" onClick={onMenu} />
        </span>
      )}
    </div>
  )

  if (day.status === 'today') {
    if (!routine) {
      return (
        <section className="card gym-td-hero" style={style}>
          {top('Today’s workout', 'alert')}
          <h2 className="gym-td-hero-title">Deleted routine</h2>
          <p className="gym-td-hero-sub">Today’s plan points to a routine that no longer exists. Pick what to do instead.</p>
          <div className="gym-td-hero-actions">
            <button type="button" className="btn btn-primary btn-lg gym-td-start" onClick={() => onSheet('change')}>
              <Icon name="shuffle" size={18} />Change today’s workout
            </button>
          </div>
        </section>
      )
    }
    // Deload weeks count the lightened sets.
    const rows = day.deload
      ? routine.exercises.map((row) => deloadTargets(row, exerciseById(row.exerciseId, gym.exercises), gym.schedule, gym.prefs))
      : routine.exercises
    const setCount = rows.reduce((sum, row) => sum + row.sets.filter(isWorkingType).length, 0)
    const minutes = estimateMinutes({ exercises: rows })
    const resumeSame = active && active.date === today && active.routineId === routine.id
    const sub = routine.exercises.length
      ? [plural(routine.exercises.length, 'exercise'), setCount ? plural(setCount, 'set') : null, minutes ? `~${minutes} min` : null].filter(Boolean).join(' · ')
      : 'No exercises yet'
    return (
      <section className="card gym-td-hero has-tint" style={style}>
        {top('Today’s workout')}
        <h2 className="gym-td-hero-title">{routineTitle(routine)}</h2>
        <p className="gym-td-hero-sub">{sub}</p>
        {day.deload && <p className="gym-td-hero-note">Lighter week: fewer sets and about 10% less weight, already applied below.</p>}
        <div className="gym-td-hero-actions">
          <button
            type="button"
            className="btn btn-primary btn-lg gym-td-start"
            onClick={() => (resumeSame ? navigate('gym/workout') : beginWorkout({ routine, date: today }))}
          >
            <Icon name="play" size={18} strokeWidth={2.2} />
            {resumeSame ? 'Resume Workout' : 'Start Workout'}
          </button>
        </div>
      </section>
    )
  }

  if (day.status === 'done') {
    const names = day.sessions.map((session) => session.name?.trim() || 'Workout')
    return (
      <section className="card gym-td-hero has-tint is-done" style={style}>
        {top('Completed', 'check')}
        <h2 className="gym-td-hero-title">
          <span className="gym-td-done-check" aria-hidden="true"><Icon name="check" size={18} strokeWidth={3} /></span>
          Done: {names[0]}{names.length > 1 ? ` +${names.length - 1}` : ''}
        </h2>
        <ul className="gym-td-done-list">
          {day.sessions.map((session) => <DoneSession key={session.id} session={session} gym={gym} sessions={sessions} />)}
        </ul>
        <NextUp next={next} today={today} gym={gym} />
        <div className="gym-td-hero-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onSheet('another')}>
            <Icon name="plus" size={18} />Log another
          </button>
        </div>
      </section>
    )
  }

  if (day.status === 'rest') {
    return (
      <section className="card gym-td-hero is-rest">
        {top('Rest day', 'moon')}
        <h2 className="gym-td-hero-title">Rest day</h2>
        <p className="gym-td-hero-sub">Recovery is where the gains happen. Walk, stretch, sleep well.</p>
        <NextUp next={next} today={today} gym={gym} />
        <div className="gym-td-hero-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onSheet('pick')}>
            <Icon name="dumbbell" size={18} />Train anyway
          </button>
        </div>
      </section>
    )
  }

  if (day.status === 'skipped') {
    return (
      <section className="card gym-td-hero is-skipped">
        {top('Skipped', 'skipForward')}
        <h2 className="gym-td-hero-title">Skipped {slotLabel(day.shown, gym)}</h2>
        <p className="gym-td-hero-sub">Taking today off. The rest of your plan is unchanged.</p>
        <NextUp next={next} today={today} gym={gym} />
        <div className="gym-td-hero-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onUndoable(() => clearDay(today), 'Back on plan for today')}>
            <Icon name="undo" size={18} />Undo skip
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onSheet('pick')}>Train anyway</button>
        </div>
      </section>
    )
  }

  if (day.status === 'shifted') {
    const tomorrow = week[1]
    const moved = tomorrow && tomorrow.shown.kind === 'routine' ? slotLabel(tomorrow.shown, gym) : null
    return (
      <section className="card gym-td-hero is-shifted">
        {top('Shifted', 'arrowRight')}
        <h2 className="gym-td-hero-title">Shifted a day</h2>
        <p className="gym-td-hero-sub">
          {moved ? `${moved} moves to tomorrow and everything after slides one day.` : 'Your plan moves forward a day from here.'}
        </p>
        <div className="gym-td-hero-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onUndoable(() => clearDay(today), 'Shift undone')}>
            <Icon name="undo" size={18} />Undo shift
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onSheet('pick')}>Train anyway</button>
        </div>
      </section>
    )
  }

  // 'none': no schedule yet, or nothing planned on this date.
  return (
    <section className="card gym-td-hero is-none">
      {top(hasSchedule ? 'Nothing planned' : 'No schedule yet', 'calendar')}
      <h2 className="gym-td-hero-title">{hasSchedule ? 'Nothing planned today' : 'Plan your week'}</h2>
      <p className="gym-td-hero-sub">
        {hasSchedule
          ? 'Your schedule has no workout for today. Train anyway or adjust the plan.'
          : 'Put your routines on a weekly plan or a rotation so Daybook knows what’s next.'}
      </p>
      {hasSchedule && <NextUp next={next} today={today} gym={gym} />}
      <div className="gym-td-hero-actions">
        {!hasSchedule && (
          <button type="button" className="btn btn-primary" onClick={() => onSheet('schedule')}>
            <Icon name="calendar" size={18} />Set up schedule
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => onSheet('pick')}>
          <Icon name="dumbbell" size={18} />Train anyway
        </button>
      </div>
    </section>
  )
}

function NextUp({ next, today, gym }) {
  if (!next) return null
  return (
    <p className="gym-td-next">
      <span className="gym-td-next-label">Next</span>
      <RoutineChip routine={next.routine} label={next.routine || next.routineMissing ? undefined : slotLabel(next.shown, gym)} />
      <span className="gym-td-next-when">{relativeDay(next.date, today)}</span>
    </p>
  )
}

function DoneSession({ session, gym, sessions }) {
  const { prefs } = gym
  const summary = useMemo(() => {
    const lookup = (id) => {
      const entry = exerciseById(id, gym.exercises)
      return entry && !prefs.bodyweightInVolume ? { ...entry, bwVolume: false } : entry
    }
    const quick = !session.exercises?.length
    return {
      quick,
      minutes: minutesText(sessionDurationSec(session)),
      volume: sessionVolume(session, lookup),
      sets: sessionWorkingSets(session),
      prs: quick ? 0 : sessionPRs(sessions, session, prefs.e1rmFormula).length,
    }
  }, [session, sessions, gym.exercises, prefs.bodyweightInVolume, prefs.e1rmFormula])
  const routine = routineById(gym, session.routineId)
  const parts = summary.quick
    ? ['Logged without details']
    : [summary.minutes, summary.volume > 0 ? formatVolume(summary.volume, prefs.unit) : null, summary.sets ? plural(summary.sets, 'set') : null].filter(Boolean)
  return (
    <li>
      <button type="button" className="gym-td-done-card" onClick={() => navigate(`gym/session/${encodeURIComponent(session.id)}`)}>
        {routine ? <RoutineDot routine={routine} size={10} /> : <span className="gym-td-done-dot" aria-hidden="true" />}
        <span className="gym-td-done-text">
          <strong>{session.name?.trim() || 'Workout'}</strong>
          <small>{parts.join(' · ')}</small>
        </span>
        {summary.prs > 0 && <span className="gym-pr-badge"><Icon name="trophy" size={12} strokeWidth={2.2} />{plural(summary.prs, 'PR')}</span>}
        <Icon name="chevronRight" size={18} className="gym-td-chevron" />
      </button>
    </li>
  )
}

// ---- 7-day strip -----------------------------------------------------------------------------------------

function WeekStrip({ days, today, gym }) {
  return (
    <ol className="card gym-td-strip" aria-label="Your next 7 days">
      {days.map((day) => <StripDay key={day.date} day={day} today={today} gym={gym} />)}
    </ol>
  )
}

function StripDay({ day, today, gym }) {
  const isToday = day.date === today
  const session = day.sessions[0]
  const routine = day.status === 'done' ? routineById(gym, session?.routineId) || day.routine : day.routine
  const color = routine ? routineColor(routine) : null
  let kind = 'none'
  let label = ''
  let status = 'nothing planned'
  if (day.status === 'done') {
    kind = 'done'
    label = session?.name?.trim() || 'Done'
    status = `done, ${label}`
  } else if (day.status === 'skipped') {
    kind = 'skipped'
    label = slotLabel(day.shown, gym)
    status = `${label}, skipped`
  } else if (day.status === 'shifted') {
    kind = 'shifted'
    label = 'Shifted'
    status = 'shifted'
  } else if (day.status === 'rest') {
    kind = 'rest'
    label = 'Rest'
    status = 'rest day'
  } else if (day.status === 'today' || day.status === 'upcoming') {
    kind = day.routineMissing ? 'missing' : 'planned'
    label = slotLabel(day.shown, gym)
    status = label
  }
  const dayLabel = isToday ? 'Today' : WEEKDAY_SHORT[weekdayIndex(day.date)]
  return (
    <li>
      <button
        type="button"
        className={`gym-td-strip-day is-${kind}${isToday ? ' is-today' : ''}${color ? ' has-color' : ''}`}
        style={color ? { '--gym-rc': color } : undefined}
        onClick={() => navigate('gym/calendar')}
        aria-label={`${relativeDay(day.date, today)}, ${formatDateShort(day.date)}: ${status}${day.override ? ', changed' : ''}. Open calendar`}
      >
        <span className="gym-td-strip-wd">{dayLabel}</span>
        <span className="gym-td-strip-circle">
          {kind === 'shifted' ? <Icon name="arrowRight" size={16} strokeWidth={2.2} /> : Number(day.date.slice(8))}
          {kind === 'done' && <span className="gym-td-strip-mark is-done"><Icon name="check" size={9} strokeWidth={4} /></span>}
          {kind !== 'done' && day.override && <span className="gym-td-strip-mark is-edit"><Icon name="pencil" size={8} strokeWidth={3} /></span>}
        </span>
        <span className="gym-td-strip-name">{label || '\u00a0'}</span>
      </button>
    </li>
  )
}

// ---- exercise list with inline target editing ---------------------------------------------------------

function ExerciseList({ routine, gym, sessions, deload }) {
  const [openId, setOpenId] = useState(null)
  const plans = useMemo(
    () => routine.exercises.map((row) => planRow(row, { gym, sessions, routineId: routine.id, deload })),
    // gym.exercises/exerciseMeta/prefs/schedule are the parts planRow reads
    [routine, gym.exercises, gym.exerciseMeta, gym.prefs, gym.schedule, sessions, deload], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const labels = useMemo(() => supersetLabels(routine.exercises), [routine.exercises])

  if (!plans.length) {
    return (
      <div className="card">
        <EmptyState icon="dumbbell" title={`No exercises in ${routine.name?.trim() || 'this routine'} yet`} action={(
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`gym/routine/${encodeURIComponent(routine.id)}`)}>
            Add exercises
          </button>
        )}>
          Add a few and they’ll show up here with your targets.
        </EmptyState>
      </div>
    )
  }

  return (
    <ul className="card gym-td-ex-list" style={{ '--gym-rc': routineColor(routine) }}>
      {plans.map((plan, index) => {
        const open = openId === plan.row.id
        const label = labels.get(plan.row.id)
        return (
          <li key={plan.row.id} className={`gym-td-ex${open ? ' is-open' : ''}${label ? ' in-superset' : ''}`}>
            <button type="button" className="gym-td-ex-row" aria-expanded={open} onClick={() => setOpenId(open ? null : plan.row.id)}>
              <span className="gym-td-ex-num" aria-hidden="true">{label || index + 1}</span>
              <span className="gym-td-ex-text">
                <span className="gym-td-ex-name">{plan.name}</span>
                <span className="gym-td-ex-line">
                  {plan.line}
                  {plan.warmups > 0 && <span className="gym-td-ex-warm"> · {plan.warmups} W</span>}
                </span>
              </span>
              {plan.badge && (
                <span className={`gym-td-badge is-${plan.badge.kind}`} title={plan.badge.title}>
                  <Icon name={plan.badge.icon} size={12} strokeWidth={2.6} />{plan.badge.text}
                </span>
              )}
              <Icon name="chevronDown" size={18} className="gym-td-ex-chevron" />
            </button>
            {open && <TargetEditor routine={routine} plan={plan} gym={gym} deload={deload} />}
          </li>
        )
      })}
    </ul>
  )
}

function Stepper({ label, value, min = 1, max = 20, onChange }) {
  return (
    <div className="gym-td-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Icon name="minus" size={16} strokeWidth={2.4} />
      </button>
      <output className="gym-td-stepper-value" aria-live="polite">{value}</output>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Icon name="plus" size={16} strokeWidth={2.4} />
      </button>
    </div>
  )
}

function TargetEditor({ routine, plan, gym, deload }) {
  const { row, tracking } = plan
  const { unit, distanceUnit } = gym.prefs
  const fields = fieldsOf(tracking)
  const working = row.sets.filter(isWorkingType)
  const first = working[0] || null
  const edit = (change) => editRow(routine.id, row.id, change)
  // On leaving a reps field, a minimum above the maximum pulls the other end along.
  const fixRange = (changed) => edit((current) => {
    const set = current.sets.find(isWorkingType)
    const lo = num(set?.repsMin)
    const hi = num(set?.repsMax)
    if (lo === null || hi === null || lo <= hi) return current
    return changed === 'min' ? withWorkingField(current, 'repsMax', lo) : withWorkingField(current, 'repsMin', hi)
  })
  const weightField = fields.find((field) => field === 'weight' || field === 'added' || field === 'assist')
  const weightLabel = weightField === 'added' ? 'Added' : weightField === 'assist' ? 'Assist' : 'Weight'
  const distUnit = tracking === 'weight_distance' ? shortDistanceUnit(distanceUnit) : distanceUnit
  const name = routine.name?.trim() || 'this routine'

  return (
    <div className="gym-td-ex-edit">
      <div className="gym-td-ex-fields">
        <div className="gym-td-mini">
          <span className="gym-td-mini-label">Sets</span>
          <Stepper label="Sets" value={working.length} min={1} onChange={(count) => edit((current) => withWorkingCount(current, count, tracking))} />
        </div>
        {weightField && (
          <label className="gym-td-mini">
            <span className="gym-td-mini-label">{weightLabel} ({unit})</span>
            <WeightInput
              valueKg={first?.weightKg}
              unit={unit}
              placeholder="—"
              ariaLabel={`${weightLabel} target for ${plan.name}`}
              onChange={(kg) => edit((current) => withWorkingField(current, 'weightKg', kg))}
            />
          </label>
        )}
        {fields.includes('reps') && (
          <div className="gym-td-mini">
            <span className="gym-td-mini-label">Reps</span>
            <div className="gym-td-range">
              <NumberInput value={first?.repsMin} min={1} max={100} placeholder="8" ariaLabel={`Minimum reps for ${plan.name}`} enterKeyHint="next" onChange={(value) => edit((current) => withWorkingField(current, 'repsMin', value))} onBlur={() => fixRange('min')} />
              <span aria-hidden="true">–</span>
              <NumberInput value={first?.repsMax} min={1} max={100} placeholder="12" ariaLabel={`Maximum reps for ${plan.name}`} onChange={(value) => edit((current) => withWorkingField(current, 'repsMax', value))} onBlur={() => fixRange('max')} />
            </div>
          </div>
        )}
        {fields.includes('distance') && (
          <label className="gym-td-mini">
            <span className="gym-td-mini-label">Distance ({distUnit})</span>
            <NumberInput
              decimal
              value={fromMeters(first?.distanceM, distUnit)}
              placeholder="—"
              ariaLabel={`Distance target for ${plan.name}`}
              onChange={(value) => edit((current) => withWorkingField(current, 'distanceM', value === null ? null : toMeters(value, distUnit)))}
            />
          </label>
        )}
        {fields.includes('duration') && (
          <label className="gym-td-mini">
            <span className="gym-td-mini-label">Time</span>
            <DurationInput valueSec={first?.durationSec} placeholder="1:00" ariaLabel={`Time target for ${plan.name}`} onChange={(sec) => edit((current) => withWorkingField(current, 'durationSec', sec))} />
          </label>
        )}
      </div>
      <div className="gym-td-ex-notes">
        {plan.suggestionText && <p><Icon name="target" size={14} /><span>Suggested: <strong>{plan.suggestionText}</strong>{deload ? ' before the deload' : ''}</span></p>}
        {plan.lastText && <p><Icon name="history" size={14} /><span>Last time: {plan.lastText}</span></p>}
        <p className="gym-td-ex-save-note">Changes save to {name}{deload ? '; this week’s deload lightens them automatically' : ''}.</p>
      </div>
      {row.exerciseId && (
        <button type="button" className="link-btn gym-td-ex-details" onClick={() => navigate(`gym/exercise/${encodeURIComponent(row.exerciseId)}`)}>
          History & records
          <Icon name="chevronRight" size={16} />
        </button>
      )}
    </div>
  )
}

// ---- progress tiles & body weight ---------------------------------------------------------------------

function GoalRing({ value, goal }) {
  const r = 21
  const c = 2 * Math.PI * r
  const pct = goal > 0 ? Math.min(1, value / goal) : 0
  return (
    <svg className={`gym-td-ring${pct >= 1 ? ' is-met' : ''}`} width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      <circle className="gym-td-ring-track" cx="26" cy="26" r={r} />
      <circle className="gym-td-ring-value" cx="26" cy="26" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 26 26)" />
      {pct >= 1 && <path className="gym-td-ring-check" d="m19.5 26.5 4.5 4.5 8.5-9" />}
    </svg>
  )
}

function BodyWeightCard({ today, unit }) {
  const weights = useBodyWeights()
  const [draft, setDraft] = useState(null)
  const latest = weights[0] || null
  const previous = weights[1] || null
  const delta = latest && previous ? latest.kg - previous.kg : null
  const shownDelta = delta === null ? null : fromKg(delta, unit)
  const hasToday = latest?.date === today

  function log() {
    if (draft === null) return
    const before = weights.find((entry) => entry.date === today) || null
    try {
      const saved = addBodyWeight(today, draft)
      setDraft(null)
      toast(`Logged ${formatWeight(draft, unit)}`, {
        action: { label: 'Undo', onClick: () => (before ? addBodyWeight(today, before.kg) : deleteBodyWeight(saved.id)) },
      })
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  return (
    <section className="card gym-td-bw">
      <header className="gym-td-card-head">
        <h3><Icon name="scale" size={18} />Body weight</h3>
        <button type="button" className="link-btn" onClick={() => navigate('gym/stats')}>Stats</button>
      </header>
      <div className="gym-td-bw-body">
        <div className="gym-td-bw-latest">
          {latest ? (
            <>
              <span className="gym-td-bw-value">
                <strong>{formatWeight(latest.kg, unit, { withUnit: false })}</strong>
                <span>{unit}</span>
              </span>
              <small>
                {relativeDay(latest.date, today)}
                {shownDelta !== null && Math.abs(shownDelta) >= 0.005 && (
                  <span className="gym-td-bw-delta">
                    <Icon name={shownDelta > 0 ? 'arrowUp' : 'arrowDown'} size={12} strokeWidth={2.6} />
                    {formatNumber(Math.abs(shownDelta), 1)} {unit}
                  </span>
                )}
              </small>
            </>
          ) : (
            <small className="gym-td-bw-empty">Log it now and then to see the trend.</small>
          )}
        </div>
        <div className="gym-td-bw-form">
          <WeightInput
            valueKg={draft}
            unit={unit}
            onChange={setDraft}
            placeholder={latest ? latest.kg : unit === 'lb' ? '170' : '75'}
            ariaLabel={`Today’s body weight in ${unit}`}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              log()
              event.currentTarget.blur()
            }}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={draft === null} onClick={log}>
            {hasToday ? 'Update' : 'Log'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---- routine picker ("Train anyway" / "Log another") -----------------------------------------------------

function RoutinePickerSheet({ open, onClose, title, gym, today, planned }) {
  const start = (routine) => {
    onClose()
    beginWorkout({ routine, date: today })
  }
  return (
    <Sheet open={open} onClose={onClose} title={title} description="Pick a routine to start, or start empty and add exercises as you go." size="sm">
      <ul className="gym-td-pick-list">
        {gym.routines.map((routine) => {
          const minutes = estimateMinutes(routine)
          return (
            <li key={routine.id}>
              <button type="button" className="gym-td-pick-row" onClick={() => start(routine)}>
                <RoutineDot routine={routine} size={12} />
                <span className="gym-td-pick-text">
                  <strong>{routine.name?.trim() || 'Untitled routine'}</strong>
                  <small>{[plural(routine.exercises.length, 'exercise'), minutes ? `~${minutes} min` : null].filter(Boolean).join(' · ')}</small>
                </span>
                {planned?.id === routine.id && <span className="gym-td-badge">Planned</span>}
                <Icon name="play" size={16} className="gym-td-chevron" />
              </button>
            </li>
          )
        })}
        <li>
          <button type="button" className="gym-td-pick-row" onClick={() => start(null)}>
            <span className="gym-td-pick-icon" aria-hidden="true"><Icon name="plus" size={14} strokeWidth={2.6} /></span>
            <span className="gym-td-pick-text">
              <strong>Empty workout</strong>
              <small>Add exercises as you go</small>
            </span>
            <Icon name="play" size={16} className="gym-td-chevron" />
          </button>
        </li>
      </ul>
      {!gym.routines.length && (
        <button
          type="button"
          className="link-btn gym-td-pick-create"
          onClick={() => {
            onClose()
            navigate('gym/routine/new')
          }}
        >
          Create a routine
        </button>
      )}
    </Sheet>
  )
}

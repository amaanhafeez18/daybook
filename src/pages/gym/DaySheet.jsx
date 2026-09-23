import { useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addDaysISO, diffDays, formatDateLong, formatDateShort, isISODate } from '../../lib/dates.js'
import { resolveDay } from '../../lib/gym/schedule.js'
import { deloadTargets, estimateMinutes, sessionDurationSec } from '../../lib/gym/stats.js'
import { clearDay, deleteSession, moveWorkout, quickLog, routineById, routineColor, slotLabel, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatDistance, formatDuration, formatVolume, formatWeight } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import ChangeWorkoutSheet from './ChangeWorkoutSheet.jsx'
import SkipSheet from './SkipSheet.jsx'
import { RoutineChip, RoutineDot } from './common.jsx'
import { beginWorkout } from './startWorkout.js'
import { ActionRow, SessionDot, clockLabel, formatMinutes, showError, useExerciseLookup, useVolumeOf } from './HistoryTab.jsx'
import './history.css'

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

function relativeText(date, today) {
  if (!isISODate(today)) return undefined
  const delta = diffDays(today, date)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta === -1) return 'Yesterday'
  return delta > 0 ? `In ${delta} days` : `${-delta} days ago`
}

// The sheet keeps showing the last date while it animates closed (the caller may clear it).
export default function DaySheet({ open, onClose, date, today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const last = useRef(null)
  if (isISODate(date)) last.current = date
  const shown = last.current
  return (
    <Sheet
      open={!!open && !!shown}
      onClose={onClose}
      title={shown ? formatDateLong(shown) : ''}
      description={shown ? relativeText(shown, today) : undefined}
      size="md"
    >
      {shown && <DayBody key={shown} date={shown} today={today} onClose={onClose} />}
    </Sheet>
  )
}

const STATUS_PILL = {
  done: { label: 'Done', tone: 'success', icon: 'check' },
  skipped: { label: 'Skipped', tone: 'muted', icon: 'skipForward' },
  missed: { label: 'Missed', tone: 'danger' },
  today: { label: 'To do', tone: 'accent' },
  upcoming: { label: 'Upcoming', tone: 'muted' },
}

function PlanChip({ day }) {
  const { shown } = day
  if (shown.kind === 'routine') return <RoutineChip routine={day.routine} />
  if (shown.kind === 'rest') return <RoutineChip label="Rest" />
  if (shown.kind === 'shifted') return <RoutineChip label="Shifted" />
  return <RoutineChip label="No plan" />
}

function dayNotes(day, gym, hasSession) {
  const notes = []
  const override = day.override
  if (override?.movedFrom) notes.push({ icon: 'arrowRight', text: `Moved here from ${formatDateShort(override.movedFrom)}` })
  if (override?.movedTo) notes.push({ icon: 'arrowRight', text: `Workout moved to ${formatDateShort(override.movedTo)}` })
  if (override && !override.movedFrom && !override.movedTo) {
    const from = day.planned.kind === 'routine' || day.planned.kind === 'rest' ? slotLabel(day.planned, gym) : null
    notes.push({ icon: 'pencil', text: from ? `Changed from ${from} for this day only` : 'Changed for this day only' })
  }
  if (day.shifted) notes.push({ icon: 'arrowRight', text: 'Shifted: the plan carries on a day later from here' })
  if (day.skipped) {
    notes.push({ icon: 'skipForward', text: day.shown.kind === 'routine' ? `${slotLabel(day.shown, gym)} skipped; the rest of the plan stays the same` : 'Skipped' })
  }
  if (day.routineMissing) notes.push({ icon: 'alert', text: 'The planned routine was deleted' })
  if (day.status === 'none' && !hasSession && !override) notes.push({ icon: 'calendar', text: 'No gym plan covers this day' })
  return notes
}

const sessionStart = (session) => (typeof session.startedAt === 'string' && session.startedAt) || (typeof session.createdAt === 'string' ? session.createdAt : '')

// '3 × 8–12 @ 60 kg' for a routine exercise (working sets only).
function summarize(row, unit, distanceUnit) {
  const sets = Array.isArray(row.sets) ? row.sets : []
  const working = sets.filter((set) => set.type !== 'warmup')
  const list = working.length ? working : sets
  if (!list.length) return 'No sets'
  const first = list[0]
  let target = ''
  if (isNum(first.repsMin) || isNum(first.repsMax)) {
    const a = isNum(first.repsMin) ? first.repsMin : first.repsMax
    const b = isNum(first.repsMax) ? first.repsMax : first.repsMin
    target = a === b ? String(a) : `${Math.min(a, b)}–${Math.max(a, b)}`
  } else if (isNum(first.durationSec) && first.durationSec > 0) {
    target = formatDuration(first.durationSec)
  } else if (isNum(first.distanceM) && first.distanceM > 0) {
    target = formatDistance(first.distanceM, distanceUnit === 'mi' ? 'mi' : 'km')
  }
  let text = target ? `${list.length} × ${target}` : `${list.length} set${list.length === 1 ? '' : 's'}`
  if (isNum(first.weightKg) && first.weightKg > 0) text += ` @ ${formatWeight(first.weightKg, unit)}`
  return text
}

function DayBody({ date, today, onClose }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const { unit, distanceUnit } = gym.prefs
  const lookup = useExerciseLookup(gym)
  const volumeOf = useVolumeOf(lookup)
  const day = useMemo(() => resolveDay(gym, sessions, date, today), [gym, sessions, date, today])
  const daySessions = useMemo(() => [...day.sessions].sort((a, b) => sessionStart(a).localeCompare(sessionStart(b))), [day.sessions])
  const [pick, setPick] = useState(undefined) // routine id, null = no routine, undefined = the planned one
  const [sub, setSub] = useState(null) // 'skip' | 'change'
  const [moving, setMoving] = useState(false)
  const [moveTo, setMoveTo] = useState(() => addDaysISO(date < today ? today : date, 1))
  const moveId = useId()

  const past = date < today
  const isToday = date === today
  const future = date > today
  const hasSession = daySessions.length > 0
  const shownRoutine = day.shown.kind === 'routine' ? day.routine : null
  const pickedId = pick === undefined ? shownRoutine?.id ?? null : pick
  const picked = pickedId != null ? routineById(gym, pickedId) : null
  const notes = dayNotes(day, gym, hasSession)
  const pill = STATUS_PILL[day.status]
  const planEditable = !past && !hasSession
  const canSkip = planEditable && day.versionId != null && day.status !== 'none' && !day.skipped && !day.shifted
  const canMove = planEditable && day.shown.kind === 'routine'
  const hasChanges = planEditable && (day.skipped || day.shifted || !!day.override)
  const preview = !past && !hasSession && !day.skipped && shownRoutine ? shownRoutine : null

  function openSession(session) {
    onClose()
    navigate(`gym/session/${encodeURIComponent(session.id)}`)
  }

  function begin() {
    // beginWorkout unlocks audio, so it runs straight from the tap.
    beginWorkout({ routine: picked, date, today })
    onClose()
  }

  function logQuick() {
    try {
      const saved = quickLog(date, pickedId)
      toast(`Logged ${saved.name} ${isToday ? 'today' : `on ${formatDateShort(date)}`}`, {
        tone: 'success',
        action: { label: 'Undo', onClick: () => deleteSession(saved.id) },
      })
    } catch (error) {
      showError(error)
    }
  }

  function submitMove(event) {
    event.preventDefault()
    try {
      if (!isISODate(moveTo) || moveTo < today) throw new Error('Pick today or a later day.')
      if (moveTo === date) throw new Error('Pick a different day to move it to.')
      const label = slotLabel(day.shown, gym)
      const undo = moveWorkout(date, moveTo)
      setMoving(false)
      toast(`Moved ${label} to ${formatDateShort(moveTo)}`, undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
    } catch (error) {
      showError(error)
    }
  }

  function clear() {
    try {
      const undo = clearDay(date)
      toast('Back to the regular plan', undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
    } catch (error) {
      showError(error)
    }
  }

  return (
    <div className="gym-day">
      <section className="gym-day-plan" aria-label="Plan">
        <div className="gym-day-plan-row">
          <span className="gym-day-label">{past ? 'Planned' : 'Plan'}</span>
          <PlanChip day={day} />
          {day.deload && (
            <span className="gym-deload-badge" title="Lighter weights and fewer sets this week">
              <Icon name="arrowDown" size={13} strokeWidth={2.4} />
              Deload week
            </span>
          )}
          {pill && (
            <span className={`gym-day-status is-${pill.tone}`}>
              {pill.icon && <Icon name={pill.icon} size={13} strokeWidth={2.4} />}
              {pill.label}
            </span>
          )}
        </div>
        {notes.length > 0 && (
          <ul className="gym-day-notes">
            {notes.map((note) => (
              <li key={note.text}>
                <Icon name={note.icon} size={15} strokeWidth={2} />
                <span>{note.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hasSession && (
        <section aria-label="Workouts">
          <h3 className="gym-day-h">{daySessions.length === 1 ? 'Workout' : `${daySessions.length} workouts`}</h3>
          <ul className="gym-day-list">
            {daySessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                gym={gym}
                unit={unit}
                volume={volumeOf(session)}
                onOpen={() => openSession(session)}
              />
            ))}
          </ul>
        </section>
      )}

      {preview && (
        <RoutinePreview
          routine={preview}
          deload={day.deload}
          gym={gym}
          lookup={lookup}
          unit={unit}
          distanceUnit={distanceUnit}
          onEdit={() => {
            onClose()
            navigate(`gym/routine/${encodeURIComponent(preview.id)}`)
          }}
        />
      )}

      {!future && (
        <section aria-label="Log a workout">
          <h3 className="gym-day-h">{hasSession ? 'Log another workout' : isToday ? 'Train today' : 'Log this day'}</h3>
          <div className="gym-day-log">
            {gym.routines.length > 0 && (
              <div className="gym-day-picker" role="group" aria-label="Routine to log">
                {gym.routines.map((routine) => (
                  <button
                    key={routine.id}
                    type="button"
                    className="gym-day-pick"
                    aria-pressed={pickedId === routine.id}
                    style={{ '--gym-dot': routineColor(routine) }}
                    onClick={() => setPick(routine.id)}
                  >
                    <RoutineDot routine={routine} size={8} />
                    {routine.name.trim() || 'Untitled routine'}
                  </button>
                ))}
                <button type="button" className="gym-day-pick" aria-pressed={pickedId == null} onClick={() => setPick(null)}>
                  No routine
                </button>
              </div>
            )}
            <div className="gym-day-log-actions">
              <Button icon={past ? 'plus' : 'play'} onClick={begin}>
                {past ? 'Add past workout' : picked ? `Start ${picked.name.trim() || 'workout'}` : 'Start empty workout'}
              </Button>
              <Button variant="secondary" icon="check" onClick={logQuick}>Quick log: I trained</Button>
            </div>
            <p className="gym-day-hint">
              {past
                ? 'Add past workout lets you enter every set. Quick log just marks the day as trained.'
                : 'Quick log marks today as trained without entering sets.'}
            </p>
          </div>
        </section>
      )}

      {planEditable && (
        <section aria-label="Change the plan">
          <h3 className="gym-day-h">{isToday ? 'Change today' : 'Change this day'}</h3>
          <ul className="gym-hl-list">
            {canSkip && (
              <li>
                <ActionRow icon="skipForward" label="Skip or shift from here…" hint="Skip this day, or shift the plan a day later" onClick={() => setSub('skip')} />
              </li>
            )}
            <li>
              <ActionRow icon="shuffle" label="Change workout…" hint="Another routine or rest, this day only" onClick={() => setSub('change')} />
            </li>
            {canMove && (
              <li>
                <ActionRow
                  icon="calendar"
                  label="Move to another day…"
                  hint={`${slotLabel(day.shown, gym)} moves; this day becomes rest`}
                  chevron={false}
                  onClick={() => setMoving((current) => !current)}
                />
                {moving && (
                  <form className="gym-day-move" onSubmit={submitMove}>
                    <label className="sr-only" htmlFor={moveId}>Move to</label>
                    <input
                      id={moveId}
                      type="date"
                      className="input"
                      value={moveTo}
                      min={today}
                      onChange={(event) => setMoveTo(event.target.value)}
                    />
                    <Button type="submit" size="sm">Move</Button>
                  </form>
                )}
              </li>
            )}
            {hasChanges && (
              <li>
                <ActionRow icon="undo" label="Clear changes" hint="Remove the skip, shift or change on this day" chevron={false} onClick={clear} />
              </li>
            )}
          </ul>
        </section>
      )}

      <SkipSheet open={sub === 'skip'} onClose={() => setSub(null)} date={date} today={today} />
      <ChangeWorkoutSheet open={sub === 'change'} onClose={() => setSub(null)} date={date} today={today} />
    </div>
  )
}

function SessionItem({ session, gym, unit, volume, onOpen }) {
  const name = session.name?.trim() || 'Workout'
  const quick = !session.exercises.length
  const meta = quick
    ? 'Logged without details'
    : [clockLabel(session.startedAt), formatMinutes(sessionDurationSec(session)), volume > 0 ? formatVolume(volume, unit) : null].filter(Boolean).join(' · ')

  function remove() {
    const undo = deleteSession(session.id)
    toast(`Deleted “${name}”`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <li className="gym-day-session">
      <button type="button" className="gym-day-session-main" onClick={onOpen}>
        <SessionDot session={session} gym={gym} size={12} />
        <span className="gym-day-session-text">
          <strong>{name}</strong>
          <small>{meta || `${session.exercises.length} exercises`}</small>
        </span>
        <Icon name="chevronRight" size={18} className="gym-hl-chevron" />
      </button>
      <button type="button" className="icon-btn gym-day-session-delete" onClick={remove} aria-label={`Delete ${name}`} title="Delete">
        <Icon name="trash" size={18} />
      </button>
    </li>
  )
}

function RoutinePreview({ routine, deload, gym, lookup, unit, distanceUnit, onEdit }) {
  const rows = routine.exercises.filter((row) => row.exerciseId)
  const minutes = estimateMinutes(routine)
  return (
    <section aria-label={`${routine.name} preview`}>
      <h3 className="gym-day-h">
        {rows.length} exercise{rows.length === 1 ? '' : 's'}
        {minutes > 0 && ` · ~${minutes} min`}
        {deload && ' · deload'}
      </h3>
      {rows.length ? (
        <ul className="gym-day-list gym-day-preview">
          {rows.map((row) => {
            const shown = deload ? deloadTargets(row, lookup(row.exerciseId), gym.schedule, gym.prefs) : row
            return (
              <li key={row.id}>
                <span className="gym-day-ex">{row.name || lookup(row.exerciseId)?.name || 'Exercise'}</span>
                <span className="gym-day-ex-sets">{summarize(shown, unit, distanceUnit)}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="gym-day-empty">
          <span>This routine has no exercises yet.</span>
          <button type="button" className="link-btn" onClick={onEdit}>Add exercises</button>
        </div>
      )}
    </section>
  )
}

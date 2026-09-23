import { useEffect, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { formatDateLong, formatDuration as formatMinutes } from '../../lib/dates.js'
import { addDays, plannedFor, realign, resolveDay, versionFor } from '../../lib/gym/schedule.js'
import { bestSet, compareSessions, e1rm, sessionDurationSec, sessionPRs, sessionVolume, sessionWorkingSets } from '../../lib/gym/stats.js'
import { newGymId, realignTo, routineById, saveRoutine, slotLabel, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatDistance, formatDuration, formatNumber, formatPace, formatVolume, formatWeight } from '../../lib/gym/units.js'
import { Stat } from './common.jsx'
import { distanceUnitFor, fieldKeys, formatSetShort, setTypeOf, trackingOf, volumeLookup } from './ExerciseLog.jsx'
import './workout.css'

// After Finish: the workout's numbers, PRs and best sets, plus two optional follow-ups: copy
// today's changes into the routine, and realign a rotation after doing a different day.

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const isObject = (value) => !!value && typeof value === 'object'
const numOrNull = (value) => (isNum(value) ? value : null)
const firstNum = (...values) => values.find(isNum) ?? null
const rowsOf = (item) => (Array.isArray(item?.exercises) ? item.exercises.filter(isObject) : [])
const setsOf = (row) => (Array.isArray(row?.sets) ? row.sets.filter(isObject) : [])
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const workingCount = (row) => setsOf(row).filter((set) => set.done !== false && setTypeOf(set) !== 'warmup').length

function names(rows) {
  const list = rows.map((row) => row.name || 'exercise')
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`
}

// Pairs each performed exercise with the routine row it came from (by exercise, in order).
function matchRows(routineRows, sessionRows) {
  const queues = new Map()
  for (const row of routineRows) {
    if (!queues.has(row.exerciseId)) queues.set(row.exerciseId, [])
    queues.get(row.exerciseId).push(row)
  }
  return sessionRows.map((done) => ({ done, planned: queues.get(done.exerciseId)?.shift() || null }))
}

const usesWeight = (tracking) => fieldKeys(tracking).includes('weightKg')

// What differs between the routine and what was done: exercises, order, set counts, weights.
function routineChanges(routine, session) {
  const planned = rowsOf(routine)
  const done = rowsOf(session)
  const plannedIds = planned.map((row) => row.exerciseId)
  const doneIds = done.map((row) => row.exerciseId)
  const changes = []
  // Exercises skipped today stay in the routine, so only additions count.
  const added = done.filter((row) => !plannedIds.includes(row.exerciseId))
  if (added.length) changes.push(`Add ${names(added)}`)
  const keptDone = doneIds.filter((id) => plannedIds.includes(id))
  const keptPlanned = plannedIds.filter((id) => doneIds.includes(id))
  if (keptDone.join('\n') !== keptPlanned.join('\n')) changes.push('New exercise order')
  const setChanges = []
  let weightChanges = 0
  for (const { done: row, planned: source } of matchRows(planned, done)) {
    if (!source) continue
    const a = setsOf(source)
    const b = setsOf(row)
    if (a.length !== b.length) setChanges.push(`${row.name}: ${a.length} → ${plural(b.length, 'set')}`)
    else if (a.some((set, j) => setTypeOf(set) !== setTypeOf(b[j]))) setChanges.push(`${row.name}: set types`)
    if (usesWeight(row.tracking) && b.some((set, j) => isNum(set.weightKg) && !(isNum(a[j]?.weightKg) && Math.abs(a[j].weightKg - set.weightKg) < 1e-6))) weightChanges += 1
  }
  changes.push(...setChanges.slice(0, 2))
  if (setChanges.length > 2) changes.push(`Set changes on ${plural(setChanges.length - 2, 'more exercise')}`)
  if (weightChanges) changes.push(`New weights on ${plural(weightChanges, 'exercise')}`)
  return changes
}

// The routine with today's exercises, order, set counts and loads as its new targets. Rep targets
// are kept (a bad day must not turn 8–12 into a fixed 7, which would break progression); only a set
// with no rep target takes the reps done. Rest and notes stay, and exercises skipped today are kept
// where they were (a short session must not shrink the routine).
function updatedRoutine(routine, session) {
  const pairs = matchRows(rowsOf(routine), rowsOf(session))
  const updated = pairs.map(({ done, planned }) => {
    const tracking = trackingOf(done.tracking)
    const oldSets = setsOf(planned)
    const sets = setsOf(done).map((set, j) => {
      const type = setTypeOf(set)
      const old = (oldSets[j] && setTypeOf(oldSets[j]) === type ? oldSets[j] : oldSets.find((item) => setTypeOf(item) === type)) || oldSets[j] || null
      let repsMin = numOrNull(old?.repsMin)
      let repsMax = numOrNull(old?.repsMax)
      if (isNum(set.reps) && repsMin === null && repsMax === null) {
        repsMin = set.reps
        repsMax = set.reps
      }
      return {
        type,
        weightKg: firstNum(set.weightKg, old?.weightKg),
        repsMin,
        repsMax,
        durationSec: firstNum(set.durationSec, old?.durationSec),
        distanceM: firstNum(set.distanceM, old?.distanceM),
        rpe: numOrNull(old?.rpe),
      }
    })
    return {
      id: planned?.id ?? newGymId(),
      exerciseId: done.exerciseId,
      name: planned?.name || done.name || 'Exercise',
      tracking,
      restSec: planned ? planned.restSec ?? null : numOrNull(done.restSec),
      note: planned?.note ?? '',
      supersetId: done.supersetId ?? null,
      sets,
    }
  })
  const used = new Set(pairs.map((pair) => pair.planned).filter(Boolean))
  const exercises = [...updated]
  rowsOf(routine).forEach((row, index) => {
    if (!used.has(row)) exercises.splice(Math.min(index, exercises.length), 0, row)
  })
  return { ...routine, exercises }
}

function prText(pr, tracking, prefs) {
  const unit = prefs.unit
  switch (pr.type) {
    case 'heaviest':
    case 'e1rm':
    case 'repMax':
    case 'leastAssist': return formatWeight(pr.value, unit)
    case 'setVolume':
    case 'sessionVolume': return formatVolume(pr.value, unit)
    case 'mostReps':
    case 'sessionReps': return plural(Math.round(pr.value), 'rep')
    case 'longestDuration': return formatDuration(pr.value)
    case 'longestDistance': return formatDistance(pr.value, distanceUnitFor(tracking, prefs.distanceUnit))
    case 'bestPace': return formatPace(pr.value, prefs.distanceUnit)
    default: return formatNumber(pr.value)
  }
}

export default function WorkoutSummary({ session, onDone }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const today = useToday()
  const { prefs } = gym
  const unit = prefs.unit
  const current = sessions.find((item) => item.id === session?.id) || session
  const routine = routineById(gym, current?.routineId)

  const number = useMemo(() => Math.max(1, sessions.filter((item) => compareSessions(item, current) <= 0).length), [sessions, current])
  const prs = useMemo(() => (current ? sessionPRs(sessions, current, prefs.e1rmFormula) : []), [sessions, current, prefs.e1rmFormula])
  const volume = useMemo(() => (current ? sessionVolume(current, volumeLookup(gym)) : 0), [current, gym])
  const workingSets = current ? sessionWorkingSets(current) : 0
  const seconds = current ? sessionDurationSec(current) : null
  const trackingById = useMemo(() => new Map(rowsOf(current).map((row) => [row.exerciseId, trackingOf(row.tracking)])), [current])

  const prGroups = useMemo(() => {
    const groups = new Map()
    for (const pr of prs) {
      if (!groups.has(pr.exerciseId)) groups.set(pr.exerciseId, { exerciseId: pr.exerciseId, name: pr.name, items: [] })
      groups.get(pr.exerciseId).items.push(pr)
    }
    return [...groups.values()]
  }, [prs])

  // The floating Done button: toasts show above it.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('gym-has-float')
    return () => root.classList.remove('gym-has-float')
  }, [])

  const [routineChoice, setRoutineChoice] = useState(null)
  const [realignChoice, setRealignChoice] = useState(null)

  const changes = useMemo(() => (routine && current && !current.isDeload ? routineChanges(routine, current) : []), [routine, current])

  // "You did Pull on a Push day": rotation plans only, for a routine that is in the cycle.
  const realignInfo = useMemo(() => {
    if (!current?.routineId || current.date !== today) return null
    try {
      const version = versionFor(gym.schedule, today)
      if (!version || version.mode !== 'rotation' || !version.cycle.length) return null
      if (!version.cycle.some((slot) => slot?.kind === 'routine' && slot.routineId === current.routineId)) return null
      const day = resolveDay(gym, sessions, today, today)
      const shown = day.shown
      if (shown?.kind === 'routine' && shown.routineId === current.routineId) return null
      if (shown?.kind !== 'routine' && shown?.kind !== 'rest') return null
      // Today's planned workout was done as well: this one was an extra, not a swap.
      if (shown.kind === 'routine' && day.sessions.some((item) => item?.id !== current.id && item?.routineId === shown.routineId)) return null
      const preview = realign(gym.schedule, current.routineId, today)
      const next = preview?.versions?.[preview.versions.length - 1]
      const tomorrowSlot = next?.cycle?.[next.anchorIndex]
      if (!tomorrowSlot) return null
      const planned = plannedFor(gym.schedule, addDays(today, 1)).slot
      const same = planned?.kind === tomorrowSlot.kind && (planned.kind !== 'routine' || planned.routineId === tomorrowSlot.routineId)
      if (same) return null
      const plannedName = shown.kind === 'rest' ? '' : slotLabel(shown, gym)
      return {
        did: routine?.name?.trim() || current.name || 'this workout',
        on: shown.kind === 'rest' ? 'a rest day' : `${/^[aeiou]/i.test(plannedName) ? 'an' : 'a'} ${plannedName} day`,
        tomorrow: slotLabel(tomorrowSlot, gym),
      }
    } catch {
      return null
    }
  }, [current, today, gym, sessions, routine])

  if (!current) return null

  function updateRoutine() {
    const previous = routine
    try {
      saveRoutine(updatedRoutine(previous, current))
    } catch (error) {
      toast(error?.message || 'Couldn’t update the routine.', { tone: 'error' })
      return
    }
    setRoutineChoice('updated')
    toast(`${previous.name || 'Routine'} updated`, { tone: 'success', action: { label: 'Undo', onClick: () => saveRoutine(previous) } })
  }

  function doRealign() {
    let undo = null
    try {
      undo = realignTo(current.routineId)
    } catch (error) {
      toast(error?.message || 'Couldn’t change the plan.', { tone: 'error' })
      return
    }
    setRealignChoice('done')
    if (undo) toast(`Plan realigned · tomorrow is ${realignInfo.tomorrow}`, { tone: 'success', action: { label: 'Undo', onClick: undo } })
    else toast('Your plan already continues from here.')
  }

  const minutes = seconds !== null ? Math.max(1, Math.round(seconds / 60)) : null
  const showRoutinePrompt = !!routine && changes.length > 0 && !routineChoice
  const showRealign = !!realignInfo && !realignChoice

  return (
    <div className="gym-summary">
      <header className="gym-summary-hero">
        <span className={`gym-summary-medal${prs.length ? ' has-prs' : ''}`} aria-hidden="true">
          <Icon name={prs.length ? 'trophy' : 'check'} size={34} strokeWidth={2.2} />
        </span>
        <p className="eyebrow">Workout #{number}</p>
        <h1>{current.name || 'Workout'}</h1>
        <p className="page-subtitle">
          {formatDateLong(current.date)}
          {current.isDeload ? ' · Deload' : ''}
        </p>
        {prs.length > 0 && <p className="gym-summary-cheer">{prs.length === 1 ? 'New personal record!' : `${prs.length} new personal records!`}</p>}
      </header>

      <div className="gym-stat-grid gym-summary-stats">
        <Stat label="Duration" value={minutes !== null ? formatMinutes(minutes) : '—'} />
        <Stat label="Volume" value={formatVolume(volume, unit)} />
        <Stat label="Working sets" value={workingSets} />
        <Stat label="PRs" value={prs.length} />
      </div>

      {showRoutinePrompt && (
        <section className="gym-prompt" aria-labelledby="gym-prompt-routine">
          <div className="gym-prompt-head">
            <span className="gym-prompt-icon" aria-hidden="true"><Icon name="repeat" size={20} /></span>
            <div>
              <h2 id="gym-prompt-routine">Update {routine.name || 'routine'} with today’s changes?</h2>
              <ul className="gym-prompt-list">
                {changes.slice(0, 5).map((change) => <li key={change}>{change}</li>)}
              </ul>
            </div>
          </div>
          <div className="gym-prompt-actions">
            <button type="button" className="btn btn-secondary btn-grow" onClick={() => setRoutineChoice('kept')}>Keep routine</button>
            <button type="button" className="btn btn-primary btn-grow" onClick={updateRoutine}>Update targets</button>
          </div>
        </section>
      )}

      {showRealign && (
        <section className="gym-prompt" aria-labelledby="gym-prompt-realign">
          <div className="gym-prompt-head">
            <span className="gym-prompt-icon" aria-hidden="true"><Icon name="shuffle" size={20} /></span>
            <div>
              <h2 id="gym-prompt-realign">You did {realignInfo.did} on {realignInfo.on}</h2>
              <p>Realign your rotation so it carries on from here, or keep the plan as it is.</p>
            </div>
          </div>
          <div className="gym-prompt-actions">
            <button type="button" className="btn btn-secondary btn-grow" onClick={() => setRealignChoice('kept')}>Keep plan</button>
            <button type="button" className="btn btn-primary btn-grow" onClick={doRealign}>Realign (tomorrow = {realignInfo.tomorrow})</button>
          </div>
        </section>
      )}

      {prGroups.length > 0 && (
        <section className="card gym-summary-card" aria-labelledby="gym-summary-prs">
          <h2 id="gym-summary-prs" className="gym-summary-title">
            <Icon name="trophy" size={18} />
            Personal records
          </h2>
          <ul className="gym-summary-prs">
            {prGroups.map((group) => (
              <li key={group.exerciseId}>
                <strong>{group.name}</strong>
                <span className="gym-summary-badges">
                  {group.items.map((pr) => (
                    <span key={`${pr.type}-${pr.label}`} className="gym-pr-badge">
                      <Icon name="trophy" size={12} strokeWidth={2.4} />
                      {pr.label} {prText(pr, trackingById.get(group.exerciseId), prefs)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rowsOf(current).length > 0 && (
        <section className="card gym-summary-card" aria-labelledby="gym-summary-exercises">
          <h2 id="gym-summary-exercises" className="gym-summary-title">
            <Icon name="dumbbell" size={18} />
            Best sets
          </h2>
          <ul className="gym-summary-list">
            {rowsOf(current).map((row, index) => {
              const tracking = trackingOf(row.tracking)
              const best = bestSet(row, prefs.e1rmFormula)
              const bestText = formatSetShort(best, tracking, unit, prefs.distanceUnit, { withUnit: true })
              const oneRm = best && tracking === 'weight_reps' ? e1rm(best.weightKg, best.reps, prefs.e1rmFormula) : null
              const count = workingCount(row)
              return (
                <li key={row.id ?? index}>
                  <span className="gym-summary-ex">
                    <strong>{row.name || 'Exercise'}</strong>
                    <small>{plural(count, 'working set')}</small>
                  </span>
                  <span className="gym-summary-best">
                    <strong>{bestText || '—'}</strong>
                    {oneRm !== null && <small>e1RM {formatWeight(oneRm, unit)}</small>}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <div className="gym-summary-done">
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

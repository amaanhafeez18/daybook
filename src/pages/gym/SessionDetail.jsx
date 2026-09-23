import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { AutoTextarea, Button, Field, Skeleton } from '../../components/ui/primitives.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { addDaysISO, formatDateLong, formatDateShort, isISODate, nowTimeHHMM } from '../../lib/dates.js'
import { e1rm, isWorking, sessionDurationSec, sessionPRs, sessionVolume, sessionWorkingSets } from '../../lib/gym/stats.js'
import { deleteSession, latestBodyWeight, newGymId, routineById, saveRoutine, saveSession, useBodyWeights, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatVolume, formatWeight } from '../../lib/gym/units.js'
import { tokenUserId } from '../../lib/api.js'
import { navigate } from '../../lib/router.js'
import { useStore } from '../../lib/store.js'
import { GymEmpty, RoutineChip, SetTypeBadge, Stat, goBack } from './common.jsx'
import { beginWorkout } from './startWorkout.js'
import ExerciseLog from './ExerciseLog.jsx'
import { ActionRow, clockLabel, formatMinutes, formatPrValue, formatSetValue, showError, useExerciseLookup } from './HistoryTab.jsx'
import './history.css'

const EPS = 1e-6
const SET_TYPES = ['normal', 'warmup', 'drop', 'failure']
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const num = (value) => (isNum(value) ? value : null)
const selectLoading = (state) => !state.loaded || (state.syncing && !state.lastSyncedAt)

export default function SessionDetail({ param: sessionId, today: todayProp }) {
  const clock = useToday()
  const today = todayProp || clock
  const gym = useGym()
  const sessions = useGymSessions()
  const bodyWeights = useBodyWeights()
  const loading = useStore(selectLoading)
  const id = sessionId == null ? '' : String(sessionId)
  const session = useMemo(() => sessions.find((item) => String(item.id) === id) || null, [sessions, id])
  // Unsaved edits left behind (by navigating away mid-edit) reopen the editor.
  const [editing, setEditing] = useState(() => readStoredEdit(id) !== null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    setEditing(readStoredEdit(id) !== null)
    setLeaving(false)
  }, [id])

  if (!session) {
    if (leaving) return null
    if (loading) {
      return (
        <div className="gym-sd">
          <BackRow />
          <Skeleton lines={5} />
        </div>
      )
    }
    return (
      <div className="gym-sd">
        <BackRow />
        <GymEmpty
          icon="history"
          title="Workout not found"
          action={<Button variant="secondary" onClick={() => goBack('gym/history')}>Back to history</Button>}
        >
          It may have been deleted, or it hasn’t synced to this device yet.
        </GymEmpty>
      </div>
    )
  }

  if (editing) {
    return (
      <SessionEditor
        key={session.id}
        session={session}
        gym={gym}
        sessions={sessions}
        bodyWeights={bodyWeights}
        today={today}
        onDone={() => {
          setEditing(false)
          window.scrollTo({ top: 0 })
        }}
      />
    )
  }

  return (
    <SessionView
      session={session}
      gym={gym}
      sessions={sessions}
      bodyWeights={bodyWeights}
      today={today}
      onEdit={() => {
        setEditing(true)
        window.scrollTo({ top: 0 })
      }}
      onDeleted={() => setLeaving(true)}
    />
  )
}

function BackRow({ children }) {
  return (
    <div className="gym-sd-nav">
      <button type="button" className="gym-sd-back" onClick={() => goBack('gym/history')}>
        <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
        <span>Back</span>
      </button>
      {children}
    </div>
  )
}

// ---- view ------------------------------------------------------------------------------------

function SessionView({ session, gym, sessions, bodyWeights, today, onEdit, onDeleted }) {
  const { unit, distanceUnit, e1rmFormula: formula } = gym.prefs
  const lookup = useExerciseLookup(gym)
  const routine = routineById(gym, session.routineId)
  const quick = !session.exercises.length
  const prs = useMemo(() => (quick ? [] : sessionPRs(sessions, session, formula)), [quick, sessions, session, formula])
  const marks = useMemo(() => prMarks(session, prs, formula), [session, prs, formula])
  const volume = useMemo(() => sessionVolume(session, lookup), [session, lookup])
  const supersets = useMemo(() => supersetLabels(session.exercises), [session.exercises])
  const [sheet, setSheet] = useState(null) // 'routine' | 'duplicate'
  const prsTitle = useId()

  const minutes = formatMinutes(sessionDurationSec(session))
  const start = clockLabel(session.startedAt)
  const end = clockLabel(session.endedAt)
  const time = start ? (end && end !== start ? `${start} – ${end}` : start) : ''
  const bodyweight = num(session.bodyweightKg)
  const name = session.name?.trim() || 'Workout'
  const canStartAgain = !quick || !!routine
  const exerciseLabelsShown = new Set()

  function startAgain() {
    beginWorkout({ fromSession: quick ? null : session, routine: routine || null, date: today, today })
  }

  function remove() {
    const undo = deleteSession(session.id)
    onDeleted()
    toast(`Deleted “${name}”`, { action: { label: 'Undo', onClick: undo } })
    goBack('gym/history')
  }

  return (
    <div className="gym-sd">
      <BackRow>
        <Button variant="secondary" size="sm" icon="pencil" onClick={onEdit}>Edit</Button>
      </BackRow>

      <header className="gym-sd-header">
        <h1 className="gym-sd-title">{name}</h1>
        <p className="gym-sd-when">
          {formatDateLong(session.date)}
          {time && <span> · {time}</span>}
        </p>
        {(session.routineId != null || session.isDeload) && (
          <div className="gym-sd-tags">
            {session.routineId != null && <RoutineChip routine={routine} />}
            {session.isDeload && (
              <span className="gym-deload-badge">
                <Icon name="arrowDown" size={13} strokeWidth={2.4} />
                Deload
              </span>
            )}
          </div>
        )}
      </header>

      {quick ? (
        <section className="card gym-sd-quick">
          <span className="gym-sd-quick-icon" aria-hidden="true"><Icon name="check" size={22} strokeWidth={2.4} /></span>
          <div className="gym-sd-quick-text">
            <h2>Logged without details</h2>
            <p>This day counts as a workout. Add exercises and sets whenever you like.</p>
          </div>
          <Button variant="secondary" size="sm" icon="plus" onClick={onEdit}>Add details</Button>
        </section>
      ) : (
        <div className="gym-stat-grid gym-sd-stats">
          <Stat label="Duration" value={minutes || '—'} />
          <Stat label="Volume" value={volume > 0 ? formatVolume(volume, unit) : '—'} />
          <Stat label="Working sets" value={sessionWorkingSets(session)} />
          {bodyweight !== null && <Stat label="Body weight" value={formatWeight(bodyweight, unit)} />}
        </div>
      )}

      {session.note?.trim() && (
        <section className="card gym-sd-note" aria-label="Note">
          <Icon name="note" size={18} />
          <p className="preserve-lines">{session.note.trim()}</p>
        </section>
      )}

      {prs.length > 0 && (
        <section className="card gym-sd-prs" aria-labelledby={prsTitle}>
          <header className="gym-sd-prs-head">
            <span className="gym-sd-trophy" aria-hidden="true"><Icon name="trophy" size={18} strokeWidth={2} /></span>
            <h2 id={prsTitle}>{prs.length} personal record{prs.length === 1 ? '' : 's'}</h2>
          </header>
          <ul className="gym-sd-pr-list">
            {prs.map((pr, index) => (
              <li key={`${pr.exerciseId}-${pr.label}-${index}`}>
                <span className="gym-pr-badge">{pr.label}</span>
                <span className="gym-sd-pr-name">{pr.name || 'Exercise'}</span>
                <strong>{formatPrValue(pr, unit, distanceUnit)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!quick && (
        <ol className="gym-sd-exercises" aria-label="Exercises">
          {session.exercises.map((exercise, index) => {
            const superset = supersets.get(exercise)
            const exerciseLabels = !exerciseLabelsShown.has(exercise.exerciseId) ? marks.byExercise.get(exercise.exerciseId) : null
            exerciseLabelsShown.add(exercise.exerciseId)
            return (
              <ExerciseCard
                key={exercise.id ?? index}
                exercise={exercise}
                superset={superset}
                exerciseLabels={exerciseLabels}
                setLabels={marks.bySet}
                unit={unit}
                distanceUnit={distanceUnit}
              />
            )
          })}
        </ol>
      )}

      <ul className="gym-hl-list" aria-label="Workout actions">
        {canStartAgain && (
          <li><ActionRow icon="play" label="Start again" hint="Repeat this workout today" onClick={startAgain} /></li>
        )}
        {!quick && (
          <li><ActionRow icon="layers" label="Save as routine" hint="These sets become the targets" onClick={() => setSheet('routine')} /></li>
        )}
        <li><ActionRow icon="copy" label="Duplicate to another day…" onClick={() => setSheet('duplicate')} /></li>
        <li><ActionRow icon="trash" label="Delete workout" danger chevron={false} onClick={remove} /></li>
      </ul>

      <SaveRoutineSheet open={sheet === 'routine'} onClose={() => setSheet(null)} session={session} gym={gym} lookup={lookup} />
      <DuplicateSheet open={sheet === 'duplicate'} onClose={() => setSheet(null)} session={session} today={today} bodyWeights={bodyWeights} />
    </div>
  )
}

function resultLabel(tracking, unit, distanceUnit) {
  const w = unit === 'lb' ? 'lb' : 'kg'
  switch (tracking) {
    case 'bodyweight_reps':
    case 'reps_only': return 'Reps'
    case 'weighted_bodyweight': return `+${w} × reps`
    case 'assisted_bodyweight': return `−${w} × reps`
    case 'duration': return 'Time'
    case 'weight_duration': return `${w} · time`
    case 'distance_duration': return `${distanceUnit === 'mi' ? 'mi' : 'km'} · time`
    case 'weight_distance': return `${w} · ${distanceUnit === 'mi' ? 'yd' : 'm'}`
    default: return `${w} × reps`
  }
}

function PrMark({ labels }) {
  if (!labels?.length) return null
  return (
    <span className="gym-pr-badge gym-sd-set-pr">
      <span aria-hidden="true" className="gym-sd-set-pr-visual">
        <Icon name="trophy" size={11} strokeWidth={2.4} />
        {labels[0]}
        {labels.length > 1 && ` +${labels.length - 1}`}
      </span>
      <span className="sr-only">Personal record: {labels.join(', ')}</span>
    </span>
  )
}

function ExerciseCard({ exercise, superset, exerciseLabels, setLabels, unit, distanceUnit }) {
  const sets = (Array.isArray(exercise.sets) ? exercise.sets : []).filter((set) => set && set.done !== false)
  const showRpe = sets.some((set) => isNum(set.rpe))
  const showPr = sets.some((set) => setLabels.has(set))
  let normal = 0

  return (
    <li className={`card gym-sd-ex${superset ? ' is-superset' : ''}`}>
      <div className="gym-sd-ex-head">
        {superset && (
          <span className="gym-sd-ss" title={superset.circuit ? 'Circuit' : 'Superset'}>
            <span className="sr-only">{superset.circuit ? 'Circuit' : 'Superset'} </span>
            {superset.label}
          </span>
        )}
        {exercise.exerciseId ? (
          <button type="button" className="gym-sd-ex-name" onClick={() => navigate(`gym/exercise/${encodeURIComponent(exercise.exerciseId)}`)}>
            <span>{exercise.name || 'Exercise'}</span>
            <Icon name="chevronRight" size={16} strokeWidth={2.2} />
          </button>
        ) : (
          <span className="gym-sd-ex-name">{exercise.name || 'Exercise'}</span>
        )}
      </div>
      {exerciseLabels?.length > 0 && (
        <div className="gym-sd-ex-prs">
          {exerciseLabels.map((label) => (
            <span key={label} className="gym-pr-badge"><Icon name="trophy" size={11} strokeWidth={2.4} />{label}</span>
          ))}
        </div>
      )}
      {exercise.note?.trim() && <p className="gym-sd-ex-note">{exercise.note.trim()}</p>}
      {sets.length ? (
        <table className="gym-sd-table">
          <thead>
            <tr>
              <th scope="col" className="col-set">Set</th>
              <th scope="col">{resultLabel(exercise.tracking, unit, distanceUnit)}</th>
              {showRpe && <th scope="col" className="col-rpe">RPE</th>}
              {showPr && <th scope="col" className="col-pr"><span className="sr-only">Records</span></th>}
            </tr>
          </thead>
          <tbody>
            {sets.map((set, index) => {
              const type = SET_TYPES.includes(set.type) ? set.type : 'normal'
              if (type === 'normal') normal += 1
              return (
                <tr key={set.id ?? index} className={`is-${type}`}>
                  <td className="col-set"><SetTypeBadge type={type} number={type === 'normal' ? normal : undefined} /></td>
                  <td className="col-value">{formatSetValue(set, exercise.tracking, unit, distanceUnit)}</td>
                  {showRpe && <td className="col-rpe">{isNum(set.rpe) ? `@${set.rpe}` : ''}</td>}
                  {showPr && <td className="col-pr"><PrMark labels={setLabels.get(set)} /></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p className="gym-sd-empty-sets">No completed sets</p>
      )}
    </li>
  )
}

// ---- PR placement ------------------------------------------------------------------------------
// sessionPRs reports records per exercise; the trophy goes on the first working set that holds the
// value. Session-level records (session volume / reps) go on the exercise header.

const SESSION_LEVEL = new Set(['sessionVolume', 'sessionReps'])

function setMetric(type, set, formula) {
  const w = num(set.weightKg)
  const r = isNum(set.reps) && set.reps > 0 ? set.reps : null
  const d = isNum(set.durationSec) && set.durationSec > 0 ? set.durationSec : null
  const m = isNum(set.distanceM) && set.distanceM > 0 ? set.distanceM : null
  switch (type) {
    case 'heaviest': return w !== null && w > 0 ? w : null
    case 'e1rm': return w && r ? e1rm(w, r, formula) : null
    case 'setVolume': return w && r ? w * r : null
    case 'mostReps': return r
    case 'longestDuration': return d
    case 'longestDistance': return m
    case 'bestPace': return d && m && m >= 400 ? d / (m / 1000) : null
    default: return null
  }
}

function findPrSet(entries, pr, formula) {
  for (const exercise of entries) {
    for (const set of Array.isArray(exercise.sets) ? exercise.sets : []) {
      if (!isWorking(set)) continue
      if (pr.type === 'repMax' || pr.type === 'leastAssist') {
        if (set.reps === pr.reps && Math.abs(Math.max(0, num(set.weightKg) ?? 0) - pr.value) < EPS) return set
        continue
      }
      const value = setMetric(pr.type, set, formula)
      if (value !== null && Math.abs(value - pr.value) < EPS * Math.max(1, Math.abs(pr.value))) return set
    }
  }
  return null
}

function prMarks(session, prs, formula) {
  const bySet = new Map()
  const byExercise = new Map()
  const add = (map, key, label) => {
    if (!map.has(key)) map.set(key, [])
    if (!map.get(key).includes(label)) map.get(key).push(label)
  }
  for (const pr of prs) {
    const set = SESSION_LEVEL.has(pr.type) ? null : findPrSet(session.exercises.filter((exercise) => exercise.exerciseId === pr.exerciseId), pr, formula)
    if (set) add(bySet, set, pr.label)
    else add(byExercise, pr.exerciseId, pr.label)
  }
  return { bySet, byExercise }
}

// Exercises sharing a supersetId (2+ members) → { label: 'A1', circuit } keyed by the exercise object.
function supersetLabels(exercises) {
  const counts = new Map()
  for (const exercise of exercises) if (exercise.supersetId != null) counts.set(exercise.supersetId, (counts.get(exercise.supersetId) || 0) + 1)
  const letters = new Map()
  const seen = new Map()
  const out = new Map()
  for (const exercise of exercises) {
    const group = exercise.supersetId
    const size = group == null ? 0 : counts.get(group) || 0
    if (size < 2) continue
    if (!letters.has(group)) letters.set(group, String.fromCharCode(65 + (letters.size % 26)))
    const position = (seen.get(group) || 0) + 1
    seen.set(group, position)
    out.set(exercise, { label: `${letters.get(group)}${position}`, circuit: size >= 3 })
  }
  return out
}

// ---- save as routine / duplicate ---------------------------------------------------------------

function remapGroups() {
  const groups = new Map()
  return (old) => {
    if (old == null) return null
    if (!groups.has(old)) groups.set(old, newGymId())
    return groups.get(old)
  }
}

function routineFromSession(session, name, gym, lookup) {
  const groupId = remapGroups()
  const exercises = session.exercises
    .filter((exercise) => typeof exercise.exerciseId === 'string' && exercise.exerciseId)
    .map((exercise) => {
      const entry = lookup(exercise.exerciseId)
      const sets = (Array.isArray(exercise.sets) ? exercise.sets : [])
        .filter((set) => set && set.done !== false)
        .map((set) => ({
          type: SET_TYPES.includes(set.type) ? set.type : 'normal',
          weightKg: num(set.weightKg),
          repsMin: num(set.reps),
          repsMax: num(set.reps),
          durationSec: num(set.durationSec),
          distanceM: num(set.distanceM),
          rpe: num(set.rpe),
        }))
      return {
        id: newGymId(),
        exerciseId: exercise.exerciseId,
        name: exercise.name || entry?.name || 'Exercise',
        tracking: exercise.tracking || entry?.tracking || 'weight_reps',
        restSec: isNum(exercise.restSec) ? exercise.restSec : isNum(entry?.rest) ? entry.rest : gym.prefs.defaultRest,
        note: '',
        supersetId: groupId(exercise.supersetId),
        sets,
      }
    })
    .filter((exercise) => exercise.sets.length)
  return { name, notes: '', folderId: null, exercises }
}

function defaultRoutineName(session, gym) {
  const base = session.name?.trim() || 'Workout'
  const taken = new Set(gym.routines.map((routine) => routine.name.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
  return base
}

function SaveRoutineSheet({ open, onClose, session, gym, lookup }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(defaultRoutineName(session, gym))
    setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const kept = session.exercises.filter((exercise) => exercise.exerciseId && (exercise.sets || []).some((set) => set && set.done !== false))
  const setCount = kept.reduce((sum, exercise) => sum + exercise.sets.filter((set) => set && set.done !== false).length, 0)

  function save(event) {
    event?.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the routine a name.')
      return
    }
    try {
      const saved = saveRoutine(routineFromSession(session, trimmed, gym, lookup))
      onClose()
      toast(`Saved routine “${saved.name}”`, {
        tone: 'success',
        action: { label: 'Open', onClick: () => navigate(`gym/routine/${encodeURIComponent(saved.id)}`) },
      })
    } catch (failure) {
      showError(failure)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Save as routine"
      description="Each set becomes a target in the new routine."
      size="sm"
      footer={(
        <>
          <Button variant="secondary" className="btn-grow" onClick={onClose}>Cancel</Button>
          <Button className="btn-grow" onClick={save}>Save routine</Button>
        </>
      )}
    >
      <form className="form-stack" onSubmit={save}>
        <Field label="Routine name" error={error}>
          {(id) => (
            <input
              id={id}
              className="input"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError('')
              }}
              maxLength={60}
              autoComplete="off"
              enterKeyHint="done"
            />
          )}
        </Field>
        <p className="muted">
          {kept.length} exercise{kept.length === 1 ? '' : 's'} · {setCount} set{setCount === 1 ? '' : 's'}
        </p>
      </form>
    </Sheet>
  )
}

function duplicateSession(session, date, bodyWeights) {
  const groupId = remapGroups()
  const startMs = Date.parse(session.startedAt)
  const startedAt = Number.isFinite(startMs) ? new Date(`${date}T${nowTimeHHMM(new Date(startMs))}:00`).toISOString() : null
  const seconds = sessionDurationSec(session)
  const durationSec = isNum(seconds) ? Math.round(seconds) : null
  return {
    ...session,
    id: newGymId(),
    date,
    startedAt,
    endedAt: startedAt && durationSec !== null ? new Date(Date.parse(startedAt) + durationSec * 1000).toISOString() : null,
    durationSec,
    planned: null,
    bodyweightKg: latestBodyWeight(bodyWeights, date) ?? num(session.bodyweightKg),
    createdAt: new Date().toISOString(),
    exercises: session.exercises.map((exercise) => ({
      ...exercise,
      id: newGymId(),
      supersetId: groupId(exercise.supersetId),
      sets: (Array.isArray(exercise.sets) ? exercise.sets : []).filter((set) => set && set.done !== false).map((set) => ({ ...set, id: newGymId(), done: true })),
    })),
  }
}

function DuplicateSheet({ open, onClose, session, today, bodyWeights }) {
  const [date, setDate] = useState(today)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setDate(session.date === today ? addDaysISO(today, -1) : today)
    setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function submit(event) {
    event?.preventDefault()
    if (!isISODate(date)) {
      setError('Choose a date.')
      return
    }
    if (date > today) {
      setError('Pick today or an earlier day.')
      return
    }
    try {
      const saved = saveSession(duplicateSession(session, date, bodyWeights))
      onClose()
      toast(`Copied to ${formatDateShort(date)}`, {
        tone: 'success',
        action: { label: 'Open', onClick: () => navigate(`gym/session/${encodeURIComponent(saved.id)}`) },
      })
    } catch (failure) {
      showError(failure)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Duplicate workout"
      description="Copies every set to another day."
      size="sm"
      initialFocus={false}
      footer={(
        <>
          <Button variant="secondary" className="btn-grow" onClick={onClose}>Cancel</Button>
          <Button className="btn-grow" icon="copy" onClick={submit}>Duplicate</Button>
        </>
      )}
    >
      <form className="form-stack" onSubmit={submit}>
        <Field label="Date" error={error}>
          {(id) => (
            <input
              id={id}
              type="date"
              className="input"
              value={date}
              max={today}
              onChange={(event) => {
                setDate(event.target.value)
                setError('')
              }}
            />
          )}
        </Field>
      </form>
    </Sheet>
  )
}

// ---- edit ------------------------------------------------------------------------------------
// While editing, the draft is also kept in sessionStorage (per workout, this tab only, tied to the
// signed-in account), so leaving another way (tab bar, a reload) doesn't lose it.

const EDIT_KEY = 'daybook.gym.sessionDraft.'
const FORM_KEYS = ['name', 'date', 'time', 'minutes', 'note']

function readStoredEdit(sessionId) {
  if (!sessionId) return null
  try {
    const raw = sessionStorage.getItem(EDIT_KEY + sessionId)
    const saved = raw ? JSON.parse(raw) : null
    if (!saved || typeof saved !== 'object' || saved.user !== (tokenUserId() ?? null)) return null
    const { draft, form } = saved
    if (!draft || typeof draft !== 'object' || String(draft.id) !== String(sessionId) || !Array.isArray(draft.exercises)) return null
    if (!draft.exercises.every((exercise) => exercise && typeof exercise === 'object' && Array.isArray(exercise.sets) && exercise.sets.every((set) => set && typeof set === 'object'))) return null
    if (!form || typeof form !== 'object' || !FORM_KEYS.every((key) => typeof form[key] === 'string')) return null
    return { draft, form: Object.fromEntries(FORM_KEYS.map((key) => [key, form[key]])) }
  } catch {
    return null
  }
}

function writeStoredEdit(sessionId, draft, form) {
  try {
    sessionStorage.setItem(EDIT_KEY + sessionId, JSON.stringify({ user: tokenUserId() ?? null, draft, form }))
  } catch {
    // storage full or unavailable: the edits just live in memory
  }
}

function clearStoredEdit(sessionId) {
  try {
    sessionStorage.removeItem(EDIT_KEY + sessionId)
  } catch {
    // storage unavailable
  }
}

const formChangedFrom = (start, form) => FORM_KEYS.some((key) => form[key] !== start.form[key])
const exercisesChangedFrom = (start, draft) => draft.exercises !== start.draft.exercises && JSON.stringify(draft.exercises) !== JSON.stringify(start.draft.exercises)

function toDraft(session) {
  return {
    ...session,
    rest: null,
    exercises: session.exercises.map((exercise) => ({
      ...exercise,
      id: exercise.id ?? newGymId(),
      sets: (Array.isArray(exercise.sets) ? exercise.sets : [])
        .filter((set) => set && typeof set === 'object')
        .map((set) => ({ ...set, id: set.id ?? newGymId(), done: set.done !== false, target: null })),
    })),
  }
}

function initialForm(session) {
  const startMs = Date.parse(session.startedAt)
  const seconds = sessionDurationSec(session)
  return {
    name: session.name || '',
    date: session.date,
    time: Number.isFinite(startMs) ? nowTimeHHMM(new Date(startMs)) : '',
    minutes: isNum(seconds) ? String(Math.round(seconds / 60)) : '',
    note: session.note || '',
  }
}

const hasValue = (set) => [set.weightKg, set.reps, set.durationSec, set.distanceM].some(isNum)

// Only completed sets are saved; exercises left without any are dropped.
function cleanExercises(list) {
  let dropped = 0
  const exercises = []
  for (const exercise of Array.isArray(list) ? list : []) {
    if (!exercise || typeof exercise !== 'object') continue
    const sets = []
    for (const set of Array.isArray(exercise.sets) ? exercise.sets : []) {
      if (!set || typeof set !== 'object') continue
      if (!set.done) {
        if (hasValue(set)) dropped += 1
        continue
      }
      const { target, prs, ...rest } = set // eslint-disable-line no-unused-vars
      sets.push({ ...rest, id: rest.id ?? newGymId(), done: true })
    }
    if (sets.length) exercises.push({ ...exercise, sets })
  }
  return { exercises, dropped }
}

function SessionEditor({ session, gym, sessions, bodyWeights, today, onDone }) {
  const [start] = useState(() => ({ draft: toDraft(session), form: initialForm(session) }))
  // Edits stored earlier for this workout, if they still differ from it.
  const [restored] = useState(() => {
    const saved = readStoredEdit(session.id)
    return saved && (formChangedFrom(start, saved.form) || exercisesChangedFrom(start, saved.draft)) ? saved : null
  })
  const [draft, setDraft] = useState(() => restored?.draft || start.draft)
  const [form, setForm] = useState(() => restored?.form || start.form)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const restoreToastShown = useRef(false)
  const others = useMemo(() => sessions.filter((item) => item.id !== session.id), [sessions, session.id])
  const formChanged = formChangedFrom(start, form)
  const exercisesChanged = useMemo(() => exercisesChangedFrom(start, draft), [draft, start])
  const dirty = formChanged || exercisesChanged
  const sessionId = session.id

  // Marks the page while editing (the floating workout pill hides, so a stray tap can't leave).
  useEffect(() => {
    const root = document.documentElement
    mounted.current = true
    root.classList.add('gym-editing')
    return () => {
      mounted.current = false
      root.classList.remove('gym-editing')
    }
  }, [])

  // Keep unsaved edits in sessionStorage; drop them once nothing differs from the workout.
  useEffect(() => {
    if (dirty) writeStoredEdit(sessionId, draft, form)
    else clearStoredEdit(sessionId)
  }, [sessionId, dirty, draft, form])

  // Restored edits get a toast with a way back to the saved workout.
  useEffect(() => {
    if (!restored || restoreToastShown.current) return
    restoreToastShown.current = true
    toast('Restored your unsaved changes', {
      duration: 7000,
      action: {
        label: 'Discard',
        onClick: () => {
          clearStoredEdit(sessionId)
          if (!mounted.current) return
          setDraft(start.draft)
          setForm(start.form)
          onDone()
        },
      },
    })
  }, [restored, sessionId, start, onDone])

  // ExerciseLog may hand back the next workout or an updater, like setState.
  const onLogChange = useCallback((next) => {
    setDraft((current) => (typeof next === 'function' ? next(current) : next))
  }, [])

  const setField = (key) => (event) => {
    const value = event.target.value
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'date' && isISODate(value)) setDraft((current) => ({ ...current, date: value }))
  }

  async function cancel() {
    if (busy) return
    if (dirty) {
      setBusy(true)
      const discard = await confirmAction({ title: 'Discard changes?', message: 'Your edits to this workout won’t be saved.', confirmLabel: 'Discard' })
      setBusy(false)
      if (!discard) return
    }
    clearStoredEdit(sessionId)
    onDone()
  }

  async function save() {
    if (busy) return
    try {
      const { date } = form
      if (!isISODate(date)) throw new Error('Choose a valid date.')
      if (date > today) throw new Error('A workout can’t be dated in the future.')
      let durationSec = null
      const minutesText = form.minutes.trim().replace(',', '.')
      if (minutesText) {
        const minutes = Number(minutesText)
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error('Enter the duration in minutes (0–1440).')
        durationSec = Math.round(minutes * 60)
      }
      let startedAt = null
      if (form.time) {
        const start = new Date(`${date}T${form.time.slice(0, 5)}:00`)
        if (Number.isNaN(start.getTime())) throw new Error('Enter a valid start time.')
        startedAt = start.toISOString()
      }
      const endedAt = startedAt && durationSec !== null ? new Date(Date.parse(startedAt) + durationSec * 1000).toISOString() : null
      const { exercises, dropped } = cleanExercises(draft.exercises)
      if (!exercises.length && session.exercises.length) {
        setBusy(true)
        const ok = await confirmAction({
          title: 'No completed sets',
          message: 'Save this workout without any sets? The day still counts as a workout.',
          confirmLabel: 'Save',
          tone: 'primary',
        })
        setBusy(false)
        if (!ok) return
      }
      const bodyweightKg = date !== session.date ? latestBodyWeight(bodyWeights, date) ?? num(session.bodyweightKg) : num(session.bodyweightKg)
      saveSession({
        ...session,
        name: form.name.trim() || session.name?.trim() || 'Workout',
        date,
        startedAt,
        endedAt,
        durationSec,
        note: form.note.trim(),
        exercises,
        bodyweightKg,
      })
      clearStoredEdit(sessionId)
      toast(dropped ? `Workout saved · ${dropped} unticked set${dropped === 1 ? '' : 's'} left out` : 'Workout saved', { tone: 'success' })
      onDone()
    } catch (failure) {
      setBusy(false)
      showError(failure)
    }
  }

  return (
    <div className="gym-sd is-editing">
      <div className="gym-sd-editbar">
        <button type="button" className="gym-sd-back gym-sd-cancel" onClick={cancel}>Cancel</button>
        <h1 className="gym-sd-edit-title">Edit workout</h1>
        <Button size="sm" onClick={save} disabled={busy}>Save</Button>
      </div>

      <section className="card gym-sd-form" aria-label="Workout details">
        <Field label="Name">
          {(id) => (
            <input id={id} className="input" value={form.name} onChange={setField('name')} placeholder="Workout" maxLength={80} autoComplete="off" enterKeyHint="done" />
          )}
        </Field>
        <div className="field-row">
          <Field label="Date">
            {(id) => <input id={id} type="date" className="input" value={form.date} max={today} onChange={setField('date')} required />}
          </Field>
          <Field label="Start time">
            {(id) => <input id={id} type="time" className="input" value={form.time} onChange={setField('time')} />}
          </Field>
        </div>
        <Field label="Duration (minutes)">
          {(id) => (
            <input
              id={id}
              className="input gym-sd-minutes"
              inputMode="numeric"
              pattern="[0-9]*"
              value={form.minutes}
              onChange={setField('minutes')}
              placeholder="—"
              autoComplete="off"
              enterKeyHint="done"
            />
          )}
        </Field>
        <Field label="Note">
          {(id) => <AutoTextarea id={id} value={form.note} onChange={setField('note')} placeholder="How did it go?" minRows={2} maxRows={8} />}
        </Field>
      </section>

      <ExerciseLog workout={draft} onChange={onLogChange} mode="edit" gym={gym} sessions={others} />

      <div className="gym-sd-edit-foot">
        <Button variant="secondary" className="btn-grow" onClick={cancel} disabled={busy}>Cancel</Button>
        <Button className="btn-grow" icon="check" onClick={save} disabled={busy}>Save changes</Button>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { AutoTextarea, Field } from '../../components/ui/primitives.jsx'
import { isISODate, nowTimeHHMM } from '../../lib/dates.js'
import { isBackfillWorkout, sessionVolume, sessionWorkingSets } from '../../lib/gym/stats.js'
import { discardActive, finishActive, latestBodyWeight, newGymId, routineById, useBodyWeights, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { formatVolume } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { fillFromPlaceholder, missingKeys, normalizeSupersets, setTypeOf, trackingOf, volumeLookup, workoutPlaceholders } from './ExerciseLog.jsx'
import './workout.css'

// Finishing a workout: settle sets that were filled in but never ticked, catch an empty workout,
// then confirm name, date, start time, duration and a note, and save a clean Session.

const VALUE_KEYS = ['weightKg', 'reps', 'durationSec', 'distanceM']
// A running clock longer than this is a forgotten workout, not a real duration (as WorkoutPill).
const LIVE_LIMIT_SEC = 6 * 60 * 60
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const numOrNull = (value) => (isNum(value) ? value : null)
const exercisesOf = (workout) => (Array.isArray(workout?.exercises) ? workout.exercises.filter((row) => row && typeof row === 'object') : [])
const setsOf = (exercise) => (Array.isArray(exercise?.sets) ? exercise.sets.filter((set) => set && typeof set === 'object') : [])
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// An unticked set the user typed something into, with its other fields taken from the grid's
// placeholders exactly as ✓ would; null when nothing was typed (an untouched set is just dropped).
function filledSet(set, tracking, placeholders) {
  if (!VALUE_KEYS.some((key) => isNum(set[key]))) return null
  return fillFromPlaceholder(set, tracking, placeholders?.get(set))
}

// done: ticked sets; filled: unticked sets ✓ would accept; partial: unticked with values still missing.
function countSets(workout, placeholders) {
  let done = 0
  let filled = 0
  let partial = 0
  for (const exercise of exercisesOf(workout)) {
    const tracking = trackingOf(exercise.tracking)
    for (const set of setsOf(exercise)) {
      if (set.done) {
        done += 1
        continue
      }
      const values = filledSet(set, tracking, placeholders)
      if (!values) continue
      if (!missingKeys(tracking, values).length) filled += 1
      else partial += 1
    }
  }
  return { done, filled, partial }
}

// Only completed sets (plus the filled ones, placeholders applied, when the user chose to mark them
// done), stripped of the in-progress fields; exercises left without sets are dropped.
function keptExercises(workout, markFilled, placeholders) {
  const out = []
  for (const exercise of exercisesOf(workout)) {
    const tracking = trackingOf(exercise.tracking)
    const sets = setsOf(exercise)
      .map((set) => {
        if (set.done) return set
        if (!markFilled) return null
        const values = filledSet(set, tracking, placeholders)
        return values && !missingKeys(tracking, values).length ? values : null
      })
      .filter(Boolean)
      .map((set) => ({
        id: set.id ?? newGymId(),
        type: setTypeOf(set),
        weightKg: numOrNull(set.weightKg),
        reps: numOrNull(set.reps),
        durationSec: numOrNull(set.durationSec),
        distanceM: numOrNull(set.distanceM),
        rpe: numOrNull(set.rpe),
        done: true,
      }))
    if (!sets.length) continue
    out.push({
      id: exercise.id ?? newGymId(),
      exerciseId: exercise.exerciseId,
      name: exercise.name || 'Exercise',
      tracking,
      restSec: numOrNull(exercise.restSec),
      note: typeof exercise.note === 'string' ? exercise.note.trim() : '',
      supersetId: exercise.supersetId ?? null,
      sets,
    })
  }
  return normalizeSupersets(out)
}

function defaultForm(workout, gym, today) {
  const routine = routineById(gym, workout?.routineId)
  const name = (typeof workout?.name === 'string' && workout.name.trim()) || routine?.name?.trim() || 'Workout'
  const startMs = Date.parse(workout?.startedAt)
  const validStart = Number.isFinite(startMs)
  const elapsed = validStart ? Math.round((Date.now() - startMs) / 1000) : null
  // A backfilled past workout (its start is a stand-in noon) or one left running for hours has no
  // meaningful elapsed time: the duration defaults to 60 min instead. One past midnight is fine.
  const live = !isBackfillWorkout(workout)
  const exactSec = live && elapsed !== null && elapsed > 0 && elapsed < LIVE_LIMIT_SEC ? elapsed : null
  return {
    name,
    date: isISODate(workout?.date) ? workout.date : today,
    time: nowTimeHHMM(validStart ? new Date(startMs) : new Date()),
    minutes: String(exactSec !== null ? Math.max(1, Math.round(exactSec / 60)) : 60),
    note: typeof workout?.note === 'string' ? workout.note : '',
    exactSec,
  }
}

function localStart(date, time) {
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0)
}

function validate(form, today) {
  const errors = {}
  if (!isISODate(form.date)) errors.date = 'Choose a date.'
  else if (form.date > today) errors.date = 'A workout can’t be in the future.'
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(form.time)) errors.time = 'Choose a start time.'
  const text = String(form.minutes).trim()
  const minutes = Number(text)
  if (!/^\d+$/.test(text) || minutes < 1 || minutes > 1440) errors.minutes = 'Enter 1 to 1440 minutes.'
  if (!errors.date && !errors.time && localStart(form.date, form.time).getTime() > Date.now() + 60000) errors.time = 'That time hasn’t happened yet.'
  return Object.keys(errors).length ? errors : null
}

function buildSession(workout, form, initial, { markFilled, bodyWeights, placeholders }) {
  const keepStart = form.date === initial.date && form.time === initial.time && Number.isFinite(Date.parse(workout.startedAt))
  const startedAt = keepStart ? workout.startedAt : localStart(form.date, form.time).toISOString()
  const keepDuration = String(form.minutes).trim() === initial.minutes && initial.exactSec !== null
  const durationSec = keepDuration ? initial.exactSec : Number(String(form.minutes).trim()) * 60
  const sameDay = form.date === workout.date
  const planned = workout.planned && typeof workout.planned === 'object' ? workout.planned : null
  return {
    id: workout.id ?? newGymId(),
    date: form.date,
    name: form.name.trim() || 'Workout',
    routineId: workout.routineId ?? null,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationSec * 1000).toISOString(),
    durationSec,
    exercises: keptExercises(workout, markFilled, placeholders),
    note: form.note.trim(),
    // The plan snapshot belongs to the day it was started on.
    planned: sameDay ? planned : planned ? { ...planned, cycleIndex: null } : null,
    bodyweightKg: sameDay && isNum(workout.bodyweightKg) ? workout.bodyweightKg : latestBodyWeight(bodyWeights, form.date),
    isDeload: !!workout.isDeload,
    createdAt: workout.createdAt || new Date().toISOString(),
  }
}

export default function FinishSheet({ open, onClose, workout, onFinished }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const bodyWeights = useBodyWeights()
  const today = useToday()
  const shown = useRef(workout)
  if (workout) shown.current = workout
  const current = shown.current

  const [step, setStep] = useState('form') // 'unticked' | 'empty' | 'form'
  const [markFilled, setMarkFilled] = useState(false)
  const [form, setForm] = useState(() => defaultForm(current, gym, today))
  const [errors, setErrors] = useState({})
  const initial = useRef(form)

  // What ✓ would fill into each empty field, so unticked sets settle the way the grid shows them.
  const placeholders = useMemo(() => (open && current ? workoutPlaceholders(current, gym, sessions) : null), [open, current, gym, sessions])
  const counts = useMemo(() => countSets(current, placeholders), [current, placeholders])

  useEffect(() => {
    if (!open) return
    const defaults = defaultForm(shown.current, gym, today)
    initial.current = defaults
    setForm(defaults)
    setErrors({})
    setMarkFilled(false)
    const start = countSets(shown.current, shown.current ? workoutPlaceholders(shown.current, gym, sessions) : null)
    setStep(start.filled > 0 ? 'unticked' : start.done === 0 ? 'empty' : 'form')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => {
    const exercises = keptExercises(current, markFilled, placeholders)
    const session = { exercises, bodyweightKg: current?.bodyweightKg ?? null }
    return { sets: sessionWorkingSets(session), volume: sessionVolume(session, volumeLookup(gym)), exercises: exercises.length }
  }, [current, markFilled, placeholders, gym])

  const setField = (key) => (event) => {
    const value = event.target.value
    setForm((previous) => ({ ...previous, [key]: value }))
    if (errors[key]) setErrors((previous) => ({ ...previous, [key]: undefined }))
  }

  function choose(mark) {
    setMarkFilled(mark)
    setStep(counts.done + (mark ? counts.filled : 0) === 0 ? 'empty' : 'form')
  }

  function discard() {
    discardActive()
    onClose?.()
    navigate('gym')
    toast('Workout discarded')
  }

  function save() {
    const problems = validate(form, today)
    if (problems) {
      setErrors(problems)
      return
    }
    if (!current) return
    let saved
    try {
      saved = finishActive(buildSession(current, form, initial.current, { markFilled, bodyWeights, placeholders: placeholders || workoutPlaceholders(current, gym, sessions) }))
    } catch (error) {
      toast(error?.message || 'Couldn’t save the workout.', { tone: 'error' })
      return
    }
    onFinished?.(saved)
  }

  const titles = { unticked: 'Unfinished sets', empty: 'Nothing logged', form: 'Finish workout' }
  const dropped = counts.partial + (markFilled ? 0 : counts.filled)

  return (
    <Sheet
      open={open && !!current}
      onClose={onClose}
      title={titles[step]}
      size="sm"
      initialFocus={false}
      footer={step === 'form' ? (
        <>
          <button type="button" className="btn btn-secondary btn-grow" onClick={onClose}>Keep logging</button>
          <button type="button" className="btn btn-primary btn-grow" onClick={save}>
            <Icon name="check" size={18} strokeWidth={2.4} />
            Save workout
          </button>
        </>
      ) : null}
    >
      {step === 'unticked' && (
        <div className="gym-finish-step">
          <span className="gym-finish-icon" aria-hidden="true"><Icon name="alert" size={26} /></span>
          <p>
            {counts.filled === 1 ? '1 set has values but isn’t ticked.' : `${counts.filled} sets have values but aren’t ticked.`}
            {counts.partial > 0 && ` ${plural(counts.partial, 'set')} missing values will be left out.`}
          </p>
          <div className="gym-finish-choices">
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => choose(true)}>
              Mark {plural(counts.filled, 'filled set')} done
            </button>
            <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={() => choose(false)}>{counts.filled === 1 ? 'Drop it' : 'Drop them'}</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>Keep logging</button>
          </div>
        </div>
      )}

      {step === 'empty' && (
        <div className="gym-finish-step">
          <span className="gym-finish-icon is-danger" aria-hidden="true"><Icon name="dumbbell" size={26} /></span>
          <p>Nothing logged. Discard this workout?</p>
          <p className="gym-finish-sub">No sets are ticked yet, so there’s nothing to save.</p>
          <div className="gym-finish-choices">
            <button type="button" className="btn btn-danger btn-lg btn-block" onClick={discard}>Discard workout</button>
            <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={onClose}>Keep logging</button>
          </div>
        </div>
      )}

      {step === 'form' && (
        <div className="form-stack gym-finish-form">
          <div className="gym-finish-summary" aria-label="What will be saved">
            <span><strong>{preview.sets}</strong> {preview.sets === 1 ? 'set' : 'sets'}</span>
            <span><strong>{formatVolume(preview.volume, gym.prefs.unit)}</strong></span>
            <span><strong>{preview.exercises}</strong> {preview.exercises === 1 ? 'exercise' : 'exercises'}</span>
          </div>
          {dropped > 0 && (
            <p className="gym-finish-sub">{plural(dropped, 'unticked set')} won’t be saved.</p>
          )}
          <Field label="Name">
            {(id) => (
              <input id={id} className="input" value={form.name} onChange={setField('name')} placeholder="Workout" autoComplete="off" enterKeyHint="done" maxLength={80} />
            )}
          </Field>
          <div className="field-row">
            <Field label="Date" error={errors.date}>
              {(id) => <input id={id} type="date" className="input" value={form.date} max={today} onChange={setField('date')} />}
            </Field>
            <Field label="Start" error={errors.time}>
              {(id) => <input id={id} type="time" className="input" value={form.time} onChange={setField('time')} />}
            </Field>
          </div>
          <Field label="Duration" error={errors.minutes}>
            {(id) => (
              <div className="gym-finish-minutes">
                <input
                  id={id}
                  className="input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={form.minutes}
                  onChange={setField('minutes')}
                  autoComplete="off"
                  enterKeyHint="done"
                />
                <span aria-hidden="true">min</span>
              </div>
            )}
          </Field>
          <Field label="Note">
            {(id) => <AutoTextarea id={id} value={form.note} onChange={setField('note')} placeholder="How did it go?" minRows={2} maxRows={8} />}
          </Field>
        </div>
      )}
    </Sheet>
  )
}

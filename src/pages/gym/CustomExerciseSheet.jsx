import { useEffect, useId, useState } from 'react'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { Button, Field, Segmented } from '../../components/ui/primitives.jsx'
import { EQUIPMENT, MUSCLES, allExercises } from '../../lib/gym/library.js'
import { newGymId, saveCustomExercise, useGym } from '../../lib/gym/state.js'
import { formatDuration } from '../../lib/gym/units.js'
import './exercises.css'

// Plain-language tracking types, with examples, in the order people usually need them.
export const TRACKING_OPTIONS = [
  { id: 'weight_reps', label: 'Weight and reps', example: 'bench press, curls', logs: 'the weight and reps of each set' },
  { id: 'bodyweight_reps', label: 'Bodyweight reps', example: 'push-ups, pull-ups', logs: 'reps only; your body is the weight' },
  { id: 'weighted_bodyweight', label: 'Bodyweight + added weight', example: 'weighted dips', logs: 'the extra weight and reps' },
  { id: 'assisted_bodyweight', label: 'Bodyweight with assistance', example: 'assisted pull-ups', logs: 'the assistance weight and reps' },
  { id: 'reps_only', label: 'Reps only', example: 'band pull-aparts', logs: 'reps only' },
  { id: 'duration', label: 'Time', example: 'plank, dead hang', logs: 'how long each set lasts' },
  { id: 'weight_duration', label: 'Weight and time', example: 'weighted plank', logs: 'the weight and how long you hold it' },
  { id: 'distance_duration', label: 'Distance and time', example: 'running, rowing', logs: 'distance and time' },
  { id: 'weight_distance', label: 'Weight and distance', example: "farmer's walk, sled push", logs: 'the weight and distance' },
]
const TRACKING_BY_ID = Object.fromEntries(TRACKING_OPTIONS.map((option) => [option.id, option]))
export const trackingName = (id) => TRACKING_BY_ID[id]?.label || 'Weight and reps'

export const CATEGORY_OPTIONS = [
  { id: 'compound', label: 'Compound' },
  { id: 'isolation', label: 'Isolation' },
  { id: 'cardio', label: 'Cardio' },
]
const CATEGORY_REST = { compound: 120, isolation: 90, cardio: 0 }

// A new exercise's rest starts from Gym settings' Default rest: compound exercises get it,
// isolation about a quarter less (2:00 gives 1:30), and cardio starts with the timer off.
function categoryRest(category, defaultRest) {
  const base = Number.isFinite(defaultRest) && defaultRest >= 0 ? defaultRest : CATEGORY_REST.compound
  if (category === 'cardio') return 0
  return category === 'isolation' ? Math.round((base * 0.75) / 15) * 15 : base
}

// Rest choices in seconds (0 = timer off), plus the current value if it's something else.
const REST_STEPS = [0, 30, 45, 60, 75, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 600]
export const restText = (sec) => (sec > 0 ? formatDuration(sec) : 'Off')
export function restChoices(current) {
  const list = [...REST_STEPS]
  if (Number.isFinite(current) && current >= 0 && !list.includes(current)) list.push(current)
  return list.sort((a, b) => a - b)
}

const PULL = new Set(['lats', 'upper_back', 'lower_back', 'traps', 'biceps', 'forearms'])
const LEGS = new Set(['quads', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors'])
function movementFor(primary, category) {
  if (category === 'cardio' || primary === 'cardio') return 'cardio'
  if (primary === 'abs') return 'core'
  if (LEGS.has(primary)) return 'legs'
  return PULL.has(primary) ? 'pull' : 'push'
}

const blank = (name = '', defaultRest) => ({
  name,
  primary: 'chest',
  secondary: [],
  equipment: 'machine',
  tracking: 'weight_reps',
  category: 'compound',
  rest: categoryRest('compound', defaultRest),
  restTouched: false,
})

// Create (no `exercise`) or edit a custom exercise. onSaved gets the saved entry.
export default function CustomExerciseSheet({ open, onClose, exercise = null, onSaved, initialName = '' }) {
  const gym = useGym()
  const formId = useId()
  const [draft, setDraft] = useState(() => blank())
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    if (exercise) {
      setDraft({
        name: exercise.name || '',
        primary: exercise.primary || 'chest',
        secondary: Array.isArray(exercise.secondary) ? exercise.secondary : [],
        equipment: exercise.equipment || 'machine',
        tracking: TRACKING_BY_ID[exercise.tracking] ? exercise.tracking : 'weight_reps',
        category: CATEGORY_REST[exercise.category] !== undefined ? exercise.category : 'compound',
        rest: Number.isFinite(exercise.rest) ? exercise.rest : CATEGORY_REST[exercise.category] ?? 120,
        restTouched: true,
      })
    } else {
      setDraft(blank(initialName.trim(), gym.prefs.defaultRest))
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

  const setCategory = (category) => setDraft((current) => ({
    ...current,
    category,
    rest: current.restTouched ? current.rest : categoryRest(category, gym.prefs.defaultRest),
  }))

  const toggleSecondary = (id) => setDraft((current) => ({
    ...current,
    secondary: current.secondary.includes(id) ? current.secondary.filter((item) => item !== id) : [...current.secondary, id],
  }))

  const save = (event) => {
    event?.preventDefault()
    const name = draft.name.trim().replace(/\s+/g, ' ')
    if (!name) {
      setError('Give the exercise a name.')
      return
    }
    const clash = allExercises(gym.exercises).find((entry) => entry.id !== exercise?.id && entry.name.trim().toLowerCase() === name.toLowerCase())
    if (clash) {
      setError(clash.custom ? 'You already have an exercise with this name.' : 'This exercise is already in the library.')
      return
    }
    try {
      const saved = saveCustomExercise({
        ...(exercise || {}),
        id: exercise?.id || `custom-${newGymId()}`,
        name,
        primary: draft.primary,
        secondary: draft.secondary.filter((muscle) => muscle !== draft.primary),
        equipment: draft.equipment,
        category: draft.category,
        movement: movementFor(draft.primary, draft.category),
        tracking: draft.tracking,
        rest: draft.rest,
        custom: true,
      })
      toast(exercise ? 'Exercise updated' : `Added ${name} to your exercises`, { tone: 'success' })
      onSaved?.(saved)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'Could not save the exercise.')
    }
  }

  const tracking = TRACKING_BY_ID[draft.tracking]

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={exercise ? 'Edit exercise' : 'New exercise'}
      size="md"
      footer={(
        <>
          <Button variant="secondary" className="btn-grow" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} className="btn-grow">{exercise ? 'Save' : 'Create'}</Button>
        </>
      )}
    >
      <form id={formId} className="form-stack gym-cx" onSubmit={save} noValidate>
        <Field label="Name" error={error}>
          {(id) => (
            <input
              id={id}
              className="input"
              value={draft.name}
              onChange={(event) => {
                set({ name: event.target.value })
                if (error) setError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) save(event)
              }}
              placeholder="e.g. Cable Y-Raise"
              autoCapitalize="words"
              autoComplete="off"
              enterKeyHint="done"
              maxLength={80}
            />
          )}
        </Field>

        <div className="field-row">
          <Field label="Main muscle">
            {(id) => (
              <select id={id} className="input" value={draft.primary} onChange={(event) => set({ primary: event.target.value })}>
                {MUSCLES.map((muscle) => <option key={muscle.id} value={muscle.id}>{muscle.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Equipment">
            {(id) => (
              <select id={id} className="input" value={draft.equipment} onChange={(event) => set({ equipment: event.target.value })}>
                {EQUIPMENT.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="field">
          <span className="field-label" id={`${formId}-secondary`}>Also works <span className="gym-cx-optional">optional</span></span>
          <div className="chip-row gym-cx-chips" role="group" aria-labelledby={`${formId}-secondary`}>
            {MUSCLES.filter((muscle) => muscle.id !== draft.primary && muscle.id !== 'cardio').map((muscle) => {
              const on = draft.secondary.includes(muscle.id)
              return (
                <button key={muscle.id} type="button" className={`chip chip-sm${on ? ' is-active' : ''}`} aria-pressed={on} onClick={() => toggleSecondary(muscle.id)}>
                  {muscle.label}
                </button>
              )
            })}
          </div>
          <p className="field-hint">Secondary muscles count as half a set in your weekly stats.</p>
        </div>

        <Field label="What you log" hint={tracking ? `Each set records ${tracking.logs}. Like ${tracking.example}.` : undefined}>
          {(id) => (
            <select id={id} className="input" value={draft.tracking} onChange={(event) => set({ tracking: event.target.value })}>
              {TRACKING_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          )}
        </Field>

        <div className="field">
          <span className="field-label">Type</span>
          <Segmented options={CATEGORY_OPTIONS} value={draft.category} onChange={setCategory} label="Exercise type" />
          <p className="field-hint">
            {draft.category === 'compound' ? 'Moves several joints, like a squat or row.'
              : draft.category === 'isolation' ? 'Targets one joint, like a curl or leg extension.'
                : 'Conditioning work; the rest timer is off by default.'}
          </p>
        </div>

        <Field label="Rest timer" hint="Starts after each set. You can still change it per routine.">
          {(id) => (
            <select id={id} className="input" value={draft.rest} onChange={(event) => set({ rest: Number(event.target.value), restTouched: true })}>
              {restChoices(draft.rest).map((sec) => <option key={sec} value={sec}>{restText(sec)}</option>)}
            </select>
          )}
        </Field>
        {exercise && <p className="field-hint">Changes apply to future workouts. Past workouts keep what you logged.</p>}
      </form>
    </Sheet>
  )
}

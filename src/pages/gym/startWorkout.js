import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { todayISO } from '../../lib/dates.js'
import { exerciseById } from '../../lib/gym/library.js'
import { isDeload, plannedFor, resolveDay } from '../../lib/gym/schedule.js'
import { deloadTargets, plannedWeight } from '../../lib/gym/stats.js'
import { discardActive, getActiveWorkout, getGym, latestBodyWeight, newGymId, normalizeGym, routineById, startWorkout } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import { getState } from '../../lib/store.js'
import { unlockAudio } from './RestTimer.jsx'

// Builds the in-progress workout from a routine, a past session or nothing (empty workout), and
// starts it. Set values stay empty (null): the grid shows previous → suggestion → target as
// placeholders, so only the targets are copied here.

const SET_TYPES = new Set(['normal', 'warmup', 'drop', 'failure'])
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [])

// First usable rest (seconds, 0–600) among the candidates.
function restOf(...candidates) {
  for (const value of candidates) {
    const n = num(value)
    if (n !== null && n >= 0) return Math.min(600, Math.round(n))
  }
  return 120
}

function activeSet(type, target) {
  return {
    id: newGymId(),
    type: SET_TYPES.has(type) ? type : 'normal',
    weightKg: null,
    reps: null,
    durationSec: null,
    distanceM: null,
    rpe: null,
    done: false,
    target,
  }
}

// A routine row's own rest wins (the routine editor sets it); the exercise's saved rest is the
// default for rows without one. A past session's rest is only a snapshot, so the saved one wins.
function exerciseRow(source, gym, sets, { fromRoutine = false } = {}) {
  const entry = exerciseById(source.exerciseId, gym.exercises)
  const meta = gym.exerciseMeta[source.exerciseId]
  const rest = fromRoutine
    ? restOf(source.restSec, meta?.restSec, entry?.rest, gym.prefs.defaultRest)
    : restOf(meta?.restSec, source.restSec, entry?.rest, gym.prefs.defaultRest)
  return {
    id: newGymId(),
    exerciseId: source.exerciseId,
    name: (entry?.custom ? entry.name : '') || source.name || entry?.name || 'Exercise',
    tracking: source.tracking || entry?.tracking || 'weight_reps',
    restSec: rest,
    note: '',
    supersetId: source.supersetId ?? null,
    sets,
  }
}

// In a deload week, working sets without a target weight (template routines have none) get the
// lightened weight the gym Today list shows (plannedWeight), so the grid pre-fills it rather than
// last week's full load. Drop sets keep their own (lightened previous) weight in the grid.
function fromRoutine(routine, gym, deload, sessions) {
  return list(routine.exercises)
    .filter((row) => typeof row.exerciseId === 'string' && row.exerciseId)
    .map((row) => {
      const entry = exerciseById(row.exerciseId, gym.exercises)
      const source = deload ? deloadTargets(row, entry, gym.schedule, gym.prefs) : row
      let lighter = null
      if (deload) {
        try {
          const plan = plannedWeight(sessions, row, entry, gym.prefs, gym.exerciseMeta[row.exerciseId], { routineId: routine.id, deload, schedule: gym.schedule })
          if (plan.deloaded) lighter = plan.weightKg
        } catch {
          lighter = null
        }
      }
      const sets = list(source?.sets).map((set) => activeSet(set.type, {
        weightKg: num(set.weightKg) ?? (set.type === 'normal' || set.type === 'failure' || !SET_TYPES.has(set.type) ? lighter : null),
        repsMin: num(set.repsMin),
        repsMax: num(set.repsMax),
        durationSec: num(set.durationSec),
        distanceM: num(set.distanceM),
        rpe: num(set.rpe),
      }))
      return exerciseRow(row, gym, sets, { fromRoutine: true })
    })
}

// A past session re-run: what was done becomes the target; only completed sets are copied.
function fromPastSession(session, gym) {
  return list(session.exercises)
    .filter((exercise) => typeof exercise.exerciseId === 'string' && exercise.exerciseId)
    .map((exercise) => {
      const sets = list(exercise.sets)
        .filter((set) => set.done !== false)
        .map((set) => activeSet(set.type, {
          weightKg: num(set.weightKg),
          repsMin: num(set.reps),
          repsMax: num(set.reps),
          durationSec: num(set.durationSec),
          distanceM: num(set.distanceM),
          rpe: num(set.rpe),
        }))
      return exerciseRow(exercise, gym, sets)
    })
}

// → ActiveWorkout. `routine` may be a Routine or its id; `date` defaults to today.
export function buildWorkout({ gym: rawGym, sessions, bodyWeights, routine: routineOrId = null, date, today, fromSession = null, name } = {}) {
  const gym = normalizeGym(rawGym ?? getGym())
  const state = getState()
  const allSessions = sessions ?? state.data.gymSessions
  const weights = bodyWeights ?? state.data.bodyWeights
  const now = today || todayISO()
  const day = date || now
  const routine = typeof routineOrId === 'string' ? routineById(gym, routineOrId) : routineOrId
  const deload = isDeload(gym.schedule, day, gym.prefs.firstWeekday)

  let exercises = []
  if (fromSession && typeof fromSession === 'object') exercises = fromPastSession(fromSession, gym)
  else if (routine) exercises = fromRoutine(routine, gym, deload, allSessions)

  const routineId = routine?.id ?? (fromSession?.routineId && routineById(gym, fromSession.routineId) ? fromSession.routineId : null)
  const plan = plannedFor(gym.schedule, day)
  const versionId = plan.version?.id ?? null
  let planned = versionId || routineId ? { versionId, routineId, cycleIndex: null } : null
  if (routineId && day === now) {
    const shown = resolveDay(gym, allSessions, day, now).shown
    if (shown.kind === 'routine' && shown.routineId === routineId) planned = { versionId, routineId, cycleIndex: plan.cycleIndex }
  }

  const stamp = new Date().toISOString()
  // A past day is a backfill: it starts at noon that day and has no running clock (isBackfillWorkout).
  const backfill = day < now
  const startedAt = backfill ? new Date(`${day}T12:00:00`).toISOString() : stamp
  const title = typeof name === 'string' && name.trim()
    ? name.trim()
    : routine?.name?.trim() || (fromSession && typeof fromSession.name === 'string' ? fromSession.name.trim() : '') || 'Workout'

  return {
    id: newGymId(),
    date: day,
    name: title,
    routineId,
    startedAt,
    endedAt: null,
    durationSec: null,
    exercises,
    note: '',
    planned,
    bodyweightKg: latestBodyWeight(weights, day),
    isDeload: deload,
    createdAt: stamp,
    status: 'active',
    updatedAt: stamp,
    editingSessionId: null,
    rest: null,
    backfill,
  }
}

// Call from a tap handler: unlocks audio for the rest timer, asks what to do with a workout
// that is already running (Resume opens it, closing the dialog does nothing), starts the new one
// and opens it. Resolves to the new workout or null.
export async function beginWorkout(args = {}) {
  try {
    unlockAudio()
  } catch {
    // audio is optional
  }
  const current = getActiveWorkout()
  if (current) {
    // true = discard, false = the Resume button, null = dismissed (backdrop, Escape, close).
    const discard = await confirmAction({
      title: 'Workout in progress',
      message: `Resume ${current.name || 'your workout'} or discard it and start a new one?`,
      confirmLabel: 'Discard & start new',
      cancelLabel: 'Resume',
    })
    if (discard == null) return null
    if (!discard) {
      navigate('gym/workout')
      return null
    }
    discardActive()
  }
  try {
    const workout = buildWorkout({ ...args, gym: args.gym || getGym(), today: args.today || todayISO() })
    startWorkout(workout)
    navigate('gym/workout')
    return workout
  } catch (error) {
    toast(error?.message || 'Couldn’t start the workout.', { tone: 'error' })
    return null
  }
}

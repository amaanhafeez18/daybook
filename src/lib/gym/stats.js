// Derived gym numbers: e1RM, volume, records/PRs, progression, plate and warm-up calculators,
// weekly aggregates and CSV export. Pure; every read path tolerates malformed stored sessions
// (missing arrays, strings where numbers belong) by ignoring the bad parts instead of throwing.
import { exerciseById } from './library.js'
import { addDays, isIsoDate, weekStart } from './schedule.js'
import { LB, formatNumber, fromKg, toKg } from './units.js'

const EPS = 1e-9
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const pos = (value) => {
  const n = num(value)
  return n !== null && n > 0 ? n : null
}
const str = (value) => (typeof value === 'string' ? value : '')
const sessionList = (sessions) => (Array.isArray(sessions) ? sessions.filter(isObject) : [])
const exercisesOf = (session) => (isObject(session) && Array.isArray(session.exercises) ? session.exercises.filter(isObject) : [])
const setsOf = (exercise) => (isObject(exercise) && Array.isArray(exercise.sets) ? exercise.sets.filter(isObject) : [])
const weekdayOf = (firstWeekday) => (Number.isInteger(firstWeekday) && firstWeekday >= 0 && firstWeekday <= 6 ? firstWeekday : 1)
const defaultLookup = (id) => exerciseById(id)
// Own-property lookup, so stored strings like 'constructor' never hit Object.prototype.
const own = (object, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined)

const WEIGHT_UP = new Set(['weight_reps', 'weighted_bodyweight', 'weight_duration', 'weight_distance'])
const TRACKINGS = new Set([...WEIGHT_UP, 'bodyweight_reps', 'reps_only', 'assisted_bodyweight', 'duration', 'distance_duration'])
// First known tracking type among the candidates (snapshot, library entry…), else weight_reps.
const trackingOf = (...candidates) => candidates.find((value) => TRACKINGS.has(value)) || 'weight_reps'

// ---- ordering ------------------------------------------------------------------------------

const timeOf = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : -Infinity
}
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Chronological: date, then startedAt, then createdAt and id so the order is total.
export function compareSessions(a, b) {
  return order(str(a?.date), str(b?.date))
    || order(timeOf(a?.startedAt), timeOf(b?.startedAt))
    || order(timeOf(a?.createdAt), timeOf(b?.createdAt))
    || order(String(a?.id ?? ''), String(b?.id ?? ''))
}

// Sessions sorted oldest first plus, per exerciseId, one group per session (duplicate entries of
// the same exercise in a session are merged). Cached per array identity: the store replaces the
// array on every edit, so a stale index is never served.
const indexCache = new WeakMap()

function indexSessions(sessions) {
  if (Array.isArray(sessions) && indexCache.has(sessions)) return indexCache.get(sessions)
  const sorted = sessionList(sessions).sort(compareSessions)
  const byExercise = new Map()
  for (const session of sorted) {
    const groups = new Map()
    for (const exercise of exercisesOf(session)) {
      const id = exercise.exerciseId
      if (typeof id !== 'string' || !id) continue
      let group = groups.get(id)
      if (!group) {
        group = { session, exercise, sets: [] }
        groups.set(id, group)
        if (!byExercise.has(id)) byExercise.set(id, [])
        byExercise.get(id).push(group)
      }
      group.sets.push(...setsOf(exercise))
    }
  }
  const index = { sorted, byExercise, records: new Map() }
  if (Array.isArray(sessions)) indexCache.set(sessions, index)
  return index
}

// ---- e1RM ----------------------------------------------------------------------------------

const FORMULAS = {
  brzycki: (w, r) => (w * 36) / (37 - r),
  epley: (w, r) => w * (1 + r / 30),
  lombardi: (w, r) => w * r ** 0.1,
  oconner: (w, r) => w * (1 + 0.025 * r),
  wathan: (w, r) => (100 * w) / (48.8 + 53.8 * Math.exp(-0.075 * r)),
}

// null when not computable: no weight, 0 reps or more than 12. With useRir the reps are topped up
// by the reps left in reserve (10 − RPE), capped at 12.
export function e1rm(weightKg, reps, formula = 'brzycki', rpe = null, useRir = false) {
  const w = num(weightKg)
  const r = num(reps)
  if (w === null || r === null || w <= 0 || r <= 0 || r > 12) return null
  let effective = r
  const effort = num(rpe)
  if (useRir && effort !== null && effort > 0 && effort <= 10) effective = Math.min(12, r + (10 - effort))
  if (effective === 1) return w
  return (own(FORMULAS, formula) || FORMULAS.brzycki)(w, effective)
}

// Brzycki inverse: the weight for `reps` reps given a 1RM.
export function projectedWeight(oneRm, reps) {
  const w = num(oneRm)
  const n = num(reps)
  if (w === null || n === null || w <= 0 || n < 1 || n >= 37) return null
  return n === 1 ? w : (w * (37 - n)) / 36
}

// ---- volume and counts ---------------------------------------------------------------------

export function isWorking(set) {
  return isObject(set) && set.type !== 'warmup' && Boolean(set.done)
}

// Working sets only. Dumbbell weight is per dumbbell and never doubled.
export function setVolume(set, tracking, bodyweightKg, bwVolume) {
  if (!isWorking(set)) return 0
  const w = Math.max(0, num(set.weightKg) ?? 0)
  const r = Math.max(0, num(set.reps) ?? 0)
  const bw = bwVolume ? pos(bodyweightKg) : null
  switch (trackingOf(tracking)) {
    case 'weight_reps': return w * r
    case 'bodyweight_reps': return bw ? bw * r : 0
    case 'weighted_bodyweight': return (bw ? bw + w : w) * r
    case 'assisted_bodyweight': return bw ? Math.max(0, bw - w) * r : 0
    default: return 0
  }
}

// exerciseLookup(id) → library/custom entry (for bwVolume); pass null to leave bodyweight out.
export function sessionVolume(session, exerciseLookup = defaultLookup) {
  let total = 0
  for (const exercise of exercisesOf(session)) {
    const entry = typeof exerciseLookup === 'function' ? exerciseLookup(exercise.exerciseId) : null
    const tracking = trackingOf(exercise.tracking, entry?.tracking)
    for (const set of setsOf(exercise)) total += setVolume(set, tracking, session.bodyweightKg, Boolean(entry?.bwVolume))
  }
  return total
}

export function sessionWorkingSets(session) {
  let count = 0
  for (const exercise of exercisesOf(session)) count += setsOf(exercise).filter(isWorking).length
  return count
}

export function sessionReps(session) {
  let total = 0
  for (const exercise of exercisesOf(session)) {
    for (const set of setsOf(exercise)) if (isWorking(set)) total += pos(set.reps) ?? 0
  }
  return total
}

// Seconds: the stored duration, else endedAt − startedAt; null when unknown.
export function sessionDurationSec(session) {
  if (!isObject(session)) return null
  const stored = num(session.durationSec)
  if (stored !== null && stored >= 0) return stored
  const span = (timeOf(session.endedAt) - timeOf(session.startedAt)) / 1000
  return Number.isFinite(span) && span > 0 ? span : null
}

// An active workout started for an earlier day ('Add past workout'), not one running now: flagged
// by buildWorkout, or (started before the flag existed) created over a minute after its startedAt.
// A live workout that runs past midnight is not a backfill. (WorkoutPill.jsx keeps a copy of this
// rule so the main bundle doesn't load this module.)
export function isBackfillWorkout(workout) {
  if (!isObject(workout)) return false
  if (workout.backfill === true) return true
  const created = timeOf(workout.createdAt)
  const started = timeOf(workout.startedAt)
  return Number.isFinite(created) && Number.isFinite(started) && created - started > 60000
}

// ---- best set ------------------------------------------------------------------------------

// Ranking key per tracking type, compared element by element (higher wins); null = not rankable.
function setKey(set, tracking, formula) {
  const w = num(set.weightKg)
  const r = pos(set.reps)
  const d = pos(set.durationSec)
  const m = pos(set.distanceM)
  switch (tracking) {
    case 'bodyweight_reps':
    case 'reps_only': return r ? [r] : null
    case 'weighted_bodyweight': return r ? [w ?? 0, r] : null
    case 'assisted_bodyweight': return r ? [-(w ?? 0), r] : null
    case 'duration': return d ? [d] : null
    case 'weight_duration': return d ? [w ?? 0, d] : null
    case 'distance_duration': return m || d ? [m ?? 0, d ?? 0] : null
    case 'weight_distance': return m || w ? [w ?? 0, m ?? 0] : null
    default: {
      if (!r) return null
      // Sets above 12 reps have no e1RM; rank them as if at 12 so 100×15 still beats 50×5.
      const score = w && w > 0 ? e1rm(w, Math.min(r, 12), formula) : 0
      return [score ?? 0, w ?? 0, r]
    }
  }
}

function keyGreater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i] + EPS) return true
    if (a[i] < b[i] - EPS) return false
  }
  return false
}

// Top working set by e1RM for weight_reps, else by reps/duration/distance per tracking type.
export function bestSet(sessionExercise, formula = 'brzycki') {
  const tracking = trackingOf(sessionExercise?.tracking)
  let best = null
  let bestKey = null
  for (const set of setsOf(sessionExercise)) {
    if (!isWorking(set)) continue
    const key = setKey(set, tracking, formula)
    if (key && (!bestKey || keyGreater(key, bestKey))) {
      best = set
      bestKey = key
    }
  }
  return best
}

// ---- history and records -------------------------------------------------------------------

// Every occurrence of the exercise, newest session first.
export function exerciseHistory(sessions, exerciseId) {
  const out = []
  const { sorted } = indexSessions(sessions)
  for (let i = sorted.length - 1; i >= 0; i--) {
    for (const exercise of exercisesOf(sorted[i])) {
      if (exercise.exerciseId === exerciseId) out.push({ session: sorted[i], exercise })
    }
  }
  return out
}

// Which records each tracking type keeps (spec "PR definitions").
const METRICS = {
  weight_reps: ['heaviest', 'e1rm', 'setVolume', 'sessionVolume', 'repMax'],
  bodyweight_reps: ['mostReps', 'sessionReps'],
  reps_only: ['mostReps', 'sessionReps'],
  weighted_bodyweight: ['heaviest', 'mostReps', 'repMax', 'sessionReps'],
  assisted_bodyweight: ['leastAssist', 'mostReps', 'sessionReps'],
  duration: ['longestDuration'],
  weight_duration: ['heaviest', 'longestDuration'],
  distance_duration: ['longestDistance', 'longestDuration', 'bestPace'],
  weight_distance: ['heaviest', 'longestDistance'],
}
const LOWER_IS_BETTER = new Set(['bestPace', 'leastAssist'])
const SCALARS = ['heaviest', 'e1rm', 'setVolume', 'sessionVolume', 'mostReps', 'sessionReps', 'longestDuration', 'longestDistance', 'bestPace']
const SET_LEVEL = ['heaviest', 'e1rm', 'repMax', 'setVolume', 'mostReps', 'longestDuration', 'longestDistance', 'bestPace', 'leastAssist']
const LABELS = {
  heaviest: 'Weight',
  e1rm: 'e1RM',
  setVolume: 'Volume',
  sessionVolume: 'Session volume',
  mostReps: 'Reps',
  sessionReps: 'Session reps',
  longestDuration: 'Duration',
  longestDistance: 'Distance',
  bestPace: 'Pace',
}
const repLabel = (type, reps) => (type === 'repMax' ? `${reps}RM` : `Assist ×${reps}`)
const beats = (value, record, lower) => (lower ? value < record - EPS : value > record + EPS)

const emptyRecords = () => ({
  heaviest: null, e1rm: null, setVolume: null, sessionVolume: null, repMax: {}, mostReps: null, sessionReps: null,
  longestDuration: null, longestDistance: null, bestPace: null, leastAssist: {},
})

// groups: [{ session, sets }] oldest first. The first session to reach a value keeps the record,
// so a later tie never takes it over.
function aggregate(groups, tracking, formula) {
  const keys = new Set(own(METRICS, tracking) || METRICS.weight_reps)
  const records = emptyRecords()
  for (const { session, sets } of groups) {
    const stamp = { date: isObject(session) && typeof session.date === 'string' ? session.date : null, sessionId: session?.id ?? null }
    const put = (key, value) => {
      if (value === null || !keys.has(key)) return
      const current = records[key]
      if (!current || beats(value, current.value, LOWER_IS_BETTER.has(key))) records[key] = { value, ...stamp }
    }
    const putRep = (key, reps, weightKg) => {
      if (!keys.has(key) || !Number.isInteger(reps) || reps < 1 || (key === 'repMax' && reps > 15)) return
      const current = records[key][reps]
      if (!current || beats(weightKg, current.value, key === 'leastAssist')) records[key][reps] = { value: weightKg, weightKg, reps, ...stamp }
    }
    let volume = 0
    let reps = 0
    for (const set of sets) {
      if (!isWorking(set)) continue
      const w = num(set.weightKg)
      const r = pos(set.reps)
      const d = pos(set.durationSec)
      const m = pos(set.distanceM)
      const loaded = w !== null && w > 0 ? w : null
      if (tracking === 'weight_reps' || tracking === 'weighted_bodyweight') {
        if (r && loaded) {
          put('heaviest', loaded)
          putRep('repMax', r, loaded)
        }
      } else if (tracking === 'weight_duration') {
        if (d && loaded) put('heaviest', loaded)
      } else if (tracking === 'weight_distance') {
        if (m && loaded) put('heaviest', loaded)
      }
      if (tracking === 'weight_reps' && r && loaded) {
        put('e1rm', e1rm(loaded, r, formula))
        put('setVolume', loaded * r)
        volume += loaded * r
      }
      if (tracking === 'assisted_bodyweight' && r) putRep('leastAssist', r, Math.max(0, w ?? 0))
      if (r) {
        put('mostReps', r)
        reps += r
      }
      if (d) put('longestDuration', d)
      if (m) put('longestDistance', m)
      if (d && m && m >= 400) put('bestPace', d / (m / 1000))
    }
    if (volume > 0) put('sessionVolume', volume)
    if (reps > 0) put('sessionReps', reps)
  }
  return records
}

// The given tracking type if valid, else the newest valid snapshot among the groups.
function groupTracking(groups, tracking) {
  if (TRACKINGS.has(tracking)) return tracking
  for (let i = groups.length - 1; i >= 0; i--) if (TRACKINGS.has(groups[i].exercise?.tracking)) return groups[i].exercise.tracking
  return 'weight_reps'
}

// All records for an exercise across `sessions`; each { value, date, sessionId } or null.
// repMax[r] / leastAssist[r] = { value, weightKg, reps, date, sessionId }.
export function computeRecords(sessions, exerciseId, tracking, formula = 'brzycki') {
  const index = indexSessions(sessions)
  const groups = index.byExercise.get(exerciseId) || []
  const type = groupTracking(groups, tracking)
  const cacheKey = `${exerciseId}\u0000${type}\u0000${formula}`
  if (!index.records.has(cacheKey)) index.records.set(cacheKey, aggregate(groups, type, formula))
  return index.records.get(cacheKey)
}

// PR entries where `current` strictly beats `before`. A record with no earlier value to beat is a
// baseline, not a PR (so the first session of an exercise, or of a rep count, never shows one).
function diffRecords(before, current, keys) {
  const out = []
  for (const key of keys) {
    if (key === 'repMax' || key === 'leastAssist') {
      for (const [reps, record] of Object.entries(current[key])) {
        const previous = before[key][reps]
        if (previous && beats(record.value, previous.value, key === 'leastAssist')) {
          out.push({ type: key, label: repLabel(key, Number(reps)), value: record.value, reps: Number(reps) })
        }
      }
    } else if (current[key] && before[key] && beats(current[key].value, before[key].value, LOWER_IS_BETTER.has(key))) {
      out.push({ type: key, label: LABELS[key], value: current[key].value })
    }
  }
  return out
}

// PRs `session` set against strictly-earlier sessions (by date, then startedAt). Warm-ups never
// count. `session` may be an unsaved or edited copy; a stored row with the same id is skipped.
export function sessionPRs(sessions, session, formula = 'brzycki') {
  if (!isObject(session)) return []
  const index = indexSessions(sessions)
  const own = new Map()
  for (const exercise of exercisesOf(session)) {
    const id = exercise.exerciseId
    if (typeof id !== 'string' || !id) continue
    if (!own.has(id)) own.set(id, { exercise, sets: [] })
    own.get(id).sets.push(...setsOf(exercise))
  }
  const out = []
  for (const [exerciseId, { exercise, sets }] of own) {
    const earlier = (index.byExercise.get(exerciseId) || [])
      .filter((group) => (session.id == null || group.session.id !== session.id) && compareSessions(group.session, session) < 0)
    if (!earlier.length) continue
    const tracking = groupTracking(earlier, exercise.tracking)
    const before = aggregate(earlier, tracking, formula)
    const current = aggregate([{ session, sets }], tracking, formula)
    for (const pr of diffRecords(before, current, [...SCALARS, 'repMax', 'leastAssist'])) {
      out.push({ exerciseId, name: str(exercise.name), ...pr })
    }
  }
  return out
}

// Labels ('Weight', 'e1RM', '5RM', …) a just-completed set beats versus all saved sessions.
export function livePRs(sessions, exerciseId, tracking, set, formula = 'brzycki') {
  if (!isWorking(set)) return []
  const records = computeRecords(sessions, exerciseId, tracking, formula)
  const type = groupTracking(indexSessions(sessions).byExercise.get(exerciseId) || [], tracking)
  const current = aggregate([{ session: null, sets: [set] }], type, formula)
  return diffRecords(records, current, SET_LEVEL).map((pr) => pr.label)
}

// Sets (warm-ups included, in order) of the newest session containing the exercise; with
// source 'routine' only sessions of `routineId` count.
export function previousSets(sessions, exerciseId, options = {}) {
  const { routineId = null, source = 'any' } = options || {}
  const { sorted } = indexSessions(sessions)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const session = sorted[i]
    if (source === 'routine' && routineId && session.routineId !== routineId) continue
    for (const exercise of exercisesOf(session)) {
      if (exercise.exerciseId !== exerciseId) continue
      const sets = setsOf(exercise).filter((set) => set.done)
      if (sets.length) return sets
    }
  }
  return null
}

// ---- progression ---------------------------------------------------------------------------

const LOWER_BODY = new Set(['quads', 'hamstrings', 'glutes', 'lower_back'])
// [kg, lb] per equipment; anything else (bodyweight, band) uses the barbell step.
const LOAD_STEP = { barbell: [2.5, 5], smith_machine: [2.5, 5], dumbbell: [2, 5], kettlebell: [4, 5], machine: [5, 10], cable: [5, 10] }

const inUnit = ([kg, lb], unit) => (unit === 'lb' ? lb * LB : kg)

// kg value of the rounding step for loads.
export function loadStep(exercise, unit) {
  return inUnit(own(LOAD_STEP, exercise?.equipment) || [2.5, 5], unit)
}

// kg value of the progression increment; meta.increment (kg) overrides.
export function increment(exercise, unit, meta) {
  const override = pos(meta?.increment) ?? pos(exercise?.increment)
  if (override !== null) return override
  const equipment = exercise?.equipment
  if (equipment === 'barbell' || equipment === 'smith_machine') return inUnit(LOWER_BODY.has(exercise?.primary) ? [5, 10] : [2.5, 5], unit)
  return inUnit(own(LOAD_STEP, equipment) || [2.5, 5], unit)
}

export function roundDown(valueKg, stepKg) {
  const value = num(valueKg)
  if (value === null) return null
  const step = pos(stepKg)
  if (step === null) return value
  return Math.floor(value / step + EPS) * step
}

const sameWeight = (a, b) => Math.abs(a - b) < 1e-6
const topWeight = (sets) => Math.max(...sets.map((set) => num(set.weightKg) ?? 0))

// Double progression from the last non-deload session. Returns { weightKg, reps, increased,
// deload, sets: [{ weightKg, reps, durationSec? }] } where `sets` has one suggestion per working
// set of that session (use sets[i], falling back to the top-level values). Weight suggestions only
// for weight_reps and weighted_bodyweight; other types get reps + 1 or duration + 5 s; distance
// types get none. `meta` (optional) = the exercise's settings.gym.exerciseMeta entry.
export function suggestNext(sessions, routineExercise, exercise, prefs, meta) {
  if (prefs?.progression === false) return null
  const exerciseId = routineExercise?.exerciseId ?? exercise?.id
  if (typeof exerciseId !== 'string' || !exerciseId) return null
  const entry = exercise || exerciseById(exerciseId)
  const tracking = trackingOf(routineExercise?.tracking, entry?.tracking)
  const unit = prefs?.unit === 'lb' ? 'lb' : 'kg'
  const history = []
  const groups = indexSessions(sessions).byExercise.get(exerciseId) || []
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].session.isDeload) continue
    const working = groups[i].sets.filter(isWorking)
    if (working.length) history.push(working)
  }
  if (!history.length) return null
  const last = history[0]

  if (tracking === 'weight_reps' || tracking === 'weighted_bodyweight') {
    const first = setsOf(routineExercise).find((set) => set.type !== 'warmup')
    let lo = pos(first?.repsMin) ?? pos(first?.repsMax)
    let hi = pos(first?.repsMax) ?? lo
    if (lo === null) return null
    if (lo > hi) [lo, hi] = [hi, lo]
    const withReps = (sets) => sets.filter((set) => pos(set.reps) !== null)
    const valid = withReps(last)
    if (!valid.length) return null
    const w = topWeight(valid)
    const recent = history.slice(0, 3).map(withReps)
    const stalled = recent.length === 3 && recent.every((sets) => sets.length > 0
      && sameWeight(topWeight(sets), w)
      && sets.some((set) => sameWeight(num(set.weightKg) ?? 0, w) && set.reps < lo))
    if (stalled) {
      const weightKg = roundDown(w * 0.9, loadStep(entry, unit))
      return { weightKg, reps: lo, increased: false, deload: true, sets: valid.map(() => ({ weightKg, reps: lo })) }
    }
    if (valid.every((set) => set.reps >= hi)) {
      const weightKg = w + increment(entry, unit, meta)
      return { weightKg, reps: lo, increased: true, deload: false, sets: valid.map(() => ({ weightKg, reps: lo })) }
    }
    const sets = valid.map((set) => ({ weightKg: num(set.weightKg) ?? w, reps: Math.min(hi, set.reps + 1) }))
    const top = sets.find((set) => sameWeight(set.weightKg, w)) || sets[0]
    return { weightKg: w, reps: top.reps, increased: false, deload: false, sets }
  }

  if (tracking === 'bodyweight_reps' || tracking === 'reps_only' || tracking === 'assisted_bodyweight') {
    const valid = last.filter((set) => pos(set.reps) !== null)
    if (!valid.length) return null
    const assisted = tracking === 'assisted_bodyweight'
    const sets = valid.map((set) => ({ weightKg: assisted ? num(set.weightKg) : null, reps: set.reps + 1 }))
    return { ...sets[0], increased: false, deload: false, sets }
  }

  if (tracking === 'duration' || tracking === 'weight_duration') {
    const valid = last.filter((set) => pos(set.durationSec) !== null)
    if (!valid.length) return null
    const weighted = tracking === 'weight_duration'
    const sets = valid.map((set) => ({ weightKg: weighted ? num(set.weightKg) : null, reps: null, durationSec: set.durationSec + 5 }))
    return { ...sets[0], increased: false, deload: false, sets }
  }

  return null
}

const deloadFactor = (value, fallback) => (num(value) !== null && value > 0 && value <= 1 ? value : fallback)

// A load lightened for a deload week: roundDown(w × schedule.deload.weightFactor (0.9), loadStep),
// never below one step. Only loaded types get lighter (assistance and unloaded types are returned
// as they are).
export function deloadWeight(weightKg, exercise, tracking, schedule, prefs) {
  const w = num(weightKg)
  if (w === null || w <= 0 || !WEIGHT_UP.has(trackingOf(tracking, exercise?.tracking))) return w
  const step = loadStep(exercise, prefs?.unit)
  const lighter = roundDown(w * deloadFactor(schedule?.deload?.weightFactor, 0.9), step)
  return lighter > 0 ? lighter : Math.min(w, step)
}

// Tracking types with a weight column (added weight and assistance included).
const HAS_LOAD = new Set([...WEIGHT_UP, 'assisted_bodyweight'])

// The working weight a routine exercise is planned at: what the gym Today list shows and what a
// workout pre-fills. The progression suggestion, else the previous session's top working weight
// (its first one for assisted exercises), else the routine's first working target. In a deload week
// a suggested or previous load is lightened with deloadWeight (the target already is, through
// deloadTargets). options: { routineId, deload, schedule, suggestion?, previous? } — pass a
// suggestion / previousSets result already computed to reuse it. → { weightKg (null when unknown
// or the exercise has no weight column), source: 'suggestion' | 'previous' | 'target', deloaded }.
export function plannedWeight(sessions, routineExercise, exercise, prefs, meta, options = {}) {
  const opts = isObject(options) ? options : {}
  const { routineId = null, deload = false, schedule = null } = opts
  const entry = exercise || exerciseById(routineExercise?.exerciseId)
  const tracking = trackingOf(routineExercise?.tracking, entry?.tracking)
  const result = { weightKg: null, source: 'target', deloaded: false }
  if (!HAS_LOAD.has(tracking)) return result
  const exerciseId = routineExercise?.exerciseId ?? entry?.id
  let suggestion = opts.suggestion
  if (suggestion === undefined) {
    try {
      suggestion = suggestNext(sessions, routineExercise, entry, prefs, meta)
    } catch {
      suggestion = null
    }
  }
  let previous = opts.previous
  if (previous === undefined) {
    previous = typeof exerciseId === 'string' && exerciseId ? previousSets(sessions, exerciseId, { routineId, source: prefs?.previousSource }) : null
  }
  const lastWorking = (Array.isArray(previous) ? previous : []).filter((set) => isObject(set) && set.type !== 'warmup')
  const last = tracking === 'assisted_bodyweight'
    ? num(lastWorking[0]?.weightKg)
    : lastWorking.reduce((top, set) => (num(set.weightKg) !== null && (top === null || set.weightKg > top) ? set.weightKg : top), null)
  if (num(suggestion?.weightKg) !== null) {
    result.weightKg = suggestion.weightKg
    result.source = 'suggestion'
  } else if (last !== null) {
    result.weightKg = last
    result.source = 'previous'
  } else {
    const shown = deload ? deloadTargets(routineExercise, entry, schedule, prefs) : routineExercise
    result.weightKg = num(setsOf(shown).find((set) => set.type !== 'warmup')?.weightKg)
  }
  if (deload && result.source !== 'target' && WEIGHT_UP.has(tracking) && result.weightKg > 0) {
    result.weightKg = deloadWeight(result.weightKg, entry, tracking, schedule, prefs)
    result.deloaded = true
  }
  return result
}

// Deload version of a routine exercise (display/start time only; stored targets are untouched):
// working sets → max(1, round(n × setsFactor)), loads → deloadWeight (roundDown(w × weightFactor,
// loadStep)), target RPE − 3 (floor 5). Warm-ups are kept; assistance weights are left alone.
export function deloadTargets(routineExercise, exercise, schedule, prefs) {
  if (!isObject(routineExercise)) return routineExercise ?? null
  const setsFactor = deloadFactor(schedule?.deload?.setsFactor, 0.5)
  const entry = exercise || exerciseById(routineExercise.exerciseId)
  const tracking = trackingOf(routineExercise.tracking, entry?.tracking)
  const sets = setsOf(routineExercise)
  const working = sets.filter((set) => set.type !== 'warmup').length
  let keep = working ? Math.max(1, Math.round(working * setsFactor)) : 0
  const out = []
  for (const set of sets) {
    if (set.type === 'warmup') {
      out.push(set)
      continue
    }
    if (keep <= 0) continue
    keep -= 1
    const next = { ...set }
    const w = num(set.weightKg)
    if (WEIGHT_UP.has(tracking) && w !== null && w > 0) next.weightKg = deloadWeight(w, entry, tracking, schedule, prefs)
    const rpe = num(set.rpe)
    if (rpe !== null) next.rpe = Math.max(5, rpe - 3)
    out.push(next)
  }
  return { ...routineExercise, sets: out }
}

// ---- plate calculator ----------------------------------------------------------------------

const DEFAULT_PLATES = { kg: [25, 20, 15, 10, 5, 2.5, 1.25], lb: [45, 35, 25, 10, 5, 2.5] }
const DEFAULT_PAIRS = 2 // limited plates: pairs of a size the pairs map doesn't list
const KG_BARS = { olympic: 20, womens: 15, ez: 10, trap: 25, smith: 15, landmine: 0 }
const LB_BARS = { olympic: 45, womens: 35, ez: 25, trap: 55, smith: 35, landmine: 0 }

// Default bar for an exercise: smith machines use the Smith bar, else the library `bar` field,
// else Olympic. In lb mode an untouched kg default becomes the lb standard (45 lb, not 44.09).
// Landmine has one loaded sleeve, so the plate maths uses the whole load on it.
export function barFor(exercise, prefs) {
  const id = exercise?.equipment === 'smith_machine' ? 'smith' : own(KG_BARS, exercise?.bar) !== undefined ? exercise.bar : 'olympic'
  const unit = prefs?.unit === 'lb' ? 'lb' : 'kg'
  const custom = num(prefs?.bars?.[id])
  const useCustom = custom !== null && custom >= 0 && !(unit === 'lb' && custom === KG_BARS[id])
  const barKg = useCustom ? custom : unit === 'lb' ? LB_BARS[id] * LB : KG_BARS[id]
  return { id, barKg, sleeves: id === 'landmine' ? 1 : 2 }
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

// Fewest plates reaching each reachable per-side sum (units already divided by their gcd); ties
// prefer heavier plates. best[s] = { count, vec } with vec[i] = plates of items[i].
function fewestPlates(items, maxUnits) {
  let layer = new Array(maxUnits + 1)
  layer[0] = { count: 0, vec: [] }
  items.forEach((item, i) => {
    const next = new Array(maxUnits + 1)
    for (let s = 0; s <= maxUnits; s++) {
      const prev = layer[s]
      if (!prev) continue
      const most = Math.min(item.limit, Math.floor((maxUnits - s) / item.units))
      for (let k = most; k >= 0; k--) {
        const t = s + k * item.units
        const current = next[t]
        const count = prev.count + k
        if (current && (count > current.count || (count === current.count && !heavierFirst(prev.vec, k, current.vec, i)))) continue
        next[t] = { count, vec: [...prev.vec, k] }
      }
    }
    layer = next
  })
  return layer
}

// Is prevVec + [k] lexicographically greater than other (both of length i + 1)?
function heavierFirst(prevVec, k, other, i) {
  for (let j = 0; j < i; j++) if (prevVec[j] !== other[j]) return prevVec[j] > other[j]
  return k > other[i]
}

// Per-side plates, heaviest first, in the display unit. Integer maths in 1/100 units. Unlimited
// plates: greedy; limited pairs (or when greedy misses): fewest-plates DP. No exact load → the
// closest below and above, each { total, totalKg, perSide }. `sleeves: 1` for a landmine.
// `pairs` (limited plates) is keyed by size; a size it doesn't list counts as the 2 pairs the
// settings seed, so switching kg ↔ lb or adding a size never makes plates vanish.
export function plateBreakdown(targetKg, options = {}) {
  const { unit: rawUnit, barKg, collarKg, plates, pairs, sleeves: rawSleeves } = options || {}
  const unit = rawUnit === 'lb' ? 'lb' : 'kg'
  const sleeves = rawSleeves === 1 ? 1 : 2
  const result = { perSide: [], exact: false, below: null, above: null, belowBar: false }
  const target = fromKg(targetKg, unit)
  if (target === null || target < 0) return result
  const cents = (value) => Math.round(value * 100)
  const bar = num(barKg) !== null && barKg >= 0 ? fromKg(barKg, unit) : unit === 'lb' ? 45 : 20
  const collar = num(collarKg) !== null && collarKg > 0 ? fromKg(collarKg, unit) : 0
  const base = cents(bar) + sleeves * cents(collar)
  const rest = cents(target) - base
  if (rest < 0) return { ...result, belowBar: true }

  const limited = isObject(pairs)
  const sizes = [...new Set((Array.isArray(plates) ? plates : DEFAULT_PLATES[unit]).filter((size) => num(size) !== null && size > 0))]
    .sort((a, b) => b - a)
  const items = sizes
    .map((size) => {
      const raw = limited ? own(pairs, String(size)) : undefined
      const count = !limited ? Infinity : raw === undefined ? DEFAULT_PAIRS : num(raw)
      return { size, units: cents(size), limit: count === null || count < 0 ? 0 : Math.floor(count) * (2 / sleeves) }
    })
    .filter((item) => item.units > 0 && item.limit > 0)
  const goal = rest / sleeves
  const expand = (vec) => items.flatMap((item, i) => Array(vec[i] || 0).fill(item.size))
  const describe = (vec, unitsSum) => {
    const total = (base + sleeves * unitsSum) / 100
    return { total, totalKg: toKg(total, unit), perSide: expand(vec) }
  }
  if (goal === 0) return { ...result, exact: true }

  // Greedy, heaviest first (the answer for unlimited plates whenever it lands exactly).
  if (!limited && Number.isInteger(goal)) {
    let remaining = goal
    const vec = items.map((item) => {
      const k = Math.min(item.limit, Math.floor(remaining / item.units))
      remaining -= k * item.units
      return k
    })
    if (remaining === 0) return { ...result, exact: true, perSide: expand(vec) }
  }
  if (!items.length) return { ...result, below: describe([], 0) }

  const g = items.reduce((acc, item) => gcd(acc, item.units), 0)
  const reduced = items.map((item) => ({ ...item, units: item.units / g }))
  const lo = Math.floor(goal / g + EPS)
  const hi = Math.ceil(goal / g - EPS)
  const capacity = limited ? reduced.reduce((sum, item) => sum + item.limit * item.units, 0) : Infinity
  const maxUnits = Math.min(hi + reduced[0].units, capacity, 20000)
  const dp = fewestPlates(reduced.map((item) => ({ ...item, limit: Math.min(item.limit, Math.floor(maxUnits / item.units)) })), maxUnits)
  if (lo === hi && dp[lo]) return { ...result, exact: true, perSide: expand(dp[lo].vec) }
  let below = null
  for (let s = Math.min(lo, maxUnits); s >= 0 && !below; s--) if (dp[s]) below = describe(dp[s].vec, s * g)
  let above = null
  for (let s = hi; s <= maxUnits && !above; s++) if (dp[s]) above = describe(dp[s].vec, s * g)
  return { ...result, below, above }
}

// ---- warm-ups ------------------------------------------------------------------------------

const DEFAULT_WARMUP = [
  { pct: 0, reps: 10, bar: true },
  { pct: 0.5, reps: 5 },
  { pct: 0.7, reps: 3 },
  { pct: 0.85, reps: 2 },
  { pct: 0.92, reps: 1, minKg: 100 },
]

// Row threshold in kg; the 100 kg default reads as 225 lb for lb users.
function minimumFor(row, unit) {
  const lb = pos(row.minLb)
  if (unit === 'lb' && lb !== null) return lb * LB
  const kg = pos(row.minKg)
  if (kg === null) return null
  return unit === 'lb' && kg === 100 ? 225 * LB : kg
}

// Warm-up rows for a working weight (weight_reps only). Loads round down to the loading step and
// never go under the bar (barbell) or one step; a row is kept only if prev < load < working.
export function warmupSets(workingKg, exercise, prefs) {
  const working = pos(workingKg)
  if (working === null || trackingOf(exercise?.tracking) !== 'weight_reps') return []
  const unit = prefs?.unit === 'lb' ? 'lb' : 'kg'
  const custom = Array.isArray(prefs?.warmupScheme) ? prefs.warmupScheme.filter(isObject) : []
  const scheme = custom.length ? custom : DEFAULT_WARMUP
  const barbell = exercise?.equipment === 'barbell' || exercise?.equipment === 'smith_machine'
  const bar = barbell ? barFor(exercise, prefs).barKg : 0
  const step = loadStep(exercise, unit)
  const repsOf = (row) => (Number.isInteger(row.reps) && row.reps > 0 ? row.reps : null)
  if (barbell && working < 1.5 * bar) {
    const row = scheme.find((item) => item.bar && repsOf(item))
    return row && bar > 0 && bar < working - EPS ? [{ type: 'warmup', weightKg: bar, reps: repsOf(row) }] : []
  }
  const rows = []
  let prev = 0
  for (const row of scheme) {
    const reps = repsOf(row)
    if (!reps || (row.bar && !barbell)) continue
    const minimum = minimumFor(row, unit)
    if (minimum !== null && working < minimum - EPS) continue
    let load
    if (row.bar) load = bar
    else {
      const pct = pos(row.pct)
      if (pct === null) continue
      load = Math.max(roundDown(working * pct, step), barbell ? bar : step)
    }
    if (load > prev + EPS && load < working - EPS) {
      rows.push({ type: 'warmup', weightKg: load, reps })
      prev = load
    }
  }
  return rows
}

// ---- weekly aggregates ---------------------------------------------------------------------

// Completed working sets per muscle between from and to (inclusive): 1 for the primary muscle,
// 0.5 for each secondary. Exercises whose primary is cardio are left out.
export function weeklySetsByMuscle(sessions, from, to, lookup = defaultLookup) {
  const find = typeof lookup === 'function' ? lookup : defaultLookup
  const out = {}
  const add = (muscle, amount) => {
    out[muscle] = (out[muscle] || 0) + amount
  }
  for (const session of sessionList(sessions)) {
    const date = session.date
    if (!isIsoDate(date) || (isIsoDate(from) && date < from) || (isIsoDate(to) && date > to)) continue
    for (const exercise of exercisesOf(session)) {
      const entry = find(exercise.exerciseId)
      const primary = entry?.primary
      if (!primary || primary === 'cardio') continue
      const count = setsOf(exercise).filter(isWorking).length
      if (!count) continue
      add(primary, count)
      const secondary = Array.isArray(entry.secondary) ? entry.secondary : []
      for (const muscle of new Set(secondary)) {
        if (typeof muscle === 'string' && muscle && muscle !== primary && muscle !== 'cardio') add(muscle, count * 0.5)
      }
    }
  }
  return out
}

// Oldest → current week: [{ weekStart, count, volumeKg, minutes, timed }], `timed` = sessions
// with a known duration (for averages).
export function weeklyCounts(sessions, today, firstWeekday, weeks = 12, lookup = defaultLookup) {
  if (!isIsoDate(today)) return []
  const first = weekdayOf(firstWeekday)
  const total = Number.isInteger(weeks) && weeks > 0 ? Math.min(weeks, 520) : 12
  const current = weekStart(today, first)
  const buckets = new Map()
  for (let i = total - 1; i >= 0; i--) {
    const start = addDays(current, -7 * i)
    buckets.set(start, { weekStart: start, count: 0, volumeKg: 0, minutes: 0, timed: 0 })
  }
  for (const session of sessionList(sessions)) {
    if (!isIsoDate(session.date)) continue
    const bucket = buckets.get(weekStart(session.date, first))
    if (!bucket) continue
    bucket.count += 1
    bucket.volumeKg += sessionVolume(session, lookup)
    const seconds = sessionDurationSec(session)
    if (seconds !== null) {
      bucket.minutes += seconds / 60
      bucket.timed += 1
    }
  }
  return [...buckets.values()].map((bucket) => ({ ...bucket, minutes: Math.round(bucket.minutes) }))
}

// Consecutive weeks with at least one session, counting back from last week; the current week
// adds 1 once it has a session and never breaks the streak while in progress.
export function streakWeeks(sessions, today, firstWeekday) {
  if (!isIsoDate(today)) return 0
  const first = weekdayOf(firstWeekday)
  const weeks = new Set()
  for (const session of sessionList(sessions)) {
    if (isIsoDate(session.date) && session.date <= today) weeks.add(weekStart(session.date, first))
  }
  const current = weekStart(today, first)
  let streak = 0
  for (let week = addDays(current, -7); weeks.has(week); week = addDays(week, -7)) streak += 1
  return weeks.has(current) ? streak + 1 : streak
}

export function weekProgress(sessions, today, firstWeekday) {
  if (!isIsoDate(today)) return 0
  const first = weekdayOf(firstWeekday)
  const current = weekStart(today, first)
  return sessionList(sessions).filter((session) => isIsoDate(session.date) && weekStart(session.date, first) === current).length
}

// Most-trained exercises by number of sessions: [{ exerciseId, name, count, lastDate }].
export function topExercises(sessions, n = 5) {
  const { sorted } = indexSessions(sessions)
  const counts = new Map()
  for (let i = sorted.length - 1; i >= 0; i--) {
    const session = sorted[i]
    const seen = new Set()
    for (const exercise of exercisesOf(session)) {
      const id = exercise.exerciseId
      if (typeof id !== 'string' || !id || seen.has(id) || !setsOf(exercise).some(isWorking)) continue
      seen.add(id)
      if (!counts.has(id)) counts.set(id, { exerciseId: id, name: str(exercise.name), count: 0, lastDate: str(session.date) || null })
      counts.get(id).count += 1
    }
  }
  const limit = Number.isInteger(n) && n >= 0 ? n : 5
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || order(b.lastDate || '', a.lastDate || '') || a.name.localeCompare(b.name))
    .slice(0, limit)
}

// ---- CSV -----------------------------------------------------------------------------------

const CSV_HEADER = ['date', 'start_time', 'end_time', 'workout_name', 'routine', 'exercise', 'exercise_id', 'superset', 'exercise_note',
  'set_index', 'set_type', 'weight_kg', 'weight_lb', 'reps', 'rpe', 'distance_m', 'duration_s', 'session_note']

// RFC 4180: quote fields containing a comma, quote or line break; double inner quotes.
const csvField = (value) => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const csvNumber = (value, dp = 2) => (num(value) === null ? '' : formatNumber(value, dp))

// Local wall-clock HH:MM of a timestamp.
function clock(iso) {
  const t = timeOf(iso)
  if (!Number.isFinite(t)) return ''
  const date = new Date(t)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// One row per set, oldest session first; a session without sets (quick log) gets one row so it is
// not lost. Both weight_kg and weight_lb are always written, so `unit` does not change the columns.
// `routines` (optional) turns routineId into the routine's name.
export function sessionsToCsv(sessions, unit, routines = []) {
  const routineNames = new Map((Array.isArray(routines) ? routines : []).filter(isObject).map((routine) => [routine.id, str(routine.name)]))
  const lines = [CSV_HEADER.join(',')]
  for (const session of sessionList(sessions).sort(compareSessions)) {
    const head = [
      str(session.date), clock(session.startedAt), clock(session.endedAt), str(session.name),
      session.routineId ? routineNames.get(session.routineId) || String(session.routineId) : '',
    ]
    const note = str(session.note)
    const groups = new Map()
    const letter = (id) => {
      if (id === null || id === undefined || id === '') return ''
      if (!groups.has(id)) groups.set(id, String.fromCharCode(65 + (groups.size % 26)))
      return groups.get(id)
    }
    let rows = 0
    for (const exercise of exercisesOf(session)) {
      const superset = letter(exercise.supersetId)
      setsOf(exercise).forEach((set, i) => {
        if (!set.done) return
        const w = num(set.weightKg)
        lines.push([
          ...head, str(exercise.name), str(exercise.exerciseId), superset, str(exercise.note),
          i + 1, str(set.type) || 'normal', csvNumber(w), w === null ? '' : formatNumber(w / LB, 2),
          csvNumber(set.reps), csvNumber(set.rpe), csvNumber(set.distanceM), csvNumber(set.durationSec), note,
        ].map(csvField).join(','))
        rows += 1
      })
    }
    if (!rows) lines.push([...head, '', '', '', '', '', '', '', '', '', '', '', '', note].map(csvField).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

// ---- routine estimate ----------------------------------------------------------------------

// ~minutes: Σ sets × (45 s of work + restSec), rounded to 5 (minimum 5); no exercises → 0.
export function estimateMinutes(routine) {
  const exercises = isObject(routine) && Array.isArray(routine.exercises) ? routine.exercises.filter(isObject) : []
  if (!exercises.length) return 0
  let seconds = 0
  for (const exercise of exercises) {
    const rest = num(exercise.restSec)
    seconds += setsOf(exercise).length * (45 + (rest !== null && rest >= 0 ? rest : 120))
  }
  return Math.max(5, Math.round(seconds / 60 / 5) * 5)
}

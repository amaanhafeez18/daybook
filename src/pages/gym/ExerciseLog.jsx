import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { AutoTextarea, Button } from '../../components/ui/primitives.jsx'
import { MUSCLES, TRACKING, exerciseById } from '../../lib/gym/library.js'
import { compareSessions, deloadWeight, e1rm, increment, isBackfillWorkout, livePRs, plannedWeight, previousSets, suggestNext, warmupSets } from '../../lib/gym/stats.js'
import { formatDistance, formatDuration, formatNumber, formatPace, formatVolume, formatWeight, fromMeters, toMeters } from '../../lib/gym/units.js'
import { getActiveWorkout, getGym, newGymId, normalizeGym, routineById, saveRoutine, setExerciseMeta } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import { ActionSheet, DurationInput, GymEmpty, NumberInput, SetTypeBadge, WeightInput } from './common.jsx'
import ExercisePicker from './ExercisePicker.jsx'
import { PlateCalculatorSheet } from './ToolsSheet.jsx'
import { unlockAudio } from './RestTimer.jsx'
import './workout.css'

// The exercise cards of a workout: the set grid (previous values, placeholders, set types,
// swipe to delete), supersets, notes and the per-exercise tools. 'live' is the active workout
// (rest timer, live PR badges); 'edit' is a saved session being corrected (no timer, no toasts).

const SET_TYPES = ['normal', 'warmup', 'drop', 'failure']
const TYPE_NAME = { normal: 'Set', warmup: 'Warm-up set', drop: 'Drop set', failure: 'Failure set' }
const TYPE_OPTIONS = [
  { type: 'normal', label: 'Normal', hint: 'Counts toward weight lifted, sets and records' },
  { type: 'warmup', label: 'Warm-up', hint: 'Left out of weight lifted, set counts and PRs' },
  { type: 'drop', label: 'Drop set', hint: 'Lighter set straight after, no rest before it' },
  { type: 'failure', label: 'Failure', hint: 'A working set taken to failure' },
]
const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]
const REST_PRESETS = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300]
const SUPERSET_COLORS = ['var(--gym-c-indigo)', 'var(--gym-c-teal)', 'var(--gym-c-pink)', 'var(--gym-c-orange)', 'var(--gym-c-blue)', 'var(--gym-c-green)']
const FIELD_KEY = { weight: 'weightKg', added: 'weightKg', assist: 'weightKg', reps: 'reps', duration: 'durationSec', distance: 'distanceM' }
const VALUE_KEYS = ['weightKg', 'reps', 'durationSec', 'distanceM']
const PR_ORDER = ['e1RM', 'Weight', 'RM', 'Volume', 'Reps', 'Duration', 'Distance', 'Pace', 'Assist']
const OPEN_X = 88 // px the Delete button takes when a row is swiped open

const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const hasOwn = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key)
const firstNum = (...values) => values.find(isNum) ?? null
const numOrNull = (value) => (isNum(value) ? value : null)
const setsOf = (exercise) => (Array.isArray(exercise?.sets) ? exercise.sets : [])
const exercisesOf = (workout) => (Array.isArray(workout?.exercises) ? workout.exercises : [])
const replaceAt = (list, index, item) => list.map((current, i) => (i === index ? item : current))
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const withoutPrs = ({ prs, ...rest }) => rest // eslint-disable-line no-unused-vars

export const trackingOf = (value) => (hasOwn(TRACKING, value) ? value : 'weight_reps')
export const setTypeOf = (set) => (SET_TYPES.includes(set?.type) ? set.type : 'normal')
export const fieldKeys = (tracking) => TRACKING[trackingOf(tracking)].fields.map((field) => FIELD_KEY[field])

const hasValue = (key, value) => (key === 'weightKg' ? isNum(value) && value >= 0 : isNum(value) && value > 0)

// Value keys a set still needs before it can be ticked.
export function missingKeys(tracking, values) {
  const need = (keys) => keys.filter((key) => !hasValue(key, values?.[key]))
  switch (trackingOf(tracking)) {
    case 'weight_reps': return need(['weightKg', 'reps'])
    case 'duration':
    case 'weight_duration': return need(['durationSec'])
    case 'distance_duration': return need(['distanceM']).length && need(['durationSec']).length ? ['distanceM', 'durationSec'] : []
    case 'weight_distance': return need(['distanceM'])
    default: return need(['reps'])
  }
}

// A set's values with its empty fields taken from the grey placeholders, as tapping ✓ fills them.
export function fillFromPlaceholder(set, tracking, placeholder) {
  const filled = { ...set }
  for (const key of fieldKeys(tracking)) if (!isNum(filled[key]) && isNum(placeholder?.[key])) filled[key] = placeholder[key]
  return filled
}

// Superset groups must be contiguous runs of 2+; anything else is unlinked (a repeated id in a
// separate run gets a fresh one). Unchanged rows keep their identity.
export function normalizeSupersets(list) {
  const out = [...list]
  const seen = new Set()
  let i = 0
  while (i < out.length) {
    const id = out[i]?.supersetId
    if (id == null || id === '') {
      i += 1
      continue
    }
    let j = i
    while (j + 1 < out.length && out[j + 1]?.supersetId === id) j += 1
    if (j === i) out[i] = { ...out[i], supersetId: null }
    else if (seen.has(id)) {
      const fresh = newGymId()
      for (let k = i; k <= j; k++) out[k] = { ...out[k], supersetId: fresh }
      seen.add(fresh)
    } else seen.add(id)
    i = j + 1
  }
  return out
}

// Per exercise: null, or { letter, pos (1-based), size, last, color } for superset members.
export function supersetGroups(list) {
  const info = new Array(list.length).fill(null)
  let group = 0
  let i = 0
  while (i < list.length) {
    const id = list[i]?.supersetId
    let j = i
    if (id != null && id !== '') while (j + 1 < list.length && list[j + 1]?.supersetId === id) j += 1
    if (j > i) {
      const letter = String.fromCharCode(65 + (group % 26))
      const color = SUPERSET_COLORS[group % SUPERSET_COLORS.length]
      for (let k = i; k <= j; k++) info[k] = { letter, pos: k - i + 1, size: j - i + 1, last: k === j, color }
      group += 1
    }
    i = j + 1
  }
  return info
}

// Exercise lookup for sessionVolume that honours the "count bodyweight in volume" setting.
export function volumeLookup(gym) {
  const g = normalizeGym(gym)
  const customs = g.exercises
  const withBodyweight = g.prefs.bodyweightInVolume
  return (id) => {
    const entry = exerciseById(id, customs)
    return entry && !withBodyweight && entry.bwVolume ? { ...entry, bwVolume: false } : entry
  }
}

export const distanceUnitFor = (tracking, distanceUnit) => (tracking === 'weight_distance' ? (distanceUnit === 'mi' ? 'yd' : 'm') : distanceUnit === 'mi' ? 'mi' : 'km')

// Short set text for the PREVIOUS column / summaries: '60 × 8', '+10 × 6', '1:30', '5 km · 25:10'.
export function formatSetShort(set, tracking, unit, distanceUnit, { withUnit = false } = {}) {
  if (!set) return null
  const type = trackingOf(tracking)
  const w = isNum(set.weightKg) ? formatWeight(set.weightKg, unit, { withUnit }) : null
  const r = isNum(set.reps) ? formatNumber(set.reps, 0) : null
  const t = isNum(set.durationSec) ? formatDuration(set.durationSec) : null
  const du = distanceUnitFor(type, distanceUnit)
  const d = isNum(set.distanceM) ? `${formatNumber(fromMeters(set.distanceM, du), 2)} ${du}` : null
  const loaded = isNum(set.weightKg) && set.weightKg > 0
  let text = null
  switch (type) {
    case 'weight_reps': text = w !== null && r !== null ? `${w} × ${r}` : r !== null ? `${r} reps` : w; break
    case 'weighted_bodyweight': text = r === null ? null : loaded ? `+${w} × ${r}` : `${r} reps`; break
    case 'assisted_bodyweight': text = r === null ? null : loaded ? `−${w} × ${r}` : `${r} reps`; break
    case 'duration': text = t; break
    case 'weight_duration': text = t !== null && loaded ? `${w} × ${t}` : t; break
    case 'distance_duration': text = [d, t].filter(Boolean).join(' · ') || null; break
    case 'weight_distance': text = d !== null && loaded ? `${w} × ${d}` : d; break
    default: text = r !== null ? `${r} reps` : null
  }
  if (text && isNum(set.rpe)) text += ` @${formatNumber(set.rpe, 1)}`
  return text
}

function columnsFor(tracking, unit, distanceUnit) {
  const du = distanceUnitFor(tracking, distanceUnit)
  const u = unit === 'lb' ? 'lb' : 'kg'
  return TRACKING[tracking].fields.map((field) => {
    const key = FIELD_KEY[field]
    switch (field) {
      case 'weight': return { field, key, label: u.toUpperCase(), name: `weight in ${u}` }
      case 'added': return { field, key, label: `+${u.toUpperCase()}`, name: `added weight in ${u}` }
      case 'assist': return { field, key, label: `−${u.toUpperCase()}`, name: `assistance in ${u}` }
      case 'reps': return { field, key, label: 'REPS', name: 'reps' }
      case 'duration': return { field, key, label: 'TIME', name: 'time' }
      default: return { field, key, label: du.toUpperCase(), name: `distance in ${du}`, unit: du }
    }
  })
}

function musclesLine(entry) {
  if (!entry) return ''
  const label = (id) => (hasOwn(MUSCLE_LABEL, id) ? MUSCLE_LABEL[id] : null)
  const secondary = (Array.isArray(entry.secondary) ? entry.secondary : []).map(label).filter(Boolean)
  return [label(entry.primary), secondary.join(', ')].filter(Boolean).join(' · ')
}

function restSecFor(exercise, meta, entry, prefs) {
  const value = firstNum(exercise?.restSec, meta?.restSec, entry?.rest, prefs?.defaultRest)
  return value === null ? 0 : Math.min(600, Math.max(0, Math.round(value)))
}

// Rest after ticking `set`: none before a drop set or when the exercise's rest is off.
function restAfter(set, nextSet, baseRest, prefs) {
  if (!(baseRest > 0)) return 0
  if (nextSet && setTypeOf(nextSet) === 'drop') return 0
  if (setTypeOf(set) === 'warmup') return Math.min(600, Math.max(0, Math.round(isNum(prefs.warmupRest) ? prefs.warmupRest : 45)))
  return baseRest
}

function blankSet(type = 'normal', values = {}, target = null) {
  return {
    id: newGymId(),
    type: SET_TYPES.includes(type) ? type : 'normal',
    weightKg: numOrNull(values.weightKg),
    reps: numOrNull(values.reps),
    durationSec: numOrNull(values.durationSec),
    distanceM: numOrNull(values.distanceM),
    rpe: null,
    done: false,
    target,
  }
}

// Previous values, suggestion and placeholders for one exercise row. Placeholder order: live →
// progression suggestion, then the previous session, then the routine target; edit → previous,
// then target. A deload workout has no suggestion: its working sets show the lightened planned
// weight the gym Today list shows (plannedWeight), then the deload target, then the previous load
// lightened too (the PREVIOUS column still shows what was really lifted).
function deriveExercise(exercise, ctx) {
  const { baseSessions, prefs, metaMap, customs, deload, routineId, mode, schedule } = ctx
  const entry = exerciseById(exercise.exerciseId, customs)
  const tracking = trackingOf(exercise.tracking ?? entry?.tracking)
  const meta = (hasOwn(metaMap, exercise.exerciseId) && metaMap[exercise.exerciseId]) || null
  const sets = setsOf(exercise)
  const previous = exercise.exerciseId ? previousSets(baseSessions, exercise.exerciseId, { routineId, source: prefs.previousSource }) || [] : []
  const previousByType = {}
  for (const set of previous) {
    const type = setTypeOf(set)
    if (!previousByType[type]) previousByType[type] = []
    previousByType[type].push(set)
  }

  const routineLike = { exerciseId: exercise.exerciseId, tracking, sets: sets.map((set) => ({ type: setTypeOf(set), ...(set.target || {}) })) }
  let suggestion = null
  if (mode === 'live' && !deload && exercise.exerciseId) {
    try {
      suggestion = suggestNext(baseSessions, routineLike, entry, prefs, meta)
    } catch {
      suggestion = null
    }
  }
  const lightDeload = mode === 'live' && deload
  let deloadPlan = null
  if (lightDeload && exercise.exerciseId) {
    try {
      const plan = plannedWeight(baseSessions, routineLike, entry, prefs, meta, { routineId, deload: true, schedule, previous })
      if (plan.deloaded) deloadPlan = { weightKg: plan.weightKg }
    } catch {
      deloadPlan = null
    }
  }
  const lighter = (set) => (set && isNum(set.weightKg) ? { ...set, weightKg: deloadWeight(set.weightKg, entry, tracking, schedule, prefs) } : set)

  const typeCount = {}
  const lastEntered = {} // per set type: values typed into earlier sets of this workout
  let normal = 0
  let working = 0
  const rows = sets.map((set) => {
    const type = setTypeOf(set)
    const carried = lastEntered[type] || null
    const entered = {}
    for (const key of VALUE_KEYS) entered[key] = isNum(set[key]) ? set[key] : carried?.[key]
    lastEntered[type] = entered
    const typeIndex = (typeCount[type] = (typeCount[type] ?? -1) + 1)
    if (type === 'normal') normal += 1
    const workingIndex = type === 'warmup' ? -1 : working++
    const prev = previousByType[type]?.[typeIndex] || null
    const sug = suggestion && (type === 'normal' || type === 'failure') ? suggestion.sets?.[workingIndex] || suggestion : null
    const target = set.target && typeof set.target === 'object'
      ? { weightKg: set.target.weightKg, reps: firstNum(set.target.repsMax, set.target.repsMin), durationSec: set.target.durationSec, distanceM: set.target.distanceM }
      : null
    let order = [sug, prev, target]
    if (mode === 'edit') order = [prev, target]
    else if (lightDeload) order = type === 'warmup' ? [target, prev] : [type === 'drop' ? null : deloadPlan, target, lighter(prev)]
    const placeholder = {}
    for (const key of VALUE_KEYS) placeholder[key] = firstNum(...order.map((source) => source?.[key]))
    // A weight typed into an earlier set carries down (you usually repeat it); anything else
    // still missing falls back to the earlier set too.
    if (mode === 'live' && carried) {
      if (isNum(carried.weightKg)) placeholder.weightKg = carried.weightKg
      for (const key of VALUE_KEYS) if (!isNum(placeholder[key]) && isNum(carried[key])) placeholder[key] = carried[key]
    }
    return { number: type === 'normal' ? normal : null, typeIndex: typeIndex + 1, previous: prev, placeholder, targetRpe: numOrNull(set.target?.rpe) }
  })

  return {
    entry,
    tracking,
    meta,
    rows,
    suggestion,
    rest: restSecFor(exercise, meta, entry, prefs),
    increase: suggestion?.increased ? increment(entry, prefs.unit, meta) : null,
    muscles: musclesLine(entry),
    barbell: entry?.equipment === 'barbell' || entry?.equipment === 'smith_machine',
  }
}

// History a workout is compared with: saved sessions before it (never itself).
function sessionsBefore(sessions, id, date, startedAt) {
  const list = Array.isArray(sessions) ? sessions : []
  const self = { id, date, startedAt }
  return list.filter((session) => session && session.id !== id && (!date || compareSessions(session, self) < 0))
}

// The placeholders the live grid shows for each set of a workout (what ✓ would fill in), keyed by
// set object, so Finish settles unticked sets exactly as ✓ does.
export function workoutPlaceholders(workout, gym, sessions) {
  const g = normalizeGym(gym)
  const ctx = {
    baseSessions: sessionsBefore(sessions, workout?.id, workout?.date, workout?.startedAt),
    prefs: g.prefs,
    metaMap: g.exerciseMeta,
    customs: g.exercises,
    deload: !!workout?.isDeload,
    routineId: workout?.routineId ?? null,
    mode: 'live',
    schedule: g.schedule,
  }
  const out = new WeakMap()
  for (const exercise of exercisesOf(workout)) {
    if (!exercise || typeof exercise !== 'object') continue
    const { rows } = deriveExercise(exercise, ctx)
    setsOf(exercise).forEach((set, j) => {
      if (set && typeof set === 'object' && rows[j]) out.set(set, rows[j].placeholder)
    })
  }
  return out
}

// PR labels a ticked set earns: it must beat every saved session and the other sets of this
// workout (so repeating a weight doesn't earn the same PR twice).
function livePrLabels(sessions, exerciseId, tracking, set, others, formula) {
  if (!exerciseId) return []
  let labels = []
  try {
    labels = livePRs(sessions, exerciseId, tracking, set, formula)
    if (!labels.length || !others.length) return labels
    const withWorkout = [...sessions, { id: '__workout__', date: '9999-12-31', exercises: [{ exerciseId, tracking, sets: others }] }]
    const still = new Set(livePRs(withWorkout, exerciseId, tracking, set, formula))
    return labels.filter((label) => still.has(label))
  } catch {
    return []
  }
}

const prRank = (label) => {
  const index = PR_ORDER.findIndex((key) => label === key || (key === 'RM' && /^\d+RM$/.test(label)) || (key === 'Assist' && label.startsWith('Assist')))
  return index < 0 ? 99 : index
}

function prValue(label, set, tracking, prefs) {
  const unit = prefs.unit
  const du = distanceUnitFor(tracking, prefs.distanceUnit)
  if (label === 'e1RM') return formatWeight(e1rm(set.weightKg, set.reps, prefs.e1rmFormula), unit)
  if (label === 'Weight' || /^\d+RM$/.test(label) || label.startsWith('Assist')) return formatWeight(set.weightKg, unit)
  if (label === 'Volume') return formatVolume((set.weightKg || 0) * (set.reps || 0), unit)
  if (label === 'Reps') return plural(set.reps, 'rep')
  if (label === 'Duration') return formatDuration(set.durationSec)
  if (label === 'Distance') return formatDistance(set.distanceM, du)
  if (label === 'Pace' && set.distanceM > 0) return formatPace(set.durationSec / (set.distanceM / 1000), prefs.distanceUnit)
  return ''
}

function prMessage(labels, set, tracking, prefs) {
  const sorted = [...labels].sort((a, b) => prRank(a) - prRank(b))
  const top = sorted[0]
  const value = prValue(top, set, tracking, prefs)
  const more = sorted.length - 1
  return `New ${top} PR${value ? `: ${value}` : ''}${more ? ` · +${more} more` : ''}`
}

const keyOf = (ref) => (ref.id != null ? `id:${ref.id}` : `i:${ref.i}`)

function indexOf(list, ref) {
  if (!ref) return -1
  if (ref.id != null) return list.findIndex((item) => item?.id === ref.id)
  return Number.isInteger(ref.i) && ref.i >= 0 && ref.i < list.length ? ref.i : -1
}

function nextOpenSet(exercise, preferred) {
  const sets = setsOf(exercise)
  if (sets[preferred] && !sets[preferred].done) return preferred
  const index = sets.findIndex((set) => !set.done)
  return index >= 0 ? index : null
}

const setDomId = (prefix, exIndex, setIndex) => `${prefix}-set-${exIndex}-${setIndex}`
const cardDomId = (prefix, exIndex) => `${prefix}-ex-${exIndex}`
const noteDomId = (prefix, exIndex) => `${prefix}-note-${exIndex}`
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function selectOnFocus(event) {
  const input = event.currentTarget
  requestAnimationFrame(() => {
    try {
      if (document.activeElement === input && input.value) input.setSelectionRange(0, input.value.length)
    } catch {
      // some input types can't be selected
    }
  })
}

// ---- component ---------------------------------------------------------------------------------

export default function ExerciseLog({ workout, onChange, mode = 'live', gym, sessions, onSetDone }) {
  const live = mode !== 'edit'
  const g = normalizeGym(gym)
  const { prefs } = g
  const exercises = exercisesOf(workout)
  const domPrefix = useId().replace(/:/g, '')

  const latest = useRef(workout)
  latest.current = workout
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSetDoneRef = useRef(onSetDone)
  onSetDoneRef.current = onSetDone
  const modeRef = useRef(mode)
  modeRef.current = live ? 'live' : 'edit'
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const metaRef = useRef(g.exerciseMeta)
  metaRef.current = g.exerciseMeta

  // History this workout is compared with: saved sessions before it (never itself).
  const workoutId = workout?.id
  const workoutDate = workout?.date
  const workoutStart = workout?.startedAt
  const baseSessions = useMemo(
    () => sessionsBefore(sessions, workoutId, workoutDate, workoutStart),
    [sessions, workoutId, workoutDate, workoutStart],
  )
  const baseRef = useRef(baseSessions)
  baseRef.current = baseSessions

  const deload = !!workout?.isDeload
  const routineId = workout?.routineId ?? null
  const derive = useMemo(() => {
    const cache = new WeakMap()
    const ctx = { baseSessions, prefs, metaMap: g.exerciseMeta, customs: g.exercises, deload, routineId, mode: live ? 'live' : 'edit', schedule: g.schedule }
    return (exercise) => {
      const row = exercise && typeof exercise === 'object' ? exercise : {}
      let derived = cache.get(row)
      if (!derived) {
        derived = deriveExercise(row, ctx)
        cache.set(row, derived)
      }
      return derived
    }
  }, [baseSessions, prefs, g.exerciseMeta, g.exercises, g.schedule, deload, routineId, live])
  const deriveRef = useRef(derive)
  deriveRef.current = derive

  const [sheet, setSheet] = useState(null) // { kind: 'menu' | 'type' | 'rest' | 'pinned', exRef, setRef }
  const [picker, setPicker] = useState(null) // { mode: 'add' | 'replace', exRef, open }
  const [plates, setPlates] = useState(null) // { open, initialKg, exercise }
  const [reorder, setReorder] = useState(false)
  const [swiped, setSwiped] = useState(null) // 'exKey|setKey'
  const [openNotes, setOpenNotes] = useState(() => new Set())
  const [shake, setShake] = useState(null) // { ex, set, keys, n }
  const [scrollCard, setScrollCard] = useState(null)

  // Sheets keep showing their last content while they animate closed.
  const lastSheets = useRef({})
  if (sheet) lastSheets.current[sheet.kind] = sheet

  const actions = useMemo(() => {
    const isLive = () => modeRef.current === 'live'
    // Live edits always start from the newest stored copy, so nothing made in between is lost.
    const current = () => {
      const shown = latest.current
      if (!isLive()) return shown
      const active = getActiveWorkout()
      return active && (!shown || active.id === shown.id) ? active : null
    }
    const commit = (next) => {
      latest.current = next
      onChangeRef.current?.(next)
    }
    const update = (fn) => {
      const base = current()
      if (!base) return null
      const next = fn(base)
      if (!next || next === base) return null
      commit(next)
      return next
    }
    const withExercise = (exRef, fn) => update((w) => {
      const list = exercisesOf(w)
      const i = indexOf(list, exRef)
      if (i < 0) return null
      const next = fn(list[i], i, w)
      if (!next || next === list[i]) return null
      return { ...w, exercises: replaceAt(list, i, next) }
    })
    const withSet = (exRef, setRef, fn) => withExercise(exRef, (ex, i, w) => {
      const sets = setsOf(ex)
      const j = indexOf(sets, setRef)
      if (j < 0) return null
      const next = fn(sets[j], j, ex, i, w)
      if (!next || next === sets[j]) return null
      return { ...ex, sets: replaceAt(sets, j, next) }
    })

    // Live mode: PR labels for a done working set (other sets of the same exercise in this
    // workout count as the bar to beat too). `ex` stands in for row i of the workout.
    const withPrs = (w, i, j, ex, set) => {
      const clean = withoutPrs(set)
      if (!isLive() || !clean.done || setTypeOf(clean) === 'warmup') return clean
      const others = []
      exercisesOf(w).forEach((row, ri) => {
        const source = ri === i ? ex : row
        if (source?.exerciseId !== ex.exerciseId) return
        setsOf(source).forEach((other, si) => {
          if ((ri !== i || si !== j) && other.done && setTypeOf(other) !== 'warmup') others.push(other)
        })
      })
      const labels = livePrLabels(baseRef.current, ex.exerciseId, trackingOf(ex.tracking), clean, others, prefsRef.current.e1rmFormula)
      return labels.length ? { ...clean, prs: labels } : clean
    }

    // Edit mode treats a set as done once it has every value it needs. Live, a done set that loses
    // a value (backspacing '60' to type '62.5') un-ticks but remembers it (wasDone), and ticks
    // itself again once complete; only the ✓ button un-ticks for good.
    const settle = (set, tracking) => {
      const complete = !missingKeys(tracking, set).length
      if (set.done && !complete) return isLive() ? { ...set, done: false, wasDone: true } : { ...set, done: false }
      if (!set.done && complete && (!isLive() || set.wasDone)) {
        const { wasDone, ...rest } = set // eslint-disable-line no-unused-vars
        return { ...rest, done: true }
      }
      return set
    }

    const scrollToSet = (exIndex, setIndex) => {
      if (setIndex === null || setIndex === undefined) return
      requestAnimationFrame(() => {
        const element = document.getElementById(setDomId(domPrefix, exIndex, setIndex))
        if (!element) return
        element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
        element.classList.remove('is-flash')
        void element.offsetWidth
        element.classList.add('is-flash')
        setTimeout(() => element.classList.remove('is-flash'), 1400)
      })
    }

    const buildRow = (entry) => {
      const prefsNow = prefsRef.current
      const meta = (hasOwn(metaRef.current, entry.id) && metaRef.current[entry.id]) || null
      const previous = previousSets(baseRef.current, entry.id, { routineId: latest.current?.routineId ?? null, source: prefsNow.previousSource })
      const types = previous?.length ? previous.map(setTypeOf) : ['normal', 'normal', 'normal']
      return {
        id: newGymId(),
        exerciseId: entry.id,
        name: entry.name || 'Exercise',
        tracking: trackingOf(entry.tracking),
        restSec: restSecFor(null, meta, entry, prefsNow),
        note: '',
        supersetId: null,
        sets: types.map((type) => blankSet(type)),
      }
    }

    return {
      setValue(exRef, setRef, key, value) {
        withSet(exRef, setRef, (set, j, ex, i, w) => {
          if (set[key] === value) return null
          return withPrs(w, i, j, ex, settle({ ...set, [key]: value }, trackingOf(ex.tracking)))
        })
      },

      setRpe(exRef, setRef, rpe) {
        withSet(exRef, setRef, (set) => (set.rpe === rpe ? null : { ...set, rpe }))
      },

      copyPrevious(exRef, setRef, previous) {
        if (!previous) return
        withSet(exRef, setRef, (set, j, ex, i, w) => {
          const tracking = trackingOf(ex.tracking)
          const next = { ...set }
          let changed = false
          for (const key of fieldKeys(tracking)) {
            if (isNum(previous[key]) && next[key] !== previous[key]) {
              next[key] = previous[key]
              changed = true
            }
          }
          if (prefsRef.current.showRpe && isNum(previous.rpe) && next.rpe !== previous.rpe) {
            next.rpe = previous.rpe
            changed = true
          }
          return changed ? withPrs(w, i, j, ex, settle(next, tracking)) : null
        })
      },

      toggleDone(exRef, setRef, placeholder) {
        unlockAudio()
        let missing = null
        let message = null
        let scroll = null
        let doneIds = null
        update((w) => {
          const list = exercisesOf(w)
          const i = indexOf(list, exRef)
          if (i < 0) return null
          const ex = list[i]
          const sets = setsOf(ex)
          const j = indexOf(sets, setRef)
          if (j < 0) return null
          const set = sets[j]
          if (set.done) {
            // Un-ticking right after a tick also cancels the rest that tick started.
            const rest = w.rest
            const accidental = rest && rest.exerciseId === String(ex.id ?? i) && Date.now() - (rest.endAt - (rest.durationSec || 0) * 1000) < 8000
            const { wasDone, ...undone } = withoutPrs(set) // eslint-disable-line no-unused-vars
            return { ...w, exercises: replaceAt(list, i, { ...ex, sets: replaceAt(sets, j, { ...undone, done: false }) }), ...(accidental ? { rest: null } : {}) }
          }
          const tracking = trackingOf(ex.tracking)
          const { wasDone, ...filled } = fillFromPlaceholder(set, tracking, placeholder) // eslint-disable-line no-unused-vars
          const gaps = missingKeys(tracking, filled)
          if (gaps.length) {
            missing = gaps
            return null
          }
          const doneSet = withPrs(w, i, j, ex, { ...filled, done: true })
          if (doneSet.prs) message = prMessage(doneSet.prs, doneSet, tracking, prefsRef.current)
          const nextList = replaceAt(list, i, { ...ex, sets: replaceAt(sets, j, doneSet) })
          let rest = w.rest ?? null
          if (isLive()) {
            const group = supersetGroups(nextList)[i]
            if (group && !group.last) {
              // Straight on to the same set of the next exercise in the superset.
              rest = null
              scroll = [i + 1, nextOpenSet(nextList[i + 1], j)]
            } else {
              // Typing in a past workout ('Add past workout') needs no rest timer.
              const seconds = isBackfillWorkout(w) ? 0 : restAfter(set, sets[j + 1], deriveRef.current(ex).rest, prefsRef.current)
              rest = seconds > 0 ? { endAt: Date.now() + seconds * 1000, durationSec: seconds, exerciseId: String(ex.id ?? i) } : null
              if (group) {
                const first = i - group.pos + 1
                scroll = [first, nextOpenSet(nextList[first], j + 1)]
              }
            }
          }
          doneIds = [ex.id ?? i, set.id ?? j]
          return { ...w, exercises: nextList, rest }
        })
        if (missing) {
          setShake({ ex: keyOf(exRef), set: keyOf(setRef), keys: missing, n: Date.now() })
          try {
            navigator.vibrate?.([20, 40, 20])
          } catch {
            // optional
          }
        }
        if (message) toast(message, { tone: 'success' })
        if (scroll) scrollToSet(scroll[0], scroll[1])
        if (doneIds) onSetDoneRef.current?.(doneIds[0], doneIds[1])
      },

      setType(exRef, setRef, type) {
        withSet(exRef, setRef, (set, j, ex, i, w) => {
          const currentType = setTypeOf(set)
          const nextType = currentType === type ? 'normal' : type
          if (nextType === currentType) return null
          return withPrs(w, i, j, ex, { ...set, type: nextType })
        })
      },

      addSet(exRef) {
        withExercise(exRef, (ex) => {
          const sets = setsOf(ex)
          const tracking = trackingOf(ex.tracking)
          const last = sets[sets.length - 1]
          if (!last) return { ...ex, sets: [blankSet('normal')] }
          const shown = deriveRef.current(ex).rows[sets.length - 1]?.placeholder || {}
          const values = {}
          for (const key of VALUE_KEYS) values[key] = last[key]
          // The copy keeps the placeholders the last row showed (they may come from its index).
          const target = last.target && typeof last.target === 'object'
            ? { ...last.target }
            : VALUE_KEYS.some((key) => isNum(shown[key]))
              ? { weightKg: shown.weightKg, repsMin: null, repsMax: shown.reps, durationSec: shown.durationSec, distanceM: shown.distanceM, rpe: null }
              : null
          return { ...ex, sets: [...sets, settle(blankSet(setTypeOf(last), values, target), tracking)] }
        })
      },

      deleteSet(exRef, setRef) {
        let removed = null
        let at = -1
        withExercise(exRef, (ex) => {
          const sets = setsOf(ex)
          const j = indexOf(sets, setRef)
          if (j < 0) return null
          removed = sets[j]
          at = j
          return { ...ex, sets: sets.filter((_, k) => k !== j) }
        })
        setSwiped(null)
        if (!removed) return
        const restore = removed
        toast(removed.done ? 'Completed set deleted' : 'Set deleted', {
          action: {
            label: 'Undo',
            onClick: () => withExercise(exRef, (ex) => {
              const sets = setsOf(ex)
              if (restore.id != null && sets.some((set) => set.id === restore.id)) return null
              const next = [...sets]
              next.splice(Math.min(at, next.length), 0, restore)
              return { ...ex, sets: next }
            }),
          },
        })
      },

      setNote(exRef, text) {
        withExercise(exRef, (ex) => (ex.note === text ? null : { ...ex, note: text }))
      },

      addExercises(entries) {
        const picked = (Array.isArray(entries) ? entries : [entries]).filter((entry) => entry && typeof entry.id === 'string')
        if (!picked.length) return
        let firstIndex = -1
        update((w) => {
          const list = exercisesOf(w)
          firstIndex = list.length
          return { ...w, exercises: [...list, ...picked.map(buildRow)] }
        })
        if (firstIndex >= 0) setScrollCard(firstIndex)
      },

      replaceExercise(exRef, entry) {
        if (!entry || typeof entry.id !== 'string') return
        let before = null
        withExercise(exRef, (ex, i, w) => {
          if (ex.exerciseId === entry.id) return null
          before = ex
          const tracking = trackingOf(entry.tracking)
          const same = tracking === trackingOf(ex.tracking)
          const keep = new Set(fieldKeys(tracking))
          const meta = (hasOwn(metaRef.current, entry.id) && metaRef.current[entry.id]) || null
          // Sets are kept; weights only carry over when the tracking type is the same.
          const sets = setsOf(ex).map((set) => {
            const clean = withoutPrs(set)
            if (same) return clean
            const next = { ...clean }
            for (const key of VALUE_KEYS) if (key === 'weightKg' || !keep.has(key)) next[key] = null
            next.target = clean.target && typeof clean.target === 'object' ? { ...clean.target, weightKg: null } : null
            next.done = !!clean.done && !missingKeys(tracking, next).length
            return next
          })
          const replaced = { ...ex, exerciseId: entry.id, name: entry.name || 'Exercise', tracking, restSec: restSecFor(null, meta, entry, prefsRef.current), sets }
          return { ...replaced, sets: sets.map((set, j) => (set.done ? withPrs(w, i, j, replaced, set) : set)) }
        })
        if (!before) return
        const original = before
        toast(`Replaced ${original.name || 'exercise'} with ${entry.name}`, {
          action: { label: 'Undo', onClick: () => withExercise(exRef, (ex) => (ex.exerciseId === entry.id ? original : null)) },
        })
      },

      removeExercise(exRef) {
        let removed = null
        let at = -1
        let links = null
        update((w) => {
          const list = exercisesOf(w)
          const i = indexOf(list, exRef)
          if (i < 0) return null
          removed = list[i]
          at = i
          links = new Map(list.map((row) => [row.id, row.supersetId ?? null]))
          return { ...w, exercises: normalizeSupersets(list.filter((_, k) => k !== i)) }
        })
        if (!removed) return
        const restore = removed
        toast(`Removed ${restore.name || 'exercise'}`, {
          action: {
            label: 'Undo',
            onClick: () => update((w) => {
              const list = exercisesOf(w)
              if (restore.id != null && list.some((row) => row.id === restore.id)) return null
              const next = [...list]
              next.splice(Math.min(at, next.length), 0, restore)
              // Superset partners unlinked by the removal get their group back.
              const relinked = next.map((row) => (row.supersetId == null && links.get(row.id) != null ? { ...row, supersetId: links.get(row.id) } : row))
              return { ...w, exercises: normalizeSupersets(relinked) }
            }),
          },
        })
      },

      move(exRef, delta) {
        update((w) => {
          const list = [...exercisesOf(w)]
          const i = indexOf(list, exRef)
          const k = i + delta
          if (i < 0 || k < 0 || k >= list.length) return null
          const moving = list[i]
          list[i] = list[k]
          list[k] = moving
          return { ...w, exercises: normalizeSupersets(list) }
        })
      },

      linkNext(exRef) {
        update((w) => {
          const list = exercisesOf(w)
          const i = indexOf(list, exRef)
          const a = list[i]
          const b = list[i + 1]
          if (!a || !b) return null
          const id = a.supersetId ?? b.supersetId ?? newGymId()
          const joining = new Set([a.supersetId, b.supersetId].filter((value) => value != null))
          const next = list.map((row, k) => (k === i || k === i + 1 || joining.has(row.supersetId) ? { ...row, supersetId: id } : row))
          return { ...w, exercises: normalizeSupersets(next) }
        })
      },

      unlink(exRef) {
        update((w) => {
          const list = exercisesOf(w)
          const i = indexOf(list, exRef)
          if (i < 0 || list[i].supersetId == null) return null
          return { ...w, exercises: normalizeSupersets(replaceAt(list, i, { ...list[i], supersetId: null })) }
        })
      },

      setRest(exRef, seconds) {
        const value = Math.min(600, Math.max(0, Math.round(seconds / 15) * 15))
        let exerciseId = null
        withExercise(exRef, (ex) => {
          exerciseId = ex.exerciseId
          return ex.restSec === value ? null : { ...ex, restSec: value }
        })
        if (!exerciseId) return
        // Remembered so the next workout starts with it too: as the exercise's own rest (new
        // routines and workouts) and on its rows in the routine this workout came from, whose rest
        // is what that routine's workouts start with.
        setExerciseMeta(exerciseId, { restSec: value })
        const routineId = isLive() ? current()?.routineId : null
        const routine = routineId ? routineById(getGym(), routineId) : null
        const rows = Array.isArray(routine?.exercises) ? routine.exercises : []
        if (!rows.some((row) => row?.exerciseId === exerciseId && row.restSec !== value)) return
        try {
          saveRoutine({ ...routine, exercises: rows.map((row) => (row?.exerciseId === exerciseId ? { ...row, restSec: value } : row)) })
        } catch {
          // the workout keeps its rest either way
        }
      },

      addWarmups(exRef) {
        let message = null
        withExercise(exRef, (ex) => {
          const derived = deriveRef.current(ex)
          if (derived.tracking !== 'weight_reps') return null
          const sets = setsOf(ex)
          const j = sets.findIndex((set) => setTypeOf(set) !== 'warmup')
          const working = j >= 0 ? firstNum(sets[j].weightKg, derived.rows[j]?.placeholder.weightKg) : null
          if (!(working > 0)) {
            message = 'Enter a weight for your first working set, then add warm-ups.'
            return null
          }
          const rows = warmupSets(working, derived.entry || { tracking: 'weight_reps' }, prefsRef.current)
          if (!rows.length) {
            message = `No warm-up needed for ${formatWeight(working, prefsRef.current.unit)}.`
            return null
          }
          // Replaces warm-ups not done yet; completed ones stay, and their loads aren't repeated.
          const kept = sets.filter((set) => !(setTypeOf(set) === 'warmup' && !set.done))
          const doneLoads = kept.filter((set) => setTypeOf(set) === 'warmup').map((set) => set.weightKg).filter(isNum)
          const fresh = rows.filter((row) => !doneLoads.some((kg) => Math.abs(kg - row.weightKg) < 1e-6))
          if (!fresh.length) {
            message = 'Your warm-ups for this weight are already done.'
            return null
          }
          const warmups = fresh.map((row) => settle(blankSet('warmup', { weightKg: row.weightKg, reps: row.reps }), derived.tracking))
          const at = kept.findIndex((set) => setTypeOf(set) !== 'warmup')
          const position = at < 0 ? kept.length : at
          message = `Added ${plural(warmups.length, 'warm-up set')} for ${formatWeight(working, prefsRef.current.unit)}`
          return { ...ex, sets: [...kept.slice(0, position), ...warmups, ...kept.slice(position)] }
        })
        if (message) toast(message)
      },

      openMenu: (exRef) => setSheet({ kind: 'menu', exRef }),
      openSetType: (exRef, setRef) => setSheet({ kind: 'type', exRef, setRef }),
      openRest: (exRef) => setSheet({ kind: 'rest', exRef }),
      openPinned: (exRef) => setSheet({ kind: 'pinned', exRef }),
      openAdd: () => setPicker({ mode: 'add', open: true }),
      openReplace: (exRef) => setPicker({ mode: 'replace', exRef, open: true }),
      setSwiped,
      closeNote: (key) => setOpenNotes((current) => {
        if (!current.has(key)) return current
        const next = new Set(current)
        next.delete(key)
        return next
      }),
      openNote: (key, exIndex) => {
        setOpenNotes((current) => new Set(current).add(key))
        setTimeout(() => document.getElementById(noteDomId(domPrefix, exIndex))?.focus(), 320)
      },
    }
  }, [domPrefix])

  // Clear the shake once it has played.
  useEffect(() => {
    if (!shake) return undefined
    const timer = setTimeout(() => setShake(null), 1200)
    return () => clearTimeout(timer)
  }, [shake])

  // A row swiped open closes on any tap elsewhere.
  useEffect(() => {
    if (!swiped) return undefined
    const onDown = (event) => {
      if (!event.target.closest?.('.gym-set.is-open')) setSwiped(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [swiped])

  // Bring newly added exercises into view.
  useEffect(() => {
    if (scrollCard === null) return
    const element = document.getElementById(cardDomId(domPrefix, scrollCard))
    if (element) element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    setScrollCard(null)
  }, [scrollCard, domPrefix, exercises.length])

  const groups = useMemo(() => supersetGroups(exercises), [exercises])

  if (!workout) return null

  const closeSheet = () => setSheet(null)
  const find = (ref) => {
    const i = indexOf(exercises, ref)
    return i >= 0 ? { exercise: exercises[i], index: i } : null
  }

  // ---- reorder mode ----
  if (reorder && exercises.length) {
    return (
      <div className="gym-log">
        <div className="gym-log-reorder-bar">
          <div>
            <strong>Reorder exercises</strong>
            <span>Move exercises with the arrows</span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setReorder(false)}>Done</button>
        </div>
        <ol className="gym-log-reorder">
          {exercises.map((exercise, index) => {
            const group = groups[index]
            const ref = { id: exercise.id, i: index }
            const name = exercise.name || 'Exercise'
            return (
              <li key={exercise.id ?? index} className={`gym-log-reorder-row${group ? ' has-ss' : ''}`} style={group ? { '--gym-ss': group.color } : undefined}>
                {group && <span className="gym-ss-tag">{group.letter}{group.pos}</span>}
                <span className="gym-log-reorder-name">
                  <span>{name}</span>
                  <small>{plural(setsOf(exercise).length, 'set')}</small>
                </span>
                <button type="button" className="icon-btn" onClick={() => actions.move(ref, -1)} disabled={index === 0} aria-label={`Move ${name} up`}>
                  <Icon name="arrowUp" size={20} />
                </button>
                <button type="button" className="icon-btn" onClick={() => actions.move(ref, 1)} disabled={index === exercises.length - 1} aria-label={`Move ${name} down`}>
                  <Icon name="arrowDown" size={20} />
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

  // ---- sheets ----
  const menuSheet = lastSheets.current.menu
  const menuTarget = menuSheet ? find(menuSheet.exRef) : null
  const typeSheet = lastSheets.current.type
  const typeTarget = typeSheet ? find(typeSheet.exRef) : null
  const typeSetIndex = typeTarget ? indexOf(setsOf(typeTarget.exercise), typeSheet.setRef) : -1
  const typeSet = typeSetIndex >= 0 ? setsOf(typeTarget.exercise)[typeSetIndex] : null
  const typeRow = typeSet ? derive(typeTarget.exercise).rows[typeSetIndex] : null
  const restSheet = lastSheets.current.rest
  const restTarget = restSheet ? find(restSheet.exRef) : null
  const pinnedSheet = lastSheets.current.pinned
  const pinnedTarget = pinnedSheet ? find(pinnedSheet.exRef) : null
  const pickerTarget = picker?.mode === 'replace' ? find(picker.exRef) : null

  // The card's ⋯ menu (the shared ActionSheet, which closes itself before running an action),
  // grouped by intent: things for this workout, tools, then arranging the list, with the
  // destructive action last on its own.
  function menuItems() {
    if (!menuTarget) return { groups: [], name: '' }
    const { exercise, index } = menuTarget
    const ref = { id: exercise.id, i: index }
    const key = keyOf(ref)
    const derived = derive(exercise)
    const name = exercise.name || 'Exercise'
    const next = exercises[index + 1]
    const linkedWithNext = next && exercise.supersetId != null && next.supersetId === exercise.supersetId
    const log = [
      !exercise.note && !openNotes.has(key) && { id: 'note', icon: 'pencil', label: 'Add a note', hint: 'For this workout only', onClick: () => actions.openNote(key, index) },
      { id: 'pinned', icon: 'note', label: derived.meta?.note ? 'Edit pinned note' : 'Pin a note', hint: 'Shown every time you do this exercise', onClick: () => setSheet({ kind: 'pinned', exRef: ref }) },
      live && { id: 'rest', icon: 'timer', label: 'Rest timer', value: derived.rest ? formatDuration(derived.rest) : 'Off', onClick: () => setSheet({ kind: 'rest', exRef: ref }) },
    ]
    const tools = [
      derived.tracking === 'weight_reps' && { id: 'warmups', icon: 'flame', label: 'Add warm-up sets', hint: 'Lighter sets that build up to your first working weight', onClick: () => actions.addWarmups(ref) },
      derived.barbell && {
        id: 'plates',
        icon: 'calculator',
        label: 'Plate calculator',
        hint: 'Which plates to load on the bar',
        onClick: () => setPlates({ open: true, initialKg: plateWeight(exercise, derived), exercise: derived.entry || { equipment: 'barbell', tracking: 'weight_reps' } }),
      },
      live && exercise.exerciseId && { id: 'history', icon: 'history', label: 'History & records', onClick: () => navigate(`gym/exercise/${encodeURIComponent(exercise.exerciseId)}`) },
    ]
    const arrange = [
      { id: 'replace', icon: 'shuffle', label: 'Replace exercise', hint: 'Keeps the sets', onClick: () => actions.openReplace(ref) },
      next && !linkedWithNext && { id: 'link', icon: 'link', label: 'Superset with next', hint: `Alternate with ${next.name || 'the next exercise'}, no rest in between`, onClick: () => actions.linkNext(ref) },
      exercise.supersetId != null && { id: 'unlink', icon: 'link', label: 'Unlink superset', onClick: () => actions.unlink(ref) },
      exercises.length > 1 && { id: 'reorder', icon: 'layers', label: 'Reorder exercises', onClick: () => setReorder(true) },
    ]
    const danger = [{ id: 'remove', icon: 'trash', label: 'Remove exercise', danger: true, onClick: () => actions.removeExercise(ref) }]
    return { groups: [log, tools, arrange, danger], name }
  }

  const menu = menuItems()

  return (
    <div className="gym-log">
      {exercises.length === 0 ? (
        <GymEmpty
          icon="dumbbell"
          title="No exercises yet"
          action={<Button icon="plus" onClick={actions.openAdd}>Add exercises</Button>}
        >
          Pick from the library or your own exercises, then log each set as you go.
        </GymEmpty>
      ) : (
        <ol className="gym-ex-list">
          {exercises.map((exercise, index) => {
            const ref = { id: exercise.id, i: index }
            const key = keyOf(ref)
            const group = groups[index]
            const swipedHere = swiped && swiped.startsWith(`${key}|`) ? swiped.slice(key.length + 1) : null
            return (
              <ExerciseCard
                key={exercise.id ?? index}
                exercise={exercise}
                index={index}
                derived={derive(exercise)}
                live={live}
                prefs={prefs}
                ssLetter={group?.letter ?? null}
                ssPos={group?.pos ?? null}
                ssColor={group?.color ?? null}
                ssLast={group ? group.last : null}
                swipedSet={swipedHere}
                shake={shake && shake.ex === key ? shake : null}
                noteOpen={openNotes.has(key)}
                domPrefix={domPrefix}
                actions={actions}
              />
            )
          })}
        </ol>
      )}

      {exercises.length > 0 && (
        <button type="button" className="btn btn-secondary btn-block gym-add-ex" onClick={actions.openAdd}>
          <Icon name="plus" size={20} />
          Add exercises
        </button>
      )}

      <ActionSheet open={sheet?.kind === 'menu' && !!menuTarget} onClose={closeSheet} title={menu.name || 'Exercise'} actions={menu.groups} />

      <Sheet
        open={sheet?.kind === 'type' && !!typeSet}
        onClose={closeSheet}
        title={typeSet ? (setTypeOf(typeSet) === 'normal' ? `Set ${typeRow?.number ?? ''}` : `${TYPE_NAME[setTypeOf(typeSet)]} ${typeRow?.typeIndex ?? ''}`) : 'Set'}
        description="Choose the set type"
        size="sm"
        initialFocus={false}
      >
        {typeSet && (
          <>
            <ul className="gym-actions">
              {TYPE_OPTIONS.map((option) => {
                const selected = setTypeOf(typeSet) === option.type
                return (
                  <li key={option.type}>
                    <button
                      type="button"
                      className={`gym-action${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        actions.setType(typeSheet.exRef, typeSheet.setRef, option.type)
                        closeSheet()
                      }}
                    >
                      <span className="gym-action-icon" aria-hidden="true">
                        <SetTypeBadge type={option.type} number={option.type === 'normal' ? typeRow?.number ?? 1 : undefined} />
                      </span>
                      <span className="gym-action-text">
                        <span>{option.label}</span>
                        <small>{selected && option.type !== 'normal' ? 'Tap again to make it a normal set' : option.hint}</small>
                      </span>
                      {selected && <Icon name="check" size={20} strokeWidth={2.4} className="gym-action-check" />}
                    </button>
                  </li>
                )
              })}
            </ul>
            <ActionList
              items={[{
                icon: 'trash',
                label: 'Delete set',
                tone: 'danger',
                onClick: () => {
                  closeSheet()
                  actions.deleteSet(typeSheet.exRef, typeSheet.setRef)
                },
              }]}
            />
          </>
        )}
      </Sheet>

      <RestEditSheet
        open={sheet?.kind === 'rest' && !!restTarget}
        onClose={closeSheet}
        name={restTarget?.exercise.name || 'Exercise'}
        value={restTarget ? derive(restTarget.exercise).rest : 0}
        warmupRest={prefs.warmupRest}
        onSave={(seconds) => {
          if (restTarget) actions.setRest(restSheet.exRef, seconds)
          closeSheet()
        }}
      />

      <PinnedNoteSheet
        open={sheet?.kind === 'pinned' && !!pinnedTarget}
        onClose={closeSheet}
        exercise={pinnedTarget?.exercise || null}
        note={pinnedTarget ? derive(pinnedTarget.exercise).meta?.note || '' : ''}
      />

      {picker && (
        <ExercisePicker
          open={picker.open}
          onClose={() => setPicker((current) => (current ? { ...current, open: false } : current))}
          multi={picker.mode === 'add'}
          title={picker.mode === 'add' ? 'Add exercises' : `Replace ${pickerTarget?.exercise.name || 'exercise'}`}
          excludeIds={picker.mode === 'replace' && pickerTarget?.exercise.exerciseId ? [pickerTarget.exercise.exerciseId] : []}
          onPick={(entries) => {
            const list = Array.isArray(entries) ? entries : [entries]
            if (picker.mode === 'add') actions.addExercises(list)
            else if (list[0]) actions.replaceExercise(picker.exRef, list[0])
            setPicker((current) => (current ? { ...current, open: false } : current))
          }}
        />
      )}

      {plates && (
        <PlateCalculatorSheet
          open={plates.open}
          onClose={() => setPlates((current) => (current ? { ...current, open: false } : current))}
          initialKg={plates.initialKg ?? undefined}
          exercise={plates.exercise}
        />
      )}
    </div>
  )
}

// Weight for the plate calculator: the next working set to do, else the last one logged.
function plateWeight(exercise, derived) {
  const sets = setsOf(exercise)
  for (let j = 0; j < sets.length; j++) {
    if (setTypeOf(sets[j]) === 'warmup' || sets[j].done) continue
    const kg = firstNum(sets[j].weightKg, derived.rows[j]?.placeholder.weightKg)
    if (kg !== null) return kg
  }
  for (let j = sets.length - 1; j >= 0; j--) {
    const kg = firstNum(sets[j].weightKg, derived.rows[j]?.placeholder.weightKg)
    if (kg !== null) return kg
  }
  return null
}

function ActionList({ items }) {
  if (!items?.length) return null
  return (
    <ul className="gym-actions">
      {items.map((item) => (
        <li key={item.label}>
          <button type="button" className={`gym-action${item.tone === 'danger' ? ' is-danger' : ''}`} onClick={item.onClick}>
            <span className="gym-action-icon" aria-hidden="true"><Icon name={item.icon} size={20} /></span>
            <span className="gym-action-text">
              <span>{item.label}</span>
              {item.hint && <small>{item.hint}</small>}
            </span>
            {item.value && <span className="gym-action-value">{item.value}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---- one exercise ------------------------------------------------------------------------------

const ExerciseCard = memo(function ExerciseCard({
  exercise, index, derived, live, prefs, ssLetter, ssPos, ssColor, ssLast, swipedSet, shake, noteOpen, domPrefix, actions,
}) {
  const exRef = { id: exercise.id, i: index }
  const exKey = keyOf(exRef)
  const sets = setsOf(exercise)
  const tracking = derived.tracking
  const unit = prefs.unit
  const cols = useMemo(() => columnsFor(tracking, unit, prefs.distanceUnit), [tracking, unit, prefs.distanceUnit])
  const gridClass = `gym-grid f${cols.length}${prefs.showRpe ? ' rpe' : ''}`
  const done = sets.filter((set) => set.done).length
  const name = exercise.name || 'Exercise'
  const pinned = typeof derived.meta?.note === 'string' ? derived.meta.note.trim() : ''
  const showNote = noteOpen || !!exercise.note
  const suggestion = live ? derived.suggestion : null

  return (
    <li
      id={cardDomId(domPrefix, index)}
      className={`gym-ex${ssLetter ? ' has-ss' : ''}${ssLetter && !ssLast ? ' ss-continues' : ''}`}
      style={ssColor ? { '--gym-ss': ssColor } : undefined}
      aria-labelledby={`${domPrefix}-h-${index}`}
    >
      <header className="gym-ex-head">
        {ssLetter && (
          <span className="gym-ss-tag" title={`Superset ${ssLetter}`}>
            <span className="sr-only">Superset </span>
            {ssLetter}{ssPos}
          </span>
        )}
        <div className="gym-ex-title">
          <h3 className="gym-ex-name" id={`${domPrefix}-h-${index}`}>
            {live && exercise.exerciseId
              ? <button type="button" onClick={() => navigate(`gym/exercise/${encodeURIComponent(exercise.exerciseId)}`)}>{name}</button>
              : <span>{name}</span>}
          </h3>
          {(derived.muscles || suggestion?.increased || suggestion?.deload) && (
            <p className="gym-ex-meta">
              {derived.muscles && <span>{derived.muscles}</span>}
              {suggestion?.increased && derived.increase > 0 && (
                <span className="gym-ex-chip is-up" title="Progression: you hit the top of your rep range last time">
                  <Icon name="arrowUp" size={12} strokeWidth={2.6} />
                  +{formatWeight(derived.increase, unit)}
                </span>
              )}
              {suggestion?.deload && (
                <span className="gym-ex-chip is-down" title="Stalled three sessions in a row: weight reduced to build back up">
                  <Icon name="arrowDown" size={12} strokeWidth={2.6} />
                  Reset
                </span>
              )}
            </p>
          )}
        </div>
        {sets.length > 0 && (
          <span className={`gym-ex-count${done === sets.length ? ' is-complete' : ''}`} aria-label={`${done} of ${sets.length} sets done`}>
            {done}/{sets.length}
          </span>
        )}
        <button type="button" className="icon-btn gym-ex-more" onClick={() => actions.openMenu(exRef)} aria-label={`Options for ${name}`}>
          <Icon name="more" size={22} strokeWidth={2.2} />
        </button>
      </header>

      {pinned && (
        <button type="button" className="gym-pinned" onClick={() => actions.openPinned(exRef)} aria-label={`Pinned note: ${pinned}. Edit`}>
          <Icon name="note" size={15} strokeWidth={2} />
          <span>{pinned}</span>
        </button>
      )}

      {showNote && (
        <AutoTextarea
          id={noteDomId(domPrefix, index)}
          className="gym-ex-note"
          value={exercise.note || ''}
          onChange={(event) => actions.setNote(exRef, event.target.value)}
          onBlur={(event) => {
            if (!event.target.value.trim()) {
              if (exercise.note) actions.setNote(exRef, '')
              actions.closeNote(exKey)
            }
          }}
          placeholder="Note for this workout"
          aria-label={`Note for ${name} in this workout`}
          minRows={1}
          maxRows={6}
        />
      )}

      {sets.length > 0 ? (
        <div className="gym-sets">
          <div className={`${gridClass} gym-grid-head`} aria-hidden="true">
            <span>SET</span>
            <span>PREVIOUS</span>
            {cols.map((col) => <span key={col.key}>{col.label}</span>)}
            {prefs.showRpe && <span>RPE</span>}
            <span className="gym-grid-head-check"><Icon name="check" size={15} strokeWidth={2.6} /></span>
          </div>
          {sets.map((set, setIndex) => {
            const setKey = keyOf({ id: set.id, i: setIndex })
            return (
              <SetRow
                key={set.id ?? setIndex}
                set={set}
                setIndex={setIndex}
                exRef={exRef}
                exKey={exKey}
                setKey={setKey}
                row={derived.rows[setIndex]}
                cols={cols}
                gridClass={gridClass}
                tracking={tracking}
                prefs={prefs}
                isOpen={swipedSet === setKey}
                shake={shake && shake.set === setKey ? shake : null}
                domId={setDomId(domPrefix, index, setIndex)}
                actions={actions}
              />
            )
          })}
        </div>
      ) : (
        <p className="gym-ex-empty">No sets yet.</p>
      )}

      <div className="gym-ex-foot">
        <button type="button" className="gym-add-set" onClick={() => actions.addSet(exRef)}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
          Add Set
        </button>
        {live && (
          <button
            type="button"
            className={`gym-rest-chip${derived.rest ? '' : ' is-off'}`}
            onClick={() => actions.openRest(exRef)}
            aria-label={`Rest timer for ${name}: ${derived.rest ? formatDuration(derived.rest) : 'off'}. Change`}
          >
            <Icon name="timer" size={16} strokeWidth={2} />
            {derived.rest ? formatDuration(derived.rest) : 'Off'}
          </button>
        )}
      </div>
    </li>
  )
})

// ---- one set -----------------------------------------------------------------------------------

function SetRow({ set, setIndex, exRef, exKey, setKey, row, cols, gridClass, tracking, prefs, isOpen, shake, domId, actions }) {
  const rowRef = useRef(null)
  const slideRef = useRef(null)
  const drag = useRef(null)
  const suppressClick = useRef(false)
  const swipeEnd = useRef(null)
  const type = setTypeOf(set)
  const setRef = { id: set.id, i: setIndex }
  const info = row || { number: null, typeIndex: setIndex + 1, previous: null, placeholder: {}, targetRpe: null }
  const setName = type === 'normal' ? `Set ${info.number}` : `${TYPE_NAME[type]} ${info.typeIndex}`
  const previousText = formatSetShort(info.previous, tracking, prefs.unit, prefs.distanceUnit)
  const placeholder = info.placeholder || {}

  const wasOpen = useRef(isOpen)
  useEffect(() => {
    const slide = slideRef.current
    const closing = wasOpen.current && !isOpen
    wasOpen.current = isOpen
    if (!slide || drag.current?.active) return undefined
    slide.style.transform = isOpen ? `translateX(${-OPEN_X}px)` : ''
    if (!closing) return undefined
    // Keep the Delete layer while the row slides shut.
    const row = rowRef.current
    row?.classList.add('is-swiping')
    const timer = setTimeout(() => row?.classList.remove('is-swiping'), 360)
    return () => clearTimeout(timer)
  }, [isOpen])

  useEffect(() => () => clearTimeout(swipeEnd.current), [])

  // Restart the shake on every failed tick.
  useEffect(() => {
    const element = rowRef.current
    if (!shake || !element) return undefined
    element.classList.remove('is-shaking')
    void element.offsetWidth
    element.classList.add('is-shaking')
    const timer = setTimeout(() => element.classList.remove('is-shaking'), 500)
    return () => clearTimeout(timer)
  }, [shake?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe left to reveal Delete; a long swipe deletes straight away.
  const onPointerDown = (event) => {
    suppressClick.current = false
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest?.('select, .gym-set-delete')) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: isOpen ? -OPEN_X : 0, offset: null, active: false, width: rowRef.current?.offsetWidth || 320 }
  }
  const onPointerMove = (event) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      if (!isOpen && dx > 0) {
        drag.current = null
        return
      }
      d.active = true
      try {
        rowRef.current?.setPointerCapture?.(event.pointerId)
      } catch {
        // capture is best-effort
      }
      if (slideRef.current) slideRef.current.style.transition = 'none'
      clearTimeout(swipeEnd.current)
      rowRef.current?.classList.add('is-swiping')
      const focused = document.activeElement
      if (focused && rowRef.current?.contains(focused)) focused.blur?.()
    }
    d.offset = Math.max(-d.width * 0.92, Math.min(0, d.base + dx))
    if (slideRef.current) slideRef.current.style.transform = `translateX(${d.offset}px)`
  }
  const finishDrag = (cancelled) => {
    const d = drag.current
    drag.current = null
    if (!d?.active) return
    suppressClick.current = true
    const slide = slideRef.current
    if (slide) slide.style.transition = ''
    // Keep the Delete layer until the row has slid back.
    clearTimeout(swipeEnd.current)
    swipeEnd.current = setTimeout(() => rowRef.current?.classList.remove('is-swiping'), 360)
    const offset = cancelled ? d.base : d.offset ?? d.base
    if (!cancelled && offset < -d.width * 0.55) {
      if (slide) slide.style.transform = `translateX(${-d.width}px)`
      actions.deleteSet(exRef, setRef)
      return
    }
    const open = offset < -OPEN_X / 2
    if (slide) slide.style.transform = open ? `translateX(${-OPEN_X}px)` : ''
    actions.setSwiped(open ? `${exKey}|${setKey}` : null)
  }
  const onClickCapture = (event) => {
    if (suppressClick.current) {
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (isOpen && !event.target.closest?.('.gym-set-delete')) {
      event.preventDefault()
      event.stopPropagation()
      actions.setSwiped(null)
    }
  }

  const onEnterNext = (event) => {
    if (event.key !== 'Enter') return
    const inputs = [...(rowRef.current?.querySelectorAll('input') || [])]
    const next = inputs[inputs.indexOf(event.currentTarget) + 1]
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }

  const missing = shake?.keys || []
  const cell = (col, isLast) => {
    const common = {
      className: missing.includes(col.key) ? 'is-missing' : '',
      ariaLabel: `${setName} ${col.name}`,
      onFocus: selectOnFocus,
      enterKeyHint: isLast ? 'done' : 'next',
      onKeyDown: isLast ? undefined : onEnterNext,
    }
    const change = (value) => actions.setValue(exRef, setRef, col.key, value)
    if (col.key === 'weightKg') {
      return <WeightInput key={col.key} {...common} valueKg={set.weightKg} unit={prefs.unit} onChange={change} placeholder={isNum(placeholder.weightKg) ? placeholder.weightKg : ''} />
    }
    if (col.key === 'reps') {
      return <NumberInput key={col.key} {...common} value={set.reps} onChange={change} min={0} max={9999} placeholder={isNum(placeholder.reps) ? placeholder.reps : ''} />
    }
    if (col.key === 'durationSec') {
      return <DurationInput key={col.key} {...common} valueSec={set.durationSec} onChange={change} placeholder={isNum(placeholder.durationSec) ? placeholder.durationSec : ''} />
    }
    return (
      <NumberInput
        key={col.key}
        {...common}
        decimal
        value={isNum(set.distanceM) ? fromMeters(set.distanceM, col.unit) : null}
        onChange={(value) => change(value === null ? null : toMeters(value, col.unit))}
        placeholder={isNum(placeholder.distanceM) ? fromMeters(placeholder.distanceM, col.unit) : ''}
      />
    )
  }

  const prs = Array.isArray(set.prs) ? set.prs : []
  const rpeShown = isNum(set.rpe) ? set.rpe : null

  return (
    <div
      ref={rowRef}
      id={domId}
      className={`gym-set${set.done ? ' is-done' : ''}${isOpen ? ' is-open' : ''}${prs.length ? ' has-pr' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finishDrag(false)}
      onPointerCancel={() => finishDrag(true)}
      onClickCapture={onClickCapture}
    >
      <button
        type="button"
        className="gym-set-delete"
        tabIndex={isOpen ? 0 : -1}
        aria-hidden={!isOpen}
        onClick={() => actions.deleteSet(exRef, setRef)}
      >
        <Icon name="trash" size={18} />
        Delete
      </button>
      <div ref={slideRef} className={`gym-set-slide ${gridClass}`}>
        <button
          type="button"
          className="gym-set-num"
          onClick={() => actions.openSetType(exRef, setRef)}
          aria-label={`${setName}${prs.length ? `, personal record: ${prs.join(', ')}` : ''}. Change set type or delete`}
        >
          <SetTypeBadge type={type} number={info.number} />
          {prs.length > 0 && (
            <span className="gym-set-pr" aria-hidden="true">
              <Icon name="trophy" size={10} strokeWidth={2.6} />
            </span>
          )}
        </button>
        <button
          type="button"
          className="gym-prev"
          onClick={() => actions.copyPrevious(exRef, setRef, info.previous)}
          disabled={!previousText}
          aria-label={previousText ? `Previous: ${previousText}. Copy into ${setName.toLowerCase()}` : 'No previous set'}
        >
          <span className="gym-prev-text">{previousText || '—'}</span>
        </button>
        {cols.map((col, k) => cell(col, k === cols.length - 1))}
        {prefs.showRpe && (
          <label className={`gym-rpe${rpeShown !== null ? ' has-value' : ''}`} title={rpeShown !== null ? `RIR ${formatNumber(10 - rpeShown, 1)}` : 'Rate of perceived exertion'}>
            <span className="gym-rpe-value" aria-hidden="true">
              {rpeShown !== null ? formatNumber(rpeShown, 1) : isNum(info.targetRpe) ? formatNumber(info.targetRpe, 1) : '—'}
            </span>
            {rpeShown !== null && <span className="gym-rpe-rir" aria-hidden="true">RIR {formatNumber(10 - rpeShown, 1)}</span>}
            <select
              value={rpeShown !== null ? String(rpeShown) : ''}
              onChange={(event) => actions.setRpe(exRef, setRef, event.target.value === '' ? null : Number(event.target.value))}
              aria-label={`${setName} RPE`}
            >
              <option value="">No RPE</option>
              {RPE_VALUES.map((value) => (
                <option key={value} value={String(value)}>{`RPE ${formatNumber(value, 1)} · RIR ${formatNumber(10 - value, 1)}`}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className={`gym-check${set.done ? ' is-done' : ''}`}
          onClick={() => actions.toggleDone(exRef, setRef, placeholder)}
          aria-pressed={!!set.done}
          aria-label={set.done ? `${setName} done` : `Complete ${setName.toLowerCase()}`}
        >
          <Icon name="check" size={18} strokeWidth={3} />
        </button>
      </div>
    </div>
  )
}

// ---- small sheets --------------------------------------------------------------------------------

function RestEditSheet({ open, onClose, name, value, warmupRest, onSave }) {
  const [seconds, setSeconds] = useState(value)
  useEffect(() => {
    if (open) setSeconds(value)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (n) => Math.min(600, Math.max(0, n))
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Rest timer"
      description={name}
      size="sm"
      initialFocus={false}
      footer={(
        <>
          <button type="button" className="btn btn-secondary btn-grow" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-grow" onClick={() => onSave(seconds)}>Save</button>
        </>
      )}
    >
      <div className="gym-restedit">
        <button type="button" className="gym-round-btn" onClick={() => setSeconds((s) => clamp(s - 15))} disabled={seconds <= 0} aria-label="15 seconds less">
          <Icon name="minus" size={22} strokeWidth={2.4} />
        </button>
        <output className="gym-restedit-value" aria-live="polite">{seconds ? formatDuration(seconds) : 'Off'}</output>
        <button type="button" className="gym-round-btn" onClick={() => setSeconds((s) => clamp(s + 15))} disabled={seconds >= 600} aria-label="15 seconds more">
          <Icon name="plus" size={22} strokeWidth={2.4} />
        </button>
      </div>
      <div className="gym-preset-grid" role="group" aria-label="Presets">
        {REST_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`chip chip-sm${preset === seconds ? ' is-active' : ''}`}
            aria-pressed={preset === seconds}
            onClick={() => setSeconds(preset)}
          >
            {preset ? formatDuration(preset) : 'Off'}
          </button>
        ))}
      </div>
      <p className="gym-sheet-hint">
        Starts when you tick a set, and is kept for {name} next time. After a warm-up set it runs {formatDuration(warmupRest)} instead (Gym settings → Advanced).
      </p>
    </Sheet>
  )
}

function PinnedNoteSheet({ open, onClose, exercise, note }) {
  const [text, setText] = useState(note)
  useEffect(() => {
    if (open) setText(note)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const exerciseId = exercise?.exerciseId
  const save = () => {
    if (exerciseId) setExerciseMeta(exerciseId, { note: text.trim() || null })
    onClose()
  }
  const remove = () => {
    const previous = note
    if (exerciseId) setExerciseMeta(exerciseId, { note: null })
    onClose()
    toast('Pinned note removed', { action: { label: 'Undo', onClick: () => setExerciseMeta(exerciseId, { note: previous }) } })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pinned note"
      description={`Shown every time you do ${exercise?.name || 'this exercise'}: form cues, seat height, grip…`}
      size="sm"
      footer={(
        <>
          {note && <button type="button" className="btn btn-ghost gym-btn-danger" onClick={remove}>Remove</button>}
          <button type="button" className="btn btn-secondary btn-grow" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-grow" onClick={save}>Save</button>
        </>
      )}
    >
      <AutoTextarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="e.g. Elbows at 45°, pause at the bottom"
        aria-label="Pinned note"
        minRows={3}
        maxRows={8}
      />
    </Sheet>
  )
}

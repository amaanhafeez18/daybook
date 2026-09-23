import { useSyncExternalStore } from 'react'
import { getToken, readJson, tokenUserId, writeJson } from '../api.js'
import { isISODate, todayISO } from '../dates.js'
import { getState, getSyncedSettings, newId, retryUnsaved, subscribe, updateData, updateSettings, useStore } from '../store.js'
import * as sched from './schedule.js'

// Client glue for the gym: tolerant reads of settings.gym, actions that save through the shared
// store (schedule actions return an undo), and the in-progress workout, which lives in
// localStorage first and is synced to settings.gym.active for other devices.

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const validId = (id) => (typeof id === 'string' && id !== '') || isFiniteNumber(id)
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
const numOrNull = (value) => (isFiniteNumber(value) ? value : null)
const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)
const nowIso = () => new Date().toISOString()
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback)
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const inRange = (value, min, max, fallback, integer = false) =>
  isFiniteNumber(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : fallback

const replaceAt = (list, index, item) => list.map((current, i) => (i === index ? item : current))
const insertAt = (list, index, item) => [...list.slice(0, Math.max(0, index)), item, ...list.slice(Math.max(0, index))]

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

export const DEFAULT_PREFS = deepFreeze({
  unit: 'kg',
  distanceUnit: 'km',
  firstWeekday: 1, // 0 = Sun, 1 = Mon
  defaultRest: 120,
  warmupRest: 45,
  e1rmFormula: 'brzycki',
  useRir: false,
  previousSource: 'any',
  showRpe: false,
  timerSound: true,
  keepAwake: true,
  progression: true,
  weeklyGoal: 3,
  bodyweightInVolume: true,
  warmupScheme: [
    { pct: 0, reps: 10, bar: true },
    { pct: 0.5, reps: 5 },
    { pct: 0.7, reps: 3 },
    { pct: 0.85, reps: 2 },
    { pct: 0.92, reps: 1, minKg: 100 },
  ],
  plates: { kg: [25, 20, 15, 10, 5, 2.5, 1.25], lb: [45, 35, 25, 10, 5, 2.5], pairs: null },
  bars: { olympic: 20, womens: 15, ez: 10, trap: 25, smith: 15, landmine: 0 }, // kg
  collarKg: 0,
})

// Every value keeps at least 4.5:1 contrast with white text, in light and dark mode.
export const ROUTINE_COLORS = deepFreeze([
  { id: 'red', label: 'Red', value: '#D0433B' },
  { id: 'orange', label: 'Orange', value: '#BA5A18' },
  { id: 'amber', label: 'Amber', value: '#9A6D07' },
  { id: 'green', label: 'Green', value: '#2E8540' },
  { id: 'teal', label: 'Teal', value: '#12808A' },
  { id: 'blue', label: 'Blue', value: '#3368D6' },
  { id: 'indigo', label: 'Indigo', value: '#6450D6' },
  { id: 'pink', label: 'Pink', value: '#C23F7E' },
])
const COLOR_BY_ID = new Map(ROUTINE_COLORS.map((color) => [color.id, color.value]))
const FALLBACK_COLOR = '#8A8F98'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

const SET_TYPES = ['normal', 'warmup', 'drop', 'failure']
const E1RM_FORMULAS = ['brzycki', 'epley', 'lombardi', 'oconner', 'wathan']
const CATEGORY_REST = { compound: 120, isolation: 90, cardio: 0 }

// ---- normalising ---------------------------------------------------------------------------
// Read paths never throw on odd stored data. Each part is memoised by the identity of its raw
// value, and a normalised value maps to itself, so unchanged parts keep their identity when
// another part of settings.gym changes (and normalising twice is free).

function memoByRef(build) {
  const cache = new WeakMap()
  let missing
  return (value) => {
    if (!value || typeof value !== 'object') {
      if (missing === undefined) missing = build(undefined)
      return missing
    }
    let out = cache.get(value)
    if (out === undefined) {
      out = build(value)
      cache.set(value, out)
      if (out && typeof out === 'object') cache.set(out, out)
    }
    return out
  }
}

const normalizeScheduleSafe = memoByRef((raw) => {
  try {
    return sched.normalizeSchedule(raw)
  } catch {
    return sched.emptySchedule()
  }
})

function normalizeRoutineSet(set) {
  return {
    ...set,
    type: SET_TYPES.includes(set.type) ? set.type : 'normal',
    weightKg: numOrNull(set.weightKg),
    repsMin: numOrNull(set.repsMin),
    repsMax: numOrNull(set.repsMax),
    durationSec: numOrNull(set.durationSec),
    distanceM: numOrNull(set.distanceM),
    rpe: numOrNull(set.rpe),
  }
}

function normalizeRoutineRow(row, index, routineId) {
  return {
    ...row,
    id: validId(row.id) ? row.id : `${routineId}:${index}`,
    exerciseId: validId(row.exerciseId) ? row.exerciseId : '',
    name: str(row.name),
    tracking: str(row.tracking) || 'weight_reps',
    restSec: isFiniteNumber(row.restSec) && row.restSec >= 0 ? row.restSec : null,
    note: str(row.note),
    supersetId: validId(row.supersetId) ? row.supersetId : null,
    sets: Array.isArray(row.sets) ? row.sets.filter(isPlainObject).map(normalizeRoutineSet) : [],
  }
}

const normalizeRoutine = memoByRef((routine) => ({
  ...routine,
  name: str(routine.name),
  color: typeof routine.color === 'string' ? routine.color : null,
  notes: str(routine.notes),
  folderId: validId(routine.folderId) ? routine.folderId : null,
  exercises: Array.isArray(routine.exercises)
    ? routine.exercises.filter(isPlainObject).map((row, index) => normalizeRoutineRow(row, index, routine.id))
    : [],
}))

// Objects with a usable id, first of each id wins.
function uniqueById(raw, normalize) {
  if (!Array.isArray(raw)) return []
  const ids = new Set()
  const out = []
  for (const item of raw) {
    if (!isPlainObject(item) || !validId(item.id) || ids.has(item.id)) continue
    ids.add(item.id)
    out.push(normalize(item))
  }
  return out
}

const normalizeRoutines = memoByRef((raw) => uniqueById(raw, normalizeRoutine))
const normalizeFolders = memoByRef((raw) => uniqueById(raw, (folder) => ({ ...folder, name: str(folder.name) })))

const normalizeCustomExercises = memoByRef((raw) => uniqueById(raw, (exercise) => {
  const category = oneOf(exercise.category, Object.keys(CATEGORY_REST), 'compound')
  return {
    ...exercise,
    name: str(exercise.name).trim() || 'Custom exercise',
    primary: str(exercise.primary) || 'full_body',
    secondary: Array.isArray(exercise.secondary) ? exercise.secondary.filter((muscle) => typeof muscle === 'string') : [],
    equipment: str(exercise.equipment) || 'machine',
    category,
    tracking: str(exercise.tracking) || 'weight_reps',
    rest: isFiniteNumber(exercise.rest) && exercise.rest >= 0 ? exercise.rest : CATEGORY_REST[category],
    custom: true,
    hidden: exercise.hidden === true,
    bwVolume: exercise.bwVolume === true,
  }
}))

const normalizeMeta = memoByRef((raw) => {
  const out = {}
  if (isPlainObject(raw)) for (const [id, meta] of Object.entries(raw)) if (isPlainObject(meta)) out[id] = meta
  return out
})

function plateList(value, fallback) {
  const sizes = Array.isArray(value) ? [...new Set(value.filter((size) => isFiniteNumber(size) && size > 0 && size <= 100))] : []
  return sizes.length ? sizes.sort((a, b) => b - a) : [...fallback]
}

function platePairs(value) {
  if (!isPlainObject(value)) return null
  const entries = Object.entries(value).filter(([, pairs]) => Number.isInteger(pairs) && pairs >= 0)
  return entries.length ? Object.fromEntries(entries) : null
}

function warmupScheme(value) {
  if (!Array.isArray(value)) return DEFAULT_PREFS.warmupScheme.map((row) => ({ ...row }))
  return value.filter((row) => isPlainObject(row) && isFiniteNumber(row.pct) && row.pct >= 0 && row.pct <= 1.5 && Number.isInteger(row.reps) && row.reps >= 1)
}

const normalizePrefs = memoByRef((raw) => {
  const p = isPlainObject(raw) ? raw : {}
  const d = DEFAULT_PREFS
  const plates = isPlainObject(p.plates) ? p.plates : {}
  const bars = { ...d.bars }
  if (isPlainObject(p.bars)) {
    for (const [id, kg] of Object.entries(p.bars)) if (isFiniteNumber(kg) && kg >= 0 && kg <= 100) bars[id] = kg
  }
  return {
    ...p,
    unit: oneOf(p.unit, ['kg', 'lb'], d.unit),
    distanceUnit: oneOf(p.distanceUnit, ['km', 'mi'], d.distanceUnit),
    firstWeekday: inRange(p.firstWeekday, 0, 6, d.firstWeekday, true),
    defaultRest: inRange(p.defaultRest, 0, 600, d.defaultRest),
    warmupRest: inRange(p.warmupRest, 0, 600, d.warmupRest),
    e1rmFormula: oneOf(p.e1rmFormula, E1RM_FORMULAS, d.e1rmFormula),
    useRir: bool(p.useRir, d.useRir),
    previousSource: oneOf(p.previousSource, ['any', 'routine'], d.previousSource),
    showRpe: bool(p.showRpe, d.showRpe),
    timerSound: bool(p.timerSound, d.timerSound),
    keepAwake: bool(p.keepAwake, d.keepAwake),
    progression: bool(p.progression, d.progression),
    weeklyGoal: inRange(p.weeklyGoal, 1, 14, d.weeklyGoal, true),
    bodyweightInVolume: bool(p.bodyweightInVolume, d.bodyweightInVolume),
    warmupScheme: warmupScheme(p.warmupScheme),
    plates: { ...plates, kg: plateList(plates.kg, d.plates.kg), lb: plateList(plates.lb, d.plates.lb), pairs: platePairs(plates.pairs) },
    bars,
    collarKg: inRange(p.collarKg, 0, 25, d.collarKg),
  }
})

// Exercise rows with set arrays; the same array back when it is already well-formed.
function cleanRows(rows) {
  if (!Array.isArray(rows)) return []
  const rowOk = (row) => isPlainObject(row) && Array.isArray(row.sets) && row.sets.every(isPlainObject)
  if (rows.every(rowOk)) return rows
  return rows.filter(isPlainObject).map((row) => (rowOk(row) ? row : { ...row, sets: Array.isArray(row.sets) ? row.sets.filter(isPlainObject) : [] }))
}

const normalizeActive = memoByRef((raw) => {
  if (!isPlainObject(raw) || !validId(raw.id)) return null
  const exercises = cleanRows(raw.exercises)
  return exercises === raw.exercises ? raw : { ...raw, exercises }
})

function buildGym(raw) {
  return {
    ...raw,
    schedule: normalizeScheduleSafe(raw.schedule),
    routines: normalizeRoutines(raw.routines),
    folders: normalizeFolders(raw.folders),
    exercises: normalizeCustomExercises(raw.exercises),
    exerciseMeta: normalizeMeta(raw.exerciseMeta),
    prefs: normalizePrefs(raw.prefs),
    active: normalizeActive(raw.active),
  }
}

const gymCache = new WeakMap()
let emptyGym = null

export function normalizeGym(raw) {
  if (!isPlainObject(raw)) {
    if (!emptyGym) {
      emptyGym = buildGym({})
      gymCache.set(emptyGym, emptyGym)
    }
    return emptyGym
  }
  let gym = gymCache.get(raw)
  if (!gym) {
    gym = buildGym(raw)
    gymCache.set(raw, gym)
    gymCache.set(gym, gym)
  }
  return gym
}

const rawGym = () => {
  const gym = getState().data.settings?.gym
  return isPlainObject(gym) ? gym : {}
}
const selectGym = (state) => normalizeGym(state.data.settings?.gym)

export function useGym() {
  return useStore(selectGym)
}

export function getGym() {
  return selectGym(getState())
}

const LOADING = 'Still loading your plan — try again in a moment.'

// Until the user's data has loaded, settings.gym here is an empty stand-in; writing it would
// replace the saved plan on the server.
function requireLoaded() {
  if (!getState().hydrated) throw new Error(LOADING)
}

// patchOrFn: a partial of settings.gym, or (normalisedGym) => partial. Only the direct children
// it returns are replaced, so the store sends just those. Does nothing until the data has loaded.
export function updateGym(patchOrFn) {
  if (!getState().hydrated) return
  const raw = rawGym()
  const patch = typeof patchOrFn === 'function' ? patchOrFn(normalizeGym(getState().data.settings?.gym)) : patchOrFn
  if (!isPlainObject(patch) || !Object.keys(patch).some((key) => patch[key] !== raw[key])) return
  updateSettings({ gym: { ...raw, ...patch } })
}

// ---- lists ---------------------------------------------------------------------------------

const sessionTime = (session) => str(session.startedAt) || str(session.createdAt)

const sortSessions = memoByRef((raw) => {
  const list = uniqueById(raw, (session) => {
    const exercises = cleanRows(session.exercises)
    return exercises === session.exercises ? session : { ...session, exercises }
  }).filter((session) => typeof session.date === 'string')
  return list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : sessionTime(b).localeCompare(sessionTime(a))))
})

const sortBodyWeights = memoByRef((raw) => {
  const list = uniqueById(raw, (entry) => (typeof entry.kg === 'string' ? { ...entry, kg: Number(entry.kg) } : entry))
    .filter((entry) => typeof entry.date === 'string' && isFiniteNumber(entry.kg) && entry.kg > 0)
  return list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : str(b.createdAt).localeCompare(str(a.createdAt))))
})

const selectSessions = (state) => sortSessions(state.data.gymSessions)
const selectBodyWeights = (state) => sortBodyWeights(state.data.bodyWeights)

export function useGymSessions() {
  return useStore(selectSessions)
}

export function useBodyWeights() {
  return useStore(selectBodyWeights)
}

function hasSessionOn(date) {
  const list = getState().data.gymSessions
  return Array.isArray(list) && list.some((session) => isPlainObject(session) && session.date === date)
}

// ---- today -----------------------------------------------------------------------------------
// One shared clock: listeners hear about local midnight (+1 s) and about the app coming back
// (timers don't run while iOS has it suspended). The snapshot is the date string itself.

const todayListeners = new Set()
let midnightTimer = null

function notifyToday() {
  for (const listener of todayListeners) listener()
}

function armMidnight() {
  clearTimeout(midnightTimer)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
  midnightTimer = setTimeout(() => {
    notifyToday()
    armMidnight()
  }, Math.max(1000, next - now))
}

function onTodayWake() {
  if (document.visibilityState === 'hidden') return
  notifyToday()
  armMidnight()
}

function subscribeToday(listener) {
  todayListeners.add(listener)
  if (todayListeners.size === 1) {
    armMidnight()
    document.addEventListener('visibilitychange', onTodayWake)
    window.addEventListener('focus', onTodayWake)
  }
  return () => {
    todayListeners.delete(listener)
    if (todayListeners.size) return
    clearTimeout(midnightTimer)
    midnightTimer = null
    document.removeEventListener('visibilitychange', onTodayWake)
    window.removeEventListener('focus', onTodayWake)
  }
}

export function useToday() {
  return useSyncExternalStore(subscribeToday, todayISO)
}

// ---- lookups ---------------------------------------------------------------------------------

export function newGymId() {
  return newId()
}

export function routineById(gym, id) {
  if (!validId(id)) return null
  return normalizeGym(gym).routines.find((routine) => routine.id === id) || null
}

// Accepts a routine (or a colour id / hex); grey when it has no known colour.
export function routineColor(routine) {
  const color = typeof routine === 'string' ? routine : routine?.color
  if (COLOR_BY_ID.has(color)) return COLOR_BY_ID.get(color)
  return typeof color === 'string' && HEX_COLOR.test(color) ? color : FALLBACK_COLOR
}

export function slotLabel(slot, gym) {
  if (!isPlainObject(slot)) return 'No plan'
  if (slot.kind === 'rest') return 'Rest'
  if (slot.kind === 'shifted') return 'Shifted'
  if (slot.kind !== 'routine') return 'No plan'
  const routine = routineById(gym, slot.routineId)
  return routine ? routine.name.trim() || 'Untitled routine' : 'Deleted routine'
}

export function hasPlan(gym) {
  const { schedule, routines } = normalizeGym(gym)
  return (schedule.versions?.length || 0) > 0 || routines.length > 0
}

// ---- schedule actions ------------------------------------------------------------------------

// An undo that reverts exactly the entries an action changed (versions by id, skips and
// overrides by date, shift dates, the deload block), so edits made since to anything else survive.
function scheduleRevert(before, after) {
  const byId = (versions) => Object.fromEntries((versions || []).map((version) => [version.id, version]))
  const changed = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !sameJson(a[key], b[key]))
    .map((key) => [key, a[key]])
  const restore = (current = {}, entries) => {
    const out = { ...current }
    for (const [key, value] of entries) {
      if (value === undefined) delete out[key]
      else out[key] = value
    }
    return out
  }
  const beforeShifts = before.shifts || []
  const afterShifts = after.shifts || []
  const versions = changed(byId(before.versions), byId(after.versions))
  const skips = changed(before.skips, after.skips)
  const overrides = changed(before.overrides, after.overrides)
  const shiftsAdded = afterShifts.filter((date) => !beforeShifts.includes(date))
  const shiftsRemoved = beforeShifts.filter((date) => !afterShifts.includes(date))
  const deload = sameJson(before.deload, after.deload) ? null : before.deload
  if (!versions.length && !skips.length && !overrides.length && !shiftsAdded.length && !shiftsRemoved.length && !deload) return null
  return (current) => {
    const shifts = (current.shifts || []).filter((date) => !shiftsAdded.includes(date))
    return sched.normalizeSchedule({
      ...current,
      versions: Object.values(restore(byId(current.versions), versions)),
      skips: restore(current.skips, skips),
      overrides: restore(current.overrides, overrides),
      shifts: [...shifts, ...shiftsRemoved.filter((date) => !shifts.includes(date))],
      deload: deload || current.deload,
    })
  }
}

// Runs change(schedule, today); saves the result and returns its undo (null if change returned null).
function applySchedule(change) {
  const before = getGym().schedule
  const after = change(before, todayISO())
  if (!after) return null
  const revert = scheduleRevert(before, after)
  if (revert) updateGym({ schedule: after })
  return () => {
    if (revert) updateGym((gym) => ({ schedule: revert(gym.schedule) }))
  }
}

function shownSlot(date, today) {
  return sched.resolveDay(getGym(), sortSessions(getState().data.gymSessions), date, today).shown
}

export function skipDay(date) {
  return applySchedule((schedule, today) => sched.skipDay(schedule, date, today, hasSessionOn(date)))
}

export function shiftDay(date) {
  return applySchedule((schedule, today) => sched.shiftDay(schedule, date, today, hasSessionOn(date)))
}

export function overrideDay(date, slot) {
  return applySchedule((schedule, today) => sched.overrideDay(schedule, date, slot, today))
}

export function clearDay(date) {
  return applySchedule((schedule, today) => sched.clearDay(schedule, date, today))
}

export function moveWorkout(from, to) {
  // A logged day shows its session, so a workout moved onto it would silently drop out of the plan.
  if (hasSessionOn(from) || hasSessionOn(to)) throw new Error('That day already has a workout logged.')
  return applySchedule((schedule, today) => sched.moveWorkout(schedule, from, to, today, shownSlot(from, today)))
}

export function saveSchedule({ mode, cycle, weekly, anchorIndex } = {}) {
  return applySchedule((schedule, today) => sched.editSchedule(schedule, { mode, cycle, weekly, anchorIndex }, today, hasSessionOn(today)))
}

export function realignTo(routineId) {
  return applySchedule((schedule, today) => sched.realign(schedule, routineId, today))
}

// { routines, schedule } from buildTemplate: appends the routines and uses the template's plan.
// With no plan yet the template schedule is taken as is; otherwise its plan is added
// copy-on-write from today, so days already past keep resolving as they did.
export function applyTemplate(templateResult) {
  requireLoaded()
  if (!isPlainObject(templateResult)) throw new Error('Template is missing.')
  const incoming = Array.isArray(templateResult.routines) ? templateResult.routines.filter((routine) => isPlainObject(routine) && validId(routine.id)) : []
  const now = nowIso()
  const today = todayISO()
  updateGym((gym) => {
    const existing = new Set(gym.routines.map((routine) => routine.id))
    const added = incoming.filter((routine) => !existing.has(routine.id)).map((routine) => ({ ...routine, createdAt: routine.createdAt || now, updatedAt: routine.updatedAt || now }))
    const patch = added.length ? { routines: [...gym.routines, ...added] } : {}
    if (!isPlainObject(templateResult.schedule)) return patch
    const plan = sched.normalizeSchedule(templateResult.schedule)
    if (!gym.schedule.versions.length) return { ...patch, schedule: plan }
    const version = plan.versions[plan.versions.length - 1]
    if (!version) return patch
    try {
      const { mode, cycle, weekly, anchorIndex } = version
      return { ...patch, schedule: sched.editSchedule(gym.schedule, { mode, cycle, weekly, anchorIndex }, today, hasSessionOn(today)) }
    } catch {
      return patch // e.g. the Custom template's empty cycle: keep the current plan
    }
  })
}

// ---- routines --------------------------------------------------------------------------------

function nextColor(routines) {
  const used = new Set(routines.map((routine) => routine.color))
  return (ROUTINE_COLORS.find((color) => !used.has(color.id)) || ROUTINE_COLORS[routines.length % ROUTINE_COLORS.length]).id
}

const knownColor = (color) => COLOR_BY_ID.has(color) || (typeof color === 'string' && HEX_COLOR.test(color))

// Create or replace by id; returns the saved routine.
export function saveRoutine(routine) {
  requireLoaded() // callers use the returned routine, which updateGym wouldn't produce yet
  if (!isPlainObject(routine)) throw new Error('Routine is missing.')
  const now = nowIso()
  let saved = null
  updateGym((gym) => {
    const index = validId(routine.id) ? gym.routines.findIndex((item) => item.id === routine.id) : -1
    const previous = index >= 0 ? gym.routines[index] : null
    saved = {
      notes: '',
      folderId: null,
      exercises: [],
      ...routine,
      id: validId(routine.id) ? routine.id : newGymId(),
      color: knownColor(routine.color) ? routine.color : previous?.color || nextColor(gym.routines),
      createdAt: previous?.createdAt || routine.createdAt || now,
      updatedAt: now,
    }
    return { routines: index >= 0 ? replaceAt(gym.routines, index, saved) : [...gym.routines, saved] }
  })
  return saved
}

// replaceWithRest: its slots in the current and future schedule become Rest (copy-on-write).
export function deleteRoutine(id, { replaceWithRest = false } = {}) {
  const gym = getGym()
  const index = gym.routines.findIndex((routine) => routine.id === id)
  const routine = gym.routines[index]
  const today = todayISO()
  const schedule = replaceWithRest ? sched.replaceRoutineWithRest(gym.schedule, id, today, hasSessionOn(today)) || gym.schedule : gym.schedule
  const revert = scheduleRevert(gym.schedule, schedule)
  if (!routine && !revert) return () => {}
  updateGym({
    ...(routine ? { routines: gym.routines.filter((item) => item.id !== id) } : {}),
    ...(revert ? { schedule } : {}),
  })
  return () => updateGym((current) => ({
    ...(routine && !current.routines.some((item) => item.id === id) ? { routines: insertAt(current.routines, index, routine) } : {}),
    ...(revert ? { schedule: revert(current.schedule) } : {}),
  }))
}

// New ids for the routine, each exercise row and each superset group; returns the copy.
export function duplicateRoutine(id) {
  const source = routineById(getGym(), id)
  if (!source) return null
  const now = nowIso()
  const groups = new Map()
  const groupId = (old) => {
    if (!groups.has(old)) groups.set(old, newGymId())
    return groups.get(old)
  }
  const copy = {
    ...source,
    id: newGymId(),
    name: `${source.name.trim() || 'Routine'} (copy)`,
    exercises: source.exercises.map((row) => ({
      ...row,
      id: newGymId(),
      supersetId: row.supersetId == null ? null : groupId(row.supersetId),
      sets: row.sets.map((set) => ({ ...set })),
    })),
    createdAt: now,
    updatedAt: now,
  }
  updateGym((gym) => {
    const index = gym.routines.findIndex((routine) => routine.id === id)
    return { routines: index >= 0 ? insertAt(gym.routines, index + 1, copy) : [...gym.routines, copy] }
  })
  return copy
}

// Routines in the order of ids; any not listed keep their order after them.
export function reorderRoutines(ids) {
  const order = Array.isArray(ids) ? ids : []
  updateGym((gym) => {
    const byId = new Map(gym.routines.map((routine) => [routine.id, routine]))
    const listed = [...new Set(order)].filter((id) => byId.has(id)).map((id) => byId.get(id))
    const rest = gym.routines.filter((routine) => !listed.includes(routine))
    const routines = [...listed, ...rest]
    return routines.every((routine, i) => routine === gym.routines[i]) ? null : { routines }
  })
}

export function saveFolder(folder) {
  const input = isPlainObject(folder) ? folder : {}
  const saved = { ...input, id: validId(input.id) ? input.id : newGymId(), name: str(input.name).trim() || 'Folder' }
  updateGym((gym) => {
    const index = gym.folders.findIndex((item) => item.id === saved.id)
    return { folders: index >= 0 ? replaceAt(gym.folders, index, saved) : [...gym.folders, saved] }
  })
  return saved
}

// Its routines move out of the folder. Returns an undo.
export function deleteFolder(id) {
  const gym = getGym()
  const index = gym.folders.findIndex((folder) => folder.id === id)
  const folder = gym.folders[index]
  const members = gym.routines.filter((routine) => routine.folderId === id).map((routine) => routine.id)
  if (!folder && !members.length) return () => {}
  updateGym((current) => ({
    folders: current.folders.filter((item) => item.id !== id),
    ...(members.length ? { routines: current.routines.map((routine) => (routine.folderId === id ? { ...routine, folderId: null } : routine)) } : {}),
  }))
  return () => updateGym((current) => ({
    ...(folder && !current.folders.some((item) => item.id === id) ? { folders: insertAt(current.folders, index, folder) } : {}),
    ...(members.length
      ? { routines: current.routines.map((routine) => (members.includes(routine.id) && routine.folderId === null ? { ...routine, folderId: id } : routine)) }
      : {}),
  }))
}

// ---- custom exercises ------------------------------------------------------------------------

// Create or replace by id; returns the saved exercise.
export function saveCustomExercise(exercise) {
  requireLoaded() // callers use the returned exercise, which updateGym wouldn't produce yet
  if (!isPlainObject(exercise)) throw new Error('Exercise is missing.')
  let saved = null
  updateGym((gym) => {
    const index = validId(exercise.id) ? gym.exercises.findIndex((item) => item.id === exercise.id) : -1
    const previous = index >= 0 ? gym.exercises[index] : null
    saved = {
      secondary: [],
      hidden: false,
      bwVolume: false,
      ...previous,
      ...exercise,
      id: validId(exercise.id) ? exercise.id : `custom-${newGymId()}`,
      custom: true,
      createdAt: previous?.createdAt || exercise.createdAt || nowIso(),
    }
    return { exercises: index >= 0 ? replaceAt(gym.exercises, index, saved) : [...gym.exercises, saved] }
  })
  return saved
}

function exerciseInUse(id) {
  const gym = getGym()
  const inRows = (rows) => Array.isArray(rows) && rows.some((row) => row?.exerciseId === id)
  return sortSessions(getState().data.gymSessions).some((session) => inRows(session.exercises))
    || gym.routines.some((routine) => inRows(routine.exercises))
    || inRows(getActiveWorkout()?.exercises)
}

// Used in sessions → hidden (history keeps it); unused → removed with its meta. Returns an undo.
export function deleteCustomExercise(id, { usedInSessions } = {}) {
  const gym = getGym()
  const index = gym.exercises.findIndex((exercise) => exercise.id === id)
  if (index < 0) return () => {}
  const previous = gym.exercises[index]
  const meta = gym.exerciseMeta[id]
  const used = typeof usedInSessions === 'boolean' ? usedInSessions : exerciseInUse(id)
  if (used) {
    updateGym((current) => ({ exercises: current.exercises.map((exercise) => (exercise.id === id ? { ...exercise, hidden: true } : exercise)) }))
  } else {
    updateGym((current) => {
      const exerciseMeta = { ...current.exerciseMeta }
      delete exerciseMeta[id]
      return { exercises: current.exercises.filter((exercise) => exercise.id !== id), ...(meta ? { exerciseMeta } : {}) }
    })
  }
  return () => updateGym((current) => {
    const at = current.exercises.findIndex((exercise) => exercise.id === id)
    return {
      exercises: at >= 0 ? replaceAt(current.exercises, at, previous) : insertAt(current.exercises, index, previous),
      ...(meta && !current.exerciseMeta[id] ? { exerciseMeta: { ...current.exerciseMeta, [id]: meta } } : {}),
    }
  })
}

// Merges patch into the exercise's meta; null, undefined or '' removes a field.
export function setExerciseMeta(exerciseId, patch) {
  if (!validId(exerciseId) || !isPlainObject(patch)) return
  updateGym((gym) => {
    const next = { ...gym.exerciseMeta[exerciseId] }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') delete next[field]
      else next[field] = value
    }
    const exerciseMeta = { ...gym.exerciseMeta }
    if (Object.keys(next).length) exerciseMeta[exerciseId] = next
    else delete exerciseMeta[exerciseId]
    return sameJson(exerciseMeta, gym.exerciseMeta) ? null : { exerciseMeta }
  })
}

// ---- sessions --------------------------------------------------------------------------------

// Upsert by id (new sessions go first); returns the saved session.
export function saveSession(session) {
  if (!isPlainObject(session)) throw new Error('Workout is missing.')
  if (!isISODate(session.date)) throw new Error('A workout needs a valid date.')
  const saved = {
    ...session,
    id: validId(session.id) ? session.id : newGymId(),
    exercises: Array.isArray(session.exercises) ? session.exercises : [],
    createdAt: session.createdAt || nowIso(),
  }
  updateData('gymSessions', (list) => {
    const current = Array.isArray(list) ? list : []
    const index = current.findIndex((item) => item?.id === saved.id)
    return index < 0 ? [saved, ...current] : replaceAt(current, index, saved)
  })
  return saved
}

// Returns an undo that puts the same object back (if it isn't there again already).
function removeFromList(key, id) {
  const list = getState().data[key]
  const index = Array.isArray(list) ? list.findIndex((item) => item?.id === id) : -1
  if (index < 0) return () => {}
  const item = list[index]
  updateData(key, (current) => (Array.isArray(current) ? current.filter((entry) => entry?.id !== id) : current))
  return () => updateData(key, (current) => {
    const items = Array.isArray(current) ? current : []
    return items.some((entry) => entry?.id === id) ? current : insertAt(items, index, item)
  })
}

export function deleteSession(id) {
  return removeFromList('gymSessions', id)
}

// "I trained": a session with no exercises, which still counts as done.
export function quickLog(date, routineId) {
  if (!isISODate(date)) throw new Error('Choose a valid date.')
  const routine = routineById(getGym(), routineId)
  return saveSession({
    id: newGymId(),
    date,
    name: routine?.name.trim() || 'Workout',
    routineId: validId(routineId) ? routineId : null,
    startedAt: null,
    endedAt: null,
    durationSec: null,
    exercises: [],
    note: '',
    planned: null,
    bodyweightKg: latestBodyWeight(getState().data.bodyWeights, date),
    isDeload: false,
    createdAt: nowIso(),
  })
}

// ---- body weight -----------------------------------------------------------------------------

// One entry per day: logging again on the same date replaces that day's weight.
export function addBodyWeight(date, kg) {
  if (!isISODate(date)) throw new Error('Choose a valid date.')
  if (!isFiniteNumber(kg) || kg <= 0 || kg > 700) throw new Error('Enter a valid body weight.')
  let saved = null
  updateData('bodyWeights', (list) => {
    const current = Array.isArray(list) ? list : []
    const index = current.findIndex((entry) => isPlainObject(entry) && entry.date === date)
    if (index >= 0) {
      saved = { ...current[index], kg }
      return replaceAt(current, index, saved)
    }
    saved = { id: newGymId(), date, kg, createdAt: nowIso() }
    return [saved, ...current]
  })
  return saved
}

export function deleteBodyWeight(id) {
  return removeFromList('bodyWeights', id)
}

// kg of the latest entry on or before the date (any date when omitted), else null.
export function latestBodyWeight(bodyWeights, onOrBefore) {
  let best = null
  for (const entry of Array.isArray(bodyWeights) ? bodyWeights : []) {
    if (!isPlainObject(entry) || typeof entry.date !== 'string') continue
    const kg = Number(entry.kg)
    if (!Number.isFinite(kg) || kg <= 0 || (onOrBefore && entry.date > onOrBefore)) continue
    if (!best || entry.date > best.date || (entry.date === best.date && str(entry.createdAt) > str(best.createdAt))) best = { ...entry, kg }
  }
  return best ? best.kg : null
}

// ---- active workout --------------------------------------------------------------------------
// localStorage holds this device's copy (written on every change); settings.gym.active is a copy
// for other devices, sent 3 s after the last change or at once when the app is hidden. The copy
// with the newer updatedAt wins. After a finish or discard here, copies stamped at or before that
// moment are stale (e.g. a late push from another device) and are ignored and cleared. The id of
// the workout finished or discarded last is synced too (settings.gym.closedId), so a copy of it
// that a device with an old view pushes back later is ignored and cleared on every device.

const ACTIVE_KEY = 'daybook.gym.active'
const CLEARED_KEY = 'daybook.gym.activeClearedAt'
const OWNER_KEY = 'daybook.gym.activeOwner' // account the stored copy belongs to
const SEEN_KEY = 'daybook.gym.activeSeen' // stamp of the stored copy when the server last held it
const SYNC_DELAY_MS = 3000

let local = null // this device's copy
let clearedAt = 0 // ms
let seenOnServer = 0 // ms, see SEEN_KEY
let loadedFor // account id the local copy was read for (undefined: not read yet)
let lastToken = null
let lastUserId = null
let syncTimer = null
let clearQueued = false
let snapshot = { local: undefined, server: undefined, clearedAt: undefined, closedId: undefined, value: null }
const activeListeners = new Set()

const stampOf = (workout) => {
  const ms = Date.parse(workout?.updatedAt)
  return Number.isFinite(ms) ? ms : 0
}
const isStale = (workout) => clearedAt > 0 && stampOf(workout) <= clearedAt
const closedId = () => rawGym().closedId
const isClosed = (workout) => !!workout && validId(workout.id) && workout.id === closedId()
// A copy that still counts: not finished or discarded here or on another device.
const live = (workout) => (workout && !isStale(workout) && !isClosed(workout) ? workout : null)
const nextStamp = (previous) => new Date(Math.max(Date.now(), stampOf(previous) + 1, clearedAt + 1)).toISOString()

function currentUserId() {
  const token = getToken()
  if (token !== lastToken) {
    lastToken = token
    lastUserId = token ? tokenUserId(token) : null
  }
  return lastUserId
}

// Another account signed in on this device must not see (or inherit) the stored copy.
function loadLocal() {
  const userId = currentUserId()
  if (userId === loadedFor) return
  loadedFor = userId
  const mine = userId != null && readJson(OWNER_KEY) === userId
  local = mine ? normalizeActive(readJson(ACTIVE_KEY)) : null
  const cleared = mine ? Date.parse(readJson(CLEARED_KEY)) : NaN
  clearedAt = Number.isFinite(cleared) ? cleared : 0
  const seen = mine ? readJson(SEEN_KEY) : 0
  seenOnServer = isFiniteNumber(seen) ? seen : 0
}

function markSeen(ms) {
  if (ms === seenOnServer) return
  seenOnServer = ms
  writeJson(SEEN_KEY, ms)
}

// Only a copy the server confirmed (after a save or a load) counts as seen. The store's copy is
// optimistic: a save that never arrives (e.g. rejected with an expired session) must not later
// read as "finished on another device" and delete the workout.
function noteSeen() {
  const confirmed = getSyncedSettings()?.gym?.active
  if (local && isPlainObject(confirmed) && confirmed.id === local.id && stampOf(confirmed) === stampOf(local)) markSeen(stampOf(local))
}

function notifyActive() {
  for (const listener of activeListeners) listener()
}

// False when the copy couldn't be stored (storage full): the older stored copy stays.
function setLocal(workout) {
  loadLocal()
  local = workout
  const userId = currentUserId()
  if (userId != null) writeJson(OWNER_KEY, userId)
  let stored = true
  if (workout) {
    stored = writeJson(ACTIVE_KEY, workout)
  } else {
    try {
      localStorage.removeItem(ACTIVE_KEY)
    } catch {
      // storage unavailable
    }
  }
  notifyActive()
  return stored
}

function setClearedAt(ms) {
  clearedAt = Math.max(clearedAt, ms)
  writeJson(CLEARED_KEY, new Date(clearedAt).toISOString())
}

const serverCopy = () => getGym().active

// A finished or stale copy on the server is replaced whatever its stamp.
function pushActive() {
  if (local && !isClosed(local) && stampOf(local) > stampOf(live(serverCopy()))) updateGym({ active: local })
}

function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    pushActive()
  }, SYNC_DELAY_MS)
}

function cancelSync() {
  clearTimeout(syncTimer)
  syncTimer = null
}

function pickActive(mine, server) {
  const own = mine && !isClosed(mine) ? mine : null
  const remote = live(server)
  if (own && remote) return stampOf(remote) > stampOf(own) ? remote : own
  return own || remote
}

// Runs on every store change: keeps the local copy and the settings copy in step. Waits for real
// data: before it loads, the empty settings would read as "finished on another device".
function reconcile() {
  loadLocal()
  noteSeen()
  if (!getState().hydrated) return
  const server = serverCopy()
  const remote = live(server)
  if (isClosed(local)) {
    // Finished or discarded on another device (its closedId arrived). clearedAt stays: that
    // device may have started a new workout since, stamped by its own clock.
    cancelSync()
    setLocal(null)
  } else if (local && !server && closedId() == null && seenOnServer && seenOnServer === stampOf(local)) {
    // The server dropped the copy this device synced, with no closedId (an older app version
    // finished it). With a closedId for another workout, the copy was more likely overwritten
    // by a device with an old view and then cleared, so it is kept and sent again below.
    cancelSync()
    setClearedAt(stampOf(local))
    setLocal(null)
  }
  if (remote && stampOf(remote) > stampOf(local)) {
    // Newer elsewhere (another device, or this device's storage was cleared): keep it locally.
    setLocal(remote)
    noteSeen()
  } else if (local && stampOf(local) > stampOf(remote)) {
    // Not on the server yet, e.g. the app closed before the delayed sync.
    if (!syncTimer) scheduleSync()
  }
  if (!local && server && !remote && !clearQueued) {
    // A finished or stale copy is still on the server: clear it.
    clearQueued = true
    setTimeout(() => {
      clearQueued = false
      const current = serverCopy()
      if (!local && current && !live(current)) updateGym({ active: null })
    }, 0)
  }
}

export function getActiveWorkout() {
  loadLocal()
  const server = serverCopy()
  const closed = closedId()
  if (snapshot.local !== local || snapshot.server !== server || snapshot.clearedAt !== clearedAt || snapshot.closedId !== closed) {
    snapshot = { local, server, clearedAt, closedId: closed, value: pickActive(local, server) }
  }
  return snapshot.value
}

function subscribeActive(listener) {
  activeListeners.add(listener)
  const unsubscribe = subscribe(listener)
  return () => {
    activeListeners.delete(listener)
    unsubscribe()
  }
}

export function useActiveWorkout() {
  return useSyncExternalStore(subscribeActive, getActiveWorkout)
}

// workout: a fully built ActiveWorkout. Throws if one is already in progress.
export function startWorkout(workout) {
  if (getActiveWorkout()) throw new Error('A workout is already in progress.')
  if (!isPlainObject(workout)) throw new Error('Workout is missing.')
  const active = normalizeActive({
    rest: null,
    editingSessionId: null,
    ...workout,
    id: validId(workout.id) && workout.id !== closedId() ? workout.id : newGymId(),
    status: 'active',
    updatedAt: nextStamp(null),
  })
  cancelSync()
  setLocal(active)
  updateGym({ active })
  return active
}

// fn(active) → next active (returning the same object or nothing changes nothing).
export function updateActive(fn) {
  const current = getActiveWorkout()
  if (!current) return null
  const next = typeof fn === 'function' ? fn(current) : fn
  if (!isPlainObject(next) || next === current) return current
  const stamped = normalizeActive({ ...next, status: 'active', updatedAt: nextStamp(current) })
  if (setLocal(stamped)) {
    scheduleSync()
  } else {
    // This device couldn't store it (storage full), so the synced copy is the only one that lasts.
    cancelSync()
    pushActive()
  }
  return stamped
}

export function discardActive() {
  const current = getActiveWorkout()
  const id = (current || local)?.id
  cancelSync()
  setClearedAt(Math.max(Date.now(), stampOf(current), stampOf(local), stampOf(serverCopy())))
  setLocal(null)
  // Also when the server copy is already gone: a device still showing this workout may push it back.
  updateGym({ active: null, ...(validId(id) ? { closedId: id } : {}) })
}

// session: the cleaned Session to save. Saves it, then clears the workout; returns the saved session.
export function finishActive(session) {
  const saved = saveSession(session)
  discardActive()
  return saved
}

// Sends the current copy now (and any other unsaved changes), e.g. before iOS suspends the app.
export function flushActive() {
  cancelSync()
  loadLocal()
  pushActive()
  retryUnsaved()
}

if (typeof window !== 'undefined') {
  const flushIfPending = () => {
    if (syncTimer) flushActive()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushIfPending()
  })
  window.addEventListener('pagehide', flushIfPending)
  // Another tab changed the stored copy.
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ACTIVE_KEY && event.key !== CLEARED_KEY && event.key !== OWNER_KEY && event.key !== SEEN_KEY) return
    loadedFor = undefined
    loadLocal()
    notifyActive()
  })
  subscribe(reconcile)
  setTimeout(reconcile, 0)
}

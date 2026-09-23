// Gym schedule engine: which routine (or rest) falls on each day.
// Pure and dependency-free so the client (local time) and the API (UTC) share it. Dates are
// 'YYYY-MM-DD' strings, handled internally as UTC day numbers, so answers never depend on the
// machine's time zone. Read paths never throw on malformed stored data; mutations return a new
// schedule and throw Error(<message for the user>) when a change isn't allowed.

export const SHIFTED = Object.freeze({ kind: 'shifted' })
export const NONE = Object.freeze({ kind: 'none' })

const DAY_MS = 86400000
const ERA_DAYS = 146097 // days in 400 Gregorian years, also a whole number of weeks
const MAX_CYCLE = 31
const BACKLOG_DAYS = 6 // a weekly backlog expires after this many days without a shift
const NEXT_WORKOUT_DAYS = 60
const MAX_RANGE_DAYS = 3660
const SIM_CACHE_SIZE = 24

const PAST_DAY = 'You can only change today or future days.'
const LOGGED_DAY = 'That day already has a workout logged.'
const BAD_DATE = 'Pick a valid date.'

const defaultMakeId = () => Math.random().toString(36).slice(2, 10)

export function mod(a, n) {
  return ((a % n) + n) % n
}

// ---- dates ------------------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// Days since 1970-01-01 for a valid ISO date, else null. Parsing 400 years later keeps Date.UTC
// away from its "years 0–99 mean 1900s" rule; 400 years is exactly ERA_DAYS days.
function toDay(iso) {
  if (typeof iso !== 'string') return null
  const match = ISO_RE.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  if (month < 1 || month > 12 || date < 1 || date > 31) return null
  const ms = Date.UTC(year + 400, month - 1, date)
  if (new Date(ms).getUTCDate() !== date) return null // 2027-02-29, 2026-04-31 …
  return ms / DAY_MS - ERA_DAYS
}

function fromDay(day) {
  const date = new Date((day + ERA_DAYS) * DAY_MS)
  const year = date.getUTCFullYear() - 400
  if (!(year >= 0 && year <= 9999)) return null
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

const weekdayOfDay = (day) => mod(day + 4, 7) // 1970-01-01 was a Thursday
const weekStartDay = (day, firstWeekday) => day - mod(weekdayOfDay(day) - firstWeekday, 7)

function normWeekday(value, fallback = 1) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : fallback
}

export function isIsoDate(value) {
  return toDay(value) !== null
}

// ISO → ISO; null for an invalid date.
export function addDays(iso, n) {
  const day = toDay(iso)
  if (day === null) return null
  const delta = Number(n)
  return fromDay(day + (Number.isFinite(delta) ? Math.trunc(delta) : 0))
}

// Whole days from `fromIso` to `toIso` (NaN if either is invalid).
export function daysBetween(fromIso, toIso) {
  const from = toDay(fromIso)
  const to = toDay(toIso)
  return from === null || to === null ? NaN : to - from
}

// 0 = Sun … 6 = Sat (NaN if invalid).
export function weekday(iso) {
  const day = toDay(iso)
  return day === null ? NaN : weekdayOfDay(day)
}

export function weekStart(iso, firstWeekday = 1) {
  const day = toDay(iso)
  return day === null ? null : fromDay(weekStartDay(day, normWeekday(firstWeekday, 1)))
}

// ---- normalising stored data ------------------------------------------------------------------

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const restSlot = () => ({ kind: 'rest' })
const isRoutineSlot = (slot, routineId) => slot.kind === 'routine' && slot.routineId === routineId

function cleanId(value) {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

// A valid Slot copy, or null.
function cleanSlot(slot) {
  if (!isObject(slot)) return null
  if (slot.kind === 'rest') return restSlot()
  if (slot.kind !== 'routine') return null
  const routineId = cleanId(slot.routineId)
  return routineId ? { kind: 'routine', routineId } : null
}

// Unknown or broken slots become rest, which keeps the cycle length (and alignment) intact.
const cleanSlots = (list) => Array.from(list, (slot) => cleanSlot(slot) || restSlot())

const cleanDates = (list) => (Array.isArray(list) ? [...new Set(list.filter(isIsoDate))].sort() : [])

function cleanVersion(raw) {
  if (!isObject(raw) || !isIsoDate(raw.effectiveFrom)) return null
  const { effectiveFrom } = raw
  const cycle = Array.isArray(raw.cycle) ? raw.cycle : []
  const weekly = Array.isArray(raw.weekly) ? raw.weekly : []
  const mode = raw.mode === 'weekly' || raw.mode === 'rotation' ? raw.mode : !cycle.length && weekly.length ? 'weekly' : 'rotation'
  const id = cleanId(raw.id) || `v${effectiveFrom}`
  if (mode === 'weekly') {
    const days = Array.from({ length: 7 }, (_, index) => cleanSlot(weekly[index]) || restSlot())
    return { ...raw, id, effectiveFrom, mode, cycle: [], anchorIndex: 0, weekly: days }
  }
  const slots = cleanSlots(cycle)
  const anchor = Number(raw.anchorIndex)
  const anchorIndex = slots.length && Number.isFinite(anchor) ? mod(Math.trunc(anchor), slots.length) : 0
  return { ...raw, id, effectiveFrom, mode, cycle: slots, anchorIndex, weekly: [] }
}

function cleanDateMap(raw, cleanValue) {
  const out = {}
  if (!isObject(raw)) return out
  for (const key of Object.keys(raw).sort()) {
    if (!isIsoDate(key)) continue
    const value = cleanValue(raw[key])
    if (value) out[key] = value
  }
  return out
}

function cleanSkip(value) {
  if (!value) return null
  return isObject(value) && typeof value.note === 'string' && value.note ? { note: value.note } : {}
}

function cleanOverride(value) {
  if (!isObject(value)) return null
  const slot = cleanSlot(value.slot)
  if (!slot) return null
  const override = { slot }
  if (isIsoDate(value.movedFrom)) override.movedFrom = value.movedFrom
  if (isIsoDate(value.movedTo)) override.movedTo = value.movedTo
  return override
}

function cleanFactor(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

function cleanDeload(raw) {
  const deload = isObject(raw) ? raw : {}
  const every = Number(deload.everyWeeks)
  return {
    ...deload,
    everyWeeks: Number.isFinite(every) && every >= 1 ? Math.floor(every) : 0,
    programStart: isIsoDate(deload.programStart) ? deload.programStart : null,
    setsFactor: cleanFactor(deload.setsFactor, 0.5),
    weightFactor: cleanFactor(deload.weightFactor, 0.9),
    manualWeeks: cleanDates(deload.manualWeeks),
    cancelledWeeks: cleanDates(deload.cancelledWeeks),
  }
}

export function emptySchedule() {
  return { versions: [], shifts: [], skips: {}, overrides: {}, deload: cleanDeload(null) }
}

// Tolerant: fills defaults, drops malformed entries, sorts versions (a later duplicate
// effectiveFrom wins) and shifts (unique). Always returns a fresh object; never throws.
export function normalizeSchedule(schedule) {
  const raw = isObject(schedule) ? schedule : {}
  const byDate = new Map()
  for (const version of Array.isArray(raw.versions) ? raw.versions : []) {
    const clean = cleanVersion(version)
    if (clean) byDate.set(clean.effectiveFrom, clean)
  }
  return {
    ...raw,
    versions: [...byDate.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)),
    shifts: cleanDates(raw.shifts),
    skips: cleanDateMap(raw.skips, cleanSkip),
    overrides: cleanDateMap(raw.overrides, cleanOverride),
    deload: cleanDeload(raw.deload),
  }
}

// ---- planned slot -----------------------------------------------------------------------------

// First index whose value is >= x in a sorted number array.
function lowerBound(list, x) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Precomputed lookups for one normalized schedule (built once per public call).
function scheduleContext(schedule) {
  return {
    schedule,
    versions: schedule.versions,
    effDays: schedule.versions.map((version) => toDay(version.effectiveFrom)),
    shiftDays: schedule.shifts.map(toDay),
    shiftSet: new Set(schedule.shifts),
    moves: new Map(), // version index → weekly simulation, for this call
  }
}

// Index of the last version starting on or before `day`, or -1.
function versionIndexAt(ctx, day) {
  return lowerBound(ctx.effDays, day + 1) - 1
}

// Rotation position before the mod: one slot per day since effectiveFrom, minus shifted days.
function rotationK(ctx, index, day) {
  const eff = ctx.effDays[index]
  const shifted = lowerBound(ctx.shiftDays, day) - lowerBound(ctx.shiftDays, eff)
  return ctx.versions[index].anchorIndex + (day - eff) - shifted
}

// cycleIndex: rotation → index into the cycle; weekly → weekday whose slot shows (after shifts
// slide the week along); null when shifted or there is no plan.
function plannedAt(ctx, day, iso) {
  const index = versionIndexAt(ctx, day)
  if (index < 0) return { version: null, slot: NONE, cycleIndex: null }
  const version = ctx.versions[index]
  if (version.mode === 'rotation' && !version.cycle.length) return { version, slot: NONE, cycleIndex: null }
  if (ctx.shiftSet.has(iso)) return { version, slot: SHIFTED, cycleIndex: null }
  if (version.mode === 'rotation') {
    const cycleIndex = mod(rotationK(ctx, index, day), version.cycle.length)
    return { version, slot: version.cycle[cycleIndex], cycleIndex }
  }
  const moved = weeklyMoves(ctx, index).get(day)
  const cycleIndex = moved === undefined ? weekdayOfDay(day) : moved
  return { version, slot: version.weekly[cycleIndex], cycleIndex }
}

// Weekly simulations are memoised across calls. The result depends only on the version's
// rest pattern, where it ends and its shifts, so that is the key.
const simCache = new Map()
const NO_MOVES = new Map()

function weeklyMoves(ctx, index) {
  let moves = ctx.moves.get(index)
  if (moves) return moves
  const start = ctx.effDays[index]
  const end = index + 1 < ctx.effDays.length ? ctx.effDays[index + 1] : Infinity
  // Shifts before effectiveFrom are ignored; the queue never crosses into the next version.
  const shifts = ctx.shiftDays.slice(lowerBound(ctx.shiftDays, start), lowerBound(ctx.shiftDays, end))
  if (!shifts.length) {
    moves = NO_MOVES
  } else {
    const pattern = ctx.versions[index].weekly.map((slot) => (slot.kind === 'rest' ? '-' : 'x')).join('')
    const key = `${pattern}|${end}|${shifts.join(',')}`
    moves = simCache.get(key)
    if (moves) {
      simCache.delete(key) // refresh its place in the LRU order
    } else {
      moves = simulateWeekly(pattern, end, shifts)
      if (simCache.size >= SIM_CACHE_SIZE) simCache.delete(simCache.keys().next().value)
    }
    simCache.set(key, moves)
  }
  ctx.moves.set(index, moves)
  return moves
}

// The weekly queue from the spec: each day queues its own slot; a shifted day shows SHIFTED and
// keeps its slot queued, so workouts slide into later days. Rest slots left in the queue are
// absorbed, and the backlog is dropped after 6 days without a shift. Days where the queue is
// empty just show their own slot, so the loop jumps between shifts instead of walking every day.
// Returns Map(day → weekday whose slot shows) for days that don't show their own slot.
function simulateWeekly(pattern, end, shifts) {
  const moves = new Map()
  let queue = []
  let next = 0 // index of the first shift >= day
  let lastShift = -Infinity
  let day = shifts[0]
  while (day < end) {
    if (day - lastShift > BACKLOG_DAYS) queue = []
    const isShift = next < shifts.length && shifts[next] === day
    if (!queue.length && !isShift) {
      if (next >= shifts.length) break
      day = shifts[next]
      continue
    }
    const own = weekdayOfDay(day)
    queue.push(own)
    if (isShift) {
      lastShift = day
      next++
    } else {
      const shown = queue.shift()
      if (shown !== own) moves.set(day, shown)
      queue = queue.filter((index) => pattern[index] !== '-')
    }
    day++
  }
  return moves
}

export function versionFor(schedule, date) {
  const day = toDay(date)
  if (day === null) return null
  const ctx = scheduleContext(normalizeSchedule(schedule))
  const index = versionIndexAt(ctx, day)
  return index < 0 ? null : ctx.versions[index]
}

export function plannedFor(schedule, date) {
  const day = toDay(date)
  if (day === null) return { version: null, slot: NONE, cycleIndex: null }
  return plannedAt(scheduleContext(normalizeSchedule(schedule)), day, date)
}

// ---- deload -----------------------------------------------------------------------------------

// Weeks are compared by their start under the current first-weekday setting, so stored weeks
// still match if that setting changes. Automatic deloads count whole weeks from the week
// containing programStart (the first version's start when unset).
function deloadRules(deload, fallbackStart, firstWeekday) {
  const weeks = (list) => new Set(list.map((iso) => weekStartDay(toDay(iso), firstWeekday)))
  const start = toDay(deload.programStart || fallbackStart)
  return {
    firstWeekday,
    every: deload.everyWeeks,
    startWeek: start === null ? null : weekStartDay(start, firstWeekday),
    manual: weeks(deload.manualWeeks),
    cancelled: weeks(deload.cancelledWeeks),
  }
}

function autoDeloadWeek(rules, weekDay) {
  if (!rules.every || rules.startWeek === null || weekDay < rules.startWeek) return false
  return mod((weekDay - rules.startWeek) / 7, rules.every) === rules.every - 1
}

function deloadAt(rules, day) {
  const week = weekStartDay(day, rules.firstWeekday)
  if (rules.manual.has(week)) return true
  return autoDeloadWeek(rules, week) && !rules.cancelled.has(week)
}

function firstEffective(versions) {
  let first = null
  for (const version of Array.isArray(versions) ? versions : []) {
    if (isObject(version) && isIsoDate(version.effectiveFrom) && (first === null || version.effectiveFrom < first)) first = version.effectiveFrom
  }
  return first
}

export function isDeload(schedule, date, firstWeekday = 1) {
  const day = toDay(date)
  if (day === null) return false
  const raw = isObject(schedule) ? schedule : {}
  return deloadAt(deloadRules(cleanDeload(raw.deload), firstEffective(raw.versions), normWeekday(firstWeekday, 1)), day)
}

// ---- resolving days ---------------------------------------------------------------------------

function indexRoutines(routines) {
  const map = new Map()
  for (const routine of Array.isArray(routines) ? routines : []) {
    const id = isObject(routine) ? cleanId(routine.id) : null
    if (id && !map.has(id)) map.set(id, routine)
  }
  return map
}

// Session.date is the day key; entries without a valid date are ignored. Input order is kept.
function indexSessions(sessions) {
  const map = new Map()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isObject(session) || !isIsoDate(session.date)) continue
    const list = map.get(session.date)
    if (list) list.push(session)
    else map.set(session.date, [session])
  }
  return map
}

function dayContext(gym, sessions) {
  const source = isObject(gym) ? gym : {}
  const ctx = scheduleContext(normalizeSchedule(source.schedule))
  const firstWeekday = normWeekday(isObject(source.prefs) ? source.prefs.firstWeekday : undefined, 1)
  ctx.deload = deloadRules(ctx.schedule.deload, ctx.versions.length ? ctx.versions[0].effectiveFrom : null, firstWeekday)
  ctx.routines = indexRoutines(source.routines)
  ctx.sessions = indexSessions(sessions)
  return ctx
}

const todayDay = (today) => {
  const day = toDay(today)
  return day === null ? -Infinity : day // unknown today: treat every planned day as upcoming
}

// Status priority: done (sessions are facts) → none → skipped → shifted → rest → missed/today/upcoming.
function resolveAt(ctx, day, iso, today) {
  const { version, slot: planned, cycleIndex } = plannedAt(ctx, day, iso)
  const override = ctx.schedule.overrides[iso] || null
  const shown = override ? override.slot : planned
  const sessions = ctx.sessions.get(iso) || []
  const skipped = !!ctx.schedule.skips[iso]
  const routine = shown.kind === 'routine' ? ctx.routines.get(shown.routineId) || null : null
  let status
  if (sessions.length) status = 'done'
  else if (shown.kind === 'none') status = 'none'
  else if (skipped) status = 'skipped'
  else if (shown.kind === 'shifted') status = 'shifted'
  else if (shown.kind === 'rest') status = 'rest'
  else status = day < today ? 'missed' : day === today ? 'today' : 'upcoming'
  return {
    date: iso,
    status,
    planned,
    shown,
    cycleIndex,
    versionId: version ? version.id : null,
    routine,
    routineMissing: shown.kind === 'routine' && !routine,
    sessions,
    override,
    skipped,
    shifted: ctx.shiftSet.has(iso),
    deload: deloadAt(ctx.deload, day),
  }
}

function blankDay(date) {
  return {
    date,
    status: 'none',
    planned: NONE,
    shown: NONE,
    cycleIndex: null,
    versionId: null,
    routine: null,
    routineMissing: false,
    sessions: [],
    override: null,
    skipped: false,
    shifted: false,
    deload: false,
  }
}

// gym = settings.gym (uses .schedule, .routines and .prefs.firstWeekday).
export function resolveDay(gym, sessions, date, today) {
  const day = toDay(date)
  if (day === null) return blankDay(date)
  return resolveAt(dayContext(gym, sessions), day, date, todayDay(today))
}

// Every date from..to inclusive (at most MAX_RANGE_DAYS); [] when the range is invalid.
export function resolveRange(gym, sessions, from, to, today) {
  const start = toDay(from)
  const end = toDay(to)
  if (start === null || end === null || end < start) return []
  const ctx = dayContext(gym, sessions)
  const now = todayDay(today)
  const last = Math.min(end, start + MAX_RANGE_DAYS - 1)
  const days = []
  for (let day = start; day <= last; day++) days.push(resolveAt(ctx, day, fromDay(day), now))
  return days
}

// First day after today (within 60 days) that shows a routine and isn't skipped.
export function nextWorkout(gym, sessions, today) {
  const now = toDay(today)
  if (now === null) return null
  const ctx = dayContext(gym, sessions)
  for (let day = now + 1; day <= now + NEXT_WORKOUT_DAYS; day++) {
    const iso = fromDay(day)
    if (iso === null) return null
    const resolved = resolveAt(ctx, day, iso, now)
    if (resolved.shown.kind === 'routine' && resolved.status !== 'skipped') return resolved
  }
  return null
}

// ---- mutations --------------------------------------------------------------------------------

function assertEditable(date, today) {
  if (!isIsoDate(date) || !isIsoDate(today)) throw new Error(BAD_DATE)
  if (date < today) throw new Error(PAST_DAY)
}

function without(map, key) {
  const copy = { ...map }
  delete copy[key]
  return copy
}

const newVersionId = (effectiveFrom, makeId) => `v${effectiveFrom}-${(typeof makeId === 'function' ? makeId : defaultMakeId)()}`

// When a moved day is replaced or cleared, drop its partner's back-link so no day claims a move
// that no longer exists. Past partners are left alone (past days never change).
function unlinkMove(overrides, date, today) {
  const own = overrides[date]
  if (!own) return overrides
  let out = overrides
  for (const [field, back] of [['movedTo', 'movedFrom'], ['movedFrom', 'movedTo']]) {
    const partner = own[field]
    if (!partner || partner === date || partner < today || !out[partner] || out[partner][back] !== date) continue
    out = { ...out, [partner]: without(out[partner], back) }
  }
  return out
}

export function skipDay(schedule, date, today, hasSession) {
  assertEditable(date, today)
  if (hasSession) throw new Error(LOGGED_DAY)
  const s = normalizeSchedule(schedule)
  return { ...s, skips: { ...s.skips, [date]: s.skips[date] || {} } }
}

// A shifted day consumes no slot, so everything after it moves one day later. Set semantics.
export function shiftDay(schedule, date, today, hasSession) {
  assertEditable(date, today)
  if (hasSession) throw new Error(LOGGED_DAY)
  const s = normalizeSchedule(schedule)
  return s.shifts.includes(date) ? s : { ...s, shifts: [...s.shifts, date].sort() }
}

// One-off change of what a day shows. It doesn't change consumption, so tomorrow is unaffected
// (a shift on the same day still shifts). Re-planning the day also lifts a skip on it.
export function overrideDay(schedule, date, slot, today) {
  assertEditable(date, today)
  const clean = cleanSlot(slot)
  if (!clean) throw new Error('Pick a routine or Rest.')
  const s = normalizeSchedule(schedule)
  return { ...s, skips: without(s.skips, date), overrides: { ...unlinkMove(s.overrides, date, today), [date]: { slot: clean } } }
}

// Removes the skip, shift and override for date.
export function clearDay(schedule, date, today) {
  assertEditable(date, today)
  const s = normalizeSchedule(schedule)
  return {
    ...s,
    shifts: s.shifts.filter((shift) => shift !== date),
    skips: without(s.skips, date),
    overrides: without(unlinkMove(s.overrides, date, today), date),
  }
}

// `from` becomes rest and `to` shows from's workout (to's own planned slot is replaced).
export function moveWorkout(schedule, from, to, today, shownSlotOfFrom) {
  assertEditable(from, today)
  assertEditable(to, today)
  if (from === to) throw new Error('Pick a different day to move it to.')
  const slot = cleanSlot(shownSlotOfFrom)
  if (!slot || slot.kind !== 'routine') throw new Error('There is no workout to move on that day.')
  const s = normalizeSchedule(schedule)
  const overrides = unlinkMove(unlinkMove(s.overrides, from, today), to, today)
  return {
    ...s,
    skips: without(without(s.skips, from), to),
    overrides: { ...overrides, [from]: { slot: restSlot(), movedTo: to }, [to]: { slot, movedFrom: from } },
  }
}

// Copy-on-write: the new version starts today (tomorrow if today already has a session); versions
// starting later are dropped and one starting that same day is replaced, so past days never
// change. For a rotation, anchorIndex is today's slot ("Today is …"); a version that starts
// tomorrow therefore begins one slot later.
export function editSchedule(schedule, plan, today, hasSessionToday, makeId = defaultMakeId) {
  const { mode, cycle, weekly, anchorIndex } = isObject(plan) ? plan : {}
  const eff = isIsoDate(today) ? (hasSessionToday ? addDays(today, 1) : today) : null
  if (!eff) throw new Error(BAD_DATE)
  let version
  if (mode === 'rotation') {
    if (!Array.isArray(cycle) || cycle.length < 1 || cycle.length > MAX_CYCLE) throw new Error('A rotation needs between 1 and 31 days.')
    const slots = cleanSlots(cycle)
    const anchor = Number(anchorIndex)
    const todayIndex = Number.isFinite(anchor) ? Math.trunc(anchor) : 0
    version = { id: newVersionId(eff, makeId), effectiveFrom: eff, mode, cycle: slots, anchorIndex: mod(todayIndex + (eff === today ? 0 : 1), slots.length), weekly: [] }
  } else if (mode === 'weekly') {
    if (!Array.isArray(weekly) || weekly.length !== 7) throw new Error('A weekly plan needs exactly 7 days.')
    version = { id: newVersionId(eff, makeId), effectiveFrom: eff, mode, cycle: [], anchorIndex: 0, weekly: cleanSlots(weekly) }
  } else {
    throw new Error('Choose Rotation or Weekly.')
  }
  const s = normalizeSchedule(schedule)
  return { ...s, versions: [...s.versions.filter((v) => v.effectiveFrom < eff), version] }
}

// After doing `routineId` on a different day of the rotation: continue the cycle after it from
// tomorrow. Returns null when not applicable (no plan, weekly, empty cycle, routine not in it).
export function realign(schedule, routineId, today, makeId = defaultMakeId) {
  const now = toDay(today)
  const id = cleanId(routineId)
  if (now === null || !id) return null
  const s = normalizeSchedule(schedule)
  const ctx = scheduleContext(s)
  const index = versionIndexAt(ctx, now)
  if (index < 0) return null
  const version = s.versions[index]
  const n = version.cycle.length
  if (version.mode !== 'rotation' || !n) return null
  // Prefer the first occurrence at or after today's position, else the first in the cycle.
  const current = mod(rotationK(ctx, index, now), n)
  let found = -1
  for (let step = 0; step < n && found < 0; step++) {
    if (isRoutineSlot(version.cycle[(current + step) % n], id)) found = (current + step) % n
  }
  const tomorrow = fromDay(now + 1)
  if (found < 0 || !tomorrow) return null
  const next = { id: newVersionId(tomorrow, makeId), effectiveFrom: tomorrow, mode: 'rotation', cycle: cleanSlots(version.cycle), anchorIndex: mod(found + 1, n), weekly: [] }
  return { ...s, versions: [...s.versions.filter((v) => v.effectiveFrom < tomorrow), next] }
}

const slotsOf = (version) => (version.mode === 'rotation' ? version.cycle : version.weekly)
const usesRoutine = (version, routineId) => slotsOf(version).some((slot) => isRoutineSlot(slot, routineId))

// For deleting a routine: from today (tomorrow if today has a session) its slots become rest.
// The version in effect gets a copy-on-write successor that continues the rotation exactly;
// later versions and overrides from today on are mapped in place.
export function replaceRoutineWithRest(schedule, routineId, today, hasSessionToday, makeId = defaultMakeId) {
  const eff = isIsoDate(today) ? (hasSessionToday ? addDays(today, 1) : today) : null
  if (!eff) throw new Error(BAD_DATE)
  const s = normalizeSchedule(schedule)
  const id = cleanId(routineId)
  if (!id) return s
  const effDay = toDay(eff)
  const ctx = scheduleContext(s)
  const current = versionIndexAt(ctx, effDay)
  const swap = (slots) => slots.map((slot) => (isRoutineSlot(slot, id) ? restSlot() : slot))
  const versions = []
  s.versions.forEach((version, index) => {
    if (version.effectiveFrom >= eff) {
      versions.push(usesRoutine(version, id) ? { ...version, cycle: swap(version.cycle), weekly: swap(version.weekly) } : version)
      return
    }
    versions.push(version)
    if (index !== current || !usesRoutine(version, id)) return
    const anchorIndex = version.mode === 'rotation' ? mod(rotationK(ctx, index, effDay), version.cycle.length) : 0
    versions.push({ id: newVersionId(eff, makeId), effectiveFrom: eff, mode: version.mode, cycle: swap(version.cycle), anchorIndex, weekly: swap(version.weekly) })
  })
  const overrides = {}
  for (const [date, override] of Object.entries(s.overrides)) {
    overrides[date] = date >= today && isRoutineSlot(override.slot, id) ? { ...override, slot: restSlot() } : override
  }
  return { ...s, versions, overrides }
}

// Whether the routine appears in the version in effect today, a later version, or an override
// from today on.
export function routineInUse(schedule, routineId, today) {
  const now = toDay(today)
  const id = cleanId(routineId)
  if (now === null || !id) return false
  const s = normalizeSchedule(schedule)
  const current = versionIndexAt(scheduleContext(s), now)
  return s.versions.some((version, index) => index >= current && usesRoutine(version, id))
    || Object.entries(s.overrides).some(([date, override]) => date >= today && isRoutineSlot(override.slot, id))
}

// 'Deload this week' (on) / 'Skip this deload' (off) for the week containing date.
export function deloadWeek(schedule, date, firstWeekday, on) {
  const day = toDay(date)
  if (day === null) throw new Error(BAD_DATE)
  const fw = normWeekday(firstWeekday, 1)
  const s = normalizeSchedule(schedule)
  const week = weekStartDay(day, fw)
  const iso = fromDay(week)
  const otherWeeks = (list) => list.filter((entry) => weekStartDay(toDay(entry), fw) !== week)
  const manualWeeks = otherWeeks(s.deload.manualWeeks)
  const cancelledWeeks = otherWeeks(s.deload.cancelledWeeks)
  if (on) return { ...s, deload: { ...s.deload, manualWeeks: [...manualWeeks, iso].sort(), cancelledWeeks } }
  const rules = deloadRules(s.deload, s.versions.length ? s.versions[0].effectiveFrom : null, fw)
  return {
    ...s,
    deload: { ...s.deload, manualWeeks, cancelledWeeks: autoDeloadWeek(rules, week) ? [...cancelledWeeks, iso].sort() : cancelledWeeks },
  }
}

// Automatic deload every N weeks (0 = off), counted from programStart (kept if set, else today).
export function setDeloadEvery(schedule, everyWeeks, today) {
  const every = Number(everyWeeks)
  if (!Number.isInteger(every) || every < 0 || every > 52) throw new Error('Deload every 1 to 52 weeks, or 0 to turn it off.')
  if (!isIsoDate(today)) throw new Error(BAD_DATE)
  const s = normalizeSchedule(schedule)
  return { ...s, deload: { ...s.deload, everyWeeks: every, programStart: s.deload.programStart || today } }
}

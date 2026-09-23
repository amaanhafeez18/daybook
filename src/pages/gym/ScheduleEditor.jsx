import { useId, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { Button, IconButton, Segmented } from '../../components/ui/primitives.jsx'
import { WEEKDAY_SHORT } from '../../lib/dates.js'
import { addDays, editSchedule, mod, plannedFor, resolveDay, resolveRange, setDeloadEvery, versionFor, weekday } from '../../lib/gym/schedule.js'
import { getGym, routineById, routineColor, saveSchedule, updateGym, useGym, useGymSessions } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import { GymEmpty, RoutineDot } from './common.jsx'
import './routines.css'

// Edits the plan: a rotation (cycle of 1-31 days, "Today is …") or a weekly plan, plus automatic
// deloads. Saving is copy-on-write from today (tomorrow when today already has a workout), so
// past days never change; a live two-week preview shows the result before saving.

const MAX_SLOTS = 31
const PREVIEW_DAYS = 14
const REST = Object.freeze({ kind: 'rest' })
const DELOAD_CHOICES = [0, 3, 4, 5, 6, 8, 10, 12]
const MODES = [
  { id: 'rotation', label: 'Rotation', icon: 'repeat' },
  { id: 'weekly', label: 'Weekly', icon: 'calendar' },
]

let keySeq = 0
const newKey = () => `slot-${++keySeq}`
const keyed = (slots) => slots.map((slot) => ({ key: newKey(), slot }))
const slotValue = (slot) => (slot?.kind === 'routine' ? `r:${slot.routineId}` : 'rest')
const valueSlot = (value) => (value.startsWith('r:') ? { kind: 'routine', routineId: value.slice(2) } : REST)
const sameSlots = (a, b) => a.length === b.length && a.every((slot, index) => slotValue(slot) === slotValue(b[index]))
const nameOf = (routine) => (typeof routine?.name === 'string' && routine.name.trim()) || 'Untitled routine'

// Weekly → rotation: the 7 days in first-weekday order.
const weeklyToCycle = (weekly, firstWeekday) => Array.from({ length: 7 }, (_, i) => weekly[(firstWeekday + i) % 7] || REST)

// Rotation → weekly: the first 7 slots from Monday; missing days are rest.
function cycleToWeekly(cycle) {
  const weekly = Array.from({ length: 7 }, () => REST)
  cycle.slice(0, 7).forEach((slot, i) => { weekly[(1 + i) % 7] = slot })
  return weekly
}

// First slot holding the routine shown today, else 0.
function firstOccurrence(slots, gym, sessions, today) {
  const shown = resolveDay(gym, sessions, today, today).shown
  if (shown.kind === 'routine') {
    const index = slots.findIndex((slot) => slot.kind === 'routine' && slot.routineId === shown.routineId)
    if (index >= 0) return index
  }
  return 0
}

// "Today is" default: while the cycle matches the current rotation, the slot today already has
// (so saving without changes keeps the plan exactly where it is); else firstOccurrence.
function defaultAnchor(slots, base, gym, sessions, today) {
  if (!slots.length) return 0
  if (base?.mode === 'rotation' && sameSlots(slots, base.cycle)) {
    if (base.effectiveFrom > today) return mod(base.anchorIndex - 1, slots.length)
    // A shifted day has no slot; the next unshifted day shows the slot today would have had.
    for (let offset = 0; offset <= MAX_SLOTS; offset++) {
      const planned = plannedFor(gym.schedule, addDays(today, offset))
      if (planned.version?.id !== base.id) break
      if (planned.cycleIndex != null) return planned.cycleIndex
    }
  }
  return firstOccurrence(slots, gym, sessions, today)
}

function initialDraft(gym, sessions, today) {
  const { versions } = gym.schedule
  const base = versions.length ? versions[versions.length - 1] : null
  const firstWeekday = gym.prefs.firstWeekday
  let draft
  if (base?.mode === 'weekly') {
    draft = {
      mode: 'weekly',
      weekly: { slots: base.weekly.slice(), edited: true },
      rotation: { slots: keyed(weeklyToCycle(base.weekly, firstWeekday)), edited: false },
    }
  } else {
    // No plan yet: start from every routine in order, then a rest day.
    const cycle = base ? base.cycle : [...gym.routines.slice(0, MAX_SLOTS - 1).map((routine) => ({ kind: 'routine', routineId: routine.id })), REST]
    draft = {
      mode: 'rotation',
      rotation: { slots: keyed(cycle), edited: Boolean(base) },
      weekly: { slots: cycleToWeekly(cycle), edited: false },
    }
  }
  const slots = draft.rotation.slots.map((item) => item.slot)
  const anchor = draft.mode === 'rotation' ? defaultAnchor(slots, base, gym, sessions, today) : mod(weekday(today) - firstWeekday, 7)
  return { ...draft, anchorKey: draft.rotation.slots[anchor]?.key ?? null, deloadEvery: gym.schedule.deload.everyWeeks }
}

function planOf(draft) {
  if (draft.mode === 'weekly') return { mode: 'weekly', cycle: [], weekly: draft.weekly.slots, anchorIndex: 0 }
  const slots = draft.rotation.slots
  const anchor = slots.findIndex((item) => item.key === draft.anchorKey)
  return { mode: 'rotation', cycle: slots.map((item) => item.slot), weekly: [], anchorIndex: Math.max(0, anchor) }
}

const snapshot = (draft) => JSON.stringify({ plan: planOf(draft), deload: draft.deloadEvery })

// True when saving `plan` would give the same days as the version already in effect.
function planUnchanged(schedule, plan, today, hasSessionToday) {
  const eff = hasSessionToday ? addDays(today, 1) : today
  const current = versionFor(schedule, eff)
  if (!current || current.mode !== plan.mode) return false
  if (schedule.versions.some((version) => version.effectiveFrom > eff)) return false
  if (plan.mode === 'weekly') return sameSlots(current.weekly, plan.weekly)
  if (!sameSlots(current.cycle, plan.cycle)) return false
  const wanted = mod(plan.anchorIndex + (eff === today ? 0 : 1), plan.cycle.length)
  const at = current.effectiveFrom === eff ? current.anchorIndex : plannedFor(schedule, eff).cycleIndex
  return at === wanted
}

export default function ScheduleEditor({ open, onClose, today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const [state, setState] = useState(() => (open ? start(gym, sessions, today) : null))
  const [wasOpen, setWasOpen] = useState(open)
  const anchorId = useId()
  const deloadId = useId()

  // Fresh draft from the saved plan each time the sheet opens.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setState(start(gym, sessions, today))
  }

  const draft = state?.draft || null
  const firstWeekday = gym.prefs.firstWeekday
  const hasSessionToday = useMemo(() => sessions.some((session) => session.date === today), [sessions, today])
  const dirty = !!draft && snapshot(draft) !== state.initial
  const plan = draft ? planOf(draft) : null

  const preview = useMemo(() => {
    if (!open || !draft || !plan) return null
    try {
      let schedule = editSchedule(gym.schedule, plan, today, hasSessionToday)
      if (draft.deloadEvery !== gym.schedule.deload.everyWeeks) schedule = setDeloadEvery(schedule, draft.deloadEvery, today)
      return resolveRange({ ...gym, schedule }, sessions, today, addDays(today, PREVIEW_DAYS - 1), today)
    } catch {
      return null
    }
  }, [open, draft, gym, sessions, today, hasSessionToday]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn) => setState((current) => (current ? { ...current, draft: fn(current.draft) } : current))

  const editRotation = (fn) => update((current) => {
    const slots = fn(current.rotation.slots)
    let { anchorKey } = current
    if (!slots.some((item) => item.key === anchorKey)) {
      anchorKey = slots[firstOccurrence(slots.map((item) => item.slot), gym, sessions, today)]?.key ?? null
    }
    return { ...current, rotation: { slots, edited: true }, anchorKey }
  })

  const switchMode = (mode) => update((current) => {
    if (current.mode === mode) return current
    if (mode === 'rotation' && !current.rotation.edited) {
      const slots = keyed(weeklyToCycle(current.weekly.slots, firstWeekday))
      return { ...current, mode, rotation: { slots, edited: false }, anchorKey: slots[mod(weekday(today) - firstWeekday, 7)].key }
    }
    if (mode === 'weekly' && !current.weekly.edited) {
      return { ...current, mode, weekly: { slots: cycleToWeekly(current.rotation.slots.map((item) => item.slot)), edited: false } }
    }
    return { ...current, mode }
  })

  const setSlot = (key, value) => editRotation((slots) => slots.map((item) => (item.key === key ? { ...item, slot: valueSlot(value) } : item)))
  const removeSlot = (key) => editRotation((slots) => (slots.length > 1 ? slots.filter((item) => item.key !== key) : slots))
  const moveSlot = (key, delta) => editRotation((slots) => {
    const from = slots.findIndex((item) => item.key === key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= slots.length) return slots
    const next = slots.slice()
    ;[next[from], next[to]] = [next[to], next[from]]
    return next
  })
  // A new day gets the first routine not in the cycle yet, else Rest.
  const addSlot = () => editRotation((slots) => {
    if (slots.length >= MAX_SLOTS) return slots
    const used = new Set(slots.map((item) => slotValue(item.slot)))
    const routine = gym.routines.find((item) => !used.has(`r:${item.id}`))
    return [...slots, { key: newKey(), slot: routine ? { kind: 'routine', routineId: routine.id } : REST }]
  })
  const setWeekday = (day, value) => update((current) => ({
    ...current,
    weekly: { slots: current.weekly.slots.map((slot, index) => (index === day ? valueSlot(value) : slot)), edited: true },
  }))

  const requestClose = async () => {
    if (dirty && !(await confirmAction({ title: 'Discard changes?', message: 'Your schedule edits will be lost.', confirmLabel: 'Discard' }))) return
    onClose()
  }

  const save = () => {
    if (!draft || !plan) return
    if (plan.mode === 'rotation' && (plan.cycle.length < 1 || plan.cycle.length > MAX_SLOTS)) {
      toast('A rotation needs between 1 and 31 days.', { tone: 'error' })
      return
    }
    const current = getGym().schedule
    const planChanged = !planUnchanged(current, plan, today, hasSessionToday)
    const deloadChanged = draft.deloadEvery !== current.deload.everyWeeks
    if (!planChanged && !deloadChanged) {
      onClose()
      return
    }
    const undos = []
    const undoAll = () => undos.slice().reverse().forEach((undo) => undo?.())
    try {
      if (planChanged) undos.push(saveSchedule(plan))
      if (deloadChanged) {
        const before = getGym().schedule.deload
        updateGym((gymNow) => ({ schedule: setDeloadEvery(gymNow.schedule, draft.deloadEvery, today) }))
        undos.push(() => updateGym((gymNow) => ({ schedule: { ...gymNow.schedule, deload: before } })))
      }
    } catch (error) {
      undoAll()
      toast(error?.message || 'Couldn’t save the schedule.', { tone: 'error' })
      return
    }
    onClose()
    const message = planChanged ? (hasSessionToday ? 'Schedule updated from tomorrow' : 'Schedule updated') : draft.deloadEvery ? `Deload every ${draft.deloadEvery} weeks` : 'Automatic deloads off'
    toast(message, { action: { label: 'Undo', onClick: undoAll } })
  }

  const noRoutines = !gym.routines.length

  return (
    <Sheet
      open={open}
      onClose={requestClose}
      title="Schedule"
      description="Which routine falls on each day"
      size="lg"
      initialFocus={false}
      footer={draft && !noRoutines ? (
        <>
          <button type="button" className="btn btn-secondary btn-grow" onClick={requestClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-grow" onClick={save}>Save</button>
        </>
      ) : null}
    >
      {!draft ? null : noRoutines ? (
        <GymEmpty
          icon="calendar"
          title="Create a routine first"
          action={(
            <Button icon="plus" onClick={() => { onClose(); navigate('gym/routine/new') }}>New routine</Button>
          )}
        >
          Your schedule is made of routines, like Push or Legs, and rest days. Make at least one routine, then come back to plan your days.
        </GymEmpty>
      ) : (
        <div className="gym-sched">
          <div className="gym-sched-modes">
            <Segmented options={MODES} value={draft.mode} onChange={switchMode} label="Schedule type" />
            <p className="gym-sched-hint">
              {draft.mode === 'rotation'
                ? 'A cycle of days that repeats in order, whatever the weekday. Good for splits like Push, Pull, Legs, Rest.'
                : 'The same routine on the same weekday, every week.'}
            </p>
          </div>

          {draft.mode === 'rotation' ? (
            <section className="gym-sched-section" aria-label="Rotation days">
              <ol className="gym-sched-list">
                {draft.rotation.slots.map((item, index, slots) => {
                  const isAnchor = item.key === draft.anchorKey
                  const routine = item.slot.kind === 'routine' ? routineById(gym, item.slot.routineId) : null
                  return (
                    <li key={item.key} className={`gym-sched-row${isAnchor ? ' is-anchor' : ''}`}>
                      <span className="gym-sched-index" aria-hidden="true">{index + 1}</span>
                      <SlotSelect
                        slot={item.slot}
                        routine={routine}
                        gym={gym}
                        label={`Day ${index + 1}${isAnchor ? ' (today)' : ''}`}
                        onChange={(value) => setSlot(item.key, value)}
                      />
                      <IconButton icon="arrowUp" label={`Move day ${index + 1} up`} className="gym-sched-btn" size={18} disabled={index === 0} onClick={() => moveSlot(item.key, -1)} />
                      <IconButton icon="arrowDown" label={`Move day ${index + 1} down`} className="gym-sched-btn" size={18} disabled={index === slots.length - 1} onClick={() => moveSlot(item.key, 1)} />
                      <IconButton icon="minus" label={`Remove day ${index + 1}`} className="gym-sched-btn gym-sched-remove" size={18} disabled={slots.length <= 1} onClick={() => removeSlot(item.key)} />
                    </li>
                  )
                })}
              </ol>
              <button type="button" className="gym-sched-add" onClick={addSlot} disabled={draft.rotation.slots.length >= MAX_SLOTS}>
                <Icon name="plus" size={18} strokeWidth={2.2} />
                {draft.rotation.slots.length >= MAX_SLOTS ? 'A rotation can have up to 31 days' : 'Add day'}
              </button>

              <div className="gym-sched-field">
                <label htmlFor={anchorId}>Today is</label>
                <select
                  id={anchorId}
                  className="input gym-sched-inline-select"
                  value={draft.anchorKey ?? ''}
                  onChange={(event) => update((current) => ({ ...current, anchorKey: event.target.value }))}
                >
                  {draft.rotation.slots.map((item, index) => (
                    <option key={item.key} value={item.key}>
                      Day {index + 1} · {item.slot.kind === 'routine' ? routineLabel(gym, item.slot.routineId) : 'Rest'}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          ) : (
            <section className="gym-sched-section" aria-label="Weekly plan">
              <ul className="gym-sched-list">
                {Array.from({ length: 7 }, (_, i) => (firstWeekday + i) % 7).map((day) => {
                  const slot = draft.weekly.slots[day] || REST
                  const routine = slot.kind === 'routine' ? routineById(gym, slot.routineId) : null
                  const isToday = day === weekday(today)
                  return (
                    <li key={day} className={`gym-sched-row${isToday ? ' is-anchor' : ''}`}>
                      <span className="gym-sched-weekday" aria-hidden="true">{WEEKDAY_SHORT[day]}</span>
                      <SlotSelect slot={slot} routine={routine} gym={gym} label={`${WEEKDAY_SHORT[day]}${isToday ? ' (today)' : ''}`} onChange={(value) => setWeekday(day, value)} />
                      {isToday && <span className="gym-sched-today" aria-hidden="true">Today</span>}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <section className="gym-sched-section" aria-labelledby={`${anchorId}-preview`}>
            <h3 className="gym-sched-title" id={`${anchorId}-preview`}>Next two weeks</h3>
            {preview ? (
              <ol className="gym-sched-strip">
                {preview.map((day) => <PreviewDay key={day.date} day={day} gym={gym} today={today} />)}
              </ol>
            ) : (
              <p className="gym-sched-hint">Add at least one day to see a preview.</p>
            )}
          </section>

          <section className="gym-sched-section">
            <div className="gym-sched-field">
              <label htmlFor={deloadId}>Deload week</label>
              <select
                id={deloadId}
                className="input gym-sched-inline-select"
                value={draft.deloadEvery}
                onChange={(event) => update((current) => ({ ...current, deloadEvery: Number(event.target.value) }))}
              >
                {[...new Set([...DELOAD_CHOICES, draft.deloadEvery])].sort((a, b) => a - b).map((weeks) => (
                  <option key={weeks} value={weeks}>{weeks ? `Every ${weeks} weeks` : 'Off'}</option>
                ))}
              </select>
            </div>
            <p className="gym-sched-hint gym-sched-field-hint">
              {draft.deloadEvery
                ? `Every ${ordinal(draft.deloadEvery)} week is lighter: half the sets and 10% less weight, to recover.`
                : 'A regular lighter week (half the sets, 10% less weight) helps you recover and keep progressing.'}
            </p>
          </section>

          <p className="gym-sched-note">
            <Icon name="history" size={16} />
            <span>
              {hasSessionToday
                ? 'Changes start tomorrow, since you’ve already trained today. Past days never change.'
                : 'Changes start today. Past days never change.'}
            </span>
          </p>
        </div>
      )}
    </Sheet>
  )
}

function start(gym, sessions, today) {
  const draft = initialDraft(gym, sessions, today)
  return { draft, initial: snapshot(draft) }
}

function ordinal(n) {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`
}

function routineLabel(gym, routineId) {
  const routine = routineById(gym, routineId)
  return routine ? nameOf(routine) : 'Deleted routine'
}

// Routine / Rest picker with the routine's colour dot. Folders become option groups.
function SlotSelect({ slot, routine, gym, label, onChange }) {
  const value = slotValue(slot)
  const folderIds = new Set(gym.folders.map((folder) => folder.id))
  const loose = gym.routines.filter((item) => !folderIds.has(item.folderId))
  const option = (item) => <option key={item.id} value={`r:${item.id}`}>{nameOf(item)}</option>
  return (
    <span className="gym-sched-pick">
      {slot.kind === 'routine' ? <RoutineDot routine={routine} size={10} /> : <span className="gym-sched-rest-dot" aria-hidden="true" />}
      <select className="input gym-sched-select" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        <option value="rest">Rest</option>
        {slot.kind === 'routine' && !routine && <option value={value}>Deleted routine</option>}
        {gym.folders.length ? (
          <>
            {loose.length > 0 && <optgroup label="Routines">{loose.map(option)}</optgroup>}
            {gym.folders.map((folder) => {
              const members = gym.routines.filter((item) => item.folderId === folder.id)
              return members.length ? <optgroup key={folder.id} label={folder.name}>{members.map(option)}</optgroup> : null
            })}
          </>
        ) : gym.routines.map(option)}
      </select>
    </span>
  )
}

function PreviewDay({ day, gym, today }) {
  const isToday = day.date === today
  const session = day.sessions[0] || null
  let label
  let routine = null
  let tone = ''
  if (day.status === 'done') {
    routine = routineById(gym, session?.routineId)
    label = (typeof session?.name === 'string' && session.name.trim()) || (routine ? nameOf(routine) : 'Workout')
    tone = 'is-done'
  } else if (day.status === 'shifted') {
    label = 'Shifted'
    tone = 'is-muted'
  } else if (day.shown.kind === 'rest') {
    label = 'Rest'
    tone = 'is-rest'
  } else if (day.shown.kind === 'routine') {
    routine = day.routine
    label = routine ? nameOf(routine) : 'Deleted'
    tone = day.status === 'skipped' ? 'is-skipped' : routine ? '' : 'is-muted'
  } else {
    label = 'No plan'
    tone = 'is-muted'
  }
  const date = Number(day.date.slice(8, 10))
  const dow = WEEKDAY_SHORT[weekday(day.date)]
  const status = day.status === 'done' ? ', done' : day.status === 'skipped' ? ', skipped' : ''
  return (
    <li className={`gym-sched-day${isToday ? ' is-today' : ''}`} aria-label={`${isToday ? 'Today' : dow} ${date}: ${label}${status}${day.deload ? ', deload' : ''}`}>
      <span className="gym-sched-dow" aria-hidden="true">{isToday ? 'Today' : dow}</span>
      <span className="gym-sched-date" aria-hidden="true">{date}</span>
      <span
        className={`gym-sched-slot ${tone}`}
        style={routine && tone !== 'is-muted' ? { '--gym-dot': routineColor(routine) } : undefined}
        title={label}
        aria-hidden="true"
      >
        {day.status === 'done' && <Icon name="check" size={11} strokeWidth={3} />}
        {day.status === 'shifted' && <Icon name="arrowRight" size={11} strokeWidth={2.4} />}
        <span>{label}</span>
      </span>
      {day.deload && <span className="gym-sched-deload" aria-hidden="true">Deload</span>}
    </li>
  )
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { WEEKDAY_SHORT } from '../../lib/dates.js'
import { DAY_TYPES, dayTemplate, matchDayType, newRoutineExercise, parseSplit } from '../../lib/gym/library.js'
import { addDays, editSchedule, mod, resolveRange, weekday } from '../../lib/gym/schedule.js'
import { ROUTINE_COLORS, getGym, newGymId, routineColor, saveRoutine, saveSchedule, updateGym, useGym, useGymSessions } from '../../lib/gym/state.js'
import { estimateMinutes } from '../../lib/gym/stats.js'
import { useStore } from '../../lib/store.js'
import ExercisePicker from './ExercisePicker.jsx'
import './wizard.css'

// Split wizard: 1) the days of the split, typed ("push pull legs rest") or tapped together, as a
// rotation or the same days each week; 2) a routine for each training day, reusing one with the
// same name or a new one with suggested exercises; 3) where today falls, then create it all.
// Nothing is saved until "Create split", and that shows an Undo.

const MAX_DAYS = 31
const PREVIEW_DAYS = 14
const MAX_NAME = 40
const REST = Object.freeze({ kind: 'rest' })
const STEPS = ['Your split', 'Workouts', 'Start']
const EXAMPLES = ['push pull legs rest', 'PPL x2, rest', 'upper lower rest x2', 'chest & tris, back & bis, legs, off']
const WORKOUT_TYPES = DAY_TYPES.filter((type) => !type.rest)
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

let uidSeq = 0
const uid = () => `wiz-${++uidSeq}`
const keyOf = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ')
const isRestName = (name) => matchDayType(name)?.rest === true
// The text field lists names separated by commas, so a name can't hold separators.
const cleanName = (name) => String(name || '').replace(/[,;/\\|+>→\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
const capitalise = (name) => name.charAt(0).toUpperCase() + name.slice(1)
const joinNames = (days) => days.map((day) => day.name).join(', ')
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const nameOf = (routine) => (typeof routine?.name === 'string' && routine.name.trim()) || 'Untitled routine'

const blank = () => ({ step: 0, text: '', days: [], mode: 'rotation', selected: null, custom: null, workouts: {}, anchor: 0, pickFor: null })

// The workouts in the days the plan uses (a weekly plan uses the first 7), in order of first
// appearance, each with its routine choice and colour. New workouts get their day type's colour
// unless another workout in the split already has it.
function derive({ days, mode, workouts, gym }) {
  const used = mode === 'weekly' ? days.slice(0, 7) : days
  const entries = []
  const byKey = new Map()
  used.forEach((day, index) => {
    if (isRestName(day.name)) return
    const key = keyOf(day.name)
    let entry = byKey.get(key)
    if (!entry) {
      const state = workouts[key] || null
      const sameName = gym.routines.find((routine) => keyOf(routine.name) === key) || null
      const choice = state ? state.choice : sameName ? sameName.id : 'new'
      const routine = choice === 'new' ? null : gym.routines.find((item) => item.id === choice) || null
      entry = { key, name: state?.name || day.name, state, sameName, routine, color: routine ? routine.color || 'none' : state?.color || null, positions: [] }
      byKey.set(key, entry)
      entries.push(entry)
    }
    entry.positions.push(index)
  })
  const taken = new Set(entries.map((entry) => entry.color).filter(Boolean))
  for (const entry of entries) {
    if (entry.color) continue
    const suggested = matchDayType(entry.name)?.color
    entry.color = suggested && !taken.has(suggested) ? suggested : ROUTINE_COLORS.find((color) => !taken.has(color.id))?.id || suggested || ROUTINE_COLORS[0].id
    taken.add(entry.color)
  }
  const workoutDays = entries.reduce((sum, entry) => sum + entry.positions.length, 0)
  // ids: Map(key → routine id) for new workouts.
  const slotsFor = (ids) => used.map((day) => {
    const entry = byKey.get(keyOf(day.name))
    if (!entry || isRestName(day.name)) return REST
    return { kind: 'routine', routineId: entry.routine ? entry.routine.id : ids.get(entry.key) }
  })
  return { used, entries, byKey, workoutDays, restDays: used.length - workoutDays, slotsFor }
}

const entryHex = (entry) => (entry.routine ? routineColor(entry.routine) : routineColor(entry.color))

// A weekly plan maps day 1 to the first day of the week. A rotation that starts tomorrow (today
// already has a workout) is anchored one slot back, so tomorrow is the chosen day.
function schedulePlan(slots, mode, anchor, firstWeekday, hasSessionToday) {
  if (mode === 'weekly') {
    const weekly = Array.from({ length: 7 }, () => REST)
    slots.slice(0, 7).forEach((slot, i) => { weekly[(firstWeekday + i) % 7] = slot })
    return { mode, cycle: [], weekly, anchorIndex: 0 }
  }
  const index = Math.min(Math.max(0, anchor), slots.length - 1)
  return { mode, cycle: slots, weekly: [], anchorIndex: hasSessionToday ? mod(index - 1, slots.length) : index }
}

function setsLabel(row) {
  const sets = Array.isArray(row.sets) ? row.sets : []
  const first = sets.find((set) => set.type !== 'warmup') || sets[0]
  if (!first) return 'No sets yet'
  const n = sets.length
  if (first.repsMin != null) return `${n} × ${first.repsMin}${first.repsMax != null && first.repsMax !== first.repsMin ? `–${first.repsMax}` : ''}`
  if (first.durationSec != null) {
    const sec = first.durationSec
    return `${n} × ${sec >= 120 && sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`}`
  }
  return plural(n, 'set')
}

export default function SplitWizard({ open, onClose, today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const hydrated = useStore((state) => state.hydrated)
  const [s, setS] = useState(blank)
  const [wasOpen, setWasOpen] = useState(open)
  const rootRef = useRef(null)
  const headingRef = useRef(null)
  const lastStep = useRef(0)
  const id = useId()

  // A fresh wizard each time it opens.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setS(blank())
  }

  const set = (patch) => setS((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }))

  const firstWeekday = gym.prefs.firstWeekday
  const weekOrder = Array.from({ length: 7 }, (_, i) => (firstWeekday + i) % 7)
  const hasSessionToday = useMemo(() => sessions.some((session) => session.date === today), [sessions, today])
  const plan = useMemo(() => derive({ days: s.days, mode: s.mode, workouts: s.workouts, gym }), [s.days, s.mode, s.workouts, gym])
  const rotation = s.mode === 'rotation'
  const anchor = Math.min(s.anchor, Math.max(0, s.days.length - 1))
  const full = rotation ? s.days.length >= MAX_DAYS : s.days.length >= 7

  const preview = useMemo(() => {
    if (!open || !plan.entries.length) return null
    try {
      const ids = new Map(plan.entries.map((entry) => [entry.key, `wiz:${entry.key}`]))
      const next = schedulePlan(plan.slotsFor(ids), s.mode, anchor, firstWeekday, hasSessionToday)
      const schedule = editSchedule(gym.schedule, next, today, hasSessionToday)
      const drafts = plan.entries.filter((entry) => !entry.routine).map((entry) => ({ id: `wiz:${entry.key}`, name: entry.name, color: entry.color, exercises: [] }))
      return resolveRange({ ...gym, schedule, routines: [...gym.routines, ...drafts] }, sessions, today, addDays(today, PREVIEW_DAYS - 1), today)
    } catch {
      return null
    }
  }, [open, plan, s.mode, anchor, firstWeekday, hasSessionToday, gym, sessions, today])

  // New step: back to the top, and focus its heading for screen readers.
  useEffect(() => {
    if (lastStep.current === s.step) return
    lastStep.current = s.step
    rootRef.current?.closest('.sheet-body')?.scrollTo({ top: 0 })
    headingRef.current?.focus({ preventScroll: true })
  }, [s.step])

  // ---- step 1: the days ------------------------------------------------------------------------

  const commitDays = (days, extra = {}) => set({ days, text: joinNames(days), ...extra })

  const onText = (value) => set((current) => {
    const names = parseSplit(value)
    const days = names.map((name, i) => ({ id: current.days[i]?.id ?? uid(), name }))
    return { text: value, days, selected: days.some((day) => day.id === current.selected) ? current.selected : null }
  })

  const clearAll = () => {
    const before = { text: s.text, days: s.days }
    set({ text: '', days: [], selected: null })
    if (before.days.length > 1) toast('Cleared your days', { action: { label: 'Undo', onClick: () => set(before) } })
  }

  const addDay = (name) => {
    if (full) return
    commitDays([...s.days, { id: uid(), name }])
  }

  const addCustom = (event) => {
    event.preventDefault()
    const name = cleanName(s.custom)
    if (!name) return
    addDay(capitalise(name))
    set({ custom: null })
  }

  const moveDay = (dayId, delta) => {
    const from = s.days.findIndex((day) => day.id === dayId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= s.days.length) return
    const days = s.days.slice()
    ;[days[from], days[to]] = [days[to], days[from]]
    commitDays(days)
  }

  const removeDay = (dayId) => commitDays(s.days.filter((day) => day.id !== dayId), { selected: null })

  // Weekly rows: value '' = Rest, a workout key already in the split, or 'type:<id>'.
  const namesInSplit = []
  const nameByKey = new Map()
  for (const day of s.days) {
    const key = keyOf(day.name)
    if (isRestName(day.name) || nameByKey.has(key)) continue
    nameByKey.set(key, day.name)
    namesInSplit.push(day.name)
  }
  const otherTypes = WORKOUT_TYPES.filter((type) => !nameByKey.has(keyOf(type.name)))

  const setWeekday = (index, value) => {
    const name = !value ? 'Rest' : value.startsWith('type:') ? DAY_TYPES.find((type) => `type:${type.id}` === value)?.name : nameByKey.get(value)
    if (!name) return
    const days = s.days.slice()
    while (days.length <= index) days.push({ id: uid(), name: 'Rest' })
    days[index] = { ...days[index], name }
    commitDays(days)
  }

  // ---- step 2: workouts ------------------------------------------------------------------------

  // Workout state for every training day that doesn't have one yet (kept when going back).
  const ensureWorkouts = (current) => {
    const derived = derive({ days: current.days, mode: current.mode, workouts: current.workouts, gym: getGym() })
    const workouts = { ...current.workouts }
    for (const entry of derived.entries) {
      if (workouts[entry.key]) continue
      workouts[entry.key] = {
        id: uid(),
        name: entry.name,
        choice: entry.routine ? entry.routine.id : 'new',
        color: entry.routine ? null : entry.color,
        rows: dayTemplate(entry.name, newGymId).map((row) => ({ row, on: true })),
        touched: false,
      }
    }
    return workouts
  }

  const updateWorkout = (key, fn) => set((current) => {
    const workout = current.workouts[key]
    return workout ? { workouts: { ...current.workouts, [key]: { ...workout, ...fn(workout) } } } : {}
  })

  // Returns an error message, or null once the name is taken on.
  const renameWorkout = (oldKey, raw) => {
    const name = cleanName(raw)
    if (!name) return 'Give this workout a name.'
    if (isRestName(name)) return 'That reads as a rest day. Try another name.'
    const newKey = keyOf(name)
    if (newKey !== oldKey && plan.byKey.has(newKey)) return 'Another day in your split already has this name.'
    set((current) => {
      const workout = current.workouts[oldKey]
      if (!workout) return {}
      const workouts = { ...current.workouts }
      delete workouts[oldKey]
      workouts[newKey] = {
        ...workout,
        name,
        rows: workout.touched ? workout.rows : dayTemplate(name, newGymId).map((row) => ({ row, on: true })),
      }
      const days = current.days.map((day) => (keyOf(day.name) === oldKey ? { ...day, name } : day))
      return { workouts, days, text: joinNames(days) }
    })
    return null
  }

  const addExercises = (key, entries) => updateWorkout(key, (workout) => ({
    rows: [...workout.rows, ...entries.map((entry) => ({ row: newRoutineExercise(entry, newGymId), on: true }))],
    touched: true,
  }))

  // ---- navigation & create ---------------------------------------------------------------------

  const hasDays = s.days.length > 0
  const dirty = hasDays || s.text.trim() !== ''

  const requestClose = async () => {
    if (dirty && !(await confirmAction({ title: 'Discard this split?', message: 'Nothing has been saved yet.', confirmLabel: 'Discard' }))) return
    onClose()
  }

  let hint = null
  if (s.step === 0) {
    if (!hasDays) hint = 'Type your split or tap the days, in order.'
    else if (!plan.entries.length) hint = rotation || s.days.length <= 7 ? 'Add at least one training day.' : 'Your first 7 days are all rest.'
  } else if (s.step === 2 && !hydrated) {
    hint = 'Still loading your plan…'
  }
  const canNext = s.step === 0 ? plan.entries.length > 0 : s.step === 2 ? hydrated && plan.entries.length > 0 : true

  const next = () => {
    if (!canNext) return
    if (s.step === 0) set((current) => ({ workouts: ensureWorkouts(current), step: 1, selected: null, custom: null }))
    else if (s.step === 1) set({ step: 2 })
    else create()
  }

  const back = () => set((current) => ({ step: Math.max(0, current.step - 1) }))

  function create() {
    const gymNow = getGym()
    const current = derive({ days: s.days, mode: s.mode, workouts: s.workouts, gym: gymNow })
    const ids = new Map()
    const created = []
    let undoSchedule = null
    try {
      for (const entry of current.entries) {
        if (entry.routine) continue
        const workout = s.workouts[entry.key]
        const saved = saveRoutine({
          id: newGymId(),
          name: entry.name,
          color: entry.color,
          notes: '',
          folderId: null,
          exercises: (workout?.rows || []).filter((item) => item.on).map((item) => item.row),
        })
        created.push(saved.id)
        ids.set(entry.key, saved.id)
      }
      undoSchedule = saveSchedule(schedulePlan(current.slotsFor(ids), s.mode, anchor, gymNow.prefs.firstWeekday, hasSessionToday))
    } catch (error) {
      if (created.length) updateGym((gymLatest) => ({ routines: gymLatest.routines.filter((routine) => !created.includes(routine.id)) }))
      toast(error?.message || 'Couldn’t create the split.', { tone: 'error' })
      return
    }
    onClose()
    toast(`Your split is ready${created.length ? ` · ${plural(created.length, 'new routine')}` : ''}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          undoSchedule?.()
          if (created.length) updateGym((gymLatest) => ({ routines: gymLatest.routines.filter((routine) => !created.includes(routine.id)) }))
        },
      },
    })
  }

  // ---- render ----------------------------------------------------------------------------------

  const dayHex = (day) => {
    if (isRestName(day.name)) return null
    const entry = plan.byKey.get(keyOf(day.name))
    return entry ? entryHex(entry) : routineColor(matchDayType(day.name)?.color)
  }
  const selectedIndex = s.days.findIndex((day) => day.id === s.selected)
  const counts = rotation
    ? hasDays ? `${plural(s.days.length, 'day')} · ${plural(plan.workoutDays, 'workout')}` : ''
    : `${plural(plan.workoutDays, 'workout')} a week`
  const pickWorkout = s.pickFor ? s.workouts[s.pickFor] : null

  const description = (
    <span className="wiz-progress">
      <span className="wiz-progress-label">Step {s.step + 1} of {STEPS.length} · {STEPS[s.step]}</span>
      <span className="wiz-progress-bar" aria-hidden="true">
        {STEPS.map((label, index) => <span key={label} className={index <= s.step ? 'is-on' : undefined} />)}
      </span>
    </span>
  )

  return (
    <>
      <Sheet
        open={open}
        onClose={requestClose}
        title="Build your split"
        description={description}
        size="lg"
        initialFocus={false}
        footer={(
          <>
            {hint && <p className="wiz-foot-hint">{hint}</p>}
            <button type="button" className="btn btn-secondary btn-grow" onClick={s.step ? back : requestClose}>
              {s.step ? 'Back' : 'Cancel'}
            </button>
            <button type="button" className="btn btn-primary btn-grow" onClick={next} disabled={!canNext}>
              {s.step === 2 ? 'Create split' : 'Next'}
            </button>
          </>
        )}
      >
        <div className="wiz" ref={rootRef}>
          <h3 className="sr-only" tabIndex={-1} ref={headingRef}>{STEPS[s.step]}</h3>

          {s.step === 0 && (
            <div className="wiz-step">
              <section className="wiz-section">
                <label className="wiz-label" htmlFor={`${id}-text`}>Type it</label>
                <div className="wiz-type">
                  <Icon name="wand" size={18} className="wiz-type-icon" />
                  <input
                    id={`${id}-text`}
                    className="wiz-input"
                    value={s.text}
                    onChange={(event) => onText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      }
                    }}
                    placeholder="push pull shoulders legs rest rest"
                    maxLength={300}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    aria-describedby={`${id}-text-help`}
                  />
                  {(s.text || hasDays) && (
                    <button type="button" className="wiz-clear" onClick={clearAll} aria-label="Clear all days">
                      <Icon name="close" size={14} strokeWidth={2.6} />
                    </button>
                  )}
                </div>
                {!s.text && !hasDays ? (
                  <div className="wiz-examples" id={`${id}-text-help`}>
                    <span className="wiz-examples-label">Try</span>
                    {EXAMPLES.map((example) => (
                      <button key={example} type="button" className="wiz-example" onClick={() => onText(example)}>{example}</button>
                    ))}
                  </div>
                ) : (
                  <p className="wiz-help" id={`${id}-text-help`}>Spaces or commas between days. “x2” repeats, “&amp;” joins (legs &amp; abs).</p>
                )}
              </section>

              <section className="wiz-section" aria-labelledby={`${id}-days`}>
                <div className="wiz-section-head">
                  <h3 className="wiz-label" id={`${id}-days`}>{rotation ? 'Your days, in order' : 'Your week'}</h3>
                  <span className="wiz-counts" aria-live="polite">{counts}</span>
                </div>
                {rotation ? (
                  <>
                    {hasDays ? (
                      <ol className="wiz-seq">
                        {s.days.map((day, index) => {
                          const hex = dayHex(day)
                          const selected = day.id === s.selected
                          return (
                            <li key={day.id}>
                              <button
                                type="button"
                                className={`wiz-day${hex ? '' : ' is-rest'}${selected ? ' is-selected' : ''}`}
                                style={hex ? { '--wiz-c': hex } : undefined}
                                aria-pressed={selected}
                                aria-label={`Day ${index + 1}: ${day.name}`}
                                onClick={() => set({ selected: selected ? null : day.id })}
                              >
                                <span className="wiz-day-num" aria-hidden="true">{index + 1}</span>
                                <span className="wiz-day-name">{day.name}</span>
                              </button>
                            </li>
                          )
                        })}
                        <li className="wiz-seq-loop" aria-hidden="true" title="Then it starts again">
                          <Icon name="repeat" size={16} />
                        </li>
                      </ol>
                    ) : (
                      <p className="wiz-empty">No days yet. Type your split above, or tap days below in the order you train.</p>
                    )}
                    {selectedIndex >= 0 ? (
                      <div className="wiz-dayactions" role="toolbar" aria-label={`Day ${selectedIndex + 1}: ${s.days[selectedIndex].name}`}>
                        <button type="button" onClick={() => moveDay(s.selected, -1)} disabled={selectedIndex === 0}>
                          <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
                          Earlier
                        </button>
                        <button type="button" onClick={() => moveDay(s.selected, 1)} disabled={selectedIndex === s.days.length - 1}>
                          Later
                          <Icon name="chevronRight" size={18} strokeWidth={2.2} />
                        </button>
                        <button type="button" className="is-danger" onClick={() => removeDay(s.selected)}>
                          <Icon name="trash" size={17} />
                          Remove
                        </button>
                      </div>
                    ) : hasDays && s.days.length > 1 ? (
                      <p className="wiz-help">Tap a day to move or remove it.</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <ul className="wiz-week">
                      {weekOrder.map((weekdayIndex, index) => {
                        const day = s.days[index]
                        const rest = !day || isRestName(day.name)
                        const hex = rest ? null : dayHex(day)
                        const isToday = weekdayIndex === weekday(today)
                        return (
                          <li key={weekdayIndex} className={`wiz-week-row${isToday ? ' is-today' : ''}`}>
                            <span className="wiz-week-dow" aria-hidden="true">{WEEKDAY_SHORT[weekdayIndex]}</span>
                            <span className="wiz-week-pick" style={hex ? { '--wiz-c': hex } : undefined}>
                              <span className={rest ? 'wiz-week-rest' : 'wiz-week-dot'} aria-hidden="true" />
                              <select
                                className="input wiz-select"
                                value={rest ? '' : keyOf(day.name)}
                                aria-label={`${WEEKDAY_LONG[weekdayIndex]}${isToday ? ' (today)' : ''}`}
                                onChange={(event) => setWeekday(index, event.target.value)}
                              >
                                <option value="">Rest</option>
                                {namesInSplit.map((name) => <option key={keyOf(name)} value={keyOf(name)}>{name}</option>)}
                                {otherTypes.length > 0 && (
                                  <optgroup label="Add a day">
                                    {otherTypes.map((type) => <option key={type.id} value={`type:${type.id}`}>{type.name}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            </span>
                            {isToday && <span className="wiz-week-today" aria-hidden="true">Today</span>}
                          </li>
                        )
                      })}
                    </ul>
                    {s.days.length > 7 && (
                      <p className="wiz-warn">
                        <Icon name="info" size={16} />
                        <span>
                          A week has 7 days, so {s.days.length === 8 ? 'day 8 isn’t' : `days 8–${s.days.length} aren’t`} used.{' '}
                          <button type="button" className="link-btn" onClick={() => commitDays(s.days.slice(0, 7))}>Remove</button>
                        </span>
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className="wiz-section" aria-labelledby={`${id}-palette`}>
                <h3 className="wiz-label" id={`${id}-palette`}>{rotation ? 'Tap to add a day' : 'Add the next day'}</h3>
                <div className="wiz-palette">
                  {DAY_TYPES.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      className={`wiz-pal${type.rest ? ' is-rest' : ''}`}
                      style={type.color ? { '--wiz-c': routineColor(type.color) } : undefined}
                      onClick={() => addDay(type.name)}
                      disabled={full}
                      title={type.hint}
                    >
                      <span className="wiz-pal-dot" aria-hidden="true" />
                      {type.name}
                    </button>
                  ))}
                  <button type="button" className="wiz-pal is-custom" onClick={() => set({ custom: '' })} disabled={full} aria-expanded={s.custom !== null}>
                    <Icon name="plus" size={16} strokeWidth={2.4} />
                    Custom…
                  </button>
                </div>
                {s.custom !== null && !full && (
                  <form className="wiz-custom" onSubmit={addCustom}>
                    <input
                      className="input wiz-custom-input"
                      value={s.custom}
                      onChange={(event) => set({ custom: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          set({ custom: null })
                        }
                      }}
                      placeholder="e.g. Arms & Abs, Yoga"
                      aria-label="Custom day name"
                      maxLength={MAX_NAME}
                      autoFocus
                      autoComplete="off"
                      autoCapitalize="words"
                      enterKeyHint="done"
                    />
                    <button type="submit" className="btn btn-primary btn-sm" disabled={!cleanName(s.custom)}>Add</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ custom: null })}>Cancel</button>
                  </form>
                )}
                {full && (
                  <p className="wiz-help">{rotation ? 'A rotation can have up to 31 days.' : 'Your week is full. Change a day above.'}</p>
                )}
              </section>

              <section className="wiz-section" aria-labelledby={`${id}-mode`}>
                <h3 className="wiz-label" id={`${id}-mode`}>How it repeats</h3>
                <div className="wiz-modes" role="radiogroup" aria-labelledby={`${id}-mode`}>
                  <ModeOption
                    checked={rotation}
                    icon="repeat"
                    title="Repeat in order"
                    text={s.days.length > 1 ? `Day 1 to ${s.days.length}, then back to day 1, whatever the weekday.` : 'Your days in a loop, whatever the weekday.'}
                    onClick={() => set({ mode: 'rotation' })}
                  />
                  <ModeOption
                    checked={!rotation}
                    icon="calendar"
                    title="Same days each week"
                    text={`Day 1 is ${WEEKDAY_LONG[weekOrder[0]]}, day 2 ${WEEKDAY_LONG[weekOrder[1]]}, and so on.`}
                    onClick={() => set({ mode: 'weekly', selected: null })}
                  />
                </div>
              </section>

              <PreviewSection id={`${id}-preview`} preview={preview} today={today} />
            </div>
          )}

          {s.step === 1 && (
            <div className="wiz-step">
              <p className="wiz-intro">
                {plan.entries.length === 1 ? 'One workout' : `${plan.entries.length} workouts`} in your split. We’ve suggested exercises for each: untick what you don’t want or add your own. You can change everything later.
              </p>
              {plan.entries.map((entry) => {
                const workout = s.workouts[entry.key]
                if (!workout) return null
                const when = rotation
                  ? entry.positions.length > 3 ? `${entry.positions.length} days` : entry.positions.map((index) => `Day ${index + 1}`).join(' · ')
                  : entry.positions.map((index) => WEEKDAY_SHORT[weekOrder[index]]).join(' · ')
                return (
                  <WorkoutCard
                    key={workout.id}
                    entry={entry}
                    workout={workout}
                    routines={gym.routines}
                    when={when}
                    onRename={(name) => renameWorkout(entry.key, name)}
                    onChoice={(choice) => updateWorkout(entry.key, () => ({ choice }))}
                    onColor={(color) => updateWorkout(entry.key, () => ({ color }))}
                    onToggle={(rowId) => updateWorkout(entry.key, (current) => ({
                      rows: current.rows.map((item) => (item.row.id === rowId ? { ...item, on: !item.on } : item)),
                      touched: true,
                    }))}
                    onAdd={() => set({ pickFor: entry.key })}
                  />
                )
              })}
            </div>
          )}

          {s.step === 2 && (
            <div className="wiz-step">
              {rotation && (
                <section className="wiz-section" aria-labelledby={`${id}-anchor`}>
                  <h3 className="wiz-label" id={`${id}-anchor`}>{hasSessionToday ? 'Tomorrow is' : 'Today is'}</h3>
                  <div className="wiz-anchor" role="radiogroup" aria-labelledby={`${id}-anchor`}>
                    {s.days.map((day, index) => {
                      const hex = dayHex(day)
                      return (
                        <button
                          key={day.id}
                          type="button"
                          role="radio"
                          aria-checked={index === anchor}
                          aria-label={`Day ${index + 1}: ${day.name}`}
                          className={`wiz-day${hex ? '' : ' is-rest'}${index === anchor ? ' is-selected' : ''}`}
                          style={hex ? { '--wiz-c': hex } : undefined}
                          onClick={() => set({ anchor: index })}
                        >
                          <span className="wiz-day-num" aria-hidden="true">{index + 1}</span>
                          <span className="wiz-day-name">{day.name}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="wiz-help">
                    {hasSessionToday
                      ? 'You’ve already trained today, so the new plan starts tomorrow with this day.'
                      : 'Pick where you are in the split. Usually day 1.'}
                  </p>
                </section>
              )}

              <PreviewSection id={`${id}-preview2`} preview={preview} today={today} />

              <section className="wiz-section" aria-labelledby={`${id}-summary`}>
                <h3 className="wiz-label" id={`${id}-summary`}>Summary</h3>
                <ul className="wiz-summary">
                  <li>
                    <span className="wiz-summary-icon" aria-hidden="true"><Icon name={rotation ? 'repeat' : 'calendar'} size={17} /></span>
                    <span className="wiz-summary-text">
                      <strong>{rotation ? `${s.days.length}-day rotation` : 'Same days each week'}</strong>
                      <small>
                        {rotation
                          ? `${plural(plan.workoutDays, 'workout')} and ${plural(plan.restDays, 'rest day')}, then it repeats`
                          : `${plural(plan.workoutDays, 'workout')} and ${plural(7 - plan.workoutDays, 'rest day')} a week`}
                      </small>
                    </span>
                  </li>
                  <SummaryRoutines
                    icon="plusCircle"
                    title="New routines"
                    entries={plan.entries.filter((entry) => !entry.routine)}
                    sub={(list) => {
                      const total = list.reduce((sum, entry) => sum + (s.workouts[entry.key]?.rows.filter((item) => item.on).length || 0), 0)
                      return `${plural(total, 'exercise')} in total`
                    }}
                  />
                  <SummaryRoutines
                    icon="dumbbell"
                    title="Your routines"
                    entries={plan.entries.filter((entry) => entry.routine)}
                    sub={() => 'Used as they are'}
                  />
                  <li>
                    <span className="wiz-summary-icon" aria-hidden="true"><Icon name="calendarCheck" size={17} /></span>
                    <span className="wiz-summary-text">
                      <strong>Starts {hasSessionToday ? 'tomorrow' : 'today'}</strong>
                      <small>
                        {gym.schedule.versions.length
                          ? 'Replaces your current schedule from then on. Past days keep their history.'
                          : 'Your schedule shows what’s next every day.'}
                      </small>
                    </span>
                  </li>
                </ul>
              </section>
            </div>
          )}
        </div>
      </Sheet>

      <ExercisePicker
        open={!!pickWorkout}
        onClose={() => set({ pickFor: null })}
        onPick={(entries) => {
          if (s.pickFor) addExercises(s.pickFor, entries)
        }}
        title={pickWorkout ? `Add to ${pickWorkout.name}` : 'Add exercises'}
        excludeIds={pickWorkout ? pickWorkout.rows.map((item) => item.row.exerciseId) : []}
      />
    </>
  )
}

function ModeOption({ checked, icon, title, text, onClick }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={`wiz-mode${checked ? ' is-on' : ''}`} onClick={onClick}>
      <span className="wiz-mode-radio" aria-hidden="true" />
      <span className="wiz-mode-text">
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <Icon name={icon} size={20} className="wiz-mode-icon" />
    </button>
  )
}

function SummaryRoutines({ icon, title, entries, sub }) {
  if (!entries.length) return null
  return (
    <li>
      <span className="wiz-summary-icon" aria-hidden="true"><Icon name={icon} size={17} /></span>
      <span className="wiz-summary-text">
        <strong>{title}</strong>
        <span className="wiz-summary-chips">
          {entries.map((entry) => (
            <span key={entry.key} className="wiz-tag" style={{ '--wiz-c': entryHex(entry) }}>
              <span className="wiz-tag-dot" aria-hidden="true" />
              {entry.routine ? nameOf(entry.routine) : entry.name}
            </span>
          ))}
        </span>
        <small>{sub(entries)}</small>
      </span>
    </li>
  )
}

function WorkoutCard({ entry, workout, routines, when, onRename, onChoice, onColor, onToggle, onAdd }) {
  const [draft, setDraft] = useState(workout.name)
  const [error, setError] = useState(null)
  const nameId = useId()
  const isNew = !entry.routine
  const rowsOn = workout.rows.filter((item) => item.on)
  const minutes = estimateMinutes({ exercises: rowsOn.map((item) => item.row) })
  const existingNames = entry.routine ? entry.routine.exercises.map((row) => (typeof row.name === 'string' ? row.name.trim() : '')).filter(Boolean) : []

  // Outside edits (e.g. the day renamed back in step 1) show up while the field isn't being typed in.
  useEffect(() => {
    if (document.activeElement?.id !== nameId) setDraft(workout.name)
  }, [workout.name, nameId])

  return (
    <article className="wiz-wo" style={{ '--wiz-c': entryHex(entry) }} aria-labelledby={`${nameId}-title`}>
      <div className="wiz-wo-head">
        <span className="wiz-wo-dot" aria-hidden="true" />
        {isNew ? (
          <input
            id={nameId}
            className="wiz-wo-name"
            value={draft}
            aria-label="Workout name"
            aria-invalid={error ? 'true' : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(onRename(event.target.value))
            }}
            onBlur={() => {
              setDraft(workout.name)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            maxLength={MAX_NAME}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="done"
          />
        ) : (
          <h4 className="wiz-wo-title">{nameOf(entry.routine)}</h4>
        )}
        <span className="wiz-wo-when" id={`${nameId}-title`}>
          <span className="sr-only">{isNew ? draft : nameOf(entry.routine)}, </span>
          {when}
        </span>
      </div>
      {error && <p className="wiz-wo-error" role="alert">{error}</p>}

      {routines.length > 0 && (
        <label className="wiz-wo-choice">
          <span>Routine</span>
          <select className="input wiz-select" value={isNew ? 'new' : entry.routine.id} onChange={(event) => onChoice(event.target.value)}>
            <option value="new">New routine</option>
            <optgroup label="Use one of yours">
              {routines.map((routine) => <option key={routine.id} value={routine.id}>{nameOf(routine)}</option>)}
            </optgroup>
          </select>
        </label>
      )}

      {isNew ? (
        <>
          {entry.sameName && (
            <p className="wiz-help">You already have a routine called {nameOf(entry.sameName)}. Pick it above to use it instead.</p>
          )}
          <div className="wiz-swatches" role="radiogroup" aria-label={`Colour for ${workout.name}`}>
            {ROUTINE_COLORS.map((color) => {
              const checked = entry.color === color.id
              return (
                <button
                  key={color.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={color.label}
                  title={color.label}
                  className="wiz-swatch"
                  style={{ '--wiz-sw': color.value }}
                  onClick={() => onColor(color.id)}
                >
                  <span className="wiz-swatch-dot"><Icon name="check" size={14} strokeWidth={3} /></span>
                </button>
              )
            })}
          </div>
          {workout.rows.length > 0 ? (
            <ul className="wiz-ex-list" aria-label={`Exercises for ${workout.name}`}>
              {workout.rows.map((item) => (
                <li key={item.row.id}>
                  <button type="button" role="checkbox" aria-checked={item.on} className={`wiz-ex${item.on ? '' : ' is-off'}`} onClick={() => onToggle(item.row.id)}>
                    <span className="wiz-ex-check" aria-hidden="true"><Icon name="check" size={14} strokeWidth={3} /></span>
                    <span className="wiz-ex-text">
                      <span className="wiz-ex-name">{item.row.name}</span>
                      <span className="wiz-ex-sets">{setsLabel(item.row)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wiz-empty">No suggestions for “{workout.name}”. Add exercises now, or later from Routines.</p>
          )}
          <div className="wiz-wo-foot">
            <button type="button" className="wiz-add-ex" onClick={onAdd}>
              <Icon name="plus" size={17} strokeWidth={2.4} />
              Add exercises
            </button>
            <span className="wiz-wo-sum">
              {plural(rowsOn.length, 'exercise')}{minutes ? ` · ~${minutes} min` : ''}
            </span>
          </div>
        </>
      ) : (
        <div className="wiz-wo-existing">
          <p className="wiz-wo-sum">
            {plural(entry.routine.exercises.length, 'exercise')}
            {estimateMinutes(entry.routine) ? ` · ~${estimateMinutes(entry.routine)} min` : ''}
          </p>
          {existingNames.length > 0 && (
            <p className="wiz-wo-preview">{existingNames.slice(0, 4).join(', ')}{existingNames.length > 4 ? ` +${existingNames.length - 4} more` : ''}</p>
          )}
          <p className="wiz-help">Used as it is. Edit it any time from Routines.</p>
        </div>
      )}
    </article>
  )
}

function PreviewSection({ id, preview, today }) {
  return (
    <section className="wiz-section" aria-labelledby={id}>
      <h3 className="wiz-label" id={id}>Next two weeks</h3>
      {preview ? (
        <ol className="wiz-strip">
          {preview.map((day) => <PreviewDay key={day.date} day={day} today={today} />)}
        </ol>
      ) : (
        <p className="wiz-empty">Add a training day to see your next two weeks.</p>
      )}
    </section>
  )
}

function PreviewDay({ day, today }) {
  const isToday = day.date === today
  const session = day.sessions[0] || null
  let label
  let hex = null
  let tone = ''
  if (day.status === 'done') {
    label = (typeof session?.name === 'string' && session.name.trim()) || 'Workout'
    tone = 'is-done'
  } else if (day.status === 'shifted') {
    label = 'Shifted'
    tone = 'is-muted'
  } else if (day.shown.kind === 'rest') {
    label = 'Rest'
    tone = 'is-rest'
  } else if (day.shown.kind === 'routine') {
    label = day.routine ? nameOf(day.routine) : 'Deleted'
    hex = day.routine ? routineColor(day.routine) : null
    tone = day.status === 'skipped' ? 'is-skipped' : day.routine ? '' : 'is-muted'
  } else {
    label = 'No plan'
    tone = 'is-muted'
  }
  const date = Number(day.date.slice(8, 10))
  const dow = WEEKDAY_SHORT[weekday(day.date)]
  const status = day.status === 'done' ? ', done' : day.status === 'skipped' ? ', skipped' : ''
  return (
    <li className={`wiz-strip-day${isToday ? ' is-today' : ''}`} aria-label={`${isToday ? 'Today' : dow} ${date}: ${label}${status}`}>
      <span className="wiz-strip-dow" aria-hidden="true">{isToday ? 'Today' : dow}</span>
      <span className="wiz-strip-date" aria-hidden="true">{date}</span>
      <span className={`wiz-strip-slot ${tone}`} style={hex && !tone ? { '--wiz-c': hex } : undefined} title={label} aria-hidden="true">
        {day.status === 'done' && <Icon name="check" size={11} strokeWidth={3} />}
        <span>{label}</span>
      </span>
    </li>
  )
}

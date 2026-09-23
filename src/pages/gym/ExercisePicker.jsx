import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { EQUIPMENT, MUSCLES, exerciseById, searchExercises } from '../../lib/gym/library.js'
import { useGym, useGymSessions } from '../../lib/gym/state.js'
import CustomExerciseSheet from './CustomExerciseSheet.jsx'
import './exercises.css'

// ---- shared by the Exercises tab and the picker ---------------------------------------------

const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))
const EQUIPMENT_LABEL = Object.fromEntries(EQUIPMENT.map((item) => [item.id, item.label]))

export const muscleLabel = (id) => MUSCLE_LABEL[id] || 'Other'
export const equipmentLabel = (id) => EQUIPMENT_LABEL[id] || 'Other'

// Per sessions array (sorted newest first by useGymSessions): how many workouts used each
// exercise, and exercise ids in most-recently-used order. Cached per array identity.
const usageCache = new WeakMap()

export function exerciseUsage(sessions) {
  if (Array.isArray(sessions) && usageCache.has(sessions)) return usageCache.get(sessions)
  const counts = new Map()
  const recentIds = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const seen = new Set()
    for (const exercise of Array.isArray(session?.exercises) ? session.exercises : []) {
      const id = exercise?.exerciseId
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      counts.set(id, (counts.get(id) || 0) + 1)
      if (counts.get(id) === 1) recentIds.push(id)
    }
  }
  const usage = { counts, recentIds }
  if (Array.isArray(sessions)) usageCache.set(sessions, usage)
  return usage
}

// Last `limit` distinct exercises that still exist and aren't hidden.
export function recentExercises(usage, customExercises, limit = 8) {
  const out = []
  for (const id of usage.recentIds) {
    const entry = exerciseById(id, customExercises)
    if (entry && !entry.hidden) out.push(entry)
    if (out.length >= limit) break
  }
  return out
}

function letterOf(name) {
  const first = String(name || '').trim().normalize('NFD').charAt(0).toUpperCase()
  return /[A-Z]/.test(first) ? first : '#'
}

// [{ letter, items }] A–Z, '#' (digits, symbols) last. Keeps the incoming order inside a letter.
export function groupByLetter(list) {
  const groups = new Map()
  for (const entry of list) {
    const letter = letterOf(entry.name)
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push(entry)
  }
  return [...groups.keys()]
    .sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
    .map((letter) => ({ letter, items: groups.get(letter) }))
}

export function ExerciseFilters({ query, onQuery, muscle, onMuscle, equipment, onEquipment, trailing, onSubmit }) {
  const inputRef = useRef(null)
  return (
    <div className="gym-lib-filters">
      <div className="gym-lib-search-row">
        <div className="search-field gym-lib-search" onClick={() => inputRef.current?.focus()}>
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (onSubmit) onSubmit()
                else event.currentTarget.blur()
              }
            }}
            placeholder="Search exercises"
            aria-label="Search exercises"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="gym-lib-clear"
              onClick={(event) => {
                event.stopPropagation()
                onQuery('')
                inputRef.current?.focus()
              }}
              aria-label="Clear search"
            >
              <Icon name="close" size={13} strokeWidth={2.6} />
            </button>
          )}
        </div>
        {trailing}
      </div>
      <div className="gym-lib-filter-row">
        <label className={`gym-lib-select${equipment ? ' is-active' : ''}`}>
          <span className="sr-only">Equipment</span>
          <select value={equipment} onChange={(event) => onEquipment(event.target.value)}>
            <option value="">All equipment</option>
            {EQUIPMENT.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <Icon name="chevronDown" size={14} />
        </label>
        <div className="gym-lib-chips" role="group" aria-label="Filter by muscle">
          <button type="button" className={`chip chip-sm${muscle ? '' : ' is-active'}`} aria-pressed={!muscle} onClick={() => onMuscle('')}>
            All muscles
          </button>
          {MUSCLES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip chip-sm${muscle === item.id ? ' is-active' : ''}`}
              aria-pressed={muscle === item.id}
              onClick={() => onMuscle(muscle === item.id ? '' : item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// Row internals: initial, name (+ Custom tag), primary muscle · equipment, times performed.
export function ExerciseRowBody({ exercise, count = 0 }) {
  return (
    <>
      <span className="gym-lib-avatar" aria-hidden="true">{letterOf(exercise.name)}</span>
      <span className="gym-lib-text">
        <span className="gym-lib-name">
          <span className="gym-lib-name-text">{exercise.name}</span>
          {exercise.custom && <span className="gym-lib-tag">Custom</span>}
        </span>
        <span className="gym-lib-sub">{muscleLabel(exercise.primary)} · {equipmentLabel(exercise.equipment)}</span>
      </span>
      {count > 0 && (
        <span className="gym-lib-count">
          <span aria-hidden="true">{count}×</span>
          <span className="sr-only">, done {count} time{count === 1 ? '' : 's'}</span>
        </span>
      )}
    </>
  )
}

// ---- picker ----------------------------------------------------------------------------------

export default function ExercisePicker({ open, onClose, onPick, multi = true, title = 'Add exercises', excludeIds = [] }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const [query, setQuery] = useState('')
  const [muscle, setMuscle] = useState('')
  const [equipment, setEquipment] = useState('')
  const [selected, setSelected] = useState([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setMuscle('')
    setEquipment('')
    setSelected([])
    setCreating(false)
  }, [open])

  const excludeKey = Array.isArray(excludeIds) ? excludeIds.join('\u0000') : ''
  const excluded = useMemo(() => new Set(excludeKey ? excludeKey.split('\u0000') : []), [excludeKey])
  const usage = exerciseUsage(sessions)
  const trimmed = query.trim()
  const filtering = Boolean(trimmed || muscle || equipment)

  const results = useMemo(
    () => (open ? searchExercises(trimmed, { muscle, equipment, customExercises: gym.exercises }) : []),
    [open, trimmed, muscle, equipment, gym.exercises],
  )
  const recent = useMemo(
    () => (open && !filtering ? recentExercises(usage, gym.exercises, 8) : []),
    [open, filtering, usage, gym.exercises],
  )
  const groups = useMemo(() => (trimmed ? null : groupByLetter(results)), [results, trimmed])

  const finish = (entries) => {
    if (!entries.length) return
    onPick?.(entries)
    onClose?.()
  }

  const choose = (exercise) => {
    if (excluded.has(exercise.id)) return
    if (!multi) {
      finish([exercise])
      return
    }
    setSelected((list) => (list.includes(exercise.id) ? list.filter((id) => id !== exercise.id) : [...list, exercise.id]))
  }

  const confirm = () => finish(selected.map((id) => exerciseById(id, gym.exercises)).filter(Boolean))

  const onCreated = (entry) => {
    if (!entry) return
    if (!multi) {
      finish([entry])
      return
    }
    setSelected((list) => (list.includes(entry.id) ? list : [...list, entry.id]))
    setQuery('')
    setMuscle('')
    setEquipment('')
  }

  const row = (exercise) => {
    const isExcluded = excluded.has(exercise.id)
    const order = selected.indexOf(exercise.id)
    const isSelected = order >= 0
    return (
      <li key={exercise.id}>
        <button
          type="button"
          className={`gym-lib-row gym-pk-row${isSelected ? ' is-selected' : ''}`}
          disabled={isExcluded}
          aria-pressed={multi && !isExcluded ? isSelected : undefined}
          onClick={() => choose(exercise)}
        >
          <ExerciseRowBody exercise={exercise} count={usage.counts.get(exercise.id) || 0} />
          {isExcluded ? (
            <span className="gym-pk-added">{multi ? 'Added' : 'Current'}</span>
          ) : multi ? (
            <span className={`gym-pk-check${isSelected ? ' is-on' : ''}`} aria-hidden="true">
              {isSelected ? order + 1 : ''}
            </span>
          ) : (
            <Icon name="plus" size={18} className="gym-pk-plus" />
          )}
        </button>
      </li>
    )
  }

  const count = selected.length

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={title}
        size="lg"
        footer={multi ? (
          <Button className="btn-block btn-lg" icon={count ? 'plus' : undefined} disabled={!count} onClick={confirm}>
            {count ? `Add ${count} exercise${count === 1 ? '' : 's'}` : 'Select exercises'}
          </Button>
        ) : null}
      >
        <div className="gym-pk">
          <div className="gym-pk-head">
            <ExerciseFilters
              query={query}
              onQuery={setQuery}
              muscle={muscle}
              onMuscle={setMuscle}
              equipment={equipment}
              onEquipment={setEquipment}
              onSubmit={!multi && trimmed && results.length ? () => choose(results[0]) : undefined}
            />
          </div>

          <button type="button" className="gym-pk-create" onClick={() => setCreating(true)}>
            <span className="gym-pk-create-icon"><Icon name="plus" size={18} /></span>
            <span className="gym-pk-create-text">
              {trimmed ? <>Create “{trimmed}”</> : 'Create custom exercise'}
            </span>
          </button>

          {!results.length ? (
            <div className="gym-lib-none">
              <p><strong>No exercises found</strong></p>
              <p className="muted">Try another name, clear the filters or create your own.</p>
              {(muscle || equipment) && (
                <button type="button" className="link-btn" onClick={() => { setMuscle(''); setEquipment('') }}>Clear filters</button>
              )}
            </div>
          ) : (
            <>
              {recent.length > 0 && (
                <section className="gym-pk-section" aria-label="Recent">
                  <h3 className="gym-pk-letter">Recent</h3>
                  <ul className="card-list gym-lib-list">{recent.map(row)}</ul>
                </section>
              )}
              {groups ? groups.map((group) => (
                <section key={group.letter} className="gym-pk-section" aria-label={group.letter}>
                  <h3 className="gym-pk-letter">{group.letter}</h3>
                  <ul className="card-list gym-lib-list">{group.items.map(row)}</ul>
                </section>
              )) : (
                <section className="gym-pk-section" aria-label="Results">
                  <h3 className="gym-pk-letter">{results.length} result{results.length === 1 ? '' : 's'}</h3>
                  <ul className="card-list gym-lib-list">{results.map(row)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      </Sheet>
      <CustomExerciseSheet
        open={open && creating}
        onClose={() => setCreating(false)}
        initialName={trimmed}
        onSaved={onCreated}
      />
    </>
  )
}

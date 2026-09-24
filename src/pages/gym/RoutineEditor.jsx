import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Disclosure from '../../components/ui/Disclosure.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { AutoTextarea, Button, Field, IconButton, Skeleton } from '../../components/ui/primitives.jsx'
import { MUSCLES, TRACKING, exerciseById, newRoutineExercise } from '../../lib/gym/library.js'
import { ROUTINE_COLORS, deleteRoutine, duplicateRoutine, getGym, newGymId, routineById, saveRoutine, useGym } from '../../lib/gym/state.js'
import { estimateMinutes } from '../../lib/gym/stats.js'
import { formatDuration, fromMeters, toMeters } from '../../lib/gym/units.js'
import { tokenUserId } from '../../lib/api.js'
import { useStore } from '../../lib/store.js'
import { DurationInput, GymEmpty, NumberInput, SectionHeader, SetTypeBadge, WeightInput, goBack } from './common.jsx'
import ExercisePicker from './ExercisePicker.jsx'
import { ActionSheet, removeRoutine, routineName, useSheetTarget } from './RoutinesTab.jsx'
import './routines.css'

// #/gym/routine/<id> ('new' creates one). Edits a draft in component state; nothing reaches the
// store until Save. Unsaved edits are also kept in sessionStorage, so leaving the editor another
// way (tab bar, workout pill, a reload) doesn't lose them: reopening the routine restores them.

const SET_TYPES = [
  { id: 'normal', label: 'Normal' },
  { id: 'warmup', label: 'Warm-up' },
  { id: 'drop', label: 'Drop set' },
  { id: 'failure', label: 'Failure' },
]
const SUPERSET_COLORS = ['var(--gym-c-teal)', 'var(--gym-c-indigo)', 'var(--gym-c-pink)', 'var(--gym-c-amber)', 'var(--gym-c-blue)', 'var(--gym-c-green)']
const REST_STEP = 15
const REST_MAX = 600
const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))

const fieldsFor = (tracking) => TRACKING[tracking]?.fields || ['weight', 'reps']
const exerciseName = (row) => (typeof row?.name === 'string' && row.name.trim()) || 'Exercise'
const snap = (draft) => JSON.stringify(draft)

function blankSet(tracking) {
  const fields = fieldsFor(tracking)
  const reps = fields.includes('reps')
  return {
    type: 'normal',
    weightKg: null,
    repsMin: reps ? 8 : null,
    repsMax: reps ? 12 : null,
    durationSec: fields.includes('duration') && !fields.includes('distance') ? 60 : null,
    distanceM: null,
    rpe: null,
  }
}

function newDraft(routines) {
  const used = new Set(routines.map((routine) => routine.color))
  const color = (ROUTINE_COLORS.find((item) => !used.has(item.id)) || ROUTINE_COLORS[routines.length % ROUTINE_COLORS.length]).id
  return { id: newGymId(), name: '', color, notes: '', folderId: null, exercises: [] }
}

const fromRoutine = (routine) => ({
  ...routine,
  exercises: routine.exercises.map((row) => ({ ...row, sets: row.sets.map((set) => ({ ...set })) })),
})

// ---- unsaved draft (per routine id, or 'new'; this tab only; tied to the signed-in account) ----

const DRAFT_KEY = 'daybook.gym.routineDraft.'

function readStoredDraft(key) {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY + key)
    const saved = raw ? JSON.parse(raw) : null
    const draft = saved?.draft
    if (!saved || saved.user !== (tokenUserId() ?? null) || !draft || typeof draft !== 'object' || draft.id == null || !Array.isArray(draft.exercises)) return null
    if (!draft.exercises.every((row) => row && typeof row === 'object' && row.id != null && Array.isArray(row.sets) && row.sets.every((set) => set && typeof set === 'object'))) return null
    return { ...draft, name: typeof draft.name === 'string' ? draft.name : '', notes: typeof draft.notes === 'string' ? draft.notes : '' }
  } catch {
    return null
  }
}

// draftJson is the draft already serialised (the editor's snapshot).
function writeStoredDraft(key, draftJson) {
  try {
    sessionStorage.setItem(DRAFT_KEY + key, `{"user":${JSON.stringify(tokenUserId() ?? null)},"draft":${draftJson}}`)
  } catch {
    // storage full or unavailable: the draft just lives in memory
  }
}

function clearStoredDraft(key) {
  try {
    sessionStorage.removeItem(DRAFT_KEY + key)
  } catch {
    // storage unavailable
  }
}

// The editor's starting state: a stored draft that still differs from the routine wins.
function startState(key, fresh) {
  if (!fresh) return { draft: null, base: '', restored: false }
  const base = snap(fresh)
  const saved = readStoredDraft(key)
  if (saved && (key === 'new' || String(saved.id) === String(fresh.id)) && snap(saved) !== base) return { draft: saved, base, restored: true }
  return { draft: fresh, base, restored: false }
}

// Swaps the current history entry for `hash`, keeping its back-button depth (see goBack), and
// tells the app's hash listeners, as location.replace would.
function replaceHash(hash) {
  const oldURL = window.location.href
  try {
    window.history.replaceState(window.history.state, '', hash)
  } catch {
    window.location.replace(hash)
    return
  }
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }))
}

function freshDraft(key, gym) {
  if (key === 'new') return newDraft(gym.routines)
  const routine = routineById(gym, key)
  return routine ? fromRoutine(routine) : null
}

// Consecutive rows sharing a supersetId form a group. Lone members lose the id, and a group id
// reused further down (after a reorder) gets a fresh one, so groups are always contiguous.
function normalizeSupersets(rows) {
  const out = []
  const seen = new Set()
  let i = 0
  while (i < rows.length) {
    const id = rows[i].supersetId
    let j = i
    if (id != null) while (j + 1 < rows.length && rows[j + 1].supersetId === id) j++
    if (id == null || j === i) {
      out.push(rows[i].supersetId === null ? rows[i] : { ...rows[i], supersetId: null })
    } else {
      const groupId = seen.has(id) ? newGymId() : id
      seen.add(groupId)
      for (let k = i; k <= j; k++) out.push(rows[k].supersetId === groupId ? rows[k] : { ...rows[k], supersetId: groupId })
    }
    i = j + 1
  }
  return out
}

// rowId → { letter, position, size, color } for rows in a superset.
function supersetInfo(rows) {
  const info = new Map()
  let groups = 0
  let i = 0
  while (i < rows.length) {
    const id = rows[i].supersetId
    let j = i
    if (id != null) while (j + 1 < rows.length && rows[j + 1].supersetId === id) j++
    if (j > i) {
      const letter = String.fromCharCode(65 + (groups % 26))
      const color = SUPERSET_COLORS[groups % SUPERSET_COLORS.length]
      for (let k = i; k <= j; k++) info.set(rows[k].id, { letter, position: k - i + 1, size: j - i + 1, color })
      groups++
    }
    i = j + 1
  }
  return info
}

// Only one of min/max → fixed reps; a reversed range is swapped.
function cleanSet(set) {
  let { repsMin, repsMax } = set
  if (repsMin == null && repsMax != null) repsMin = repsMax
  if (repsMax == null && repsMin != null) repsMax = repsMin
  if (repsMin != null && repsMax != null && repsMin > repsMax) [repsMin, repsMax] = [repsMax, repsMin]
  return { ...set, repsMin, repsMax }
}

function cleanForSave(draft) {
  return {
    ...draft,
    name: draft.name.trim(),
    notes: draft.notes.trim() ? draft.notes.trimEnd() : '',
    exercises: normalizeSupersets(draft.exercises).map((row) => ({ ...row, note: (row.note || '').trim(), sets: row.sets.map(cleanSet) })),
  }
}

// What a row without its own rest uses in a workout: the exercise's rest, then Default rest.
function restFallback(row, customExercises, defaultRest) {
  const rest = exerciseById(row.exerciseId, customExercises)?.rest
  return Number.isFinite(rest) && rest >= 0 ? rest : defaultRest
}

function musclesText(row, customExercises) {
  const entry = exerciseById(row.exerciseId, customExercises)
  if (!entry) return TRACKING[row.tracking]?.label || ''
  const primary = MUSCLE_LABEL[entry.primary] || ''
  const secondary = (Array.isArray(entry.secondary) ? entry.secondary : []).map((muscle) => MUSCLE_LABEL[muscle]).filter(Boolean)
  return [primary, secondary.join(', ')].filter(Boolean).join(' · ')
}

export default function RoutineEditor({ param, today }) {
  const id = param || 'new'
  return <Editor key={id} param={id} today={today} />
}

function Editor({ param, today }) {
  const gym = useGym()
  const loaded = useStore((state) => state.loaded)
  const isNew = param === 'new'
  const stored = isNew ? null : routineById(gym, param)
  const [state, setState] = useState(() => startState(param, freshDraft(param, gym)))
  const [reordering, setReordering] = useState(false)
  const [picker, setPicker] = useState({ open: false, mode: 'add', rowId: null })
  const [rowMenu, showRowMenu, hideRowMenu] = useSheetTarget() // row id
  const [scrollTo, setScrollTo] = useState(null)
  const colorLabelId = useId()
  const lastMenuName = useRef('') // keeps the exercise sheet's title while it closes after a removal
  const mounted = useRef(true)
  const restoreToastShown = useRef(false)

  const { draft } = state
  const draftSnap = useMemo(() => (draft ? snap(draft) : ''), [draft])
  const dirty = !!draft && draftSnap !== state.base
  const canSave = !!draft && draft.name.trim() !== ''
  const { prefs } = gym

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The saved routine changed elsewhere (another device) while there are no local edits: show it.
  // It also fills in the editor when the routine arrives after the first render.
  useEffect(() => {
    if (isNew || !stored) return
    const fresh = fromRoutine(stored)
    const freshSnap = snap(fresh)
    setState((current) => {
      if (!current.draft) return startState(param, fresh)
      if (snap(current.draft) !== current.base) return current
      return freshSnap === current.base ? current : { draft: fresh, base: freshSnap, restored: false }
    })
  }, [stored, isNew, param])

  // Keep unsaved edits in sessionStorage; drop them once the draft matches the routine again.
  useEffect(() => {
    if (!draftSnap) return
    if (dirty) writeStoredDraft(param, draftSnap)
    else clearStoredDraft(param)
  }, [param, draftSnap, dirty])

  // Restored edits get a toast with a way back to the saved routine.
  useEffect(() => {
    if (!state.restored || restoreToastShown.current) return
    restoreToastShown.current = true
    toast('Restored your unsaved changes', {
      duration: 7000,
      action: {
        label: 'Discard',
        onClick: () => {
          clearStoredDraft(param)
          if (!mounted.current) return
          const fresh = freshDraft(param, getGym())
          setState({ draft: fresh, base: fresh ? snap(fresh) : '', restored: false })
        },
      },
    })
  }, [state.restored, param])

  // Desktop: warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Bring newly added exercises into view.
  useEffect(() => {
    if (!scrollTo) return
    const element = document.querySelector(`[data-row-id="${CSS.escape(scrollTo)}"]`)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setScrollTo(null)
  }, [scrollTo])

  const groups = useMemo(() => (draft ? supersetInfo(draft.exercises) : new Map()), [draft])

  if (!draft) {
    if (!loaded) return <div className="gym-re"><Skeleton lines={6} /></div>
    return (
      <div className="gym-re">
        <GymEmpty
          icon="dumbbell"
          title="Routine not found"
          action={<Button variant="secondary" icon="chevronLeft" onClick={() => goBack('gym/routines')}>Back to routines</Button>}
        >
          It may have been deleted, possibly on another device.
        </GymEmpty>
      </div>
    )
  }

  const markClean = () => {
    clearStoredDraft(param)
    setState((current) => ({ ...current, base: snap(current.draft) }))
  }
  const setDraft = (fn) => setState((current) => (current.draft ? { ...current, draft: fn(current.draft) } : current))
  const setRows = (fn) => setDraft((current) => ({ ...current, exercises: fn(current.exercises) }))
  const updateRow = (rowId, fn) => setRows((rows) => rows.map((row) => (row.id === rowId ? fn(row) : row)))

  const newRow = (entry, sets = 3) => {
    const row = newRoutineExercise(entry, newGymId, sets)
    const restOverride = gym.exerciseMeta[entry.id]?.restSec
    return Number.isFinite(restOverride) ? { ...row, restSec: Math.min(REST_MAX, Math.max(0, restOverride)) } : row
  }

  const onPick = (entries) => {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : []
    setPicker((current) => ({ ...current, open: false }))
    if (!list.length) return
    if (picker.mode === 'replace') {
      const entry = list[0]
      updateRow(picker.rowId, (row) => {
        const fresh = newRow(entry, Math.max(1, row.sets.length))
        const keepSets = fresh.tracking === row.tracking
        return {
          ...row,
          exerciseId: fresh.exerciseId,
          name: fresh.name,
          tracking: fresh.tracking,
          restSec: fresh.restSec,
          sets: keepSets ? row.sets : fresh.sets.map((set, index) => ({ ...set, type: row.sets[index]?.type || 'normal' })),
        }
      })
      return
    }
    const rows = list.map((entry) => newRow(entry))
    setRows((current) => [...current, ...rows])
    setScrollTo(rows[0].id)
  }

  const moveRow = (rowId, delta) => setRows((rows) => {
    const from = rows.findIndex((row) => row.id === rowId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= rows.length) return rows
    const next = rows.slice()
    ;[next[from], next[to]] = [next[to], next[from]]
    return normalizeSupersets(next)
  })

  // Links the row with the one below (joining that one's group), or splits the group after it.
  const toggleLink = (rowId) => setRows((rows) => {
    const index = rows.findIndex((row) => row.id === rowId)
    const row = rows[index]
    const next = rows[index + 1]
    if (!row || !next) return rows
    if (row.supersetId != null && next.supersetId === row.supersetId) {
      const split = newGymId()
      return normalizeSupersets(rows.map((item, i) => (i > index && item.supersetId === row.supersetId ? { ...item, supersetId: split } : item)))
    }
    const groupId = row.supersetId ?? next.supersetId ?? newGymId()
    const joined = next.supersetId
    return normalizeSupersets(rows.map((item, i) => (
      i === index || i === index + 1 || (joined != null && item.supersetId === joined) ? { ...item, supersetId: groupId } : item
    )))
  })

  const removeRow = (rowId) => {
    const index = draft.exercises.findIndex((row) => row.id === rowId)
    const removed = draft.exercises[index]
    if (!removed) return
    setRows((rows) => normalizeSupersets(rows.filter((row) => row.id !== rowId)))
    toast(`Removed ${exerciseName(removed)}`, {
      action: {
        label: 'Undo',
        onClick: () => setRows((rows) => (rows.some((row) => row.id === rowId) ? rows : normalizeSupersets([...rows.slice(0, index), removed, ...rows.slice(index)]))),
      },
    })
  }

  const save = () => {
    if (!canSave) return
    if (!dirty && !isNew) {
      goBack('gym/routines')
      return
    }
    const saved = saveRoutine(cleanForSave(draft))
    markClean()
    toast(`Saved ${routineName(saved)}`, { tone: 'success' })
    goBack('gym/routines')
  }

  const cancel = async () => {
    if (dirty) {
      const ok = await confirmAction({
        title: isNew ? 'Discard this routine?' : 'Discard changes?',
        message: isNew ? 'It hasn’t been saved yet.' : 'Your changes to this routine will be lost.',
        confirmLabel: 'Discard',
      })
      if (!ok) return
      markClean()
    }
    goBack('gym/routines')
  }

  const duplicate = () => {
    if (!stored) return
    if (dirty) {
      if (!canSave) return
      saveRoutine(cleanForSave(draft))
      markClean()
    }
    const copy = duplicateRoutine(stored.id)
    if (!copy) return
    const hash = `#/gym/routine/${encodeURIComponent(copy.id)}`
    const originalHash = `#/gym/routine/${encodeURIComponent(stored.id)}`
    toast(`Now editing ${routineName(copy)}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          deleteRoutine(copy.id, { replaceWithRest: false })
          clearStoredDraft(copy.id)
          // Back to the original routine, in the same history entry.
          if (window.location.hash === hash) replaceHash(originalHash)
        },
      },
    })
    // The copy takes the original's history entry, so Save or Cancel on it returns to where the
    // original was opened from (usually the Routines list), not to the original's editor.
    replaceHash(hash)
  }

  const remove = async () => {
    if (!stored) return
    if (await removeRoutine(stored, today)) {
      markClean()
      goBack('gym/routines')
    }
  }

  const rows = draft.exercises
  const totalSets = rows.reduce((sum, row) => sum + row.sets.length, 0)
  const minutes = estimateMinutes(draft)
  const menuIndex = rowMenu.target ? rows.findIndex((row) => row.id === rowMenu.target) : -1
  const menuRow = rows[menuIndex] || null
  const menuNext = rows[menuIndex + 1] || null
  const menuLinked = !!menuRow && menuRow.supersetId != null && menuNext?.supersetId === menuRow.supersetId
  if (menuRow) lastMenuName.current = exerciseName(menuRow)
  const pickerRow = picker.mode === 'replace' ? rows.find((row) => row.id === picker.rowId) : null
  const distanceUnit = prefs.distanceUnit === 'mi' ? 'mi' : 'km'
  const draftColor = ROUTINE_COLORS.find((color) => color.id === draft.color) || ROUTINE_COLORS[0]
  const draftFolder = gym.folders.find((folder) => folder.id === draft.folderId) || null

  return (
    <div className="gym-re">
      <header className="gym-re-bar">
        <button type="button" className="gym-re-bar-btn" onClick={cancel}>Cancel</button>
        <h1 className="gym-re-bar-title">{isNew ? 'New routine' : 'Edit routine'}</h1>
        <button type="button" className="gym-re-bar-btn is-save" onClick={save} disabled={!canSave}>Save</button>
      </header>

      <section className="card gym-re-details" aria-label="Routine details">
        <Field label="Name" hint={!canSave && (dirty || isNew) ? 'Give it a name to save it.' : undefined}>
          {(id) => (
            <input
              id={id}
              className="input gym-re-name"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="e.g. Push, Legs, Upper A"
              maxLength={60}
              autoFocus={isNew}
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="done"
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
          )}
        </Field>

        <Disclosure
          id="routine-details"
          label="Colour, folder & notes"
          className="gym-disclosure"
          hasValues={!!draft.notes.trim() || !!draftFolder}
          summary={(
            <>
              <span className="gym-disclosure-dot" style={{ '--gym-dot': draftColor.value }} aria-hidden="true" />
              {[draftColor.label, draftFolder?.name, draft.notes.trim() ? 'Notes' : null].filter(Boolean).join(' · ')}
            </>
          )}
        >
          <div className="field">
            <span className="field-label" id={colorLabelId}>Colour</span>
            <div className="gym-re-swatches" role="radiogroup" aria-labelledby={colorLabelId}>
              {ROUTINE_COLORS.map((color) => {
                const checked = draft.color === color.id
                return (
                  <button
                    key={color.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={color.label}
                    title={color.label}
                    className="gym-re-swatch"
                    style={{ '--gym-sw': color.value }}
                    onClick={() => setDraft((current) => ({ ...current, color: color.id }))}
                  >
                    <span className="gym-re-swatch-dot"><Icon name="check" size={16} strokeWidth={3} /></span>
                  </button>
                )
              })}
            </div>
            <p className="field-hint">Shows on the calendar and the routine’s days.</p>
          </div>

          {gym.folders.length > 0 && (
            <Field label="Folder" hint="Folders keep related routines together on the Routines tab.">
              {(id) => (
                <select
                  id={id}
                  className="input"
                  value={draftFolder ? draft.folderId : ''}
                  onChange={(event) => setDraft((current) => ({ ...current, folderId: event.target.value || null }))}
                >
                  <option value="">No folder</option>
                  {gym.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
              )}
            </Field>
          )}

          <Field label="Notes">
            {(id) => (
              <AutoTextarea
                id={id}
                value={draft.notes}
                onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Focus, cues, anything to remember"
                minRows={2}
                maxRows={8}
              />
            )}
          </Field>
        </Disclosure>
      </section>

      <SectionHeader
        title="Exercises"
        action={rows.length > 1 ? (
          <button type="button" className={`gym-rt-toggle${reordering ? ' is-on' : ''}`} onClick={() => setReordering((on) => !on)}>
            {reordering ? 'Done' : 'Reorder'}
          </button>
        ) : null}
      />
      {rows.length > 0 && (
        <p className="gym-re-summary">
          {rows.length} exercise{rows.length === 1 ? '' : 's'} · {totalSets} set{totalSets === 1 ? '' : 's'}{minutes ? ` · ~${minutes} min` : ''}
        </p>
      )}

      {!rows.length ? (
        <div className="card gym-re-empty">
          <GymEmpty
            icon="dumbbell"
            title="No exercises yet"
            action={<Button icon="plus" onClick={() => setPicker({ open: true, mode: 'add', rowId: null })}>Add exercises</Button>}
          >
            Pick from the library or your own exercises, then set targets for each set.
          </GymEmpty>
        </div>
      ) : reordering ? (
        <ul className="card-list gym-reorder-list">
          {rows.map((row, index) => {
            const group = groups.get(row.id)
            return (
              <li key={row.id} className="gym-reorder-row">
                {group
                  ? <span className="gym-re-ss-tag" style={{ '--gym-ss': group.color }}>{group.letter}{group.position}</span>
                  : <span className="gym-reorder-index" aria-hidden="true">{index + 1}</span>}
                <span className="gym-reorder-name">{exerciseName(row)}</span>
                <IconButton icon="arrowUp" label={`Move ${exerciseName(row)} up`} disabled={index === 0} onClick={() => moveRow(row.id, -1)} />
                <IconButton icon="arrowDown" label={`Move ${exerciseName(row)} down`} disabled={index === rows.length - 1} onClick={() => moveRow(row.id, 1)} />
              </li>
            )
          })}
        </ul>
      ) : (
        <ol className="gym-re-list">
          {rows.map((row) => (
            <li key={row.id} data-row-id={row.id}>
              <ExerciseCard
                row={row}
                group={groups.get(row.id) || null}
                muscles={musclesText(row, gym.exercises)}
                unit={prefs.unit}
                distanceUnit={distanceUnit}
                showRpe={prefs.showRpe}
                defaultRest={restFallback(row, gym.exercises, prefs.defaultRest)}
                onChange={(fn) => updateRow(row.id, fn)}
                onMenu={() => showRowMenu(row.id)}
              />
            </li>
          ))}
        </ol>
      )}

      {rows.length > 0 && !reordering && (
        <button type="button" className="btn btn-secondary btn-block gym-re-add" onClick={() => setPicker({ open: true, mode: 'add', rowId: null })}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
          Add exercises
        </button>
      )}

      {!isNew && stored && !reordering && (
        <div className="gym-as-list gym-re-actions">
          <button type="button" className="gym-as-row" onClick={duplicate} disabled={dirty && !canSave}>
            <Icon name="copy" size={20} />
            <span className="gym-as-label">
              {dirty ? 'Save and duplicate' : 'Duplicate routine'}
              <small>Makes a copy you can change, like a variation</small>
            </span>
          </button>
          <button type="button" className="gym-as-row is-danger" onClick={remove}>
            <Icon name="trash" size={20} />
            <span className="gym-as-label">Delete routine</span>
          </button>
        </div>
      )}

      <ExercisePicker
        open={picker.open}
        onClose={() => setPicker((current) => ({ ...current, open: false }))}
        onPick={onPick}
        multi={picker.mode === 'add'}
        title={picker.mode === 'add' ? 'Add exercises' : 'Replace exercise'}
        excludeIds={picker.mode === 'add' ? rows.map((row) => row.exerciseId).filter(Boolean) : pickerRow?.exerciseId ? [pickerRow.exerciseId] : []}
      />

      <ActionSheet
        open={rowMenu.open && !!menuRow}
        onClose={hideRowMenu}
        title={lastMenuName.current}
        actions={menuRow ? [
          [
            { id: 'replace', label: 'Replace exercise', icon: 'shuffle', hint: 'Keeps the sets when it’s tracked the same way', onClick: () => setPicker({ open: true, mode: 'replace', rowId: menuRow.id }) },
            menuLinked
              ? { id: 'unlink', label: 'Unlink from next', icon: 'link', hint: `Ends the superset before ${exerciseName(menuNext)}`, onClick: () => toggleLink(menuRow.id) }
              : { id: 'link', label: 'Superset with next', icon: 'link', disabled: !menuNext, hint: menuNext ? `Alternate with ${exerciseName(menuNext)}, no rest in between` : 'Add another exercise below it first', onClick: () => toggleLink(menuRow.id) },
          ],
          [
            { id: 'up', label: 'Move up', icon: 'arrowUp', disabled: menuIndex <= 0, onClick: () => moveRow(menuRow.id, -1) },
            { id: 'down', label: 'Move down', icon: 'arrowDown', disabled: !menuNext, onClick: () => moveRow(menuRow.id, 1) },
          ],
          [{ id: 'remove', label: 'Remove exercise', icon: 'trash', danger: true, onClick: () => removeRow(menuRow.id) }],
        ] : []}
      />
    </div>
  )
}

// ---- one exercise ----------------------------------------------------------------------------------

function ExerciseCard({ row, group, muscles, unit, distanceUnit, showRpe, defaultRest, onChange, onMenu }) {
  const name = exerciseName(row)
  const rest = Number.isFinite(row.restSec) ? row.restSec : defaultRest
  const stepRest = (delta) => {
    const next = delta > 0 ? Math.floor(rest / REST_STEP) * REST_STEP + REST_STEP : Math.ceil(rest / REST_STEP) * REST_STEP - REST_STEP
    onChange((current) => ({ ...current, restSec: Math.min(REST_MAX, Math.max(0, next)) }))
  }
  const setSets = (fn) => onChange((current) => ({ ...current, sets: fn(current.sets) }))
  const addSet = () => setSets((sets) => [...sets, sets.length ? { ...sets[sets.length - 1] } : blankSet(row.tracking)])

  return (
    <article
      className={`card gym-re-ex${group ? ' is-grouped' : ''}`}
      style={group ? { '--gym-ss': group.color } : undefined}
      aria-label={name}
    >
      {group && group.position === 1 && (
        <p className="gym-re-ss-label">
          <Icon name="link" size={14} strokeWidth={2.2} />
          {group.size > 2 ? 'Circuit' : 'Superset'} {group.letter} · {group.size} exercises
        </p>
      )}
      <header className="gym-re-ex-head">
        {group && <span className="gym-re-ss-tag">{group.letter}{group.position}</span>}
        <div className="gym-re-ex-title">
          <h3>{name}</h3>
          {muscles && <p>{muscles}</p>}
        </div>
        <IconButton icon="more" label={`Options for ${name}`} className="gym-re-ex-more" onClick={onMenu} />
      </header>

      <SetsTable row={row} unit={unit} distanceUnit={distanceUnit} showRpe={showRpe} onSets={setSets} />

      <button type="button" className="gym-re-addset" onClick={addSet}>
        <Icon name="plus" size={16} strokeWidth={2.2} />
        Add set
      </button>

      <Disclosure
        id="routine-exercise-extras"
        label="Rest & note"
        className="gym-disclosure gym-re-extras"
        hasValues={!!row.note?.trim()}
        summary={`Rest ${rest > 0 ? formatDuration(rest) : 'off'}${row.note?.trim() ? ' · Note' : ''}`}
      >
        <div className="gym-re-rest">
          <Icon name="timer" size={18} />
          <span className="gym-re-rest-label" id={`rest-${row.id}`}>Rest after each set</span>
          <div className="gym-re-stepper" role="group" aria-labelledby={`rest-${row.id}`}>
            <IconButton icon="minus" size={16} label="Less rest" disabled={rest <= 0} onClick={() => stepRest(-1)} />
            <output aria-live="off">{rest > 0 ? formatDuration(rest) : 'Off'}</output>
            <IconButton icon="plus" size={16} label="More rest" disabled={rest >= REST_MAX} onClick={() => stepRest(1)} />
          </div>
        </div>
        <AutoTextarea
          className="gym-re-note"
          value={row.note || ''}
          onChange={(event) => onChange((current) => ({ ...current, note: event.target.value }))}
          placeholder="Note, like seat height or grip"
          aria-label={`Note for ${name}`}
          minRows={1}
          maxRows={5}
        />
      </Disclosure>
    </article>
  )
}

function fieldHeader(field, unit, distanceLabel) {
  const weight = unit === 'lb' ? 'lb' : 'kg'
  if (field === 'weight') return weight
  if (field === 'added') return `+${weight}`
  if (field === 'assist') return `−${weight}`
  if (field === 'reps') return 'Reps'
  if (field === 'duration') return 'Time'
  if (field === 'distance') return distanceLabel
  return ''
}

function SetsTable({ row, unit, distanceUnit, showRpe, onSets }) {
  const fields = fieldsFor(row.tracking)
  // Farmer's-walk style carries are short: metres (or yards) instead of km (or miles).
  const distanceLabel = row.tracking === 'weight_distance' ? (distanceUnit === 'mi' ? 'yd' : 'm') : distanceUnit
  const columns = [
    '44px',
    ...fields.map((field) => (field === 'reps' ? 'minmax(0, 1.5fr)' : 'minmax(0, 1fr)')),
    ...(showRpe ? ['minmax(44px, 0.6fr)'] : []),
    '36px',
  ].join(' ')
  const setAt = (index, patch) => onSets((sets) => sets.map((set, i) => (i === index ? { ...set, ...patch } : set)))
  let normal = 0

  return (
    <div className="gym-re-sets">
      <div className="gym-re-sets-head" style={{ gridTemplateColumns: columns }} aria-hidden="true">
        <span>Set</span>
        {fields.map((field) => <span key={field}>{fieldHeader(field, unit, distanceLabel)}</span>)}
        {showRpe && <span>RPE</span>}
        <span />
      </div>
      {row.sets.map((set, index) => {
        const number = set.type === 'normal' ? ++normal : undefined
        const label = `Set ${index + 1}`
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="gym-re-set" style={{ gridTemplateColumns: columns }}>
            <SetTypeButton type={set.type} number={number} label={label} onChange={(type) => setAt(index, { type })} />
            {fields.map((field) => {
              if (field === 'weight' || field === 'added' || field === 'assist') {
                const what = field === 'added' ? 'added weight' : field === 'assist' ? 'assistance' : 'weight'
                return (
                  <WeightInput
                    key={field}
                    valueKg={set.weightKg}
                    unit={unit}
                    placeholder="–"
                    ariaLabel={`${label} target ${what}, ${unit === 'lb' ? 'pounds' : 'kilograms'}`}
                    enterKeyHint="next"
                    onChange={(weightKg) => setAt(index, { weightKg })}
                  />
                )
              }
              if (field === 'reps') {
                return (
                  <div key={field} className="gym-re-range">
                    <NumberInput
                      value={set.repsMin}
                      min={1}
                      max={999}
                      placeholder={set.repsMax ?? 'min'}
                      ariaLabel={`${label} minimum reps`}
                      enterKeyHint="next"
                      onChange={(repsMin) => setAt(index, { repsMin })}
                    />
                    <span aria-hidden="true">–</span>
                    <NumberInput
                      value={set.repsMax}
                      min={1}
                      max={999}
                      placeholder={set.repsMin ?? 'max'}
                      ariaLabel={`${label} maximum reps (leave empty for a fixed number)`}
                      onChange={(repsMax) => setAt(index, { repsMax })}
                    />
                  </div>
                )
              }
              if (field === 'duration') {
                return (
                  <DurationInput
                    key={field}
                    valueSec={set.durationSec}
                    placeholder="0:00"
                    ariaLabel={`${label} target time, minutes and seconds`}
                    onChange={(durationSec) => setAt(index, { durationSec })}
                  />
                )
              }
              return (
                <NumberInput
                  key={field}
                  decimal
                  value={fromMeters(set.distanceM, distanceLabel)}
                  placeholder="–"
                  ariaLabel={`${label} target distance, ${distanceLabel}`}
                  onChange={(value) => setAt(index, { distanceM: value == null ? null : toMeters(value, distanceLabel) })}
                />
              )
            })}
            {showRpe && (
              <NumberInput
                decimal
                value={set.rpe}
                min={1}
                max={10}
                placeholder="–"
                ariaLabel={`${label} target RPE, 1 to 10`}
                onChange={(rpe) => setAt(index, { rpe })}
              />
            )}
            <IconButton
              icon="close"
              size={16}
              className="gym-re-set-del"
              label={`Delete ${label.toLowerCase()}`}
              disabled={row.sets.length <= 1}
              onClick={() => onSets((sets) => sets.filter((_, i) => i !== index))}
            />
          </div>
        )
      })}
    </div>
  )
}

// The set badge opens a small menu: Normal, Warm-up, Drop, Failure. Picking the current type
// again sets it back to Normal.
function SetTypeButton({ type, number, label, onChange }) {
  const [open, setOpen] = useState(false)
  const [upward, setUpward] = useState(false)
  const wrapRef = useRef(null)
  const buttonRef = useRef(null)
  const menuId = useId()
  const current = SET_TYPES.find((item) => item.id === type) || SET_TYPES[0]

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    wrapRef.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect()
      setUpward(!!rect && rect.bottom + 240 > window.innerHeight && rect.top > 260)
    }
    setOpen((value) => !value)
  }

  const pick = (id) => {
    onChange(id === type ? 'normal' : id)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const onMenuKey = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll('[role="menuitemradio"]')]
    const at = items.indexOf(document.activeElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  return (
    <div className="gym-re-type" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="gym-re-type-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}, ${current.label}. Change set type`}
        onClick={toggle}
      >
        <SetTypeBadge type={type} number={number} />
      </button>
      {open && (
        <div id={menuId} className={`gym-re-type-menu${upward ? ' is-up' : ''}`} role="menu" aria-label="Set type" onKeyDown={onMenuKey}>
          {SET_TYPES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === type}
              className="gym-re-type-item"
              onClick={() => pick(item.id)}
            >
              <span className="gym-re-type-badge" aria-hidden="true">
                <SetTypeBadge type={item.id} number={item.id === 'normal' ? number ?? 1 : undefined} />
              </span>
              <span className="gym-re-type-label">{item.label}</span>
              {item.id === type && <Icon name="check" size={16} strokeWidth={2.4} className="gym-re-type-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

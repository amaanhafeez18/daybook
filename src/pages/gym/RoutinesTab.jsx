import { useEffect, useId, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { Button, Field, IconButton, Skeleton } from '../../components/ui/primitives.jsx'
import { WEEKDAY_SHORT, relativeDay, timeAgo } from '../../lib/dates.js'
import { TEMPLATES, buildTemplate } from '../../lib/gym/library.js'
import { addDays, isDeload, nextWorkout, resolveDay, routineInUse, weekday } from '../../lib/gym/schedule.js'
import {
  applyTemplate, deleteFolder, deleteRoutine, duplicateRoutine, getGym, newGymId, reorderRoutines, routineById, routineColor,
  saveFolder, saveRoutine, updateGym, useBodyWeights, useGym, useGymSessions,
} from '../../lib/gym/state.js'
import { estimateMinutes } from '../../lib/gym/stats.js'
import { navigate } from '../../lib/router.js'
import { useStore } from '../../lib/store.js'
import { GymEmpty, RoutineChip, RoutineDot, SectionHeader } from './common.jsx'
import ScheduleEditor from './ScheduleEditor.jsx'
import SplitWizard from './SplitWizard.jsx'
import { beginWorkout } from './startWorkout.js'
import './routines.css'
import './wizard.css'
import './browse.css'

// ---- shared with the routine editor ------------------------------------------------------------

export function routineName(routine) {
  const name = typeof routine?.name === 'string' ? routine.name.trim() : ''
  return name || 'Untitled routine'
}

export function routineSummary(routine) {
  const count = routine.exercises.length
  const minutes = estimateMinutes(routine)
  return `${count} exercise${count === 1 ? '' : 's'}${minutes ? ` · ~${minutes} min` : ''}`
}

// Asks first only when the schedule uses it (its days become Rest); always offers Undo.
// Resolves true when the routine was deleted.
export async function removeRoutine(routine, today) {
  const name = routineName(routine)
  const inUse = routineInUse(getGym().schedule, routine.id, today)
  if (inUse) {
    const ok = await confirmAction({
      title: `Delete ${name}?`,
      message: 'It’s in your schedule. Its days will become Rest days. Past workouts keep their history.',
      confirmLabel: 'Delete',
    })
    if (!ok) return false
  }
  let undo
  try {
    undo = deleteRoutine(routine.id, { replaceWithRest: inUse })
  } catch (error) {
    toast(error.message, { tone: 'error' })
    return false
  }
  toast(inUse ? `Deleted ${name} · its days are now Rest` : `Deleted ${name}`, { action: { label: 'Undo', onClick: undo } })
  return true
}

// iOS-style action sheet: a titled sheet with one grouped list of actions.
export function ActionSheet({ open, onClose, title, description, actions }) {
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} size="sm" initialFocus={false}>
      <div className="gym-as-list">
        {actions.filter(Boolean).map((action) => (
          <button
            key={action.id}
            type="button"
            className={`gym-as-row${action.danger ? ' is-danger' : ''}`}
            disabled={action.disabled}
            aria-current={action.checked ? 'true' : undefined}
            onClick={() => {
              onClose()
              action.onClick()
            }}
          >
            {action.icon && <Icon name={action.icon} size={20} />}
            <span className="gym-as-label">
              {action.label}
              {action.hint && <small>{action.hint}</small>}
            </span>
            {action.checked && <Icon name="check" size={18} strokeWidth={2.4} className="gym-as-check" />}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

// ---- tab -----------------------------------------------------------------------------------------

const COLLAPSE_KEY = 'daybook.gym.collapsedFolders'

function readCollapsed() {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSE_KEY))
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

// Sheet state that keeps its target while the sheet animates closed, so its content doesn't blank out.
export function useSheetTarget() {
  const [state, setState] = useState({ open: false, target: null })
  const show = (target) => setState({ open: true, target })
  const hide = () => setState((current) => (current.open ? { ...current, open: false } : current))
  return [state, show, hide]
}

// Ungrouped routines first, then one group per folder (a routine whose folder is gone is ungrouped).
function groupRoutines(routines, folders) {
  const folderIds = new Set(folders.map((folder) => folder.id))
  return [
    { folder: null, routines: routines.filter((routine) => !folderIds.has(routine.folderId)) },
    ...folders.map((folder) => ({ folder, routines: routines.filter((routine) => routine.folderId === folder.id) })),
  ]
}

export default function RoutinesTab({ today }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const bodyWeights = useBodyWeights()
  const loaded = useStore((state) => state.loaded)
  const { routines, folders, schedule } = gym

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [menu, showMenu, hideMenu] = useSheetTarget() // routine
  const [move, showMove, hideMove] = useSheetTarget() // routine
  const [folderMenu, showFolderMenu, hideFolderMenu] = useSheetTarget() // folder
  const [folderEdit, showFolderEdit, hideFolderEdit] = useSheetTarget() // { folder: Folder | null, moveRoutineId? }
  const [collapsed, setCollapsed] = useState(readCollapsed)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
    } catch {
      // storage unavailable: folders just start expanded next time
    }
  }, [collapsed])

  useEffect(() => {
    if (routines.length < 2) setReordering(false)
  }, [routines.length])

  const groups = useMemo(() => groupRoutines(routines, folders), [routines, folders])

  const lastDone = useMemo(() => {
    const map = new Map()
    for (const session of sessions) if (session.routineId && !map.has(session.routineId)) map.set(session.routineId, session.date)
    return map
  }, [sessions])

  // The routine planned today (if not done yet), else the next scheduled one.
  const upNext = useMemo(() => {
    const day = resolveDay(gym, sessions, today, today)
    if (day.status === 'today' && day.routine) return { id: day.routine.id, label: 'Today' }
    const next = nextWorkout(gym, sessions, today)
    return next?.routine ? { id: next.routine.id, label: relativeDay(next.date, today) } : null
  }, [gym, sessions, today])

  const start = (routine) => {
    beginWorkout({ gym, sessions, bodyWeights, routine, date: today, today }).catch((error) => {
      toast(error?.message || 'Couldn’t start the workout.', { tone: 'error' })
    })
  }

  const duplicate = (routine) => {
    const copy = duplicateRoutine(routine.id)
    if (!copy) return
    toast(`Created ${routineName(copy)}`, { action: { label: 'Undo', onClick: () => deleteRoutine(copy.id, { replaceWithRest: false }) } })
  }

  const moveTo = (routine, folderId) => {
    const current = routineById(getGym(), routine.id)
    if (!current || current.folderId === folderId) return
    const previous = current.folderId
    saveRoutine({ ...current, folderId })
    const folder = getGym().folders.find((item) => item.id === folderId)
    toast(folder ? `Moved to ${folder.name}` : 'Moved out of the folder', {
      action: {
        label: 'Undo',
        onClick: () => {
          const latest = routineById(getGym(), routine.id)
          if (latest) saveRoutine({ ...latest, folderId: previous })
        },
      },
    })
  }

  const removeFolder = (folder) => {
    const undo = deleteFolder(folder.id)
    toast(`Deleted folder ${folder.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  // Swaps within the routine's group, then saves the order as displayed (groups in order).
  const moveInGroup = (routine, delta) => {
    const group = groups.find((item) => item.routines.includes(routine))
    if (!group) return
    const ids = group.routines.map((item) => item.id)
    const from = ids.indexOf(routine.id)
    const to = from + delta
    if (to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    reorderRoutines(groups.flatMap((item) => (item === group ? ids : item.routines.map((entry) => entry.id))))
  }

  const toggleFolder = (id) => setCollapsed((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]))

  if (!loaded && !routines.length) {
    return <div className="gym-routines"><Skeleton lines={5} /></div>
  }

  const sheets = (
    <>
      <ScheduleEditor open={scheduleOpen} onClose={() => setScheduleOpen(false)} today={today} />
      <TemplateSheet open={templatesOpen} onClose={() => setTemplatesOpen(false)} today={today} />
      <SplitWizard open={wizardOpen} onClose={() => setWizardOpen(false)} today={today} />
      <ActionSheet
        open={menu.open}
        onClose={hideMenu}
        title={menu.target ? routineName(menu.target) : ''}
        actions={menu.target ? [
          { id: 'duplicate', label: 'Duplicate', icon: 'copy', onClick: () => duplicate(menu.target) },
          { id: 'move', label: 'Move to folder…', icon: 'layers', onClick: () => showMove(menu.target) },
          routines.length > 1 && { id: 'reorder', label: 'Reorder routines', icon: 'arrowDown', onClick: () => setReordering(true) },
          { id: 'delete', label: 'Delete routine', icon: 'trash', danger: true, onClick: () => removeRoutine(menu.target, today) },
        ] : []}
      />
      <ActionSheet
        open={move.open}
        onClose={hideMove}
        title={move.target ? `Move ${routineName(move.target)}` : ''}
        description="Folders keep related routines together, like a program or your home workouts."
        actions={move.target ? [
          { id: 'none', label: 'No folder', icon: 'list', checked: !folders.some((folder) => folder.id === move.target.folderId), onClick: () => moveTo(move.target, null) },
          ...folders.map((folder) => ({ id: folder.id, label: folder.name, icon: 'layers', checked: move.target.folderId === folder.id, onClick: () => moveTo(move.target, folder.id) })),
          { id: 'new', label: 'New folder…', icon: 'plus', onClick: () => showFolderEdit({ folder: null, moveRoutineId: move.target.id }) },
        ] : []}
      />
      <ActionSheet
        open={folderMenu.open}
        onClose={hideFolderMenu}
        title={folderMenu.target?.name || ''}
        actions={folderMenu.target ? [
          { id: 'rename', label: 'Rename folder', icon: 'pencil', onClick: () => showFolderEdit({ folder: folderMenu.target }) },
          { id: 'delete', label: 'Delete folder', icon: 'trash', danger: true, hint: 'Its routines stay, just outside the folder', onClick: () => removeFolder(folderMenu.target) },
        ] : []}
      />
      <FolderSheet
        open={folderEdit.open}
        folder={folderEdit.target?.folder || null}
        onClose={hideFolderEdit}
        onSaved={(saved) => {
          const routine = folderEdit.target?.moveRoutineId ? routineById(getGym(), folderEdit.target.moveRoutineId) : null
          if (routine) moveTo(routine, saved.id)
        }}
      />
    </>
  )

  // Nothing yet: explain routines and offer both ways to begin.
  if (!routines.length && !schedule.versions.length && !folders.length) {
    return (
      <div className="gym-routines">
        <div className="card gym-rt-hero">
          <GymEmpty
            icon="dumbbell"
            title="Build your split"
            action={(
              <div className="gym-rt-hero-actions">
                <Button icon="wand" onClick={() => setWizardOpen(true)}>Build my split</Button>
                <Button variant="secondary" icon="plus" onClick={() => navigate('gym/routine/new')}>Create one routine</Button>
                <Button variant="secondary" icon="layers" onClick={() => setTemplatesOpen(true)}>Use a template</Button>
              </div>
            )}
          >
            A routine is one training day, like Push, Pull or Legs, with its exercises and target sets. Type your split, like “push pull legs rest”, and the wizard sets it all up.
          </GymEmpty>
        </div>
        <MoreLinks />
        {sheets}
      </div>
    )
  }

  return (
    <div className="gym-routines">
      <SplitCard gym={gym} sessions={sessions} today={today} onEdit={() => setScheduleOpen(true)} onWizard={() => setWizardOpen(true)} />

      <SectionHeader
        title={routines.length ? `Routines · ${routines.length}` : 'Routines'}
        action={routines.length > 1 ? (
          <button type="button" className={`gym-rt-toggle${reordering ? ' is-on' : ''}`} onClick={() => setReordering((on) => !on)}>
            {reordering ? 'Done' : 'Reorder'}
          </button>
        ) : null}
      />

      {!reordering && (
        <div className="gym-rt-new">
          <Button icon="plus" onClick={() => navigate('gym/routine/new')}>New routine</Button>
          <Button variant="secondary" icon="layers" onClick={() => showFolderEdit({ folder: null })}>New folder</Button>
        </div>
      )}

      {reordering && <p className="gym-rt-hint">Use the arrows to change the order. Folders keep their own order.</p>}

      {groups.map((group) => {
        const { folder } = group
        if (!folder && !group.routines.length) {
          if (routines.length || reordering) return null
          return (
            <div key="loose" className="card gym-rt-empty">
              <GymEmpty
                icon="dumbbell"
                title="No routines yet"
                action={(
                  <div className="wiz-split-actions">
                    <Button icon="wand" onClick={() => setWizardOpen(true)}>Build my split</Button>
                    <Button variant="secondary" icon="layers" onClick={() => setTemplatesOpen(true)}>Use a template</Button>
                  </div>
                )}
              >
                Create one for each training day, like Push or Legs, then pick when each one happens in your schedule.
              </GymEmpty>
            </div>
          )
        }
        const isCollapsed = !!folder && !reordering && collapsed.includes(folder.id)
        return (
          <section key={folder ? folder.id : 'loose'} className="gym-rt-group" aria-label={folder ? `Folder ${folder.name}` : undefined}>
            {folder && (
              <div className="gym-rt-folder">
                <button type="button" className="gym-rt-folder-toggle" aria-expanded={!isCollapsed} onClick={() => toggleFolder(folder.id)} disabled={reordering}>
                  <Icon name="chevronDown" size={16} strokeWidth={2.2} className="gym-rt-folder-chevron" />
                  <Icon name="layers" size={18} className="gym-rt-folder-icon" />
                  <span className="gym-rt-folder-name">{folder.name}</span>
                  <span className="count">{group.routines.length}</span>
                </button>
                {!reordering && <IconButton icon="more" label={`Options for folder ${folder.name}`} onClick={() => showFolderMenu(folder)} />}
              </div>
            )}
            {isCollapsed ? null : !group.routines.length ? (
              <p className="gym-rt-folder-empty">Empty folder. Move a routine here from its <span aria-hidden="true">•••</span><span className="sr-only">More</span> menu.</p>
            ) : reordering ? (
              <ul className="card-list gym-reorder-list">
                {group.routines.map((routine, index) => (
                  <li key={routine.id} className="gym-reorder-row">
                    <RoutineDot routine={routine} size={12} />
                    <span className="gym-reorder-name">{routineName(routine)}</span>
                    <IconButton icon="arrowUp" label={`Move ${routineName(routine)} up`} disabled={index === 0} onClick={() => moveInGroup(routine, -1)} />
                    <IconButton icon="arrowDown" label={`Move ${routineName(routine)} down`} disabled={index === group.routines.length - 1} onClick={() => moveInGroup(routine, 1)} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="gym-rt-list">
                {group.routines.map((routine) => (
                  <li key={routine.id}>
                    <RoutineCard
                      routine={routine}
                      today={today}
                      lastDate={lastDone.get(routine.id) || null}
                      upNext={upNext?.id === routine.id ? upNext.label : null}
                      onStart={() => start(routine)}
                      onMenu={() => showMenu(routine)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      {!reordering && <MoreLinks onTemplates={() => setTemplatesOpen(true)} />}

      {sheets}
    </div>
  )
}

// The foot of the tab: the exercise library (no longer a tab of its own) and, once there are
// routines, templates to add more.
function MoreLinks({ onTemplates }) {
  return (
    <ul className="card-list gym-br-links">
      <li>
        <button type="button" className="gym-as-row" onClick={() => navigate('gym/exercises')}>
          <Icon name="book" size={20} />
          <span className="gym-as-label">
            Browse exercises
            <small>Records and history for each one</small>
          </span>
          <Icon name="chevronRight" size={18} className="gym-br-chevron" />
        </button>
      </li>
      {onTemplates && (
        <li>
          <button type="button" className="gym-as-row" onClick={onTemplates}>
            <Icon name="layers" size={20} />
            <span className="gym-as-label">Add routines from a template</span>
            <Icon name="chevronRight" size={18} className="gym-br-chevron" />
          </button>
        </li>
      )}
    </ul>
  )
}

function RoutineCard({ routine, today, lastDate, upNext, onStart, onMenu }) {
  const name = routineName(routine)
  const names = routine.exercises.map((row) => (typeof row.name === 'string' ? row.name.trim() : '')).filter(Boolean)
  const preview = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4} more` : '')
  const edit = () => navigate(`gym/routine/${encodeURIComponent(routine.id)}`)
  return (
    <article className="card gym-rt-card" style={{ '--gym-rc': routineColor(routine) }}>
      <button type="button" className="gym-rt-card-main" onClick={edit}>
        <span className="gym-rt-card-title">
          <span className="gym-rt-card-name">{name}</span>
          {upNext && (
            <span className="gym-rt-next">
              <Icon name="calendarCheck" size={13} strokeWidth={2.2} />
              {upNext}
            </span>
          )}
        </span>
        <span className="gym-rt-card-meta">{routineSummary(routine)}</span>
        <span className={`gym-rt-card-preview${preview ? '' : ' is-empty'}`}>{preview || 'No exercises yet. Tap to add some.'}</span>
      </button>
      <IconButton icon="more" label={`More for ${name}`} className="gym-rt-more" onClick={onMenu} />
      <div className="gym-rt-card-foot">
        <span className="gym-rt-card-last">
          <Icon name="history" size={15} />
          {lastDate ? `Last done ${timeAgo(lastDate, today)}` : 'Not done yet'}
        </span>
        <div className="gym-rt-card-actions">
          <button type="button" className="btn btn-secondary btn-sm gym-rt-edit" onClick={edit} aria-label={`Edit ${name}`} title="Edit">
            <Icon name="pencil" size={16} />
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onStart}>
            <Icon name="play" size={15} strokeWidth={2.2} />
            Start
            <span className="sr-only"> {name}</span>
          </button>
        </div>
      </div>
    </article>
  )
}

// ---- your split --------------------------------------------------------------------------------

// Which slot of `version` is today's (or tomorrow's, when it starts tomorrow or today is shifted).
function splitMarker(version, gym, sessions, today) {
  for (let offset = 0; offset < 2; offset++) {
    const date = addDays(today, offset)
    if (!date || version.effectiveFrom > date) continue
    const label = offset ? 'Tomorrow' : 'Today'
    if (version.mode === 'weekly') return { index: weekday(date), label }
    const day = resolveDay(gym, sessions, date, today)
    if (day.versionId === version.id && day.cycleIndex != null) return { index: day.cycleIndex, label }
  }
  return null
}

function SlotChip({ slot, gym }) {
  if (slot?.kind !== 'routine') return <RoutineChip routine={null} label="Rest" />
  return <RoutineChip routine={routineById(gym, slot.routineId)} />
}

function SplitCard({ gym, sessions, today, onEdit, onWizard }) {
  const { schedule, prefs } = gym
  const version = schedule.versions.length ? schedule.versions[schedule.versions.length - 1] : null
  const marker = useMemo(() => (version ? splitMarker(version, gym, sessions, today) : null), [version, gym, sessions, today])

  if (!version) {
    return (
      <section className="card gym-split" aria-label="Your split">
        <div className="gym-split-head">
          <div className="gym-split-heading">
            <span className="eyebrow">Your split</span>
            <h3>No schedule yet</h3>
          </div>
        </div>
        <p className="gym-split-sub">
          {gym.routines.length
            ? 'Choose which routine falls on each day: a rotation that repeats in order, or a fixed weekly plan.'
            : 'Type your split, like “push pull legs rest”, and the wizard creates the routines and the schedule.'}
        </p>
        <div className="wiz-split-actions">
          {gym.routines.length > 0 && <Button icon="calendar" onClick={onEdit} className="gym-split-cta">Set up schedule</Button>}
          <Button variant={gym.routines.length ? 'secondary' : 'primary'} icon="wand" onClick={onWizard}>Split wizard</Button>
        </div>
      </section>
    )
  }

  const firstWeekday = prefs.firstWeekday
  const rotation = version.mode === 'rotation'
  const slots = rotation ? version.cycle : version.weekly
  const workouts = slots.filter((slot) => slot.kind === 'routine').length
  const title = rotation ? (slots.length ? `${slots.length}-day rotation` : 'Rotation') : 'Weekly plan'
  const sub = rotation
    ? slots.length ? `${workouts} workout${workouts === 1 ? '' : 's'} per cycle · repeats in order, whatever the weekday` : 'No days in the rotation yet.'
    : `${workouts} workout${workouts === 1 ? '' : 's'} a week`
  const deloadEvery = schedule.deload.everyWeeks
  const deloadNow = isDeload(schedule, today, firstWeekday)
  const startsLater = version.effectiveFrom > today
  const weekOrder = Array.from({ length: 7 }, (_, i) => (firstWeekday + i) % 7)

  return (
    <section className="card gym-split" aria-label="Your split">
      <div className="gym-split-head">
        <div className="gym-split-heading">
          <span className="eyebrow">Your split</span>
          <h3>{title}</h3>
          <p className="gym-split-sub">{sub}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-label="Edit schedule">
          <Icon name="pencil" size={15} />
          Edit
        </button>
      </div>

      {rotation && slots.length > 0 && (
        <ol className="gym-split-cycle">
          {slots.map((slot, index) => {
            const marked = marker?.index === index
            return (
              // eslint-disable-next-line react/no-array-index-key
              <li key={index} className={marked ? 'is-marked' : undefined} aria-current={marked && marker.label === 'Today' ? 'date' : undefined}>
                <span className="gym-split-cap">{marked ? marker.label : `Day ${index + 1}`}</span>
                <SlotChip slot={slot} gym={gym} />
              </li>
            )
          })}
        </ol>
      )}

      {!rotation && (
        <ul className="gym-split-week">
          {weekOrder.map((day) => {
            const marked = marker?.index === day
            return (
              <li key={day} className={marked ? 'is-marked' : undefined} aria-current={marked && marker.label === 'Today' ? 'date' : undefined}>
                <span className="gym-split-dow">
                  {WEEKDAY_SHORT[day]}
                  {marked && <span className="sr-only"> ({marker.label.toLowerCase()})</span>}
                </span>
                <SlotChip slot={version.weekly[day]} gym={gym} />
              </li>
            )
          })}
        </ul>
      )}

      {(startsLater || deloadEvery > 0 || deloadNow || (rotation && !slots.length)) && (
        <div className="gym-split-meta">
          {startsLater && <span className="meta-chip is-accent"><Icon name="clock" size={13} />Starts {relativeDay(version.effectiveFrom, today).toLowerCase()}</span>}
          {deloadNow && <span className="meta-chip gym-split-deload"><Icon name="zap" size={13} />Deload week</span>}
          {deloadEvery > 0 && <span className="meta-chip"><Icon name="repeat" size={13} />Deload every {deloadEvery} weeks</span>}
          {rotation && !slots.length && (
            <button type="button" className="link-btn" onClick={onEdit}>Add days</button>
          )}
        </div>
      )}

      <button type="button" className="wiz-split-link" onClick={onWizard}>
        <Icon name="wand" size={18} />
        New split with the wizard
      </button>
    </section>
  )
}

// ---- templates -----------------------------------------------------------------------------------

function TemplateSheet({ open, onClose, today }) {
  const gym = useGym()
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    if (open) setPicked(null)
  }, [open])

  // Built once with throwaway ids, just to show what each template contains.
  const templates = useMemo(() => TEMPLATES.filter((template) => template.id !== 'custom').map((template) => {
    let n = 0
    const built = buildTemplate(template.id, today, () => `preview-${template.id}-${n++}`)
    const version = built.schedule.versions[0]
    const slots = version ? (version.mode === 'rotation' ? version.cycle : version.weekly) : []
    const workouts = slots.filter((slot) => slot.kind === 'routine').length
    const plan = version?.mode === 'rotation' ? `${slots.length}-day rotation` : `${workouts} days a week`
    return { ...template, routines: built.routines, plan }
  }), [today])

  const hasSchedule = gym.schedule.versions.length > 0
  const template = templates.find((item) => item.id === picked) || null

  const apply = () => {
    if (!template) return
    const result = buildTemplate(template.id, today, newGymId)
    const before = getGym().schedule
    try {
      applyTemplate(result)
    } catch (error) {
      toast(error?.message || 'Couldn’t add the template.', { tone: 'error' })
      return
    }
    const after = JSON.stringify(getGym().schedule)
    const ids = new Set(result.routines.map((routine) => routine.id))
    onClose()
    toast(`Added ${result.routines.map((routine) => routine.name).join(', ')}`, {
      action: {
        label: 'Undo',
        onClick: () => updateGym((current) => ({
          routines: current.routines.filter((routine) => !ids.has(routine.id)),
          // Put the old plan back only if nothing else changed it since.
          ...(JSON.stringify(current.schedule) === after ? { schedule: before } : {}),
        })),
      },
    })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={template ? template.name : 'Start from a template'}
      description={template ? template.plan : 'Ready-made routines and a schedule. You can edit everything afterwards.'}
      size="md"
      initialFocus={false}
      footer={template ? (
        <>
          <button type="button" className="btn btn-secondary btn-grow" onClick={() => setPicked(null)}>Back</button>
          <button type="button" className="btn btn-primary btn-grow" onClick={apply}>
            Add {template.routines.length} routine{template.routines.length === 1 ? '' : 's'}
          </button>
        </>
      ) : null}
    >
      {template ? (
        <div className="gym-tpl-confirm">
          <p className="gym-tpl-desc">{template.description}</p>
          <ul className="gym-tpl-routines">
            {template.routines.map((routine) => (
              <li key={routine.id}>
                <RoutineDot routine={routine} size={10} />
                <span className="gym-tpl-routine-name">{routine.name}</span>
                <span className="gym-tpl-routine-meta">{routineSummary(routine)}</span>
              </li>
            ))}
          </ul>
          <p className="gym-tpl-note">
            <Icon name="calendar" size={16} />
            <span>
              {hasSchedule
                ? 'These routines are added to yours, and your schedule switches to this split from today. Past days stay as they were.'
                : 'These routines are added and your schedule is set to this split from today.'}
            </span>
          </p>
        </div>
      ) : (
        <ul className="gym-tpl-list">
          {templates.map((item) => (
            <li key={item.id}>
              <button type="button" className="gym-tpl" onClick={() => setPicked(item.id)}>
                <span className="gym-tpl-head">
                  <span className="gym-tpl-name">{item.name}</span>
                  <Icon name="chevronRight" size={18} className="gym-tpl-chevron" />
                </span>
                <span className="gym-tpl-plan">{item.plan}</span>
                <span className="gym-tpl-chips">
                  {item.routines.map((routine) => <RoutineChip key={routine.id} routine={routine} />)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

// ---- folders -------------------------------------------------------------------------------------

function FolderSheet({ open, folder, onClose, onSaved }) {
  const [name, setName] = useState('')
  const formId = useId()

  useEffect(() => {
    if (open) setName(folder?.name || '')
  }, [open, folder])

  const submit = (event) => {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) return
    const saved = saveFolder(folder ? { ...folder, name: clean } : { name: clean })
    onClose()
    onSaved?.(saved)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={folder ? 'Rename folder' : 'New folder'}
      size="sm"
      footer={(
        <>
          <button type="button" className="btn btn-secondary btn-grow" onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="btn btn-primary btn-grow" disabled={!name.trim()}>{folder ? 'Save' : 'Create'}</button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit}>
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. PPL, Home workouts"
              maxLength={40}
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="done"
            />
          )}
        </Field>
      </form>
    </Sheet>
  )
}

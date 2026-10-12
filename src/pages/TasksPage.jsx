import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import { Button, EmptyState, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { UnderstoodChip, useQuickParse } from '../components/QuickParse.jsx'
import { useData, useStore } from '../lib/store.js'
import { archiveCompletedTasks, archiveTask, compareTasks, createTask, deleteTaskForever, restoreTask, unarchiveTasks, updateTask } from '../lib/planner.js'
import { addDaysISO, dueSentence, formatDateShort, toISO } from '../lib/dates.js'
import { useNow } from '../lib/environment.js'
import { timePassed } from '../lib/agenda.js'
import { useLinger } from '../lib/useLinger.js'
import { taskClashes } from '../lib/timing.js'
import { primeKeyboard } from '../lib/keyboard.js'
import { useSessionState } from '../lib/sessionState.js'
import '../components/tasks.css'

const VIEWS = [
  { id: 'open', label: 'To do' },
  { id: 'done', label: 'Completed' },
]
const ARCHIVED_SHOWN = 30

// #/tasks/<id> (a reminder notification's link) opens that task, ready to complete.
function linkedTaskId() {
  const match = window.location.hash.match(/^#\/?tasks\/([^/?#]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

const byRecent = (a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || ''))

export default function TasksPage({ loaded }) {
  const tasks = useData('tasks')
  const events = useData('events')
  const classes = useData('classes')
  // Kept while the app is open (lib/sessionState.js), so the tab comes back as it was left.
  const [view, setView] = useSessionState('tasks.view', 'open')
  const [query, setQuery] = useSessionState('tasks.query', '')
  const [sheet, setSheet] = useState(null) // { task?, defaults?, completeFirst?, fromDock?, pickDate? }
  // A row's tap opens its task; Later… → "Pick a date…" passes { pickDate: true } to go straight to the date.
  const openTask = (task, intent) => setSheet({ task, ...intent })
  const [linkedId, setLinkedId] = useState(linkedTaskId)
  const [allArchived, setAllArchived] = useState(false)
  const [dockKey, setDockKey] = useState(0) // bumping it empties the quick-add
  // Re-rendered every minute, so the groups (Overdue / Today / Tomorrow) move on at midnight
  // even when nothing else changes, e.g. the app left open overnight.
  const now = useNow(60000)
  const today = toISO(now)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const tomorrow = addDaysISO(today, 1)
  const weekEnd = addDaysISO(today, 7)
  const searchInput = useRef(null)

  const matches = (task) => !query.trim() || `${task.text} ${task.details || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  // A task ticked off in the list stays in its place for a moment, then folds away (lib/useLinger.js).
  // Done or not doesn't change how tasks sort, so it never moves while it lingers.
  const openIds = useMemo(() => active.filter((task) => !task.done).map((task) => task.id), [active])
  const doneIds = useMemo(() => active.filter((task) => task.done).map((task) => task.id), [active])
  const { lingering, leaving, onLeft } = useLinger(openIds, doneIds)
  const open = useMemo(() => active.filter((task) => !task.done && matches(task)).sort(compareTasks), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps
  const listed = useMemo(() => active.filter((task) => (!task.done || lingering.has(task.id)) && matches(task)).sort(compareTasks), [active, query, lingering]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => active.filter((task) => task.done && matches(task)).sort(byRecent), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps
  // "Overlaps ECON 101" on timed tasks from today on that clash with a class, an event or another
  // task (lib/timing.js). Not tied to the search, so typing doesn't recompute it.
  const clashes = useMemo(() => taskClashes({ tasks: active, events, classes, from: today }), [active, events, classes, today])
  const archived = useMemo(() => tasks.filter((task) => task.archived && matches(task)).sort(byRecent), [tasks, query]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const buckets = [
      { id: 'overdue', title: 'Overdue', tone: 'danger', items: [] },
      { id: 'today', title: 'Today', tone: 'accent', items: [] },
      { id: 'tomorrow', title: 'Tomorrow', items: [] },
      { id: 'week', title: 'Next 7 days', items: [] },
      { id: 'later', title: 'Later', items: [] },
      { id: 'someday', title: 'No date', items: [] },
    ]
    const byId = Object.fromEntries(buckets.map((bucket) => [bucket.id, bucket]))
    for (const task of listed) {
      if (!task.date) byId.someday.items.push(task)
      else if (task.date < today) byId.overdue.items.push(task)
      else if (task.date === today) byId.today.items.push(task)
      else if (task.date === tomorrow) byId.tomorrow.items.push(task)
      else if (task.date <= weekEnd) byId.week.items.push(task)
      else byId.later.items.push(task)
    }
    return buckets.filter((bucket) => bucket.items.length)
  }, [listed, today, tomorrow, weekEnd])

  // ---- #/tasks/<id> -------------------------------------------------------------------------------
  // A reminder tapped on a phone that hasn't synced since the task was made elsewhere: the cache
  // doesn't have it yet, so "deleted" is only said once the server has answered this session.
  const synced = useStore((state) => state.lastSyncedAt)
  useEffect(() => {
    const onHash = () => {
      const id = linkedTaskId()
      if (id) setLinkedId(id)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!linkedId) return
    // Back to the plain route, so the link doesn't open the task again and the tab behaves as usual.
    if (linkedTaskId()) window.history.replaceState(window.history.state, '', '#/tasks') // keeps the history depth (router.js)
    const task = tasks.find((item) => item.id === linkedId)
    if (task) {
      setSheet({ task, completeFirst: !task.done })
      setLinkedId(null)
    } else if (synced) {
      toast('That task isn’t here any more — it may have been deleted.')
      setLinkedId(null)
    }
  }, [linkedId, tasks, synced])

  // "N" and "/" on a computer (the shell's daybook:command): a new task, or the search field.
  useEffect(() => {
    const onCommand = (event) => {
      if (event.detail?.name === 'new-task') {
        event.preventDefault() // tells the shell this page took it
        setSheet({})
      } else if (event.detail?.name === 'search') {
        event.preventDefault()
        setView('open')
        searchInput.current?.focus()
      }
    }
    window.addEventListener('daybook:command', onCommand)
    return () => window.removeEventListener('daybook:command', onCommand)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions --------------------------------------------------------------------------------------
  function moveToToday(list) {
    const moved = list.map((task) => ({ id: task.id, date: task.date }))
    for (const task of list) updateTask(task.id, { date: today })
    const label = list.length === 1 ? `“${truncate(list[0].text, 28)}”` : `${list.length} tasks`
    toast(`Moved ${label} to today`, { action: { label: 'Undo', onClick: () => moved.forEach((item) => updateTask(item.id, { date: item.date })) } })
  }

  function clearCompleted() {
    // Only what the list shows: a search hides the other completed tasks.
    const ids = archiveCompletedTasks(query.trim() ? done.map((task) => task.id) : null)
    if (ids.length) toast(`Archived ${ids.length} completed task${ids.length === 1 ? '' : 's'}`, { action: { label: 'Undo', onClick: () => unarchiveTasks(ids) } })
  }

  function restore(task) {
    restoreTask(task.id)
    toast(`Moved “${truncate(task.text, 28)}” back to ${task.done ? 'Completed' : 'To do'}`, { action: { label: 'Undo', onClick: () => archiveTask(task.id) } })
  }

  async function removeForever(task) {
    const ok = await confirmAction({ title: 'Delete permanently?', message: `“${task.text}” will be gone for good.`, confirmLabel: 'Delete' })
    if (ok) deleteTaskForever(task.id)
  }

  const searching = !!query.trim()
  const archivedShown = allArchived ? archived : archived.slice(0, ARCHIVED_SHOWN)

  return (
    <div className="tasks-page">
      <div className="tk-body">
        <header className="page-header page-header-row">
          <div>
            <h1>Tasks</h1>
            {/* Counts every open task; a search (kept across tabs) only adds how many it shows. */}
            <p className="page-subtitle">{openIds.length === 0 ? 'All clear' : `${openIds.length} to do${query.trim() ? ` · ${open.length} shown` : ''}`}</p>
          </div>
          <Button
            icon="plus"
            onClick={() => {
              primeKeyboard() // the sheet opens with the keyboard already up
              setSheet({})
            }}
          >
            New task
          </Button>
        </header>

        <div className="toolbar tk-toolbar">
          <Segmented options={VIEWS.map((item) => ({ ...item, label: item.id === 'done' && done.length ? `${item.label} · ${done.length}` : item.label }))} value={view} onChange={setView} label="Show" />
          <label className="search-field">
            <Icon name="search" size={18} />
            <input ref={searchInput} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
          </label>
        </div>

        {!loaded ? <Skeleton lines={5} /> : view === 'open' ? (
          groups.length === 0 ? (
            <EmptyState
              icon="tasks"
              title={query ? 'No matching tasks' : 'You’re all caught up'}
              action={!query && <Button variant="secondary" icon="plus" onClick={() => document.getElementById('tk-quick-input')?.focus()}>Add a task</Button>}
            >
              {query ? 'Try a different search.' : 'Enjoy it — or add the next thing on your mind.'}
            </EmptyState>
          ) : groups.map((group) => (
            <section key={group.id} className="task-group">
              <div className="group-title-row">
                <h2 className={`group-title ${group.tone ? `is-${group.tone}` : ''}`}>
                  {group.title}
                  <span className="count">{group.items.filter((task) => !task.done).length || group.items.length}</span>
                </h2>
                {group.id === 'overdue' && group.items.filter((task) => !task.done).length > 1 && (
                  <button type="button" className="link-btn" onClick={() => moveToToday(group.items.filter((task) => !task.done))}>Move all to today</button>
                )}
              </div>
              <ul className="task-list card-list">
                {group.items.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpen={openTask}
                    showDate={group.id !== 'today' && group.id !== 'tomorrow'}
                    overdueGroup={group.id === 'overdue'}
                    passed={group.id === 'today' && timePassed(task, today, nowMinutes)}
                    leaving={leaving.has(task.id)}
                    onLeft={onLeft}
                    overlap={clashes[task.id]}
                    trailing={group.id === 'overdue' && !task.done ? (
                      <button type="button" className="tk-chip-today" onClick={() => moveToToday([task])} aria-label={`Move “${task.text}” to today`}>Today</button>
                    ) : null}
                  />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <>
            {done.length === 0 ? (
              <EmptyState icon="check" title={query ? 'No matching tasks' : 'Nothing completed yet'}>
                {query ? 'Try a different search.' : 'Finished tasks show up here until you archive them.'}
              </EmptyState>
            ) : (
              <section className="task-group">
                <div className="group-title-row">
                  <h2 className="group-title">Completed <span className="count">{done.length}</span></h2>
                  <button type="button" className="link-btn" onClick={clearCompleted}>Archive all</button>
                </div>
                <ul className="task-list card-list">
                  {done.map((task) => <TaskRow key={task.id} task={task} onOpen={openTask} />)}
                </ul>
              </section>
            )}

            {archived.length > 0 && (
              <section className="task-group tk-archived">
                {/* A search shows matching archived tasks too (remounted open while it lasts). */}
                <Disclosure
                  key={searching ? 'search' : 'browse'}
                  id="tasks-archived"
                  className="tk-archived-fold"
                  label={<><Icon name="archive" size={17} />Archived</>}
                  summary={`${archived.length} task${archived.length === 1 ? '' : 's'}`}
                  defaultOpen={searching}
                >
                  <p className="tk-arch-hint">Archived tasks are out of the way but kept. Restore one, or delete it for good.</p>
                  <ul className="card-list tk-archived-list">
                    {archivedShown.map((task) => (
                      <li key={task.id} className="tk-arch-row">
                        <span className="tk-arch-text">
                          <span className="tk-arch-title">{task.text}</span>
                          {task.date && <small>{formatDateShort(task.date)}</small>}
                        </span>
                        <Button variant="secondary" size="sm" onClick={() => restore(task)}>Restore</Button>
                        <button type="button" className="icon-btn icon-btn-sm tk-arch-delete" onClick={() => removeForever(task)} aria-label={`Delete “${task.text}” permanently`} title="Delete permanently">
                          <Icon name="trash" size={16} />
                        </button>
                      </li>
                    ))}
                    {archived.length > archivedShown.length && (
                      <li className="tk-arch-more">
                        <button type="button" className="link-btn" onClick={() => setAllArchived(true)}>Show all {archived.length}</button>
                      </li>
                    )}
                  </ul>
                </Disclosure>
              </section>
            )}
          </>
        )}
      </div>

      <QuickAddDock
        key={dockKey}
        today={today}
        onAdded={() => setView('open')}
        onMore={(defaults) => setSheet({ defaults, fromDock: true })}
      />

      <TaskSheet
        open={!!sheet}
        task={sheet?.task || null}
        defaults={sheet?.defaults}
        completeFirst={!!sheet?.completeFirst}
        pickingDate={!!sheet?.pickDate}
        onSaved={sheet?.fromDock ? () => setDockKey((key) => key + 1) : undefined}
        onClose={() => setSheet(null)}
      />
    </div>
  )
}

// ---- quick add, docked at the bottom on phones ------------------------------------------------------
// Understands a day and time typed at the start or end ("Call mom tomorrow 5pm") and shows it as a
// chip; tapping the chip keeps those words in the title instead. Without one, Today/Tomorrow chips
// appear once there's text. The + opens the full form with what's been typed so far (the page
// remounts the dock, emptying it, once that form saves).

function QuickAddDock({ today, onAdded, onMore }) {
  const [text, setText] = useState('')
  const [pickedDate, setPickedDate] = useState('')
  // A time typed on its own ("5pm") stays on the day picked here (Tomorrow).
  const quick = useQuickParse(text, true, pickedDate)
  const { understood } = quick
  const input = useRef(null)
  const tomorrow = addDaysISO(today, 1)
  const typing = text.trim().length > 0

  const reset = () => {
    setText('')
    setPickedDate('')
    quick.reset()
  }

  // An "!!" on its own (no day or time) keeps the day picked here.
  const fields = () => (understood
    ? { text: understood.title, date: understood.date || pickedDate, time: understood.time, ...(understood.priority ? { priority: understood.priority } : {}) }
    : { text: text.trim(), date: pickedDate, time: '' })

  function submit(event) {
    event.preventDefault()
    if (!typing) return
    const values = fields()
    const task = createTask(values)
    reset()
    onAdded?.(task)
    if (task.date) toast(`Added for ${dueSentence(task.date, task.time, today)}`, { action: { label: 'Undo', onClick: () => deleteTaskForever(task.id) } })
    // The key reads "Done", so on phones the keyboard goes away; on desktop keep typing.
    if (window.matchMedia?.('(pointer: coarse)').matches) input.current?.blur()
  }

  return (
    <div className="tk-dock">
      <form className="quick-add tk-quick" onSubmit={submit}>
        <button
          type="button"
          className="tk-quick-more"
          onClick={() => onMore(typing ? fields() : {})}
          aria-label={typing ? 'Add details (opens the full form)' : 'New task with details'}
          title="More options"
        >
          {/* Not a "+": the header already has one, and this opens the full form ("details"). */}
          <Icon name="pencil" size={19} strokeWidth={2.1} />
        </button>
        <input
          ref={input}
          id="tk-quick-input"
          className="quick-add-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add a task — try “fri 5pm”"
          aria-label="Add a task"
          aria-describedby={typing ? 'tk-quick-hint' : undefined}
          enterKeyHint="done"
          autoComplete="off"
        />
        {typing && <button type="submit" className="btn btn-primary btn-sm">Add</button>}
      </form>

      {typing && (
        <div className="tk-dock-chips" id="tk-quick-hint" aria-live="polite">
          {understood && <UnderstoodChip understood={understood} today={today} onDismiss={quick.dismiss} />}
          {/* Only "urgent" understood (no day or time): Today / Tomorrow still offered beside it. */}
          {!understood?.date && (
            [{ id: today, label: 'Today' }, { id: tomorrow, label: 'Tomorrow' }].map((option) => (
              <button
                key={option.id}
                type="button"
                className={`chip chip-sm ${pickedDate === option.id ? 'is-active' : ''}`}
                aria-pressed={pickedDate === option.id}
                onClick={() => setPickedDate(pickedDate === option.id ? '' : option.id)}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

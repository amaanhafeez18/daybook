import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import { Button, EmptyState, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { useData, useStore } from '../lib/store.js'
import { archiveCompletedTasks, archiveTask, compareTasks, createTask, deleteTaskForever, restoreTask, unarchiveTasks, updateTask } from '../lib/planner.js'
import { addDaysISO, dueSentence, formatDateShort, formatDue, parseQuickAdd, toISO } from '../lib/dates.js'
import { useNow } from '../lib/environment.js'
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
  const [view, setView] = useState('open')
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState(null) // { task?, defaults?, completeFirst?, fromDock? }
  const [linkedId, setLinkedId] = useState(linkedTaskId)
  const [allArchived, setAllArchived] = useState(false)
  const [dockKey, setDockKey] = useState(0) // bumping it empties the quick-add
  // Re-rendered every minute, so the groups (Overdue / Today / Tomorrow) move on at midnight
  // even when nothing else changes, e.g. the app left open overnight.
  const today = toISO(useNow(60000))
  const tomorrow = addDaysISO(today, 1)
  const weekEnd = addDaysISO(today, 7)

  const matches = (task) => !query.trim() || `${task.text} ${task.details || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const open = useMemo(() => active.filter((task) => !task.done && matches(task)).sort(compareTasks), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => active.filter((task) => task.done && matches(task)).sort(byRecent), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps
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
    for (const task of open) {
      if (!task.date) byId.someday.items.push(task)
      else if (task.date < today) byId.overdue.items.push(task)
      else if (task.date === today) byId.today.items.push(task)
      else if (task.date === tomorrow) byId.tomorrow.items.push(task)
      else if (task.date <= weekEnd) byId.week.items.push(task)
      else byId.later.items.push(task)
    }
    return buckets.filter((bucket) => bucket.items.length)
  }, [open, today, tomorrow, weekEnd])

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
    if (linkedTaskId()) window.history.replaceState(null, '', '#/tasks')
    const task = tasks.find((item) => item.id === linkedId)
    if (task) {
      setSheet({ task, completeFirst: !task.done })
      setLinkedId(null)
    } else if (synced) {
      toast('That task isn’t here any more — it may have been deleted.')
      setLinkedId(null)
    }
  }, [linkedId, tasks, synced])

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
            <p className="page-subtitle">{open.length === 0 ? 'All clear' : `${open.length} to do`}</p>
          </div>
          <Button icon="plus" onClick={() => setSheet({})}>New task</Button>
        </header>

        <div className="toolbar tk-toolbar">
          <Segmented options={VIEWS.map((item) => ({ ...item, label: item.id === 'done' && done.length ? `${item.label} · ${done.length}` : item.label }))} value={view} onChange={setView} label="Show" />
          <label className="search-field">
            <Icon name="search" size={18} />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
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
                  <span className="count">{group.items.length}</span>
                </h2>
                {group.id === 'overdue' && group.items.length > 1 && (
                  <button type="button" className="link-btn" onClick={() => moveToToday(group.items)}>Move all to today</button>
                )}
              </div>
              <ul className="task-list card-list">
                {group.items.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpen={(item) => setSheet({ task: item })}
                    showDate={group.id !== 'today' && group.id !== 'tomorrow'}
                    trailing={group.id === 'overdue' ? (
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
                  {done.map((task) => <TaskRow key={task.id} task={task} onOpen={(item) => setSheet({ task: item })} />)}
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
  const [ignored, setIgnored] = useState('') // the parse the user dismissed, by its words
  const input = useRef(null)
  const tomorrow = addDaysISO(today, 1)

  const parsed = useMemo(() => parseQuickAdd(text, new Date()), [text])
  const parseKey = parsed.matched.map((span) => span.text.toLowerCase()).join('|')
  const understood = parsed.matched.length > 0 && parseKey !== ignored ? parsed : null
  const typing = text.trim().length > 0

  const reset = () => {
    setText('')
    setPickedDate('')
    setIgnored('')
  }

  const fields = () => (understood
    ? { text: understood.title, date: understood.date, time: understood.time }
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

  const understoodLabel = understood ? formatDue(understood.date, understood.time, today) : ''
  const heard = understood ? understood.matched.map((span) => span.text).join(' … ') : ''

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
          <Icon name="plus" size={20} strokeWidth={2.2} />
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
          {understood ? (
            <button
              type="button"
              className="chip chip-sm is-active tk-parsed"
              onClick={() => setIgnored(parseKey)}
              aria-label={`Due ${understoodLabel.replace(' · ', ' at ')}, from “${heard}”. Tap to keep those words in the title instead.`}
            >
              <Icon name="calendar" size={14} strokeWidth={2.1} />
              <span>{understoodLabel}</span>
              <Icon name="close" size={13} strokeWidth={2.4} className="tk-parsed-x" />
            </button>
          ) : (
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

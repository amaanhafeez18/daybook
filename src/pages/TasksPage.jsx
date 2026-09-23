import { useMemo, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { Button, EmptyState, Segmented, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { useData } from '../lib/store.js'
import { archiveCompletedTasks, compareTasks, createTask, unarchiveTasks } from '../lib/planner.js'
import { addDaysISO, todayISO } from '../lib/dates.js'

const VIEWS = [
  { id: 'open', label: 'To do' },
  { id: 'done', label: 'Completed' },
]

export default function TasksPage({ loaded }) {
  const tasks = useData('tasks')
  const [view, setView] = useState('open')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [quickText, setQuickText] = useState('')
  const [quickDate, setQuickDate] = useState('')
  const today = todayISO()
  const tomorrow = addDaysISO(today, 1)
  const weekEnd = addDaysISO(today, 7)

  const matches = (task) => !query.trim() || `${task.text} ${task.details || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const open = useMemo(() => active.filter((task) => !task.done && matches(task)).sort(compareTasks), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => active.filter((task) => task.done && matches(task)).sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || ''))), [active, query]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function quickAdd(event) {
    event.preventDefault()
    const text = quickText.trim()
    if (!text) return
    createTask({ text, date: quickDate })
    setQuickText('')
    toast(quickDate === today ? 'Added to today' : quickDate === tomorrow ? 'Added for tomorrow' : 'Task added')
  }

  function clearCompleted() {
    // Only what the list shows: a search hides the other completed tasks.
    const ids = archiveCompletedTasks(query.trim() ? done.map((task) => task.id) : null)
    if (ids.length) toast(`Archived ${ids.length} completed task${ids.length === 1 ? '' : 's'}`, { action: { label: 'Undo', onClick: () => unarchiveTasks(ids) } })
  }

  return (
    <div className="tasks-page">
      <header className="page-header page-header-row">
        <div>
          <h1>Tasks</h1>
          <p className="page-subtitle">{open.length === 0 ? 'All clear' : `${open.length} to do`}</p>
        </div>
        <Button icon="plus" onClick={() => setEditing({})}>New task</Button>
      </header>

      <form className="quick-add" onSubmit={quickAdd}>
        <Icon name="plus" size={20} />
        <input
          className="quick-add-input"
          value={quickText}
          onChange={(event) => setQuickText(event.target.value)}
          placeholder="Add a task…"
          aria-label="Add a task"
          enterKeyHint="done"
        />
        <div className="quick-add-chips">
          {[{ id: today, label: 'Today' }, { id: tomorrow, label: 'Tomorrow' }].map((option) => (
            <button key={option.id} type="button" className={`chip chip-sm ${quickDate === option.id ? 'is-active' : ''}`} aria-pressed={quickDate === option.id} onClick={() => setQuickDate(quickDate === option.id ? '' : option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        {quickText.trim() && <button type="submit" className="btn btn-primary btn-sm">Add</button>}
      </form>

      <div className="toolbar">
        <Segmented options={VIEWS.map((item) => ({ ...item, label: item.id === 'done' && done.length ? `${item.label} · ${done.length}` : item.label }))} value={view} onChange={setView} label="Show" />
        <label className="search-field">
          <Icon name="search" size={18} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search tasks" />
        </label>
      </div>

      {!loaded ? <Skeleton lines={5} /> : view === 'open' ? (
        groups.length === 0 ? (
          <EmptyState
            icon="tasks"
            title={query ? 'No matching tasks' : 'You’re all caught up'}
            action={!query && <Button variant="secondary" icon="plus" onClick={() => setEditing({})}>Add a task</Button>}
          >
            {query ? 'Try a different search.' : 'Enjoy it — or add the next thing on your mind.'}
          </EmptyState>
        ) : groups.map((group) => (
          <section key={group.id} className="task-group">
            <h2 className={`group-title ${group.tone ? `is-${group.tone}` : ''}`}>
              {group.title}
              <span className="count">{group.items.length}</span>
            </h2>
            <ul className="task-list card-list">
              {group.items.map((task) => <TaskRow key={task.id} task={task} onOpen={setEditing} showDate={group.id !== 'today' && group.id !== 'tomorrow'} />)}
            </ul>
          </section>
        ))
      ) : done.length === 0 ? (
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
            {done.map((task) => <TaskRow key={task.id} task={task} onOpen={setEditing} />)}
          </ul>
        </section>
      )}

      <TaskSheet open={!!editing} task={editing?.id ? editing : null} onClose={() => setEditing(null)} />
    </div>
  )
}

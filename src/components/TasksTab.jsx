import { useEffect, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

const EMPTY_FORM = {
  text: '',
  details: '',
  date: '',
  time: '',
  priority: 'medium',
}

export default function TasksTab() {
  const [tasks, setTasks] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  useEffect(() => {
    let active = true
    load('tasks', []).then((data) => {
      if (active) setTasks(data)
    })
    return () => { active = false }
  }, [])

  function persist(next) {
    setTasks(next)
    save('tasks', next)
  }

  function addTask(e) {
    e.preventDefault()
    const trimmed = form.text.trim()
    if (!trimmed) return

    const task = {
      id: uid(),
      text: trimmed,
      details: form.details.trim(),
      done: false,
      createdAt: Date.now(),
      date: form.date || todayISO(),
      time: form.time || '',
      priority: form.priority,
    }

    persist([task, ...tasks])
    setForm(EMPTY_FORM)
    setShowAdd(false)

    if (task.date) {
      const calendarEvents = load('events', [])
      calendarEvents.then((events) => {
        const exists = events.some((event) => event.title === trimmed && event.date === task.date && event.time === task.time)
        if (!exists) {
          save('events', [
            { id: uid(), date: task.date, time: task.time, title: trimmed },
            ...events,
          ])
        }
      })
    }
  }

  function toggle(id) {
    persist(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  }

  function remove(id) {
    persist(tasks.filter((t) => t.id !== id))
  }

  const open = tasks.filter((t) => !t.done)
  const done = tasks.filter((t) => t.done)
  const weekTasks = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayISO(), index)
    return { date, tasks: open.filter((task) => task.date === date) }
  }).filter((day) => day.tasks.length > 0)

  return (
    <section className="tab-panel">
      <div className="friends-header">
        <h2 className="section-label">Tasks</h2>
        <button className="btn-accent" onClick={() => setShowAdd(true)}>Add task</button>
      </div>

      <div className="week-overview">
        <div className="section-heading-row">
          <h2 className="section-label">Next 7 days</h2>
          <span className="muted-count">{open.length} open</span>
        </div>
        {weekTasks.length === 0 ? (
          <p className="empty-note">No open tasks scheduled in the next 7 days.</p>
        ) : (
          <div className="week-list">
            {weekTasks.map((day) => (
              <div className="week-day" key={day.date}>
                <strong>{formatDay(day.date)}</strong>
                {day.tasks.map((task) => (
                  <span className={`week-task priority-${task.priority || 'medium'}`} key={task.id}>
                    {task.text}{task.time ? ` · ${task.time}` : ''}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <div className="friend-modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="friend-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add task</h3>
              <button type="button" className="row-delete" onClick={() => setShowAdd(false)}>×</button>
            </div>

            <form className="friend-form" onSubmit={addTask}>
              <input
                type="text"
                placeholder="Task name"
                value={form.text}
                onChange={(e) => setForm((prev) => ({ ...prev, text: e.target.value }))}
              />
              <textarea
                rows="3"
                placeholder="Further details (optional)"
                value={form.details}
                onChange={(e) => setForm((prev) => ({ ...prev, details: e.target.value }))}
              />
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
              />
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value }))}
              />
              <select
                value={form.priority}
                onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
              >
                <option value="urgent">Urgent priority</option>
                <option value="medium">Medium priority</option>
                <option value="low">Low priority</option>
              </select>
              <div className="friend-modal-actions">
                <button type="button" className="btn-small btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn-small">Save task</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tasks.length === 0 && (
        <p className="empty-note">Nothing on the list yet. Add the first thing you need to do.</p>
      )}

      {open.length > 0 && (
        <ul className="task-list">
          {open.map((t) => (
            <li key={t.id} className="task-row">
              <button className="checkbox" aria-label="Mark done" onClick={() => toggle(t.id)} />
              <div className="task-main">
                <span className="task-text">{t.text}</span>
                {t.details && <span className="task-details">{t.details}</span>}
                {(t.date || t.time) && (
                  <span className="task-date-line">
                    {t.date ? formatDate(t.date) : ''}{t.date && t.time ? ' · ' : ''}{t.time || ''}
                  </span>
                )}
              </div>
              <span className={`priority-badge priority-${t.priority || 'medium'}`}>{priorityLabel(t.priority)}</span>
              <button className="row-delete" aria-label="Delete task" onClick={() => remove(t.id)}>×</button>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <>
          <h2 className="section-label">Done</h2>
          <ul className="task-list">
            {done.map((t) => (
              <li key={t.id} className="task-row is-done">
                <button className="checkbox is-checked" aria-label="Mark not done" onClick={() => toggle(t.id)} />
                <div className="task-main">
                  <span className="task-text">{t.text}</span>
                  {t.details && <span className="task-details">{t.details}</span>}
                  {(t.date || t.time) && (
                    <span className="task-date-line">
                      {t.date ? formatDate(t.date) : ''}{t.date && t.time ? ' · ' : ''}{t.time || ''}
                    </span>
                  )}
                </div>
                <span className={`priority-badge priority-${t.priority || 'medium'}`}>{priorityLabel(t.priority)}</span>
                <button className="row-delete" aria-label="Delete task" onClick={() => remove(t.id)}>×</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function formatDate(iso) {
  if (!iso) return ''
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function addDays(iso, delta) {
  const date = new Date(`${iso}T12:00:00`)
  date.setDate(date.getDate() + delta)
  return date.toISOString().slice(0, 10)
}

function formatDay(iso) {
  const date = new Date(`${iso}T12:00:00`)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function priorityLabel(priority) {
  if (priority === 'urgent') return 'Urgent'
  if (priority === 'low') return 'Low'
  return 'Medium'
}

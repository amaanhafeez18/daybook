import { useEffect, useState } from 'react'
import { load, save, uid, todayISO } from '../lib/storage.js'

const EMPTY_FORM = {
  text: '',
  date: '',
  time: '',
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
      done: false,
      createdAt: Date.now(),
      date: form.date || todayISO(),
      time: form.time || '',
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

  return (
    <section className="tab-panel">
      <div className="friends-header">
        <h2 className="section-label">Tasks</h2>
        <button className="btn-accent" onClick={() => setShowAdd(true)}>Add task</button>
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
                {(t.date || t.time) && (
                  <span className="task-date-line">
                    {t.date ? formatDate(t.date) : ''}{t.date && t.time ? ' · ' : ''}{t.time || ''}
                  </span>
                )}
              </div>
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
                  {(t.date || t.time) && (
                    <span className="task-date-line">
                      {t.date ? formatDate(t.date) : ''}{t.date && t.time ? ' · ' : ''}{t.time || ''}
                    </span>
                  )}
                </div>
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

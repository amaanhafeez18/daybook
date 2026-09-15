import { useState } from 'react'
import { load, save, uid } from '../lib/storage.js'

export default function TasksTab() {
  const [tasks, setTasks] = useState(() => load('tasks', []))
  const [text, setText] = useState('')

  function persist(next) {
    setTasks(next)
    save('tasks', next)
  }

  function addTask(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    persist([{ id: uid(), text: trimmed, done: false, createdAt: Date.now() }, ...tasks])
    setText('')
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
      <form className="add-row" onSubmit={addTask}>
        <input
          type="text"
          placeholder="Add a task"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn-accent">Add</button>
      </form>

      {tasks.length === 0 && (
        <p className="empty-note">Nothing on the list yet. Add the first thing you need to do.</p>
      )}

      {open.length > 0 && (
        <ul className="task-list">
          {open.map((t) => (
            <li key={t.id} className="task-row">
              <button className="checkbox" aria-label="Mark done" onClick={() => toggle(t.id)} />
              <span className="task-text">{t.text}</span>
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
                <span className="task-text">{t.text}</span>
                <button className="row-delete" aria-label="Delete task" onClick={() => remove(t.id)}>×</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

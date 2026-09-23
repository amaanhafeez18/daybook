import { useEffect, useRef, useState } from 'react'
import Sheet from './ui/Sheet.jsx'
import { AutoTextarea, Button, Field, Segmented } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { archiveTask, createTask, isReminderMarker, restoreTask, setTaskDone, updateTask } from '../lib/planner.js'
import { addDaysISO, todayISO } from '../lib/dates.js'
import { LEAD_OPTIONS, leadLabel, notificationPrefs } from '../lib/notifications.js'
import { useData } from '../lib/store.js'

const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Normal' },
  { id: 'urgent', label: 'Urgent' },
]

const EMPTY = { text: '', details: '', date: '', time: '', priority: 'medium', reminderMinutes: '' }

// The reminder a task will actually get, as a select value. Mirrors api/_reminders.js:
// negative = none; without a time only 0 (on the day) and >= 1440 (day before) apply, anything
// else falls back to the default.
function effectiveReminder(value, timed) {
  if (value === '' || value == null) return ''
  const minutes = Number(value)
  if (!Number.isInteger(minutes)) return ''
  if (minutes < 0) return '-1'
  if (!timed) return minutes >= 1440 ? '1440' : minutes === 0 ? '0' : ''
  return String(minutes)
}

// Create a task (task = null) or edit an existing one.
export default function TaskSheet({ open, onClose, task: taskProp = null, defaults = {} }) {
  // Keep the last task while the sheet animates closed, so it doesn't switch to the "New task" layout.
  const shownTask = useRef(taskProp)
  if (open) shownTask.current = taskProp
  const task = shownTask.current
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const prefs = notificationPrefs(useData('settings'))

  useEffect(() => {
    if (!open) return
    setError('')
    setForm(task
      ? { text: task.text || '', details: isReminderMarker(task.details) ? '' : task.details || '', date: task.date || '', time: task.time || '', priority: task.priority || 'medium', reminderMinutes: Number.isInteger(task.reminderMinutes) ? String(task.reminderMinutes) : '' }
      : { ...EMPTY, ...defaults })
  }, [open, task?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }))
  const reminderValue = effectiveReminder(form.reminderMinutes, Boolean(form.time))
  const customLead = form.time && reminderValue !== '' && !LEAD_OPTIONS.some((option) => String(option.value) === reminderValue)
  const today = todayISO()
  const quickDates = [
    { id: today, label: 'Today' },
    { id: addDaysISO(today, 1), label: 'Tomorrow' },
    { id: addDaysISO(today, 7), label: 'Next week' },
  ]

  function submit(event) {
    event.preventDefault()
    const text = form.text.trim()
    if (!text) {
      setError('Give the task a name.')
      return
    }
    const fields = { ...form, text, details: form.details.trim(), reminderMinutes: reminderValue === '' ? null : Number(reminderValue) }
    if (task) {
      // Keep the internal reminder marker if the user didn't add notes of their own.
      if (isReminderMarker(task.details) && !fields.details) fields.details = task.details
      updateTask(task.id, fields)
      toast('Task updated')
    } else {
      createTask(fields)
      toast(fields.date ? `Added for ${quickDates.find((item) => item.id === fields.date)?.label.toLowerCase() || fields.date}` : 'Task added')
    }
    onClose()
  }

  function archive() {
    archiveTask(task.id)
    onClose()
    toast('Task archived', { action: { label: 'Undo', onClick: () => restoreTask(task.id) } })
  }

  function toggleDone() {
    setTaskDone(task.id, !task.done)
    onClose()
    toast(task.done ? 'Marked as not done' : 'Completed', { action: { label: 'Undo', onClick: () => setTaskDone(task.id, task.done) } })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      footer={(
        <>
          {task && <Button variant="ghost" icon="archive" onClick={archive}>Archive</Button>}
          {task && <Button variant="secondary" icon={task.done ? 'undo' : 'check'} onClick={toggleDone}>{task.done ? 'Reopen' : 'Complete'}</Button>}
          <Button type="submit" form="task-form" className="btn-grow">{task ? 'Save' : 'Add task'}</Button>
        </>
      )}
    >
      <form id="task-form" className="form-stack" onSubmit={submit}>
        <Field label="Task" error={error}>
          {(id) => <input id={id} className="input input-lg" value={form.text} onChange={(event) => { set('text')(event.target.value); setError('') }} placeholder="What needs doing?" autoComplete="off" enterKeyHint="done" data-autofocus />}
        </Field>
        <Field label="Notes">
          {(id) => <AutoTextarea id={id} value={form.details} onChange={(event) => set('details')(event.target.value)} placeholder="Add details (optional)" minRows={2} maxRows={8} />}
        </Field>
        <div className="field">
          <span className="field-label">Due</span>
          <div className="chip-row">
            {quickDates.map((item) => (
              <button key={item.id} type="button" className={`chip ${form.date === item.id ? 'is-active' : ''}`} onClick={() => set('date')(form.date === item.id ? '' : item.id)}>
                {item.label}
              </button>
            ))}
            {form.date && <button type="button" className="chip chip-quiet" onClick={() => setForm((current) => ({ ...current, date: '', time: '' }))}>No date</button>}
          </div>
          <div className="field-row">
            <input className="input" type="date" value={form.date} onChange={(event) => set('date')(event.target.value)} aria-label="Due date" />
            <input className="input" type="time" value={form.time} onChange={(event) => set('time')(event.target.value)} aria-label="Time" disabled={!form.date} />
          </div>
        </div>
        {form.date && (
          <Field label="Reminder">
            {(id) => (
              <select id={id} className="input" value={reminderValue} onChange={(event) => set('reminderMinutes')(event.target.value)}>
                {form.time ? (
                  <>
                    <option value="">Default ({(LEAD_OPTIONS.find((option) => option.value === Number(prefs.taskLead)) || LEAD_OPTIONS[3]).label.toLowerCase()})</option>
                    {LEAD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    {customLead && <option value={reminderValue}>{leadLabel(Number(reminderValue))}</option>}
                  </>
                ) : (
                  <>
                    <option value="">Default ({prefs.allDayTime ? `${prefs.allDayMode === 'before' ? 'day before' : 'on the day'} at ${prefs.allDayTime}` : 'none'})</option>
                    <option value="0">On the day{prefs.allDayTime ? ` at ${prefs.allDayTime}` : ''}</option>
                    <option value="1440">The day before</option>
                    <option value="-1">No reminder</option>
                  </>
                )}
              </select>
            )}
          </Field>
        )}
        <div className="field">
          <span className="field-label" id="priority-label">Priority</span>
          <Segmented options={PRIORITIES} value={form.priority} onChange={set('priority')} label="Priority" />
        </div>
      </form>
    </Sheet>
  )
}

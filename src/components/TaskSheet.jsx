import { useEffect, useRef, useState } from 'react'
import Sheet from './ui/Sheet.jsx'
import Disclosure from './ui/Disclosure.jsx'
import { AutoTextarea, Button, Field, Segmented } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { archiveTask, createTask, deleteTaskForever, isReminderMarker, restoreTask, setTaskDone, updateTask } from '../lib/planner.js'
import { addDaysISO, dueSentence, formatTime, todayISO } from '../lib/dates.js'
import { LEAD_OPTIONS, leadLabel, notificationPrefs } from '../lib/notifications.js'
import { useData } from '../lib/store.js'
import './tasks.css'

const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Normal' },
  { id: 'urgent', label: 'Urgent' },
]

const EMPTY = { text: '', details: '', date: '', time: '', priority: 'medium', reminderMinutes: '' }

// What the sheet calls the thing: the Tasks page and Today say "task"; the calendar says "event"
// (a dated task and its calendar event are the same record, kept in step by lib/planner.js).
const NOUNS = {
  task: { title: 'task', label: 'Task', when: 'Due', placeholder: 'What needs doing?', add: 'Add task' },
  event: { title: 'event', label: 'Event', when: 'When', placeholder: 'e.g. Dentist, Coffee with Sara', add: 'Add event' },
}

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

// Short reminder wording for the "More options" summary: "15 min before", "Day before".
function shortReminder(value, timed) {
  if (value === '') return ''
  const minutes = Number(value)
  if (minutes < 0) return 'No reminder'
  if (!timed) return minutes >= 1440 ? 'Day before' : 'On the day'
  if (minutes === 0) return 'At the time'
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Day before' : `${minutes / 1440} days before`
  if (minutes % 60 === 0) return `${minutes / 60} h before`
  return `${minutes} min before`
}

// Create a task (task = null) or edit an existing one.
// completeFirst: opened to tick it off (e.g. from its reminder), so Complete is the main button.
// onSaved(task): after Save / Add task. noun: 'task' (default) or 'event' (the calendar).
export default function TaskSheet({ open, onClose, task: taskProp = null, defaults = {}, completeFirst = false, onSaved, noun = 'task' }) {
  // Keep the last task while the sheet animates closed, so it doesn't switch to the "New task" layout.
  const shown = useRef({ task: taskProp, completeFirst })
  if (open) shown.current = { task: taskProp, completeFirst }
  const task = shown.current.task
  const readyToComplete = Boolean(shown.current.completeFirst && task && !task.done)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const prefs = notificationPrefs(useData('settings'))
  const words = NOUNS[noun] || NOUNS.task

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

  // Priority, reminder and notes live behind "More options"; the summary says what's set there.
  const extras = [
    form.priority !== 'medium' && (PRIORITIES.find((item) => item.id === form.priority)?.label || ''),
    form.date && shortReminder(reminderValue, Boolean(form.time)),
    form.details.trim() && 'Notes',
  ].filter(Boolean)
  const hasExtras = extras.length > 0

  function submit(event) {
    event.preventDefault()
    const text = form.text.trim()
    if (!text) {
      setError(`Give the ${words.title} a name.`)
      return
    }
    const fields = { ...form, text, details: form.details.trim(), reminderMinutes: reminderValue === '' ? null : Number(reminderValue) }
    if (task) {
      // Keep the internal reminder marker if the user didn't add notes of their own.
      if (isReminderMarker(task.details) && !fields.details) fields.details = task.details
      onSaved?.(updateTask(task.id, fields))
    } else {
      const created = createTask(fields)
      // A dated task may land out of sight (another day, group or page): say where it went.
      if (created.date) toast(`Added for ${dueSentence(created.date, created.time, today)}`, { action: { label: 'Undo', onClick: () => deleteTaskForever(created.id) } })
      onSaved?.(created)
    }
    onClose()
  }

  function archive() {
    archiveTask(task.id)
    onClose()
    toast('Archived', { action: { label: 'Undo', onClick: () => restoreTask(task.id) } })
  }

  function toggleDone() {
    setTaskDone(task.id, !task.done)
    onClose()
    toast(task.done ? 'Marked as not done' : 'Completed', { action: { label: 'Undo', onClick: () => setTaskDone(task.id, task.done) } })
  }

  // Only a new task starts in the title field: opening one to read or tick it off shouldn't
  // bring up the keyboard.
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={task ? `Edit ${words.title}` : `New ${words.title}`}
      initialFocus={!task}
      footer={readyToComplete ? (
        <>
          <Button type="submit" form="task-form" variant="secondary">Save</Button>
          <Button icon="check" className="btn-grow" onClick={toggleDone}>Complete</Button>
        </>
      ) : (
        <>
          {task && <Button variant="secondary" icon={task.done ? 'undo' : 'check'} onClick={toggleDone}>{task.done ? 'Reopen' : 'Complete'}</Button>}
          <Button type="submit" form="task-form" className="btn-grow">{task ? 'Save' : words.add}</Button>
        </>
      )}
    >
      <form id="task-form" className="form-stack" onSubmit={submit}>
        <Field label={words.label} error={error}>
          {(id) => <input id={id} className="input input-lg" value={form.text} onChange={(event) => { set('text')(event.target.value); setError('') }} placeholder={words.placeholder} autoComplete="off" enterKeyHint="done" data-autofocus />}
        </Field>
        <div className="field">
          <span className="field-label">{words.when}</span>
          <div className="chip-row">
            {quickDates.map((item) => (
              <button key={item.id} type="button" className={`chip ${form.date === item.id ? 'is-active' : ''}`} aria-pressed={form.date === item.id} onClick={() => set('date')(form.date === item.id ? '' : item.id)}>
                {item.label}
              </button>
            ))}
            {form.date && <button type="button" className="chip chip-quiet" onClick={() => setForm((current) => ({ ...current, date: '', time: '' }))}>No date</button>}
          </div>
          <div className="field-row">
            <input className="input" type="date" value={form.date} onChange={(event) => set('date')(event.target.value)} aria-label="Date" />
            <input className="input" type="time" value={form.time} onChange={(event) => set('time')(event.target.value)} aria-label="Time" disabled={!form.date} title={form.date ? undefined : 'Pick a date first'} />
          </div>
        </div>

        {/* Remounts per task so a remembered or already-set state is read fresh for each one. */}
        <Disclosure key={task?.id || 'new'} id="task-more" label="More options" summary={extras.join(' · ')} hasValues={hasExtras}>
          <div className="field">
            <span className="field-label" id="priority-label">Priority</span>
            <Segmented options={PRIORITIES} value={form.priority} onChange={set('priority')} label="Priority" />
          </div>
          {form.date ? (
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
                      <option value="">Default ({prefs.allDayTime ? `${prefs.allDayMode === 'before' ? 'day before' : 'on the day'} at ${formatTime(prefs.allDayTime)}` : 'none'})</option>
                      <option value="0">On the day{prefs.allDayTime ? ` at ${formatTime(prefs.allDayTime)}` : ''}</option>
                      <option value="1440">The day before</option>
                      <option value="-1">No reminder</option>
                    </>
                  )}
                </select>
              )}
            </Field>
          ) : (
            <p className="field-hint">Pick a date to set a reminder.</p>
          )}
          <Field label="Notes">
            {(id) => <AutoTextarea id={id} value={form.details} onChange={(event) => set('details')(event.target.value)} placeholder="Anything to remember (optional)" minRows={2} maxRows={8} />}
          </Field>
          {task && (
            <Button variant="secondary" icon="archive" className="ts-archive" onClick={archive}>Archive</Button>
          )}
        </Disclosure>
      </form>
    </Sheet>
  )
}

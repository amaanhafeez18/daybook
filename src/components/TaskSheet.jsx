import { useEffect, useMemo, useRef, useState } from 'react'
import Sheet from './ui/Sheet.jsx'
import Disclosure from './ui/Disclosure.jsx'
import Icon from './ui/Icon.jsx'
import { AutoTextarea, Button, Field, Segmented } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import AttachmentStrip from './AttachmentStrip.jsx'
import SnoozeSheet from './SnoozeSheet.jsx'
import { offerCatchUp } from './catchUpOffer.js'
import { UnderstoodChip, understand } from './QuickParse.jsx'
import { archiveTask, classesOn, createTask, deleteTaskForever, isReminderMarker, restoreTask, setTaskDone, updateTask } from '../lib/planner.js'
import { dayPresets, dueLine, dueSentence, formatTime, formatTimeShort, nowTimeHHMM, todayISO } from '../lib/dates.js'
import { DEFAULT_TIMES, busySlots, clashSlot, usualTimes } from '../lib/timing.js'
import { askAssistantHash } from '../lib/assistantChat.js'
import { peekDraft, saveDraft, takeDraft } from '../lib/drafts.js'
import { LEAD_OPTIONS, leadLabel, notificationPrefs } from '../lib/notifications.js'
import { attachmentSummary, useAttachmentsFor } from '../lib/attachments.js'
import { useData } from '../lib/store.js'
import { learnRhythms, readRhythms, showTimeChip, titleMatches, usualToday, visibleNow } from '../lib/rhythms.js'
import { scrollBehavior } from '../lib/motion.js'
import './tasks.css'

const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Normal' },
  { id: 'urgent', label: 'Urgent' },
]

const EMPTY = { text: '', details: '', date: '', time: '', priority: 'medium', reminderMinutes: '' }
// Once a date is set: one tap for a time you usually use (lib/timing.js usualTimes; 9, 12, 3 and
// 6 until there's a history), or none. A chip that falls in a class or another task says so.
// A new task's unsaved form, kept when the sheet is closed by a stray tap (lib/drafts.js).
const DRAFT_KEY = 'task:new'

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

// The "Usually today" chips' data, frozen while the sheet is open (see TaskSheet).
function rhythmChips(tasks, settings, prefs) {
  const rhythms = readRhythms(settings)
  if (rhythms.off) return { learned: [], dismissed: [], today: [] }
  const today = todayISO()
  const learned = learnRhythms(tasks, today)
  const due = usualToday({ tasks, today, rhythms, learned, limit: 2 })
  return { learned, dismissed: rhythms.dismissed, today: visibleNow(due, nowTimeHHMM(), prefs.overdueTime || '18:00') }
}

const formFromTask = (task) => ({
  text: task.text || '',
  details: isReminderMarker(task.details) ? '' : task.details || '',
  date: task.date || '',
  time: task.time || '',
  priority: task.priority || 'medium',
  reminderMinutes: Number.isInteger(task.reminderMinutes) ? String(task.reminderMinutes) : '',
})

// Worth keeping as a draft: something typed that wasn't there when the sheet opened.
const isDirty = (form, start) => (!!form.text.trim() || !!form.details.trim()) && Object.keys(EMPTY).some((key) => form[key] !== start[key])

// Create a task (task = null) or edit an existing one.
// completeFirst: opened to tick it off (e.g. from its reminder), so Complete is the main button,
// with "Later…" beside it.
// onSaved(task): after Save / Add task. noun: 'task' (default) or 'event' (the calendar).
// pickingDate: opened from a row's Later… → "Pick a date…", so the date picker comes straight up.
// A day or time typed into a new (or undated) task's name fills Due as you type, shown as a chip
// that keeps the words in the name when tapped; a time on its own keeps the day already set.
// Closing a new task with something typed keeps it as a draft ("Draft kept · Reopen"); the next
// new task starts from it, unless that one opens for another day (see the open effect).
export default function TaskSheet({ open, onClose, task: taskProp = null, defaults = {}, completeFirst = false, onSaved, noun = 'task', pickingDate = false }) {
  // Reopened from the "Draft kept" toast after the page had already closed it.
  const [reopened, setReopened] = useState(false)
  const isOpen = open || reopened
  // Keep the last task while the sheet animates closed, so it doesn't switch to the "New task" layout.
  const shown = useRef({ task: taskProp, completeFirst })
  if (isOpen) shown.current = reopened && !open ? { task: null, completeFirst: false } : { task: taskProp, completeFirst }
  const task = shown.current.task
  const readyToComplete = Boolean(shown.current.completeFirst && task && !task.done)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [ignored, setIgnored] = useState('') // the name's parse the user dismissed, by its words
  const [snoozing, setSnoozing] = useState(false)
  const start = useRef(EMPTY) // the form as it opened
  const fill = useRef(null) // { before, applied }: the Due the name's words replaced, and what they set
  const dateInput = useRef(null)
  const settings = useData('settings')
  const prefs = notificationPrefs(settings)
  const tasks = useData('tasks')
  const classes = useData('classes')
  // The time chips are worked out as the sheet opens and kept until it closes, so they never
  // shift under the finger (a save from elsewhere, a new task).
  const chipTimes = useRef({ open: false, list: DEFAULT_TIMES })
  if (isOpen && !chipTimes.current.open) chipTimes.current = { open: true, list: usualTimes(tasks, todayISO()) }
  else if (!isOpen && chipTimes.current.open) chipTimes.current = { ...chipTimes.current, open: false }
  // "Usually today" (lib/rhythms.js), for a new task only: worked out as the sheet opens and kept
  // until it closes, like the time chips.
  const usual = useRef(null)
  if (isOpen && !task && !usual.current) usual.current = rhythmChips(tasks, settings, prefs)
  else if (!isOpen && usual.current) usual.current = null
  const attachments = useAttachmentsFor('task', task?.id)
  const words = NOUNS[noun] || NOUNS.task

  useEffect(() => {
    if (!isOpen) return
    setError('')
    setIgnored('')
    setSnoozing(false)
    fill.current = null
    // A draft is picked up unless the sheet was opened with a name already (the quick add's +), or
    // for a day other than the draft's own (the calendar's selected day, the Tomorrow card's Add):
    // that opener's day comes first, and the draft stays kept for later. "Reopen" always brings it
    // back. Taking it removes it, so saving needs no clean-up and a draft left elsewhere survives.
    const kept = !task && !defaults?.text ? peekDraft(DRAFT_KEY) : null
    const draft = kept && ((reopened && !open) || !defaults?.date || kept.date === defaults.date) ? takeDraft(DRAFT_KEY) : null
    const next = task ? formFromTask(task) : { ...EMPTY, ...defaults, ...(draft || {}) }
    // A restored draft counts as typed, so a day in its name is understood again.
    start.current = draft ? { ...next, text: '' } : next
    setForm(next)
    if (open && pickingDate) pickDate()
  }, [isOpen, task?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Only for a new or undated task, and only once the name has been changed here: opening an
  // existing "Call about Friday's game" mustn't move it. day: the Due the words would replace; a
  // time on its own ("Dentist 3pm") stays on it (e.g. the calendar's selected day).
  const parseOn = (!task || !task.date)
  const nameParse = (text, skip, day) => (parseOn && text !== start.current.text ? understand(text, skip, day) : null)
  const understood = nameParse(form.text, ignored, (fill.current?.before || form).date)

  // The name's words set Due as they're typed; when they go (deleted or dismissed), Due goes back
  // to what it was, unless it has been changed by hand since. Called with the rendered form (not
  // inside a state updater), since it moves `fill` along.
  // A trailing "!!" / "urgent" sets the priority the same way (alone, it leaves Due as it was).
  function withName(current, text, skip = ignored) {
    const next = { ...current, text }
    const before = fill.current?.before || { date: current.date, time: current.time, priority: current.priority }
    const hit = nameParse(text, skip, before.date)
    if (hit) {
      const priority = hit.priority || before.priority
      const applied = hit.date
        ? { date: hit.date, time: hit.time || (before.date ? before.time : ''), priority }
        : { date: before.date, time: before.time, priority }
      fill.current = { before, applied }
      return { ...next, ...applied }
    }
    if (fill.current) {
      const { applied } = fill.current
      fill.current = null
      if (current.date === applied.date && current.time === applied.time && current.priority === applied.priority) return { ...next, ...before }
    }
    return next
  }

  function dismissParse() {
    if (!understood) return
    setIgnored(understood.key)
    setForm(withName(form, form.text, understood.key))
  }

  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }))
  // With no name yet and Due on today: what's usually done today. Once 2 letters are typed: tasks
  // you repeat that start like it ("lau" → "Laundry · 5 PM").
  const typed = form.text.trim()
  const suggestions = task || !usual.current ? []
    : !typed ? (form.date === todayISO() ? usual.current.today : [])
      : typed.length >= 2 ? titleMatches(usual.current.learned, typed, { dismissed: usual.current.dismissed, limit: 2 }) : []
  // Fills the name (and, for today, the usual time if it's still ahead); never saves.
  function pickSuggestion(item) {
    let next = withName(form, item.title)
    if (next.date === todayISO() && !next.time && showTimeChip(item, nowTimeHHMM())) next = { ...next, time: item.usualTime }
    setForm(next)
    setError('')
  }
  const reminderValue = effectiveReminder(form.reminderMinutes, Boolean(form.time))
  const customLead = form.time && reminderValue !== '' && !LEAD_OPTIONS.some((option) => String(option.value) === reminderValue)
  const today = todayISO()
  // What's already on the chosen day (classes, other timed tasks), for the time chips.
  const busy = useMemo(() => (form.date ? busySlots(classesOn(form.date), tasks, form.date, task?.id) : []), [form.date, tasks, classes, task?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const quickDates = dayPresets(today).map((preset) => ({
    id: preset.date,
    // "Next Mon" rather than "Next week · Mon", so the chips wrap less on a phone.
    label: preset.id === 'today' || preset.id === 'tomorrow' ? preset.label : preset.id === 'next-week' ? `Next ${preset.day}` : `${preset.label} · ${preset.day}`,
  }))

  // Priority, reminder, notes and attached files live behind "More options"; the summary says
  // what's set there.
  const extras = [
    form.priority !== 'medium' && (PRIORITIES.find((item) => item.id === form.priority)?.label || ''),
    form.date && shortReminder(reminderValue, Boolean(form.time)),
    form.details.trim() && 'Notes',
    attachments.length > 0 && attachmentSummary(attachments),
  ].filter(Boolean)
  const hasExtras = extras.length > 0

  // Closed without saving (×, backdrop, Escape, swipe): a new task with something typed is kept.
  function dismiss() {
    if (!task && isDirty(form, start.current)) {
      saveDraft(DRAFT_KEY, form)
      toast('Draft kept', { action: { label: 'Reopen', onClick: () => setReopened(true) } })
    }
    setReopened(false)
    onClose()
  }

  function finish() {
    setReopened(false)
    onClose()
  }

  function submit(event) {
    event.preventDefault()
    const text = (understood ? understood.title : form.text).trim()
    if (!text) {
      setError(`Give the ${words.title} a name.`)
      return
    }
    const fields = { ...form, text, details: form.details.trim(), reminderMinutes: reminderValue === '' ? null : Number(reminderValue) }
    if (task) {
      // Keep the internal reminder marker if the user didn't add notes of their own.
      if (isReminderMarker(task.details) && !fields.details) fields.details = task.details
      // Saved first, on its own line: `onSaved?.(updateTask(…))` would skip the update entirely
      // whenever there is no onSaved (optional calls don't evaluate their arguments).
      const saved = updateTask(task.id, fields)
      onSaved?.(saved)
    } else {
      const created = createTask(fields)
      // A dated task may land out of sight (another day, group or page): say where it went.
      if (created.date) toast(`Added for ${dueSentence(created.date, created.time, today)}`, { action: { label: 'Undo', onClick: () => deleteTaskForever(created.id) } })
      onSaved?.(created)
    }
    finish()
  }

  function archive() {
    archiveTask(task.id)
    finish()
    toast('Archived', { action: { label: 'Undo', onClick: () => restoreTask(task.id) } })
  }

  function breakIntoSteps() {
    const ask = askAssistantHash(`Help me break “${task.text}” into a few small steps I can tick off.`)
    finish()
    window.location.hash = ask
  }

  function toggleDone() {
    setTaskDone(task.id, !task.done)
    finish()
    toast(task.done ? 'Marked as not done' : 'Completed', { action: { label: 'Undo', onClick: () => setTaskDone(task.id, task.done) } })
    if (!task.done) offerCatchUp(task)
  }

  // "Pick a date…" from Later: the Due field right here, once the Later sheet has gone (it hands
  // focus back as it closes, which would close a picker opened before).
  function pickDate() {
    setTimeout(() => {
      const input = dateInput.current
      if (!input) return
      input.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
      try {
        input.showPicker()
      } catch {
        input.focus()
      }
    }, 220)
  }

  // Only a new task starts in the title field: opening one to read or tick it off shouldn't
  // bring up the keyboard.
  return (
    <Sheet
      open={isOpen}
      onClose={dismiss}
      title={task ? `Edit ${words.title}` : `New ${words.title}`}
      initialFocus={!task}
      footer={readyToComplete ? (
        <>
          <Button type="submit" form="task-form" variant="secondary">Save</Button>
          <Button variant="secondary" icon="clock" onClick={() => setSnoozing(true)}>Later…</Button>
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
          {(id) => (
            <input
              id={id}
              className="input input-lg"
              value={form.text}
              onChange={(event) => {
                setForm(withName(form, event.target.value))
                setError('')
              }}
              placeholder={words.placeholder}
              autoComplete="off"
              enterKeyHint="done"
              aria-describedby={understood ? 'ts-parsed' : undefined}
              data-autofocus
            />
          )}
        </Field>
        {understood && (
          <div className="ts-parsed-row" id="ts-parsed" aria-live="polite">
            <UnderstoodChip understood={understood} today={today} onDismiss={dismissParse} />
            <span className="ts-parsed-name">Saves as “{understood.title}”</span>
          </div>
        )}
        {suggestions.length > 0 && (
          // A press here mustn't take focus from the name field, so the keyboard stays up.
          <div className="chip-row ts-usual" role="group" aria-label="Suggestions" onMouseDown={(event) => event.preventDefault()}>
            {suggestions.map((item) => (
              <button key={item.key} type="button" className="chip chip-sm ts-usual-chip" onClick={() => pickSuggestion(item)}>
                <Icon name="repeat" size={13} strokeWidth={2.2} />
                <span>{item.title}{item.usualTime ? ` · ${formatTimeShort(item.usualTime)}` : ''}</span>
              </button>
            ))}
          </div>
        )}
        <div className="field ts-when">
          <span className="field-label">{words.when}</span>
          <div className="chip-row">
            {quickDates.map((item) => (
              <button key={item.id} type="button" className={`chip ${form.date === item.id ? 'is-active' : ''}`} aria-pressed={form.date === item.id} onClick={() => set('date')(form.date === item.id ? '' : item.id)}>
                {item.label}
              </button>
            ))}
            {form.date && <button type="button" className="chip chip-quiet" onClick={() => setForm((current) => ({ ...current, date: '', time: '' }))}>No date</button>}
          </div>
          <div className="field-row ts-when-row">
            <input ref={dateInput} className="input" type="date" value={form.date} onChange={(event) => set('date')(event.target.value)} aria-label="Date" />
            <input className="input" type="time" value={form.time} onChange={(event) => set('time')(event.target.value)} aria-label="Time" disabled={!form.date} title={form.date ? undefined : 'Pick a date first'} />
          </div>
          {form.date && (
            <div className="chip-row ts-time-chips" role="group" aria-label="Time">
              {chipTimes.current.list.map((time) => {
                const clash = clashSlot(time, busy)
                const label = formatTimeShort(time)
                return (
                  <button
                    key={time}
                    type="button"
                    className={`chip chip-sm ${form.time === time ? 'is-active' : ''} ${clash ? 'is-clash' : ''}`}
                    aria-pressed={form.time === time}
                    aria-label={clash ? `${label}, during ${clash.label}` : undefined}
                    onClick={() => set('time')(form.time === time ? '' : time)}
                  >
                    {label}
                    {clash && <span className="ts-chip-clash" aria-hidden="true"> · {clash.kind === 'class' ? 'class' : 'busy'}</span>}
                  </button>
                )
              })}
              <button type="button" className={`chip chip-sm ${!form.time ? 'is-active' : ''}`} aria-pressed={!form.time} onClick={() => set('time')('')}>Any time</button>
            </div>
          )}
          {form.date && <p className="ts-due-line" aria-live="polite">{dueLine(form.date, form.time, today)}</p>}
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
          {/* Files are pinned to the saved task (a new one has no id yet). Adding and removing save straight away. */}
          {task ? (
            <div className="field ts-files">
              <span className="field-label">Photos & files</span>
              <AttachmentStrip targetType="task" targetId={task.id} label={`Photos and files on this ${words.title}`} />
            </div>
          ) : (
            <p className="field-hint">Photos and PDFs can be added once the {words.title} is saved.</p>
          )}
          {task && (
            // Only fills the assistant's message box (nothing is sent until you send it).
            <Button variant="secondary" icon="sparkles" className="ts-handoff" onClick={breakIntoSteps}>Break into steps with the assistant</Button>
          )}
          {task && (
            <Button variant="secondary" icon="archive" className="ts-archive" onClick={archive}>Archive</Button>
          )}
        </Disclosure>
      </form>
      {task && <SnoozeSheet task={task} open={snoozing} onClose={() => setSnoozing(false)} onPick={pickDate} onDone={finish} />}
    </Sheet>
  )
}

import Icon from './ui/Icon.jsx'
import { Checkbox } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { isReminderMarker, setTaskDone } from '../lib/planner.js'
import { formatTime, relativeDay, todayISO } from '../lib/dates.js'
import './today.css'

// trailing: an optional accessory after the text (e.g. a "Today" chip); tapping it doesn't open the task.
export default function TaskRow({ task, onOpen, showDate = true, trailing = null }) {
  const today = todayISO()
  const overdue = !task.done && task.date && task.date < today
  const details = isReminderMarker(task.details) ? '' : task.details

  function toggle(done) {
    setTaskDone(task.id, done)
    if (done) toast(`Completed “${truncate(task.text, 32)}”`, { action: { label: 'Undo', onClick: () => setTaskDone(task.id, false) } })
  }

  return (
    <li className={`task-row ${task.done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}>
      <Checkbox checked={!!task.done} onChange={toggle} label={task.done ? `Mark “${task.text}” as not done` : `Complete “${task.text}”`} />
      <button type="button" className="task-body" onClick={() => onOpen?.(task)}>
        <span className="task-title">{task.text}</span>
        {details && <span className="task-notes">{details}</span>}
        {(showDate && task.date) || task.time || task.priority === 'urgent' ? (
          <span className="task-meta">
            {showDate && task.date && (
              <span className={`meta-chip ${overdue ? 'is-danger' : task.date === today ? 'is-accent' : ''}`}>
                <Icon name="calendar" size={13} />
                {overdue ? `Overdue · ${relativeDay(task.date, today)}` : relativeDay(task.date, today)}
              </span>
            )}
            {task.time && (
              <span className="meta-chip">
                <Icon name="clock" size={13} />
                {formatTime(task.time)}
              </span>
            )}
            {task.priority === 'urgent' && (
              <span className="meta-chip is-danger">
                <Icon name="flag" size={13} />
                Urgent
              </span>
            )}
          </span>
        ) : null}
      </button>
      {trailing && <span className="task-trailing">{trailing}</span>}
      {task.priority === 'low' && <span className="task-low" aria-label="Low priority" title="Low priority" />}
    </li>
  )
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

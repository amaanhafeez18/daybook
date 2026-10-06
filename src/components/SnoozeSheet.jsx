import { useRef } from 'react'
import Sheet from './ui/Sheet.jsx'
import Icon from './ui/Icon.jsx'
import { toast } from './ui/feedback.jsx'
import { updateTask } from '../lib/planner.js'
import { dueSentence, snoozeOptions } from '../lib/dates.js'
import './tasks.css'

const ICONS = { hour: 'clock', evening: 'moon', tomorrow: 'sunrise', weekend: 'sun', 'next-week': 'calendar' }

// Moves a task to a "Later…" choice straight away; the toast has Undo.
export function snoozeTask(task, { date, time = '' }) {
  const from = { date: task.date || '', time: task.time || '' }
  updateTask(task.id, { date, time })
  toast(`Moved “${truncate(task.text, 28)}” to ${dueSentence(date, time)}`, { action: { label: 'Undo', onClick: () => updateTask(task.id, from) } })
}

// "Later…": the choices from snoozeOptions (in 1 hour, this evening, tomorrow, the weekend, next
// week), plus "Pick a date…" (onPick) for anything else. A choice applies at once, then onDone.
export default function SnoozeSheet({ task, open, onClose, onPick, onDone }) {
  // Frozen while open, so the list doesn't change under the finger or while it slides away.
  const shown = useRef({ task, options: [] })
  if (open && task) shown.current = { task, options: snoozeOptions(task, new Date()) }
  const { task: current, options } = shown.current
  if (!current) return null

  function choose(option) {
    onClose()
    snoozeTask(current, option)
    onDone?.()
  }

  return (
    <Sheet open={open} onClose={onClose} size="sm" title="Later" description={`“${truncate(current.text, 60)}”`} initialFocus={false}>
      {options.length === 0 && current.date && (
        <p className="field-hint ts-snz-note">It’s already due {dueSentence(current.date, current.time)}.</p>
      )}
      <div className="ts-snz-list">
        {options.map((option) => (
          <button key={option.id} type="button" className="ts-snz-row" onClick={() => choose(option)}>
            <Icon name={ICONS[option.id] || 'clock'} size={20} />
            <span className="ts-snz-label">{option.label}</span>
            <span className="ts-snz-hint">{option.hint}</span>
          </button>
        ))}
        {onPick && (
          <button
            type="button"
            className="ts-snz-row"
            onClick={() => {
              onClose()
              onPick()
            }}
          >
            <Icon name="calendarCheck" size={20} />
            <span className="ts-snz-label">Pick a date…</span>
          </button>
        )}
      </div>
    </Sheet>
  )
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

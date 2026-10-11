import { useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { formatDue, parseQuickAdd } from '../lib/dates.js'
import './tasks.css'

// A day and time typed into a task's name ("Call mom tomorrow 5pm"), shared by the Tasks quick add
// and the task sheet: the parse ({ title, date, time, matched, hasDay, priority, key }) or null when
// nothing was recognised or the user tapped the chip to keep those words (`ignored` = that parse's
// key). A trailing " !", "!!" or "urgent" sets priority 'urgent' (date may then be '').
// day: the day the form already has; a time typed on its own ("Dentist 3pm") stays on it.
export function understand(text, ignored = '', day = '') {
  const parsed = parseQuickAdd(text, new Date(), { day })
  const key = parsed.matched.map((span) => span.text.toLowerCase()).join('|')
  return parsed.matched.length > 0 && key !== ignored ? { ...parsed, key } : null
}

// understand() for a field as it's typed. enabled: false turns it off (understood is null).
export function useQuickParse(text, enabled = true, day = '') {
  const [ignored, setIgnored] = useState('')
  const understood = useMemo(() => (enabled ? understand(text, ignored, day) : null), [text, enabled, ignored, day])
  return {
    understood,
    ignored,
    dismiss: () => understood && setIgnored(understood.key),
    reset: () => setIgnored(''),
  }
}

// The parse as a chip ("Tomorrow · 5:00 PM ×", with a flag when urgent); tapping it keeps those
// words in the title instead.
export function UnderstoodChip({ understood, today, onDismiss, className = '' }) {
  const due = understood.date ? formatDue(understood.date, understood.time, today) : ''
  const urgent = understood.priority === 'urgent'
  const heard = understood.matched.map((span) => span.text).join(' … ')
  const spoken = [due && `Due ${due.replace(' · ', ' at ')}`, urgent && 'urgent'].filter(Boolean).join(', ')
  return (
    <button
      type="button"
      className={`chip chip-sm is-active tk-parsed ${className}`}
      onClick={onDismiss}
      aria-label={`${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}, from “${heard}”. Tap to keep those words in the title instead.`}
    >
      {due && <Icon name="calendar" size={14} strokeWidth={2.1} />}
      {due && <span>{due}</span>}
      {urgent && <Icon name="flag" size={14} strokeWidth={2.1} className="tk-parsed-flag" />}
      {urgent && !due && <span>Urgent</span>}
      <Icon name="close" size={13} strokeWidth={2.4} className="tk-parsed-x" />
    </button>
  )
}

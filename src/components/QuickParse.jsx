import { useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { formatDue, parseQuickAdd } from '../lib/dates.js'
import './tasks.css'

// A day and time typed into a task's name ("Call mom tomorrow 5pm"), shared by the Tasks quick add
// and the task sheet: the parse ({ title, date, time, matched, key }) or null when nothing was
// recognised or the user tapped the chip to keep those words (`ignored` = that parse's key).
export function understand(text, ignored = '') {
  const parsed = parseQuickAdd(text, new Date())
  const key = parsed.matched.map((span) => span.text.toLowerCase()).join('|')
  return parsed.matched.length > 0 && key !== ignored ? { ...parsed, key } : null
}

// understand() for a field as it's typed. enabled: false turns it off (understood is null).
export function useQuickParse(text, enabled = true) {
  const [ignored, setIgnored] = useState('')
  const understood = useMemo(() => (enabled ? understand(text, ignored) : null), [text, enabled, ignored])
  return {
    understood,
    ignored,
    dismiss: () => understood && setIgnored(understood.key),
    reset: () => setIgnored(''),
  }
}

// The parse as a chip ("Tomorrow · 5:00 PM ×"); tapping it keeps those words in the title instead.
export function UnderstoodChip({ understood, today, onDismiss, className = '' }) {
  const label = formatDue(understood.date, understood.time, today)
  const heard = understood.matched.map((span) => span.text).join(' … ')
  return (
    <button
      type="button"
      className={`chip chip-sm is-active tk-parsed ${className}`}
      onClick={onDismiss}
      aria-label={`Due ${label.replace(' · ', ' at ')}, from “${heard}”. Tap to keep those words in the title instead.`}
    >
      <Icon name="calendar" size={14} strokeWidth={2.1} />
      <span>{label}</span>
      <Icon name="close" size={13} strokeWidth={2.4} className="tk-parsed-x" />
    </button>
  )
}

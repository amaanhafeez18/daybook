import { useId, useState } from 'react'
import Icon from './Icon.jsx'
import { readPref, writePref } from '../../lib/api.js'
import './disclosure.css'

// Progressive disclosure, the one pattern the whole app uses to stay simple by default without
// hiding anything: the essentials show, the rest sits behind "More options" (or a named label).
// The progression is natural rather than a mode: a disclosure remembers (per device) whether the
// user left it open, and opens by itself when something inside it is already set (`hasValues`),
// so people who use the extra controls see them without asking, and people who don't never do.
//
//   <Disclosure id="task-reminder" label="Reminder & details" summary="15 min before" hasValues={!!details}>…</Disclosure>
//
// id: a stable name for remembering the open state (omit to never remember). summary: a short
// read-only line shown while closed, so the user knows what's inside without opening it.

export default function Disclosure({ id, label = 'More options', summary, defaultOpen = false, hasValues = false, children, className = '' }) {
  const buttonId = useId()
  const [open, setOpen] = useState(() => defaultOpen || hasValues || (id ? readPref(`disclosure.${id}`, false) === true : false))
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (id) writePref(`disclosure.${id}`, next)
  }
  return (
    <div className={`disclosure ${open ? 'is-open' : ''} ${className}`}>
      <button type="button" id={buttonId} className="disclosure-toggle" aria-expanded={open} onClick={toggle}>
        <span className="disclosure-label">{label}</span>
        {!open && summary && <span className="disclosure-summary">{summary}</span>}
        <Icon name="chevronDown" size={16} strokeWidth={2.2} className="disclosure-chevron" />
      </button>
      {open && <div className="disclosure-body" role="region" aria-labelledby={buttonId}>{children}</div>}
    </div>
  )
}

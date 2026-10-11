import { useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { readPref, writePref } from '../lib/api.js'
import { timeToMinutes } from '../lib/dates.js'
import { notificationPrefs } from '../lib/notifications.js'
import { collapseOut } from '../lib/collapse.js'
import './morning-note.css'

// The morning summary the assistant wrote (Settings → Notifications → Morning summary → "Written
// by the assistant"), at the top of Plan → Today. The server writes settings.briefing =
// { date, text, at } when it sends the 8 AM push; this only shows it: that day, until noon (or 3
// hours after the summary time, if later), unless ✕ hid it for today on this device ('brief.hidden').
export default function MorningNote({ settings, today, now }) {
  const [hiddenOn, setHiddenOn] = useState(() => readPref('brief.hidden', ''))
  const card = useRef(null)
  const brief = settings?.briefing
  const text = typeof brief?.text === 'string' ? brief.text.trim() : ''
  if (settings?.notifications?.dailySummaryAi !== true || brief?.date !== today || !text) return null
  if (hiddenOn === today) return null
  const summaryAt = timeToMinutes(notificationPrefs(settings).dailySummaryTime) ?? 8 * 60
  const minutesNow = now.getHours() * 60 + now.getMinutes()
  if (minutesNow >= Math.min(1440, Math.max(720, summaryAt + 180))) return null

  // Folds away (at once under Reduce Motion), then stays hidden until tomorrow.
  async function hide() {
    writePref('brief.hidden', today)
    await collapseOut(card.current)
    setHiddenOn(today)
  }

  return (
    <section ref={card} className="card td-note" aria-label="Morning note">
      <div className="td-note-head">
        <span className="td-note-icon" aria-hidden="true"><Icon name="sparkles" size={15} strokeWidth={2.1} /></span>
        <span className="eyebrow td-note-eyebrow">Morning note</span>
      </div>
      <p className="td-note-text">{text}</p>
      <button type="button" className="td-note-close" onClick={hide} aria-label="Hide morning note">
        <Icon name="close" size={17} strokeWidth={2.2} />
      </button>
    </section>
  )
}

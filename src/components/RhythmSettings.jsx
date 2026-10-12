import Disclosure from './ui/Disclosure.jsx'
import { Switch } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { useMemo } from 'react'
import { getState, updateSettings, useData } from '../lib/store.js'
import { dismissRhythm, readRhythms, restoreRhythm } from '../lib/rhythms.js'
import { dismissRadar, readRadar, restoreRadar } from '../lib/radar.js'
import { todayISO } from '../lib/dates.js'

// Settings → Suggestions: "Usually today" on or off, and the suggestions hidden with "Not this"
// (each with Bring back). settings.rhythms = { off, dismissed: [{ key, title, at }] }; lib/rhythms.js.
// Also the "Coming up" deadlines hidden on Today (settings.radar.dismissed, lib/radar.js), listed
// while the task or event still exists and is still ahead.
// Mounted by SettingsPage as a whole settings group.
export default function RhythmSettings({ settings }) {
  const { off, dismissed } = readRhythms(settings)
  // Written from the latest settings, not this render's, so quick taps never undo each other.
  const current = () => readRhythms(getState().data.settings)
  const tasks = useData('tasks')
  const events = useData('events')
  const radarDismissed = readRadar(settings).dismissed
  const hiddenDeadlines = useMemo(() => {
    const today = todayISO()
    const byKey = new Map()
    for (const task of tasks || []) if (task && !task.done && !task.archived) byKey.set(`task:${task.id}`, { title: task.text, date: task.date })
    for (const event of events || []) if (event) byKey.set(`event:${event.id}`, { title: event.title, date: event.date })
    return radarDismissed
      .map((entry) => ({ ...entry, ...byKey.get(entry.key) }))
      .filter((entry) => entry.title && typeof entry.date === 'string' && entry.date > today)
  }, [tasks, events, radarDismissed.map((entry) => entry.key).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  function bringBack(item) {
    updateSettings({ rhythms: restoreRhythm(current(), item.key) })
    toast(`“${item.title}” can be suggested again`, { action: { label: 'Undo', onClick: () => updateSettings({ rhythms: dismissRhythm(current(), item, item.at) }) } })
  }

  function bringBackDeadline(item) {
    const radar = () => getState().data.settings?.radar
    updateSettings({ radar: restoreRadar(radar(), item.key) })
    toast(`“${item.title}” can show in Coming up again`, { action: { label: 'Undo', onClick: () => updateSettings({ radar: dismissRadar(radar(), item.key, item.at) }) } })
  }

  return (
    <section className="settings-group" id="suggestions">
      <h2>Suggestions</h2>
      <div className="card set-list">
        <div className="set-row is-switch">
          <Switch
            label="Usually today"
            description="Suggest tasks you repeat, like Laundry on Sundays"
            checked={!off}
            onChange={(on) => updateSettings({ rhythms: { ...current(), off: !on } })}
          />
        </div>
      </div>
      {dismissed.length > 0 && (
        <Disclosure id="settings-rhythms-hidden" label="Hidden suggestions" summary={String(dismissed.length)} className="set-disclosure">
          <ul className="card set-list rs-hidden">
            {dismissed.map((item) => (
              <li key={item.key} className="set-row rs-hidden-row">
                <span className="rs-hidden-title">{item.title}</span>
                <button type="button" className="link-btn rs-bring-back" onClick={() => bringBack(item)} aria-label={`Bring back “${item.title}”`}>
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {hiddenDeadlines.length > 0 && (
        <Disclosure id="settings-radar-hidden" label="Hidden deadlines" summary={String(hiddenDeadlines.length)} className="set-disclosure">
          <ul className="card set-list rs-hidden">
            {hiddenDeadlines.map((item) => (
              <li key={item.key} className="set-row rs-hidden-row">
                <span className="rs-hidden-title">{item.title}</span>
                <button type="button" className="link-btn rs-bring-back" onClick={() => bringBackDeadline(item)} aria-label={`Bring back “${item.title}”`}>
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  )
}

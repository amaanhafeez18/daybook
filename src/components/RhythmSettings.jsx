import Disclosure from './ui/Disclosure.jsx'
import { Switch } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { getState, updateSettings } from '../lib/store.js'
import { dismissRhythm, readRhythms, restoreRhythm } from '../lib/rhythms.js'

// Settings → Suggestions: "Usually today" on or off, and the suggestions hidden with "Not this"
// (each with Bring back). settings.rhythms = { off, dismissed: [{ key, title, at }] }; lib/rhythms.js.
// Mounted by SettingsPage as a whole settings group.
export default function RhythmSettings({ settings }) {
  const { off, dismissed } = readRhythms(settings)
  // Written from the latest settings, not this render's, so quick taps never undo each other.
  const current = () => readRhythms(getState().data.settings)

  function bringBack(item) {
    updateSettings({ rhythms: restoreRhythm(current(), item.key) })
    toast(`“${item.title}” can be suggested again`, { action: { label: 'Undo', onClick: () => updateSettings({ rhythms: dismissRhythm(current(), item, item.at) }) } })
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
    </section>
  )
}

import { useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button, Card } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import InstallSteps from './InstallSteps.jsx'
import { turnOnHere } from './NotifyOffHint.jsx'
import { readPref, writePref } from '../lib/api.js'
import { updateSettings, useData, useStore } from '../lib/store.js'
import { deviceName, isHomeScreenApp, usePushStatus } from '../lib/notifications.js'
import { setupSteps, setupVisible, todayHint } from '../lib/setup.js'
import './setup.css'

// "Not now" on the reminders card asks again after a month; "Got it" on the install card is final.
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000
const dismissedAt = (name) => {
  const at = Number(readPref(`hint.${name}`, 0))
  return Number.isFinite(at) ? at : 0
}

// Today's one hint card (lib/setup.js todayHint): "Get set up" for a new account, else "Get
// reminders on this iPhone" in the Home Screen app, else (iPhone Safari) how to add Daybook to the
// Home Screen. Those two become rows of "Get set up" while it shows, so there's never a second card.
export default function TodayHint({ areas, location, loaded, onAddClass, onChooseCity }) {
  const settings = useData('settings')
  const classes = useData('classes')
  const friends = useData('friends')
  const isNew = useStore((state) => setupVisible(state.data))
  const { support, subscribed } = usePushStatus()
  const [dismissed, setDismissed] = useState(() => ({
    reminders: Date.now() - dismissedAt('reminders') < SNOOZE_MS,
    install: dismissedAt('install') > 0,
  }))

  // Still asking whether this device is subscribed: wait rather than flash a card.
  if (!loaded || (support === 'granted' && subscribed === null)) return null
  const steps = setupSteps({ settings, classes, friends, areas, hasCoords: !!location.coords, push: support, subscribed })
  const hint = todayHint({ setup: isNew, steps, push: support, subscribed, standalone: isHomeScreenApp(), dismissed })
  const dismiss = (name) => {
    writePref(`hint.${name}`, Date.now())
    setDismissed((current) => ({ ...current, [name]: true }))
  }

  if (hint === 'setup') return <SetupCard steps={steps} location={location} support={support} onAddClass={onAddClass} onChooseCity={onChooseCity} />
  if (hint === 'reminders') return <RemindersCard onDismiss={() => dismiss('reminders')} />
  if (hint === 'install') return <InstallCard onDismiss={() => dismiss('install')} />
  return null
}

// "Get set up · 2 of 5 done": one row per thing to set up, ticked off from the data, each going
// straight to where it's done. Hide sets settings.setupHidden (with Undo).
function SetupCard({ steps, location, support, onAddClass, onChooseCity }) {
  const [expanded, setExpanded] = useState('')
  const [busy, setBusy] = useState(false)
  const done = steps.filter((step) => step.done).length
  const blocked = location.status === 'denied' || location.status === 'unsupported'
  const device = deviceName()

  async function turnOn() {
    setBusy(true)
    await turnOnHere()
    setBusy(false)
  }

  function hide() {
    updateSettings({ setupHidden: true })
    toast('Hidden. Everything is still in Settings.', { action: { label: 'Undo', onClick: () => updateSettings({ setupHidden: false }) } })
  }

  const toggle = (id) => setExpanded((current) => (current === id ? '' : id))
  const ROWS = {
    classes: { icon: 'graduation', title: 'Add your timetable', text: 'Classes show up on Today and the calendar', onClick: onAddClass, extra: { label: 'From a photo', href: '#/assistant/timetable' } },
    gym: { icon: 'dumbbell', title: 'Pick a gym plan', text: 'Your split and what to train each day', href: '#/gym' },
    food: { icon: 'utensils', title: 'Set your calorie goal', text: 'Worked out from a few questions', href: '#/food/goals' },
    people: { icon: 'people', title: 'Add people', text: 'Birthdays and reminders to catch up', href: '#/people' },
    location: blocked
      ? { icon: 'pin', title: 'Choose your city', text: 'Location is blocked, so pick it by name', onClick: onChooseCity }
      : { icon: 'pin', title: 'Use my location', text: 'For weather and prayer times', onClick: location.locate, loading: location.status === 'locating', extra: { label: 'Choose a city', onClick: onChooseCity } },
    reminders: support === 'install'
      ? { icon: 'bell', title: 'Add Daybook to your Home Screen', text: 'Reminders on iPhone need the Home Screen app', onClick: () => toggle('reminders'), more: <InstallSteps /> }
      : support === 'denied'
        ? { icon: 'bell', title: 'Turn on reminders', text: `Blocked on ${device}: allow Daybook in your phone’s Settings → Notifications`, href: '#/settings/notifications' }
        : { icon: 'bell', title: 'Turn on reminders', text: `Get reminders on ${device}`, onClick: turnOn, loading: busy },
  }

  return (
    <Card title="Get set up" icon="sparkles" className="su-card" action={<span className="su-count">{done} of {steps.length} done</span>}>
      <div className="su-progress" aria-hidden="true"><span style={{ width: `${Math.round((done / Math.max(1, steps.length)) * 100)}%` }} /></div>
      <ul className="su-list">
        {steps.map((step) => {
          const row = ROWS[step.id]
          const open = !step.done && !!row.more && expanded === step.id
          return (
            <li key={step.id} className={`su-item ${step.done ? 'is-done' : ''}`}>
              <div className="su-row">
                <SetupRowMain row={row} done={step.done} open={open} />
                {!step.done && row.extra && (row.extra.href
                  ? <a className="su-chip" href={row.extra.href}>{row.extra.label}</a>
                  : <button type="button" className="su-chip" onClick={row.extra.onClick}>{row.extra.label}</button>)}
              </div>
              {open && <div className="su-more">{row.more}</div>}
            </li>
          )
        })}
      </ul>
      <div className="su-foot">
        <button type="button" className="link-btn" onClick={hide}>Hide</button>
      </div>
    </Card>
  )
}

function SetupRowMain({ row, done, open }) {
  const content = (
    <>
      <span className="su-icon" aria-hidden="true">
        {done ? <Icon name="check" size={15} strokeWidth={2.6} /> : row.loading ? <span className="spinner" /> : <Icon name={row.icon} size={16} />}
      </span>
      <span className="su-text">
        <strong>{row.title}</strong>
        {!done && <small>{row.text}</small>}
      </span>
      {!done && !row.extra && (
        <span className="su-chev" aria-hidden="true"><Icon name={row.more ? (open ? 'chevronUp' : 'chevronDown') : 'chevronRight'} size={18} strokeWidth={2.2} /></span>
      )}
    </>
  )
  if (done) return <div className="su-main"><span className="sr-only">Done: </span>{content}</div>
  if (row.href) return <a className="su-main" href={row.href}>{content}</a>
  return (
    <button type="button" className="su-main" onClick={row.onClick} disabled={row.loading} aria-busy={row.loading || undefined} aria-expanded={row.more ? open : undefined}>
      {content}
    </button>
  )
}

// In the Home Screen app, before notifications were ever asked for.
function RemindersCard({ onDismiss }) {
  const [busy, setBusy] = useState(false)
  async function turnOn() {
    setBusy(true)
    await turnOnHere() // once they're on, this card goes away by itself
    setBusy(false)
  }
  return (
    <Card className="su-hint">
      <div className="su-hint-body">
        <span className="su-icon" aria-hidden="true"><Icon name="bell" size={16} /></span>
        <div className="su-hint-text">
          <strong>Get reminders on {deviceName()}</strong>
          <p>A morning summary and a heads-up before anything with a time. Choose what in Settings.</p>
        </div>
      </div>
      <div className="su-hint-actions">
        <Button variant="ghost" size="sm" onClick={onDismiss}>Not now</Button>
        <Button size="sm" loading={busy} onClick={turnOn}>Turn on</Button>
      </div>
    </Card>
  )
}

// iPhone Safari, once: reminders need the Home Screen app.
function InstallCard({ onDismiss }) {
  return (
    <Card className="su-hint">
      <div className="su-hint-body">
        <span className="su-icon" aria-hidden="true"><Icon name="home" size={16} /></span>
        <div className="su-hint-text">
          <strong>Add Daybook to your Home Screen for reminders</strong>
          <p>On iPhone, reminders only arrive in the Home Screen app.</p>
          <InstallSteps />
        </div>
      </div>
      <div className="su-hint-actions">
        <Button variant="secondary" size="sm" onClick={onDismiss}>Got it</Button>
      </div>
    </Card>
  )
}

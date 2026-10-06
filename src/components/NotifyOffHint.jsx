import { useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import InstallSteps from './InstallSteps.jsx'
import { deviceName, enableNotifications, usePushStatus } from '../lib/notifications.js'
import { notifyHintState } from '../lib/setup.js'
import './setup.css'

// Turns notifications on for this device, from a tap (iOS only asks for a user gesture), with a
// toast either way. Resolves true when they're on.
export async function turnOnHere() {
  try {
    await enableNotifications()
    toast(`Notifications are on for ${deviceName()}`, { tone: 'success' })
    return true
  } catch (error) {
    toast(error.message, { tone: 'error', duration: 7000 })
    return false
  }
}

// "Notifications are off on this iPhone · Turn on", under a reminder switch (workout, prayer) when
// this device won't get that reminder; nothing once it will. `className` fits it into the list it
// sits in (a Settings .set-row, a gym settings .gym-cfg-row).
export default function NotifyOffHint({ className = '' }) {
  const { support, subscribed } = usePushStatus()
  const [busy, setBusy] = useState(false)
  const [showSteps, setShowSteps] = useState(false)
  const state = notifyHintState(support, subscribed)
  if (!state) return null
  const device = deviceName()

  async function turnOn() {
    setBusy(true)
    await turnOnHere()
    setBusy(false)
  }

  return (
    <>
      <div className={`nh-row ${state === 'blocked' ? 'is-blocked' : ''} ${className}`}>
        <span className="nh-icon" aria-hidden="true"><Icon name="bell" size={17} /></span>
        <span className="nh-text">
          {state === 'off' && `Notifications are off on ${device}.`}
          {state === 'install' && 'On iPhone, reminders need Daybook on your Home Screen.'}
          {state === 'blocked' && `Notifications are blocked on ${device}. Allow them for Daybook in your phone’s Settings → Notifications.`}
        </span>
        {state === 'off' && <Button size="sm" variant="secondary" loading={busy} onClick={turnOn}>Turn on</Button>}
        {state === 'install' && (
          <button type="button" className="link-btn" aria-expanded={showSteps} onClick={() => setShowSteps((open) => !open)}>{showSteps ? 'Hide' : 'How'}</button>
        )}
      </div>
      {state === 'install' && showSteps && <div className={`nh-steps ${className}`}><InstallSteps /></div>}
    </>
  )
}

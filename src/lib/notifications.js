import { apiRequest, readPref, writePref } from './api.js'

// Keep in sync with api/_reminders.js.
export const DEFAULT_NOTIFICATIONS = {
  taskLead: 15,
  allDayTime: '09:00',
  allDayMode: 'day',
  dailySummary: true,
  dailySummaryTime: '08:00',
  overdue: true,
  overdueTime: '18:00',
  people: true,
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '07:00',
}

export const LEAD_OPTIONS = [
  { value: 0, label: 'At time of task' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
  { value: -1, label: 'No reminder' },
]

// Label for any lead time in minutes (the assistant can set values that aren't in LEAD_OPTIONS).
export function leadLabel(minutes) {
  const known = LEAD_OPTIONS.find((option) => option.value === minutes)
  if (known) return known.label
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`
  return `${minutes} minutes before`
}

export function notificationPrefs(settings) {
  return { ...DEFAULT_NOTIFICATIONS, ...(settings?.notifications || {}) }
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true

// 'unsupported' | 'install' (iOS: add to Home Screen first) | 'dev' | 'default' | 'denied' | 'granted'
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) {
    return isIOS() && !isStandalone() ? 'install' : 'unsupported'
  }
  if (import.meta.env.DEV) return 'dev'
  return Notification.permission
}

async function registration() {
  const ready = navigator.serviceWorker.ready
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('The app’s offline worker isn’t ready yet. Reload and try again.')), 8000))
  return Promise.race([ready, timeout])
}

export async function currentSubscription() {
  if (pushSupport() !== 'granted') return null
  const reg = await registration().catch(() => null)
  return reg ? reg.pushManager.getSubscription() : null
}

function base64UrlToBytes(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')

// A subscription made with an old server key can't receive messages.
function keyMatches(subscription, publicKey) {
  const current = subscription?.options?.applicationServerKey
  return !current || b64(new Uint8Array(current)) === b64(base64UrlToBytes(publicKey))
}

// Must be called from a tap (iOS only shows the permission prompt for a user gesture).
export async function enableNotifications() {
  const support = pushSupport()
  if (support === 'install') throw new Error('On iPhone, add Daybook to your Home Screen first (Share → Add to Home Screen), then turn notifications on from the app.')
  if (support === 'unsupported') throw new Error('This browser doesn’t support notifications.')
  if (support === 'dev') throw new Error('Notifications only work in the installed app, not the local dev server.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in Settings → Notifications → Daybook.')

  const { configured, publicKey } = await apiRequest('/api/push')
  if (!configured || !publicKey) throw new Error('Notifications aren’t set up on the server yet.')

  const reg = await registration()
  let subscription = await reg.pushManager.getSubscription()
  if (subscription && !keyMatches(subscription, publicKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
  }
  await apiRequest('/api/push', { method: 'POST', body: { action: 'subscribe', subscription: subscription.toJSON() } })
  return subscription
}

// Re-registers this device with the server at most daily per account + endpoint (the server may
// have dropped the row, or the key changed). It also moves a subscription left by another account
// (session expired, no explicit logout) to the user signed in now. Best effort, never throws.
export async function syncSubscription(userId) {
  try {
    if (pushSupport() !== 'granted') return
    const reg = await registration()
    let subscription = await reg.pushManager.getSubscription()
    if (!subscription) return
    const last = readPref('pushSync', null)
    if (last && last.userId === userId && last.endpoint === subscription.endpoint && Date.now() - last.at < 86400000) return
    const { configured, publicKey } = await apiRequest('/api/push')
    if (!configured || !publicKey) return
    if (!keyMatches(subscription, publicKey)) {
      await subscription.unsubscribe().catch(() => {})
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }).catch(() => null)
      if (!subscription) return
    }
    await apiRequest('/api/push', { method: 'POST', body: { action: 'subscribe', subscription: subscription.toJSON() } })
    writePref('pushSync', { userId, endpoint: subscription.endpoint, at: Date.now() })
  } catch {
    // best effort: tried again next launch
  }
}

export async function disableNotifications() {
  writePref('pushSync', null)
  const subscription = await currentSubscription()
  if (!subscription) return
  await apiRequest('/api/push', { method: 'POST', body: { action: 'unsubscribe', endpoint: subscription.endpoint } }).catch(() => {})
  await subscription.unsubscribe().catch(() => {})
}

export function sendTestNotification() {
  return apiRequest('/api/push', { method: 'POST', body: { action: 'test' } })
}

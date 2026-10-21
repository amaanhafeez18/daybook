import { apiRequest, getToken } from '../api.js'
import { formatTime, nowTimeHHMM } from '../dates.js'
import { currentSubscription, PUSH_CHANGED } from '../notifications.js'
import { getActiveWorkout, getGym } from './state.js'

// The rest timer on the lock screen. An iPhone web app's timers stop while it's in the background,
// so when the app is left mid-rest:
//   1. a quiet notification shows at once: "Resting · ends 6:42 PM · Next: Bench Press, set 3";
//   2. the server is asked to send "Rest over" to this device at the end (api/push.js, action
//      'rest'), which it skips if the rest changed meanwhile.
// Back in the app first: that notification goes and the server's send is cancelled ('rest-cancel'),
// since the app's own timer (RestTimer.jsx) takes over. Needs notifications on for this device;
// Gym settings → Rest timer → "On the lock screen" (prefs.restNotify, on unless false).
const TAG = 'daybook-rest'
const MIN_LEFT_MS = 5000 // a rest about to end isn't worth a notification

let scheduled = null // { workoutId, endAt } sent to the server
let started = false
// This device's push endpoint, read while the app is open: when it's being put away there's no
// time to wait for the service worker before the request goes out.
let endpoint = null

function refreshEndpoint() {
  currentSubscription().then((subscription) => { endpoint = subscription?.endpoint || null }).catch(() => { endpoint = null })
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

// 'Bench Press (Barbell), set 3' for the first set not done yet, from the rested exercise on.
export function nextSetLabel(workout, restExerciseId) {
  const list = Array.isArray(workout?.exercises) ? workout.exercises : []
  const from = Math.max(0, list.findIndex((exercise, i) => String(exercise?.id ?? i) === String(restExerciseId)))
  for (let k = 0; k < list.length; k++) {
    const exercise = list[(from + k) % list.length]
    const sets = Array.isArray(exercise?.sets) ? exercise.sets : []
    const index = sets.findIndex((set) => set && !set.done)
    if (index >= 0) return `${exercise.name || 'Exercise'}, set ${index + 1}`
  }
  return ''
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.getRegistration().catch(() => null)
}

async function onHidden() {
  const workout = getActiveWorkout()
  const rest = workout?.rest
  if (!workout || !rest || !isNum(rest.endAt) || rest.endAt - Date.now() < MIN_LEFT_MS) return
  if (getGym().prefs?.restNotify === false || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const next = nextSetLabel(workout, rest.exerciseId)
  const ends = formatTime(nowTimeHHMM(new Date(rest.endAt)))
  if (endpoint && getToken()) {
    scheduled = { workoutId: workout.id, endAt: rest.endAt }
    apiRequest('/api/push', {
      method: 'POST',
      body: { action: 'rest', workoutId: workout.id, endAt: rest.endAt, endpoint, title: 'Rest over', body: next ? `Next: ${next}` : 'Time for your next set' },
      keepalive: true,
    }).catch(() => { scheduled = null })
  }
  const reg = await registration()
  reg?.showNotification?.('Resting', {
    body: [`Ends ${ends}`, next && `Next: ${next}`].filter(Boolean).join(' · '),
    tag: TAG,
    silent: true,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: '/#/gym/workout' },
  }).catch(() => {})
}

async function onVisible() {
  refreshEndpoint()
  const reg = await registration()
  const shown = await reg?.getNotifications?.({ tag: TAG }).catch(() => [])
  for (const notification of shown || []) notification.close()
  const pending = scheduled
  scheduled = null
  if (pending && pending.endAt > Date.now() && getToken()) {
    apiRequest('/api/push', { method: 'POST', body: { action: 'rest-cancel', ...pending } }).catch(() => {})
  }
}

// Once, from the app shell. Returns a cleanup.
export function startRestAlarm() {
  if (started || typeof document === 'undefined') return () => {}
  started = true
  refreshEndpoint()
  window.addEventListener(PUSH_CHANGED, refreshEndpoint)
  const onChange = () => {
    if (document.visibilityState === 'hidden') onHidden().catch(() => {})
    else onVisible().catch(() => {})
  }
  document.addEventListener('visibilitychange', onChange)
  return () => {
    started = false
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener(PUSH_CHANGED, refreshEndpoint)
  }
}

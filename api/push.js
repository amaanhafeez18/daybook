import { randomUUID } from 'crypto'
import { waitUntil } from '@vercel/functions'
import { getSupabase, readJsonBody, verifyRequestToken, verifyTokenVersion } from './db.js'
import { pushConfigured, sendToUser } from './_reminders.js'

// GET                         → { configured, publicKey }
// POST { action: 'subscribe', subscription }   save this device
// POST { action: 'unsubscribe', endpoint }      forget this device
// POST { action: 'test', appBadge? }            send a test notification to all devices (with the icon count)
// POST { action: 'rest', workoutId, endAt, endpoint, title, body }
//                                               the rest timer on the lock screen: answers at once,
//                                               then at endAt sends "Rest over" to that one device
//                                               (lib/gym/restAlarm.js), unless cancelled meanwhile
// POST { action: 'rest-cancel', workoutId, endAt }  the app came back first: don't send it

// A rest further away than this isn't sent (the function may run up to 300 s, vercel.json).
const REST_MAX_MS = 285000
const restKey = (workoutId, endAt) => `rest:${String(workoutId).slice(0, 80)}:${endAt}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Claims a notification_log key for the user; false when it's already taken (sent or cancelled).
async function claim(supabase, userId, key) {
  const { error } = await supabase.from('notification_log').insert({ user_id: userId, key })
  if (!error) return true
  if (error.code === '23505') return false
  throw error
}

// Waits until the rest ends, then sends "Rest over" if the workout still has that rest (the synced
// settings.gym.active: a skipped rest, the next set ticked or the workout finished change it) and
// the app hasn't come back first (rest-cancel claims the same key).
async function restAlarm(supabase, userId, { workoutId, endAt, endpoint, title, body }) {
  await sleep(Math.max(0, endAt - Date.now()))
  const { data } = await supabase.from('settings').select('value').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)
  const active = data?.[0]?.value?.gym?.active
  if (!active || active.id !== workoutId || active.rest?.endAt !== endAt) return
  if (!(await claim(supabase, userId, restKey(workoutId, endAt)))) return
  await sendToUser(supabase, userId, { title, body, tag: 'daybook-rest', url: '/#/gym/workout' }, { endpoint })
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

export default async function handler(req, res) {
  try {
    const decoded = verifyRequestToken(req)
    if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    const supabase = getSupabase()
    if (!(await verifyTokenVersion(supabase, decoded))) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })

    if (req.method === 'GET') {
      return sendJson(res, 200, { configured: pushConfigured(), publicKey: process.env.VAPID_PUBLIC_KEY || null })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.' })
    if (!pushConfigured()) return sendJson(res, 503, { error: 'Notifications aren’t set up on the server yet.' })

    const body = await readJsonBody(req)

    if (body.action === 'subscribe') {
      const subscription = body.subscription || {}
      const endpoint = String(subscription.endpoint || '')
      const p256dh = String(subscription.keys?.p256dh || '')
      const auth = String(subscription.keys?.auth || '')
      if (!endpoint.startsWith('https://') || !p256dh || !auth || endpoint.length > 1000) {
        return sendJson(res, 400, { error: 'Invalid push subscription.' })
      }
      // One row per device endpoint; a device that switches accounts moves to the new user.
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
      const { error } = await supabase.from('push_subscriptions').insert({
        id: randomUUID(),
        user_id: decoded.id,
        endpoint,
        p256dh,
        auth,
        vapid_public: process.env.VAPID_PUBLIC_KEY,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      })
      if (error) throw error
      return sendJson(res, 200, { ok: true })
    }

    if (body.action === 'unsubscribe') {
      await supabase.from('push_subscriptions').delete().eq('endpoint', String(body.endpoint || '')).eq('user_id', decoded.id)
      return sendJson(res, 200, { ok: true })
    }

    if (body.action === 'test') {
      const payload = {
        title: 'Daybook',
        body: 'Notifications are working. You’ll be reminded about your tasks here.',
        url: '/#/settings',
        tag: 'test',
      }
      // The app sends its icon count when that's on, so the badge shows with the test.
      if (Number.isInteger(body.appBadge) && body.appBadge >= 0 && body.appBadge <= 9999) payload.appBadge = body.appBadge
      const { sent, failed } = await sendToUser(supabase, decoded.id, payload)
      if (!sent && failed) return sendJson(res, 502, { error: 'Couldn’t reach your devices right now. Please try again.' })
      if (!sent) return sendJson(res, 404, { error: 'No devices with notifications turned on.' })
      return sendJson(res, 200, { ok: true, sent })
    }

    if (body.action === 'rest' || body.action === 'rest-cancel') {
      const workoutId = typeof body.workoutId === 'string' ? body.workoutId.slice(0, 80) : ''
      const endAt = Number(body.endAt)
      if (!workoutId || !Number.isInteger(endAt)) return sendJson(res, 400, { error: 'Invalid rest.' })
      if (body.action === 'rest-cancel') {
        await claim(supabase, decoded.id, restKey(workoutId, endAt))
        return sendJson(res, 200, { ok: true })
      }
      const wait = endAt - Date.now()
      const endpoint = String(body.endpoint || '')
      if (wait < 2000 || wait > REST_MAX_MS || !endpoint.startsWith('https://')) return sendJson(res, 200, { ok: false, skipped: true })
      const text = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
      const job = restAlarm(supabase, decoded.id, { workoutId, endAt, endpoint, title: text(body.title, 60) || 'Rest over', body: text(body.body, 160) })
        .catch((error) => console.error('Rest alarm failed:', error?.message || error))
      waitUntil(job) // keeps the function alive after the answer below (outside Vercel the promise just runs)
      return sendJson(res, 202, { ok: true })
    }

    return sendJson(res, 400, { error: 'Unknown action.' })
  } catch (error) {
    console.error('Push API error:', error)
    return sendJson(res, error.status === 503 ? 503 : 500, { error: error.status === 503 ? error.message : 'Something went wrong. Please try again.' })
  }
}

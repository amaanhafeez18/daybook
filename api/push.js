import { randomUUID } from 'crypto'
import { getSupabase, readJsonBody, verifyRequestToken, verifyTokenVersion } from './db.js'
import { pushConfigured, sendToUser } from './_reminders.js'

// GET                         → { configured, publicKey }
// POST { action: 'subscribe', subscription }   save this device
// POST { action: 'unsubscribe', endpoint }      forget this device
// POST { action: 'test' }                       send a test notification to all devices

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
      const { sent, failed } = await sendToUser(supabase, decoded.id, {
        title: 'Daybook',
        body: 'Notifications are working. You’ll be reminded about your tasks here.',
        url: '/#/settings',
        tag: 'test',
      })
      if (!sent && failed) return sendJson(res, 502, { error: 'Couldn’t reach your devices right now. Please try again.' })
      if (!sent) return sendJson(res, 404, { error: 'No devices with notifications turned on.' })
      return sendJson(res, 200, { ok: true, sent })
    }

    return sendJson(res, 400, { error: 'Unknown action.' })
  } catch (error) {
    console.error('Push API error:', error)
    return sendJson(res, error.status === 503 ? 503 : 500, { error: error.status === 503 ? error.message : 'Something went wrong. Please try again.' })
  }
}

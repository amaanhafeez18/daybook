import { getSupabase } from './db.js'
import { dueNotifications, pushConfigured, sendToUser } from './_reminders.js'

// Called every minute by the Supabase scheduler (pg_cron + pg_net), see
// supabase/migrations/2026-09-24-notifications.sql. Protected by CRON_SECRET.
//   ?dryRun=1          report what would be sent, send nothing
//   ?all=1&at=<ISO>    (dry run only) evaluate every user at a given moment

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return sendJson(res, 401, { error: 'Unauthorized' })
  if (!pushConfigured()) return sendJson(res, 503, { error: 'Push notifications are not configured (VAPID keys missing).' })

  try {
    const supabase = getSupabase()
    const dryRun = req.query?.dryRun === '1'
    const now = dryRun && req.query?.at ? new Date(req.query.at).getTime() : Date.now()
    if (!Number.isFinite(now)) return sendJson(res, 400, { error: 'Invalid "at" time.' })

    let userIds
    if (dryRun && req.query?.all === '1') {
      const { data, error } = await supabase.from('users').select('id')
      if (error) throw error
      userIds = (data || []).map((row) => row.id)
    } else {
      const { data, error } = await supabase.from('push_subscriptions').select('user_id').eq('vapid_public', process.env.VAPID_PUBLIC_KEY)
      if (error) throw error
      userIds = [...new Set((data || []).map((row) => row.user_id))]
    }

    const report = []
    await Promise.all(userIds.map(async (userId) => {
      const [settings, tasks, friends, classes] = await Promise.all([
        supabase.from('settings').select('value').eq('user_id', userId).limit(1),
        supabase.from('tasks').select('*').eq('user_id', userId).eq('done', false).eq('archived', false).limit(1000),
        supabase.from('friends').select('id, name, birthday').eq('user_id', userId).limit(1000),
        supabase.from('classes').select('*').eq('user_id', userId).limit(200),
      ])
      for (const result of [settings, tasks, friends, classes]) if (result.error) throw result.error

      const due = dueNotifications({
        settings: settings.data?.[0]?.value || {},
        tasks: tasks.data || [],
        friends: friends.data || [],
        contactLogs: [],
        classes: classes.data || [],
      }, now)

      for (const item of due) {
        if (dryRun) {
          report.push({ userId, key: item.key, fireAt: new Date(item.fireAt).toISOString(), title: item.title, body: item.body })
          continue
        }
        // Record first: the unique key means overlapping runs can never send twice.
        const { error: logError } = await supabase.from('notification_log').insert({ user_id: userId, key: item.key })
        if (logError) {
          if (logError.code !== '23505') console.error('Notification log failed:', logError.message)
          continue
        }
        const sent = await sendToUser(supabase, userId, { title: item.title, body: item.body, url: item.url, tag: item.tag })
        report.push({ key: item.key, sent })
      }
    }))

    // Occasional clean-up of old log rows.
    if (!dryRun && new Date(now).getUTCMinutes() === 0) {
      await supabase.from('notification_log').delete().lt('sent_at', new Date(now - 45 * 86400000).toISOString())
    }

    return sendJson(res, 200, { ok: true, users: userIds.length, notifications: report })
  } catch (error) {
    console.error('Cron error:', error)
    return sendJson(res, 500, { error: error.message || 'Cron failed.' })
  }
}

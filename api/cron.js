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
      // One user's bad data or a failed query must not stop everyone else's reminders.
      try {
        const [settings, tasks, friends, classes, logs] = await Promise.all([
          supabase.from('settings').select('value').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
          supabase.from('tasks').select('*').eq('user_id', userId).eq('done', false).eq('archived', false).limit(1000),
          // '*' so databases without relationship / reminder_days still work.
          supabase.from('friends').select('*').eq('user_id', userId).limit(1000),
          supabase.from('classes').select('*').eq('user_id', userId).limit(200),
          supabase.from('contact_logs').select('friend_id, date').eq('user_id', userId).order('date', { ascending: false }).limit(1000),
        ])
        for (const result of [settings, tasks, friends, classes]) if (result.error) throw result.error
        if (logs.error) console.error('Contact logs failed:', userId, logs.error.message)

        const due = dueNotifications({
          settings: settings.data?.[0]?.value || {},
          tasks: tasks.data || [],
          friends: friends.data || [],
          contactLogs: logs.error ? null : (logs.data || []),
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
          let result = { sent: 0, failed: 1 }
          try {
            result = await sendToUser(supabase, userId, { title: item.title, body: item.body, url: item.url, tag: item.tag })
          } catch (err) {
            console.error('Reminder send failed:', err.message || err)
          }
          // Nothing reached any device: release the key so the next run retries within SEND_WINDOW_MS.
          if (!result.sent && result.failed) await supabase.from('notification_log').delete().eq('user_id', userId).eq('key', item.key)
          report.push({ key: item.key, sent: result.sent, failed: result.failed })
        }
      } catch (error) {
        console.error('Cron user failed:', userId, error.message)
        report.push({ userId, error: error.message })
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

import { getSupabase } from './db.js'
import { removeOldUploads } from './_uploads.js'
import { appBadgeFor, combineReminders, dueNotifications, groupDue, localDateFor, notificationPrefs, pushConfigured, sendToUser } from './_reminders.js'
import { briefingCost, briefingDigest, cleanBriefing, createLimiter, generateBriefing, morningBriefing } from './_briefing.js'
import { fetchPrayerDay, savedLocation } from './_prayer.js'
import { fetchRainChance } from './_weather.js'

// Called every minute by the Supabase scheduler (pg_cron + pg_net), see
// supabase/migrations/2026-09-24-notifications.sql. Protected by CRON_SECRET.
//   ?dryRun=1          report what would be sent, send nothing
//   ?all=1&at=<ISO>    (dry run only) evaluate every user at a given moment
//   ?ai=1              (dry run only) also has the assistant write each due morning summary from its
//                      digest (a real OpenAI call that costs a little; nothing is saved or sent)
// A dry run never claims, sends, calls OpenAI (without ai=1) or saves anything.

// gym_sessions doesn't exist until supabase/migrations/2026-09-26-gym.sql has run.
function missingTable(error) {
  return error.code === 'PGRST205' || error.code === '42P01' || /Could not find the table/i.test(error.message || '')
}

// Only the columns reminders use: this runs every minute, and whole rows would carry each person's
// photo. A database without relationship / reminder_days yet falls back to '*'.
async function friendsFor(supabase, userId) {
  const query = (columns) => supabase.from('friends').select(columns).eq('user_id', userId).limit(1000)
  const result = await query('id, name, birthday, relationship, reminder_days')
  if (!result.error || !['42703', 'PGRST204'].includes(result.error.code)) return result
  return query('*')
}

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

    // Gym sessions from two days before today in UTC cover every user's local today.
    const gymFrom = new Date(now - 2 * 86400000).toISOString().slice(0, 10)
    // Assistant-written morning summaries: a few at a time, and none once the run has gone on too long.
    const runStartedAt = Date.now()
    const aiLimit = createLimiter(4)
    const tryAi = dryRun && req.query?.ai === '1'

    const report = []
    await Promise.all(userIds.map(async (userId) => {
      // One user's bad data or a failed query must not stop everyone else's reminders.
      try {
        const [settings, tasks, friends, classes, logs, gym] = await Promise.all([
          supabase.from('settings').select('value').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
          // Open tasks, plus recent done ones for the evening check-in's "3 of 4 done today".
          // Nearest dates first, so a very long list can only drop far-future tasks.
          supabase.from('tasks').select('*').eq('user_id', userId).eq('archived', false).or(`done.eq.false,date.gte.${gymFrom}`).order('date', { ascending: true, nullsFirst: false }).limit(2000),
          friendsFor(supabase, userId),
          supabase.from('classes').select('*').eq('user_id', userId).limit(200),
          supabase.from('contact_logs').select('friend_id, date').eq('user_id', userId).order('date', { ascending: false }).limit(1000),
          supabase.from('gym_sessions').select('id, date, routine_id').eq('user_id', userId).gte('date', gymFrom).order('date', { ascending: false }).limit(50),
        ])
        for (const result of [settings, tasks, friends, classes]) if (result.error) throw result.error
        if (logs.error) console.error('Contact logs failed:', userId, logs.error.message)
        // No table yet means no sessions; any other failure skips gym reminders this run (null).
        const gymMissing = gym.error && missingTable(gym.error)
        if (gym.error && !gymMissing) console.error('Gym sessions failed:', userId, gym.error.message)

        const userSettings = settings.data?.[0]?.value || {}
        const prefs = notificationPrefs(userSettings)
        // Prayer reminders need today's times for the saved location (cached per day in _prayer.js).
        let prayerTimings = null
        const location = savedLocation(userSettings)
        if (prefs.prayer && location) {
          try {
            prayerTimings = (await fetchPrayerDay(location, localDateFor(userSettings, now), userSettings)).times24h
          } catch (error) {
            console.error('Prayer times failed:', userId, error.message || error) // retried next minute
          }
        }
        const input = {
          settings: userSettings,
          tasks: tasks.data || [],
          friends: friends.data || [],
          contactLogs: logs.error ? null : (logs.data || []),
          classes: classes.data || [],
          gymSessions: gym.error ? (gymMissing ? [] : null) : (gym.data || []),
          prayerTimings,
        }
        let due = dueNotifications(input, now)
        // The morning summary mentions rain (and the assistant-written one the prayers still ahead):
        // these are fetched only in the run that sends it. The summary stays "due" for the whole send
        // window even once sent, so only its first few minutes look them up (a late send just goes
        // without them). Both are recomputed into `due` once.
        const today = localDateFor(userSettings, now)
        const summary = due.find((item) => item.key === `summary:${today}`)
        if (location && summary && now - summary.fireAt < 5 * 60000) {
          const wantsPrayers = prefs.dailySummaryAi === true && !prayerTimings && (prefs.prayer || userSettings.showPrayerTimes !== false)
          const [rainChance, extraTimings] = await Promise.all([
            fetchRainChance(location.lat, location.lon, today, userSettings.timeZone),
            wantsPrayers
              ? fetchPrayerDay(location, today, userSettings).then((day) => day.times24h).catch((error) => {
                console.error('Prayer times failed:', userId, error.message || error)
                return null
              })
              : null,
          ])
          if (rainChance !== null || extraTimings) {
            due = dueNotifications({ ...input, prayerTimings: prayerTimings || extraTimings, forecast: rainChance !== null ? { rainChance } : null }, now)
          }
        }
        // The app icon's count goes with every push (never on its own: iOS drops subscriptions that
        // get pushes without a notification). Only users with something due pay for it.
        const appBadge = due.length ? appBadgeFor(userSettings, tasks.data || [], now) : null

        for (const group of groupDue(due)) {
          if (dryRun) {
            const message = combineReminders(group)
            const row = { userId, key: group.map((item) => item.key).join(' + '), fireAt: new Date(group[0].fireAt).toISOString(), title: message.title, body: message.body, appBadge }
            const summaryItem = group.find((item) => item.key === `summary:${today}` && item.facts)
            if (summaryItem) {
              row.digest = briefingDigest(summaryItem.facts)
              if (tryAi) {
                try {
                  const result = await aiLimit(() => generateBriefing(row.digest, { userId }))
                  Object.assign(row, { text: result.text, cleaned: cleanBriefing(result.text, row.digest), usage: result.usage, costUsd: briefingCost(result.usage), ms: result.ms })
                } catch (error) {
                  row.aiError = error.message || String(error)
                }
              }
            }
            report.push(row)
            continue
          }
          // Record first: the unique key means overlapping runs can never send twice. A batch sends
          // only the reminders this run claimed.
          const claimed = []
          for (const item of group) {
            const { error: logError } = await supabase.from('notification_log').insert({ user_id: userId, key: item.key })
            if (!logError) claimed.push(item)
            else if (logError.code !== '23505') console.error('Notification log failed:', logError.message)
          }
          if (!claimed.length) continue
          const keys = claimed.map((item) => item.key)
          // This run owns today's summary (the claim above), so it alone may have it written by the
          // assistant: once a day per user. Off, or any problem, sends the template.
          let items = claimed
          let briefing = null
          const claimedSummary = claimed.find((item) => item.key === `summary:${today}`)
          if (claimedSummary) {
            briefing = await morningBriefing({ supabase, userId, settings: userSettings, facts: claimedSummary.facts, now: Date.now(), runStartedAt, limit: aiLimit })
            if (briefing.text) items = claimed.map((item) => (item === claimedSummary ? { ...item, body: briefing.text } : item))
          }
          const payload = combineReminders(items)
          if (appBadge !== null) payload.appBadge = appBadge
          let result = { sent: 0, failed: 1 }
          try {
            result = await sendToUser(supabase, userId, payload)
          } catch (err) {
            console.error('Reminder send failed:', err.message || err)
          }
          // Nothing reached any device: release the keys so the next run retries within SEND_WINDOW_MS.
          if (!result.sent && result.failed) await supabase.from('notification_log').delete().eq('user_id', userId).in('key', keys)
          report.push({ key: keys.join(' + '), sent: result.sent, failed: result.failed, ...(briefing && briefing.source !== 'off' ? { briefing: briefing.source } : {}) })
        }
      } catch (error) {
        console.error('Cron user failed:', userId, error.message)
        report.push({ userId, error: error.message })
      }
    }))

    // Occasional clean-up of old log rows.
    if (!dryRun && new Date(now).getUTCMinutes() === 0) {
      await supabase.from('notification_log').delete().lt('sent_at', new Date(now - 45 * 86400000).toISOString())
      // Assistant attachments are only needed for a few follow-up messages.
      await removeOldUploads(supabase, 3, now).catch((error) => console.error('Upload cleanup failed:', error.message))
    }

    return sendJson(res, 200, { ok: true, users: userIds.length, notifications: report })
  } catch (error) {
    console.error('Cron error:', error)
    return sendJson(res, 500, { error: error.message || 'Cron failed.' })
  }
}

import jwt from 'jsonwebtoken'
import { getSupabase, readJsonBody, parseAuthHeader } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'

function isConfigError(error) {
  return /Missing SUPABASE_URL|Missing JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|Environment Variables/.test(error?.message || '')
}

const TABLES = {
  tasks: 'tasks',
  events: 'events',
  friends: 'friends',
  contactLogs: 'contact_logs',
  voiceNotes: 'voice_notes',
  classes: 'classes',
  settings: 'settings',
  journalEntries: 'journal_entries'
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function normalizeKey(key) {
  return key === 'contactLogs' ? 'contact_logs' : key
}

function toIsoString(value) {
  if (!value) return new Date().toISOString()
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return new Date(value).toISOString()
}

function normalizeRowForDb(item, userId) {
  const next = { ...item, user_id: userId }

  if ('friendId' in next && !('friend_id' in next)) {
    next.friend_id = next.friendId
    delete next.friendId
  }

  if ('photoUrl' in next && !('photo_url' in next)) {
    next.photo_url = next.photoUrl
    delete next.photoUrl
  }

  if ('currentStatus' in next && !('current_status' in next)) {
    next.current_status = next.currentStatus
    delete next.currentStatus
  }

  if ('endDate' in next && !('end_date' in next)) {
    next.end_date = next.endDate
    delete next.endDate
  }

  if ('calendarEventId' in next && !('calendar_event_id' in next)) {
    next.calendar_event_id = next.calendarEventId
    delete next.calendarEventId
  }

  if ('taskId' in next && !('task_id' in next)) {
    next.task_id = next.taskId
    delete next.taskId
  }

  if ('reminderDays' in next && !('reminder_days' in next)) {
    next.reminder_days = next.reminderDays
    delete next.reminderDays
  }

  if ('createdAt' in next || 'created_at' in next) {
    next.created_at = toIsoString(next.createdAt ?? next.created_at)
    delete next.createdAt
  } else {
    next.created_at = new Date().toISOString()
  }

  return next
}

function normalizeRowForClient(item) {
  if (!item) return item
  const next = { ...item }

  if ('friend_id' in next && !('friendId' in next)) {
    next.friendId = next.friend_id
  }

  if ('photo_url' in next && !('photoUrl' in next)) {
    next.photoUrl = next.photo_url
  }

  if ('current_status' in next && !('currentStatus' in next)) {
    next.currentStatus = next.current_status
  }

  if ('end_date' in next && !('endDate' in next)) {
    next.endDate = next.end_date
  }

  if ('calendar_event_id' in next && !('calendarEventId' in next)) next.calendarEventId = next.calendar_event_id
  if ('task_id' in next && !('taskId' in next)) next.taskId = next.task_id
  if ('reminder_days' in next && !('reminderDays' in next)) next.reminderDays = next.reminder_days

  if ('created_at' in next && !('createdAt' in next)) {
    next.createdAt = next.created_at
  }

  delete next.created_at
  delete next.friend_id
  delete next.photo_url
  delete next.current_status
  delete next.end_date
  delete next.calendar_event_id
  delete next.task_id
  delete next.reminder_days

  return next
}

export default async function handler(req, res) {
  try {
    const method = req.method || 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }

    const token = parseAuthHeader(req)
    if (!token) {
      return sendJson(res, 401, { error: 'Missing auth token.' })
    }

    const decoded = jwt.verify(token, JWT_SECRET)
    const supabase = getSupabase()

    if (method === 'GET') {
      const key = normalizeKey(req.query?.key || 'tasks')
      const tableName = TABLES[key] || key

      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('user_id', decoded.id)
        .order('created_at', { ascending: false })

      if (error) {
        return sendJson(res, 500, { error: error.message })
      }

      if (key === 'settings') {
        const settings = (data || []).find((row) => row.user_id === decoded.id)
        return sendJson(res, 200, settings ? settings.value : {})
      }

      return sendJson(res, 200, (data || []).map(normalizeRowForClient))
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req)
      const key = normalizeKey(body.key)
      const value = body.value ?? []
      const tableName = TABLES[key] || key

      const { error: deleteError } = await supabase
        .from(tableName)
        .delete()
        .eq('user_id', decoded.id)

      if (deleteError) {
        return sendJson(res, 500, { error: deleteError.message })
      }

      if (key === 'settings') {
        const payload = value && typeof value === 'object' ? value : {}
        const { error: insertError } = await supabase.from(tableName).insert({
          id: crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          user_id: decoded.id,
          value: payload,
          created_at: new Date().toISOString()
        })

        if (insertError) {
          return sendJson(res, 500, { error: insertError.message })
        }

        return sendJson(res, 200, { ok: true })
      }

      const rows = Array.isArray(value) ? value.map((item) => normalizeRowForDb(item, decoded.id)) : []

      if (rows.length > 0) {
        const { error: insertError } = await supabase.from(tableName).insert(rows)
        if (insertError) {
          return sendJson(res, 500, { error: insertError.message })
        }
      }

      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'Unsupported method.' })
  } catch (error) {
    console.error('Data API error:', error)
    if (isConfigError(error)) {
      return sendJson(res, 503, {
        error: 'Server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and JWT_SECRET in Vercel.'
      })
    }
    return sendJson(res, 500, { error: error.message || 'Unexpected data error.' })
  }
}

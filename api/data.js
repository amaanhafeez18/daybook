import { randomUUID } from 'crypto'
import { getSupabase, readJsonBody, verifyRequestToken } from './db.js'

function isConfigError(error) {
  return /Missing SUPABASE_URL|Missing JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|Environment Variables/.test(error?.message || '')
}

// Client data keys the API may read or write, mapped to their tables.
const TABLES = {
  tasks: 'tasks',
  events: 'events',
  friends: 'friends',
  contactLogs: 'contact_logs',
  contact_logs: 'contact_logs',
  voiceNotes: 'voice_notes',
  classes: 'classes',
  settings: 'settings',
  journalEntries: 'journal_entries'
}

// Columns each table accepts (matches supabase/schema.sql). Unknown fields are dropped
// so a stray client field can never make a save fail.
const COLUMNS = {
  tasks: ['id', 'text', 'done', 'date', 'time', 'details', 'priority', 'archived', 'calendar_event_id', 'created_at'],
  events: ['id', 'date', 'time', 'title', 'task_id', 'created_at'],
  friends: ['id', 'name', 'relationship', 'reminder_days', 'organization', 'note', 'photo_url', 'birthday', 'current_status', 'facts', 'created_at'],
  contact_logs: ['id', 'friend_id', 'date', 'created_at'],
  voice_notes: ['id', 'text', 'created_at'],
  classes: ['id', 'name', 'days', 'time', 'room', 'end_date', 'day_details', 'created_at'],
  journal_entries: ['id', 'date', 'title', 'body', 'mood', 'created_at']
}

// camelCase client field -> snake_case column
const FIELD_TO_COLUMN = {
  friendId: 'friend_id',
  photoUrl: 'photo_url',
  currentStatus: 'current_status',
  endDate: 'end_date',
  calendarEventId: 'calendar_event_id',
  taskId: 'task_id',
  reminderDays: 'reminder_days',
  dayDetails: 'day_details',
  createdAt: 'created_at'
}
const COLUMN_TO_FIELD = Object.fromEntries(Object.entries(FIELD_TO_COLUMN).map(([field, column]) => [column, field]))

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function toIsoString(value) {
  if (!value) return new Date().toISOString()
  if (typeof value === 'string') return value
  return new Date(value).toISOString()
}

function normalizeRowForDb(item, tableName, userId) {
  const allowed = COLUMNS[tableName]
  const next = {}
  for (const [key, value] of Object.entries(item || {})) {
    const column = FIELD_TO_COLUMN[key] || key
    if (!allowed.includes(column)) continue
    if (column in next && key === column) continue // prefer the camelCase value when both are present
    next[column] = value
  }
  next.id = next.id ? String(next.id) : randomUUID()
  next.created_at = toIsoString(next.created_at)
  next.user_id = userId
  return next
}

function normalizeRowForClient(item) {
  if (!item) return item
  const next = {}
  for (const [key, value] of Object.entries(item)) {
    next[COLUMN_TO_FIELD[key] || key] = value
  }
  return next
}

async function saveSettings(supabase, userId, value) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const { data: existing, error: readError } = await supabase.from('settings').select('id').eq('user_id', userId)
  if (readError) throw readError

  if (existing?.length) {
    const [keep, ...extras] = existing
    const { error } = await supabase.from('settings').update({ value: payload }).eq('id', keep.id).eq('user_id', userId)
    if (error) throw error
    if (extras.length) await supabase.from('settings').delete().eq('user_id', userId).in('id', extras.map((row) => row.id))
    return
  }

  const { error } = await supabase.from('settings').insert({ id: randomUUID(), user_id: userId, value: payload, created_at: new Date().toISOString() })
  if (error) throw error
}

// Replaces the user's rows in a table with `value` without ever deleting first:
// write the new list, and only once that succeeds remove rows that are no longer in it.
async function replaceRows(supabase, tableName, userId, value) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const row = normalizeRowForDb(item, tableName, userId)
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }

  const { data: owned, error: ownedError } = await supabase.from(tableName).select('id').eq('user_id', userId)
  if (ownedError) throw ownedError
  const ownedIds = new Set((owned || []).map((row) => row.id))

  // Rows the user already owns are updated in place. New rows use a plain insert, so an id that
  // belongs to another user fails instead of being taken over.
  const existingRows = rows.filter((row) => ownedIds.has(row.id))
  const newRows = rows.filter((row) => !ownedIds.has(row.id))

  if (existingRows.length) {
    const { error } = await supabase.from(tableName).upsert(existingRows, { onConflict: 'id', defaultToNull: false })
    if (error) throw error
  }

  if (newRows.length) {
    const { error } = await supabase.from(tableName).insert(newRows, { defaultToNull: false })
    if (error) throw error
  }

  const staleIds = [...ownedIds].filter((id) => !seen.has(id))
  if (staleIds.length) {
    const { error } = await supabase.from(tableName).delete().eq('user_id', userId).in('id', staleIds)
    if (error) throw error
  }
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

    const decoded = verifyRequestToken(req)
    if (!decoded) {
      return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    }

    const supabase = getSupabase()

    if (method === 'GET') {
      const tableName = TABLES[req.query?.key || 'tasks']
      if (!tableName) return sendJson(res, 400, { error: 'Unknown data key.' })

      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('user_id', decoded.id)
        .order('created_at', { ascending: false })

      if (error) {
        return sendJson(res, 500, { error: error.message })
      }

      if (tableName === 'settings') {
        return sendJson(res, 200, data?.[0]?.value || {})
      }

      return sendJson(res, 200, (data || []).map(normalizeRowForClient))
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req)
      const tableName = TABLES[body.key]
      if (!tableName) return sendJson(res, 400, { error: 'Unknown data key.' })

      if (tableName === 'settings') {
        await saveSettings(supabase, decoded.id, body.value)
      } else {
        await replaceRows(supabase, tableName, decoded.id, body.value ?? [])
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

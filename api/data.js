import jwt from 'jsonwebtoken'
import { getSupabase, readJsonBody, parseAuthHeader } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'

const TABLES = {
  tasks: 'tasks',
  events: 'events',
  friends: 'friends',
  contactLogs: 'contact_logs',
  voiceNotes: 'voice_notes'
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function normalizeKey(key) {
  return key === 'contactLogs' ? 'contact_logs' : key
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
        .order('created_at', { ascending: false, foreignTable: undefined })

      if (error) {
        return sendJson(res, 500, { error: error.message })
      }

      if (tableName === 'contact_logs') {
        return sendJson(res, 200, data || [])
      }

      return sendJson(res, 200, data || [])
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

      const rows = Array.isArray(value) ? value.map((item) => ({
        ...item,
        user_id: decoded.id,
        created_at: item.createdAt || item.created_at || new Date().toISOString()
      })) : []

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
    return sendJson(res, 500, { error: error.message || 'Unexpected data error.' })
  }
}

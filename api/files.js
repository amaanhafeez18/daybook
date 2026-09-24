// Attachments on tasks, notes and people (see _attachments.js):
//   POST   { action: 'keep', path, name, kind, bytes, targetType, targetId, caption } → { attachment }
//          (the file was uploaded first through /api/assistant?upload=1)
//   GET    ?ids=a,b → { urls: { [id]: signedUrl } }   short-lived links to view the files
//   DELETE { ids: [...] } → { removed }
import { getSupabase, readJsonBody, verifyRequestToken, verifyTokenVersion } from './db.js'
import { keepFile, removeAttachments, signedUrls } from './_attachments.js'

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }
  try {
    const decoded = verifyRequestToken(req)
    if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    const supabase = getSupabase()
    const sessionCheck = verifyTokenVersion(supabase, decoded)
    sessionCheck.catch(() => {})
    const userId = decoded.id

    if (req.method === 'GET') {
      const ids = String(req.query?.ids || req.query?.id || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100)
      if (!ids.length) return sendJson(res, 400, { error: 'Say which files.' })
      const [valid, { data, error }] = await Promise.all([sessionCheck, supabase.from('attachments').select('id, path').eq('user_id', userId).in('id', ids)])
      if (!valid) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      if (error) throw error
      const rows = data || []
      const byPath = await signedUrls(supabase, rows.map((row) => row.path))
      return sendJson(res, 200, { urls: Object.fromEntries(rows.map((row) => [row.id, byPath[row.path] || null])), expiresIn: 3600 })
    }

    const body = await readJsonBody(req)
    if (!(await sessionCheck)) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })

    if (req.method === 'POST' && body?.action === 'keep') {
      try {
        const attachment = await keepFile(supabase, userId, {
          fromPath: body.path, name: body.name, kind: body.kind, bytes: body.bytes, targetType: body.targetType, targetId: body.targetId, caption: body.caption,
        })
        return sendJson(res, 200, { attachment })
      } catch (error) {
        if (error.status) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) })
        throw error
      }
    }

    if (req.method === 'DELETE') {
      const ids = (Array.isArray(body?.ids) ? body.ids : [body?.id]).map(String).filter(Boolean).slice(0, 100)
      if (!ids.length) return sendJson(res, 400, { error: 'Say which files.' })
      const removed = await removeAttachments(supabase, userId, { ids })
      return sendJson(res, 200, { removed })
    }

    return sendJson(res, 404, { error: 'Unsupported request.' })
  } catch (error) {
    console.error('Files API error:', error)
    return sendJson(res, 500, { error: error.message || 'Unexpected error.' })
  }
}

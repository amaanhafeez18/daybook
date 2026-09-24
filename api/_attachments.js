// Photos and files pinned to a task, a note or a person (table attachments, migration
// 2026-09-29-attachments.sql). The file is a copy in the private assistant-uploads bucket under
// <userId>/keep/…, which the nightly upload cleanup skips (it only removes day folders). Shared by
// api/files.js (the app), api/assistant.js (the attach_file tool) and api/data.js (cascade deletes).
import { randomUUID } from 'crypto'
import { UPLOAD_BUCKET } from './_uploads.js'

export const ATTACHMENT_TARGETS = ['task', 'note', 'friend']
export const ATTACHMENTS_MIGRATION = 'Attachments aren’t set up yet: run supabase/migrations/2026-09-29-attachments.sql in Supabase.'
const KINDS = ['image', 'pdf']
const SIGNED_SECONDS = 60 * 60

export function isMissingAttachmentsTable(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  return /Could not find the table 'public\.attachments'|relation "attachments" does not exist/i.test(String(error.message || ''))
}

// A storage path this user may attach: their own folder, no traversal.
export function ownsPath(path, userId) {
  return typeof path === 'string' && path.startsWith(`${userId}/`) && !path.includes('..') && path.length < 300
}

export function keptPath(path, userId) {
  return ownsPath(path, userId) && path.startsWith(`${userId}/keep/`)
}

const safeName = (name, kind) => String(name || (kind === 'pdf' ? 'document.pdf' : 'photo.jpg')).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file'

export function rowToClient(row) {
  return {
    id: row.id, targetType: row.target_type, targetId: row.target_id, path: row.path, name: row.name, kind: row.kind,
    bytes: row.bytes ?? null, caption: row.caption ?? null, createdAt: row.created_at,
  }
}

// Copies an uploaded file (a day folder path, or one already kept) into <user>/keep/ and records it
// on the target. Returns the new row (client shape). Throws with .code 'attachments_missing' when
// the table hasn't been created, .status 400 for bad input.
export async function keepFile(supabase, userId, { fromPath, name, kind, bytes, targetType, targetId, caption }) {
  if (!ATTACHMENT_TARGETS.includes(targetType)) throw Object.assign(new Error('target must be task, note or friend.'), { status: 400 })
  if (!targetId || typeof targetId !== 'string') throw Object.assign(new Error('Say which task, note or person.'), { status: 400 })
  if (!ownsPath(fromPath, userId)) throw Object.assign(new Error('That file isn’t available any more. Attach it again.'), { status: 400 })
  const fileKind = KINDS.includes(kind) ? kind : 'image'
  const cleanName = String(name || '').replace(/[\r\n\t"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || (fileKind === 'pdf' ? 'document.pdf' : 'photo.jpg')
  let path = fromPath
  if (!keptPath(fromPath, userId)) {
    path = `${userId}/keep/${randomUUID()}-${safeName(cleanName, fileKind)}`
    const { error } = await supabase.storage.from(UPLOAD_BUCKET).copy(fromPath, path)
    if (error) throw Object.assign(new Error('That file isn’t available any more. Attach it again.'), { status: 410 })
  }
  const row = {
    id: randomUUID(), user_id: userId, target_type: targetType, target_id: String(targetId), path, name: cleanName, kind: fileKind,
    bytes: Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Math.round(Number(bytes)) : null,
    caption: typeof caption === 'string' && caption.trim() ? caption.trim().slice(0, 300) : null,
    created_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('attachments').insert(row)
  if (error) {
    if (path !== fromPath) await supabase.storage.from(UPLOAD_BUCKET).remove([path]).catch(() => {})
    if (isMissingAttachmentsTable(error)) throw Object.assign(new Error(ATTACHMENTS_MIGRATION), { code: 'attachments_missing', status: 503 })
    throw error
  }
  return rowToClient(row)
}

// Removes attachment rows (by ids, or everything on the given targets) and their stored files.
// Returns how many were removed. A missing table means nothing to remove.
export async function removeAttachments(supabase, userId, { ids = null, targetType = null, targetIds = null } = {}) {
  let query = supabase.from('attachments').select('id, path').eq('user_id', userId)
  if (ids) {
    if (!ids.length) return 0
    query = query.in('id', ids)
  } else {
    if (!targetType || !targetIds?.length) return 0
    query = query.eq('target_type', targetType).in('target_id', targetIds)
  }
  const { data, error } = await query
  if (error) {
    if (isMissingAttachmentsTable(error)) return 0
    throw error
  }
  const rows = data || []
  if (!rows.length) return 0
  const { error: deleteError } = await supabase.from('attachments').delete().eq('user_id', userId).in('id', rows.map((row) => row.id))
  if (deleteError) throw deleteError
  const paths = rows.map((row) => row.path).filter((path) => keptPath(path, userId))
  if (paths.length) await supabase.storage.from(UPLOAD_BUCKET).remove(paths).catch((err) => console.error('Attachment files not removed:', err?.message || err))
  return rows.length
}

// All of a user's attachments (client shape), or [] when the table doesn't exist yet.
export async function listAttachments(supabase, userId) {
  const { data, error } = await supabase.from('attachments').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(2000)
  if (error) {
    if (isMissingAttachmentsTable(error)) return []
    throw error
  }
  return (data || []).map(rowToClient)
}

// Short-lived URLs to view the files (the bucket is private).
export async function signedUrls(supabase, paths, seconds = SIGNED_SECONDS) {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(UPLOAD_BUCKET).createSignedUrls(paths, seconds)
  if (error) throw error
  const out = {}
  paths.forEach((path, index) => { if (data?.[index]?.signedUrl) out[path] = data[index].signedUrl })
  return out
}

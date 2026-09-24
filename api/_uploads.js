// Files people attach in the assistant are uploaded straight to this private bucket as
// <userId>/<YYYY-MM-DD>/<uuid>-<name> (see handleUpload in assistant.js). They are only needed
// for a few follow-up messages, so they are deleted after a few days, and with "Clear all data".

export const UPLOAD_BUCKET = 'assistant-uploads'
const PAGE = 1000

async function listNames(supabase, prefix) {
  const names = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from(UPLOAD_BUCKET).list(prefix, { limit: PAGE, offset })
    if (error) {
      if (/not found/i.test(error.message || '')) return names // no bucket yet: nothing to clean
      throw error
    }
    names.push(...(data || []).map((item) => item.name).filter(Boolean))
    if (!data || data.length < PAGE) return names
  }
}

async function removeFolder(supabase, prefix) {
  const files = await listNames(supabase, prefix)
  let removed = 0
  for (let index = 0; index < files.length; index += 100) {
    const batch = files.slice(index, index + 100).map((name) => `${prefix}/${name}`)
    const { error } = await supabase.storage.from(UPLOAD_BUCKET).remove(batch)
    if (error) throw error
    removed += batch.length
  }
  return removed
}

// Deletes every day-folder older than `days` for every user. Returns how many files were removed.
export async function removeOldUploads(supabase, days = 3, now = Date.now()) {
  const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 10)
  let removed = 0
  for (const userId of await listNames(supabase, '')) {
    for (const day of await listNames(supabase, userId)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) removed += await removeFolder(supabase, `${userId}/${day}`)
    }
  }
  return removed
}

// Deletes all of one user's uploads (Clear all data).
export async function removeUserUploads(supabase, userId) {
  let removed = 0
  for (const day of await listNames(supabase, userId)) removed += await removeFolder(supabase, `${userId}/${day}`)
  return removed
}

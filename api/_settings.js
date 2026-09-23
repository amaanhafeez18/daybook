// Settings writes shared by api/data.js (the app's saves) and the assistant.
// Files starting with "_" are not deployed as their own serverless functions.
import { randomUUID } from 'crypto'

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// Each changed field replaces the saved one, except an object over an object (notifications, gym,
// food), which merges one level deep. The database function patch_settings uses the same rules.
export function mergeSettings(saved, set) {
  const value = { ...(isPlainObject(saved) ? saved : {}) }
  for (const [field, next] of Object.entries(isPlainObject(set) ? set : {})) {
    value[field] = isPlainObject(next) && isPlainObject(value[field]) ? { ...value[field], ...next } : next
  }
  return value
}

// Replaces the user's whole settings value. Keeps one row per user: the first is updated and any
// duplicates are removed; a user without a row gets one.
export async function saveSettings(supabase, userId, value) {
  const payload = isPlainObject(value) ? value : {}
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

// patch_settings comes from supabase/migrations/2026-09-26-gym.sql. Until that has run, saves use the
// older read-modify-write; a missing function is remembered for a while (so each save doesn't pay for a
// failing call) and then tried again, in case the migration has run since.
const SETTINGS_RPC_RETRY_MS = 10 * 60 * 1000
let settingsRpcMissingAt = null
let warnedSettingsRpc = false

export function isMissingFunction(error) {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  return /Could not find the function/i.test(String(error.message || ''))
}

// Writes only the given fields (see mergeSettings). With patch_settings the merge runs in the database
// in one locked step, so a device saving its workout can't put back a change the assistant made a
// moment earlier. Returns the merged settings value when this call knows it (the read-modify-write
// fallback), or null (the database function returns nothing).
export async function patchSettingsAtomic(supabase, userId, patch) {
  const set = isPlainObject(patch) ? patch : {}
  if (settingsRpcMissingAt === null || Date.now() - settingsRpcMissingAt >= SETTINGS_RPC_RETRY_MS) {
    const { error } = await supabase.rpc('patch_settings', { p_user: userId, p_patch: set })
    if (!error) {
      settingsRpcMissingAt = null
      return null
    }
    if (!isMissingFunction(error)) throw error
    settingsRpcMissingAt = Date.now()
    if (!warnedSettingsRpc) {
      warnedSettingsRpc = true
      console.warn('Function "patch_settings" is missing; saving settings without it. Run supabase/migrations/2026-09-26-gym.sql in Supabase.')
    }
  }

  const { data, error } = await supabase.from('settings').select('value').eq('user_id', userId)
    .order('created_at', { ascending: false }).order('id').limit(1)
  if (error) throw error
  const value = mergeSettings(data?.[0]?.value, set)
  await saveSettings(supabase, userId, value)
  return value
}

// The name the contract's tool-module notes use.
export const writeSettingsPatch = patchSettingsAtomic

// Tests only: forget that the database function was missing.
export function resetSettingsRpcMemo() {
  settingsRpcMissingAt = null
  warnedSettingsRpc = false
}

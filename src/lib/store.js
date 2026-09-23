import { useSyncExternalStore } from 'react'
import { apiRequest, readJson, writeJson } from './api.js'

// One in-memory copy of the user's data, shared by every page.
//   * Pages read it synchronously, so switching tabs is instant.
//   * It starts from the device cache and refreshes from the server in the background.
//   * Edits apply immediately and are saved as small diffs (only what changed), queued per list,
//     retried when the connection comes back, and merged with server changes made elsewhere.

export const LIST_KEYS = ['tasks', 'events', 'friends', 'contactLogs', 'classes', 'journalEntries', 'voiceNotes']
const ALL_KEYS = [...LIST_KEYS, 'settings']
const CACHE_PREFIX = 'daybook.data.'
const SYNCED_PREFIX = 'daybook.synced.'
const SAVE_DELAY_MS = 350
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000]

function emptyData() {
  return { tasks: [], events: [], friends: [], contactLogs: [], classes: [], journalEntries: [], voiceNotes: [], settings: {} }
}

function isValid(key, value) {
  return key === 'settings' ? !!value && typeof value === 'object' && !Array.isArray(value) : Array.isArray(value)
}

let state = {
  data: emptyData(),
  loaded: false, // true once the cache or the server has provided data
  syncing: false,
  lastSyncedAt: null,
  pendingSaves: 0,
  saveError: '',
  offline: typeof navigator !== 'undefined' ? navigator.onLine === false : false,
}
const listeners = new Set()
let synced = {} // what the server is known to have, per key
const saveTimers = {}
const inFlight = {}
const saveAgain = {}
let retryTimer = null
let retryAttempt = 0
let refreshPromise = null
let generation = 0 // bumped on reset so late responses from a previous session are ignored

function setState(patch) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getState() {
  return state
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state))
}

export function useData(key) {
  return useStore((current) => current.data[key])
}

// ---- diffs -------------------------------------------------------------------------------

function sameValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function diffList(base, next) {
  const baseById = new Map((base || []).map((item) => [item.id, item]))
  const upsert = []
  const nextIds = new Set()
  for (const item of next || []) {
    nextIds.add(item.id)
    const previous = baseById.get(item.id)
    if (!previous || !sameValue(previous, item)) upsert.push(item)
  }
  const remove = (base || []).filter((item) => !nextIds.has(item.id)).map((item) => item.id)
  return { upsert, remove }
}

function applyDiff(list, { upsert, remove }) {
  const removed = new Set(remove)
  const replacements = new Map(upsert.map((item) => [item.id, item]))
  const result = list.filter((item) => !removed.has(item.id)).map((item) => replacements.get(item.id) || item)
  const present = new Set(result.map((item) => item.id))
  const added = upsert.filter((item) => !present.has(item.id))
  return added.length ? [...added, ...result] : result
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// Settings fields this device changed; plain-object fields (notifications) diff one level deep.
function settingsChanges(base, next) {
  const changes = {}
  for (const [field, value] of Object.entries(next || {})) {
    if (sameValue(base[field], value)) continue
    changes[field] = isPlainObject(value) && isPlainObject(base[field]) ? changedFields(base[field], value) : value
  }
  return changes
}

// Applies settingsChanges the same way the server's PATCH does.
function mergeSettings(server, changes) {
  const out = { ...server }
  for (const [field, value] of Object.entries(changes)) out[field] = isPlainObject(value) && isPlainObject(out[field]) ? { ...out[field], ...value } : value
  return out
}

function hasLocalChanges(key) {
  if (key === 'settings') return Object.keys(settingsChanges(synced.settings || {}, state.data.settings)).length > 0
  const { upsert, remove } = diffList(synced[key] || [], state.data[key])
  return upsert.length > 0 || remove.length > 0
}

// ---- loading -----------------------------------------------------------------------------

// Show whatever this device already has, instantly.
export function hydrateFromCache() {
  const data = emptyData()
  let found = false
  for (const key of ALL_KEYS) {
    const cached = readJson(CACHE_PREFIX + key)
    if (isValid(key, cached)) {
      data[key] = cached
      found = true
    }
    const confirmed = readJson(SYNCED_PREFIX + key)
    // Without a record of what the server had, assume the cache matches it.
    synced[key] = isValid(key, confirmed) ? confirmed : data[key]
  }
  setState({ data, loaded: found })
  for (const key of ALL_KEYS) if (hasLocalChanges(key)) scheduleSave(key, 0)
}

// Fetch everything from the server in one request and merge it with unsaved local edits.
export function refresh() {
  if (refreshPromise) return refreshPromise
  const startedIn = generation
  refreshPromise = (async () => {
    setState({ syncing: true })
    try {
      await flushAll()
      // What the server had before this read: saves that finish while the GET is in flight
      // must still count as local changes, whichever way the race goes.
      const base = { ...synced }
      const result = await apiRequest(`/api/data?keys=${ALL_KEYS.join(',')}`)
      if (startedIn !== generation) return
      const data = { ...state.data }
      for (const key of ALL_KEYS) {
        const server = isValid(key, result[key]) ? result[key] : emptyData()[key]
        if (key === 'settings') {
          // Settings are small: keep local values only for fields changed on this device.
          const local = settingsChanges(base.settings || {}, state.data.settings)
          data.settings = Object.keys(local).length ? mergeSettings(server, local) : server
        } else {
          const local = diffList(base[key] || [], state.data[key])
          data[key] = local.upsert.length || local.remove.length ? applyDiff(server, local) : server
        }
        synced[key] = server
        writeJson(SYNCED_PREFIX + key, server)
        writeJson(CACHE_PREFIX + key, data[key])
      }
      setState({ data, loaded: true, syncing: false, lastSyncedAt: Date.now(), offline: false })
      for (const key of ALL_KEYS) if (hasLocalChanges(key)) scheduleSave(key, 0)
    } catch (error) {
      if (startedIn !== generation) return
      setState({ syncing: false, loaded: true, offline: error.status === 0 })
      throw error
    } finally {
      if (startedIn === generation) refreshPromise = null
    }
  })()
  return refreshPromise
}

function changedFields(base, next) {
  return Object.fromEntries(Object.entries(next).filter(([field, value]) => !sameValue(base[field], value)))
}

// ---- editing & saving --------------------------------------------------------------------

export function updateData(key, updater) {
  const previous = state.data[key]
  const next = typeof updater === 'function' ? updater(previous) : updater
  if (next === previous) return
  setState({ data: { ...state.data, [key]: next } })
  writeJson(CACHE_PREFIX + key, next)
  scheduleSave(key)
}

export function updateSettings(patch) {
  updateData('settings', (current) => ({ ...current, ...patch }))
}

function scheduleSave(key, delay = SAVE_DELAY_MS) {
  clearTimeout(saveTimers[key])
  saveTimers[key] = setTimeout(() => flush(key), delay)
}

async function flush(key) {
  clearTimeout(saveTimers[key])
  if (inFlight[key]) {
    saveAgain[key] = true
    return inFlight[key]
  }
  const target = state.data[key]
  const base = synced[key]
  let request, upsert, remove, set
  if (key === 'settings') {
    // Only the fields changed here, so an old copy can't overwrite changes made elsewhere.
    set = settingsChanges(base || {}, target)
    if (!Object.keys(set).length) return
    request = { method: 'PATCH', body: { key, set } }
  } else {
    ;({ upsert, remove } = diffList(base || [], target))
    if (!upsert.length && !remove.length) return
    request = { method: 'PATCH', body: { key, upsert, delete: remove } }
  }

  const startedIn = generation
  setState({ pendingSaves: state.pendingSaves + 1 })
  inFlight[key] = (async () => {
    try {
      await apiRequest('/api/data', request)
      if (startedIn !== generation) return
      // A refresh may have replaced synced[key] meanwhile: apply this save on top of it instead.
      if (key === 'settings') synced.settings = synced.settings === base ? target : mergeSettings(synced.settings || {}, set)
      else synced[key] = synced[key] === base ? target : applyDiff(synced[key] || [], { upsert, remove })
      writeJson(SYNCED_PREFIX + key, synced[key])
      retryAttempt = 0
      setState({ saveError: '', offline: false })
    } catch (error) {
      if (startedIn !== generation || error.status === 401) return
      setState({ saveError: error.status === 0 ? '' : error.message, offline: error.status === 0 })
      scheduleRetry()
    } finally {
      if (startedIn === generation) {
        inFlight[key] = null
        setState({ pendingSaves: Math.max(0, state.pendingSaves - 1) })
        if (saveAgain[key]) {
          saveAgain[key] = false
          flush(key)
        }
      }
    }
  })()
  return inFlight[key]
}

export async function flushAll() {
  await Promise.all(ALL_KEYS.map((key) => flush(key)))
  await Promise.all(ALL_KEYS.map((key) => inFlight[key]))
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)]
  retryAttempt += 1
  retryTimer = setTimeout(retryUnsaved, delay)
}

export function retryUnsaved() {
  clearTimeout(retryTimer)
  for (const key of ALL_KEYS) if (hasLocalChanges(key)) flush(key)
}

export function hasUnsavedChanges() {
  return ALL_KEYS.some((key) => hasLocalChanges(key))
}

// Forget everything (sign-out). Pending saves from the old session are dropped.
export function resetStore() {
  generation += 1
  for (const key of ALL_KEYS) {
    clearTimeout(saveTimers[key])
    inFlight[key] = null
    saveAgain[key] = false
  }
  clearTimeout(retryTimer)
  retryAttempt = 0
  refreshPromise = null
  synced = {}
  setState({ data: emptyData(), loaded: false, syncing: false, lastSyncedAt: null, pendingSaves: 0, saveError: '', offline: false })
}

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// Keep in sync when the connection returns or the app comes back to the foreground.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setState({ offline: false })
    retryUnsaved()
  })
  window.addEventListener('offline', () => setState({ offline: true }))
  // iOS suspends a backgrounded home-screen app, so send pending saves before that happens.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') retryUnsaved()
  })
}

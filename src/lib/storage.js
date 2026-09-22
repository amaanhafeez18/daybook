const SESSION_KEY = 'daybook.session.token'
const USER_KEY = 'daybook.session.user'
const DATA_CACHE_PREFIX = 'daybook.data.'
const saveQueues = new Map()
const pendingSaves = new Set()

export function getToken() {
  try {
    return localStorage.getItem(SESSION_KEY) || ''
  } catch {
    return ''
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(SESSION_KEY, token)
    } else {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    // ignore storage errors in the browser
  }
}

async function requestJson(url, options = {}) {
  const token = getToken()
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(url, {
    ...options,
    headers,
  })

  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { error: `Server error (${response.status}). Please try again.` }
  }

  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed')
    error.status = response.status
    // A 401 on a data request means the saved session is no longer valid.
    if (response.status === 401 && token && url !== '/api/auth') {
      notify('daybook:session-expired')
    }
    throw error
  }

  return payload
}

function notify(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {
    // no window (tests/SSR)
  }
}

export async function load(key, fallback) {
  const token = getToken()
  if (!token) return fallback

  if (pendingSaves.has(key)) return readDataCache(key, fallback)

  try {
    const data = await requestJson(`/api/data?key=${encodeURIComponent(key)}`)
    const valid = Array.isArray(fallback) ? Array.isArray(data) : data && typeof data === 'object'
    if (!valid) return readDataCache(key, fallback)
    writeDataCache(key, data)
    return data
  } catch {
    return readDataCache(key, fallback)
  }
}

export async function save(key, value) {
  const token = getToken()
  if (!token) return
  writeDataCache(key, value)
  const previous = saveQueues.get(key) || Promise.resolve()
  pendingSaves.add(key)
  const next = previous.catch(() => {}).then(() => requestJson('/api/data', {
    method: 'PUT',
    body: JSON.stringify({ key, value })
  }))
  saveQueues.set(key, next)
  try {
    await next
    notify('daybook:save-ok', { key })
  } catch (error) {
    notify('daybook:save-error', { key, message: error.message })
  } finally {
    if (saveQueues.get(key) === next) pendingSaves.delete(key)
  }
}

function readDataCache(key, fallback) {
  try {
    const raw = localStorage.getItem(`${DATA_CACHE_PREFIX}${key}`)
    if (!raw) return fallback
    const value = JSON.parse(raw)
    return Array.isArray(fallback) ? (Array.isArray(value) ? value : fallback) : value
  } catch {
    return fallback
  }
}

export function readCachedData(key, fallback) {
  return readDataCache(key, fallback)
}

function writeDataCache(key, value) {
  try { localStorage.setItem(`${DATA_CACHE_PREFIX}${key}`, JSON.stringify(value)) } catch { /* ignore quota errors */ }
}

export async function authRequest(action, payload = {}) {
  const response = await requestJson('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ action, ...payload })
  })

  if (response.token) {
    setToken(response.token)
  }
  if (response.user) {
    writeJson(USER_KEY, response.user)
  }

  return response
}

export async function validateSession() {
  const token = getToken()
  if (!token) return null

  try {
    const response = await requestJson('/api/auth')
    if (response.user) writeJson(USER_KEY, response.user)
    return response.user || null
  } catch (error) {
    // Only a rejected token logs you out. Offline or server hiccups keep the
    // last known user so the installed app still opens with cached data.
    if (error.status === 401) {
      clearSession()
      return null
    }
    return readJson(USER_KEY)
  }
}

// Removes the token, the cached user and every cached data list, so the next
// person to log in on this device never sees the previous user's data.
export function clearSession() {
  setToken('')
  try {
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey === USER_KEY || storageKey.startsWith(DATA_CACHE_PREFIX)) localStorage.removeItem(storageKey)
    }
  } catch {
    // ignore storage errors in the browser
  }
}

function readJson(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || 'null')
  } catch {
    return null
  }
}

function writeJson(storageKey, value) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* ignore quota errors */ }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export function todayISO() {
  return toLocalISO(new Date())
}

// Adds days to a YYYY-MM-DD date in local time (toISOString() would shift to UTC).
export function addDaysISO(iso, delta) {
  const date = new Date(`${iso}T12:00:00`)
  date.setDate(date.getDate() + delta)
  return toLocalISO(date)
}

// "14:30" -> "2:30 PM"; anything else (e.g. "9:00 AM - 10:30 AM") is returned unchanged.
export function formatTime12(value) {
  if (!value) return ''
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) return value
  const hour = Number(match[1])
  const suffix = hour >= 12 ? 'PM' : 'AM'
  return `${hour % 12 || 12}:${match[2]} ${suffix}`
}

function toLocalISO(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const SESSION_KEY = 'daybook.session.token'
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
  const payload = text ? JSON.parse(text) : {}

  if (!response.ok) {
    throw new Error(payload.error || 'Request failed')
  }

  return payload
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
  try { await next } catch { /* cache keeps the latest local state available */ }
  finally { if (saveQueues.get(key) === next) pendingSaves.delete(key) }
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

  return response
}

export async function validateSession() {
  const token = getToken()
  if (!token) return null

  try {
    const response = await requestJson('/api/auth')
    return response.user || null
  } catch {
    setToken('')
    return null
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export function todayISO() {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

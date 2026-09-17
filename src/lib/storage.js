const SESSION_KEY = 'daybook.session.token'

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

  try {
    const data = await requestJson(`/api/data?key=${encodeURIComponent(key)}`)
    if (Array.isArray(fallback)) return Array.isArray(data) ? data : fallback
    return data && typeof data === 'object' ? data : fallback
  } catch {
    return fallback
  }
}

export async function save(key, value) {
  const token = getToken()
  if (!token) return

  try {
    await requestJson('/api/data', {
      method: 'PUT',
      body: JSON.stringify({ key, value })
    })
  } catch {
    // fail silently; app will still work in memory if the network is unavailable
  }
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

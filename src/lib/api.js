const TOKEN_KEY = 'daybook.session.token'
const USER_KEY = 'daybook.session.user'
// Everything the app caches for the signed-in user. Device preferences live under daybook.prefs.
const USER_CACHE_PREFIXES = ['daybook.data.', 'daybook.synced.', 'daybook.chat', 'daybook.backup.']

export const SESSION_EXPIRED_EVENT = 'daybook:session-expired'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage unavailable (private mode); the session just won't persist
  }
}

export function getCachedUser() {
  return readJson(USER_KEY)
}

export function setCachedUser(user) {
  writeJson(USER_KEY, user)
}

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // quota or private mode: caching is best-effort
  }
}

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

// JSON request with the session token. A 401 on anything but the session check means the
// saved session is no longer valid, so the app is told to sign out.
export async function apiRequest(url, { method = 'GET', body, headers, signal } = {}) {
  const token = getToken()
  let response
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('You’re offline. Changes are saved on this device and will sync later.', 0)
  }

  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { error: `Server error (${response.status}). Please try again.` }
  }

  if (!response.ok) {
    if (response.status === 401 && token && !(url === '/api/auth' && method === 'GET')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    }
    throw new ApiError(payload.error || 'Something went wrong. Please try again.', response.status, payload)
  }
  return payload
}

export async function authRequest(action, payload = {}) {
  const response = await apiRequest('/api/auth', { method: 'POST', body: { action, ...payload } })
  if (response.token) setToken(response.token)
  if (response.user) setCachedUser(response.user)
  return response
}

// Returns the current user, null if the session was rejected, or throws when offline so the
// app can keep running from its cache.
export async function fetchSession() {
  if (!getToken()) return null
  try {
    const response = await apiRequest('/api/auth')
    if (response.user) setCachedUser(response.user)
    return response.user || null
  } catch (error) {
    if (error.status === 401) return null
    throw error
  }
}

// Removes the session and everything cached for this user so the next person on the device
// starts clean.
export function clearSession() {
  setToken('')
  try {
    localStorage.removeItem(USER_KEY)
    for (const key of Object.keys(localStorage)) {
      if (USER_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
}

export function readPref(name, fallback) {
  return readJson(`daybook.prefs.${name}`, fallback)
}

export function writePref(name, value) {
  writeJson(`daybook.prefs.${name}`, value)
}

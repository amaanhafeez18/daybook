import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

// apiRequest (src/lib/api.js): a request that never answers must not hang forever (the store's
// refresh and per-list saves wait on it), and a caller's own signal is respected.

class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}
globalThis.localStorage = new MemoryStorage()
globalThis.window = { dispatchEvent() {} }

const { apiRequest, ApiError, clearUserCaches } = await import('../src/lib/api.js')

const realFetch = globalThis.fetch
const realTimeout = AbortSignal.timeout
const timeoutError = () => (typeof DOMException === 'function' ? new DOMException('The operation was aborted due to timeout', 'TimeoutError') : Object.assign(new Error('timeout'), { name: 'TimeoutError' }))

let seen = []
beforeEach(() => {
  seen = []
  // A fetch that answers only when the signal lets it: an already-aborted signal rejects with its reason.
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url, signal: options.signal })
    if (options.signal?.aborted) throw options.signal.reason
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  AbortSignal.timeout = realTimeout
})

describe('apiRequest timeouts', () => {
  test('every request carries a timeout signal by default', async () => {
    await apiRequest('/api/data?keys=tasks')
    assert.ok(seen[0].signal instanceof AbortSignal, 'a default AbortSignal is attached')
    assert.equal(seen[0].signal.aborted, false)
  })

  test('a request that times out fails with a retryable 408, not "offline"', async () => {
    AbortSignal.timeout = () => AbortSignal.abort(timeoutError())
    await assert.rejects(apiRequest('/api/data', { method: 'PATCH', body: { key: 'tasks', upsert: [], delete: [] } }), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 408)
      assert.match(error.message, /too long/)
      return true
    })
  })

  test('a caller’s own signal replaces the default one', async () => {
    AbortSignal.timeout = () => { throw new Error('the default must not be used') }
    const controller = new AbortController()
    await apiRequest('/api/food', { method: 'POST', body: {}, signal: controller.signal })
    assert.equal(seen[0].signal, controller.signal)
  })

  test('a caller’s abort still surfaces as AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(apiRequest('/api/food', { method: 'POST', body: {}, signal: controller.signal }), (error) => error.name === 'AbortError')
  })

  test('a dropped connection is still reported as offline (status 0)', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    await assert.rejects(apiRequest('/api/data'), (error) => error instanceof ApiError && error.status === 0)
  })
})

// clearUserCaches: like the browser's storage, Object.keys() lists what's stored.
function plainStorage(entries = {}) {
  const store = { ...entries }
  Object.defineProperties(store, {
    getItem: { value: (key) => (Object.hasOwn(store, key) ? store[key] : null) },
    setItem: { value: (key, value) => { store[key] = String(value) } },
    removeItem: { value: (key) => { delete store[key] } },
  })
  return store
}

describe('clearUserCaches', () => {
  const realLocal = globalThis.localStorage
  afterEach(() => {
    globalThis.localStorage = realLocal
    delete globalThis.sessionStorage
  })

  const session = () => ({
    'daybook.draft.person:new': '{"value":{"name":"Sam"}}',
    'daybook.draft.task:new': '{"value":{"title":"Call"}}',
    'daybook.gym.routineDraft.r1': '{"user":"u1"}',
    'other.app': 'kept',
  })

  test('signing out removes the unsaved form drafts, so the next account doesn’t see them', () => {
    globalThis.localStorage = plainStorage({ 'daybook.session.token': 'x', 'daybook.data.tasks': '[]', 'daybook.gym.active': '{}', 'daybook.prefs.theme': '"blue"' })
    globalThis.sessionStorage = plainStorage(session())
    clearUserCaches()
    assert.deepEqual(Object.keys(sessionStorage).sort(), ['daybook.gym.routineDraft.r1', 'other.app'])
    assert.deepEqual(Object.keys(localStorage).sort(), ['daybook.gym.active', 'daybook.prefs.theme'])
  })

  test('"Clear all data" keeps the session and removes every draft and the gym state', () => {
    globalThis.localStorage = plainStorage({ 'daybook.session.token': 'x', 'daybook.data.tasks': '[]', 'daybook.gym.active': '{}' })
    globalThis.sessionStorage = plainStorage(session())
    clearUserCaches({ keepSession: true })
    assert.deepEqual(Object.keys(sessionStorage), ['other.app'])
    assert.deepEqual(Object.keys(localStorage), ['daybook.session.token'])
  })
})

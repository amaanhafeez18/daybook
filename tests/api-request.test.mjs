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

const { apiRequest, ApiError } = await import('../src/lib/api.js')

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

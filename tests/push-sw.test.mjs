// public/push-sw.js runs inside the service worker; here it runs in a node:vm sandbox with a fake `self`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8')

// Loads the worker script with spies → { push(event payload), calls }.
function loadWorker({ navigator = 'spy' } = {}) {
  const calls = { shown: [], setAppBadge: [], clearAppBadge: 0 }
  const listeners = {}
  const nav = navigator === 'spy'
    ? {
      setAppBadge: (count) => { calls.setAppBadge.push(count); return Promise.resolve() },
      clearAppBadge: () => { calls.clearAppBadge += 1; return Promise.resolve() },
    }
    : navigator
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler },
    registration: { showNotification: (title, options) => { calls.shown.push({ title, options }); return Promise.resolve() } },
    navigator: nav,
    location: { origin: 'https://example.test' },
    clients: { matchAll: async () => [], openWindow: async () => null },
  }
  vm.runInNewContext(SOURCE, { self, URL, Promise })
  // body: an object (sent as JSON) or a string that isn't JSON.
  const push = async (body) => {
    let waited = null
    const event = {
      data: body === undefined ? null : {
        json: () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: () => (typeof body === 'string' ? body : JSON.stringify(body)),
      },
      waitUntil: (promise) => { waited = promise },
    }
    listeners.push(event)
    assert.ok(waited, 'push handler called waitUntil')
    return waited
  }
  return { push, calls, listeners }
}

describe('push service worker: notification and app icon count', () => {
  test('a count sets the badge and still shows the notification', async () => {
    const worker = loadWorker()
    await worker.push({ title: 'zz-Task', body: 'Due today', url: '/#/tasks/1', tag: 'task-1', appBadge: 3 })
    assert.deepEqual(worker.calls.setAppBadge, [3])
    assert.equal(worker.calls.clearAppBadge, 0)
    assert.equal(worker.calls.shown.length, 1)
    assert.equal(worker.calls.shown[0].title, 'zz-Task')
    assert.equal(worker.calls.shown[0].options.data.url, '/#/tasks/1')
  })

  test('0 clears the badge; a huge count is capped', async () => {
    const worker = loadWorker()
    await worker.push({ title: 'zz-Done', appBadge: 0 })
    assert.equal(worker.calls.clearAppBadge, 1)
    assert.deepEqual(worker.calls.setAppBadge, [])
    await worker.push({ title: 'zz-Many', appBadge: 123456 })
    assert.deepEqual(worker.calls.setAppBadge, [9999])
  })

  test('no appBadge field: the badge is left alone', async () => {
    const worker = loadWorker()
    await worker.push({ title: 'zz-Plain', body: 'x' })
    assert.deepEqual(worker.calls.setAppBadge, [])
    assert.equal(worker.calls.clearAppBadge, 0)
    assert.equal(worker.calls.shown.length, 1)
  })

  test('a badge call that throws or rejects never stops the notification', async () => {
    const throwing = loadWorker({ navigator: { setAppBadge: () => { throw new Error('denied') }, clearAppBadge: () => Promise.reject(new Error('denied')) } })
    await throwing.push({ title: 'zz-A', appBadge: 2 })
    await throwing.push({ title: 'zz-B', appBadge: 0 })
    assert.deepEqual(throwing.calls.shown.map((item) => item.title), ['zz-A', 'zz-B'])
    const rejecting = loadWorker({ navigator: { setAppBadge: () => Promise.reject(new Error('denied')) } })
    await rejecting.push({ title: 'zz-C', appBadge: 5 })
    assert.equal(rejecting.calls.shown.length, 1)
  })

  test('a worker without badge methods (or navigator) does not throw', async () => {
    const bare = loadWorker({ navigator: {} })
    await bare.push({ title: 'zz-D', appBadge: 4 })
    assert.equal(bare.calls.shown.length, 1)
    const none = loadWorker({ navigator: null })
    await none.push({ title: 'zz-E', appBadge: 4 })
    assert.equal(none.calls.shown.length, 1)
  })

  test('a body that is not JSON still shows a notification', async () => {
    const worker = loadWorker()
    await worker.push('plain text, not JSON')
    assert.equal(worker.calls.shown.length, 1)
    assert.equal(worker.calls.shown[0].title, 'Daybook')
    assert.equal(worker.calls.shown[0].options.body, 'plain text, not JSON')
    assert.deepEqual(worker.calls.setAppBadge, [])
    await worker.push(undefined) // no data at all
    assert.equal(worker.calls.shown.length, 2)
    assert.ok(worker.listeners.notificationclick)
  })
})

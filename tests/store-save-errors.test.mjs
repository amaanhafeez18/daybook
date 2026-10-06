import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

// A fake browser (localStorage) and a fake /api/data that can turn saves of some lists down.
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
  key: (index) => [...memory.keys()][index] ?? null,
  get length() { return memory.size },
}

const server = { data: {}, reject: new Map(), down: false }

globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  if (server.down) throw new TypeError('Failed to fetch')
  const parsed = body ? JSON.parse(body) : undefined
  if (method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify(server.data) }
  if (server.reject.has(parsed.key)) {
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: server.reject.get(parsed.key) }) }
  }
  if (parsed.key !== 'settings') {
    const removed = new Set(parsed.delete || [])
    const rows = (server.data[parsed.key] || []).filter((row) => !removed.has(row.id))
    for (const row of parsed.upsert || []) {
      const index = rows.findIndex((item) => item.id === row.id)
      if (index >= 0) rows[index] = row
      else rows.push(row)
    }
    server.data[parsed.key] = rows
  }
  return { ok: true, status: 200, text: async () => '{"ok":true}' }
}

const store = await import('../src/lib/store.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function settle() {
  await sleep(5)
  await store.flushAll()
}

beforeEach(async () => {
  store.resetStore()
  memory.clear()
  server.reject.clear()
  server.down = false
  server.data = { tasks: [{ id: 't1', title: 'One' }], journalEntries: [], settings: { displayName: 'Test' } }
  await store.refresh()
})

after(() => store.resetStore())

test('a rejected save stays an error until that list saves', async () => {
  server.reject.set('tasks', 'Title is too long')
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  assert.equal(store.getState().saveError, 'Title is too long')
  assert.equal(store.saveStatus(store.getState(), true), 'error')

  server.reject.clear()
  store.retryUnsaved()
  await settle()
  assert.equal(store.getState().saveError, '')
  assert.equal(store.getState().pendingSaves, 0)
  assert.deepEqual(server.data.tasks.map((task) => task.id), ['t1', 't2'])
})

test('another list saving fine does not hide a failure', async () => {
  server.reject.set('tasks', 'Title is too long')
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  store.updateData('journalEntries', [{ id: 'j1', date: '2026-10-06', text: 'Hi' }])
  await settle()
  assert.deepEqual(server.data.journalEntries.map((entry) => entry.id), ['j1'])
  assert.equal(store.getState().saveError, 'Title is too long')
})

test('undoing the edit that was turned down clears the failure', async () => {
  server.reject.set('tasks', 'Title is too long')
  const before = store.getState().data.tasks
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  assert.equal(store.getState().saveError, 'Title is too long')
  store.updateData('tasks', before)
  await settle()
  assert.equal(store.getState().saveError, '')
})

test('offline is not a rejection, and signing out forgets failures', async () => {
  server.down = true
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  assert.equal(store.getState().offline, true)
  assert.equal(store.getState().saveError, '')
  assert.equal(store.saveStatus(store.getState()), 'offline')

  server.down = false
  server.reject.set('tasks', 'Nope')
  store.retryUnsaved()
  await settle()
  assert.equal(store.getState().saveError, 'Nope')
  store.resetStore()
  assert.equal(store.getState().saveError, '')
})

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

test('saveErrors keeps each list’s failure until that list saves, whichever failed last', async () => {
  // e.g. food entries turned down because the food migration hasn't been run, then a task save
  // fails too: the food failure must stay visible to the food page.
  server.reject.set('foodEntries', 'Food data needs a database update')
  store.updateData('foodEntries', [{ id: 'f1', date: '2026-10-06', name: 'Toast' }])
  await settle()
  assert.deepEqual(store.getState().saveErrors, { foodEntries: 'Food data needs a database update' })

  server.reject.set('tasks', 'Title is too long')
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  assert.equal(store.getState().saveError, 'Title is too long')
  assert.deepEqual(store.getState().saveErrors, { foodEntries: 'Food data needs a database update', tasks: 'Title is too long' })

  // Turned down again with the same messages: the same object, so nothing re-renders.
  const errors = store.getState().saveErrors
  await store.retryUnsaved()
  assert.equal(store.getState().saveErrors, errors)

  server.reject.delete('tasks')
  await store.retryUnsaved()
  assert.deepEqual(store.getState().saveErrors, { foodEntries: 'Food data needs a database update' })
  assert.equal(store.getState().saveError, 'Food data needs a database update')

  store.resetStore()
  assert.deepEqual(store.getState().saveErrors, {})
})

test('retryUnsaved resolves once the saves are done, and clears a failure with nothing left to send', async () => {
  server.reject.set('tasks', 'Nope')
  store.updateData('tasks', (tasks) => [...tasks, { id: 't2', title: 'Two' }])
  await settle()
  assert.equal(store.getState().saveError, 'Nope')

  // Still turned down: known as soon as the retry resolves.
  await store.retryUnsaved()
  assert.equal(store.getState().saveError, 'Nope')
  assert.equal(store.getState().pendingSaves, 0)

  // The same task was saved from another device: after a refresh there's nothing left to send here.
  server.data.tasks = [...server.data.tasks, { id: 't2', title: 'Two' }]
  await store.refresh()
  assert.equal(store.hasUnsavedChanges(), false)
  assert.equal(store.getState().saveError, 'Nope')
  await store.retryUnsaved()
  assert.equal(store.getState().saveError, '')
  assert.deepEqual(store.getState().saveErrors, {})
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

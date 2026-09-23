import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

// ---- a fake browser: localStorage with a quota, and a fake /api/data server --------------------

class QuotaError extends Error {
  constructor() {
    super('QuotaExceededError')
    this.name = 'QuotaExceededError'
  }
}

// Like the browser's: a failed setItem throws and leaves the old value in place.
class MemoryStorage {
  constructor() {
    this.map = new Map()
    this.quota = Infinity // characters, keys included
    this.failing = new Set() // keys whose writes throw
  }
  get length() { return this.map.size }
  key(index) { return [...this.map.keys()][index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) {
    const text = String(value)
    if (this.failing.has(key)) throw new QuotaError()
    const current = this.map.has(key) ? key.length + this.map.get(key).length : 0
    if (this.used() - current + key.length + text.length > this.quota) throw new QuotaError()
    this.map.set(key, text)
  }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
  used() {
    let total = 0
    for (const [key, value] of this.map) total += key.length + value.length
    return total
  }
}

const storage = new MemoryStorage()
globalThis.localStorage = storage

// missingColumns: { [key]: [field] } — columns the fake database doesn't have yet (a migration not
// run): saves leave them out and reply with `dropped`, like api/data.js.
const server = { data: {}, requests: [], down: false, missingColumns: {} }

function applyPatch({ key, upsert, delete: remove, set }) {
  if (key === 'settings') {
    const value = { ...(server.data.settings || {}) }
    for (const [field, next] of Object.entries(set || {})) {
      const plain = (item) => !!item && typeof item === 'object' && !Array.isArray(item)
      value[field] = plain(next) && plain(value[field]) ? { ...value[field], ...next } : next
    }
    server.data.settings = value
    return
  }
  const removed = new Set(remove || [])
  const list = (server.data[key] || []).filter((row) => !removed.has(row.id))
  const missing = server.missingColumns[key] || []
  const dropped = new Set()
  for (const sent of upsert || []) {
    const row = { ...sent }
    for (const field of missing) {
      if (field in row) dropped.add(field)
      delete row[field]
    }
    const index = list.findIndex((item) => item.id === row.id)
    if (index >= 0) list[index] = { ...list[index], ...row } // like an upsert: unsent columns keep their value
    else list.unshift(row)
  }
  server.data[key] = list
  return dropped.size ? { ok: true, dropped: [...dropped] } : { ok: true }
}

globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  if (server.down) throw new TypeError('Failed to fetch')
  const parsed = body ? JSON.parse(body) : undefined
  server.requests.push({ url, method, body: parsed })
  let payload = {}
  if (method === 'GET') payload = structuredClone(server.data)
  else if (method === 'PATCH') payload = applyPatch(parsed) || { ok: true }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

const store = await import('../src/lib/store.js')

// ---- helpers ------------------------------------------------------------------------------------

const CACHE = 'daybook.data.'
const RECORD = 'daybook.synced.'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stored = (key) => JSON.parse(storage.getItem(key))
const patches = () => server.requests.filter((request) => request.method === 'PATCH')
const deletesSent = () => patches().flatMap((request) => request.body.delete || [])
const ids = (list) => list.map((row) => row.id).sort()

function session(id, date, note = '') {
  return {
    id,
    date,
    name: 'Push',
    routineId: null,
    startedAt: `${date}T10:00:00.000Z`,
    endedAt: `${date}T11:00:00.000Z`,
    durationSec: 3600,
    exercises: Array.from({ length: 6 }, (_, e) => ({
      id: `${id}-row-${e}`,
      exerciseId: `ex-${e}`,
      name: `Exercise ${e}`,
      tracking: 'weight_reps',
      note: '',
      sets: Array.from({ length: 4 }, (_, s) => ({ id: `${id}-${e}-${s}`, type: 'normal', weightKg: 60 + s * 5, reps: 8, rpe: null, done: true })),
    })),
    note,
    planned: null,
    bodyweightKg: 80,
    isDeload: false,
    createdAt: `${date}T11:00:00.000Z`,
  }
}

// Let saves scheduled with a 0 ms delay start, then wait for them.
async function settle() {
  await sleep(5)
  await store.flushAll()
}

// A new launch of the app on this device: memory is gone, localStorage stays.
async function relaunch() {
  store.resetStore()
  store.hydrateFromCache()
  await settle()
}

beforeEach(() => {
  store.resetStore()
  storage.clear()
  storage.quota = Infinity
  storage.failing.clear()
  server.down = false
  server.requests = []
  server.missingColumns = {}
  server.data = {
    tasks: [{ id: 't1', title: 'Task one' }],
    gymSessions: [session('s1', '2026-09-20')],
    settings: { displayName: 'Test', gym: { routines: [], prefs: { unit: 'kg' } } },
  }
})

after(() => store.resetStore())

// ---- tests --------------------------------------------------------------------------------------

describe('device copy', () => {
  test('storage filling up during a refresh never turns into deletes on the next launch', async () => {
    store.hydrateFromCache()
    await store.refresh()
    assert.deepEqual(ids(stored(CACHE + 'gymSessions')), ['s1'])

    // Two workouts logged elsewhere. Storage has room for one more copy of them and a little
    // more: the first write fits and the second doesn't (with the record written first, that
    // left an old cache next to a new record, and the next launch deleted s2 and s3).
    const before = JSON.stringify(server.data.gymSessions).length
    server.data.gymSessions = [session('s3', '2026-09-22'), session('s2', '2026-09-21'), ...server.data.gymSessions]
    storage.quota = storage.used() + JSON.stringify(server.data.gymSessions).length - before + 20
    await store.refresh()
    assert.equal(storage.getItem(CACHE + 'gymSessions'), null, 'no stale cache is left behind')
    assert.equal(storage.getItem(RECORD + 'gymSessions'), null, 'no record without a cache')
    assert.ok(storage.getItem(CACHE + 'tasks'), 'other keys are still cached')

    server.requests = []
    await relaunch()
    assert.deepEqual(deletesSent(), [])
    assert.deepEqual(patches(), [])
    assert.deepEqual(ids(server.data.gymSessions), ['s1', 's2', 's3'])

    // Room again: the next refresh stores both copies, and they agree.
    storage.quota = Infinity
    await store.refresh()
    assert.deepEqual(ids(stored(CACHE + 'gymSessions')), ['s1', 's2', 's3'])
    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])
  })

  test('a failed cache write removes both copies of that list, and a later save restores them', async () => {
    store.hydrateFromCache()
    await store.refresh()
    assert.ok(storage.getItem(CACHE + 'gymSessions'))
    assert.ok(storage.getItem(RECORD + 'gymSessions'))

    storage.failing.add(CACHE + 'gymSessions')
    store.updateData('gymSessions', (list) => [session('s2', '2026-09-21'), ...list])
    assert.equal(storage.getItem(CACHE + 'gymSessions'), null)
    assert.equal(storage.getItem(RECORD + 'gymSessions'), null)

    // Still full when the save lands: the record isn't written on its own either.
    await store.flushAll()
    assert.equal(storage.getItem(CACHE + 'gymSessions'), null)
    assert.equal(storage.getItem(RECORD + 'gymSessions'), null)
    assert.deepEqual(ids(server.data.gymSessions), ['s1', 's2'])

    // Space freed: the next confirmed save writes the cache first, then the record.
    storage.failing.clear()
    store.updateData('gymSessions', (list) => list.map((row) => (row.id === 's1' ? { ...row, note: 'Felt strong' } : row)))
    await store.flushAll()
    assert.deepEqual(ids(stored(CACHE + 'gymSessions')), ['s1', 's2'])
    assert.equal(stored(RECORD + 'gymSessions').length, 2)

    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])
  })

  test('a failed record write removes the cache too', async () => {
    store.hydrateFromCache()
    await store.refresh()
    storage.failing.add(RECORD + 'tasks')
    store.updateData('tasks', (list) => [...list, { id: 't2', title: 'Task two' }])
    assert.ok(storage.getItem(CACHE + 'tasks'), 'the cache write itself worked')
    await store.flushAll()
    assert.equal(storage.getItem(CACHE + 'tasks'), null)
    assert.equal(storage.getItem(RECORD + 'tasks'), null)

    server.requests = []
    await relaunch()
    assert.deepEqual(patches(), [])
    assert.deepEqual(ids(server.data.tasks), ['t1', 't2'])
  })

  test('a record without a cache is ignored (no deletes from an older device state)', async () => {
    storage.setItem(RECORD + 'gymSessions', JSON.stringify([{ id: 's1', h: 'abc' }, { id: 's9', h: 'def' }]))
    storage.setItem(RECORD + 'tasks', JSON.stringify([{ id: 't1', title: 'Task one' }]))
    await relaunch()
    assert.deepEqual(patches(), [])
  })
})

describe('gym session fingerprints', () => {
  test('the record of gymSessions is stored as { id, h }; other lists keep full rows', async () => {
    server.data.gymSessions = [session('s2', '2026-09-21'), session('s1', '2026-09-20')]
    store.hydrateFromCache()
    await store.refresh()
    const record = stored(RECORD + 'gymSessions')
    assert.equal(record.length, 2)
    for (const entry of record) {
      assert.deepEqual(Object.keys(entry).sort(), ['h', 'id'])
      assert.equal(typeof entry.h, 'string')
    }
    assert.deepEqual(stored(RECORD + 'tasks'), server.data.tasks)
    assert.ok(JSON.stringify(record).length < JSON.stringify(stored(CACHE + 'gymSessions')).length / 20)
  })

  test('unchanged rows match their fingerprint; edits and deletes are found and sent', async () => {
    server.data.gymSessions = [session('s3', '2026-09-22'), session('s2', '2026-09-21'), session('s1', '2026-09-20')]
    store.hydrateFromCache()
    await store.refresh()

    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])

    // An edit after a launch from fingerprints sends only that row.
    store.updateData('gymSessions', (list) => list.map((row) => (row.id === 's2' ? { ...row, note: 'Edited' } : row)))
    assert.equal(store.hasUnsavedChanges(), true)
    await store.flushAll()
    assert.equal(patches().length, 1)
    assert.deepEqual(patches()[0].body.upsert.map((row) => row.id), ['s2'])
    assert.deepEqual(patches()[0].body.delete, [])
    assert.equal(server.data.gymSessions.find((row) => row.id === 's2').note, 'Edited')

    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])

    // A delete made offline survives a relaunch and is sent afterwards.
    server.down = true
    store.updateData('gymSessions', (list) => list.filter((row) => row.id !== 's1'))
    await store.flushAll()
    server.down = false
    server.requests = []
    await relaunch()
    assert.deepEqual(deletesSent(), ['s1'])
    assert.deepEqual(patches()[0].body.upsert, [])
    assert.deepEqual(ids(server.data.gymSessions), ['s2', 's3'])
  })

  test('a refresh keeps an unsaved local edit on top of a fingerprint base', async () => {
    store.hydrateFromCache()
    await store.refresh()
    server.down = true
    store.updateData('gymSessions', (list) => list.map((row) => ({ ...row, note: 'Offline note' })))
    await store.flushAll()
    await relaunch() // still down: the save waits
    server.down = false
    server.data.gymSessions = [session('s4', '2026-09-23'), ...server.data.gymSessions]
    await store.refresh()
    await settle()
    const shown = store.getState().data.gymSessions
    assert.deepEqual(ids(shown), ['s1', 's4'])
    assert.equal(shown.find((row) => row.id === 's1').note, 'Offline note')
    assert.equal(server.data.gymSessions.find((row) => row.id === 's1').note, 'Offline note')
    assert.deepEqual(deletesSent(), [])
  })
})

describe('food entry fingerprints', () => {
  const food = (id, date, calories) => ({
    id, date, time: '12:30', meal: 'lunch', name: `Food ${id}`, brand: null, amount: 1, unit: 'serving', grams: 150,
    calories, proteinG: 10, carbsG: 20, fatG: 5, fiberG: null, sugarG: null, sodiumMg: null, extra: {}, note: null,
    source: 'manual', favoriteId: null, ai: null, createdAt: `${date}T12:30:00.000Z`,
  })

  test('the record of foodEntries is stored as { id, h }; relaunches send nothing and edits send only what changed', async () => {
    server.data.foodEntries = [food('f2', '2026-09-21', 300), food('f1', '2026-09-20', 450)]
    store.hydrateFromCache()
    await store.refresh()
    const record = stored(RECORD + 'foodEntries')
    assert.deepEqual(record.map((entry) => Object.keys(entry).sort()), [['h', 'id'], ['h', 'id']])
    assert.deepEqual(ids(stored(CACHE + 'foodEntries')), ['f1', 'f2'])

    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])

    store.updateData('foodEntries', (list) => [food('f3', '2026-09-22', 120), ...list.map((row) => (row.id === 'f1' ? { ...row, calories: 500 } : row))])
    await store.flushAll()
    assert.equal(patches().length, 1)
    assert.deepEqual(patches()[0].body.upsert.map((row) => row.id).sort(), ['f1', 'f3'])
    assert.deepEqual(patches()[0].body.delete, [])
    assert.equal(server.data.foodEntries.find((row) => row.id === 'f1').calories, 500)

    server.requests = []
    await relaunch()
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [])
    assert.deepEqual(ids(store.getState().data.foodEntries), ['f1', 'f2', 'f3'])
  })

  test('an account without food data loads an empty list', async () => {
    store.hydrateFromCache()
    assert.deepEqual(store.getState().data.foodEntries, [])
    await store.refresh()
    assert.deepEqual(store.getState().data.foodEntries, [])
    assert.deepEqual(stored(RECORD + 'foodEntries'), [])
  })
})

describe('fields the database has no column for yet', () => {
  const HELD = RECORD + 'heldFields'
  const log = (id, date, extra = {}) => ({ id, friendId: 'f1', date, createdAt: `${date}T12:00:00.000Z`, ...extra })
  const shownNote = (id) => store.getState().data.contactLogs.find((row) => row.id === id)?.note
  const serverRow = (id) => server.data.contactLogs.find((row) => row.id === id)

  beforeEach(() => {
    server.missingColumns = { contactLogs: ['note'] }
    server.data.contactLogs = [log('c1', '2026-09-20')]
  })

  test('a catch-up note stays on this device across refreshes and relaunches, and nothing is re-sent meanwhile', async () => {
    store.hydrateFromCache()
    await store.refresh()
    assert.deepEqual(store.getState().droppedFields, {})

    store.updateData('contactLogs', (list) => [log('c2', '2026-09-22', { note: 'trip plans' }), ...list.map((row) => (row.id === 'c1' ? { ...row, note: 'new job' } : row))])
    await store.flushAll()
    assert.equal('note' in serverRow('c1'), false, 'the database has no column for it')
    assert.deepEqual(store.getState().droppedFields, { contactLogs: ['note'] })
    assert.deepEqual(stored(HELD), { contactLogs: { c1: { note: 'new job' }, c2: { note: 'trip plans' } } })

    // Before, the refresh replaced the rows with the server's copy and both notes vanished.
    await store.refresh()
    assert.equal(shownNote('c1'), 'new job')
    assert.equal(shownNote('c2'), 'trip plans')

    server.requests = []
    await relaunch()
    await store.refresh()
    await settle()
    assert.equal(shownNote('c1'), 'new job')
    assert.equal(shownNote('c2'), 'trip plans')
    assert.equal(store.hasUnsavedChanges(), false)
    assert.deepEqual(patches(), [], 'no pointless re-saves while the column is missing')

    // A second note the same day builds on the kept one.
    store.updateData('contactLogs', (list) => list.map((row) => (row.id === 'c1' ? { ...row, note: `${row.note}\nkids` } : row)))
    await store.flushAll()
    await store.refresh()
    assert.equal(shownNote('c1'), 'new job\nkids')

    // Clearing a note or removing the catch-up lets go of it.
    store.updateData('contactLogs', (list) => list.filter((row) => row.id !== 'c2').map((row) => (row.id === 'c1' ? { ...row, note: '' } : row)))
    await store.flushAll()
    assert.equal(storage.getItem(HELD), null)
    await store.refresh()
    assert.equal(shownNote('c1'), undefined)
    assert.deepEqual(ids(store.getState().data.contactLogs), ['c1'])
  })

  test('once the column exists, kept notes are saved and then let go', async () => {
    store.hydrateFromCache()
    await store.refresh()
    store.updateData('contactLogs', (list) => list.map((row) => (row.id === 'c1' ? { ...row, note: 'new job' } : row)))
    await store.flushAll()
    assert.ok(stored(HELD).contactLogs.c1)

    // The migration runs: the column exists, empty on every row.
    server.missingColumns = {}
    server.data.contactLogs = server.data.contactLogs.map((row) => ({ ...row, note: null }))
    server.requests = []
    await relaunch()
    await store.refresh()
    await settle()
    assert.equal(serverRow('c1').note, 'new job')
    assert.equal(shownNote('c1'), 'new job')
    assert.equal(storage.getItem(HELD), null)
    assert.deepEqual(patches().map((request) => request.body.upsert.map((row) => row.id)), [['c1']])
    assert.deepEqual(deletesSent(), [])

    server.requests = []
    await store.refresh()
    await settle()
    assert.deepEqual(patches(), [])
    assert.equal(store.hasUnsavedChanges(), false)
  })

  test('a note saved elsewhere after the column exists wins over the kept one; a row deleted elsewhere is let go', async () => {
    server.data.contactLogs = [log('c1', '2026-09-20'), log('c3', '2026-09-21')]
    store.hydrateFromCache()
    await store.refresh()
    store.updateData('contactLogs', (list) => list.map((row) => ({ ...row, note: `note ${row.id}` })))
    await store.flushAll()
    assert.deepEqual(Object.keys(stored(HELD).contactLogs).sort(), ['c1', 'c3'])

    server.missingColumns = {}
    server.data.contactLogs = [{ ...serverRow('c1'), note: 'written on the iPad' }]
    await store.refresh()
    await settle()
    assert.equal(shownNote('c1'), 'written on the iPad')
    assert.equal(serverRow('c1').note, 'written on the iPad')
    assert.deepEqual(ids(store.getState().data.contactLogs), ['c1'])
    assert.equal(storage.getItem(HELD), null)
  })

  test('other lists and settings are unaffected; the kept values are cleared with the rest of the cache', async () => {
    store.hydrateFromCache()
    await store.refresh()
    store.updateData('tasks', (list) => [...list, { id: 't2', title: 'Task two' }])
    store.updateSettings({ displayName: 'Changed' })
    store.updateData('contactLogs', (list) => list.map((row) => ({ ...row, note: 'kept' })))
    await store.flushAll()
    assert.deepEqual(Object.keys(stored(HELD)), ['contactLogs'])
    assert.deepEqual(ids(server.data.tasks), ['t1', 't2'])
    assert.equal(server.data.settings.displayName, 'Changed')
    assert.ok(HELD.startsWith('daybook.synced.'), 'sign-out and "Clear all data" remove daybook.synced.*')

    store.resetStore()
    assert.deepEqual(store.getState().droppedFields, {})
  })
})

describe('hydrated', () => {
  test('false until a refresh succeeds or cached settings are found; reset on sign-out', async () => {
    store.hydrateFromCache()
    assert.equal(store.getState().hydrated, false)

    // Edits to settings before then aren't cached, so a later launch can't mistake them for loaded data.
    store.updateSettings({ theme: 'blue' })
    assert.equal(storage.getItem(CACHE + 'settings'), null)

    await store.refresh()
    assert.equal(store.getState().hydrated, true)
    assert.equal(stored(CACHE + 'settings').theme, 'blue')

    store.resetStore()
    assert.equal(store.getState().hydrated, false)
    store.hydrateFromCache()
    assert.equal(store.getState().hydrated, true)
  })

  test('a failed first load leaves it false', async () => {
    store.hydrateFromCache()
    server.down = true
    await assert.rejects(store.refresh())
    assert.equal(store.getState().loaded, true)
    assert.equal(store.getState().hydrated, false)
    server.down = false
  })

  test('getSyncedSettings has only what the server confirmed', async () => {
    store.hydrateFromCache()
    await store.refresh()
    store.updateSettings({ displayName: 'Changed' })
    assert.equal(store.getSyncedSettings().displayName, 'Test')
    await store.flushAll()
    assert.equal(store.getSyncedSettings().displayName, 'Changed')
  })
})

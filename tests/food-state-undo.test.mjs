import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The food coach's undos (src/lib/food/state.js) must reach the server even when the part they
// restore (food.prefs, food.coach, food.profile) didn't exist before: JSON drops undefined, and the
// server merges settings.food one level deep, so an undefined restore would keep the new value.
// state.js imports a .jsx file, so it's bundled with esbuild (Vite's own dependency) first.

class MemoryStorage {
  constructor() { this.map = new Map() }
  get length() { return this.map.size }
  key(index) { return [...this.map.keys()][index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}
globalThis.localStorage = new MemoryStorage()

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const server = { data: { settings: { food: { goals: { calories: 2000, source: 'manual' } } } }, patches: [] }
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const parsed = body ? JSON.parse(body) : undefined
  let payload = {}
  if (method === 'GET') payload = structuredClone(server.data)
  else if (method === 'PATCH' && parsed.key === 'settings') {
    server.patches.push(parsed)
    const value = { ...server.data.settings }
    for (const [field, next] of Object.entries(parsed.set || {})) value[field] = plain(next) && plain(value[field]) ? { ...value[field], ...next } : next
    server.data.settings = value
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

const src = (path) => fileURLToPath(new URL(`../src/lib/${path}`, import.meta.url)).replace(/\\/g, '/')
const dir = mkdtempSync(join(tmpdir(), 'daybook-food-state-'))
const outfile = join(dir, 'bundle.mjs')
await build({
  stdin: {
    contents: `export * as store from '${src('store.js')}'\nexport { setNudge, dismissMaintenance, applyMaintenanceGoal, getFood } from '${src('food/state.js')}'`,
    resolveDir: dir,
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  loader: { '.jsx': 'jsx' },
  logLevel: 'error',
  outfile,
})
const food = await import(pathToFileURL(outfile).href)
rmSync(dir, { recursive: true, force: true })
const { store } = food
store.hydrateFromCache()
await store.refresh()
const serverFood = () => server.data.settings.food

test('turning a nudge off then Undo clears it on the server too', async () => {
  const undo = food.setNudge('protein', false)
  await store.flushAll()
  assert.equal(serverFood().prefs.nudges.protein, false)
  undo()
  await store.flushAll()
  assert.deepEqual(server.patches.at(-1).set.food, { prefs: {} })
  assert.deepEqual(serverFood().prefs, {})
  assert.equal(food.getFood().prefs.nudges.protein, true)
})

test('"Not now" then Undo un-snoozes the card on the server', async () => {
  const undo = food.dismissMaintenance(2300, '2026-10-11')
  await store.flushAll()
  assert.equal(serverFood().coach.maintenance.dismissedOn, '2026-10-11')
  undo()
  await store.flushAll()
  assert.deepEqual(serverFood().coach, {})
})

test('Update my goal then Undo puts back the goal, profile and coach on the server', async () => {
  const undo = food.applyMaintenanceGoal(
    { calories: 1900, protein: 120, pace: -0.25 },
    { kcal: 2300, days: 20, confidence: 'good' },
    { today: '2026-10-11', weightKg: 80, weighedOn: '2026-10-10' },
  )
  await store.flushAll()
  assert.equal(serverFood().goals.calories, 1900)
  assert.equal(serverFood().coach.maintenance.appliedOn, '2026-10-11')
  assert.equal(serverFood().profile.measured.kcal, 2300)
  undo()
  await store.flushAll()
  assert.equal(serverFood().goals.calories, 2000)
  assert.deepEqual(serverFood().coach, {})
  assert.deepEqual(serverFood().profile, {})
  for (const patch of server.patches) assert.deepEqual(JSON.parse(JSON.stringify(patch)), patch)
})

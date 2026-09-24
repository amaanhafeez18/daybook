import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'

const { keepFile, removeAttachments, ownsPath, keptPath } = await import('../api/_attachments.js')
const { executeTool, stageTool } = await import('../api/assistant.js')

const USER = '11111111-2222-3333-4444-555555555555'
const ctx = { localDate: '2026-09-24', localTime: '14:30', weekday: 'Thu', timeZone: 'UTC', location: null }

// A tiny Supabase stand-in with the attachments table and a storage bucket.
function fake({ rows = [], objects = [`${USER}/2026-09-24/abc-receipt.jpg`], missingTable = false } = {}) {
  const db = { attachments: [...rows], tasks: [{ id: 't1', user_id: USER, text: 'Dentist', done: false, archived: false }], voice_notes: [{ id: 'n1', user_id: USER, text: 'Wifi code 1234' }], friends: [{ id: 'f1', user_id: USER, name: 'Sarah Connor', relationship: 'friend' }] }
  const store = { objects: new Set(objects), removed: [] }
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.attachments' in the schema cache" }
  const query = (table) => {
    const filters = []
    const q = {
      select() { return q },
      insert(row) { if (table === 'attachments' && missingTable) return Promise.resolve({ error: missing }); db[table].push(...(Array.isArray(row) ? row : [row])); return Promise.resolve({ error: null }) },
      delete() { q.op = 'delete'; return q },
      eq(column, value) { filters.push((row) => String(row[column]) === String(value)); return q },
      in(column, values) { filters.push((row) => values.map(String).includes(String(row[column]))); return q },
      order() { return q },
      limit() { return q },
      then(resolve, reject) {
        if (table === 'attachments' && missingTable) return Promise.resolve({ data: null, error: missing }).then(resolve, reject)
        const rows = db[table].filter((row) => filters.every((f) => f(row)))
        if (q.op === 'delete') { db[table] = db[table].filter((row) => !rows.includes(row)); return Promise.resolve({ data: null, error: null }).then(resolve, reject) }
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      },
    }
    return q
  }
  return {
    db, store,
    from: (table) => query(table),
    storage: {
      from: () => ({
        copy: async (from, to) => { if (!store.objects.has(from)) return { error: { message: 'not found' } }; store.objects.add(to); return { error: null } },
        remove: async (paths) => { paths.forEach((p) => { store.objects.delete(p); store.removed.push(p) }); return { error: null } },
        createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ signedUrl: `https://signed/${p}` })), error: null }),
      }),
    },
  }
}

const data = (supabase) => ({
  tasks: supabase.db.tasks, events: [], friends: supabase.db.friends, voice_notes: supabase.db.voice_notes, classes: [], journal_entries: [], contact_logs: [], memories: [], attachments: [],
  settings: {}, gym: { schedule: { versions: [] }, routines: [], folders: [], exercises: [], exerciseMeta: {}, prefs: {} }, gym_sessions: [], body_weights: [], foodEntries: [], gymTablesMissing: false,
})

describe('_attachments', () => {
  test('paths must be the user’s own; kept files live under keep/', () => {
    assert.equal(ownsPath(`${USER}/2026-09-24/x.jpg`, USER), true)
    assert.equal(ownsPath(`other/2026-09-24/x.jpg`, USER), false)
    assert.equal(ownsPath(`${USER}/../x.jpg`, USER), false)
    assert.equal(keptPath(`${USER}/keep/x.jpg`, USER), true)
    assert.equal(keptPath(`${USER}/2026-09-24/x.jpg`, USER), false)
  })

  test('keepFile copies the upload into keep/ and records it; removeAttachments deletes both', async () => {
    const supabase = fake()
    const row = await keepFile(supabase, USER, { fromPath: `${USER}/2026-09-24/abc-receipt.jpg`, name: 'receipt.jpg', kind: 'image', bytes: 1234, targetType: 'task', targetId: 't1', caption: ' Dentist receipt ' })
    assert.equal(row.targetType, 'task')
    assert.equal(row.targetId, 't1')
    assert.match(row.path, new RegExp(`^${USER}/keep/[0-9a-f-]{36}-receipt.jpg$`))
    assert.equal(row.caption, 'Dentist receipt')
    assert.equal(supabase.db.attachments.length, 1)
    assert.ok(supabase.store.objects.has(row.path))
    // Wrong target / unowned path are refused before anything is written.
    await assert.rejects(keepFile(supabase, USER, { fromPath: `${USER}/2026-09-24/abc-receipt.jpg`, name: 'x', kind: 'image', targetType: 'event', targetId: 'e1' }), /task, note or friend/)
    await assert.rejects(keepFile(supabase, USER, { fromPath: 'someone-else/keep/x.jpg', name: 'x', kind: 'image', targetType: 'task', targetId: 't1' }), /Attach it again/)
    assert.equal(supabase.db.attachments.length, 1)
    // Remove by target: row and file gone.
    assert.equal(await removeAttachments(supabase, USER, { targetType: 'task', targetIds: ['t1'] }), 1)
    assert.equal(supabase.db.attachments.length, 0)
    assert.deepEqual(supabase.store.removed, [row.path])
  })

  test('a missing table is a clear message, and nothing to remove', async () => {
    const supabase = fake({ missingTable: true })
    await assert.rejects(keepFile(supabase, USER, { fromPath: `${USER}/2026-09-24/abc-receipt.jpg`, name: 'r.jpg', kind: 'image', targetType: 'task', targetId: 't1' }), (error) => error.code === 'attachments_missing')
    assert.equal(await removeAttachments(supabase, USER, { targetType: 'task', targetIds: ['t1'] }), 0)
  })
})

describe('attach_file tool', () => {
  const file = { kind: 'image', name: 'receipt.jpg', path: `${USER}/2026-09-24/abc-receipt.jpg`, bytes: 1234 }

  test('saves the only file of the turn to a task, a note or a person', async () => {
    const supabase = fake()
    const d = data(supabase)
    const turn = { ...ctx, turnFiles: [file] }
    const result = await executeTool(supabase, USER, 'attach_file', { target: 'task', id: 't1' }, d, turn)
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /Saved “receipt.jpg” to the task “Dentist”/)
    assert.equal(d.attachments.length, 1)
    assert.equal((await executeTool(supabase, USER, 'attach_file', { target: 'note', id: 'n1' }, d, turn)).ok, true)
    assert.equal((await executeTool(supabase, USER, 'attach_file', { target: 'person', id: 'Sarah' }, d, turn)).ok, true)
    assert.equal(supabase.db.attachments.map((row) => row.target_type).join(','), 'task,note,friend')
  })

  test('asks which file when several were sent, and refuses when none were', async () => {
    const supabase = fake({ objects: [`${USER}/2026-09-24/abc-receipt.jpg`, `${USER}/2026-09-24/abc-menu.pdf`] })
    const d = data(supabase)
    const two = { ...ctx, turnFiles: [file, { ...file, name: 'menu.pdf', kind: 'pdf', path: `${USER}/2026-09-24/abc-menu.pdf` }] }
    const which = await executeTool(supabase, USER, 'attach_file', { target: 'task', id: 't1' }, d, two)
    assert.equal(which.ok, false)
    assert.match(which.message, /Say which file: "receipt.jpg", "menu.pdf"/)
    const named = await executeTool(supabase, USER, 'attach_file', { target: 'task', id: 't1', file: 'menu' }, d, two)
    assert.equal(named.ok, true)
    assert.equal(supabase.db.attachments[0].kind, 'pdf')
    const none = await executeTool(supabase, USER, 'attach_file', { target: 'task', id: 't1' }, d, { ...ctx, turnFiles: [] })
    assert.equal(none.ok, false)
    assert.match(none.message, /no photo or file/)
    assert.equal((await executeTool(supabase, USER, 'attach_file', { target: 'event', id: 't1' }, d, { ...ctx, turnFiles: [file] })).ok, false)
  })

  test('staging pins the resolved file so the Yes tap still knows it; running the staged call works without turnFiles', async () => {
    const supabase = fake()
    const d = data(supabase)
    const stage = { sim: null, simIds: {}, list: [] }
    const staged = await stageTool(supabase, USER, 'attach_file', { target: 'task', id: 't1' }, d, { ...ctx, turnFiles: [file] }, stage)
    assert.equal(staged.ok, true, staged.message)
    assert.equal(staged.staged, true)
    assert.match(staged.label, /Save “receipt.jpg” to the task “Dentist”/)
    assert.equal(supabase.db.attachments.length, 0) // dry run
    const pinned = stage.list[0].args
    assert.equal(pinned.path, file.path)
    // The next request (the Yes tap) has no turnFiles: the pinned path is enough.
    const result = await executeTool(supabase, USER, 'attach_file', pinned, data(supabase), ctx)
    assert.equal(result.ok, true, result.message)
    assert.equal(supabase.db.attachments.length, 1)
  })

  test('the table missing on the database is explained, not thrown', async () => {
    const supabase = fake({ missingTable: true })
    const result = await executeTool(supabase, USER, 'attach_file', { target: 'task', id: 't1' }, data(supabase), { ...ctx, turnFiles: [file] })
    assert.equal(result.ok, false)
    assert.match(result.message, /2026-09-29-attachments.sql/)
  })
})

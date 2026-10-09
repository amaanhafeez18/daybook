// One write call in an assistant turn (runWrite): $n refs, the 'changes' level's check before a create
// or log runs, and the Undo chips (what they check first, what they load, what they take back with
// them, how they survive folding), plus what later turns and the summary see of changes that ran,
// and when the model may promise "Log my sets".
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettings } from '../api/_settings.js'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const {
  runWrite, undoState, historyContent, foldCount, foldHistory, carriedUndo, dependentUndos, loadUndoData, workoutOfferCall, gymOffer, buildInstructions,
  undoCalls, actionChips, runUndo, normalizeMessage, executeTool,
} = await import('../api/assistant.js')

console.warn = () => {}
console.error = () => {}

// ---- a small in-memory stand-in for the Supabase client ----------------------------------------

function fakeSupabase(tables = {}) {
  const db = { tables: structuredClone(tables), reads: [] }
  const rowsOf = (table) => (db.tables[table] ||= [])
  // A LIKE pattern as a regular expression (% any run, _ one character).
  const likeRe = (pattern) => new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`)
  class Query {
    constructor(table) { Object.assign(this, { table, op: 'select', columns: '*', filters: [], payload: null, single: false, returning: false, limitN: null, from: 0 }) }
    select(columns = '*') { if (this.op !== 'select') this.returning = true; else this.columns = columns; return this }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    delete() { this.op = 'delete'; return this }
    eq(column, value) { this.filters.push(['eq', column, value]); return this }
    in(column, values) { this.filters.push(['in', column, values]); return this }
    is(column, value) { this.filters.push(['is', column, value]); return this }
    like(column, pattern) { this.filters.push(['like', column, pattern]); return this }
    not(column, operator, value) { this.filters.push([`not.${operator}`, column, value]); return this }
    order() { return this }
    limit(n) { this.limitN = n; return this }
    range(from, to) { this.from = from; this.limitN = to - from + 1; return this }
    maybeSingle() { this.single = true; return this }
    single() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }
    matches(row) {
      return this.filters.every(([kind, column, value]) => (kind === 'in' ? value.map(String).includes(String(row[column]))
        : kind === 'is' ? row[column] == value // eslint-disable-line eqeqeq
          : kind === 'not.is' ? row[column] != value // eslint-disable-line eqeqeq
            : kind === 'like' ? likeRe(value).test(String(row[column] ?? ''))
              : String(row[column]) === String(value)))
    }
    // Only the columns asked for, like the real client (missing ones as null).
    project(row) {
      if (this.columns === '*') return row
      return Object.fromEntries(this.columns.split(',').map((column) => column.trim()).map((column) => [column, row[column] ?? null]))
    }
    run() {
      const rows = rowsOf(this.table)
      const shape = (list) => (this.single ? structuredClone(list[0] ?? null) : structuredClone(list))
      if (this.op === 'select') {
        db.reads.push(this.table)
        const out = rows.filter((row) => this.matches(row)).slice(this.from).map((row) => this.project(row))
        return { data: shape(this.limitN === null ? out : out.slice(0, this.limitN)), error: null }
      }
      if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload]
        rows.push(...structuredClone(list))
        return { data: this.returning ? shape(list) : null, error: null }
      }
      const hit = rows.filter((row) => this.matches(row))
      if (this.op === 'update') hit.forEach((row) => Object.assign(row, structuredClone(this.payload)))
      if (this.op === 'delete') db.tables[this.table] = rows.filter((row) => !this.matches(row))
      return { data: this.returning ? shape(hit) : null, error: null }
    }
  }
  return {
    db,
    from: (table) => new Query(table),
    async rpc(name, args) {
      const rows = rowsOf('settings').filter((row) => row.user_id === args.p_user)
      if (rows.length) rows[0].value = mergeSettings(rows[0].value, args.p_patch)
      else rowsOf('settings').push({ id: 'settings-1', user_id: args.p_user, value: args.p_patch })
      return { data: null, error: null }
    },
  }
}

const USER = 'user-a'
const TODAY = '2026-10-06'
const ctx = { localDate: TODAY, localTime: '14:30', weekday: 'Tue', timeZone: 'UTC', location: null }

function emptyData(extra = {}) {
  return {
    tasks: [], events: [], friends: [], contact_logs: [], voice_notes: [], classes: [], journal_entries: [], memories: [], attachments: [],
    body_weights: [], gym_sessions: [], settings: { notifications: {} }, ...extra,
  }
}

// What the next request loads (as loadData shapes it), from the fake database.
function freshData(supabase, extra = {}) {
  const rows = (table) => structuredClone(supabase.db.tables[table] || [])
  return emptyData({
    tasks: rows('tasks'),
    events: rows('events'),
    friends: rows('friends'),
    voice_notes: rows('voice_notes'),
    classes: rows('classes'),
    contact_logs: rows('contact_logs').map((log) => ({ id: log.id, friend_id: log.friend_id, date: log.date, note: typeof log.note === 'string' ? log.note : '', created_at: log.created_at })),
    ...extra,
  })
}

function turn(level, data) {
  return { data, ctx, level, stage: { sim: null, simIds: {}, list: [], direct: 0 }, directRefs: {} }
}
const write = (supabase, state, name, args) => runWrite({ supabase, userId: USER, name, args, ...state })

// ---- $n refs -------------------------------------------------------------------------------------

describe('refs within a turn', () => {
  test('"all": remember doesn\'t take $1, so log_contact "$1" is the person staged just before', async () => {
    const supabase = fakeSupabase()
    const state = turn('all', emptyData())
    const memory = await write(supabase, state, 'remember', { content: 'Cousin Hassan just started a new job' })
    assert.equal(memory.staged, false)
    assert.equal(memory.result.ok, true)
    assert.equal(memory.result.ref, undefined, 'no ref for a memory')
    assert.equal(state.stage.direct, 0)
    const friend = await write(supabase, state, 'create_friend', { name: 'Hassan', relationship: 'friend' })
    assert.equal(friend.staged, true)
    assert.equal(friend.result.ref, '$1')
    const log = await write(supabase, state, 'log_contact', { friendId: '$1', note: 'his new job' })
    assert.equal(log.result.ok, true, log.result.message)
    assert.equal(log.result.ref, '$2')
    assert.match(log.result.label, /Hassan/)
    assert.deepEqual(state.stage.list.map((item) => item.tool), ['create_friend', 'log_contact'])
    assert.equal((supabase.db.tables.friends || []).length, 0, 'nothing but the memory is saved before Yes')
  })

  test('"all": forget before a create doesn\'t shift the refs either', async () => {
    const supabase = fakeSupabase({ assistant_memories: [{ id: 'm1', user_id: USER, content: 'Old fact' }] })
    const state = turn('all', emptyData({ memories: [{ id: 'm1', content: 'Old fact' }] }))
    const forgot = await write(supabase, state, 'forget', { memoryId: 'm1' })
    assert.equal(forgot.staged, false)
    assert.equal(forgot.result.ok, true, forgot.result.message)
    assert.equal(forgot.result.ref, undefined)
    const friend = await write(supabase, state, 'create_friend', { name: 'Hassan' })
    assert.equal(friend.result.ref, '$1')
    const log = await write(supabase, state, 'log_contact', { friendId: '$1' })
    assert.equal(log.result.ok, true, log.result.message)
  })

  test('"off": a memory, then a person and a catch-up with "$1", all run at once', async () => {
    const supabase = fakeSupabase()
    const state = turn('off', emptyData())
    await write(supabase, state, 'remember', { content: 'Likes tea' })
    const friend = await write(supabase, state, 'create_friend', { name: 'Hassan' })
    assert.equal(friend.result.ref, '$1')
    const log = await write(supabase, state, 'log_contact', { friendId: '$1', note: 'coffee' })
    assert.equal(log.result.ok, true, log.result.message)
    assert.equal(supabase.db.tables.contact_logs[0].friend_id, friend.result.id)
  })
})

// ---- the 'changes' level checks before it saves -------------------------------------------------

describe('"changes": a create or log with something to check waits for Yes', () => {
  test('a near-duplicate person is staged with the warning, not added', async () => {
    const existing = { id: 'f1', user_id: USER, name: 'Sarah K', relationship: 'friend' }
    const supabase = fakeSupabase({ friends: [existing] })
    const state = turn('changes', emptyData({ friends: [{ ...existing }] }))
    const added = await write(supabase, state, 'create_friend', { name: 'Sara' })
    assert.equal(added.staged, true)
    assert.match(added.result.warning, /Sarah K/)
    assert.equal(added.result.ref, '$1')
    assert.equal(supabase.db.tables.friends.length, 1, 'not saved')
    assert.equal(state.stage.list.length, 1)
    // The rest of the turn waits too (one card).
    const task = await write(supabase, state, 'create_task', { text: 'Call Sara' })
    assert.equal(task.staged, true)
    assert.equal(task.result.ref, '$2')
    assert.equal((supabase.db.tables.tasks || []).length, 0)
  })

  test('a guessed person is staged; a clear one runs at once with an Undo', async () => {
    const people = [{ id: 'f1', user_id: USER, name: 'Hasan Raza', relationship: 'friend' }]
    const supabase = fakeSupabase({ friends: people })
    const state = turn('changes', emptyData({ friends: structuredClone(people) }))
    const guessed = await write(supabase, state, 'log_contact', { friendId: 'Hassan', note: 'lunch' })
    assert.equal(guessed.staged, true)
    assert.equal(guessed.result.assumed, 'Hasan Raza')
    assert.equal((supabase.db.tables.contact_logs || []).length, 0)

    const clean = turn('changes', emptyData({ friends: structuredClone(people) }))
    const done = await write(supabase, clean, 'log_contact', { friendId: 'Hasan Raza', note: 'lunch' })
    assert.equal(done.staged, false)
    assert.equal(done.result.ok, true)
    assert.equal(done.result.ref, '$1')
    assert.equal(supabase.db.tables.contact_logs.length, 1)
    assert.deepEqual(done.undo[0], { tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } })
  })

  test('a new person with no similar name runs at once', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const added = await write(supabase, state, 'create_friend', { name: 'Bob' })
    assert.equal(added.staged, false)
    assert.equal(supabase.db.tables.friends.length, 1)
    assert.deepEqual(added.undo, [{ tool: 'delete_friend', args: { friendId: added.result.id } }])
    assert.equal(state.stage.list.length, 0)
  })
})

// ---- Undo ---------------------------------------------------------------------------------------

function chatWith(chips, undo, createdAt = new Date().toISOString()) {
  return [
    { role: 'user', content: 'x', createdAt },
    normalizeMessage({ role: 'assistant', content: 'Done ✓', createdAt, actions: chips, undo }),
  ]
}

function undoBase(supabase, history) {
  supabase.db.tables.assistant_conversations = [{ id: 'c1', user_id: USER, messages: history, updated_at: 'v1' }]
  return { supabase, userId: USER, history, exists: true, seen: 'v1', ctx, debug: [] }
}

describe('Undo takes back exactly what the chat added', () => {
  test('undoing a catch-up reopens the "Talk to …" reminder it completed, back on the calendar', async () => {
    const reminder = { id: 't1', user_id: USER, text: 'Talk to Mom', date: '2026-10-05', time: '', details: 'friend-reminder:f1:2026-10-05', priority: 'medium', done: false, archived: false, calendar_event_id: 'e1' }
    const supabase = fakeSupabase({
      friends: [{ id: 'f1', user_id: USER, name: 'Mom', relationship: 'close_friend' }],
      tasks: [reminder],
      events: [{ id: 'e1', user_id: USER, task_id: 't1', title: 'Talk to Mom', date: '2026-10-05', time: '' }],
    })
    const state = turn('changes', freshData(supabase))
    const logged = await write(supabase, state, 'log_contact', { friendId: 'f1' })
    assert.equal(logged.staged, false)
    assert.equal(supabase.db.tables.tasks[0].done, true)
    assert.equal(supabase.db.tables.events.length, 0)
    assert.deepEqual(logged.undo, [
      { tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } },
      { tool: 'update_task', args: { taskId: 't1', done: false } },
    ])
    const { actions, undo } = actionChips([{ tool: 'log_contact', ...logged.result, undoCalls: logged.undo }], state.data)
    const outcome = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(outcome.status, 200, outcome.body.error)
    assert.equal(outcome.body.message, 'Undone.')
    assert.equal(supabase.db.tables.contact_logs.length, 0)
    assert.equal(supabase.db.tables.tasks[0].done, false, 'the reminder is open again')
    assert.equal(supabase.db.tables.events.length, 1, 'and on the calendar')
    assert.equal(supabase.db.tables.events[0].task_id, 't1')
  })

  test('stored Undo entries keep a reopen call only in its narrow form, and the state list', () => {
    const [, message] = chatWith([], [
      { id: 'u1', calls: [{ tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } }, { tool: 'update_task', args: { taskId: 't1', done: false } }], state: ['log:l1:abc'] },
      { id: 'u2', calls: [{ tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } }, { tool: 'update_task', args: { taskId: 't1', done: false, text: 'hacked' } }] },
      { id: 'u3', calls: [{ tool: 'update_task', args: { taskId: 't1', done: false } }] },
    ])
    assert.deepEqual(message.undo.map((entry) => entry.id), ['u1', 'u2'], 'an entry that only reopens is dropped')
    assert.equal(message.undo[0].calls.length, 2)
    assert.deepEqual(message.undo[0].state, ['log:l1:abc'])
    assert.deepEqual(message.undo[1].calls.map((call) => call.tool), ['delete_contact_log'], 'any other update is dropped')
  })

  test('Undo refuses when a catch-up was logged with the new person since, and keeps them', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const added = await write(supabase, state, 'create_friend', { name: 'Sara' })
    const { actions, undo } = actionChips([{ tool: 'create_friend', ...added.result, undoCalls: added.undo }], state.data)
    assert.ok(undo[0].state.length >= 1)
    // Later, in People: a catch-up with Sara.
    supabase.db.tables.contact_logs = [{ id: 'l9', user_id: USER, friend_id: added.result.id, date: TODAY, note: 'coffee' }]
    const refused = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /changed since \(a catch-up was added or changed\)/)
    assert.doesNotMatch(refused.body.error, /ask_choice|isn’t in People/)
    assert.equal(supabase.db.tables.friends.length, 1, 'Sara stays')
    assert.equal(supabase.db.tables.contact_logs.length, 1)
  })

  test('Undo refuses when the task was edited or a photo was added since; untouched, it deletes', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const created = await write(supabase, state, 'create_task', { text: 'Renew passport', date: TODAY, time: '18:00' })
    const { actions, undo } = actionChips([{ tool: 'create_task', ...created.result, undoCalls: created.undo }], state.data)
    const history = chatWith(actions, undo)
    const taskId = created.result.id

    const photo = { id: 'a1', targetType: 'task', targetId: taskId, name: 'passport.jpg', kind: 'image' }
    const withPhoto = await runUndo({ ...undoBase(supabase, history), undoId: actions[0].undoId, data: freshData(supabase, { attachments: [photo] }) })
    assert.equal(withPhoto.status, 409)
    assert.match(withPhoto.body.error, /a photo or file was added/)

    supabase.db.tables.tasks[0].details = 'Bring two photos'
    const edited = await runUndo({ ...undoBase(supabase, history), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(edited.status, 409)
    assert.match(edited.body.error, /it was edited/)
    assert.equal(supabase.db.tables.tasks.length, 1)

    supabase.db.tables.tasks[0].details = ''
    const ok = await runUndo({ ...undoBase(supabase, history), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(ok.status, 200, ok.body.error)
    assert.equal(supabase.db.tables.tasks.length, 0)
    assert.equal(supabase.db.tables.events.length, 0)
  })

  test('the state matches what the next request loads (no false "changed")', async () => {
    const supabase = fakeSupabase()
    const state = turn('off', emptyData())
    const friend = await write(supabase, state, 'create_friend', { name: 'Sara', currentStatus: 'new job' })
    const log = await write(supabase, state, 'log_contact', { friendId: '$1', note: 'lunch' })
    const note = await write(supabase, state, 'save_note', { text: 'Gate code 1234' })
    const klass = await write(supabase, state, 'create_class', { name: 'Biology', schedules: [{ day: 'Mon', time: '09:00', room: 'B2' }, { day: 'Wed', time: '09:00' }] })
    const event = await write(supabase, state, 'create_event', { title: 'Dentist', date: TODAY, time: '15:00' })
    for (const done of [friend, log, note, klass, event]) {
      assert.equal(done.result.ok, true, done.result.message)
      const calls = done.undo
      assert.ok(calls.length)
      assert.deepEqual(undoState(calls, freshData(supabase)), undoState(calls, state.data))
    }
  })

  test('column defaults on the next load (a class\'s day_details {}, empty fields as null) aren\'t a change', async () => {
    const supabase = fakeSupabase()
    const state = turn('off', emptyData())
    const klass = await write(supabase, state, 'create_class', { name: 'Biology', schedules: [{ day: 'Mon', time: '09:00' }] })
    const friend = await write(supabase, state, 'create_friend', { name: 'Sara' })
    // What Postgres fills in for columns the insert left out.
    for (const row of supabase.db.tables.classes) row.day_details ??= {}
    for (const row of supabase.db.tables.friends) for (const column of ['organization', 'birthday', 'current_status', 'facts']) row[column] ??= null
    for (const done of [klass, friend]) assert.deepEqual(undoState(done.undo, freshData(supabase)), undoState(done.undo, state.data))
    const { actions, undo } = actionChips([{ tool: 'create_class', ...klass.result, undoCalls: klass.undo }], state.data)
    const outcome = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(outcome.status, 200, outcome.body.error)
    assert.equal(supabase.db.tables.classes.length, 0)
  })

  test('a catch-up already deleted in the app: nothing to undo, and its reminder stays as it is', async () => {
    const supabase = fakeSupabase({
      friends: [{ id: 'f1', user_id: USER, name: 'Mom', relationship: 'close_friend' }],
      tasks: [{ id: 't1', user_id: USER, text: 'Talk to Mom', date: '2026-10-05', time: '', details: 'friend-reminder:f1:2026-10-05', priority: 'medium', done: false, archived: false, calendar_event_id: 'e1' }],
      events: [{ id: 'e1', user_id: USER, task_id: 't1', title: 'Talk to Mom', date: '2026-10-05', time: '' }],
    })
    const state = turn('changes', freshData(supabase))
    const logged = await write(supabase, state, 'log_contact', { friendId: 'f1' })
    const { actions, undo } = actionChips([{ tool: 'log_contact', ...logged.result, undoCalls: logged.undo }], state.data)
    supabase.db.tables.contact_logs = []
    const outcome = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(outcome.status, 409)
    assert.equal(outcome.body.gone, true)
    assert.equal(supabase.db.tables.tasks[0].done, true, 'not reopened')
    assert.equal(supabase.db.tables.events.length, 0)
  })

  test('undoing a person also settles the chip of the catch-up logged with them; failures read plainly', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const friend = await write(supabase, state, 'create_friend', { name: 'Sara' })
    const log = await write(supabase, state, 'log_contact', { friendId: '$1', note: 'lunch' })
    assert.equal(log.staged, false)
    const { actions, undo } = actionChips([
      { tool: 'create_friend', ...friend.result, undoCalls: friend.undo },
      { tool: 'log_contact', ...log.result, undoCalls: log.undo },
    ], state.data)
    const history = chatWith(actions, undo)
    assert.deepEqual(dependentUndos(normalizeHistory(history), actions[0].undoId, [friend.result.id]), [actions[1].undoId])
    const base = undoBase(supabase, history)
    const first = await runUndo({ ...base, undoId: actions[0].undoId, data: freshData(supabase) })
    assert.equal(first.status, 200, first.body.error)
    assert.deepEqual(first.body.alsoUndone, [actions[1].undoId])
    const saved = supabase.db.tables.assistant_conversations[0].messages.map(normalizeMessage)
    assert.deepEqual(saved[1].actions.map((action) => action.undone === true), [true, true])
    const second = await runUndo({ ...base, history: saved, undoId: actions[1].undoId, data: freshData(supabase) })
    assert.equal(second.body.message, 'Already undone.')

    // A chip whose thing was deleted in the app: a plain message, not the model's instructions.
    const gone = chatWith([{ tool: 'log_contact', ok: true, message: 'Logged.', undoId: 'u9' }], [{ id: 'u9', calls: [{ tool: 'delete_contact_log', args: { friendId: 'nobody', date: TODAY } }] }])
    const refused = await runUndo({ ...undoBase(supabase, gone), undoId: 'u9', data: freshData(supabase) })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'That’s already gone, so there was nothing to undo.')
  })
})

function normalizeHistory(history) {
  return history.map(normalizeMessage)
}

// ---- long chats ----------------------------------------------------------------------------------

describe('folding old messages carries the Undo chips that still work', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const iso = (minutes, from = now) => new Date(from + minutes * 60000).toISOString()
  const calls = [{ tool: 'delete_note', args: { noteId: 'n1' } }]
  const chat = (count, undoAt, minutesAgo = 10, at = now) => Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `m${index}`,
    createdAt: iso(-(index === undoAt ? minutesAgo : 1), at),
    ...(index === undoAt ? { undo: [{ id: 'u1', calls }] } : {}),
  }))

  test('a chip that still works doesn\'t hold folding back, so nothing sits outside both the window and the summary', () => {
    assert.equal(foldCount(chat(37, 3)), 0)
    assert.equal(foldCount(chat(38, -1)), 8)
    assert.equal(foldCount(chat(38, 3)), 8)
    const pending = chat(38, -1)
    pending[5].proposal = { status: 'pending' }
    assert.equal(foldCount(pending), 5, 'a waiting card still does')
  })

  test('carriedUndo keeps the live chips with when their reply was sent; used and expired ones go', () => {
    const messages = [
      { role: 'summary', content: 'S', createdAt: iso(-45), undo: [{ id: 'carried-old', calls, at: iso(-70) }, { id: 'carried', calls, at: iso(-40) }] },
      { role: 'assistant', content: '', createdAt: iso(-30), undo: [{ id: 'live', calls }, { id: 'used', calls, done: true }] },
      { role: 'assistant', content: '', createdAt: iso(-90), undo: [{ id: 'expired', calls }] },
      { role: 'user', content: 'x', createdAt: iso(-20) },
      null, // no summary yet
    ]
    assert.deepEqual(carriedUndo(messages, now).map((entry) => [entry.id, entry.at]), [['carried', iso(-40)], ['live', iso(-30)]])
    const many = [{ role: 'assistant', content: '', createdAt: iso(-5), undo: Array.from({ length: 30 }, (_, index) => ({ id: `u${index}`, calls })) }]
    assert.deepEqual(carriedUndo(many, now).map((entry) => entry.id), Array.from({ length: 25 }, (_, index) => `u${index + 5}`), 'the newest 25')
  })

  test('a fold keeps a live chip on the summary, and Undo still finds and runs it', async () => {
    const realNow = Date.now()
    const history = normalizeHistory([
      { role: 'summary', content: 'Earlier.', createdAt: iso(-30, realNow), undo: [{ id: 'u0', calls: [{ tool: 'delete_note', args: { noteId: 'n0' } }], at: iso(-20, realNow) }] },
      ...chat(38, 3, 10, realNow),
    ])
    const realFetch = globalThis.fetch
    let asked = ''
    globalThis.fetch = async (url, init) => {
      asked = JSON.parse(init.body).input[0].content[0].text
      const payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'They saved a gate-code note.' }) }] }] }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    let folded
    try {
      folded = await foldHistory(history, { userId: USER, ctx, debug: [] })
    } finally {
      globalThis.fetch = realFetch
    }
    assert.match(asked, /Earlier\./)
    assert.equal(folded.length, 1 + 30)
    const saved = folded.map(normalizeMessage)
    assert.equal(saved[0].role, 'summary')
    assert.equal(saved[0].content, 'They saved a gate-code note.')
    assert.deepEqual(saved[0].undo.map((entry) => [entry.id, entry.at]), [['u0', iso(-20, realNow)], ['u1', history[4].createdAt]])
    assert.ok(saved.slice(1).every((message) => !message.undo), 'the folded reply is gone from the chat')

    const supabase = fakeSupabase({ voice_notes: [{ id: 'n1', user_id: USER, text: 'Gate code 1234' }] })
    const outcome = await runUndo({ ...undoBase(supabase, saved), undoId: 'u1', data: await loadUndoData(supabase, USER, calls, ctx) })
    assert.equal(outcome.status, 200, outcome.body.error)
    assert.equal(supabase.db.tables.voice_notes.length, 0)
    const stored = supabase.db.tables.assistant_conversations[0].messages.map(normalizeMessage)
    assert.equal(stored[0].undo.find((entry) => entry.id === 'u1').done, true)
    assert.equal(stored[0].actions, undefined, 'the summary gets no chips of its own')
  })

  test('a carried chip expires an hour after its own reply, not the summary', async () => {
    const realNow = Date.now()
    const supabase = fakeSupabase({ voice_notes: [{ id: 'n1', user_id: USER, text: 'Gate code' }] })
    const summary = normalizeMessage({ role: 'summary', content: 'S', createdAt: iso(-5, realNow), undo: [{ id: 'u1', calls, at: iso(-61, realNow) }] })
    const outcome = await runUndo({ ...undoBase(supabase, [summary]), undoId: 'u1', data: await loadUndoData(supabase, USER, calls, ctx) })
    assert.equal(outcome.status, 410)
    assert.equal(supabase.db.tables.voice_notes.length, 1)
  })
})

// ---- what an Undo loads ----------------------------------------------------------------------------

describe('Undo loads only what its chip touches (loadUndoData)', () => {
  test('a note: that note and its files, nothing else; a chip that isn\'t there: nothing at all', async () => {
    const supabase = fakeSupabase({
      voice_notes: [{ id: 'n1', user_id: USER, text: 'Gate code' }, { id: 'n2', user_id: USER, text: 'Other' }],
      tasks: [{ id: 't1', user_id: USER, text: 'Call the bank' }],
      attachments: [{ id: 'a1', user_id: USER, target_type: 'note', target_id: 'n1', path: 'p', name: 'gate.jpg', kind: 'image' }],
    })
    const data = await loadUndoData(supabase, USER, [{ tool: 'delete_note', args: { noteId: 'n1' } }], ctx)
    assert.deepEqual([...supabase.db.reads].sort(), ['attachments', 'voice_notes'])
    assert.deepEqual(data.voice_notes.map((note) => note.id), ['n1'])
    assert.deepEqual(data.attachments.map((file) => [file.id, file.targetType, file.targetId]), [['a1', 'note', 'n1']])
    assert.deepEqual(data.tasks, [])
    supabase.db.reads.length = 0
    await loadUndoData(supabase, USER, [], ctx)
    assert.deepEqual(supabase.db.reads, [])
  })

  test('the state a turn saves is what the Undo load reads (no false "changed")', async () => {
    const supabase = fakeSupabase()
    const state = turn('off', emptyData())
    const friend = await write(supabase, state, 'create_friend', { name: 'Sara', currentStatus: 'new job', photoUrl: 'https://example.com/sara.jpg' })
    const log = await write(supabase, state, 'log_contact', { friendId: '$1', note: 'lunch' })
    const note = await write(supabase, state, 'save_note', { text: 'Gate code 1234' })
    const klass = await write(supabase, state, 'create_class', { name: 'Biology', schedules: [{ day: 'Mon', time: '09:00', room: 'B2' }] })
    const event = await write(supabase, state, 'create_event', { title: 'Dentist', date: TODAY, time: '15:00' })
    const task = await write(supabase, state, 'create_task', { text: 'Renew passport', date: TODAY })
    assert.ok(undoState(friend.undo, state.data).includes(`photo:${friend.result.id}`), 'a photo the chat set is part of it')
    for (const done of [friend, log, note, klass, event, task]) {
      assert.equal(done.result.ok, true, done.result.message)
      assert.deepEqual(undoState(done.undo, await loadUndoData(supabase, USER, done.undo, ctx)), undoState(done.undo, state.data))
    }
  })

  test('undoing a catch-up reopens its reminder, with only that person, their catch-ups and the reminder loaded', async () => {
    const supabase = fakeSupabase({
      friends: [{ id: 'f1', user_id: USER, name: 'Mom', relationship: 'close_friend' }, { id: 'f2', user_id: USER, name: 'Dad', relationship: 'close_friend' }],
      tasks: [{ id: 't1', user_id: USER, text: 'Talk to Mom', date: '2026-10-05', time: '', details: 'friend-reminder:f1:2026-10-05', priority: 'medium', done: false, archived: false, calendar_event_id: 'e1' }],
      events: [{ id: 'e1', user_id: USER, task_id: 't1', title: 'Talk to Mom', date: '2026-10-05', time: '' }],
    })
    const state = turn('changes', freshData(supabase))
    const logged = await write(supabase, state, 'log_contact', { friendId: 'f1' })
    const { actions, undo } = actionChips([{ tool: 'log_contact', ...logged.result, undoCalls: logged.undo }], state.data)
    const data = await loadUndoData(supabase, USER, undo[0].calls, ctx)
    assert.deepEqual(data.friends.map((item) => item.id), ['f1'])
    assert.deepEqual(data.tasks.map((item) => item.id), ['t1'])
    const outcome = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data })
    assert.equal(outcome.status, 200, outcome.body.error)
    assert.equal(supabase.db.tables.contact_logs.length, 0)
    assert.equal(supabase.db.tables.tasks[0].done, false)
    assert.equal(supabase.db.tables.events.length, 1)
  })

  test('undoing a new person archives the "Talk to …" reminder added for them since', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const added = await write(supabase, state, 'create_friend', { name: 'Sara' })
    const { actions, undo } = actionChips([{ tool: 'create_friend', ...added.result, undoCalls: added.undo }], state.data)
    const id = added.result.id
    supabase.db.tables.tasks = [
      { id: 't9', user_id: USER, text: 'Talk to Sara', date: TODAY, time: '', details: `friend-reminder:${id}:${TODAY}`, priority: 'medium', done: false, archived: false },
      { id: 't8', user_id: USER, text: 'Unrelated', date: TODAY, time: '', details: '', priority: 'medium', done: false, archived: false },
    ]
    const data = await loadUndoData(supabase, USER, undo[0].calls, ctx)
    assert.deepEqual(data.tasks.map((task) => task.id), ['t9'])
    const outcome = await runUndo({ ...undoBase(supabase, chatWith(actions, undo)), undoId: actions[0].undoId, data })
    assert.equal(outcome.status, 200, outcome.body.error)
    assert.equal(supabase.db.tables.friends.length, 0)
    assert.deepEqual(supabase.db.tables.tasks.map((task) => [task.id, !!task.archived]), [['t9', true], ['t8', false]])
  })

  test('a workout and a weigh-in are found by id and date', async () => {
    const supabase = fakeSupabase({
      gym_sessions: [{ id: 's1', user_id: USER, date: TODAY, name: 'Legs', exercises: [], created_at: `${TODAY}T08:00:00Z` }],
      body_weights: [{ id: 'w1', user_id: USER, date: TODAY, kg: 80, created_at: `${TODAY}T08:00:00Z` }],
    })
    const history = chatWith([
      { tool: 'gym_quick_log', ok: true, message: 'Logged Legs.', undoId: 'u1' },
      { tool: 'gym_log_bodyweight', ok: true, message: 'Logged 80 kg.', undoId: 'u2' },
    ], [
      { id: 'u1', calls: [{ tool: 'gym_delete_session', args: { session_id: 's1' } }] },
      { id: 'u2', calls: [{ tool: 'weight_delete', args: { date: TODAY } }] },
    ])
    const workout = await runUndo({ ...undoBase(supabase, history), undoId: 'u1', data: await loadUndoData(supabase, USER, history[1].undo[0].calls, ctx) })
    assert.equal(workout.status, 200, workout.body.error)
    assert.equal(supabase.db.tables.gym_sessions.length, 0)
    const saved = supabase.db.tables.assistant_conversations[0].messages
    const weight = await runUndo({ ...undoBase(supabase, saved), undoId: 'u2', data: await loadUndoData(supabase, USER, history[1].undo[1].calls, ctx) })
    assert.equal(weight.status, 200, weight.body.error)
    assert.equal(supabase.db.tables.body_weights.length, 0)
  })

  test('Undo refuses when a photo, a nudge interval or a note was added to the new person since', async () => {
    const supabase = fakeSupabase()
    const state = turn('changes', emptyData())
    const added = await write(supabase, state, 'create_friend', { name: 'Sara' })
    const { actions, undo } = actionChips([{ tool: 'create_friend', ...added.result, undoCalls: added.undo }], state.data)
    const history = chatWith(actions, undo)
    const row = supabase.db.tables.friends[0]
    const tryUndo = async () => runUndo({ ...undoBase(supabase, history), undoId: actions[0].undoId, data: await loadUndoData(supabase, USER, undo[0].calls, ctx) })

    row.photo_url = 'data:image/jpeg;base64,AAAA' // added in People (messages never load it)
    const photo = await tryUndo()
    assert.equal(photo.status, 409)
    assert.match(photo.body.error, /a photo was added/)
    row.photo_url = null

    const days = row.reminder_days
    row.reminder_days = 7
    const nudge = await tryUndo()
    assert.equal(nudge.status, 409)
    assert.match(nudge.body.error, /it was edited/)
    row.reminder_days = days

    row.note = 'Met at the climbing gym'
    assert.match((await tryUndo()).body.error, /it was edited/)
    row.note = null

    const ok = await tryUndo()
    assert.equal(ok.status, 200, ok.body.error)
    assert.equal(supabase.db.tables.friends.length, 0)
  })
})

// ---- "Log my sets" --------------------------------------------------------------------------------

describe('"Log my sets" is only promised when it will show', () => {
  const offered = { offer: { action: 'start', name: 'Legs', routineId: null, template: 'Legs', when: 'done' }, message: 'Shown: a "Log my sets" button under your reply.' }

  test('a card with the quick log and other changes: nothing shown, and the model is told not to mention it', () => {
    const call = workoutOfferCall(offered, { staged: [{ tool: 'gym_quick_log' }, { tool: 'food_log' }], level: 'all' })
    assert.equal(call.offer, null)
    assert.equal(call.result.ok, true)
    assert.match(call.result.message, /^Not shown/)
    assert.match(call.result.message, /Don't mention the button/)
  })

  test('otherwise shown, saying when it wouldn\'t be', () => {
    const alone = workoutOfferCall(offered, { staged: [{ tool: 'gym_quick_log' }], level: 'all' })
    assert.deepEqual(alone.offer, offered.offer)
    assert.match(alone.result.message, /^Shown: a "Log my sets" button.*nothing but the quick log.*don't mention it/)
    assert.doesNotMatch(alone.result.message, /Undo/)
    assert.match(workoutOfferCall(offered, { staged: [], level: 'changes' }).result.message, /runs at once.*Undo/)
    const start = { offer: { ...offered.offer, when: 'now' }, message: 'Shown: a "Start Legs workout" button under your reply.' }
    assert.deepEqual(workoutOfferCall(start, { staged: [{ tool: 'gym_quick_log' }, { tool: 'food_log' }] }).result, { ok: true, message: start.message })
    assert.deepEqual(workoutOfferCall({ message: 'action is "start" or "plan".' }).result, { ok: false, message: 'action is "start" or "plan".' })
    const plan = gymOffer({ action: 'plan' }, emptyData(), ctx)
    assert.deepEqual(workoutOfferCall(plan, { staged: [{ tool: 'gym_quick_log' }, { tool: 'food_log' }] }), { offer: { action: 'plan' }, result: { ok: true, message: plan.message } }, '"Build my gym plan" always shows')
  })

  test('the gym rules say so too (a reply written next to the calls never sees the result)', () => {
    assert.match(buildInstructions({}, { confirmMode: true }), /"Log my sets" button only shows when the quick log is the only change on the card/)
  })
})

// ---- what later turns see -----------------------------------------------------------------------

describe('history text', () => {
  test('changes that ran are listed after a bare "Done ✓"; undone ones only as undone', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Done ✓',
      createdAt: new Date().toISOString(),
      actions: [
        { tool: 'create_task', ok: true, message: 'Created task "Call the bank" for today at 5:00 PM.' },
        { tool: 'food_log', ok: true, message: 'Logged 2 eggs.', undoId: 'u1', undone: true },
        { tool: 'create_task', ok: false, message: 'A task needs some text.' },
      ],
    })
    const text = historyContent(message, ctx)
    assert.match(text, /\[Done: Created task "Call the bank" for today at 5:00 PM\.\]/)
    assert.match(text, /\[Didn’t work: A task needs some text\.\]/)
    assert.match(text, /\[The user tapped Undo, so this was taken back: Logged 2 eggs\.\]/)
    assert.doesNotMatch(text, /\[Done:[^\]]*eggs/)
    assert.equal(historyContent(message, ctx), text, 'the same every time (cacheable)')
  })

  test('a chip the reply already says isn\'t repeated', () => {
    const message = normalizeMessage({ role: 'assistant', content: 'Saved the note.', createdAt: new Date().toISOString(), actions: [{ tool: 'save_note', ok: true, message: 'Saved the note.' }] })
    assert.equal(historyContent(message, ctx), 'Saved the note.')
  })
})

// executeTool is imported so a failure here points at the tool, not the harness.
test('harness: executeTool runs against the fake database', async () => {
  const supabase = fakeSupabase()
  const result = await executeTool(supabase, USER, 'save_note', { text: 'hi' }, emptyData(), ctx)
  assert.equal(result.ok, true)
  assert.deepEqual(undoCalls('save_note', result), [{ tool: 'delete_note', args: { noteId: result.id } }])
})

// The assistant's confirmation levels (settings.assistantConfirm 'all' / 'changes' / 'off'), the Undo
// chips on creates and logs that ran, and the short "Done ✓" reply after Yes.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettings } from '../api/_settings.js'

// api/assistant.js reads these at import time (and would refuse to start without them).
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'
const {
  confirmLevel, stagesWrite, undoCalls, rowIds, addedRows, actionChips, markUndone, runUndo, confirmReply, normalizeMessage, publicMessage,
  cutWords, buildInstructions, executeTool, TOOL_DEFS, RUN_AT_ONCE_TOOLS, UNDO_TOOLS,
} = await import('../api/assistant.js')

console.warn = () => {}
console.error = () => {}

// ---- a small in-memory stand-in for the Supabase client ----------------------------------------

function fakeSupabase(tables = {}) {
  const db = { tables: structuredClone(tables) }
  const rowsOf = (table) => (db.tables[table] ||= [])
  class Query {
    constructor(table) { Object.assign(this, { table, op: 'select', filters: [], payload: null, single: false, returning: false, limitN: null }) }
    select() { if (this.op !== 'select') this.returning = true; return this }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    delete() { this.op = 'delete'; return this }
    eq(column, value) { this.filters.push(['eq', column, value]); return this }
    in(column, values) { this.filters.push(['in', column, values]); return this }
    is(column, value) { this.filters.push(['is', column, value]); return this }
    order() { return this }
    limit(n) { this.limitN = n; return this }
    maybeSingle() { this.single = true; return this }
    single() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }
    matches(row) {
      return this.filters.every(([kind, column, value]) => (kind === 'in' ? value.map(String).includes(String(row[column]))
        : kind === 'is' ? row[column] == value // eslint-disable-line eqeqeq
          : String(row[column]) === String(value)))
    }
    run() {
      const rows = rowsOf(this.table)
      const shape = (list) => (this.single ? structuredClone(list[0] ?? null) : structuredClone(list))
      if (this.op === 'select') {
        const out = rows.filter((row) => this.matches(row))
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

// ---- levels ------------------------------------------------------------------------------------

describe('confirmation levels', () => {
  test('assistantConfirm reads as all, changes or off (all when missing or unknown)', () => {
    assert.equal(confirmLevel({}), 'all')
    assert.equal(confirmLevel(undefined), 'all')
    assert.equal(confirmLevel({ assistantConfirm: 'sometimes' }), 'all')
    assert.equal(confirmLevel({ assistantConfirm: 'changes' }), 'changes')
    assert.equal(confirmLevel({ assistantConfirm: 'off' }), 'off')
  })

  test('"all" stages every write but memory; "off" stages nothing', () => {
    const data = emptyData()
    for (const name of ['create_task', 'update_task', 'delete_note', 'gym_skip', 'food_log']) {
      assert.equal(stagesWrite(name, {}, { level: 'all', data, ctx }), true, name)
      assert.equal(stagesWrite(name, {}, { level: 'off', data, ctx }), false, name)
    }
    assert.equal(stagesWrite('remember', { content: 'x' }, { level: 'all', data, ctx }), false)
  })

  test('"changes" runs creates and logs at once and stages edits, deletes and schedule changes', () => {
    const data = emptyData()
    const level = 'changes'
    for (const name of ['create_task', 'create_event', 'save_note', 'food_log', 'gym_quick_log', 'gym_log_workout']) {
      assert.equal(stagesWrite(name, {}, { level, data, ctx }), false, `${name} runs at once`)
    }
    for (const name of ['update_task', 'update_tasks', 'delete_task_forever', 'delete_event', 'update_settings', 'gym_skip', 'gym_shift', 'gym_set_schedule', 'food_update_entry', 'food_delete_entry', 'write_journal', 'attach_file', 'update_friend']) {
      assert.equal(stagesWrite(name, {}, { level, data, ctx }), true, `${name} waits for Yes`)
    }
  })

  test('"changes" stages creates too in a turn with photos, files or web results, or once something waits', () => {
    const data = emptyData()
    assert.equal(stagesWrite('create_task', { text: 'x' }, { level: 'changes', risky: true, data, ctx }), true)
    assert.equal(stagesWrite('create_task', { text: 'x' }, { level: 'changes', staged: true, data, ctx }), true)
  })

  test('"changes" treats a log that changes something already there as an edit', () => {
    const data = emptyData({
      friends: [{ id: 'f1', name: 'Hasan Raza' }],
      contact_logs: [{ id: 'l1', friend_id: 'f1', date: TODAY, note: 'coffee' }],
      body_weights: [{ id: 'w1', date: '2026-10-05', kg: 80 }],
    })
    const level = 'changes'
    assert.equal(stagesWrite('log_contact', { friendId: 'f1' }, { level, data, ctx }), true, 'already logged today')
    assert.equal(stagesWrite('log_contact', { friendId: 'f1', date: '2026-10-01' }, { level, data, ctx }), false, 'a new day')
    assert.equal(stagesWrite('log_contact', { friendId: 'f1', date: '2026-10-01', mode: 'replace' }, { level, data, ctx }), true, 'replace is an edit')
    assert.equal(stagesWrite('log_contact', { friendId: 'Nobody' }, { level, data, ctx }), false, 'an unknown person: running it explains')
    assert.equal(stagesWrite('gym_log_bodyweight', { date: 'yesterday', weight: 81 }, { level, data, ctx }), true, 'replaces a weigh-in')
    assert.equal(stagesWrite('gym_log_bodyweight', { date: TODAY, weight: 81 }, { level, data, ctx }), false, 'a new weigh-in')
  })

  test('every tool that runs at once exists and has an undo; every undo tool exists', () => {
    const names = new Set(TOOL_DEFS.map((def) => def.name))
    for (const name of RUN_AT_ONCE_TOOLS) assert.ok(names.has(name), name)
    for (const name of UNDO_TOOLS) assert.ok(names.has(name), name)
  })

  test('the instructions have rules for each level, and stay the same between messages', () => {
    const snapshot = { today: TODAY }
    const changes = buildInstructions(snapshot, { confirmMode: 'changes' })
    assert.match(changes, /approves edits and deletes, not new things/)
    assert.match(changes, /Undo button/)
    assert.match(changes, /Staged: waiting for the user to confirm/)
    assert.doesNotMatch(changes, /turned confirmations off/)
    assert.equal(buildInstructions(snapshot, { confirmMode: 'changes' }), changes)
    assert.doesNotMatch(buildInstructions(snapshot, { confirmMode: true }), /approves edits and deletes/)
    assert.match(buildInstructions(snapshot, { confirmMode: 'off' }), /turned confirmations off/)
  })

  test('update_settings takes the new level and says it in plain words', async () => {
    const supabase = fakeSupabase({ settings: [{ id: 's1', user_id: USER, value: {} }] })
    const data = emptyData()
    const result = await executeTool(supabase, USER, 'update_settings', { assistantConfirm: 'changes' }, data, ctx)
    assert.equal(result.ok, true)
    assert.match(result.message, /asks only before edits and deletes/)
    assert.equal(supabase.db.tables.settings[0].value.assistantConfirm, 'changes')
    const bad = await executeTool(supabase, USER, 'update_settings', { assistantConfirm: 'sometimes' }, data, ctx)
    assert.equal(bad.ok, false)
    const schema = TOOL_DEFS.find((def) => def.name === 'update_settings').parameters.properties.assistantConfirm
    assert.deepEqual(schema.enum, ['all', 'changes', 'off'])
  })
})

// ---- undo ----------------------------------------------------------------------------------------

describe('Undo chips', () => {
  test('undoCalls deletes exactly what each create or log added', () => {
    assert.deepEqual(undoCalls('create_task', { ok: true, id: 't9' }), [{ tool: 'delete_task_forever', args: { taskId: 't9' } }])
    assert.deepEqual(undoCalls('create_event', { ok: true, id: 'e9', taskId: 't9' }), [{ tool: 'delete_task_forever', args: { taskId: 't9' } }])
    assert.deepEqual(undoCalls('create_friend', { ok: true, id: 'f9' }), [{ tool: 'delete_friend', args: { friendId: 'f9' } }])
    assert.deepEqual(undoCalls('create_class', { ok: true, id: 'c9' }), [{ tool: 'delete_class', args: { classId: 'c9' } }])
    assert.deepEqual(undoCalls('save_note', { ok: true, id: 'n9' }), [{ tool: 'delete_note', args: { noteId: 'n9' } }])
    assert.deepEqual(undoCalls('food_log', { ok: true, id: 'a', ids: ['a', 'b'] }).map((call) => call.args.id), ['a', 'b'])
    assert.deepEqual(undoCalls('gym_quick_log', { ok: true, id: 's9' }), [{ tool: 'gym_delete_session', args: { session_id: 's9' } }])
    assert.deepEqual(undoCalls('log_contact', { ok: true }, [{ id: 'l9', friend_id: 'f1', date: TODAY }]), [{ tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } }])
    assert.deepEqual(undoCalls('gym_log_bodyweight', { ok: true }, [{ id: 'w9', date: TODAY }]), [{ tool: 'weight_delete', args: { date: TODAY } }])
  })

  test('no undo for failures, no-ops, edits, logs that added nothing, or a missing id', () => {
    assert.deepEqual(undoCalls('create_task', { ok: false, id: 't9' }), [])
    assert.deepEqual(undoCalls('create_task', { ok: true, noop: true, id: 't9' }), [])
    assert.deepEqual(undoCalls('create_task', { ok: true }), [])
    assert.deepEqual(undoCalls('update_task', { ok: true, id: 't9' }), [])
    assert.deepEqual(undoCalls('log_contact', { ok: true }, []), [])
    assert.deepEqual(undoCalls('gym_log_bodyweight', { ok: true }), [])
  })

  test('a new catch-up can be undone; a note added to one already there cannot', async () => {
    const supabase = fakeSupabase({ contact_logs: [{ id: 'l1', user_id: USER, friend_id: 'f1', date: '2026-10-05', note: 'lunch' }] })
    const data = emptyData({ friends: [{ id: 'f1', name: 'Hasan Raza' }], contact_logs: [{ id: 'l1', friend_id: 'f1', date: '2026-10-05', note: 'lunch' }] })
    let before = rowIds('log_contact', data)
    const fresh = await executeTool(supabase, USER, 'log_contact', { friendId: 'f1', note: 'his new job' }, data, ctx)
    const calls = undoCalls('log_contact', fresh, addedRows('log_contact', data, before))
    assert.deepEqual(calls, [{ tool: 'delete_contact_log', args: { friendId: 'f1', date: TODAY } }])
    before = rowIds('log_contact', data)
    const merged = await executeTool(supabase, USER, 'log_contact', { friendId: 'f1', date: '2026-10-05', note: 'and the trip' }, data, ctx)
    assert.equal(merged.ok, true)
    assert.deepEqual(undoCalls('log_contact', merged, addedRows('log_contact', data, before)), [])
    // Undo removes only today's new catch-up.
    const undone = await executeTool(supabase, USER, calls[0].tool, calls[0].args, data, ctx)
    assert.equal(undone.ok, true)
    assert.deepEqual(supabase.db.tables.contact_logs.map((log) => log.date), ['2026-10-05'])
  })

  test('undoing a dated task removes the task and its calendar event', async () => {
    const supabase = fakeSupabase()
    const data = emptyData()
    const created = await executeTool(supabase, USER, 'create_task', { text: 'Call mum', date: TODAY, time: '18:00' }, data, ctx)
    assert.equal(created.ok, true)
    assert.equal(supabase.db.tables.events.length, 1)
    const [call] = undoCalls('create_task', created)
    const result = await executeTool(supabase, USER, call.tool, call.args, data, ctx)
    assert.equal(result.ok, true)
    assert.equal(supabase.db.tables.tasks.length, 0)
    assert.equal(supabase.db.tables.events.length, 0)
  })

  test('actionChips gives an undoId only to results that can be taken back', () => {
    const { actions, undo } = actionChips([
      { tool: 'create_task', ok: true, message: 'Created task "A".', undoCalls: [{ tool: 'delete_task_forever', args: { taskId: 'a' } }] },
      { tool: 'update_task', ok: true, message: 'Updated task "B".' },
      { tool: 'create_task', ok: false, message: 'A task needs some text.' },
      { tool: 'search', ok: true, message: 'found' },
    ])
    assert.equal(actions.length, 3, 'lookups that worked are not chips')
    assert.ok(actions[0].undoId)
    assert.equal(actions[1].undoId, undefined)
    assert.equal(actions[2].undoId, undefined)
    assert.deepEqual(undo, [{ id: actions[0].undoId, calls: [{ tool: 'delete_task_forever', args: { taskId: 'a' } }] }])
  })

  test('stored messages keep Undo ids on chips, keep only delete calls, and hide the calls from the app', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Done ✓',
      createdAt: '2026-10-06T10:00:00Z',
      actions: [{ tool: 'create_task', ok: true, message: 'Created task "A".', undoId: 'u1' }, { tool: 'save_note', ok: true, message: 'Saved.', undoId: 'u2', undone: true }],
      undo: [
        { id: 'u1', calls: [{ tool: 'delete_task_forever', args: { taskId: 'a' } }] },
        { id: 'u2', calls: [{ tool: 'delete_note', args: { noteId: 'n' } }], done: true },
        { id: 'u3', calls: [{ tool: 'update_settings', args: { assistantConfirm: 'off' } }] },
      ],
    })
    assert.deepEqual(message.undo.map((entry) => entry.id), ['u1', 'u2'], 'an entry with no delete calls is dropped')
    assert.equal(message.actions[1].undone, true)
    const shown = publicMessage(message)
    assert.equal(shown.undo, undefined)
    assert.equal(shown.actions[0].undoId, 'u1')
  })

  test('markUndone flags the chip and its calls', () => {
    const history = [{ role: 'assistant', content: '', actions: [{ tool: 'save_note', ok: true, message: 'Saved.', undoId: 'u1' }], undo: [{ id: 'u1', calls: [] }] }]
    const [message] = markUndone(history, 'u1')
    assert.equal(message.actions[0].undone, true)
    assert.equal(message.undo[0].done, true)
    assert.equal(markUndone(history, 'other')[0], history[0], 'other messages are left alone')
  })

  test('runUndo deletes once, saves the chip as used, and refuses unknown or old chips', async () => {
    const createdAt = new Date().toISOString()
    const history = [
      { role: 'user', content: 'note: buy milk', createdAt },
      normalizeMessage({
        role: 'assistant', content: 'Done ✓', createdAt,
        actions: [{ tool: 'save_note', ok: true, message: 'Saved the note.', undoId: 'u1' }],
        undo: [{ id: 'u1', calls: [{ tool: 'delete_note', args: { noteId: 'n1' } }] }],
      }),
    ]
    const supabase = fakeSupabase({
      voice_notes: [{ id: 'n1', user_id: USER, text: 'buy milk' }],
      assistant_conversations: [{ id: 'c1', user_id: USER, messages: history, updated_at: 'v1' }],
    })
    const data = emptyData({ voice_notes: [{ id: 'n1', text: 'buy milk' }] })
    const debug = []
    const base = { supabase, userId: USER, history, exists: true, seen: 'v1', data, ctx, debug }
    const first = await runUndo({ ...base, undoId: 'u1' })
    assert.equal(first.status, 200)
    assert.equal(first.body.message, 'Undone.')
    assert.equal(supabase.db.tables.voice_notes.length, 0)
    const saved = supabase.db.tables.assistant_conversations[0].messages[1]
    assert.equal(saved.actions[0].undone, true)
    assert.equal(saved.undo[0].done, true)
    const again = await runUndo({ ...base, history: supabase.db.tables.assistant_conversations[0].messages.map(normalizeMessage), undoId: 'u1' })
    assert.equal(again.body.message, 'Already undone.')
    assert.equal((await runUndo({ ...base, undoId: 'nope' })).status, 404)
    const old = history.map((message) => ({ ...message, createdAt: '2026-01-01T00:00:00Z' }))
    assert.equal((await runUndo({ ...base, history: old, undoId: 'u1' })).status, 410)
  })
})

// ---- short replies -------------------------------------------------------------------------------

describe('replies after Yes', () => {
  test('all done: "Done ✓", plus the day total after a food log', () => {
    assert.equal(confirmReply([{ tool: 'create_task', ok: true, message: 'Created task "A".' }]), 'Done ✓')
    const food = { tool: 'food_log', ok: true, message: 'Logged Oatmeal, 150 kcal, to Breakfast today. Today: 1,450 / 2,000 kcal (550 left).' }
    assert.equal(confirmReply([food, { tool: 'create_task', ok: true, message: 'x' }]), 'Done ✓\n\nToday: 1,450 / 2,000 kcal (550 left).')
    assert.equal(confirmReply([{ ...food, message: 'Logged Tea, 5 kcal, to Snacks today. Today: 405 kcal.' }]), 'Done ✓\n\nToday: 405 kcal.')
  })

  test('failures are spelled out', () => {
    const reply = confirmReply([{ tool: 'create_task', ok: true, message: 'Created.' }, { tool: 'update_task', ok: false, message: 'No task with that id.' }])
    assert.match(reply, /^Partly done\. This part didn’t work: No task with that id\.$/)
    assert.match(confirmReply([{ tool: 'update_task', ok: false, message: 'Nope' }]), /^That didn’t work, so nothing changed\. Nope\.$/)
  })

  test('labels cut at a word boundary', () => {
    assert.equal(cutWords('Buy milk', 60), 'Buy milk')
    assert.equal(cutWords('Pick up the dry cleaning from the place on Queen Street', 30), 'Pick up the dry cleaning from…')
    assert.ok(cutWords('Supercalifragilisticexpialidocious', 10).endsWith('…'))
    assert.ok(cutWords('Supercalifragilisticexpialidocious', 10).length <= 10)
  })
})

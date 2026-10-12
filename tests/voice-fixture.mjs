// Shared by tests/voice-server.test.mjs and tests/voice-api.test.mjs (not a test file itself): an
// in-memory stand-in for the Supabase client (the same idea as the one in assistant-tools.test.mjs,
// plus JSON-path filters like usage->>rev for the usage ledger's compare-and-swap) and a small
// account to talk about. Generic example data only.
import { mergeSettings } from '../api/_settings.js'

// api/assistant.js reads these at import time.
process.env.SUPABASE_URL ||= 'http://x'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'k'
process.env.JWT_SECRET ||= 's'
process.env.OPENAI_API_KEY ||= 'sk-test'

export const USER = 'user-a'
export const TODAY = '2026-10-11' // a Sunday
export const TOMORROW = '2026-10-12'
export const ctx = { localDate: TODAY, localTime: '21:12', weekday: 'Sun', timeZone: 'UTC', location: null, pushEnabled: null }
export const CONTEXT = { localDate: TODAY, localTime: '21:12', timeZone: 'UTC' }
const AT = '2026-10-01T10:00:00Z'

// Ids shaped like the real ones (UUIDs), so voice refs (t:/f:) apply to them.
export const ID = {
  dentist: '3f9a2c1b-0d4e-4c55-9a11-000000000001',
  milk: '7c1e0d22-5b6a-4f77-8b22-000000000002',
  rent: '9a8b7c6d-1e2f-4a3b-8c4d-000000000003',
  sara: 'aa11bb22-3c4d-4e5f-9a6b-000000000004',
  omar: 'cc33dd44-5e6f-4a7b-8c9d-000000000005',
  event: 'ee55ff66-7a8b-4c9d-8e0f-000000000006',
}

const valueAt = (row, column) => {
  if (!String(column).includes('->')) return row[column]
  const [base, ...path] = String(column).split(/->>?/)
  let value = row[base]
  for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined
  return value === undefined || value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

// missingColumns: { table: ['column'] } — a database without them (Postgres 42703 on a read,
// PostgREST PGRST204 on a write), like one where the 2026-09-23 usage column was never added.
export function fakeSupabase({ tables = {}, rpc = 'ok', missingColumns = {} } = {}) {
  const db = { tables: structuredClone(tables), calls: [] }
  const rowsOf = (table) => {
    if (!db.tables[table]) db.tables[table] = []
    return db.tables[table]
  }

  class Query {
    constructor(table) {
      Object.assign(this, { table, op: 'select', filters: [], orders: [], limitN: null, rangeArg: null, payload: null, single: false, returning: false })
    }
    select(columns = '*') { if (this.op !== 'select') this.returning = true; else this.columns = String(columns); return this }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this }
    upsert(rows) { this.op = 'upsert'; this.payload = rows; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    delete() { this.op = 'delete'; return this }
    eq(column, value) { this.filters.push(['eq', column, value]); return this }
    neq(column, value) { this.filters.push(['neq', column, value]); return this }
    gte(column, value) { this.filters.push(['gte', column, value]); return this }
    lte(column, value) { this.filters.push(['lte', column, value]); return this }
    is(column, value) { this.filters.push(['is', column, value]); return this }
    not(column, op, value) { this.filters.push(['not', column, [op, value]]); return this }
    in(column, values) { this.filters.push(['in', column, values]); return this }
    like(column, pattern) { this.filters.push(['like', column, pattern]); return this }
    order(column, options) { this.orders.push([column, options?.ascending !== false]); return this }
    limit(n) { this.limitN = n; return this }
    range(from, to) { this.rangeArg = [from, to]; return this }
    maybeSingle() { this.single = true; return this }
    single() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }
    catch(reject) { return this.then(undefined, reject) }

    matches(row) {
      return this.filters.every(([kind, column, value]) => {
        const actual = valueAt(row, column)
        if (kind === 'eq') return actual !== null && actual !== undefined && String(actual) === String(value)
        if (kind === 'neq') return String(actual) !== String(value)
        if (kind === 'gte') return actual >= value
        if (kind === 'lte') return actual <= value
        if (kind === 'is') return value === null ? actual === null || actual === undefined : actual === value
        if (kind === 'not') return value[0] === 'is' && value[1] === null ? actual !== null && actual !== undefined : true
        if (kind === 'in') return value.map(String).includes(String(actual))
        if (kind === 'like') return new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(String(actual ?? ''))
        return true
      })
    }

    shape(list) {
      const out = structuredClone(list)
      return this.single ? out[0] ?? null : out
    }

    missing(columns) {
      return (missingColumns[this.table] || []).find((column) => columns.includes(column))
    }

    run() {
      db.calls.push({ table: this.table, op: this.op, filters: this.filters, payload: structuredClone(this.payload) })
      const rows = rowsOf(this.table)
      const named = this.op === 'select' ? (this.columns || '*').split(',').map((column) => column.trim()) : (Array.isArray(this.payload) ? this.payload : [this.payload]).flatMap((item) => Object.keys(item || {}))
      const absent = this.missing([...named, ...this.filters.map(([, column]) => String(column).split('->')[0])])
      if (absent) return { data: null, error: this.op === 'select' ? { code: '42703', message: `column ${this.table}.${absent} does not exist` } : { code: 'PGRST204', message: `Could not find the '${absent}' column of '${this.table}' in the schema cache` } }
      if (this.op === 'select') {
        let out = rows.filter((row) => this.matches(row))
        for (const [column, ascending] of [...this.orders].reverse()) {
          out = [...out].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
        }
        if (this.rangeArg) out = out.slice(this.rangeArg[0], this.rangeArg[1] + 1)
        if (this.limitN !== null) out = out.slice(0, this.limitN)
        return { data: this.shape(out), error: null }
      }
      if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload]
        for (const item of list) {
          const unique = this.table === 'assistant_conversations' ? (row) => row.user_id === item.user_id : (row) => row.id !== undefined && row.id === item.id
          const index = rows.findIndex(unique)
          if (index >= 0 && this.op === 'upsert') rows[index] = structuredClone(item)
          else if (index >= 0) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          else rows.push(structuredClone(item))
        }
        return { data: this.returning ? this.shape(list) : null, error: null }
      }
      if (this.op === 'update') {
        const hit = rows.filter((row) => this.matches(row))
        for (const row of hit) Object.assign(row, structuredClone(this.payload))
        return { data: this.returning ? this.shape(hit) : null, error: null }
      }
      if (this.op === 'delete') {
        const hit = rows.filter((row) => this.matches(row))
        db.tables[this.table] = rows.filter((row) => !this.matches(row))
        return { data: this.returning ? this.shape(hit) : null, error: null }
      }
      return { data: null, error: { message: 'unsupported' } }
    }
  }

  return {
    db,
    from: (table) => new Query(table),
    async rpc(name, args) {
      db.calls.push({ rpc: name, args: structuredClone(args) })
      if (name === 'daybook_throttle') return { data: true, error: null }
      if (name !== 'patch_settings' || rpc !== 'ok') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      const list = rowsOf('settings').filter((row) => row.user_id === args.p_user)
      if (list.length) list[0].value = mergeSettings(list[0].value, args.p_patch)
      else rowsOf('settings').push({ id: 'new-settings', user_id: args.p_user, value: args.p_patch, created_at: AT })
      return { data: null, error: null }
    },
  }
}

export function buildSettings(extra = {}) {
  return { theme: 'sunset', appearance: 'system', displayName: 'Sam Lee', assistantConfirm: 'all', timeZone: 'UTC', ...extra }
}

// One account: tasks, an event, two people, a journal entry, a memory. `conversation`: the stored
// chat row (undefined = none yet; `usage: false` = a database without the usage column).
export function buildTables({ settings = {}, messages = [], usage = {}, noConversation = false } = {}) {
  const task = (id, text, fields) => ({ id, user_id: USER, text, date: '', time: '', details: '', priority: 'medium', done: false, archived: false, calendar_event_id: null, created_at: AT, ...fields })
  const friend = (id, name, fields) => ({ id, user_id: USER, name, relationship: 'friend', reminder_days: 30, organization: '', note: '', birthday: '', current_status: '', facts: '', created_at: AT, ...fields })
  const conversation = { id: 'conv-1', user_id: USER, messages, updated_at: '2026-10-11T20:00:00.000Z' }
  if (usage !== false) conversation.usage = usage
  return {
    tasks: [
      task(ID.dentist, 'Dentist appointment', { date: TOMORROW, time: '15:00', calendar_event_id: ID.event }),
      task(ID.milk, 'Buy milk', {}),
      task(ID.rent, 'Pay rent', { date: '2026-10-09' }),
    ],
    events: [{ id: ID.event, user_id: USER, title: 'Dentist appointment', date: TOMORROW, time: '15:00', task_id: ID.dentist, created_at: AT }],
    friends: [friend(ID.sara, 'Sara Khan', { birthday: '2000-10-15' }), friend(ID.omar, 'Omar Ali', { organization: 'City Hospital' })],
    contact_logs: [{ id: 'c1', user_id: USER, friend_id: ID.sara, date: '2026-10-01', note: 'her new job', created_at: AT }],
    voice_notes: [],
    classes: [],
    journal_entries: [{ id: 'j1', user_id: USER, date: '2026-10-10', title: 'Long day', body: 'Worked late.', mood: 'okay', created_at: AT }],
    settings: [{ id: 's1', user_id: USER, value: buildSettings(settings), created_at: AT }],
    gym_sessions: [],
    body_weights: [],
    assistant_memories: [{ id: 'm1', user_id: USER, content: 'User likes short answers', created_at: AT }],
    attachments: [],
    food_entries: [],
    assistant_conversations: noConversation ? [] : [conversation],
  }
}

// The options for fakeSupabase that go with buildTables(options).
export const databaseFor = (options = {}) => ({ tables: buildTables(options), ...(options.usage === false ? { missingColumns: { assistant_conversations: ['usage'] } } : {}) })

export const conversationOf = (supabase) => supabase.db.tables.assistant_conversations.find((row) => row.user_id === USER)
export const talkOf = (supabase, talkId) => (conversationOf(supabase)?.messages || []).find((message) => message.talk?.id === talkId)

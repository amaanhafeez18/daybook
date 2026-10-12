// The usage store (api/_usage.js): compare-and-swap writes of assistant_conversations.usage, the
// message count, metering from debug logs, voice billing, the ai_usage tool; plus the metering hooks
// in api/_openai.js and api/_briefing.js. No network: fetch is stubbed where a module would call out.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bumpMessageCount, mutateUsage, raceTimeout, readLedger, recordTalk, recordTalkSegment, recordUsage, usageFromDebug, usageToolResult,
} from '../api/_usage.js'
import { addToLedger } from '../src/lib/aiLedger.js'

const USER = 'user-a'
const TODAY = '2026-10-11'

// A stand-in for the Supabase client that understands the filters mutateUsage uses, including the
// JSON path `usage->>rev` (eq, and is null for rows without a rev). Options:
//   missingColumn: the table has no usage column (reads 42703, writes PGRST204)
//   onUpdate(db): runs before each update is applied (another writer sneaking in)
function fakeDb({ rows = [], missingColumn = false, onUpdate } = {}) {
  const db = { rows: structuredClone(rows), writes: 0 }
  const field = (row, column) => {
    if (column === 'usage->>rev') return row.usage?.rev === undefined || row.usage?.rev === null ? null : String(row.usage.rev)
    return row[column]
  }
  class Query {
    constructor() {
      this.op = 'select'
      this.columns = '*'
      this.filters = []
      this.payload = null
      this.single = false
    }
    select(columns) {
      if (this.op === 'select') this.columns = columns
      return this
    }
    insert(row) { this.op = 'insert'; this.payload = row; return this }
    update(patch) { this.op = 'update'; this.payload = patch; return this }
    eq(column, value) { this.filters.push((row) => field(row, column) !== null && String(field(row, column)) === String(value)); return this }
    is(column, value) { this.filters.push((row) => (value === null ? field(row, column) === null || field(row, column) === undefined : field(row, column) === value)); return this }
    maybeSingle() { this.single = true; return this }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject) }
    run() {
      const match = (row) => this.filters.every((filter) => filter(row))
      if (this.op === 'select') {
        if (missingColumn && /usage/.test(this.columns)) return { data: null, error: { code: '42703', message: 'column assistant_conversations.usage does not exist' } }
        const found = db.rows.filter(match).map((row) => structuredClone(row))
        return { data: this.single ? found[0] ?? null : found, error: null }
      }
      if (missingColumn && 'usage' in this.payload) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'usage' column of 'assistant_conversations' in the schema cache" } }
      if (this.op === 'insert') {
        if (db.rows.some((row) => row.user_id === this.payload.user_id)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        db.rows.push(structuredClone(this.payload))
        db.writes += 1
        return { data: null, error: null }
      }
      onUpdate?.(db)
      const hit = db.rows.filter(match)
      for (const row of hit) Object.assign(row, structuredClone(this.payload))
      if (hit.length) db.writes += 1
      return { data: hit.map((row) => ({ user_id: row.user_id })), error: null }
    }
  }
  return { db, from: () => new Query() }
}

const conversation = (usage) => ({ id: 'conv-1', user_id: USER, messages: [{ role: 'user', content: 'zz-hello' }], updated_at: '2026-10-11T10:00:00Z', usage })

// Silence the expected "Usage write failed" lines.
let originalError
beforeEach(() => {
  originalError = console.error
  console.error = () => {}
})
afterEach(() => {
  console.error = originalError
})

describe('mutateUsage', () => {
  test('creates a missing row (messages empty, rev 1)', async () => {
    const supabase = fakeDb()
    const result = await recordUsage(supabase, USER, [{ feature: 'chat', micros: 1200, n: 1 }], { day: TODAY })
    assert.deepEqual(result, { ok: true, available: true })
    const [row] = supabase.db.rows
    assert.equal(row.user_id, USER)
    assert.deepEqual(row.messages, [])
    assert.equal(row.usage.rev, 1)
    assert.deepEqual(row.usage.ai.days[TODAY].chat, { u: 1200, n: 1 })
  })

  test('a conflicting writer: retried, and both changes are kept', async () => {
    let sneaked = false
    const supabase = fakeDb({
      rows: [conversation({ date: TODAY, count: 3, rev: 7 })],
      onUpdate: (db) => {
        if (sneaked) return
        sneaked = true
        // Another request counts a message between our read and our write.
        const row = db.rows[0]
        row.usage = { ...row.usage, count: row.usage.count + 1, rev: row.usage.rev + 1 }
      },
    })
    const result = await recordUsage(supabase, USER, [{ feature: 'food', micros: 900 }], { day: TODAY })
    assert.equal(result.ok, true)
    const { usage } = supabase.db.rows[0]
    assert.equal(usage.count, 4) // the other writer's change
    assert.deepEqual(usage.ai.days[TODAY].food, { u: 900, n: 1 }) // ours
    assert.equal(usage.rev, 9)
  })

  test('never touches the messages or updated_at', async () => {
    const supabase = fakeDb({ rows: [conversation({ date: TODAY, count: 1, rev: 2 })] })
    await recordUsage(supabase, USER, [{ feature: 'chat', micros: 5 }], { day: TODAY })
    const [row] = supabase.db.rows
    assert.equal(row.updated_at, '2026-10-11T10:00:00Z')
    assert.deepEqual(row.messages, [{ role: 'user', content: 'zz-hello' }])
  })

  test('gives up after 4 tries without throwing', async () => {
    const supabase = fakeDb({
      rows: [conversation({ rev: 1 })],
      onUpdate: (db) => { db.rows[0].usage = { ...db.rows[0].usage, rev: db.rows[0].usage.rev + 1 } },
    })
    const result = await mutateUsage(supabase, USER, () => ({ count: 1 }))
    assert.equal(result.ok, false)
    assert.equal(result.conflict, true)
  })

  test('a fn that returns null writes nothing', async () => {
    const supabase = fakeDb({ rows: [conversation({ rev: 4 })] })
    const result = await mutateUsage(supabase, USER, () => null)
    assert.equal(result.ok, true)
    assert.equal(supabase.db.writes, 0)
  })

  test('no usage column: available false and no write', async () => {
    const supabase = fakeDb({ rows: [{ id: 'conv-1', user_id: USER, messages: [] }], missingColumn: true })
    assert.deepEqual(await mutateUsage(supabase, USER, () => ({ count: 1 })), { ok: false, available: false, usage: null })
    assert.deepEqual(await recordUsage(supabase, USER, [{ feature: 'chat', micros: 5 }], { day: TODAY }), { ok: false, available: false })
    assert.equal((await readLedger(supabase, USER)).available, false)
    assert.equal(supabase.db.writes, 0)
  })

  test('a broken client never throws', async () => {
    const result = await mutateUsage({}, USER, () => ({ count: 1 }))
    assert.equal(result.ok, false)
    assert.deepEqual(await recordUsage({}, USER, [{ feature: 'chat', micros: 5 }], { day: TODAY }), { ok: false, available: true })
  })
})

describe('bumpMessageCount', () => {
  test('keeps the ledger and bumps rev', async () => {
    const ai = addToLedger(null, { day: TODAY, feature: 'voice', micros: 400000, s: 600 })
    const supabase = fakeDb({ rows: [conversation({ date: TODAY, count: 5, rev: 12, ai })] })
    assert.deepEqual(await bumpMessageCount(supabase, USER, TODAY), { ok: true })
    const { usage } = supabase.db.rows[0]
    assert.equal(usage.count, 6)
    assert.equal(usage.rev, 13)
    assert.deepEqual(usage.ai, ai)
  })

  test('a legacy { date, count } row gets rev 1; a new day starts at 1', async () => {
    const supabase = fakeDb({ rows: [conversation({ date: '2026-10-10', count: 40 })] })
    await bumpMessageCount(supabase, USER, TODAY)
    assert.deepEqual(supabase.db.rows[0].usage, { date: TODAY, count: 1, rev: 1 })
    await bumpMessageCount(supabase, USER, TODAY)
    assert.deepEqual(supabase.db.rows[0].usage, { date: TODAY, count: 2, rev: 2 })
  })

  test('an empty usage object ({} default) works too', async () => {
    const supabase = fakeDb({ rows: [conversation({})] })
    await bumpMessageCount(supabase, USER, TODAY)
    assert.deepEqual(supabase.db.rows[0].usage, { date: TODAY, count: 1, rev: 1 })
  })

  test('without the column: ok false with an error, nothing written', async () => {
    const supabase = fakeDb({ rows: [{ id: 'conv-1', user_id: USER, messages: [] }], missingColumn: true })
    const result = await bumpMessageCount(supabase, USER, TODAY)
    assert.equal(result.ok, false)
    assert.ok(result.error instanceof Error)
  })
})

describe('usageFromDebug', () => {
  const response = (usage, extra = {}) => ({ step: 'openai.response', status: 'completed', model: 'gpt-5-mini', outputTypes: ['message'], webCalls: 0, usage, ...extra })

  test('sums the model calls into one entry', () => {
    const debug = [
      { step: 'openai.request' },
      response({ input: 1000, cached: 400, output: 200 }),
      response({ input: 2000, cached: 0, output: 100 }, { webCalls: 1, outputTypes: ['web_search_call', 'message'] }),
    ]
    const entries = usageFromDebug(debug, { feature: 'chat' })
    assert.deepEqual(entries, [{ feature: 'chat', micros: 560 + 700 + 10000, n: 1 }])
    assert.ok(debug.filter((item) => item.step === 'openai.response').every((item) => item.metered))
  })

  test('web calls are counted from outputTypes when webCalls is missing', () => {
    const debug = [response({ input: 0, output: 0 }, { webCalls: undefined, outputTypes: ['web_search_call', 'web_search_call', 'message'] })]
    assert.deepEqual(usageFromDebug(debug, { feature: 'food' }), [{ feature: 'food', micros: 20000, n: 1 }])
  })

  test('transcriptions are voice notes', () => {
    const debug = [{ step: 'openai.transcribe', model: 'gpt-4o-mini-transcribe', seconds: 30 }, response({ input: 1000, output: 0 })]
    assert.deepEqual(usageFromDebug(debug, { feature: 'food' }), [
      { feature: 'food', micros: 250, n: 1 },
      { feature: 'note', micros: 1500, n: 1, s: 30 },
    ])
  })

  test('metered entries are skipped; a late fold adds cost but not another use', () => {
    const debug = [response({ input: 1000, output: 0 })]
    assert.equal(usageFromDebug(debug)[0].micros, 250)
    assert.deepEqual(usageFromDebug(debug), [])
    debug.push(response({ input: 4000, output: 100 }))
    assert.deepEqual(usageFromDebug(debug), [{ feature: 'chat', micros: 1200, n: 0 }])
  })

  test('voice hand-offs, unknown models, failed calls', () => {
    assert.equal(usageFromDebug([response({ input: 1000 })], { feature: 'voiceAsk' })[0].feature, 'voiceAsk')
    assert.deepEqual(usageFromDebug([response({ input: 1000 }, { model: 'gpt-9-mini' })]), [{ feature: 'chat', micros: 250, n: 1, unpricedModel: 'gpt-9-mini' }])
    // A model call with no usage (an HTTP error) costs nothing.
    assert.deepEqual(usageFromDebug([response(null, { httpStatus: 429 })]), [])
    // Older entries without a model are priced as gpt-5-mini.
    assert.equal(usageFromDebug([response({ input: 1000 }, { model: undefined })])[0].micros, 250)
    assert.deepEqual(usageFromDebug(null), [])
  })

  test('recordUsage books a voice hand-off inside voice', async () => {
    const supabase = fakeDb()
    await recordUsage(supabase, USER, usageFromDebug([response({ input: 20000, output: 0 })], { feature: 'voiceAsk' }), { day: TODAY })
    assert.deepEqual(supabase.db.rows[0].usage.ai.days[TODAY].voice, { u: 5000, n: 0, a: 5000 })
  })

  test('nothing to book: no write', async () => {
    const supabase = fakeDb()
    assert.deepEqual(await recordUsage(supabase, USER, [], { day: TODAY }), { ok: true, skipped: true })
    assert.equal(supabase.db.writes, 0)
  })
})

describe('voice calls', () => {
  const segment = { talkId: 'talk_abc12345', sessionId: 'sess-1', day: TODAY, model: 'gpt-realtime-2.1-mini', mintedAt: Date.now(), maxSec: 900 }

  test('mint, then checkpoints bill once each', async () => {
    const supabase = fakeDb({ rows: [conversation({ date: TODAY, count: 2, rev: 1 })] })
    assert.deepEqual(await recordTalkSegment(supabase, USER, segment), { ok: true, available: true })
    assert.deepEqual(supabase.db.rows[0].usage.ai.days, {}) // minting costs nothing
    const first = await recordTalk(supabase, USER, { talkId: segment.talkId, sessionId: 'sess-1', seq: 1, micros: 90000, seconds: 120 })
    assert.equal(first.ok, true)
    assert.equal(first.deltaMicros, 90000)
    const again = await recordTalk(supabase, USER, { talkId: segment.talkId, sessionId: 'sess-1', seq: 1, micros: 90000, seconds: 120 })
    assert.equal(again.ok, false)
    assert.equal(again.skipped, 'seq')
    assert.ok(again.ai) // the ledger as stored, for the month total
    const more = await recordTalk(supabase, USER, { talkId: segment.talkId, sessionId: 'sess-1', seq: 2, micros: 150000, seconds: 200 })
    assert.equal(more.deltaMicros, 60000)
    const { usage } = supabase.db.rows[0]
    assert.deepEqual(usage.ai.days[TODAY].voice, { u: 150000, n: 1, s: 200 })
    assert.equal(usage.count, 2)
  })

  test('an unknown segment: skipped, nothing written', async () => {
    const supabase = fakeDb({ rows: [conversation({ rev: 1 })] })
    const result = await recordTalk(supabase, USER, { talkId: 'talk_nothere1', sessionId: 'x', seq: 1, micros: 5, seconds: 5 })
    assert.equal(result.skipped, 'unknown')
    assert.equal(supabase.db.writes, 0)
  })
})

describe('usageToolResult (the ai_usage tool)', () => {
  function ledger() {
    let ai = addToLedger(null, { day: '2026-09-20', feature: 'chat', micros: 2000000, n: 40 })
    ai = addToLedger(ai, { day: '2026-10-02', feature: 'voice', micros: 1500000, n: 2, s: 1800, a: 50000 })
    ai = addToLedger(ai, { day: TODAY, feature: 'chat', micros: 310000, n: 12 })
    return ai
  }
  const ctx = { localDate: TODAY, timeZone: 'UTC' }

  test('this month: total, features, projection, budget', async () => {
    const supabase = fakeDb({ rows: [conversation({ rev: 3, ai: ledger() })] })
    const result = await usageToolResult(supabase, USER, { period: 'month', settings: { aiBudgetUsd: 20 }, ctx })
    assert.equal(result.ok, true)
    assert.equal(result.period, 'month')
    assert.equal(result.total, '$1.81')
    assert.deepEqual(result.byFeature, [
      { feature: 'Voice chats', usd: '$1.50', uses: 2, minutes: 30, handedToAssistant: '$0.05' },
      { feature: 'Assistant (typing)', usd: '$0.31', uses: 12 },
    ])
    assert.match(result.projected, /^\$\d+\.\d\d$/)
    assert.equal(result.budget, '$20.00 a month, 9% used this month')
    assert.equal(result.since, '2026-09-20')
    assert.match(result.note, /OpenAI bill is final/)
  })

  test('today, last month and the last 30 days', async () => {
    const supabase = fakeDb({ rows: [conversation({ rev: 3, ai: ledger() })] })
    assert.equal((await usageToolResult(supabase, USER, { period: 'today', settings: {}, ctx })).total, '$0.31')
    const last = await usageToolResult(supabase, USER, { period: 'last_month', settings: {}, ctx })
    assert.equal(last.total, '$2.00')
    assert.equal(last.projected, undefined)
    const recent = await usageToolResult(supabase, USER, { period: 'last_30_days', settings: { aiBudgetUsd: 0 }, ctx })
    assert.equal(recent.total, '$3.81')
    assert.equal(recent.budget, 'No monthly budget set')
    // An unknown period means this month.
    assert.equal((await usageToolResult(supabase, USER, { period: 'forever', settings: {}, ctx })).period, 'month')
  })

  test('says when tracking started inside the period', async () => {
    const supabase = fakeDb({ rows: [conversation({ rev: 1, ai: addToLedger(null, { day: '2026-10-05', feature: 'chat', micros: 5 }) })] })
    const result = await usageToolResult(supabase, USER, { period: 'month', settings: {}, ctx })
    assert.match(result.note, /Tracking started 2026-10-05/)
  })

  test('no usage column: ok false', async () => {
    const supabase = fakeDb({ rows: [{ id: 'conv-1', user_id: USER, messages: [] }], missingColumn: true })
    const result = await usageToolResult(supabase, USER, { period: 'month', settings: {}, ctx })
    assert.equal(result.ok, false)
    assert.match(result.message, /2026-09-23/)
  })

  test('nothing recorded yet: $0.00', async () => {
    const supabase = fakeDb({ rows: [conversation({ date: TODAY, count: 1 })] })
    const result = await usageToolResult(supabase, USER, { period: 'month', settings: {}, ctx })
    assert.equal(result.total, '$0.00')
    assert.deepEqual(result.byFeature, [])
  })
})

describe('raceTimeout', () => {
  test('the result, a timeout or a rejection — never a throw', async () => {
    assert.deepEqual(await raceTimeout(Promise.resolve({ ok: true })), { ok: true })
    assert.deepEqual(await raceTimeout(new Promise(() => {}), 10), { ok: false, timeout: true })
    const failed = await raceTimeout(Promise.reject(new Error('zz-boom')), 50)
    assert.equal(failed.ok, false)
  })
})

describe('metering hooks', () => {
  const realFetch = globalThis.fetch
  const realKey = process.env.OPENAI_API_KEY
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-test-not-real' })
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = realKey
  })
  const reply = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

  test('transcribeAudio logs the seconds it used', async () => {
    const { transcribeAudio } = await import('../api/_openai.js')
    globalThis.fetch = async () => reply({ text: 'zz-two eggs' })
    const audio = Buffer.alloc(40000, 1).toString('base64')
    const debug = []
    assert.equal(await transcribeAudio(audio, 'audio/mp4', '', { debug }), 'zz-two eggs')
    assert.deepEqual(debug, [{ step: 'openai.transcribe', model: 'gpt-4o-mini-transcribe', seconds: 10 }]) // 40,000 bytes ≈ 10 s
    const told = []
    await transcribeAudio(audio, 'audio/mp4', '', { debug: told, seconds: 999 })
    assert.equal(told[0].seconds, 130)
    // The old three-argument call still works (no log).
    assert.equal(await transcribeAudio(audio, 'audio/mp4', ''), 'zz-two eggs')
  })

  test('responsesJson logs model and web calls', async () => {
    const { responsesJson } = await import('../api/_openai.js')
    globalThis.fetch = async () => reply({
      status: 'completed',
      output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{"text":"zz"}' }] }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 },
    })
    const debug = []
    await responsesJson({ model: 'gpt-5-mini', instructions: 'x', content: 'zz', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, debug })
    const logged = debug.find((item) => item.step === 'openai.response')
    assert.equal(logged.model, 'gpt-5-mini')
    assert.equal(logged.webCalls, 1)
    assert.deepEqual(usageFromDebug(debug, { feature: 'food' }), [{ feature: 'food', micros: 10270, n: 1 }])
  })

  test('the morning note books its cost (not on a dry run)', async () => {
    const { morningBriefing } = await import('../api/_briefing.js')
    const facts = { date: TODAY, weekday: 'Sunday', time: '08:00', first: { name: 'zz-Dentist', start: 570, isClass: false }, tasks: [{ text: 'zz-Dentist', time: '09:30' }], overdue: 0, classes: [] }
    const settings = { timeZone: 'UTC', notifications: { dailySummaryAi: true } }
    const generate = async () => ({ text: 'zz-Dentist at 9:30 AM is first today.', usage: { input: 1000, cached: 400, output: 200 }, ms: 5, model: 'gpt-5-mini' })
    const save = async () => {}
    const booked = []
    const record = async (supabase, userId, entries, options) => { booked.push({ userId, entries, options }) }
    const log = console.log
    console.log = () => {}
    try {
      const result = await morningBriefing({ supabase: {}, userId: USER, settings, facts, generate, save, record })
      assert.equal(result.source, 'ai')
      await morningBriefing({ supabase: {}, userId: USER, settings, facts, generate, save, record, dryRun: true })
    } finally {
      console.log = log
    }
    assert.deepEqual(booked, [{ userId: USER, entries: [{ feature: 'brief', micros: 560 }], options: { day: TODAY } }])
  })
})

// The AI cost ledger (src/lib/aiLedger.js): booking, roll-up, idempotent voice billing, summaries.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURES, addToLedger, billTalk, emptyLedger, localDay, openTalkSegment, projectMonth, summarizeLedger, totalsBetween,
} from '../src/lib/aiLedger.js'

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`)
const dayPlus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

describe('localDay', () => {
  const at = Date.parse('2026-10-11T02:30:00Z')
  test('the date in a time zone', () => {
    assert.equal(localDay('America/Toronto', at), '2026-10-10')
    assert.equal(localDay('Asia/Tokyo', at), '2026-10-11')
    assert.equal(localDay('UTC', at), '2026-10-11')
  })
  test('a bad or missing zone is UTC', () => {
    assert.equal(localDay('Not/AZone', at), '2026-10-11')
    assert.equal(localDay('', at), '2026-10-11')
    assert.equal(localDay(null, at), '2026-10-11')
  })
})

describe('addToLedger', () => {
  test('books a feature on a day and leaves its input alone', () => {
    const start = emptyLedger('2026-10-11')
    const ai = addToLedger(start, { day: '2026-10-11', feature: 'chat', micros: 1200 })
    assert.deepEqual(start.days, {})
    assert.deepEqual(ai.days['2026-10-11'], { chat: { u: 1200, n: 1 } })
    const again = addToLedger(ai, { day: '2026-10-11', feature: 'chat', micros: 800 })
    assert.deepEqual(again.days['2026-10-11'].chat, { u: 2000, n: 2 })
    assert.deepEqual(ai.days['2026-10-11'].chat, { u: 1200, n: 1 })
  })

  test('seconds, voice hand-offs and unknown features', () => {
    let ai = addToLedger(null, { day: '2026-10-11', feature: 'note', micros: 600, s: 20 })
    assert.equal(ai.since, '2026-10-11')
    assert.deepEqual(ai.days['2026-10-11'].note, { u: 600, n: 1, s: 20 })
    ai = addToLedger(ai, { day: '2026-10-11', feature: 'voiceAsk', micros: 5000 })
    assert.deepEqual(ai.days['2026-10-11'].voice, { u: 5000, n: 0, a: 5000 })
    ai = addToLedger(ai, { day: '2026-10-11', feature: 'mystery', micros: 10 })
    assert.deepEqual(ai.days['2026-10-11'].chat, { u: 10, n: 1 })
  })

  test('an earlier day moves since back; nothing to book writes nothing', () => {
    let ai = addToLedger(null, { day: '2026-10-11', feature: 'food', micros: 100 })
    ai = addToLedger(ai, { day: '2026-10-09', feature: 'food', micros: 100 })
    assert.equal(ai.since, '2026-10-09')
    const same = addToLedger(ai, { day: '2026-10-12', feature: 'food', micros: 0, n: 0 })
    assert.equal(same.days['2026-10-12'], undefined)
  })

  test('unpriced models are counted', () => {
    let ai = addToLedger(null, { day: '2026-10-11', feature: 'chat', micros: 10, unpricedModel: 'gpt-9' })
    ai = addToLedger(ai, { day: '2026-10-11', feature: 'chat', micros: 10, unpricedModel: 'gpt-9' })
    assert.deepEqual(ai.unpriced, { 'gpt-9': 2 })
  })

  test('keeps 62 days; older ones roll up into their month; 13 months', () => {
    let ai = null
    let day = '2026-01-01'
    for (let i = 0; i < 300; i += 1) {
      ai = addToLedger(ai, { day, feature: 'chat', micros: 1000 })
      day = dayPlus(day, 1)
    }
    const days = Object.keys(ai.days).sort()
    assert.equal(days.length, 62)
    assert.equal(days.at(-1), '2026-10-27')
    // January was rolled up and is still there; the totals add up.
    assert.deepEqual(ai.months['2026-01'], { chat: { u: 31000, n: 31 } })
    const rolled = Object.values(ai.months).reduce((sum, month) => sum + month.chat.n, 0)
    assert.equal(rolled + 62, 300)
    // Two years of days: only the newest 13 months stay.
    for (let i = 0; i < 450; i += 1) {
      ai = addToLedger(ai, { day, feature: 'brief', micros: 300 })
      day = dayPlus(day, 1)
    }
    assert.equal(Object.keys(ai.months).length, 13)
    assert.equal(Object.keys(ai.days).length, 62)
  })

  test('garbage in the stored ledger is dropped', () => {
    const ai = addToLedger({ v: 1, days: { nope: {}, '2026-10-10': 'x', '2026-10-09': { chat: { u: -5, n: 'a' } } }, months: [], talks: 7, unpriced: { x: 'y' } }, { day: '2026-10-11', feature: 'chat', micros: 5 })
    assert.deepEqual(Object.keys(ai.days).sort(), ['2026-10-09', '2026-10-11'])
    assert.deepEqual(ai.months, {})
    assert.deepEqual(ai.talks, {})
    assert.deepEqual(ai.unpriced, {})
  })
})

describe('voice billing per segment', () => {
  const minted = Date.parse('2026-10-11T21:00:00Z')
  const open = (ai = null, sessionId = 'sess_a') => openTalkSegment(ai, { talkId: 'talk_abc12345', sessionId, day: '2026-10-11', model: 'gpt-realtime-2.1-mini', mintedAt: minted, maxSec: 900 })

  test('a minted segment starts at zero and costs nothing', () => {
    const ai = open()
    assert.deepEqual(ai.talks.talk_abc12345.segs.sess_a, { day: '2026-10-11', model: 'gpt-realtime-2.1-mini', mintedAt: minted, maxSec: 900, seq: 0, u: 0, s: 0 })
    assert.deepEqual(ai.days, {})
  })

  test('cumulative totals bill only what is new; repeats bill nothing', () => {
    const now = minted + 60000
    let bill = billTalk(open(), { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 1, micros: 30000, seconds: 40, now })
    assert.equal(bill.deltaMicros, 30000)
    assert.equal(bill.skipped, false)
    assert.deepEqual(bill.ai.days['2026-10-11'].voice, { u: 30000, n: 1, s: 40 })
    // The same checkpoint again (same seq): skipped.
    const repeat = billTalk(bill.ai, { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 1, micros: 30000, seconds: 40, now })
    assert.equal(repeat.skipped, 'seq')
    assert.deepEqual(repeat.ai.days, bill.ai.days)
    // A later checkpoint with the same totals: nothing new.
    const same = billTalk(bill.ai, { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 2, micros: 30000, seconds: 40, now })
    assert.equal(same.deltaMicros, 0)
    assert.deepEqual(same.ai.days['2026-10-11'].voice, { u: 30000, n: 1, s: 40 })
    // Lower totals (a stale body) never refund.
    const lower = billTalk(same.ai, { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 3, micros: 10000, seconds: 10, now })
    assert.equal(lower.deltaMicros, 0)
    assert.equal(lower.deltaSeconds, 0)
    // More: the delta only, and the call is still counted once.
    bill = billTalk(lower.ai, { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 4, micros: 45000, seconds: 70, now })
    assert.equal(bill.deltaMicros, 15000)
    assert.deepEqual(bill.ai.days['2026-10-11'].voice, { u: 45000, n: 1, s: 70 })
    assert.equal(bill.ai.talks.talk_abc12345.u, 45000)
  })

  test('two segments of one call add up', () => {
    const now = minted + 60000
    let ai = billTalk(open(), { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 1, micros: 20000, seconds: 30, now }).ai
    ai = open(ai, 'sess_b')
    ai = billTalk(ai, { talkId: 'talk_abc12345', sessionId: 'sess_b', seq: 1, micros: 5000, seconds: 12, now }).ai
    assert.deepEqual(ai.days['2026-10-11'].voice, { u: 25000, n: 1, s: 42 })
    assert.equal(ai.talks.talk_abc12345.s, 42)
    assert.equal(ai.talks.talk_abc12345.billed, true)
  })

  test('opening a segment that is already open keeps what it billed', () => {
    const now = minted + 60000
    const ai = billTalk(open(), { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 1, micros: 20000, seconds: 30, now }).ai
    const again = open(ai)
    assert.deepEqual(again.talks.talk_abc12345.segs.sess_a, { day: '2026-10-11', model: 'gpt-realtime-2.1-mini', mintedAt: minted, maxSec: 900, seq: 1, u: 20000, s: 30 })
    assert.equal(billTalk(again, { talkId: 'talk_abc12345', sessionId: 'sess_a', seq: 1, micros: 20000, seconds: 30, now }).skipped, 'seq')
  })

  test('an unknown segment is skipped', () => {
    const bill = billTalk(open(), { talkId: 'talk_abc12345', sessionId: 'sess_zz', seq: 1, micros: 5, seconds: 1 })
    assert.equal(bill.skipped, 'unknown')
    assert.equal(billTalk(null, { talkId: 'talk_x', sessionId: 's', seq: 1, micros: 5 }).skipped, 'unknown')
  })

  test('keeps 30 talks and drops segments a day after the last write', () => {
    let ai = null
    for (let i = 0; i < 35; i += 1) ai = openTalkSegment(ai, { talkId: `talk_${String(i).padStart(8, '0')}`, sessionId: 's1', day: '2026-10-11', model: 'm', mintedAt: minted + i * 1000, maxSec: 60 })
    assert.equal(Object.keys(ai.talks).length, 30)
    assert.ok(!ai.talks.talk_00000000)
    ai = openTalkSegment(ai, { talkId: 'talk_later000', sessionId: 's1', day: '2026-10-12', model: 'm', mintedAt: minted + 2 * 86400000, maxSec: 60 })
    assert.deepEqual(ai.talks.talk_00000034.segs, {})
    assert.ok(ai.talks.talk_later000.segs.s1)
  })
})

describe('summarizeLedger', () => {
  const TODAY = '2026-10-11'
  // Two months of steady use: $0.50 of chat (10 messages) and 10 voice minutes ($0.40) a day.
  function steady(days = 40) {
    let ai = null
    for (let i = 0; i < days; i += 1) {
      const day = dayPlus(TODAY, -i)
      for (let m = 0; m < 10; m += 1) ai = addToLedger(ai, { day, feature: 'chat', micros: 50000 })
      ai = addToLedger(ai, { day, feature: 'voice', micros: 400000, s: 600 })
    }
    return ai
  }

  test('today, this month and last month', () => {
    const summary = summarizeLedger(steady(), { today: TODAY, budgetUsd: 20 })
    assert.equal(summary.available, true)
    near(summary.today.total, 0.9)
    assert.equal(summary.today.byFeature.chat.n, 10)
    near(summary.month.total, 11 * 0.9)
    assert.equal(summary.month.key, '2026-10')
    assert.equal(summary.month.voiceMinutes, 110)
    assert.equal(summary.month.calls, 11)
    assert.equal(summary.lastMonth.key, '2026-09')
    near(summary.lastMonth.total, 29 * 0.9) // Sep 2 – Sep 30 are in the 40 days
    assert.deepEqual(Object.keys(summary.today.byFeature), FEATURES.map((feature) => feature.id))
    assert.equal(summary.voiceSecondsToday, 600)
    assert.equal(summary.dayOfMonth, 11)
    assert.equal(summary.daysInMonth, 31)
    assert.equal(summary.budget.resetsOn, '2026-11-01')
  })

  test('last30 is zero-filled, oldest first', () => {
    const ai = addToLedger(null, { day: '2026-10-05', feature: 'food', micros: 20000 })
    const { last30 } = summarizeLedger(ai, { today: TODAY })
    assert.equal(last30.length, 30)
    assert.equal(last30[0].day, '2026-09-12')
    assert.equal(last30.at(-1).day, TODAY)
    const oct5 = last30.find((entry) => entry.day === '2026-10-05')
    near(oct5.usd, 0.02)
    near(oct5.byFeature.food, 0.02)
    assert.equal(last30.filter((entry) => entry.usd > 0).length, 1)
  })

  test('the rolled-up months still count toward their month', () => {
    const ai = { v: 1, since: '2026-08-01', days: {}, months: { '2026-09': { chat: { u: 3000000, n: 600 } } } }
    const summary = summarizeLedger(ai, { today: TODAY })
    near(summary.lastMonth.total, 3)
    assert.equal(summary.lastMonth.byFeature.chat.n, 600)
  })

  test('per-unit rates need enough data', () => {
    const little = summarizeLedger(steady(1), { today: TODAY })
    assert.equal(little.perUnit.voicePerMin, null) // 10 minutes < 20
    assert.equal(little.perUnit.chatPerMsg, null) // 10 messages < 30
    const plenty = summarizeLedger(steady(3), { today: TODAY })
    near(plenty.perUnit.voicePerMin, 0.04)
    near(plenty.perUnit.chatPerMsg, 0.05)
    near(plenty.perUnit.avgCallMinutes, 10)
    assert.equal(plenty.averages.days, 3)
  })

  test('budget states at 79, 80 and 100 %', () => {
    const spend = (usd) => summarizeLedger(addToLedger(null, { day: TODAY, feature: 'chat', micros: Math.round(usd * 1e6) }), { today: TODAY, budgetUsd: 20 }).budget
    assert.equal(spend(15.8).state, 'ok')
    assert.equal(spend(16).state, 'warn')
    assert.equal(spend(19.99).state, 'warn')
    assert.equal(spend(20).state, 'over')
    near(spend(16).pct, 0.8)
    assert.equal(summarizeLedger(null, { today: TODAY, budgetUsd: 0 }).budget.state, 'none')
  })

  test('a missing ledger reads as nothing spent', () => {
    const summary = summarizeLedger(null, { today: TODAY, budgetUsd: 20 })
    assert.equal(summary.month.total, 0)
    assert.equal(summary.projected, 0)
    assert.equal(summary.since, null)
    assert.deepEqual(summary.unpriced, [])
  })

  test('totalsBetween sums a range of days', () => {
    const totals = totalsBetween(steady(5), dayPlus(TODAY, -1), TODAY)
    near(totals.total, 1.8)
    assert.equal(totals.byFeature.voice.seconds, 1200)
  })
})

describe('projectMonth', () => {
  test('from day 7: this month’s average', () => {
    near(projectMonth({ spent: 10, dayOfMonth: 10, daysInMonth: 31, last7Usd: [9, 9, 9, 9, 9, 9, 9] }), 10 + 1 * 21)
  })
  test('in the first week: the last 7 days (into last month)', () => {
    near(projectMonth({ spent: 0.5, dayOfMonth: 2, daysInMonth: 30, last7Usd: [1, 1, 1, 1, 1, 0.25, 0.25] }), 0.5 + (5.5 / 7) * 28)
  })
  test('no data: what was spent', () => {
    assert.equal(projectMonth({ spent: 0, dayOfMonth: 3, daysInMonth: 30, last7Usd: [] }), 0)
    assert.equal(projectMonth({ spent: 0, dayOfMonth: 20, daysInMonth: 30 }), 0)
  })
  test('through summarizeLedger', () => {
    const ai = addToLedger(null, { day: '2026-10-02', feature: 'chat', micros: 700000 })
    const summary = summarizeLedger(ai, { today: '2026-10-03' })
    near(summary.projected, 0.7 + (0.7 / 7) * 28)
  })
})

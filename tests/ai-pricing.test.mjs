// AI prices and cost maths (src/lib/aiPricing.js). The fixtures are the usage OpenAI reported in the
// realtime probe, so the numbers match what OpenAI bills.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK, PRICES_CHECKED, REALTIME_PRICES, TEXT_PRICES, TRANSCRIBE_PER_MIN, WEB_SEARCH_PER_CALL,
  addRealtimeUsage, capCeiling, dollars, emptyTally, estimateMonth, formatUsd, micros, priceKey,
  sessionEstimate, tallyCost, textCost, transcriptionCost,
} from '../src/lib/aiPricing.js'

const MINI = 'gpt-realtime-2.1-mini'
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ''} ${actual} ≉ ${expected}`)

// response.done usage objects from the probe.
const textResponse1 = {
  total_tokens: 465, input_tokens: 378, output_tokens: 87,
  input_token_details: { text_tokens: 378, audio_tokens: 0, image_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 } },
  output_token_details: { text_tokens: 87, audio_tokens: 0, reasoning_tokens: 41 },
}
const textResponse2 = {
  input_tokens: 457, output_tokens: 25,
  input_token_details: { text_tokens: 457, audio_tokens: 0, cached_tokens: 384, cached_tokens_details: { text_tokens: 384, audio_tokens: 0 } },
  output_token_details: { text_tokens: 25, audio_tokens: 0 },
}
const audioResponse = {
  input_token_details: { text_tokens: 25, audio_tokens: 12, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
  output_token_details: { text_tokens: 24, audio_tokens: 23, reasoning_tokens: 13 },
}

describe('price tables', () => {
  test('are the checked prices', () => {
    assert.equal(PRICES_CHECKED, '2026-10-11')
    assert.deepEqual(REALTIME_PRICES[MINI], { textIn: 0.60, textCached: 0.06, audioIn: 10, audioCached: 0.30, textOut: 2.40, audioOut: 20 })
    assert.deepEqual(REALTIME_PRICES['gpt-realtime-mini'], REALTIME_PRICES[MINI])
    assert.deepEqual(REALTIME_PRICES['gpt-realtime-2.1'], { textIn: 4, textCached: 0.40, audioIn: 32, audioCached: 0.40, textOut: 24, audioOut: 64 })
    assert.deepEqual(REALTIME_PRICES['gpt-realtime-2'], REALTIME_PRICES['gpt-realtime-2.1'])
    assert.deepEqual(TEXT_PRICES['gpt-5-mini'], { in: 0.25, cached: 0.025, out: 2 })
    assert.equal(TRANSCRIBE_PER_MIN['gpt-transcribe'], 0.0045)
    assert.equal(TRANSCRIBE_PER_MIN['gpt-4o-mini-transcribe'], 0.003)
    assert.equal(WEB_SEARCH_PER_CALL, 0.01)
    assert.deepEqual(FALLBACK, { text: 'gpt-5-mini', realtime: MINI, transcribe: 'gpt-transcribe' })
  })

  test('priceKey resolves dated snapshots and knows nothing else', () => {
    assert.equal(priceKey('gpt-5-mini', TEXT_PRICES), 'gpt-5-mini')
    assert.equal(priceKey('gpt-5-mini-2025-08-07', TEXT_PRICES), 'gpt-5-mini')
    assert.equal(priceKey(' GPT-5-Mini ', TEXT_PRICES), 'gpt-5-mini')
    assert.equal(priceKey('gpt-realtime-2.1-mini-2026-07-06', REALTIME_PRICES), MINI)
    assert.equal(priceKey('gpt-9-turbo', TEXT_PRICES), null)
    assert.equal(priceKey('', TEXT_PRICES), null)
    assert.equal(priceKey(null, TEXT_PRICES), null)
    assert.equal(priceKey('toString', TEXT_PRICES), null)
  })

  test('micros and dollars convert both ways', () => {
    assert.equal(micros(0.000436), 436)
    assert.equal(dollars(436), 0.000436)
    assert.equal(micros(1.2345678), 1234568)
  })
})

describe('realtime cost', () => {
  const costOf = (usage, model = MINI) => tallyCost(addRealtimeUsage(emptyTally(), usage), model)

  test('the probe responses', () => {
    assert.deepEqual(costOf(textResponse1), { micros: 436, unpriced: false })
    assert.deepEqual(costOf(textResponse2), { micros: 127, unpriced: false })
    assert.deepEqual(costOf(audioResponse), { micros: 653, unpriced: false })
  })

  test('a tally sums responses; priced once at the end', () => {
    let tally = emptyTally()
    for (const usage of [textResponse1, textResponse2, audioResponse]) tally = addRealtimeUsage(tally, usage)
    assert.deepEqual(tally, { responses: 3, textIn: 860, textCached: 384, audioIn: 12, audioCached: 0, textOut: 136, audioOut: 23 })
    assert.equal(tallyCost(tally, MINI).micros, 1215) // 435.6 + 126.84 + 652.6, rounded once
  })

  test('addRealtimeUsage updates the tally in place and returns it', () => {
    const tally = emptyTally()
    const next = addRealtimeUsage(tally, textResponse1)
    assert.equal(next, tally)
    assert.equal(tally.responses, 1)
    assert.equal(tally.textIn, 378)
    // A missing tally starts a new one.
    assert.equal(addRealtimeUsage(undefined, textResponse1).textOut, 87)
  })

  test('reasoning tokens are not counted twice', () => {
    const withReasoning = costOf(textResponse1).micros
    const withoutField = costOf({ ...textResponse1, output_token_details: { text_tokens: 87, audio_tokens: 0 } }).micros
    assert.equal(withReasoning, withoutField)
  })

  test('missing cached_tokens_details counts as nothing cached', () => {
    const usage = { input_token_details: { text_tokens: 1000, audio_tokens: 100, cached_tokens: 900 }, output_token_details: { text_tokens: 0, audio_tokens: 0 } }
    const tally = addRealtimeUsage(emptyTally(), usage)
    assert.equal(tally.textCached, 0)
    assert.equal(tally.audioCached, 0)
    assert.equal(tallyCost(tally, MINI).micros, 1600) // 1000 × 0.60 + 100 × 10
  })

  test('cached more than the total is clamped', () => {
    const usage = { input_token_details: { text_tokens: 100, audio_tokens: 10, cached_tokens_details: { text_tokens: 500, audio_tokens: 50 } }, output_token_details: {} }
    const tally = addRealtimeUsage(emptyTally(), usage)
    assert.equal(tally.textCached, 100)
    assert.equal(tally.audioCached, 10)
    assert.equal(tallyCost(tally, MINI).micros, 9) // 100 × 0.06 + 10 × 0.30
    assert.equal(tallyCost({ textIn: 10, textCached: 50 }, MINI).micros, 1) // 10 × 0.06 = 0.6
  })

  test('NaN, negative and text counts are 0', () => {
    const usage = { input_token_details: { text_tokens: NaN, audio_tokens: -40 }, output_token_details: { text_tokens: 'many', audio_tokens: null } }
    assert.deepEqual(addRealtimeUsage(emptyTally(), usage), { ...emptyTally(), responses: 1 })
    assert.equal(tallyCost({ textIn: -5, audioOut: Infinity }, MINI).micros, 0)
    assert.deepEqual(addRealtimeUsage(emptyTally(), null), emptyTally())
    assert.deepEqual(addRealtimeUsage(null, textResponse1).responses, 1)
  })

  test('an unknown model is priced as the fallback and flagged', () => {
    assert.deepEqual(costOf(audioResponse, 'gpt-realtime-9'), { micros: 653, unpriced: true })
    assert.deepEqual(costOf(audioResponse, 'gpt-realtime-mini-2025-12-15'), { micros: 653, unpriced: false })
    assert.ok(costOf(audioResponse, 'gpt-realtime-2.1').micros > 653)
  })
})

describe('text cost', () => {
  test('gpt-5-mini with cached input', () => {
    assert.deepEqual(textCost({ input: 1000, cached: 400, output: 200 }, 'gpt-5-mini'), { micros: 560, unpriced: false })
  })

  test("OpenAI's own usage shape works too", () => {
    const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 150 } }
    assert.equal(textCost(usage, 'gpt-5-mini-2025-08-07').micros, 560)
  })

  test('web search calls add a cent each', () => {
    assert.deepEqual(textCost({ input: 1000, cached: 400, output: 200 }, 'gpt-5-mini', { webCalls: 2 }), { micros: 20560, unpriced: false })
  })

  test('bad input is 0; unknown model flagged', () => {
    assert.deepEqual(textCost(null, 'gpt-5-mini'), { micros: 0, unpriced: false })
    assert.equal(textCost({ input: 'x', output: -3 }, 'gpt-5-mini').micros, 0)
    assert.equal(textCost({ input: 100, cached: 900 }, 'gpt-5-mini').micros, 3) // 100 cached × 0.025 = 2.5
    assert.deepEqual(textCost({ input: 1000, output: 0 }, 'some-new-model'), { micros: 250, unpriced: true })
  })
})

describe('transcription cost', () => {
  test('the probe: 2 s of gpt-transcribe (usage type duration)', () => {
    assert.deepEqual(transcriptionCost({ usage: { type: 'duration', seconds: 2 } }, 'gpt-transcribe'), { micros: 150, seconds: 2, estimated: false, unpriced: false })
    assert.equal(transcriptionCost({ seconds: 2 }, 'gpt-transcribe').micros, 150)
  })

  test('token usage is estimated at 10 audio tokens a second', () => {
    const cost = transcriptionCost({ usage: { type: 'tokens', input_tokens: 25, input_token_details: { audio_tokens: 20, text_tokens: 5 } } }, 'gpt-transcribe')
    assert.equal(cost.seconds, 2)
    assert.equal(cost.micros, 150)
    assert.equal(cost.estimated, true)
  })

  test('voice notes: a minute of gpt-4o-mini-transcribe is $0.003; unknown → fallback', () => {
    assert.equal(transcriptionCost({ seconds: 60 }, 'gpt-4o-mini-transcribe').micros, 3000)
    assert.deepEqual(transcriptionCost({ seconds: 60 }, 'whisper-2'), { micros: 4500, seconds: 60, estimated: false, unpriced: true })
    assert.equal(transcriptionCost({ seconds: -5 }, 'gpt-transcribe').micros, 0)
    assert.equal(transcriptionCost(undefined, 'gpt-transcribe').micros, 0)
  })
})

describe('estimates', () => {
  test('sessionEstimate follows the cost model', () => {
    near(sessionEstimate(10), 0.40, 0.02, '10 min')
    near(sessionEstimate(2.5), 0.071, 0.005, '2.5 min')
    near(sessionEstimate(15), 0.72, 0.02, '15 min')
    near(sessionEstimate(20), 1.11, 0.03, '20 min')
    assert.equal(sessionEstimate(0), 0)
    assert.equal(sessionEstimate(-3), 0)
    // Longer calls cost more a minute.
    assert.ok(sessionEstimate(15) / 15 > sessionEstimate(5) / 5)
  })

  test('estimateMonth with typical figures', () => {
    const month = estimateMonth({ voiceMinutesPerDay: 10, callMinutes: 10, chatPerDay: 10 })
    near(month.voice, 30 * sessionEstimate(10), 1e-9, 'voice')
    near(month.chat, 30 * 10 * 0.005, 1e-9, 'chat')
    near(month.total, month.voice + month.chat, 1e-9, 'total')
    near(month.low, month.voice * 0.78 + month.chat, 1e-9, 'low')
    near(month.high, month.voice * 2.1 + month.chat, 1e-9, 'high')
    assert.ok(month.low <= month.total && month.total <= month.high)
    assert.deepEqual(month.basis, { voice: 'typical', chat: 'typical' })
  })

  test('estimateMonth with their own rates', () => {
    const typicalPerMin = sessionEstimate(10) / 10
    const month = estimateMonth({ voiceMinutesPerDay: 10, callMinutes: 10, chatPerDay: 10, measured: { voicePerMin: typicalPerMin * 1.5, avgCallMinutes: 10, chatPerMsg: 0.002 } })
    near(month.voice, 30 * sessionEstimate(10) * 1.5, 1e-9, 'voice')
    near(month.chat, 30 * 10 * 0.002, 1e-9, 'chat')
    assert.deepEqual(month.basis, { voice: 'yours', chat: 'yours' })
  })

  test('the measured factor is clamped to 0.5–3', () => {
    const base = estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10 }).voice
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: 10 } }).voice, base * 3, 1e-9, 'high')
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: 0.0001 } }).voice, base * 0.5, 1e-9, 'low')
    // null measurements (too little data) are ignored.
    assert.equal(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: null, chatPerMsg: null } }).basis.voice, 'typical')
    assert.equal(estimateMonth({ voiceMinutesPerDay: 0, callMinutes: 10, chatPerDay: 0 }).total, 0)
  })

  test('capCeiling at the defaults is about $43 / $90 / $20', () => {
    const ceiling = capCeiling({ dailyMinutes: 30, sessionMinutes: 15, budgetUsd: 20 })
    near(ceiling.expected, 43, 1, 'expected')
    near(ceiling.worst, 90, 2, 'worst')
    assert.equal(ceiling.capped, 20)
    assert.equal(capCeiling({ dailyMinutes: 30, sessionMinutes: 15, budgetUsd: 0 }).capped, ceiling.worst)
    assert.ok(capCeiling({ dailyMinutes: 10, sessionMinutes: 5, budgetUsd: 50 }).capped < 50)
  })
})

describe('formatUsd', () => {
  test('dollars', () => {
    assert.equal(formatUsd(0), '$0.00')
    assert.equal(formatUsd(0.004), '<$0.01')
    assert.equal(formatUsd(0.13), '$0.13')
    assert.equal(formatUsd(0.126), '$0.13')
    assert.equal(formatUsd(12.4), '$12.40')
    assert.equal(formatUsd(240.5), '$240.50')
    assert.equal(formatUsd(1240), '$1,240')
    assert.equal(formatUsd(1239.6), '$1,240')
    assert.equal(formatUsd(NaN), '$0.00')
    assert.equal(formatUsd(-3), '$0.00')
  })

  test('cents for the live call cost', () => {
    assert.equal(formatUsd(0.09, { cents: true }), '9¢')
    assert.equal(formatUsd(0.004, { cents: true }), '<1¢')
    assert.equal(formatUsd(0, { cents: true }), '0¢')
    assert.equal(formatUsd(0.994, { cents: true }), '99¢')
    assert.equal(formatUsd(1.2, { cents: true }), '$1.20')
  })
})

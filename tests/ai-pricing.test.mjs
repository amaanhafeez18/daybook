// AI prices and cost maths (src/lib/aiPricing.js). The fixtures are the usage OpenAI reported in the
// realtime probe, so the numbers match what OpenAI bills.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK, PRICES_CHECKED, REALTIME_PRICES, TEXT_PRICES, TRANSCRIBE_PER_MIN, TRANSCRIBE_TOKEN_PRICES, WEB_SEARCH_PER_CALL,
  addRealtimeUsage, addTranscriptionTokens, capCeiling, dollars, emptyTally, estimateMonth, formatUsd, micros, priceKey,
  sessionEstimate, tallyCost, textCost, transcriptionCost, transcriptionTokensCost, worstCaveat,
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
    assert.equal(PRICES_CHECKED, '2026-10-12')
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

  test('the newer text models, with their cache-write rate', () => {
    assert.deepEqual(TEXT_PRICES['gpt-6-luna'], { in: 0.10, cached: 0.01, cacheWrite: 0.125, out: 0.50 })
    assert.deepEqual(TEXT_PRICES['gpt-6-sol'], { in: 2, cached: 0.20, cacheWrite: 2.50, out: 10 })
    assert.deepEqual(TEXT_PRICES['gpt-6.1-sol'], { in: 2, cached: 0.10, cacheWrite: 2.50, out: 10 })
    assert.deepEqual(TEXT_PRICES['gpt-5.6-terra'], { in: 2, cached: 0.20, cacheWrite: 2.50, out: 12 })
    assert.deepEqual(TEXT_PRICES['gpt-5.6-luna'], { in: 0.20, cached: 0.02, cacheWrite: 0.25, out: 1.20 })
    assert.deepEqual(TEXT_PRICES['gpt-5.4-nano'], { in: 0.20, cached: 0.02, out: 1.25 })
    assert.deepEqual(TEXT_PRICES['gpt-4.1-mini'], { in: 0.40, cached: 0.10, out: 1.60 })
    // A cache write is 1.25× the input rate wherever it is listed.
    for (const [model, p] of Object.entries(TEXT_PRICES)) if (p.cacheWrite != null) near(p.cacheWrite, p.in * 1.25, 1e-12, model)
    assert.deepEqual(TRANSCRIBE_TOKEN_PRICES, { 'gpt-4o-mini-transcribe': { in: 1.25, out: 5 }, 'gpt-4o-transcribe': { in: 2.5, out: 10 } })
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

  test('gpt-6-luna live probe: a cold call writes the cache at 1.25×', () => {
    // 18,707 input tokens, 18,704 of them stored in the cache: 3 × 0.10 + 18,704 × 0.125 = 2,338.3 µ$.
    const cold = { input_tokens: 18707, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 18704 }, output_tokens: 0 }
    assert.deepEqual(textCost(cold, 'gpt-6-luna'), { micros: 2338, unpriced: false })
    // Daybook's debug shape (usageOf) gives the same.
    assert.equal(textCost({ input: 18707, cached: 0, writes: 18704, output: 0 }, 'gpt-6-luna').micros, 2338)
    // The next call reads it back: 18,704 × 0.01 + 3 × 0.10 = 187.34 µ$.
    const warm = { input_tokens: 18707, input_tokens_details: { cached_tokens: 18704 }, output_tokens: 0 }
    assert.equal(textCost(warm, 'gpt-6-luna').micros, 187)
  })

  test('cache writes: capped at the uncached input; a model without a write rate bills them as input', () => {
    // More writes reported than uncached input: only the uncached part counts.
    assert.equal(textCost({ input: 1000, cached: 900, writes: 5000, output: 0 }, 'gpt-6-luna').micros, 22) // 900 × 0.01 + 100 × 0.125 = 21.5
    // gpt-5-mini has no cache-write charge: the same as without writes.
    assert.equal(textCost({ input: 1000, cached: 400, writes: 600, output: 200 }, 'gpt-5-mini').micros, 560)
    assert.equal(textCost({ input: 1000, writes: 'x', output: 0 }, 'gpt-6-luna').micros, 100)
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

  test('token-billed models are priced from their tokens (docs example: 17 audio in, 9 out)', () => {
    const usage = { type: 'tokens', input_tokens: 17, output_tokens: 9, total_tokens: 26, input_token_details: { audio_tokens: 17, text_tokens: 0 } }
    // 17 × 1.25 + 9 × 5 = 66.25 µ$.
    assert.deepEqual(transcriptionCost({ usage }, 'gpt-4o-mini-transcribe'), { micros: 66, seconds: 0, estimated: false, unpriced: false })
    assert.equal(transcriptionCost({ usage, seconds: 4 }, 'gpt-4o-mini-transcribe-2025-12-15').seconds, 4)
    assert.equal(transcriptionCost({ usage }, 'gpt-4o-transcribe').micros, 133) // 17 × 2.5 + 9 × 10 = 132.5
    // Without usage, the length still prices it.
    assert.equal(transcriptionCost({ seconds: 60 }, 'gpt-4o-mini-transcribe').micros, 3000)
    // Duration usage on a token model (unexpected) is priced by the minute.
    assert.equal(transcriptionCost({ usage: { type: 'duration', seconds: 60 } }, 'gpt-4o-mini-transcribe').micros, 3000)
  })

  test('summed realtime transcription tokens', () => {
    let tokens = addTranscriptionTokens(null, { type: 'tokens', input_tokens: 17, output_tokens: 9, input_token_details: { audio_tokens: 17 } })
    tokens = addTranscriptionTokens(tokens, { type: 'tokens', input_tokens: 3, output_tokens: 1, input_token_details: { audio_tokens: 3 } })
    addTranscriptionTokens(tokens, { input_tokens: NaN, output_tokens: -4 })
    addTranscriptionTokens(tokens, null)
    assert.deepEqual(tokens, { in: 20, out: 10, audio: 20 })
    assert.equal(transcriptionTokensCost(tokens, 'gpt-4o-mini-transcribe').micros, 75) // 20 × 1.25 + 10 × 5
    // A duration model's tokens fall back to ≈ 10 audio tokens a second.
    assert.equal(transcriptionTokensCost({ in: 700, out: 40, audio: 600 }, 'gpt-transcribe').micros, 4500)
    assert.equal(transcriptionTokensCost(null, 'gpt-4o-mini-transcribe').micros, 0)
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
    near(month.chat, 30 * 10 * 0.002, 1e-9, 'chat')
    near(month.total, month.voice + month.chat, 1e-9, 'total')
    // Low: quiet calls (half the estimate). High: talkative ones (2×); spoken audio is cached (2026-10-12 bill).
    near(month.low, month.voice * 0.5 + month.chat, 1e-9, 'low')
    near(month.high, month.voice * 2 + month.chat, 1e-9, 'high')
    // A 10-minute call: about $0.20 to $0.80 around the $0.40 estimate.
    near(month.low - month.chat, 30 * 0.20, 0.2, 'low call')
    near(month.high - month.chat, 30 * 0.80, 0.5, 'high call')
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

  test('a measured voice rate narrows the range (its caching is already in the rate)', () => {
    const typicalPerMin = sessionEstimate(10) / 10
    // Real calls that show uncached audio (≈ 3.4×): the top end is not multiplied by 3.5 again.
    const month = estimateMonth({ voiceMinutesPerDay: 10, callMinutes: 10, chatPerDay: 10, measured: { voicePerMin: typicalPerMin * 3.4, avgCallMinutes: 10 } })
    near(month.high, month.voice * 1.5 + month.chat, 1e-9, 'high')
    near(month.low, month.voice * 0.8 + month.chat, 1e-9, 'low')
    near((month.high - month.chat) / month.voice, 1.5, 1e-9, 'not 3.5')
    // Typical basis keeps the wide range.
    const typical = estimateMonth({ voiceMinutesPerDay: 10, callMinutes: 10 })
    near(typical.high / typical.voice, 2, 1e-9, 'typical high')
  })

  test('the measured factor is clamped to 0.3–5', () => {
    const base = estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10 }).voice
    const typicalPerMin = sessionEstimate(10) / 10
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: 10 } }).voice, base * 5, 1e-9, 'high')
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: 0.0001 } }).voice, base * 0.3, 1e-9, 'low')
    // Inside the range a measured rate is used as it is: 4.5× (no audio cached) and 0.35×.
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: typicalPerMin * 4.5, avgCallMinutes: 10 } }).voice, base * 4.5, 1e-9, '4.5×')
    near(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: typicalPerMin * 0.35, avgCallMinutes: 10 } }).voice, base * 0.35, 1e-9, '0.35×')
    // null measurements (too little data) are ignored.
    assert.equal(estimateMonth({ voiceMinutesPerDay: 20, callMinutes: 10, measured: { voicePerMin: null, chatPerMsg: null } }).basis.voice, 'typical')
    assert.equal(estimateMonth({ voiceMinutesPerDay: 0, callMinutes: 10, chatPerDay: 0 }).total, 0)
  })

  test('capCeiling at the defaults is about $43 / $86 / $20', () => {
    const ceiling = capCeiling({ dailyMinutes: 30, sessionMinutes: 15, budgetUsd: 20 })
    near(ceiling.expected, 43, 1, 'expected')
    near(ceiling.worst, 86, 2, 'worst')
    assert.equal(ceiling.capped, 20)
    assert.equal(capCeiling({ dailyMinutes: 30, sessionMinutes: 15, budgetUsd: 0 }).capped, ceiling.worst)
    assert.ok(capCeiling({ dailyMinutes: 10, sessionMinutes: 5, budgetUsd: 50 }).capped < 50)
  })

  test('worstCaveat: the worst case says it assumes talkative calls unless the budget stops it', () => {
    const atBudget = capCeiling({ dailyMinutes: 30, sessionMinutes: 15, budgetUsd: 20 })
    assert.equal(worstCaveat(atBudget, 20), '')
    const underBudget = capCeiling({ dailyMinutes: 10, sessionMinutes: 5, budgetUsd: 500 })
    assert.equal(worstCaveat(underBudget, 500), ', if every call is a long, talkative one')
    assert.equal(worstCaveat(capCeiling({ budgetUsd: 0 }), 0), ', if every call is a long, talkative one')
    assert.equal(worstCaveat(null), ', if every call is a long, talkative one')
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

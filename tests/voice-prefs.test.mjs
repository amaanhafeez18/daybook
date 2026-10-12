// Voice chat and AI budget settings (src/lib/voice/prefs.js).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BUDGET_DEFAULT, BUDGET_OPTIONS, BUDGET_WARN, VOICE_DEFAULTS, VOICE_NAMES, VOICE_OPTIONS, VOICE_RECOMMENDED, budgetUsd, callLimits, voicePrefs } from '../src/lib/voice/prefs.js'

describe('voicePrefs', () => {
  test('defaults', () => {
    assert.deepEqual(VOICE_DEFAULTS, { enabled: true, dailyMinutes: 30, sessionMinutes: 15, silenceSeconds: 60, voice: 'marin' })
    assert.deepEqual(VOICE_OPTIONS, { dailyMinutes: [10, 20, 30, 60], sessionMinutes: [5, 10, 15], silenceSeconds: [30, 60, 120], voice: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] })
    assert.deepEqual(VOICE_RECOMMENDED, ['marin', 'cedar'])
    assert.equal(VOICE_OPTIONS.voice, VOICE_NAMES)
    assert.deepEqual(voicePrefs({}), VOICE_DEFAULTS)
    assert.deepEqual(voicePrefs(null), VOICE_DEFAULTS)
    assert.deepEqual(voicePrefs({ voice: 'marin' }), VOICE_DEFAULTS) // not an object
  })

  test('saved values are kept', () => {
    const prefs = voicePrefs({ voice: { enabled: false, dailyMinutes: 60, sessionMinutes: 5, silenceSeconds: 120, voice: 'cedar' } })
    assert.deepEqual(prefs, { enabled: false, dailyMinutes: 60, sessionMinutes: 5, silenceSeconds: 120, voice: 'cedar' })
  })

  test('numbers clamp to the nearest option; anything else is the default', () => {
    const prefs = voicePrefs({ voice: { enabled: 'yes', dailyMinutes: 999, sessionMinutes: 1, silenceSeconds: '100', voice: 'Nova' } })
    assert.deepEqual(prefs, { enabled: true, dailyMinutes: 60, sessionMinutes: 5, silenceSeconds: 120, voice: 'marin' })
    const bad = voicePrefs({ voice: { dailyMinutes: 'lots', sessionMinutes: NaN, silenceSeconds: null, voice: 7 } })
    assert.deepEqual(bad, VOICE_DEFAULTS)
    assert.equal(voicePrefs({ voice: { voice: ' Cedar ' } }).voice, 'cedar')
    assert.equal(voicePrefs({ voice: { voice: 'Alloy' } }).voice, 'alloy')
    assert.equal(voicePrefs({ voice: { voice: 'shimmer' } }).voice, 'shimmer')
    assert.equal(voicePrefs({ voice: { voice: 'fable' } }).voice, 'marin') // a TTS-only voice the realtime model doesn't have
  })
})

describe('budgetUsd', () => {
  test('missing → $20; 0 = no budget', () => {
    assert.equal(BUDGET_DEFAULT, 20)
    assert.deepEqual(BUDGET_OPTIONS, [0, 5, 10, 20, 50])
    assert.equal(BUDGET_WARN, 0.8)
    assert.equal(budgetUsd({}), 20)
    assert.equal(budgetUsd(null), 20)
    assert.equal(budgetUsd({ aiBudgetUsd: null }), 20)
    assert.equal(budgetUsd({ aiBudgetUsd: 0 }), 0)
    assert.equal(budgetUsd({ aiBudgetUsd: 50 }), 50)
  })
  test('unreadable → default; capped at $500; cents kept', () => {
    assert.equal(budgetUsd({ aiBudgetUsd: -5 }), 20)
    assert.equal(budgetUsd({ aiBudgetUsd: 'plenty' }), 20)
    assert.equal(budgetUsd({ aiBudgetUsd: '15' }), 15)
    assert.equal(budgetUsd({ aiBudgetUsd: 10000 }), 500)
    assert.equal(budgetUsd({ aiBudgetUsd: 12.345 }), 12.35)
  })
})

describe('callLimits', () => {
  const prefs = VOICE_DEFAULTS

  test('a fresh day: a full 15-minute call', () => {
    const limits = callLimits({ prefs, budgetUsd: 20, usedTodaySec: 0, monthUsd: 0 })
    assert.deepEqual(limits, { blocked: null, sessionSec: 900, dailyLeftSec: 1800, silenceSec: 60, budgetLeftUsd: 20, warnBudget: false })
  })

  test('the call is cut to what is left today', () => {
    const limits = callLimits({ prefs, budgetUsd: 20, usedTodaySec: 1500, monthUsd: 1 })
    assert.equal(limits.blocked, null)
    assert.equal(limits.dailyLeftSec, 300)
    assert.equal(limits.sessionSec, 300)
  })

  test('off', () => {
    assert.equal(callLimits({ prefs: { ...prefs, enabled: false }, budgetUsd: 20 }).blocked, 'off')
  })

  test('daily: under a minute left', () => {
    assert.equal(callLimits({ prefs, budgetUsd: 20, usedTodaySec: 1741 }).blocked, 'daily')
    assert.equal(callLimits({ prefs, budgetUsd: 20, usedTodaySec: 1740 }).blocked, null)
    assert.equal(callLimits({ prefs, budgetUsd: 20, usedTodaySec: 99999 }).sessionSec, 0)
  })

  test('budget: used up blocks; 80% warns; no budget never blocks', () => {
    assert.equal(callLimits({ prefs, budgetUsd: 20, monthUsd: 20 }).blocked, 'budget')
    assert.equal(callLimits({ prefs, budgetUsd: 20, monthUsd: 20 }).budgetLeftUsd, 0)
    const warn = callLimits({ prefs, budgetUsd: 20, monthUsd: 16 })
    assert.equal(warn.blocked, null)
    assert.equal(warn.warnBudget, true)
    assert.equal(callLimits({ prefs, budgetUsd: 20, monthUsd: 15.9 }).warnBudget, false)
    const none = callLimits({ prefs, budgetUsd: 0, monthUsd: 900 })
    assert.equal(none.blocked, null)
    assert.equal(none.budgetLeftUsd, null)
  })

  test('off wins over budget, budget over daily', () => {
    assert.equal(callLimits({ prefs: { ...prefs, enabled: false }, budgetUsd: 20, monthUsd: 50, usedTodaySec: 99999 }).blocked, 'off')
    assert.equal(callLimits({ prefs, budgetUsd: 20, monthUsd: 50, usedTodaySec: 99999 }).blocked, 'budget')
  })

  test('without the ledger (nulls): only the call length applies', () => {
    const limits = callLimits({ prefs: { ...prefs, sessionMinutes: 10 }, budgetUsd: 20, usedTodaySec: null, monthUsd: null })
    assert.equal(limits.blocked, null)
    assert.equal(limits.sessionSec, 600)
  })

  test('raw or missing prefs are normalized', () => {
    assert.equal(callLimits({}).sessionSec, 900)
    assert.equal(callLimits({ prefs: { dailyMinutes: 10, sessionMinutes: 15 } }).sessionSec, 600)
  })
})

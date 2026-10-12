import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIEFING_INSTRUCTIONS, briefingCost, briefingDigest, cleanBriefing, createLimiter, emptyDigest, generateBriefing, morningBriefing,
} from '../api/_briefing.js'
import { summaryFacts } from '../api/_reminders.js'

// Synthetic data only. No OpenAI call is ever made here: `generate` is a fake, and the one
// generateBriefing test stubs fetch.

const DAY = '2026-10-12' // a Monday
const at = (iso) => Date.parse(iso)

const fullFacts = () => ({
  date: DAY,
  weekday: 'Monday',
  time: '08:00',
  first: { name: 'zz-Dentist', start: 570, isClass: false },
  tasks: [{ text: 'zz-Dentist', time: '09:30' }, { text: 'zz-Essay', time: '' }],
  overdue: 2,
  classes: [{ name: 'ECON 1022', start: 870 }],
  workout: { name: 'Upper A', exercises: 5, minutes: 50 },
  birthdays: ['Sam Example’s birthday today'],
  catchUps: 1,
  rainChance: 70,
  food: { calories: 2100, protein: 150 },
  prayers: [
    { name: 'Fajr', time: '05:40' }, { name: 'Dhuhr', time: '13:05' }, { name: 'Asr', time: '16:30' },
    { name: 'Maghrib', time: '19:10' }, { name: 'Isha', time: '20:40' },
  ],
})

describe('briefingDigest', () => {
  test('one fact per line, in order', () => {
    assert.equal(briefingDigest(fullFacts()), [
      'Day: Monday, October 12',
      'Now: 8:00 AM',
      'First: zz-Dentist at 9:30 AM',
      'Tasks today (2): zz-Dentist at 9:30 AM; zz-Essay',
      'Overdue tasks: 2',
      'Classes: ECON 1022 at 2:30 PM',
      'Gym: Upper A day',
      'Birthdays: Sam Example’s birthday today',
      'Catch-ups due: 1',
      'Rain: 70% chance',
      'Food goal: 2100 kcal, 150 g protein',
      'Prayers still ahead: Dhuhr at 1:05 PM; Asr at 4:30 PM; Maghrib at 7:10 PM',
    ].join('\n'))
  })

  test('empty facts leave their lines out', () => {
    const facts = { ...fullFacts(), first: null, tasks: [], overdue: 0, classes: [], workout: null, birthdays: [], catchUps: 0, rainChance: null, food: null, prayers: [] }
    assert.equal(briefingDigest(facts), 'Day: Monday, October 12\nNow: 8:00 AM')
    assert.equal(briefingDigest(null), '')
    assert.equal(briefingDigest({ tasks: 'x', classes: 5, prayers: {} }), '')
  })

  test('at most 8 tasks, titles cut to 40 characters, 900 characters in all', () => {
    const long = 'zz-A very long task title that keeps going and going and going'
    const tasks = Array.from({ length: 12 }, (_, i) => ({ text: `${long} ${i}`, time: '' }))
    const digest = briefingDigest({ ...fullFacts(), tasks, birthdays: Array.from({ length: 10 }, () => 'x'.repeat(60)) })
    const line = digest.split('\n').find((row) => row.startsWith('Tasks today'))
    assert.match(line, /^Tasks today \(12\): /)
    assert.match(line, /; and 4 more$/)
    const names = line.replace(/^Tasks today \(12\): /, '').replace(/; and 4 more$/, '').split('; ')
    assert.equal(names.length, 8)
    for (const name of names) assert.ok(name.length <= 40, name)
    assert.ok(names[0].endsWith('…'))
    assert.ok(digest.length <= 900)
    // A digest over 900 drops whole lines from the end.
    const huge = briefingDigest({ ...fullFacts(), classes: Array.from({ length: 6 }, (_, i) => ({ name: `${'c'.repeat(45)}${i}`, start: 600 })), tasks })
    assert.ok(huge.length <= 900, String(huge.length))
    assert.ok(huge.startsWith('Day: Monday'))
    assert.ok(!huge.endsWith(';'))
  })

  test('rain only from 30%', () => {
    assert.match(briefingDigest({ ...fullFacts(), rainChance: 30 }), /Rain: 30% chance/)
    assert.doesNotMatch(briefingDigest({ ...fullFacts(), rainChance: 29 }), /Rain/)
    assert.doesNotMatch(briefingDigest({ ...fullFacts(), rainChance: null }), /Rain/)
  })

  test('prayers only after now, at most 3', () => {
    assert.match(briefingDigest({ ...fullFacts(), time: '17:00' }), /Prayers still ahead: Maghrib at 7:10 PM; Isha at 8:40 PM$/)
    assert.doesNotMatch(briefingDigest({ ...fullFacts(), time: '21:00' }), /Prayers/)
    assert.equal(briefingDigest(fullFacts()).split('\n').at(-1).split('; ').length, 3)
  })

  test('gym, food and people lines go when those areas are off', () => {
    const gym = {
      schedule: { versions: [{ id: 'v1', effectiveFrom: '2026-09-01', mode: 'weekly', weekly: Array(7).fill({ kind: 'routine', routineId: 'r1' }) }], shifts: [], skips: {}, overrides: {}, deload: { everyWeeks: 0 } },
      routines: [{ id: 'r1', name: 'zz-Upper', exercises: [{ id: 'x1', exerciseId: 'bench-press', sets: [{ reps: 8 }] }] }],
    }
    const settings = { timeZone: 'UTC', gym, food: { goals: { calories: 2000, protein: 120 } } }
    const input = { settings, tasks: [], friends: [{ id: 'f', name: 'Sam Example', birthday: '2000-10-12' }], classes: [], gymSessions: [] }
    const on = briefingDigest(summaryFacts(input, at(`${DAY}T08:00:00Z`)))
    assert.match(on, /^Gym: zz-Upper/m)
    assert.match(on, /^Food goal: 2000 kcal, 120 g protein$/m)
    assert.match(on, /^Birthdays: Sam Example’s birthday today$/m)
    const off = briefingDigest(summaryFacts({ ...input, settings: { ...settings, areas: { gym: false, food: false, people: false } } }, at(`${DAY}T08:00:00Z`)))
    assert.doesNotMatch(off, /Gym|Food|Birthdays|Catch-ups/)
  })

  test('task notes and details never reach the digest', () => {
    const input = { settings: { timeZone: 'UTC', displayName: 'zz-Name' }, tasks: [{ id: 'a', text: 'zz-Call', date: DAY, details: 'zz-secret detail', notes: 'zz-secret note' }], friends: [], classes: [] }
    const digest = briefingDigest(summaryFacts(input, at(`${DAY}T08:00:00Z`)))
    assert.match(digest, /zz-Call/)
    assert.doesNotMatch(digest, /secret|zz-Name/)
  })
})

describe('cleanBriefing', () => {
  const digest = briefingDigest(fullFacts())

  test('strips emoji, markdown, quotes and line breaks', () => {
    assert.equal(cleanBriefing('"**zz-Dentist** at 9:30 AM first 🦷,\nthen ECON at 2:30 PM. ☔️"', digest), 'zz-Dentist at 9:30 AM first, then ECON at 2:30 PM.')
    assert.equal(cleanBriefing('# A calm day ahead, `enjoy` it_', digest), 'A calm day ahead, enjoy it')
  })

  test('a long text is cut at its last sentence end within 180, else rejected', () => {
    const first = 'zz-Dentist at 9:30 AM comes first, so leave a little early this morning.'
    const second = ' Then ECON 1022 at 2:30 PM, and after that an easy evening with plenty of time to rest, read, cook and relax a while.'
    const text = `${first}${second} More words here.`
    assert.ok(`${first}${second}`.length > 180)
    assert.equal(cleanBriefing(text, digest), first)
    assert.equal(cleanBriefing('x'.repeat(200), digest), null)
    assert.equal(cleanBriefing(`${'word '.repeat(40)}end.`, digest), null) // its only sentence end is past 180
  })

  test('times must be ones the digest has', () => {
    assert.equal(cleanBriefing('zz-Dentist at 9:30 AM, then ECON 1022.', digest), 'zz-Dentist at 9:30 AM, then ECON 1022.')
    assert.equal(cleanBriefing('Start with zz-Dentist at 9:30am today.', digest), 'Start with zz-Dentist at 9:30am today.')
    assert.equal(cleanBriefing('Start with zz-Dentist at 10 AM today.', digest), null) // invented
    assert.equal(cleanBriefing('Start with zz-Dentist at 9:30 PM today.', digest), null)
    assert.equal(cleanBriefing('Start with zz-Dentist at 10:15 sharp today.', digest), null) // invented bare time
    assert.equal(cleanBriefing('Start with zz-Dentist at 9:30 sharp today.', digest), 'Start with zz-Dentist at 9:30 sharp today.')
  })

  test('percentages must be ones the digest has', () => {
    assert.equal(cleanBriefing('Rain is 70% likely, so take a jacket.', digest), 'Rain is 70% likely, so take a jacket.')
    assert.equal(cleanBriefing('Rain is 80% likely, so take a jacket.', digest), null)
  })

  test('the current time is never a fact to report (a gym line has no time)', () => {
    assert.match(digest, /^Now: 8:00 AM$/m)
    assert.equal(cleanBriefing('First up, Upper A at the gym at 8:00 AM.', digest), null)
  })

  test('counts must be ones the digest has', () => {
    assert.equal(cleanBriefing('zz-Dentist at 9:30 AM, and 2 tasks are overdue.', digest), 'zz-Dentist at 9:30 AM, and 2 tasks are overdue.')
    assert.equal(cleanBriefing('zz-Dentist at 9:30 AM, and 4 tasks are overdue.', digest), null)
    assert.equal(cleanBriefing('Aim for 2,100 kcal and 150 g protein today.', digest), 'Aim for 2,100 kcal and 150 g protein today.')
  })

  test('a digest with only the day and the time is empty', () => {
    assert.equal(emptyDigest('Day: Sunday, October 18\nNow: 8:00 AM'), true)
    assert.equal(emptyDigest(digest), false)
  })

  test('under 15 characters, or not text, is rejected', () => {
    assert.equal(cleanBriefing('Have a day.', digest), null)
    assert.equal(cleanBriefing('🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞🌞', digest), null)
    assert.equal(cleanBriefing(null, digest), null)
    assert.equal(cleanBriefing({ text: 'x' }, digest), null)
  })
})

test('briefingCost splits cached input', () => {
  assert.ok(Math.abs(briefingCost({ input: 1000, cached: 400, output: 200 }) - 0.00056) < 1e-12)
  assert.ok(Math.abs(briefingCost({ input: 1000, cached: 0, output: 0 }) - 0.00025) < 1e-12)
  assert.equal(briefingCost(null), 0)
  assert.equal(briefingCost({ input: 'x' }), 0)
})

test('briefingCost prices cache writes (GPT-5.6+ at 1.25× input)', () => {
  // 1,000 in, 900 of them written to the cache: 100 × 0.10 + 900 × 0.125 + 50 × 0.50 = 147.5 µ$.
  assert.ok(Math.abs(briefingCost({ input: 1000, cached: 0, writes: 900, output: 50 }, 'gpt-6-luna') - 0.000148) < 1e-12)
  // gpt-5-mini has no write charge.
  assert.ok(Math.abs(briefingCost({ input: 1000, cached: 0, writes: 900, output: 0 }) - 0.00025) < 1e-12)
})

test('generateBriefing reads cache writes from the usage', async () => {
  const realFetch = globalThis.fetch
  const realKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ text: 'A light day.' }) }] }],
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 1000 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const result = await generateBriefing('digest', { userId: 'u1' })
    assert.equal(result.text, 'A light day.')
    assert.deepEqual(result.usage, { input: 1200, cached: 100, writes: 1000, output: 30, reasoning: 10 })
  } finally {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = realKey
  }
})

test('the instructions are fixed text', () => {
  assert.ok(!BRIEFING_INSTRUCTIONS.includes('${'))
  assert.ok(BRIEFING_INSTRUCTIONS.length > 100)
})

describe('morningBriefing', () => {
  const env = {}
  const logs = []
  let originalLog
  let originalError
  beforeEach(() => {
    env.key = process.env.OPENAI_API_KEY
    env.kill = process.env.AI_BRIEFING
    process.env.OPENAI_API_KEY = 'test-key-not-real'
    delete process.env.AI_BRIEFING
    originalLog = console.log
    originalError = console.error
    logs.length = 0
    console.log = (line) => logs.push(line)
    console.error = () => {}
  })
  afterEach(() => {
    if (env.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = env.key
    if (env.kill === undefined) delete process.env.AI_BRIEFING
    else process.env.AI_BRIEFING = env.kill
    console.log = originalLog
    console.error = originalError
  })

  const NOW = at(`${DAY}T08:00:30Z`)
  const settingsOn = { timeZone: 'UTC', notifications: { dailySummaryAi: true } }
  const GOOD = 'zz-Dentist at 9:30 AM comes first, then ECON 1022 at 2:30 PM.'
  const fakes = (text = GOOD) => {
    const calls = { generate: [], save: [] }
    return {
      calls,
      generate: async (digest, options) => {
        calls.generate.push({ digest, options })
        return { text, usage: { input: 300, cached: 200, output: 120 }, ms: 900, model: 'test-model' }
      },
      save: async (supabase, userId, patch) => { calls.save.push({ userId, patch }) },
    }
  }
  const run = (options) => morningBriefing({ supabase: {}, userId: 'zz-user', settings: settingsOn, facts: fullFacts(), now: NOW, runStartedAt: NOW, ...options })

  test('writes, saves { date, text, at } and logs the cost', async () => {
    const fake = fakes()
    const result = await run({ generate: fake.generate, save: fake.save })
    assert.deepEqual(result, { text: GOOD, source: 'ai', reason: 'ok' })
    assert.equal(fake.calls.generate.length, 1)
    assert.equal(fake.calls.generate[0].digest, briefingDigest(fullFacts()))
    assert.deepEqual(fake.calls.generate[0].options, { userId: 'zz-user' })
    assert.deepEqual(fake.calls.save, [{ userId: 'zz-user', patch: { briefing: { date: DAY, text: GOOD, at: new Date(NOW).toISOString() } } }])
    const line = JSON.parse(logs.find((entry) => String(entry).includes('"briefing"')))
    assert.equal(line.event, 'briefing')
    assert.equal(line.source, 'ai')
    assert.equal(line.input, 300)
    assert.ok(line.costUsd > 0)
  })

  test('a stale saved note is replaced', async () => {
    const fake = fakes()
    const settings = { ...settingsOn, briefing: { date: '2026-10-11', text: 'zz-Yesterday’s words here.' } }
    const result = await run({ settings, generate: fake.generate, save: fake.save })
    assert.equal(result.source, 'ai')
    assert.equal(fake.calls.save[0].patch.briefing.date, DAY)
  })

  test('nothing planned: the template, without a call', async () => {
    const fake = fakes()
    const empty = { ...fullFacts(), first: null, tasks: [], overdue: 0, classes: [], workout: null, birthdays: [], catchUps: 0, rainChance: null, food: null, prayers: [] }
    assert.deepEqual(await run({ facts: empty, generate: fake.generate, save: fake.save }), { text: null, source: 'template', reason: 'empty' })
    assert.equal(fake.calls.generate.length, 0)
    assert.equal(fake.calls.save.length, 0)
  })

  test('already written today: the same words, no new call', async () => {
    const fake = fakes()
    const settings = { ...settingsOn, briefing: { date: DAY, text: 'zz-Saved words for today.', at: 'x' } }
    assert.deepEqual(await run({ settings, generate: fake.generate, save: fake.save }), { text: 'zz-Saved words for today.', source: 'cached', reason: 'cached' })
    assert.equal(fake.calls.generate.length, 0)
    assert.equal(fake.calls.save.length, 0)
  })

  test('a failed call or a rejected answer sends the template and marks the day as tried', async () => {
    const tried = { briefing: { date: DAY, text: '', at: new Date(NOW).toISOString() } }
    const saves = []
    const thrown = await run({ generate: async () => { throw new Error('timeout') }, save: async (supabase, userId, patch) => { saves.push(patch) } })
    assert.deepEqual(thrown, { text: null, source: 'template', reason: 'error' })
    assert.deepEqual(saves, [tried])
    const fake = fakes('zz-Dentist at 10 AM, then a nap.')
    assert.deepEqual(await run({ generate: fake.generate, save: fake.save }), { text: null, source: 'template', reason: 'rejected' })
    assert.deepEqual(fake.calls.save.map((call) => call.patch), [tried])
    // A failed marker save still sends the template.
    assert.equal((await run({ generate: fake.generate, save: async () => { throw new Error('db down') } })).reason, 'rejected')
  })

  test('tried today already (the push is being retried): the template, no new call', async () => {
    const fake = fakes()
    const settings = { ...settingsOn, briefing: { date: DAY, text: '', at: 'x' } }
    assert.deepEqual(await run({ settings, generate: fake.generate, save: fake.save }), { text: null, source: 'template', reason: 'tried' })
    assert.equal(fake.calls.generate.length, 0)
    assert.equal(fake.calls.save.length, 0)
  })

  test('over budget never marks the day as tried', async () => {
    const fake = fakes()
    await run({ runStartedAt: NOW - 25000, generate: fake.generate, save: fake.save })
    assert.equal(fake.calls.save.length, 0)
  })

  test('a failed save still sends the written text', async () => {
    const fake = fakes()
    const result = await run({ generate: fake.generate, save: async () => { throw new Error('db down') } })
    assert.deepEqual(result, { text: GOOD, source: 'ai', reason: 'ok' })
  })

  test('over the run’s budget: the template, without a call', async () => {
    const fake = fakes()
    assert.deepEqual(await run({ runStartedAt: NOW - 25000, generate: fake.generate, save: fake.save }), { text: null, source: 'template', reason: 'budget' })
    assert.equal(fake.calls.generate.length, 0)
  })

  test('off: the setting, no key or the kill switch', async () => {
    const fake = fakes()
    assert.equal((await run({ settings: { timeZone: 'UTC' }, generate: fake.generate })).source, 'off')
    assert.equal((await run({ settings: { notifications: { dailySummaryAi: true, dailySummary: false } }, generate: fake.generate })).source, 'off')
    process.env.AI_BRIEFING = 'off'
    assert.equal((await run({ generate: fake.generate })).source, 'off')
    delete process.env.AI_BRIEFING
    delete process.env.OPENAI_API_KEY
    assert.equal((await run({ generate: fake.generate })).source, 'off')
    assert.equal(fake.calls.generate.length, 0)
  })

  test('the limiter runs at most 4 at once', async () => {
    const limit = createLimiter(4)
    let active = 0
    let peak = 0
    const job = (value) => async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return value
    }
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => limit(job(i))))
    assert.deepEqual(results, [...Array(10).keys()])
    assert.equal(peak, 4)
    // A failing job doesn't block the queue.
    await assert.rejects(limit(async () => { throw new Error('boom') }), /boom/)
    assert.equal(await limit(async () => 'after'), 'after')
    // Through morningBriefing too.
    let running = 0
    let most = 0
    const generate = async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
      return { text: GOOD, usage: {}, ms: 1, model: 'test-model' }
    }
    const shared = createLimiter(4)
    const all = await Promise.all(Array.from({ length: 9 }, (_, i) => run({ userId: `zz-user-${i}`, generate, save: async () => {}, limit: shared })))
    assert.ok(all.every((result) => result.source === 'ai'))
    assert.equal(most, 4)
  })
})

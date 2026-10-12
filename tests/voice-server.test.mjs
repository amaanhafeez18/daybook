// api/_voice.js and api/_talk.js without the network: the realtime tools, the instructions (fixed for
// a day, so OpenAI can cache them), the context message, refs, the spoken yes check and the talk
// message. The operations end to end are in tests/voice-api.test.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ID, TODAY, buildTables, ctx } from './voice-fixture.mjs'
import * as sched from '../src/lib/gym/schedule.js'

const { TOOL_DEFS, UI_TOOLS, buildSnapshot } = await import('../api/assistant.js')
const voice = await import('../api/_voice.js')
const { TALK_ID_RE, normalizeTalk, talkHistoryText } = await import('../api/_talk.js')
const { VOICE_ONLY_TOOLS, VOICE_SERVER_TOOLS, VOICE_SHARED_TOOLS, assignRefs, buildVoiceContext, confirmRules, expandRefs, openingText, voiceDecision, voiceInstructions, voiceSessionConfig, voiceTools } = voice

console.error = () => {}

// What loadData() + loadFood() return for the fixture's rows.
function dataFrom(tables) {
  const t = structuredClone(tables)
  return {
    tasks: t.tasks,
    events: t.events,
    friends: t.friends,
    voice_notes: t.voice_notes,
    classes: t.classes,
    journal_entries: t.journal_entries,
    contact_logs: t.contact_logs,
    settings: t.settings[0].value,
    gym: { schedule: sched.emptySchedule(), routines: [], folders: [], exercises: [], exerciseMeta: {}, prefs: { unit: 'kg', distanceUnit: 'km', firstWeekday: 1, weeklyGoal: 3, defaultRest: 120, e1rmFormula: 'brzycki', previousSource: 'any', progression: true, bodyweightInVolume: true }, active: null },
    gymTablesMissing: false,
    gym_sessions: [],
    gymSessionsTruncated: false,
    body_weights: [],
    memories: t.assistant_memories.map(({ id, content, created_at }) => ({ id, content, created_at })),
    attachments: [],
    foodEntries: [],
    foodMissing: false,
  }
}
const fixtureData = (options) => dataFrom(buildTables(options))

describe('voiceTools', () => {
  const allOn = voiceTools({})
  const names = allOn.map((item) => item.name)

  test('23 tools with unique names: the shared ones as the text assistant defines them, then the voice-only ones', () => {
    assert.equal(allOn.length, 23)
    assert.equal(new Set(names).size, names.length)
    assert.equal(VOICE_SHARED_TOOLS.length, 19)
    assert.deepEqual(VOICE_SERVER_TOOLS, [...VOICE_SHARED_TOOLS, 'confirm_pending', 'undo_last'])
    for (const item of allOn) {
      assert.equal(item.type, 'function')
      assert.equal('strict' in item, false, `${item.name} must not carry strict`)
      const shared = TOOL_DEFS.find((def) => def.name === item.name)
      if (shared) {
        const { strict, ...rest } = shared
        assert.deepEqual(item, rest, `${item.name} is the text assistant's schema`)
      } else assert.ok(VOICE_ONLY_TOOLS.some((def) => def.name === item.name), `${item.name} is unknown`)
    }
    assert.deepEqual(names.slice(-4), ['confirm_pending', 'undo_last', 'ask_daybook', 'end_call'])
  })

  test('no UI tools, no deletes, and under 26k characters', () => {
    assert.ok(!names.some((name) => UI_TOOLS.includes(name)))
    assert.ok(!names.some((name) => name.startsWith('delete_') || name === 'weight_delete'))
    assert.ok(JSON.stringify(allOn).length < 26000, `${JSON.stringify(allOn).length} characters`)
  })

  test('areas that are off drop their tools', () => {
    const without = (areas) => voiceTools({ areas }).map((item) => item.name)
    assert.deepEqual(names.filter((name) => !without({ people: false }).includes(name)), ['person_history', 'create_friend', 'update_friend', 'log_contact'])
    assert.deepEqual(names.filter((name) => !without({ journal: false }).includes(name)), ['read_journal', 'write_journal'])
    assert.deepEqual(names.filter((name) => !without({ food: false }).includes(name)), ['food_day', 'food_log'])
    assert.deepEqual(names.filter((name) => !without({ gym: false }).includes(name)), ['gym_quick_log', 'gym_log_bodyweight'])
    assert.equal(without({ people: true, gym: true }).length, 23)
  })
})

describe('voiceInstructions', () => {
  const base = { displayName: 'Sam Lee', level: 'all', localDate: TODAY, timeZone: 'America/Toronto', areasOff: [] }

  test('the same day, user and level give the same text; it names the day and never the time', () => {
    const text = voiceInstructions(base)
    assert.equal(voiceInstructions({ ...base }), text)
    assert.match(text, /You're talking with Sam Lee\. Today is Sunday, October 11, 2026 \(America\/Toronto\)/)
    const header = text.slice(text.indexOf('About this call'))
    assert.doesNotMatch(header, /\d{1,2}:\d{2}/)
    const data = fixtureData()
    const at = (localTime) => voiceSessionConfig({ data, settings: data.settings, mode: 'open', intent: 'chat', displayName: 'Sam', level: 'all', ctx: { ...ctx, localTime } })
    assert.equal(at('07:01').instructions, at('23:59').instructions)
    assert.deepEqual(at('07:01').tools, at('23:59').tools)
  })

  test('levels differ only in their confirm rule', () => {
    const all = voiceInstructions(base)
    for (const level of ['changes', 'off']) {
      const other = voiceInstructions({ ...base, level })
      assert.notEqual(other, all)
      assert.equal(other.replace(confirmRules(level), confirmRules('all')), all)
    }
    assert.match(confirmRules('changes'), /Journal entries are always read back first/)
    assert.equal(confirmRules('nonsense'), confirmRules('all'))
    assert.ok(!voiceInstructions(base).includes('{CONFIRM_RULES}'))
  })

  test('areas that are off are named, and a missing name reads "the user"', () => {
    const text = voiceInstructions({ ...base, displayName: '', areasOff: ['gym', 'food'] })
    assert.match(text, /talking with the user\./)
    assert.match(text, /switched off the gym tracker and food tracking: don't offer those/)
  })
})

describe('voiceSessionConfig', () => {
  test('explicit model and voice, the names vocabulary, turn detection by mode and route', () => {
    const data = fixtureData({ settings: { voice: { voice: 'cedar' } } })
    const config = voiceSessionConfig({ data, settings: data.settings, mode: 'open', routeHint: 'headphones', intent: 'debrief', displayName: 'Sam', level: 'changes', ctx })
    assert.equal(config.type, 'realtime')
    assert.equal(config.model, voice.REALTIME_MODEL)
    assert.equal(config.audio.output.voice, 'cedar')
    assert.deepEqual(config.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false })
    assert.equal(config.audio.input.noise_reduction.type, 'near_field')
    assert.equal(config.audio.input.transcription.model, voice.REALTIME_TRANSCRIBE_MODEL)
    assert.match(config.audio.input.transcription.prompt, /Sara Khan, Omar Ali/)
    assert.ok(config.audio.input.transcription.prompt.length <= 800)
    assert.deepEqual(config.reasoning, { effort: 'low' })
    assert.deepEqual(config.truncation, { type: 'retention_ratio', retention_ratio: 0.8 })
    assert.ok(!JSON.stringify(config).includes('idle_timeout_ms'))
    const hold = voiceSessionConfig({ data, settings: data.settings, mode: 'hold', intent: 'chat', level: 'all', ctx })
    assert.equal(hold.audio.input.turn_detection, null)
    assert.equal(hold.audio.input.noise_reduction.type, 'far_field')
  })
})

describe('refs', () => {
  test('assignRefs gives each id the shortest unique prefix (at least 8 characters)', () => {
    const refs = assignRefs('t', ['3f9a2c1b-aaaa-1111', '3f9a2c1b-bbbb-2222', '12345678-9999-0000', '12345678-9999-0000'])
    assert.equal(refs.size, 3)
    assert.equal(refs.get('3f9a2c1b-aaaa-1111'), 't:3f9a2c1ba')
    assert.equal(refs.get('3f9a2c1b-bbbb-2222'), 't:3f9a2c1bb')
    assert.equal(refs.get('12345678-9999-0000'), 't:12345678')
  })

  test('expandRefs turns refs back into ids anywhere in the arguments; unknown or ambiguous refs are refused', () => {
    const data = fixtureData()
    const ref = assignRefs('t', data.tasks.map((task) => task.id)).get(ID.milk)
    const friend = assignRefs('f', data.friends.map((item) => item.id)).get(ID.omar)
    assert.deepEqual(expandRefs('update_task', { taskId: ref, done: true }, data), { taskId: ID.milk, done: true })
    assert.deepEqual(expandRefs('log_contact', { friendId: friend.toUpperCase(), note: 't: not a ref' }, data), { friendId: ID.omar, note: 't: not a ref' })
    assert.deepEqual(expandRefs('x', { list: [ref] }, data), { list: [ID.milk] })
    assert.throws(() => expandRefs('update_task', { taskId: 't:00000000' }, data), /Can't find that one/)
    const twins = { ...data, tasks: [{ id: 'abcdef12-0001' }, { id: 'abcdef12-0002' }] }
    assert.throws(() => expandRefs('update_task', { taskId: 't:abcdef12' }, twins), /Can't find that one/)
    assert.deepEqual(expandRefs('create_task', { text: 'Call Sara' }, data), { text: 'Call Sara' }, 'names and text are left alone')
  })
})

describe('buildVoiceContext', () => {
  const build = (data, extra = {}) => buildVoiceContext({ snapshot: buildSnapshot(data, ctx, 'sam'), data, history: [], ctx, displayName: 'Sam', limits: { sessionSec: 900, dailyLeftSec: 1500 }, ...extra })

  test('the day at a glance, with refs instead of ids, the same every time', () => {
    const data = fixtureData()
    const { text, chars } = build(data)
    assert.equal(chars, text.length)
    assert.equal(build(fixtureData()).text, text, 'deterministic')
    assert.match(text, /^Daybook context \(current; trust it over earlier messages\)\. Now: Sun Oct 11, 9:12 PM \(UTC\)\./)
    assert.match(text, /Dates: Sun Oct 11 today · Mon Oct 12 tomorrow · Tue Oct 13/)
    assert.match(text, /Tomorrow: 3:00 PM task Dentist appointment/)
    assert.match(text, /Open tasks \(overdue, today, tomorrow first\): t:9a8b7c6d Pay rent, Oct 9 \(overdue\) · t:3f9a2c1b Dentist appointment, tomorrow 3:00 PM · t:7c1e0d22 Buy milk/)
    assert.match(text, /People \(2\): f:aa11bb22 Sara Khan · f:cc33dd44 Omar Ali/)
    assert.match(text, /Birthdays soon: Sara Khan in 4 days \(Oct 15\)/)
    assert.match(text, /Journal: today none yet\. Recent: Sat okay\./)
    assert.match(text, /Remember: User likes short answers/)
    assert.match(text, /Call: up to 15 min \(25 min left today\)\./)
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/, 'no raw ids')
  })

  test('areas that are off are left out', () => {
    const { text } = build(fixtureData({ settings: { areas: { people: false, journal: false, food: false, gym: false } } }))
    assert.doesNotMatch(text, /People|Journal:|Food|Gym/)
  })

  test('the earlier chat, a waiting card and a continued call', () => {
    const now = new Date().toISOString()
    const talk = normalizeTalk({ id: 'talk_abcdefgh1', startedAt: now, seconds: 120, turns: [{ id: 'u1', r: 'u', t: 'Plan my evening' }, { id: 'a1', r: 'a', t: 'You have the gym at 7.' }] })
    const history = [
      { role: 'summary', content: 'They are training for a 10k.', createdAt: now },
      { role: 'assistant', content: '', createdAt: now, talk },
      { role: 'user', content: 'Add milk', createdAt: now },
      { role: 'assistant', content: 'Shall I?', createdAt: now, proposal: { id: 'p1', status: 'pending', createdAt: now, summary: 'Add task “Milk”', actions: [{ label: 'Add task “Milk”' }], staged: [] } },
    ]
    const { text } = build(fixtureData(), { history, continueTalk: talk })
    assert.match(text, /Earlier in chat: \(summary\) They are training for a 10k\. \| User: Add milk \| Daybook: Shall I\? \[Proposed changes/)
    assert.doesNotMatch(text, /Daybook: \[Voice chat/, 'the call being continued isn’t repeated as chat')
    assert.match(text, /Waiting for their yes: "Add task “Milk”"/)
    assert.match(text, /Earlier in this voice chat: \[Voice chat .*\nUser: Plan my evening\nDaybook: You have the gym at 7\./)
  })

  test('at most 9,000 characters: the earlier chat goes first, then memories, people and tasks are cut', () => {
    const data = fixtureData()
    const big = (n, make) => Array.from({ length: n }, (_, index) => make(index))
    data.tasks = big(80, (i) => ({ id: `${String(i).padStart(8, '0')}-task-0000`, text: `Task number ${i} with a fairly long title to fill some space here`, date: '', time: '', done: false, archived: false }))
    data.events = big(30, (i) => ({ id: `ev${i}`, title: `Event number ${i} with a long title`, date: i % 2 ? TODAY : '2026-10-12', time: `${String(8 + (i % 12)).padStart(2, '0')}:00` }))
    data.friends = big(200, (i) => ({ id: `${String(i).padStart(8, '0')}-friend-0000`, name: `Person ${String(i).padStart(3, '0')} Quite-Long-Surname-Example` }))
    data.memories = big(40, (i) => ({ id: `m${i}`, content: `A memorable fact number ${i} that goes on for a while to take room`.repeat(2) }))
    const now = new Date().toISOString()
    const talk = normalizeTalk({ id: 'talk_abcdefgh1', startedAt: now, seconds: 600, turns: big(30, (i) => ({ id: `t${i}`, r: i % 2 ? 'a' : 'u', t: `Something said in the call number ${i} `.repeat(3) })) })
    const history = [{ role: 'assistant', content: '', createdAt: now, talk }, ...big(6, (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i} `.repeat(40), createdAt: now }))]
    const textAt = (maxChars) => buildVoiceContext({ snapshot: buildSnapshot(data, ctx, 'sam'), data, history, ctx, continueTalk: talk, maxChars }).text
    const shape = (maxChars) => {
      const text = textAt(maxChars)
      return {
        length: text.length,
        chat: /Earlier in chat/.test(text),
        memories: /Remember: (.*)/.exec(text)[1].split(' · ').length,
        people: /People \(200\): (.*)/.exec(text)[1].split(' · ').length - 1,
        tasks: 80 - Number(/tomorrow first; (\d+) more/.exec(text)[1]),
      }
    }
    const full = shape(100000)
    assert.deepEqual({ ...full, length: 0 }, { length: 0, chat: true, memories: 12, people: 60, tasks: 12 })
    assert.ok(full.length > 9000, 'this account is over the cap')
    const capped = shape(9000)
    assert.ok(capped.length <= 9000)
    assert.deepEqual({ ...capped, length: 0 }, { length: 0, chat: false, memories: 12, people: 60, tasks: 12 }, 'the earlier chat goes first')
    assert.deepEqual({ ...shape(capped.length - 1), length: 0 }, { length: 0, chat: false, memories: 6, people: 60, tasks: 12 })
    assert.deepEqual({ ...shape(capped.length - 1000), length: 0 }, { length: 0, chat: false, memories: 6, people: 30, tasks: 12 })
    const last = shape(capped.length - 2700)
    assert.equal(last.tasks, 6)
    assert.ok(textAt(3000).length <= 3000, 'always within the cap')
  })
})

describe('openingText', () => {
  test('a greeting by name, a debrief question, or picking a paused call back up', () => {
    assert.equal(openingText({ intent: 'chat', displayName: 'Sam Lee', hour: 20 }), 'Voice chat just opened. Say one short greeting to Sam that fits the time of day (evening): six words or fewer in total, no second sentence and no question. Then stop and listen.')
    assert.match(openingText({ intent: 'debrief' }), /talk about their day\. Ask how it went/)
    assert.match(openingText({ intent: 'journal', displayName: 'Sam' }), /talk about their day/)
    assert.match(openingText({ continued: true, reason: 'background' }), /paused: they left the app/)
    assert.match(openingText({}), /greeting to them/)
  })
})

describe('voiceDecision', () => {
  const cases = [
    ['yeah go for it', 'yes'], ['yes please add Omar', null], ['yes please add it', 'yes'], ['yes but make it Thursday', null], ['okay.', 'yes'],
    ['no thanks', 'no'], ['', null], ['wait, actually', null], ['yes at 5', null], ['yes at five', null], ['sounds good to me', 'yes'],
    ['sure, but move it', null], ['perfect save it', 'yes'], ['what time was that again', null], [undefined, null],
    ['yes yes yes yes yes yes yes yes yes yes yes yes yes', null],
    ['yes, that one', 'yes'], ['yes at one', null],
  ]
  for (const [text, expected] of cases) test(`${JSON.stringify(text)} → ${expected}`, () => assert.equal(voiceDecision(text), expected))

  test('a longer yes may repeat the card’s own words, nothing else', () => {
    const card = { summary: 'Add Omar Khan as a friend', actions: [{ label: 'Add “Omar Khan” as a friend' }] }
    const known = voice.cardWords(card)
    assert.equal(voiceDecision('yes please add Omar', { cardWords: known }), 'yes')
    assert.equal(voiceDecision('Yes please add Omar', { cardWords: known }), 'yes')
    assert.equal(voiceDecision('yes add Omar Khan', { cardWords: known }), 'yes')
    assert.equal(voiceDecision('yes add Sara', { cardWords: known }), null)
  })

  test('new instructions and corrections are not a yes', () => {
    const known = voice.cardWords({ summary: 'Move “Dentist” to Thursday', actions: [{ label: 'Move “Dentist” to Thursday' }] })
    for (const text of ['go with friday', 'right after lunch', 'okay remind me tonight', 'please delete the gym one', 'do the gym one', 'save it under work']) {
      assert.equal(voiceDecision(text), null, text)
      assert.equal(voiceDecision(text, { cardWords: known }), null, text)
    }
  })

  test('undo words', () => {
    for (const text of ['undo that', 'take it back please', 'scratch that', 'never mind', 'nevermind', 'remove it']) assert.match(text, voice.UNDO_RE)
    for (const text of ['add a reminder', 'what did I do today']) assert.doesNotMatch(text, voice.UNDO_RE)
  })
})

describe('talk messages (api/_talk.js)', () => {
  test('normalizeTalk bounds everything and drops the oldest turns first', () => {
    assert.equal(normalizeTalk({ id: 'bad' }), null)
    assert.equal(normalizeTalk(null), null)
    assert.ok(TALK_ID_RE.test('talk_abc12345'))
    assert.ok(!TALK_ID_RE.test('talk_ABC12345'))
    const many = Array.from({ length: 170 }, (_, index) => ({ id: `i${index}`, r: index % 2 ? 'a' : 'u', t: `turn ${index}` }))
    const talk = normalizeTalk({ id: 'talk_abc12345', turns: [...many, { r: 'x', t: 'bad role' }, { r: 'u', t: '   ' }], seconds: -5, usd: 'x', end: 'nope', mode: 'hold', intent: 'debrief', segments: 0 })
    assert.equal(talk.turns.length, 150)
    assert.equal(talk.trimmed, 20)
    assert.equal(talk.turns[0].t, 'turn 20')
    assert.equal(talk.seconds, 0)
    assert.equal(talk.usd, 0)
    assert.equal(talk.end, null)
    assert.equal(talk.segments, 1)
    assert.equal(talk.mode, 'hold')
    assert.equal(talk.intent, 'debrief')
    const long = normalizeTalk({ id: 'talk_abc12345', turns: Array.from({ length: 40 }, (_, index) => ({ r: 'u', t: `${index}`.padEnd(1600, 'x') })) })
    assert.ok(long.turns.every((turn) => turn.t.length <= 1500))
    assert.ok(long.turns.reduce((sum, turn) => sum + turn.t.length, 0) <= 30000)
    assert.equal(long.trimmed + long.turns.length, 40)
  })

  test('talkHistoryText: a header in the user’s zone, the turns, and the start and end of a long call', () => {
    const talk = { id: 'talk_abc12345', startedAt: '2026-10-12T01:12:00Z', endedAt: '2026-10-12T01:23:00Z', seconds: 660, turns: [{ r: 'u', t: 'Add call mom' }, { r: 't', t: 'typed this' }, { r: 'a', t: 'Done.' }] }
    assert.equal(talkHistoryText(talk, { timeZone: 'America/Toronto' }), '[Voice chat Sun Oct 11, 9:12–9:23 PM, 11 min]\nUser: Add call mom\nUser (typed): typed this\nDaybook: Done.')
    assert.match(talkHistoryText(talk, { timeZone: 'Not/AZone' }), /^\[Voice chat Mon Oct 12, 1:12–1:23 AM, 11 min\]/)
    const long = { ...talk, turns: Array.from({ length: 60 }, (_, index) => ({ r: 'u', t: `${'word '.repeat(20)}${index}` })) }
    const text = talkHistoryText(long, { timeZone: 'UTC' })
    assert.ok(text.length < 3200)
    assert.match(text, / … /)
    assert.match(text, /59$/)
  })
})

// The voice chat's "brain" fixes: answering a card that was already tapped, spoken yeses, the gym
// tool's flat entries, numbers as digits in Daybook's captions, and the one read-back after a change.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, createTranscript, lastAssistantWords, orderedTurns, seedTurns, spokenNumbersToDigits, storedTurns } from '../src/lib/voice/transcript.js'
import { skipFollowUp, tapNote } from '../src/lib/voice/policy.js'

const voice = await import('../api/_voice.js')
const { cardWords, voiceDecision, voiceInstructions, voiceWorkoutArgs, workoutReadBack } = voice

describe('spoken yeses to a card from an earlier turn', () => {
  const card = cardWords({ summary: 'Log 8 items for breakfast · 2,311 kcal', actions: [{ label: 'Log breakfast: Scrambled eggs, Whole wheat bread, Milk tea' }] })
  const yes = ['yes confirm add', 'Yes, confirm, add.', 'save it', 'yeah log it', 'log it', 'Log it.', 'add it', 'add that', 'store it', 'put it in', 'That sounds good.',
    'looks good', 'Yes, log those.', 'yes go ahead and save it', 'yes add that to my food tracker', 'Um, yes.', 'Oh yeah, save it.', 'Uh, log it please.', 'Hmm okay.']
  for (const text of yes) test(`${JSON.stringify(text)} is a yes`, () => assert.equal(voiceDecision(text, { cardWords: card }), 'yes'))

  const not = ['add eggs', 'log more', 'add', 'log', 'um', 'log it at 5', 'yes but make it 2', 'add it for dinner', 'that is wrong', 'well actually no', 'save it under work']
  for (const text of not) test(`${JSON.stringify(text)} is not a plain yes`, () => assert.equal(voiceDecision(text, { cardWords: card }), null))

  test('a filler before a no is still a no', () => assert.equal(voiceDecision('um no'), 'no'))
})

describe('instructions', () => {
  const text = voiceInstructions({ displayName: 'Sam', level: 'all', localDate: '2026-10-11', timeZone: 'UTC' })
  test('numbers as digits, a tapped card is settled, one read-back after a change, gym sets logged directly', () => {
    assert.match(text, /Write every number as digits/)
    assert.match(text, /Say calories, not kilocalories/)
    assert.match(text, /tapped Save or No on it, it's settled: don't call confirm_pending/)
    assert.match(text, /Don't read it back before the call: read it back once, from the result/)
    assert.match(text, /call gym_log_workout once with every exercise/)
    assert.doesNotMatch(text, /workouts with sets and weights/)
  })
})

describe('gym_log_workout from voice', () => {
  test('flat entries become set groups; the same exercise twice in a row is one exercise', () => {
    const args = voiceWorkoutArgs({ date: '2026-10-11', routine: 'Legs', exercises: [
      { name: 'Squats', sets: 3, reps: 10, weight: 135 },
      { name: 'squats', sets: 1, reps: 6, weight: 155 },
      { name: 'plank', sets: 2, minutes: 1 },
      { name: '', sets: 3 },
      { name: 'pull ups', sets: 0, reps: 8 },
    ] })
    assert.deepEqual(args.exercises, [
      { name: 'Squats', sets: [{ count: 3, reps: 10, weight: 135 }, { count: 1, reps: 6, weight: 155 }] },
      { name: 'plank', sets: [{ count: 2, duration_sec: 60 }] },
      { name: 'pull ups', sets: [{ count: 1, reps: 8 }] },
    ])
    assert.equal(args.routine, 'Legs')
    assert.equal(workoutReadBack(args, 'lb'), 'Squats 3 by 10 at 135 lb, then 1 set of 6 at 155, plank 2 by 1 min, pull ups 1 set of 8')
  })

  test('the shared nested shape passes through, with a count sent as "sets" fixed', () => {
    const args = voiceWorkoutArgs({ date: '2026-10-11', exercises: [{ name: 'Bench Press (Barbell)', sets: [{ sets: 3, reps: 8, weight: 80 }, { reps: 6, weight: 85, count: 2 }] }] })
    assert.deepEqual(args.exercises[0].sets, [{ reps: 8, weight: 80, count: 3 }, { reps: 6, weight: 85, count: 2 }])
  })
})

describe('numbers in Daybook’s captions', () => {
  const cases = [
    ['Eight items, about two thousand three hundred eleven calories. Save it?', 'Eight items, about 2,311 calories. Save it?'],
    ['Two slices of toast and one egg, one sec.', 'Two slices of toast and one egg, one sec.'],
    ['That is twenty-five minutes, or forty five.', 'That is 25 minutes, or 45.'],
    ['About fifteen hundred calories.', 'About 1,500 calories.'],
    ['A hundred grams of rice.', '100 grams of rice.'],
    ['Squats at one thirty-five pounds for three sets of ten.', 'Squats at 135 pounds for three sets of ten.'],
    ['Meet at five thirty PM tomorrow.', 'Meet at 5:30 PM tomorrow.'],
    ['at five thirty', 'at five thirty'],
    ['seven oh five', '7:05'],
    ['In twenty twenty-six.', 'In 2026.'],
    ['one point five liters', '1.5 liters'],
    ['one two three four five', 'one two three four five'],
    ['twenty and thirty', '20 and 30'],
    ['Someone said hundred', 'Someone said hundred'],
    ['Already 2,311 / 2,000 kcal', 'Already 2,311 / 2,000 kcal'],
    // Ordinals and pairs stay as said (never "30 first" or "5050").
    ['Friday the thirty first.', 'Friday the thirty first.'],
    ['the twenty second at noon', 'the twenty second at noon'],
    ['a thirty second plank', 'a thirty second plank'],
    ['one hundred and first', 'one hundred and first'],
    ['fifty fifty', 'fifty fifty'],
    ['Back in nineteen ninety.', 'Back in 1990.'],
  ]
  for (const [said, shown] of cases) test(`${JSON.stringify(said)} → ${JSON.stringify(shown)}`, () => assert.equal(spokenNumbersToDigits(said), shown))

  test('a caption still arriving keeps a number at its end as heard', () => {
    assert.equal(spokenNumbersToDigits('about two thousand three', { partial: true }), 'about two thousand three')
    assert.equal(spokenNumbersToDigits('about two thousand three hundred eleven calories', { partial: true }), 'about 2,311 calories')
  })

  test('Daybook’s turns show and save digits; user turns and the echo check keep the words', () => {
    const state = createTranscript()
    const events = [
      { type: 'input_audio_buffer.committed', item_id: 'u1', previous_item_id: null },
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'add one hundred calories' },
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: 'That makes two thousand three hundred eleven calories. Save it?' },
      { type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } },
    ]
    for (const event of events) applyEvent(state, event)
    const turns = orderedTurns(state)
    assert.equal(turns[0].text, 'add one hundred calories')
    assert.equal(turns[1].text, 'That makes 2,311 calories. Save it?')
    assert.equal(storedTurns(turns).turns[1].t, 'That makes 2,311 calories. Save it?')
    assert.deepEqual(lastAssistantWords(state, 3), ['calories.', 'Save', 'it?'])
    assert.ok(lastAssistantWords(state, 30).includes('thousand'), 'the echo check compares the words as spoken')
    const seeded = seedTurns(createTranscript(), [{ id: 'x', r: 'a', t: 'About fifteen hundred calories.' }])
    assert.equal(orderedTurns(seeded)[0].text, 'About 1,500 calories.')
  })
})

describe('after a tool batch', () => {
  const staged = JSON.stringify({ ok: true, staged: true, waiting: 'Log 4 items · 490 kcal', note: 'NOT saved yet.' })
  test('no second read-back when every change was staged cleanly and Daybook already asked', () => {
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: staged }], said: 'I added a miscellaneous item, about 590 calories. Save it?' }), true)
    assert.equal(skipFollowUp({ calls: [{ name: 'create_task', output: staged }], said: 'Should I add that for tomorrow' }), true)
  })
  test('otherwise Daybook answers from the result', () => {
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: staged }], said: 'Got it, let me adjust that.' }), false, 'only a preamble')
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: staged }], said: 'Got it, let me add that breakfast entry.' }), false, 'a preamble that says "add that"')
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: staged }], said: 'I added a miscellaneous item, bringing it to 2,311 calories. Save it.' }), true)
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: JSON.stringify({ ok: true, staged: true, warning: 'Looks heavy' }) }], said: 'Save it?' }), false, 'a warning to say')
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: JSON.stringify({ ok: false, message: 'No.' }) }], said: 'Save it?' }), false)
    assert.equal(skipFollowUp({ calls: [{ name: 'food_log', output: staged }, { name: 'search', output: JSON.stringify({ ok: true }) }], said: 'Save it?' }), false, 'a lookup to read')
    assert.equal(skipFollowUp({ calls: [{ name: 'confirm_pending', output: JSON.stringify({ ok: true, staged: true }) }], said: 'Save it?' }), false)
    assert.equal(skipFollowUp({ calls: [], said: 'Save it?' }), false)
  })
})

describe('the note after a tap', () => {
  test('Save: settled, never confirm_pending, one short line', () => {
    const note = tapNote({ decision: 'yes', status: 'done', what: 'Logged 8 items (Scrambled eggs, …) ~ 2,311 kcal' })
    assert.match(note, /tapped Save on the card, so it's saved now: Logged 8 items/)
    assert.match(note, /don't call confirm_pending/)
    assert.match(note, /one short sentence/)
  })
  test('No, a failure, a partial save, and No on something already saved', () => {
    assert.match(tapNote({ decision: 'no', status: 'cancelled' }), /nothing was saved\..*don't call confirm_pending/)
    assert.match(tapNote({ decision: 'yes', status: 'failed', said: 'It waited too long' }), /didn't save: It waited too long/)
    assert.match(tapNote({ decision: 'yes', status: 'partial', said: 'One failed' }), /Only some of it saved/)
    assert.match(tapNote({ decision: 'no', status: 'done', what: 'Added Call mom' }), /already saved: Added Call mom.*offer to undo/)
  })
  test('a chip that ends in a full stop gets no second one', () => {
    const note = tapNote({ decision: 'yes', status: 'done', what: 'Done ✓ Today: 780 / 2,000 kcal (1,220 left).' })
    assert.match(note, /\(1,220 left\)\. Nothing is waiting/)
    assert.doesNotMatch(note, /\.\./)
  })
})

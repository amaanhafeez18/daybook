import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ESTIMATE_SCHEMA, ESTIMATE_SCHEMA_NAME, buildContent, buildInstructions, estimatePlan, lockedCaloriesFromText, regionFromTimeZone, toClientItems, transcriptionVocabulary, barcodeFromReply, favoritesForPrompt,
} from '../api/_food-estimate.js'
import { fastestEffort, filePart, httpError, imagePart, modelFromEnv, responsesJson, textPart } from '../api/_openai.js'

const ITEM_KEYS = ['name', 'brand', 'amount', 'unit', 'grams', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg', 'extra', 'confidence', 'assumptions', 'locked', 'options', 'mealHint']
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='

// A model item with every field present, as strict mode returns it.
function rawItem(overrides = {}) {
  return {
    name: 'Egg', brand: null, quantity: 2, unit: 'large', grams: 100,
    calories: 143, protein_g: 12.6, carbs_g: 0.8, fat_g: 9.6, fiber_g: 0, sugar_g: 0.4, sodium_mg: 142,
    alcohol_g: null, caffeine_mg: null, confidence: 0.85, assumptions: ['Cooked without oil'], user_specified: [],
    options: [{ label: 'Fried in 1 tsp oil', calories: 183, protein_g: 12.6, carbs_g: 0.8, fat_g: 14.1 }], meal_hint: null,
    ...overrides,
  }
}

// ---- schema ---------------------------------------------------------------------------------------

describe('estimate schema', () => {
  const UNSUPPORTED = ['allOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'default', '$ref']
  const types = (node) => (Array.isArray(node.type) ? node.type : [node.type])

  function walk(node, path) {
    assert.ok(node && typeof node === 'object', `${path}: schema node`)
    for (const key of UNSUPPORTED) assert.ok(!(key in node), `${path}: unsupported keyword ${key}`)
    if (types(node).includes('object')) {
      assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`)
      const keys = Object.keys(node.properties || {})
      assert.ok(keys.length > 0, `${path}: object has properties`)
      assert.deepEqual([...node.required].sort(), [...keys].sort(), `${path}: every property required`)
      for (const key of keys) walk(node.properties[key], `${path}.${key}`)
    }
    if (types(node).includes('array')) walk(node.items, `${path}[]`)
    if (node.enum && types(node).includes('null')) assert.ok(node.enum.includes(null), `${path}: nullable enum lists null`)
  }

  test('is strict-mode valid everywhere', () => {
    assert.equal(ESTIMATE_SCHEMA.type, 'object')
    walk(ESTIMATE_SCHEMA, 'root')
  })

  test('has the research §4 shape', () => {
    assert.deepEqual(Object.keys(ESTIMATE_SCHEMA.properties), ['items', 'barcode', 'clarify', 'not_food'])
    const item = ESTIMATE_SCHEMA.properties.items.items
    for (const key of ['name', 'brand', 'quantity', 'unit', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'alcohol_g', 'caffeine_mg', 'confidence', 'assumptions', 'user_specified', 'options', 'meal_hint', 'basis', 'saved_food_id']) {
      assert.ok(key in item.properties, key)
    }
    assert.equal(item.properties.assumptions.maxItems, 3)
    assert.equal(item.properties.options.maxItems, 3)
    assert.deepEqual(item.properties.brand.type, ['string', 'null'])
    assert.equal(item.properties.calories.type, 'number')
  })

  test('has a valid format name', () => {
    assert.match(ESTIMATE_SCHEMA_NAME, /^[\w-]{1,64}$/)
  })
})

// ---- locked calories ------------------------------------------------------------------------------

describe('lockedCaloriesFromText', () => {
  test('finds calorie numbers the user typed', () => {
    assert.deepEqual(lockedCaloriesFromText('300 calories of nuts'), [300])
    assert.deepEqual(lockedCaloriesFromText('a 250 kcal bar'), [250])
    assert.deepEqual(lockedCaloriesFromText('200 cal'), [200])
    assert.deepEqual(lockedCaloriesFromText('200cal'), [200])
    assert.deepEqual(lockedCaloriesFromText('a 250-calorie bar and 1,200 Calories of pizza'), [250, 1200])
    assert.deepEqual(lockedCaloriesFromText('protein bar, calories: 180'), [180])
    assert.deepEqual(lockedCaloriesFromText('300 cal 2 eggs'), [300])
  })

  test('returns [] when there are none', () => {
    assert.deepEqual(lockedCaloriesFromText('two bread two eggs'), [])
    assert.deepEqual(lockedCaloriesFromText('2 calzones'), [])
    assert.deepEqual(lockedCaloriesFromText('a 500 kJ snack'), [])
    assert.deepEqual(lockedCaloriesFromText(''), [])
    assert.deepEqual(lockedCaloriesFromText(undefined), [])
    assert.deepEqual(lockedCaloriesFromText({ text: '300 calories' }), [])
  })
})

// ---- post-processing ------------------------------------------------------------------------------

describe('toClientItems', () => {
  test('maps the model reply to EstimateItem (camelCase)', () => {
    const [item] = toClientItems({ items: [rawItem({ caffeine_mg: 12.4, meal_hint: 'breakfast' })], clarify: null, not_food: false }, 'two eggs')
    for (const key of ITEM_KEYS) assert.ok(key in item, `missing ${key}`)
    assert.equal(item.name, 'Egg')
    assert.equal(item.amount, 2)
    assert.equal(item.unit, 'large')
    assert.equal(item.grams, 100)
    assert.equal(item.proteinG, 12.6)
    assert.equal(item.sodiumMg, 142)
    assert.deepEqual(item.extra, { alcoholG: null, caffeineMg: 12, satFatG: null })
    assert.equal(item.mealHint, 'breakfast')
    assert.deepEqual(item.assumptions, ['Cooked without oil'])
    assert.deepEqual(item.locked, [])
    assert.deepEqual(item.options, [{ label: 'Fried in 1 tsp oil', calories: 183, proteinG: 12.6, carbsG: 0.8, fatG: 14.1 }])
    assert.ok(Math.abs(item.calories - 143) <= 2)
  })

  test('accepts the items array directly', () => {
    assert.equal(toClientItems([rawItem()], '').length, 1)
  })

  test('clamps and rounds', () => {
    const [item] = toClientItems([rawItem({
      name: 'Huge pasta', quantity: 1, unit: 'bowl', grams: 812.345,
      calories: 9000, protein_g: 0, carbs_g: 1250, fat_g: -5, fiber_g: null, sugar_g: null, sodium_mg: 1234.6, confidence: 7,
      assumptions: ['a', 'b', 'c', 'd'], options: [],
    })], '')
    assert.ok(item.calories <= 5000 && item.calories >= 0, `calories ${item.calories}`)
    assert.equal(item.calories, Math.round(item.calories))
    assert.equal(item.fatG, 0)
    assert.equal(item.grams, 812.3)
    assert.equal(item.sodiumMg, 1235)
    assert.ok(item.confidence <= 1)
    assert.equal(item.assumptions.length, 3)
    for (const key of ['proteinG', 'carbsG', 'fatG']) assert.ok(item[key] === null || item[key] >= 0, key)
  })

  test('keeps the user’s locked calories even when the macros disagree', () => {
    const [nuts] = toClientItems([rawItem({ name: 'Mixed nuts', quantity: 50, unit: 'g', grams: 50, calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1, user_specified: ['calories'], options: [] })], '300 calories of nuts')
    assert.equal(nuts.calories, 300)
    assert.ok(nuts.locked.includes('calories'))
  })

  test('locks a typed number the model missed (one food, one number)', () => {
    const [nuts] = toClientItems([rawItem({ name: 'Mixed nuts', calories: 280, protein_g: 9.8, carbs_g: 10.4, fat_g: 24.6, fiber_g: 3.5, user_specified: [], options: [] })], '300 calories of nuts')
    assert.equal(nuts.calories, 300)
    assert.deepEqual(nuts.locked, ['calories'])
  })

  test('drops a calorie lock the user never typed, keeps per-piece totals', () => {
    const items = toClientItems([
      rawItem({ name: 'Protein bar', quantity: 1, unit: 'bar', calories: 250, protein_g: 20, carbs_g: 25, fat_g: 8, user_specified: ['calories'], options: [] }),
      rawItem({ user_specified: ['calories', 'quantity'] }),
    ], 'a 250 kcal bar and 2 eggs')
    assert.equal(items[0].calories, 250)
    assert.ok(items[0].locked.includes('calories'))
    assert.ok(!items[1].locked.includes('calories'))
    assert.ok(items[1].locked.includes('amount'))

    const [bars] = toClientItems([rawItem({ name: 'Granola bar', quantity: 2, unit: 'bar', calories: 400, protein_g: 8, carbs_g: 60, fat_g: 14, user_specified: ['calories', 'quantity'], options: [] })], '2 bars, 200 cal each')
    assert.equal(bars.calories, 400)
    assert.ok(bars.locked.includes('calories'))
  })

  test('a stated number that isn’t the item’s total leaves the estimate alone', () => {
    const pizza = (overrides) => rawItem({ name: 'Pizza', quantity: 2, unit: 'slice', grams: 200, calories: 300, protein_g: 12, carbs_g: 36, fat_g: 12, sodium_mg: 600, options: [], ...overrides })
    // "half a 400 cal pizza": 0.5 × 400 = the model's 200, kept and locked.
    const [half] = toClientItems([pizza({ quantity: 0.5, unit: 'pizza', calories: 200, protein_g: 8, carbs_g: 24, fat_g: 8 })], 'half a 400 cal pizza')
    assert.equal(half.calories, 200)
    assert.ok(half.locked.includes('calories'))
    // "2 slices of a 1200 calorie pizza": 1200 is the whole pizza, not the 2 slices.
    const [slices] = toClientItems([pizza({ user_specified: ['calories'] })], '2 slices of a 1200 calorie pizza')
    assert.equal(slices.calories, 300)
    assert.ok(!slices.locked.includes('calories'))
    // A number about something else entirely.
    const [banana] = toClientItems([rawItem({ name: 'Banana', quantity: 1, unit: 'medium', grams: 118, calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, fiber_g: 3.1, options: [] })], 'banana, I burned 500 calories today')
    assert.equal(banana.calories, 105)
    assert.deepEqual(banana.locked, [])
  })

  test('per-piece numbers become the item total, with the nutrients scaled to match', () => {
    // "2 eggs, 70 cal each": the model said 143, the user's own total is 140.
    const [eggs] = toClientItems([rawItem({ options: [] })], '2 eggs, 70 cal each')
    assert.equal(eggs.calories, 140)
    assert.ok(eggs.locked.includes('calories'))
    assert.ok(Math.abs(eggs.fatG - 9.4) < 0.05, `fat ${eggs.fatG}`)
    // The nuts case: 280 → the typed 300, weight and macros follow.
    const [nuts] = toClientItems([rawItem({ name: 'Mixed nuts', quantity: 1, unit: 'handful', grams: 47, calories: 280, protein_g: 9.8, carbs_g: 10.4, fat_g: 24.6, fiber_g: 3.5, options: [] })], '300 calories of nuts')
    assert.equal(nuts.calories, 300)
    assert.equal(nuts.grams, 50.4)
    assert.equal(nuts.fatG, 26.4)
    // A weight the user gave doesn't move.
    const [fixed] = toClientItems([rawItem({ name: 'Mixed nuts', quantity: 50, unit: 'g', grams: 50, calories: 280, protein_g: 9.8, carbs_g: 10.4, fat_g: 24.6, user_specified: ['grams'], options: [] })], '50 g of nuts, 300 calories')
    assert.equal(fixed.calories, 300)
    assert.equal(fixed.grams, 50)
  })

  test('never throws on malformed replies', () => {
    assert.deepEqual(toClientItems(null), [])
    assert.deepEqual(toClientItems(undefined, undefined), [])
    assert.deepEqual(toClientItems({ items: 'nope' }), [])
    assert.deepEqual(toClientItems([null, 5, 'x', [], { name: '' }]), [])
    const [item] = toClientItems([{ name: 'Tea', calories: '45', user_specified: 'calories', options: [{ label: '' }, null, { label: 'Black', calories: 2 }], assumptions: [1, null, 'Milk'], meal_hint: 'Brunch', confidence: 'high' }])
    assert.equal(item.name, 'Tea')
    assert.equal(item.calories, 45)
    assert.deepEqual(item.locked, [])
    assert.deepEqual(item.options, [{ label: 'Black', calories: 2, proteinG: 0, carbsG: 0, fatG: 0 }])
    assert.deepEqual(item.assumptions, ['1', 'Milk'])
    assert.equal(item.mealHint, null)
    assert.equal(item.confidence, 0.5)
    const [odd] = toClientItems([rawItem({ user_specified: ['constructor', '__proto__', 'quantity', 'quantity', 'protein_g'] })])
    assert.deepEqual(odd.locked, ['amount', 'proteinG'])
  })

  test('caps the item count', () => {
    assert.equal(toClientItems(Array.from({ length: 40 }, () => rawItem())).length, 20)
  })
})

// ---- prompt ---------------------------------------------------------------------------------------

describe('buildContent', () => {
  const favorites = [
    { id: 'f1', name: 'Tea', aliases: ['chai', 'my tea'], amount: 1, unit: 'mug', grams: 350, calories: 45, proteinG: 1.5, carbsG: 6, fatG: 1.6, updatedAt: '2026-09-20T10:00:00Z' },
    null, 'x', { name: 5 }, { name: '' }, { name: 'Oats', aliases: 'not-an-array', calories: 'abc' },
  ]

  test('text only: a context part then the user’s words', () => {
    const parts = buildContent({ text: 'two bread two eggs', favorites, date: '2026-09-23', time: '13:05', region: 'America/Toronto' })
    assert.equal(parts.length, 2)
    for (const part of parts) assert.equal(part.type, 'input_text')
    assert.match(parts[0].text, /Wed 2026-09-23, 13:05/)
    assert.match(parts[0].text, /Meal \(from the time\): lunch/)
    assert.match(parts[0].text, /Canada/)
    assert.match(parts[0].text, /Tea \[also: chai, my tea\] — 1 mug, 350 g — 45 kcal/)
    assert.match(parts[0].text, /Oats/)
    assert.match(parts[1].text, /<user_input>\ntwo bread two eggs\n<\/user_input>/)
  })

  test('an explicit meal wins over the time', () => {
    const [context] = buildContent({ text: 'toast', meal: 'breakfast', date: '2026-09-23', time: '20:00' })
    assert.match(context.text, /Meal: breakfast/)
    assert.match(context.text, /Saved foods: none/)
  })

  test('photo: the image is the last part with detail high', () => {
    const parts = buildContent({ image: PHOTO, date: '2026-09-23' })
    assert.equal(parts.length, 3)
    assert.match(parts[1].text, /see the photo/)
    assert.deepEqual(parts[2], { type: 'input_image', image_url: PHOTO, detail: 'high' })
  })

  test('photo with text keeps both', () => {
    const parts = buildContent({ text: 'I ate half', image: PHOTO })
    assert.deepEqual(parts.map((part) => part.type), ['input_text', 'input_text', 'input_image'])
    assert.match(parts[1].text, /I ate half/)
  })

  test('previous estimate becomes a correction', () => {
    const previous = [{ name: 'Bread, white', amount: 2, unit: 'slice', grams: 60, calories: 154, proteinG: 5, carbsG: 29, fatG: 2, extra: { caffeineMg: null }, locked: ['amount'] }, null, 'junk']
    const parts = buildContent({ text: 'it was brown bread', previous })
    assert.equal(parts.length, 3)
    assert.match(parts[1].text, /^Previous estimate/)
    const json = JSON.parse(parts[1].text.split('\n').slice(1).join('\n'))
    assert.deepEqual(json, [{ name: 'Bread, white', quantity: 2, unit: 'slice', grams: 60, calories: 154, protein_g: 5, carbs_g: 29, fat_g: 2, user_specified: ['quantity'] }])
    assert.match(parts[2].text, /^Correction:/)
  })

  test('voice transcripts are labelled', () => {
    const parts = buildContent({ text: 'um a banana', voice: true })
    assert.match(parts[1].text, /voice transcript/)
  })

  test('tolerates missing arguments', () => {
    const parts = buildContent()
    assert.equal(parts.length, 1)
    assert.equal(parts[0].type, 'input_text')
  })
})

describe('estimatePlan', () => {
  test('text runs at the quickest effort with a small output cap', () => {
    assert.deepEqual(estimatePlan({ model: 'gpt-5-mini', text: 'two eggs and toast with butter' }), { effort: 'minimal', maxOutputTokens: 2500 })
    assert.equal(estimatePlan({ model: 'gpt-5.4-mini', text: 'toast' }).effort, 'low')
    assert.ok(estimatePlan({ model: 'gpt-5-mini', text: 'x'.repeat(1000) }).maxOutputTokens > 4000)
    assert.ok(estimatePlan({ model: 'gpt-5-mini', text: 'fix', previousCount: 12 }).maxOutputTokens > 4000)
    assert.ok(estimatePlan({ model: 'gpt-5-mini', text: 'x'.repeat(5000), previousCount: 99 }).maxOutputTokens <= 6000)
  })

  test('photos use low, or medium for labels and menus', () => {
    assert.deepEqual(estimatePlan({ model: 'gpt-5-mini', image: true }), { effort: 'low', maxOutputTokens: 6000 })
    assert.equal(estimatePlan({ model: 'gpt-5-mini', image: true, text: 'the nutrition label' }).effort, 'medium')
    assert.equal(estimatePlan({ model: 'gpt-5-mini', image: true, text: 'from this menu' }).effort, 'medium')
    assert.equal(estimatePlan().effort, 'low')
  })
})

describe('instructions and helpers', () => {
  test('carry the estimator rules', () => {
    const text = buildInstructions()
    for (const phrase of ['One item per distinct food', 'User numbers are locked', 'Saved foods win', 'Starbucks', 'Tim Hortons in Canada', 'Double-double', 'iced coffee', 'Nutrition label', 'previous estimate', 'not_food', 'mug = 350 ml', '1 cup cooked white rice']) {
      assert.ok(text.includes(phrase), phrase)
    }
    assert.ok(!text.includes('User context'))
    assert.match(buildInstructions({ region: 'Asia/Karachi', unit: 'lb' }), /Region: Pakistan[\s\S]*imperial/)
  })

  test('regionFromTimeZone', () => {
    assert.equal(regionFromTimeZone('America/Toronto'), 'Canada')
    assert.equal(regionFromTimeZone('America/New_York'), 'United States')
    assert.equal(regionFromTimeZone('Europe/London'), 'United Kingdom')
    assert.equal(regionFromTimeZone('Asia/Karachi'), 'Pakistan')
    assert.equal(regionFromTimeZone('Europe/Madrid'), null)
    assert.equal(regionFromTimeZone(null), null)
  })

  test('transcriptionVocabulary lists saved food names', () => {
    assert.match(transcriptionVocabulary([{ name: 'Tea', aliases: ['chai'] }, { name: 'Tim Hortons iced capp', brand: 'Tim Hortons' }]), /Tea, chai, Tim Hortons iced capp, Tim Hortons/)
    assert.doesNotMatch(transcriptionVocabulary(null), /Foods that may come up/)
  })
})

// ---- OpenAI helper (fetch stubbed, no network) ----------------------------------------------------

describe('_openai', () => {
  const realFetch = globalThis.fetch
  const realKey = process.env.OPENAI_API_KEY
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = realKey
  })

  function stub(status, payload) {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })
    }
    return calls
  }
  const reply = (text) => ({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text }] }] })
  const call = (extra = {}) => responsesJson({ model: 'gpt-5-mini', instructions: 'x', content: [textPart('hi')], schema: ESTIMATE_SCHEMA, name: ESTIMATE_SCHEMA_NAME, userId: 'u1', ...extra })

  test('part helpers', () => {
    assert.deepEqual(textPart('a'), { type: 'input_text', text: 'a' })
    assert.deepEqual(imagePart(PHOTO), { type: 'input_image', image_url: PHOTO, detail: 'high' })
    assert.deepEqual(filePart('a.pdf', 'data:application/pdf;base64,AA=='), { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,AA==', detail: 'low' })
  })

  test('sends a strict json_schema request and parses the message', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const calls = stub(200, reply('{"items":[],"clarify":null,"not_food":true}'))
    const debug = []
    const result = await call({ effort: 'medium', maxOutputTokens: 6000, debug })
    assert.deepEqual(result, { items: [], clarify: null, not_food: true })
    const { body } = calls[0]
    assert.equal(calls[0].url, 'https://api.openai.com/v1/responses')
    assert.equal(body.store, false)
    assert.equal(body.max_output_tokens, 6000)
    assert.deepEqual(body.reasoning, { effort: 'medium' })
    assert.equal(body.text.verbosity, 'low')
    assert.deepEqual(body.text.format, { type: 'json_schema', name: 'food_estimate', strict: true, schema: ESTIMATE_SCHEMA })
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    assert.equal(body.prompt_cache_key, 'daybook-food_estimate-u1')
    assert.ok(debug.some((entry) => entry.step === 'openai.response'))
  })

  test('friendly errors', async () => {
    delete process.env.OPENAI_API_KEY
    await assert.rejects(call(), { status: 503 })
    process.env.OPENAI_API_KEY = 'test-key'
    stub(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] })
    await assert.rejects(call(), { status: 422, message: 'No.' })
    stub(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
    await assert.rejects(call(), { status: 502 })
    stub(429, { error: { message: 'Rate limit', type: 'rate_limit' } })
    await assert.rejects(call(), { status: 429 })
    stub(401, { error: { message: 'bad key' } })
    await assert.rejects(call(), { status: 503 })
    stub(502, '<html>bad gateway</html>')
    await assert.rejects(call(), { status: 502 })
    stub(200, reply('{not json'))
    await assert.rejects(call(), { status: 502 })
  })

  test('a retired or mistyped model names the setting to change', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    stub(404, { error: { message: 'The model `gpt-5-mini` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } })
    await assert.rejects(call({ modelEnv: 'OPENAI_FOOD_MODEL' }), (error) => error.status === 503 && /gpt-5-mini/.test(error.message) && /OPENAI_FOOD_MODEL/.test(error.message))
    const gone = httpError(400, { error: { message: 'The model gpt-4.5-preview has been deprecated.' } })
    assert.equal(gone.status, 503)
    assert.match(gone.message, /OPENAI_MODEL/)
    assert.equal(httpError(400, { error: { message: 'Invalid image data' } }).status, 400)
    assert.equal(httpError(500, {}).status, 502)
  })

  test('an effort the model doesn’t take is retried once at low', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const efforts = []
    globalThis.fetch = async (url, init) => {
      const { reasoning } = JSON.parse(init.body)
      efforts.push(reasoning.effort)
      if (reasoning.effort === 'minimal') return new Response(JSON.stringify({ error: { message: "Unsupported value: 'minimal' is not supported with the 'gpt-5-mini' model.", param: 'reasoning.effort' } }), { status: 400 })
      return new Response(JSON.stringify(reply('{"items":[],"clarify":null,"not_food":true}')), { status: 200 })
    }
    assert.deepEqual(await call({ effort: 'minimal' }), { items: [], clarify: null, not_food: true })
    assert.deepEqual(efforts, ['minimal', 'low'])
    // Remembered: the next call goes straight to low.
    await call({ effort: 'minimal' })
    assert.deepEqual(efforts, ['minimal', 'low', 'low'])
  })

  test('models and efforts', () => {
    assert.equal(fastestEffort('gpt-5-mini'), 'minimal')
    assert.equal(fastestEffort('gpt-5-nano-2025-08-07'), 'minimal')
    assert.equal(fastestEffort('gpt-5.4-mini'), 'low')
    assert.equal(fastestEffort('o4-mini'), 'low')
    const saved = { food: process.env.OPENAI_FOOD_MODEL, main: process.env.OPENAI_MODEL }
    try {
      process.env.OPENAI_FOOD_MODEL = '  '
      process.env.OPENAI_MODEL = ' gpt-5.4-mini\n'
      assert.deepEqual(modelFromEnv('OPENAI_FOOD_MODEL', 'OPENAI_MODEL'), { model: 'gpt-5.4-mini', env: 'OPENAI_MODEL' })
      process.env.OPENAI_FOOD_MODEL = 'gpt-5.4-nano'
      assert.deepEqual(modelFromEnv('OPENAI_FOOD_MODEL', 'OPENAI_MODEL'), { model: 'gpt-5.4-nano', env: 'OPENAI_FOOD_MODEL' })
      delete process.env.OPENAI_FOOD_MODEL
      delete process.env.OPENAI_MODEL
      assert.deepEqual(modelFromEnv('OPENAI_FOOD_MODEL', 'OPENAI_MODEL'), { model: 'gpt-5-mini', env: null })
    } finally {
      for (const [key, name] of [['food', 'OPENAI_FOOD_MODEL'], ['main', 'OPENAI_MODEL']]) {
        if (saved[key] === undefined) delete process.env[name]
        else process.env[name] = saved[key]
      }
    }
  })
})

// ---- saved foods and barcodes -------------------------------------------------------------------

describe('saved foods in the estimate', () => {
  const saved = [
    { id: 'f-whey', name: 'Gold Standard Whey', brand: 'Optimum Nutrition', amount: 1, unit: 'scoop', grams: 31, calories: 120, proteinG: 24, carbsG: 3, fatG: 1.5, aliases: ['protein shake'], source: 'label', updatedAt: '2026-09-20T10:00:00Z' },
    { id: 'f-yogurt', name: 'Greek yogurt', amount: 175, unit: 'g', calories: 100, proteinG: 17, carbsG: 6, fatG: 0, updatedAt: '2026-09-22T10:00:00Z' },
  ]

  test('matching saved foods get the first ids (S1…)', () => {
    const ordered = favoritesForPrompt(saved, 'two scoops of my protein shake')
    assert.equal(ordered[0].id, 'f-whey')
    const parts = buildContent({ text: 'two scoops of my protein shake', favorites: saved })
    assert.match(parts[0].text, /S1 — Gold Standard Whey \(Optimum Nutrition\)/)
  })

  test('saved_food_id maps back to the saved food with its source', () => {
    const list = favoritesForPrompt(saved, 'two scoops of my protein shake')
    const raw = { items: [{ name: 'Gold Standard Whey', brand: 'Optimum Nutrition', quantity: 2, unit: 'scoop', grams: 62, calories: 240, protein_g: 48, carbs_g: 6, fat_g: 3, fiber_g: null, sugar_g: null, sodium_mg: null, alcohol_g: null, caffeine_mg: null, confidence: 0.95, assumptions: [], user_specified: [], options: [], meal_hint: null, basis: 'saved', saved_food_id: 'S1' }], clarify: null, not_food: false, barcode: null }
    const [item] = toClientItems(raw, 'two scoops of my protein shake', { saved: list })
    assert.equal(item.basis, 'saved')
    assert.equal(item.savedFoodId, 'f-whey')
    assert.equal(item.source.type, 'saved')
    assert.equal(item.source.savedSource, 'label')
    assert.equal(item.calories, 240)
  })

  test('an unknown saved id falls back to an estimate', () => {
    const raw = { items: [{ name: 'Mystery bar', brand: null, quantity: 1, unit: 'bar', grams: 50, calories: 200, protein_g: 10, carbs_g: 20, fat_g: 8, fiber_g: null, sugar_g: null, sodium_mg: null, alcohol_g: null, caffeine_mg: null, confidence: 0.6, assumptions: [], user_specified: [], options: [], meal_hint: null, basis: 'saved', saved_food_id: 'S9' }] }
    const [item] = toClientItems(raw, 'a bar', { saved: [] })
    assert.equal(item.basis, 'estimate')
    assert.equal(item.savedFoodId, null)
  })

  test('barcode digits from a photo', () => {
    assert.equal(barcodeFromReply({ barcode: '0 64200 11589 6' }), '064200115896')
    assert.equal(barcodeFromReply({ barcode: '12345' }), null)
    assert.equal(barcodeFromReply({}), null)
  })
})


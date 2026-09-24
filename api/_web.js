// Online lookups for the assistant and the food tracker:
//   * lookupBarcode — Open Food Facts (free product database, no key) by barcode.
//   * webNutrition   — exact nutrition for a named food/product via OpenAI's hosted web_search tool.
//   * webAnswer      — a short sourced answer to a general question via web_search.
// Web searches cost money per call (about $0.01 plus reading), so callers only run them with the
// user's go-ahead (settings.assistantWeb: 'ask' | 'always' | 'off').

import { modelFromEnv, responsesJson } from './_openai.js'
import { clampEstimateItem } from '../src/lib/food/nutrition.js'

// OPENAI_WEB_MODEL, else OPENAI_MODEL, else the default (the model must support web_search).
export const WEB_MODEL = modelFromEnv('OPENAI_WEB_MODEL', 'OPENAI_MODEL')
export const WEB_SETTINGS = ['ask', 'always', 'off']
export const webSetting = (settings) => (WEB_SETTINGS.includes(settings?.assistantWeb) ? settings.assistantWeb : 'ask')

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/'
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url'
// Open Food Facts asks every app to identify itself.
const OFF_USER_AGENT = 'Daybook/1.0 (https://daybook-smoky-seven.vercel.app)'

const num = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const round = (value, places = 1) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places)
const clean = (value, max = 120) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// 8–14 digits (EAN-8, UPC-A, EAN-13, GTIN-14), ignoring spaces and dashes; else null.
export function barcodeOf(text) {
  const digits = String(text ?? '').replace(/[\s-]/g, '')
  return /^\d{8,14}$/.test(digits) ? digits : null
}

// Per-serving numbers when the product lists a serving, else per 100 g/ml.
function productNutrition(product) {
  const n = product?.nutriments || {}
  const servingGrams = num(product.serving_quantity)
  const pick = (key, basis) => num(n[`${key}_${basis}`])
  const hasServing = pick('energy-kcal', 'serving') !== null || (servingGrams && pick('energy-kcal', '100g') !== null)
  const scale = (key) => {
    if (hasServing) {
      const direct = pick(key, 'serving')
      if (direct !== null) return direct
      const per100 = pick(key, '100g')
      return per100 !== null && servingGrams ? (per100 * servingGrams) / 100 : null
    }
    return pick(key, '100g')
  }
  let kcal = scale('energy-kcal')
  if (kcal === null) {
    const kj = scale('energy-kj') ?? scale('energy')
    if (kj !== null) kcal = kj / 4.184
  }
  const sodiumG = scale('sodium') ?? (scale('salt') !== null ? scale('salt') / 2.5 : null)
  return {
    basis: hasServing ? 'serving' : '100g',
    amount: hasServing ? 1 : 100,
    unit: hasServing ? 'serving' : 'g',
    servingText: hasServing ? clean(product.serving_size, 60) || null : '100 g',
    grams: hasServing ? servingGrams : 100,
    calories: round(kcal, 0),
    proteinG: round(scale('proteins')),
    carbsG: round(scale('carbohydrates')),
    fatG: round(scale('fat')),
    fiberG: round(scale('fiber')),
    sugarG: round(scale('sugars')),
    sodiumMg: sodiumG === null ? null : Math.round(sodiumG * 1000),
    per100g: {
      calories: round(pick('energy-kcal', '100g'), 0), proteinG: round(pick('proteins', '100g')), carbsG: round(pick('carbohydrates', '100g')), fatG: round(pick('fat', '100g')),
    },
  }
}

// → { found: true, product: { barcode, name, brand, quantity, servingText, url, imageUrl, nutrition } }
//   | { found: false, barcode } ; throws a status-carrying Error when the service can't be reached.
export async function lookupBarcode(barcode, { timeoutMs = 8000 } = {}) {
  const code = barcodeOf(barcode)
  if (!code) throw Object.assign(new Error('That isn’t a barcode number (8–14 digits).'), { status: 400 })
  let response
  try {
    response = await fetch(`${OFF_URL}${code}.json?fields=${OFF_FIELDS}`, { headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw Object.assign(new Error('The product database (Open Food Facts) didn’t answer. Try again in a moment.'), { status: 502 })
  }
  if (response.status === 404) return { found: false, barcode: code }
  if (response.status === 429) throw Object.assign(new Error('The product database is busy. Try again in a minute.'), { status: 429 })
  if (!response.ok) throw Object.assign(new Error('The product database had a problem. Try again in a moment.'), { status: 502 })
  const payload = await response.json().catch(() => null)
  const product = payload?.product
  if (!product || payload.status === 0) return { found: false, barcode: code }
  const nutrition = productNutrition(product)
  const name = clean(product.product_name || product.product_name_en || product.generic_name) || null
  if (!name && nutrition.calories === null) return { found: false, barcode: code }
  return {
    found: true,
    product: {
      barcode: code,
      name: name || `Product ${code}`,
      brand: clean(String(product.brands || '').split(',')[0], 80) || null,
      quantity: clean(product.quantity, 40) || null,
      servingText: nutrition.servingText,
      url: `https://world.openfoodfacts.org/product/${code}`,
      imageUrl: typeof product.image_front_small_url === 'string' ? product.image_front_small_url : null,
      nutrition,
    },
  }
}

// A found product as a food item (EstimateItem shape used by the food tracker).
export function productItem(product, { amount } = {}) {
  const n = product.nutrition
  const item = clampEstimateItem({
    name: product.name, brand: product.brand, amount: n.amount, unit: n.unit, grams: n.grams,
    calories: n.calories, proteinG: n.proteinG, carbsG: n.carbsG, fatG: n.fatG, fiberG: n.fiberG, sugarG: n.sugarG, sodiumMg: n.sodiumMg,
    confidence: n.calories === null ? 0.5 : 0.95,
    assumptions: [n.basis === 'serving' ? `Per serving${n.servingText ? ` (${n.servingText})` : ''}, from the product's label data` : 'Per 100 g (the product lists no serving size)'],
    locked: ['calories'], options: [],
  })
  const factor = num(amount) && num(amount) > 0 ? num(amount) : 1
  if (factor !== 1) {
    for (const key of ['amount', 'grams', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg']) if (item[key] !== null) item[key] = round(item[key] * factor, key === 'calories' || key === 'sodiumMg' ? 0 : 1)
  }
  return { ...item, basis: 'barcode', barcode: product.barcode, savedFoodId: null, source: { type: 'openfoodfacts', url: product.url, title: 'Open Food Facts' } }
}

// ---- web search -----------------------------------------------------------------------------------

const NUTRITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'name', 'brand', 'serving', 'serving_grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'source_url', 'source_title', 'confidence', 'notes'],
  properties: {
    found: { type: 'boolean', description: 'true only when reliable published numbers were found' },
    name: { type: 'string' },
    brand: { type: ['string', 'null'] },
    serving: { type: ['string', 'null'], description: 'the serving the numbers are for, e.g. "1 bar (60 g)" or "Medium (14 fl oz)"' },
    serving_grams: { type: ['number', 'null'] },
    calories: { type: ['number', 'null'] },
    protein_g: { type: ['number', 'null'] },
    carbs_g: { type: ['number', 'null'] },
    fat_g: { type: ['number', 'null'] },
    fiber_g: { type: ['number', 'null'] },
    sugar_g: { type: ['number', 'null'] },
    sodium_mg: { type: ['number', 'null'] },
    source_url: { type: ['string', 'null'] },
    source_title: { type: ['string', 'null'] },
    confidence: { type: 'number', description: '0–1: 0.9+ for the brand’s own published numbers' },
    notes: { type: ['string', 'null'], description: 'one short line: variants, region, or what differs' },
  },
}

const NUTRITION_INSTRUCTIONS = `You look up exact nutrition facts on the web for a food tracker.
Prefer, in order: the brand's or restaurant's own nutrition page or PDF, the product's label (retailer listing or photo), then a reputable database (e.g. USDA FoodData Central, Open Food Facts, Nutritionix).
Match the exact product, size and variant the user means, and their country when it matters (sizes and recipes differ between countries). The numbers are for ONE serving as published; say which serving. Calories in kcal (convert kJ ÷ 4.184), sodium in mg.
If you can't find reliable published numbers for this exact item, set found=false and leave the numbers null rather than guessing. Put the page you used in source_url and its title in source_title.`

function sourcesOf(payload) {
  const out = []
  for (const item of payload?.output || []) {
    if (item?.type === 'web_search_call') for (const source of item.action?.sources || []) if (source?.url) out.push({ url: source.url, title: clean(source.title, 120) || null })
    if (item?.type === 'message') for (const part of item.content || []) for (const note of part.annotations || []) if (note?.type === 'url_citation' && note.url) out.push({ url: note.url, title: clean(note.title, 120) || null })
  }
  const seen = new Set()
  return out.filter((source) => (seen.has(source.url) ? false : seen.add(source.url))).slice(0, 8)
}

function locationOf(ctx) {
  const zone = typeof ctx?.timeZone === 'string' ? ctx.timeZone : ''
  const country = /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal)/.test(zone) ? 'CA'
    : /^America\//.test(zone) ? 'US' : /^Europe\/London/.test(zone) ? 'GB' : /^Asia\/Karachi/.test(zone) ? 'PK' : /^Asia\/Kolkata/.test(zone) ? 'IN' : null
  return { type: 'approximate', ...(country ? { country } : {}), ...(zone ? { timezone: zone } : {}) }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// → { found, item (EstimateItem with basis 'web'), sources, notes } for a named food or product.
export async function webNutrition(query, { ctx, userId, debug = [], timeoutMs = 45000 } = {}) {
  const q = clean(query, 300)
  if (!q) throw Object.assign(new Error('Say which food to look up.'), { status: 400 })
  const { result, payload } = await responsesJson({
    model: WEB_MODEL.model,
    modelEnv: WEB_MODEL.env || 'OPENAI_WEB_MODEL',
    instructions: NUTRITION_INSTRUCTIONS,
    content: `Find the nutrition facts for: ${q}`,
    schema: NUTRITION_SCHEMA,
    name: 'web_nutrition',
    effort: 'low', // web_search doesn't run with 'minimal'
    maxOutputTokens: 4000,
    tools: [{ type: 'web_search', search_context_size: 'low', user_location: locationOf(ctx) }],
    include: ['web_search_call.action.sources'],
    userId,
    timeoutMs,
    debug,
    withPayload: true,
  })
  const sources = sourcesOf(payload)
  const url = typeof result.source_url === 'string' && /^https?:\/\//i.test(result.source_url) ? result.source_url : sources[0]?.url || null
  const found = result.found === true && num(result.calories) !== null
  if (!found) return { found: false, item: null, sources, notes: clean(result.notes, 200) || null }
  // "1 bar (60 g)" → amount 1, unit "bar" (the weight is in grams); anything else stays one serving of that text.
  const serving = clean(result.serving, 60)
  const counted = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(serving)
  const grams = num(result.serving_grams)
  const bareUnit = counted && grams !== null ? counted[2].replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:g|ml)\s*\)\s*$/i, '').trim() : ''
  const item = clampEstimateItem({
    name: clean(result.name, 120) || q, brand: clean(result.brand, 80) || null,
    amount: counted ? Number(counted[1]) : 1, unit: counted ? bareUnit || counted[2] : serving || 'serving', grams,
    calories: num(result.calories), proteinG: num(result.protein_g), carbsG: num(result.carbs_g), fatG: num(result.fat_g),
    fiberG: num(result.fiber_g), sugarG: num(result.sugar_g), sodiumMg: num(result.sodium_mg),
    confidence: Math.max(0, Math.min(1, num(result.confidence) ?? 0.8)),
    assumptions: [result.serving ? `Per ${clean(result.serving, 60)}` : 'Per serving', result.notes ? clean(result.notes, 120) : null].filter(Boolean),
    locked: ['calories'], options: [],
  })
  return {
    found: true,
    item: { ...item, basis: 'web', savedFoodId: null, barcode: null, source: { type: 'web', url, title: clean(result.source_title, 120) || (url ? hostOf(url) : null) } },
    sources,
    notes: clean(result.notes, 200) || null,
  }
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'found'],
  properties: {
    found: { type: 'boolean' },
    answer: { type: 'string', description: 'a short, factual answer (a few sentences or a compact list) with the key numbers, dates and names' },
  },
}

// → { found, answer, sources } for a general question (opening hours, a fact, a date…).
export async function webAnswer(question, { ctx, userId, debug = [], timeoutMs = 45000 } = {}) {
  const q = clean(question, 400)
  if (!q) throw Object.assign(new Error('Say what to look up.'), { status: 400 })
  const { result, payload } = await responsesJson({
    model: WEB_MODEL.model,
    modelEnv: WEB_MODEL.env || 'OPENAI_WEB_MODEL',
    instructions: `Search the web and answer briefly and factually for a personal assistant. Today is ${ctx?.localDate || 'unknown'} (${ctx?.timeZone || 'UTC'}). Prefer official and primary sources. If you can't find a reliable answer, set found=false and say what's unclear.`,
    content: q,
    schema: ANSWER_SCHEMA,
    name: 'web_answer',
    effort: 'low',
    maxOutputTokens: 4000,
    tools: [{ type: 'web_search', search_context_size: 'low', user_location: locationOf(ctx) }],
    include: ['web_search_call.action.sources'],
    userId,
    timeoutMs,
    debug,
    withPayload: true,
  })
  return { found: result.found === true, answer: clean(result.answer, 2000), sources: sourcesOf(payload) }
}

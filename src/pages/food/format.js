import { energyInUnit, energyToKcal, entryMeal, mealForTime, unitFor } from '../../lib/food/nutrition.js'
import { nowTimeHHMM, parseISO, diffDays } from '../../lib/dates.js'
import { LB } from '../../lib/gym/units.js'

// Display helpers shared by the Food page, the review card and the Today food card.

export const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

export function toNum(value) {
  if (isNum(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim().replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

const formats = new Map()
function numberFormat(dp) {
  let format = formats.get(dp)
  if (!format) {
    format = new Intl.NumberFormat(undefined, { maximumFractionDigits: dp, minimumFractionDigits: 0 })
    formats.set(dp, format)
  }
  return format
}

// Grouped number with up to dp decimals ('1,240', '2.5'); '—' without a number. Minus is U+2212.
export function fmtNum(value, dp = 0) {
  if (!isNum(value)) return '—'
  const text = numberFormat(dp).format(Math.abs(value))
  return value < 0 && text !== '0' ? `−${text}` : text
}

export const fmtInt = (value) => fmtNum(isNum(value) ? Math.round(value) : value, 0)

export const unitLabel = (unit) => (unit === 'kJ' ? 'kJ' : 'kcal')

// '1,240' in the display unit.
export function energyNumber(kcal, unit) {
  const value = energyInUnit(kcal, unit)
  return value === null ? '—' : fmtInt(value)
}

export function fmtEnergy(kcal, unit) {
  const value = energyInUnit(kcal, unit)
  return value === null ? '—' : `${fmtInt(value)} ${unitLabel(unit)}`
}

// A stored kcal value as it is typed into a form: a whole number in the display unit ('' without one).
export function energyText(kcal, unit) {
  const value = energyInUnit(kcal, unit)
  return value === null ? '' : String(Math.round(value))
}

// The kcal a typed energy value stands for (to 0.1 kcal); null when the field is blank or not a
// number. With `original` (the stored kcal the field was filled from), text that still reads as
// that value keeps it exactly: in kJ, 100 kcal shows as 418 kJ, which would otherwise come back as
// 99.9 kcal every time the entry is opened and saved untouched.
export function kcalFromText(text, unit, original = null) {
  const typed = toNum(text)
  if (typed === null) return null
  if (isNum(original) && String(text).trim() === energyText(original, unit)) return original
  return Math.round(energyToKcal(typed, unit) * 10) / 10
}

// Grams: whole numbers from 10 g, one decimal below.
export function fmtGrams(value) {
  if (!isNum(value)) return '—'
  return fmtNum(value, Math.abs(value) < 10 ? 1 : 0)
}

// Nutrients as shown in bars, rows and settings (field on entries, key in goals).
export const NUTRIENT_INFO = {
  protein: { key: 'protein', label: 'Protein', short: 'P', field: 'proteinG', unit: 'g' },
  carbs: { key: 'carbs', label: 'Carbs', short: 'C', field: 'carbsG', unit: 'g' },
  fat: { key: 'fat', label: 'Fat', short: 'F', field: 'fatG', unit: 'g' },
  fiber: { key: 'fiber', label: 'Fiber', short: 'Fb', field: 'fiberG', unit: 'g' },
  sugar: { key: 'sugar', label: 'Sugar', short: 'S', field: 'sugarG', unit: 'g', limit: true },
  sodium: { key: 'sodium', label: 'Sodium', short: 'Na', field: 'sodiumMg', unit: 'mg', limit: true },
}

export function fmtNutrient(key, value) {
  const info = NUTRIENT_INFO[key]
  if (!info || !isNum(value)) return '—'
  return info.unit === 'mg' ? fmtInt(value) : fmtGrams(value)
}

// ---- weight --------------------------------------------------------------------------------

export const weightUnitLabel = (unit) => (unit === 'lb' ? 'lb' : 'kg')
export const kgToUnit = (kg, unit) => (isNum(kg) ? (unit === 'lb' ? kg / LB : kg) : null)
export const unitToKg = (value, unit) => (isNum(value) ? (unit === 'lb' ? value * LB : value) : null)

export function fmtWeight(kg, unit, dp = 1) {
  const value = kgToUnit(kg, unit)
  return value === null ? '—' : fmtNum(value, dp)
}

// '+0.3' / '−0.3' / '0' in the display unit.
export function fmtWeightChange(kg, unit, dp = 1) {
  const value = kgToUnit(kg, unit)
  if (value === null) return '—'
  const rounded = Math.round(value * 10 ** dp) / 10 ** dp
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : '−'}${fmtNum(Math.abs(rounded), dp)}`
}

// ---- entries -------------------------------------------------------------------------------

const MASS_UNITS = new Set(['g', 'gram', 'grams', 'kg', 'ml', 'l', 'oz', 'fl oz', 'lb'])
export const isMassUnit = (unit) => typeof unit === 'string' && MASS_UNITS.has(unit.trim().toLowerCase())

// '2 slices', '1 slice', '2 large', '×2': an amount with its unit, pluralised as it reads.
export function amountLabel(amount, unit, dp = 2) {
  const word = unitFor(amount, typeof unit === 'string' ? unit.trim() : '')
  return word ? `${fmtNum(amount, dp)} ${word}` : `×${fmtNum(amount, dp)}`
}

// A unit that already says how much it weighs or holds: "serving (250 g)", "can, 355 ml", "bar (60g)".
const UNIT_WITH_MASS = /\d\s*(fl\.?\s*oz|kg|ml|oz|g|l)\b/i

// '2 slices · 60 g', '250 ml', '×2', '150 g'; '' when there is no portion. The grams aren't repeated
// after a unit that carries them itself ('1 serving (250 g)', not '1 serving (250 g) · 250 g').
export function portionText(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const amount = toNum(entry.amount)
  const grams = toNum(entry.grams)
  const unit = typeof entry.unit === 'string' ? entry.unit.trim() : ''
  const parts = []
  if (amount !== null && amount > 0) parts.push(amountLabel(amount, unit))
  else if (unit && !isMassUnit(unit)) parts.push(unit)
  if (grams !== null && grams > 0 && !(amount !== null && isMassUnit(unit)) && !(parts.length && UNIT_WITH_MASS.test(unit))) parts.push(`${fmtGrams(grams)} g`)
  return parts.join(' · ')
}

export function entryName(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  if (name) return name
  return isNum(toNum(entry?.calories)) ? 'Quick add' : 'Untitled'
}

const AI_SOURCES = new Set(['ai_text', 'ai_photo', 'ai_voice', 'assistant'])
export const isEstimate = (entry) => AI_SOURCES.has(entry?.source) || isNum(entry?.ai?.confidence)
export const entryConfidence = (entry) => (isNum(entry?.ai?.confidence) ? entry.ai.confidence : isNum(entry?.confidence) ? entry.confidence : null)

// 'high' ≥ 0.8, 'medium' 0.5–0.8, 'low' < 0.5 (research §4 bands).
export function confidenceLevel(confidence) {
  if (!isNum(confidence)) return null
  return confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low'
}

// ---- meals & days --------------------------------------------------------------------------

export const mealIdFor = (id, meals) => entryMeal({ meal: id }, meals)
export const mealName = (meals, id) => (Array.isArray(meals) ? meals.find((meal) => meal.id === id)?.name : null) || 'Snacks'
export const defaultMeal = (meals) => mealIdFor(mealForTime(nowTimeHHMM()), meals)

// A representative time per default meal (for per-meal suggestions on other days).
const MEAL_TIMES = { breakfast: '08:00', lunch: '12:30', dinner: '19:00', snack: '15:30' }
export const mealTime = (id) => MEAL_TIMES[id] || nowTimeHHMM()

const dayFormats = new Map()
function dayFormat(options) {
  const key = JSON.stringify(options)
  let format = dayFormats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, options)
    dayFormats.set(key, format)
  }
  return format
}

// 'Wed 23 Sep' style (locale order).
export function shortDay(iso) {
  const date = parseISO(iso)
  if (Number.isNaN(date.getTime())) return iso || ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return dayFormat(sameYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

export function weekdayLetter(iso) {
  return dayFormat({ weekday: 'narrow' }).format(parseISO(iso))
}

export function weekdayShort(iso) {
  return dayFormat({ weekday: 'short' }).format(parseISO(iso))
}

export function monthDay(iso) {
  return dayFormat({ month: 'short', day: 'numeric' }).format(parseISO(iso))
}

// 'Today', 'Yesterday', 'Tomorrow', else 'Wed 23 Sep'.
export function dayLabel(iso, today) {
  const delta = diffDays(today, iso)
  if (delta === 0) return 'Today'
  if (delta === -1) return 'Yesterday'
  if (delta === 1) return 'Tomorrow'
  return shortDay(iso)
}

// 'Sep 14–20' or 'Sep 28 – Oct 4'.
export function weekRange(startIso, endIso) {
  const start = parseISO(startIso)
  const end = parseISO(endIso)
  if (start.getMonth() === end.getMonth()) return `${monthDay(startIso)}–${end.getDate()}`
  return `${monthDay(startIso)} – ${monthDay(endIso)}`
}

export const plural = (n, word, many = `${word}s`) => `${fmtInt(n)} ${n === 1 ? word : many}`

// Return without Shift, and not while an input method is composing (Japanese, Chinese…): for text
// fields that send on Enter. Handling it in onKeyDown works where a browser wouldn't submit the
// form on its own.
export function isSubmitKey(event) {
  return event?.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent?.isComposing && event.keyCode !== 229
}

// For a transparent date input laid over a label: a mouse click opens the browser's picker
// (touch devices open it on their own).
export function openDatePicker(event) {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches) event.currentTarget.showPicker?.()
  } catch {
    // showPicker can refuse (e.g. already open); the field still works
  }
}

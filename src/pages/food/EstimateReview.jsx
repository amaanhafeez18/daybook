import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addEntries, deleteEntry, estimateFood, itemsToEntries, rememberFoods, useFood, useWebSetting, webLookupFood } from '../../lib/food/state.js'
import { energyInUnit, energyToKcal, entryCalories, findFavorite, scaleEntry } from '../../lib/food/nutrition.js'
import { amountLabel, confidenceLevel, dayLabel, energyNumber, fmtGrams, fmtNum, isMassUnit, isNum, isSubmitKey, mealName, portionText, toNum, unitLabel } from './format.js'
import './food-shared.css'
import '../../components/food-quick.css'

// Editable review of an AI estimate ("the plate"): per item a portion stepper that scales every
// number, kcal and P/C/F, confidence (or where exact numbers came from: My foods, a barcode, the
// web, a label), alternative chips and remove; under each item's "More": assumptions, inline edits,
// "Search the web" (asked for, never automatic), "Estimate instead" for saved foods, and a "Save to
// My foods" switch (also shown closed when it is on); then the total, a "Fix…" line that re-runs
// the estimate with the current items as context, the model's clarifying question (answered in the
// same line) and the accuracy disclaimer.
//
// result: from prepareEstimate(). Each item keeps review bookkeeping in _-prefixed fields:
//   _k key · _base the item at portion factor 1 · _f the portion factor · _orig the numbers as
//   estimated (for the "As estimated" chip) · _opt the chosen alternative (index) or null ·
//   _label / _alt after a web search or "Estimate instead": this version's chip label and the
//   other version (a whole item) to switch back to · _save the owner's "Save to My foods" choice
//   (unset: the default for the item's basis) · _edited numbers typed by hand · _renamed name
//   typed by hand · _savedId the My-foods entry a save updates (a saved food looked up again).
// The item's own fields always hold the numbers as shown (scaleEntry(_base, _f)).

const NUMBER_FIELDS = ['calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg']
const BASES = new Set(['estimate', 'label', 'menu', 'saved', 'barcode', 'web'])
const EXACT_BASES = new Set(['label', 'barcode', 'web'])
// What a save to My foods records as the numbers' origin, by basis (saved: kept as it was).
const SAVE_SOURCE = { estimate: 'estimate', menu: 'estimate', label: 'label', barcode: 'barcode', web: 'web' }
const NOT_FOUND_TEXT = 'Couldn’t find exact numbers online.'
const LOOKUP_KEY = 'lookup'
let keySeq = 0

const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (id) => (typeof id === 'string' && id !== '') || isNum(id)
const plain = (item) => Object.fromEntries(Object.entries(item || {}).filter(([key]) => !key.startsWith('_')))
const pickNumbers = (item) => Object.fromEntries(NUMBER_FIELDS.map((field) => [field, isNum(item[field]) ? item[field] : null]))

// The hint sent as the text with a photo of a barcode (the server reads the code from the photo).
export const BARCODE_HINT = 'barcode'

// The digits when text is only a barcode (8–14 digits, spaces and dashes allowed), else null.
export function barcodeDigits(text) {
  if (typeof text !== 'string') return null
  const digits = text.trim().replace(/[\s-]/g, '')
  return /^\d{8,14}$/.test(digits) ? digits : null
}

const lookupDigits = (lookup) => (isObj(lookup) && typeof lookup.barcode === 'string' && /^\d{6,14}$/.test(lookup.barcode) ? lookup.barcode : null)

export const itemBasis = (item) => (BASES.has(item?.basis) ? item.basis : 'estimate')

// Only web links (http/https) are ever rendered.
export function safeUrl(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim()) ? value.trim() : null
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const savedDayFormats = new Map()
// 'Sep 23' (with the year when it isn't this year) from an ISO timestamp or date; '' otherwise.
export function fmtSavedDay(iso) {
  if (typeof iso !== 'string' || !iso) return ''
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const key = sameYear ? 'md' : 'mdy'
  let format = savedDayFormats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
    savedDayFormats.set(key, format)
  }
  return format.format(date)
}

// A My-foods source as it reads in "My foods · label, Sep 23".
const SAVED_FROM_SHORT = { label: 'label', barcode: 'barcode', web: 'web', user: 'your numbers', estimate: 'estimate', entry: 'your log' }

// Two line icons the shared Icon set doesn't have (same 24px grid and stroke).
const GLYPHS = {
  barcode: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 7v10M12 7v10M16 7v10" />,
  globe: <><circle cx="12" cy="12" r="9.5" /><path d="M12 2.5a14.5 14.5 0 0 0 0 19 14.5 14.5 0 0 0 0-19M2.5 12h19" /></>,
}

export function FoodGlyph({ name, size = 20, strokeWidth = 1.8, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  )
}

function prepareItem(raw, extra) {
  const base = plain(raw)
  if (!Array.isArray(base.locked)) base.locked = []
  return { ...base, _k: `rv${++keySeq}`, _base: base, _f: 1, _orig: pickNumbers(base), _opt: null, ...extra }
}

// estimateFood() result → review state. query: what the user typed or said (kept for the entries;
// the barcode photo hint becomes the code that was read, if any).
export function prepareEstimate(result, query) {
  const source = result && typeof result === 'object' ? result : {}
  const transcript = typeof source.transcript === 'string' ? source.transcript.trim() : ''
  const lookup = isObj(source.lookup) ? source.lookup : null
  const typed = typeof query === 'string' ? query.trim() : ''
  const asked = typed.toLowerCase() === BARCODE_HINT ? lookupDigits(lookup) || '' : typed
  return {
    items: (Array.isArray(source.items) ? source.items : []).map((item) => prepareItem(item)),
    clarify: source.clarify || null,
    notFood: source.notFood === true,
    transcript,
    query: asked || transcript || '',
    removed: [],
    lookup,
  }
}

// Items as plain EstimateItems (for itemsToEntries or a "Fix" request).
export const reviewItems = (result) => (Array.isArray(result?.items) ? result.items.map(plain) : [])

export function reviewTotals(items) {
  const totals = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, count: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    totals.count += 1
    totals.calories += entryCalories(item)
    for (const field of ['proteinG', 'carbsG', 'fatG']) totals[field] += isNum(item[field]) ? item[field] : 0
  }
  return totals
}

// Research §4: with "auto-log" on, a result may skip review when every item is ≥ 0.8 confident.
// A barcode or web lookup is always shown first, so the product and its numbers get confirmed.
export function canAutoLog(result) {
  const items = Array.isArray(result?.items) ? result.items : []
  if (result?.lookup || items.some((item) => ['barcode', 'web'].includes(itemBasis(item)))) return false
  return items.length > 0 && !result.clarify && !result.notFood && items.every((item) => isNum(item.confidence) && item.confidence >= 0.8)
}

// The My-foods entry saving this item updates: a saved food it came from (edited here), or the
// saved food a web search replaced.
function updateTarget(item) {
  if (validId(item?._savedId)) return item._savedId
  return itemBasis(item) === 'saved' && validId(item?.savedFoodId) ? item.savedFoodId : null
}

// The "Save to My foods" switch: shown (a saved food only once its numbers or name were changed),
// on (default: on for label, barcode, web and edited saved foods; off for estimates) and labelled
// "Update" when it will change a food already saved.
function saveChoice(item, favorites) {
  const basis = itemBasis(item)
  if (basis === 'saved' && !item._edited && !item._renamed) return { show: false, on: false, label: '' }
  const target = updateTarget(item)
  const update = !!target || (Array.isArray(favorites) && !!findFavorite(favorites, plain(item)))
  const fallback = basis === 'saved' || !!target || EXACT_BASES.has(basis)
  return { show: true, on: typeof item._save === 'boolean' ? item._save : fallback, label: update ? 'Update My foods' : 'Save to My foods' }
}

// The review's items to keep in My foods → rememberFoods() requests (with the item's index).
function rememberRequests(review) {
  const items = Array.isArray(review?.items) ? review.items : []
  const query = typeof review?.query === 'string' ? review.query.trim() : ''
  // What they typed becomes a name to match next time, when it was about this one food (not a
  // barcode, a meal name, or a plate that had other items).
  const alias = items.length === 1 && !review.removed?.length && query.length >= 2 && query.length <= 60 && !query.includes('\n')
    && !barcodeDigits(query) && !/^(breakfast|brunch|lunch|dinner|supper|snacks?)$/i.test(query) ? query : null
  const code = items.length === 1 ? lookupDigits(review?.lookup) : null
  const verifiedAt = new Date().toISOString()
  const out = []
  items.forEach((item, index) => {
    if (!saveChoice(item).on) return
    const basis = itemBasis(item)
    const src = isObj(item.source) ? item.source : {}
    const target = updateTarget(item)
    const source = item._edited ? 'user' : SAVE_SOURCE[basis]
    const url = safeUrl(src.url)
    const barcode = typeof item.barcode === 'string' && item.barcode ? item.barcode : code && (basis === 'barcode' || basis === 'web') ? code : null
    out.push({
      index,
      food: plain(item),
      // A saved food keeps its portion; one a web search replaced also keeps its name.
      ...(target ? { id: target, samePortion: true, keepName: basis !== 'saved' } : {}),
      aliases: alias ? [alias] : [],
      ...(source ? { source, verifiedAt } : {}),
      ...(url ? { sourceUrl: url } : {}),
      ...(barcode ? { barcode } : {}),
    })
  })
  return out
}

// Saves the reviewed items as entries (replacing a name-only entry when given) with an Undo toast;
// items whose "Save to My foods" is on are saved (or updated) there first, and Undo reverts both.
// Returns false when there was nothing to log.
export function logEstimate({ review, meal, date, source, replace, today, meals, unit }) {
  const items = reviewItems(review)
  let remembered = null
  const requests = rememberRequests(review)
  if (requests.length) {
    try {
      remembered = rememberFoods(requests.map(({ index, ...request }) => request)) // eslint-disable-line no-unused-vars
      remembered.saved.forEach((saved, i) => {
        const at = requests[i].index
        if (saved && items[at]) items[at] = { ...items[at], favoriteId: saved.id }
      })
    } catch {
      remembered = null // not loaded yet: log without saving
    }
  }
  const rows = itemsToEntries(items, { date, meal, source, query: review.query })
  if (!rows.length) {
    remembered?.()
    return false
  }
  const totals = reviewTotals(items)
  const what = items.length === 1 ? items[0].name || 'food' : `${items.length} items`
  const where = `${mealName(meals, meal)}${date !== today ? `, ${dayLabel(date, today)}` : ''}`
  const saved = remembered?.saved.some(Boolean) ? ' · saved to My foods' : ''
  const message = `Logged ${what} to ${where} · ${energyNumber(totals.calories, unit)} ${unitLabel(unit)}${saved}`
  const undoSaved = remembered || (() => {})
  if (replace?.id) {
    const undoDelete = deleteEntry(replace.id)
    const undoAdd = addEntries(rows)
    toast(message, { action: { label: 'Undo', onClick: () => { undoAdd(); undoDelete(); undoSaved() } } })
  } else {
    const undoAdd = addEntries(rows)
    toast(message, { action: { label: 'Undo', onClick: () => { undoAdd(); undoSaved() } } })
  }
  return true
}

function withFactor(item, factor) {
  const f = Math.max(0.05, Math.min(100, factor))
  return { ...item, ...scaleEntry(item._base, f), _f: f }
}

const LOCKABLE = new Set(['calories', 'proteinG', 'carbsG', 'fatG', 'grams', 'amount', 'unit', 'brand'])

// Edits made at the shown portion, carried back to the base (factor 1) too. Edited numbers are
// marked locked, so a later "Fix" keeps them.
function editItem(item, patch) {
  const basePatch = {}
  for (const [field, value] of Object.entries(patch)) {
    basePatch[field] = isNum(value) && NUMBER_FIELDS.includes(field) ? value / item._f : value
  }
  const locked = [...new Set([...(item.locked || []), ...Object.keys(patch).filter((field) => LOCKABLE.has(field))])]
  const base = { ...item._base, ...basePatch, locked }
  return { ...item, ...patch, locked, _base: base, _edited: true }
}

const isWhole = (n) => Math.abs(n - Math.round(n)) < 0.01
const up = (n, size) => Math.ceil((n + 0.001) / size) * size
const down = (n, size) => Math.floor((n - 0.001) / size) * size

// Next value on a count scale: quarters below 1, halves between, whole steps from whole numbers.
function stepCount(value, dir, min) {
  let target
  if (dir > 0) target = value < 1 ? Math.min(1, up(value, 0.25)) : isWhole(value) ? Math.round(value) + 1 : up(value, 0.5)
  else target = value <= 1 ? down(value, 0.25) : isWhole(value) ? Math.round(value) - 1 : down(value, 0.5)
  target = Math.round(target * 100) / 100
  return target >= min ? target : null
}

// Portion stepper. Counted portions (2 slices) step the count; weights (150 g) and items without
// an amount step a ×0.5 multiplier (shown as the weight when there is one).
function stepFor(item) {
  const base = item._base
  const baseAmount = toNum(base.amount)
  const unit = typeof base.unit === 'string' ? base.unit.trim() : ''
  const f = item._f
  if (baseAmount !== null && baseAmount > 0 && !isMassUnit(unit)) {
    const amount = baseAmount * f
    return {
      mode: 'amount',
      label: amountLabel(amount, unit),
      next: (dir) => {
        const target = stepCount(amount, dir, 0.25)
        return target === null ? null : target / baseAmount
      },
    }
  }
  const massLabel = baseAmount !== null && baseAmount > 0 ? amountLabel(baseAmount * f, unit, 1) : isNum(item.grams) ? `${fmtGrams(item.grams)} g` : null
  return {
    mode: 'factor',
    label: massLabel || `×${fmtNum(f, 2)}`,
    next: (dir) => {
      if (dir > 0) return Math.round(up(f, 0.5) * 100) / 100
      const target = f > 0.5 ? down(f, 0.5) : down(f, 0.25)
      return target >= 0.25 ? Math.round(target * 100) / 100 : null
    },
  }
}

// "Quest bar 1 bar (Quest)": an item as text for a fresh estimate.
function itemText(item) {
  return [item.name, portionText(item), item.brand ? `(${item.brand})` : ''].filter(Boolean).join(' ')
}

// "Quest Protein Bar Cookie Dough, 1 bar — from “had my quest bar”": brand, name and portion, with
// what was typed or said for context.
function webQuery(item, said) {
  const what = [[item.brand, item.name].filter(Boolean).join(' '), portionText(item)].filter(Boolean).join(', ')
  const text = typeof said === 'string' ? said.trim() : ''
  const context = text && text.length <= 300 && text.toLowerCase() !== String(item.name || '').trim().toLowerCase() ? ` — from “${text}”` : ''
  return what ? `${what}${context}` : text
}

// onBusyChange(busy): told when a "Fix" (or an item's web search / fresh estimate) starts and ends,
// so the parent can hold its Save/Log button (logging mid-request would save the old numbers).
export default function EstimateReview({ result, onChange, meal, onMealChange, date, compact = false, meals, disabled = false, onBusyChange }) {
  const food = useFood()
  const web = useWebSetting()
  const unit = food.prefs.energyUnit
  const mealList = Array.isArray(meals) && meals.length ? meals : food.prefs.meals
  const [openKeys, setOpenKeys] = useState(() => new Set())
  const [editKey, setEditKey] = useState(null)
  const [fixText, setFixText] = useState('')
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState('')
  const [pending, setPending] = useState({}) // item key (or LOOKUP_KEY) → 'web' | 'estimate'
  const [notes, setNotes] = useState({}) // item key (or LOOKUP_KEY) → { text, error? }
  const fixRef = useRef(null)
  const itemRequests = useRef(new Map())
  const fixId = useId()
  const busyRef = useRef(onBusyChange)
  busyRef.current = onBusyChange
  // The latest result, for replies that land after the parent re-rendered.
  const resultRef = useRef(result)
  resultRef.current = result
  const itemBusy = Object.keys(pending).length > 0

  useEffect(() => () => {
    fixRef.current?.abort()
    itemRequests.current.forEach((controller) => controller.abort())
  }, [])
  useEffect(() => {
    busyRef.current?.(fixing || itemBusy)
  }, [fixing, itemBusy])
  // Unmounting mid-request aborts it; the parent shouldn't stay held.
  useEffect(() => () => busyRef.current?.(false), [])

  // Low-confidence items open by themselves (once, so they can be closed again).
  const autoOpened = useRef(new Set())
  useEffect(() => {
    const low = (result?.items || [])
      .filter((item) => isNum(item.confidence) && item.confidence < 0.5 && !autoOpened.current.has(item._k))
      .map((item) => item._k)
    if (!low.length) return
    low.forEach((key) => autoOpened.current.add(key))
    setOpenKeys((current) => new Set([...current, ...low]))
  }, [result?.items])

  if (!result) return null
  const items = Array.isArray(result.items) ? result.items : []
  const totals = reviewTotals(items)
  const busy = disabled || fixing || itemBusy

  const commit = (next) => {
    resultRef.current = next
    onChange?.(next)
  }
  const update = (patch) => commit({ ...result, ...patch })
  const setItem = (key, next) => update({ items: items.map((item) => (item._k === key ? next : item)) })
  const toggle = (key) => {
    setEditKey((current) => (current === key ? null : current))
    setOpenKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function removeItem(item) {
    const index = items.findIndex((current) => current._k === item._k)
    update({ items: items.filter((current) => current._k !== item._k), removed: [...(result.removed || []), { item, index }].slice(-5) })
  }

  function restoreRemoved() {
    const removed = [...(result.removed || [])]
    const last = removed.pop()
    if (!last) return
    const next = [...items]
    next.splice(Math.min(last.index, next.length), 0, last.item)
    update({ items: next, removed })
  }

  // ---- per-item requests (web search, fresh estimate) ----

  function setNote(key, note) {
    setNotes((current) => {
      if (!note && !(key in current)) return current
      const next = { ...current }
      if (note) next[key] = note
      else delete next[key]
      return next
    })
  }

  function begin(key, kind) {
    itemRequests.current.get(key)?.abort()
    const controller = new AbortController()
    itemRequests.current.set(key, controller)
    setPending((current) => ({ ...current, [key]: kind }))
    setNote(key, null)
    return controller
  }

  function end(key, controller) {
    if (itemRequests.current.get(key) !== controller) return
    itemRequests.current.delete(key)
    setPending((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function stop(key) {
    const controller = itemRequests.current.get(key)
    if (!controller) return
    controller.abort()
    end(key, controller)
  }

  const findItem = (key) => (Array.isArray(resultRef.current?.items) ? resultRef.current.items.find((item) => item._k === key) : null)

  // Swaps one item for its replacement(s) in the latest result; false when it's gone.
  function replaceItem(key, replacement) {
    const latest = resultRef.current
    const list = Array.isArray(latest?.items) ? latest.items : []
    const index = list.findIndex((item) => item._k === key)
    if (index < 0) return false
    const next = [...list]
    next.splice(index, 1, ...(Array.isArray(replacement) ? replacement : [replacement]))
    commit({ ...latest, items: next })
    return true
  }

  async function searchWeb(item) {
    const key = item._k
    if (busy) return
    const controller = begin(key, 'web')
    try {
      const found = await webLookupFood({ query: webQuery(item, result.query), item: plain(item), date, meal, signal: controller.signal })
      if (controller.signal.aborted) return
      const hit = found.webFound ? found.items[0] : null
      if (!hit) {
        setNote(key, { text: found.message || NOT_FOUND_TEXT })
        return
      }
      const current = findItem(key)
      if (!current) return
      const basis = itemBasis(current)
      // The numbers it had stay one tap away.
      const previous = { ...current, _label: current._label || (basis === 'saved' ? 'Saved numbers' : 'Previous estimate'), _alt: undefined }
      replaceItem(key, prepareItem(current.barcode && !hit.barcode ? { ...hit, barcode: current.barcode } : hit, {
        _k: key,
        _label: 'Web',
        _alt: previous,
        _savedId: updateTarget(current),
      }))
    } catch (error) {
      if (error?.name !== 'AbortError') setNote(key, { text: error?.message || 'Couldn’t search the web right now.', error: true })
    } finally {
      end(key, controller)
    }
  }

  // A saved food estimated afresh (ignoring My foods); the saved numbers stay one tap away.
  async function estimateInstead(item) {
    const key = item._k
    if (busy) return
    const controller = begin(key, 'estimate')
    try {
      const next = await estimateFood({ text: itemText(item), skipSaved: true, meal, date, signal: controller.signal })
      if (controller.signal.aborted) return
      if (!next.items.length) {
        setNote(key, { text: next.clarify || 'Couldn’t estimate that — describe it in the Fix line below.' })
        return
      }
      const current = findItem(key)
      if (!current) return
      const previous = { ...current, _label: current._label || 'Saved numbers', _alt: undefined }
      replaceItem(key, next.items.length === 1
        ? prepareItem(next.items[0], { _k: key, _label: 'Estimate', _alt: previous })
        : next.items.map((raw) => prepareItem(raw)))
    } catch (error) {
      if (error?.name !== 'AbortError') setNote(key, { text: error?.message || 'Couldn’t estimate that right now.', error: true })
    } finally {
      end(key, controller)
    }
  }

  // A barcode Open Food Facts doesn't know: look the product up on the web and add it.
  async function searchBarcode() {
    const code = lookupDigits(result.lookup)
    if (!code || busy) return
    const controller = begin(LOOKUP_KEY, 'web')
    try {
      const found = await webLookupFood({ query: `Food product with barcode ${code}`, date, meal, signal: controller.signal })
      if (controller.signal.aborted) return
      const hit = found.webFound ? found.items[0] : null
      if (!hit) {
        setNote(LOOKUP_KEY, { text: found.message || NOT_FOUND_TEXT })
        return
      }
      const latest = resultRef.current
      commit({
        ...latest,
        items: [...(Array.isArray(latest?.items) ? latest.items : []), prepareItem({ ...hit, barcode: hit.barcode || code })],
        lookup: { ...latest.lookup, searched: true },
      })
    } catch (error) {
      if (error?.name !== 'AbortError') setNote(LOOKUP_KEY, { text: error?.message || 'Couldn’t search the web right now.', error: true })
    } finally {
      end(LOOKUP_KEY, controller)
    }
  }

  // Switches an item to its other version (web ↔ previous, estimate ↔ saved numbers).
  function swapVersion(item) {
    if (!item._alt) return
    const { _alt: other, ...self } = item
    setItem(item._k, { ...other, _k: item._k, _alt: self })
  }

  async function runFix(event) {
    event?.preventDefault()
    const words = fixText.trim()
    if (!words || busy) return
    const controller = new AbortController()
    fixRef.current?.abort()
    fixRef.current = controller
    setFixing(true)
    setFixError('')
    // An answer to the question goes with what was asked about (estimateFood keeps the end of a
    // long voice transcript, so the answer always fits).
    const answering = result.clarify && !items.length
    try {
      const next = await estimateFood({
        text: answering && result.query ? `${result.query}\n${words}` : words,
        previous: items.length ? reviewItems(result) : undefined,
        meal,
        date,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const prepared = prepareEstimate(next, [result.query, words].filter(Boolean).join('\n'))
      setFixText('')
      setOpenKeys(new Set())
      setEditKey(null)
      setNotes({})
      commit(prepared)
    } catch (error) {
      if (error?.name !== 'AbortError') setFixError(error?.message || 'Couldn’t update the estimate.')
    } finally {
      if (fixRef.current === controller) {
        fixRef.current = null
        setFixing(false)
      }
    }
  }

  const lastRemoved = result.removed?.[result.removed.length - 1]?.item
  const lookupCode = lookupDigits(result.lookup)
  const hasExact = items.some((item) => ['barcode', 'web'].includes(itemBasis(item)))
  const showLookup = result.lookup?.type === 'barcode' && result.lookup.found === false && !result.lookup.searched && !!lookupCode && !hasExact
  const lookupNote = notes[LOOKUP_KEY]

  return (
    <div className={`food-rv${compact ? ' is-compact' : ''}`} aria-busy={fixing || undefined}>
      {compact && onMealChange && (
        <div className="food-rv-top">
          <MealSelect meals={mealList} value={meal} onChange={onMealChange} />
        </div>
      )}

      {result.query && !compact && <p className="food-rv-query">“{result.query}”</p>}

      {showLookup && (
        <div className="food-rv-note food-rv-lookup" role="status">
          <FoodGlyph name="barcode" size={18} />
          <div className="food-rv-lookup-body">
            <span>Barcode {lookupCode} isn’t in Open Food Facts.</span>
            {lookupNote && <span className={`food-rv-lookup-note${lookupNote.error ? ' is-error' : ''}`}>{lookupNote.text}</span>}
            {web !== 'off' && (
              pending[LOOKUP_KEY] ? (
                <span className="food-rv-actions">
                  <span className="food-rv-act is-busy"><span className="spinner" aria-hidden="true" />Searching the web…</span>
                  <button type="button" className="food-rv-act" onClick={() => stop(LOOKUP_KEY)}>Stop</button>
                </span>
              ) : (
                <span className="food-rv-actions">
                  <button type="button" className="food-rv-act" onClick={searchBarcode} disabled={busy}>
                    <FoodGlyph name="globe" size={16} />Search the web
                  </button>
                </span>
              )
            )}
          </div>
        </div>
      )}

      {result.notFood && !items.length && (
        <p className="food-rv-note"><Icon name="info" size={16} />That doesn’t look like food. Describe what you ate, or try another photo.</p>
      )}
      {!result.notFood && !items.length && !result.clarify && !showLookup && (
        <p className="food-rv-note"><Icon name="info" size={16} />{lastRemoved ? 'No items left.' : 'No food found in that. Try describing it differently.'}</p>
      )}

      {items.length > 0 && (
        <ul className="food-rv-list">
          {items.map((item) => (
            <ReviewItem
              key={item._k}
              item={item}
              unit={unit}
              web={web}
              favorites={food.favorites}
              open={openKeys.has(item._k)}
              editing={editKey === item._k}
              disabled={busy}
              compact={compact}
              pendingKind={pending[item._k] || null}
              note={notes[item._k] || null}
              onToggle={() => toggle(item._k)}
              onEdit={() => {
                setOpenKeys((current) => new Set([...current, item._k]))
                setEditKey(item._k)
              }}
              onChange={(next) => setItem(item._k, next)}
              onRemove={() => removeItem(item)}
              onSearchWeb={() => searchWeb(item)}
              onEstimateInstead={() => estimateInstead(item)}
              onStop={() => stop(item._k)}
              onSwap={() => swapVersion(item)}
            />
          ))}
        </ul>
      )}

      {lastRemoved && (
        <p className="food-rv-removed">
          <span>Removed {lastRemoved.name || 'item'}</span>
          <button type="button" className="food-rv-link" onClick={restoreRemoved} disabled={busy}>Undo</button>
        </p>
      )}

      {items.length > 0 && (
        <div className="food-rv-total">
          <span className="food-rv-total-label">Total</span>
          <span className="food-rv-total-kcal">{energyNumber(totals.calories, unit)} <small>{unitLabel(unit)}</small></span>
          <span className="food-rv-total-macros">P {fmtGrams(totals.proteinG)} · C {fmtGrams(totals.carbsG)} · F {fmtGrams(totals.fatG)}</span>
        </div>
      )}

      {result.clarify && (
        <p className="food-rv-question"><Icon name="message" size={16} /><span>{result.clarify}</span></p>
      )}

      <form className="food-rv-fix" onSubmit={runFix}>
        <label htmlFor={fixId} className="sr-only">{result.clarify ? 'Answer the question' : 'Correct the estimate'}</label>
        <Icon name={result.clarify ? 'message' : 'wand'} size={17} />
        <input
          id={fixId}
          className="food-rv-fix-input"
          value={fixText}
          onChange={(event) => setFixText(event.target.value)}
          onKeyDown={(event) => {
            // Return sends, also where the browser doesn't submit the form by itself.
            if (isSubmitKey(event)) {
              event.preventDefault()
              runFix()
            }
          }}
          placeholder={result.clarify ? 'Reply…' : items.length ? 'Fix: “it was brown bread, 3 eggs”' : 'Describe it another way…'}
          enterKeyHint="send"
          autoComplete="off"
          disabled={disabled}
          maxLength={500}
        />
        {fixing ? (
          <button type="button" className="food-rv-fix-btn is-busy" onClick={() => fixRef.current?.abort()} aria-label="Stop updating">
            <span className="spinner" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="food-rv-fix-btn" disabled={!fixText.trim() || busy} aria-label="Update estimate">
            <Icon name="send" size={17} strokeWidth={2.2} />
          </button>
        )}
      </form>
      {fixing && <p className="food-rv-status" role="status">Updating the estimate…</p>}
      {fixError && <p className="food-rv-error" role="alert">{fixError}</p>}

      <p className="food-rv-disclaimer">Estimates can be off by 20% or more — adjust the portions you know.</p>
    </div>
  )
}

export function MealSelect({ meals, value, onChange, className = '' }) {
  const id = useId()
  const current = meals.find((meal) => meal.id === value) || meals[0]
  return (
    <label className={`food-pick ${className}`} htmlFor={id}>
      <span className="sr-only">Meal</span>
      <span className="food-pick-text">{current?.name || 'Meal'}</span>
      <Icon name="chevronDown" size={15} strokeWidth={2.2} />
      <select id={id} value={current?.id || ''} onChange={(event) => onChange(event.target.value)}>
        {meals.map((meal) => <option key={meal.id} value={meal.id}>{meal.name}</option>)}
      </select>
    </label>
  )
}

function ConfidenceDots({ confidence }) {
  const level = confidenceLevel(confidence)
  if (!level) return null
  const filled = Math.max(1, Math.min(4, Math.round(confidence * 4)))
  const label = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }[level]
  return (
    <span className={`food-rv-dots is-${level}`} role="img" aria-label={label} title={label}>
      {[0, 1, 2, 3].map((i) => <i key={i} className={i < filled ? 'is-on' : ''} />)}
    </span>
  )
}

// Where exact numbers came from: "My foods · label, Sep 23", "Barcode · Open Food Facts",
// "Web · example.com" (links open in a new tab) or "Nutrition label". Estimates show nothing here
// (their confidence dots say it).
export function SourceBadge({ item }) {
  const basis = itemBasis(item)
  const src = isObj(item?.source) ? item.source : {}
  let url = safeUrl(src.url)
  let icon
  let text
  if (basis === 'saved') {
    const detail = [SAVED_FROM_SHORT[src.savedSource], fmtSavedDay(src.savedAt)].filter(Boolean).join(', ')
    icon = <Icon name="bookmark" size={13} strokeWidth={2} />
    text = detail ? `My foods · ${detail}` : 'My foods'
  } else if (basis === 'barcode') {
    const code = typeof item.barcode === 'string' && /^\d{6,14}$/.test(item.barcode) ? item.barcode : null
    if (!url && code) url = `https://world.openfoodfacts.org/product/${code}`
    icon = <FoodGlyph name="barcode" size={13} strokeWidth={2} />
    text = 'Barcode · Open Food Facts'
  } else if (basis === 'web') {
    const host = url ? hostOf(url) : ''
    icon = <FoodGlyph name="globe" size={13} strokeWidth={2} />
    text = host ? `Web · ${host}` : 'Web'
  } else if (basis === 'label') {
    icon = <Icon name="fileText" size={13} strokeWidth={2} />
    text = 'Nutrition label'
  } else {
    return null
  }
  if (!url) return <span className="food-rv-src">{icon}<span>{text}</span></span>
  return (
    <a className="food-rv-src is-link" href={url} target="_blank" rel="noopener noreferrer" title={src.title || url}>
      {icon}<span>{text}</span><span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

// One item on the plate. Closed: name, calories, the portion stepper, macros, confidence, where
// exact numbers came from, and the one-tap alternatives. "More" (or a tap on the name) opens the
// rest: what was assumed, the name and numbers to edit, "Search the web" / "Estimate instead", and
// the "Save to My foods" switch — which also shows while closed whenever it is on, so nothing that
// will happen on Save is hidden.
function ReviewItem({
  item, unit, web, favorites, open, editing, disabled, compact, pendingKind, note, onToggle, onEdit, onChange, onRemove, onSearchWeb, onEstimateInstead, onStop, onSwap,
}) {
  const level = confidenceLevel(item.confidence)
  const step = stepFor(item)
  const minusTarget = step.next(-1)
  const kcal = entryCalories(item)
  const hasKcal = isNum(item.calories) || kcal > 0
  const options = Array.isArray(item._base.options) ? item._base.options : []
  const assumptions = Array.isArray(item.assumptions) ? item.assumptions : []
  const name = item.name || 'Food'
  const basis = itemBasis(item)
  const canWeb = web !== 'off' && (basis === 'estimate' || basis === 'menu' || basis === 'saved')
  const canEstimate = basis === 'saved'
  const save = saveChoice(item, favorites)
  const moreId = useId()

  function applyOption(index) {
    const option = index === null ? null : options[index]
    const swapped = option ? Object.fromEntries(['calories', 'proteinG', 'carbsG', 'fatG'].filter((field) => isNum(option[field])).map((field) => [field, option[field]])) : {}
    const numbers = { ...item._orig, ...swapped }
    const base = { ...item._base, ...numbers }
    onChange(withFactor({ ...item, _base: base, _opt: index }, item._f))
  }

  const saveSwitch = save.show && (
    <button
      type="button"
      role="switch"
      aria-checked={save.on}
      className={`food-rv-save${save.on ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange({ ...item, _save: !save.on })}
    >
      <span className="food-rv-save-box" aria-hidden="true">{save.on && <Icon name="check" size={13} strokeWidth={3} />}</span>
      {save.label}
    </button>
  )

  return (
    <li className={`food-rv-item${level === 'low' ? ' is-low' : ''}${open ? ' is-open' : ''}${pendingKind ? ' is-busy' : ''}`} aria-busy={pendingKind ? true : undefined}>
      <div className="food-rv-head">
        <button type="button" className="food-rv-name" onClick={open ? onToggle : onEdit} aria-expanded={open} aria-controls={moreId} aria-label={`${name}${open ? '' : ' — edit'}`}>
          <span className="food-rv-name-text">{name}</span>
          {item.brand && <span className="food-rv-brand">{item.brand}</span>}
        </button>
        <span className="food-rv-kcal">
          {level && level !== 'high' && hasKcal && <span className="food-rv-approx" aria-hidden="true">~</span>}
          {hasKcal ? energyNumber(kcal, unit) : '—'}
          <small> {unitLabel(unit)}</small>
        </span>
        <button type="button" className="food-rv-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove ${name}`}>
          <Icon name="close" size={15} strokeWidth={2.2} />
        </button>
      </div>

      <div className="food-rv-meta">
        <span className="food-rv-stepper" role="group" aria-label={`${name} portion`}>
          <button type="button" aria-label="Less" disabled={disabled || minusTarget === null} onClick={() => minusTarget !== null && onChange(withFactor(item, minusTarget))}>
            <Icon name="minus" size={15} strokeWidth={2.4} />
          </button>
          <output aria-live="polite">{step.label}</output>
          <button type="button" aria-label="More" disabled={disabled} onClick={() => { const target = step.next(1); if (target !== null) onChange(withFactor(item, target)) }}>
            <Icon name="plus" size={15} strokeWidth={2.4} />
          </button>
        </span>
        <span className="food-rv-macros">
          {step.mode === 'amount' && isNum(item.grams) && item.grams > 0 && <span className="food-rv-portion">{fmtGrams(item.grams)} g</span>}
          <span>P {fmtGrams(item.proteinG ?? 0)} · C {fmtGrams(item.carbsG ?? 0)} · F {fmtGrams(item.fatG ?? 0)}</span>
        </span>
        <ConfidenceDots confidence={item.confidence} />
      </div>

      <SourceBadge item={item} />

      {level === 'low' && <p className="food-rv-check"><Icon name="alert" size={14} />Check the portion</p>}

      {/* After a web search or a fresh estimate, the numbers it had are one tap away. */}
      {item._alt && (
        <div className="food-rv-options" role="group" aria-label={`${name}: which numbers`}>
          <button type="button" className="food-rv-option is-active" aria-pressed="true" disabled={disabled}>
            {item._label || 'Now'}
            {hasKcal && <small>{energyNumber(kcal, unit)}</small>}
          </button>
          <button type="button" className="food-rv-option" aria-pressed="false" disabled={disabled} onClick={onSwap}>
            {item._alt._label || 'Before'}
            {entryCalories(item._alt) > 0 && <small>{energyNumber(entryCalories(item._alt), unit)}</small>}
          </button>
        </div>
      )}

      {/* Alternatives (black / with milk, fried in oil…) are one tap away, open or not. */}
      {options.length > 0 && (
        <div className="food-rv-options" role="group" aria-label={`${name}: alternatives`}>
          <button type="button" className={`food-rv-option${item._opt === null ? ' is-active' : ''}`} aria-pressed={item._opt === null} disabled={disabled} onClick={() => applyOption(null)}>
            As estimated
            {isNum(item._orig.calories) && <small>{energyNumber(item._orig.calories * item._f, unit)}</small>}
          </button>
          {options.map((option, index) => (
            <button
              key={`${option.label}-${index}`}
              type="button"
              className={`food-rv-option${item._opt === index ? ' is-active' : ''}`}
              aria-pressed={item._opt === index}
              disabled={disabled}
              onClick={() => applyOption(index)}
            >
              {option.label}
              {isNum(option.calories) && <small>{energyNumber(option.calories * item._f, unit)}</small>}
            </button>
          ))}
        </div>
      )}

      {/* The "More" line: what was assumed reads as its summary while closed. */}
      <div className="food-rv-foot">
        <button type="button" className="food-rv-more" aria-expanded={open} aria-controls={moreId} onClick={onToggle}>
          <span className="food-rv-more-label">{open ? 'Less' : 'More'}</span>
          {!open && assumptions.length > 0 && !compact && <span className="food-rv-more-summary">Assumed: {assumptions.join('; ')}</span>}
          <Icon name="chevronDown" size={15} strokeWidth={2.2} className="food-rv-more-chevron" />
        </button>
        {!open && !pendingKind && save.on && saveSwitch}
      </div>

      {open && (
        <div className="food-rv-detail" id={moreId}>
          {assumptions.length > 0 && <p className="food-rv-assume">Assumed: {assumptions.join('; ')}</p>}
          <ItemEditor item={item} unit={unit} disabled={disabled} autoFocus={editing} onChange={onChange} />
        </div>
      )}

      {(open || pendingKind) && (canWeb || canEstimate || save.show || pendingKind) && (
        <div className="food-rv-actions">
          {pendingKind ? (
            <>
              <span className="food-rv-act is-busy" role="status"><span className="spinner" aria-hidden="true" />{pendingKind === 'web' ? 'Searching the web…' : 'Estimating…'}</span>
              <button type="button" className="food-rv-act" onClick={onStop}>Stop</button>
            </>
          ) : (
            <>
              {canWeb && (
                <button type="button" className="food-rv-act" onClick={onSearchWeb} disabled={disabled} aria-label={`Search the web for exact numbers for ${name}`}>
                  <FoodGlyph name="globe" size={16} />Search the web
                </button>
              )}
              {canEstimate && (
                <button type="button" className="food-rv-act" onClick={onEstimateInstead} disabled={disabled} aria-label={`Estimate ${name} instead of using the saved numbers`}>
                  <Icon name="sparkles" size={16} />Estimate instead
                </button>
              )}
            </>
          )}
          {saveSwitch}
        </div>
      )}
      {note && <p className={`food-rv-webnote${note.error ? ' is-error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
    </li>
  )
}

// autoFocus: the item was opened by a tap on its name, so the name field takes focus.
function ItemEditor({ item, unit, disabled, autoFocus = false, onChange }) {
  const nameRef = useRef(null)
  useEffect(() => {
    if (autoFocus) nameRef.current?.focus({ preventScroll: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => onChange(editItem(item, patch))
  return (
    <div className="food-rv-editor">
      <label className="food-rv-field is-wide">
        <span>Name</span>
        <input
          ref={nameRef}
          className="food-rv-input"
          value={item.name || ''}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => onChange({ ...item, name: event.target.value, _base: { ...item._base, name: event.target.value }, _renamed: true })}
          autoComplete="off"
          enterKeyHint="done"
        />
      </label>
      {/* Kept to 0.01 kcal (not whole kcal) so kJ typed here converts back to the same number
          while typing; entries round to 0.1 kcal when saved. */}
      <NumField label={unitLabel(unit)} value={energyInUnit(item.calories, unit)} disabled={disabled} onCommit={(value) => set({ calories: value === null ? null : Math.round(energyToKcal(value, unit) * 100) / 100 })} />
      <NumField label="Protein g" value={item.proteinG} dp={1} disabled={disabled} onCommit={(value) => set({ proteinG: value })} />
      <NumField label="Carbs g" value={item.carbsG} dp={1} disabled={disabled} onCommit={(value) => set({ carbsG: value })} />
      <NumField label="Fat g" value={item.fatG} dp={1} disabled={disabled} onCommit={(value) => set({ fatG: value })} />
    </div>
  )
}

// A decimal field that keeps the typed text while focused and commits parseable values as they
// are typed (null when cleared).
export function NumField({ label, value, onCommit, dp = 0, disabled, className = '', placeholder }) {
  const format = (n) => (isNum(n) ? String(Math.round(n * 10 ** dp) / 10 ** dp) : '')
  const [text, setText] = useState(() => format(value))
  const focused = useRef(false)
  const committed = useRef(value)
  useEffect(() => {
    const same = committed.current === value || (isNum(value) && isNum(committed.current) && Math.abs(value - committed.current) < 10 ** -(dp + 1))
    if (!focused.current || !same) setText(format(value))
    committed.current = value
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const parse = (raw) => {
    if (!raw.trim()) return null
    const n = toNum(raw)
    return n === null || n < 0 ? undefined : n
  }
  return (
    <label className={`food-rv-field ${className}`}>
      <span>{label}</span>
      <input
        className="food-rv-input"
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={(event) => {
          focused.current = true
          event.target.select?.()
        }}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parse(event.target.value)
          if (parsed !== undefined) {
            committed.current = parsed
            onCommit(parsed)
          }
        }}
        onBlur={() => {
          focused.current = false
          setText(format(value))
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}

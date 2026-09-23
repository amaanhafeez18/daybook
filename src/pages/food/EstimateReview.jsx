import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addEntries, deleteEntry, estimateFood, itemsToEntries, useFood } from '../../lib/food/state.js'
import { energyInUnit, energyToKcal, entryCalories, scaleEntry } from '../../lib/food/nutrition.js'
import { amountLabel, confidenceLevel, dayLabel, energyNumber, fmtGrams, fmtNum, isMassUnit, isNum, isSubmitKey, mealName, toNum, unitLabel } from './format.js'
import './food-shared.css'

// Editable review of an AI estimate ("the plate"): per item a portion stepper that scales every
// number, kcal and P/C/F, confidence, assumptions, alternative chips, inline edits and remove;
// then the total, a "Fix…" line that re-runs the estimate with the current items as context, the
// model's clarifying question (answered in the same line) and the accuracy disclaimer.
//
// result: from prepareEstimate(). Each item keeps review bookkeeping in _-prefixed fields:
//   _k key · _base the item at portion factor 1 · _f the portion factor · _orig the numbers as
//   estimated (for the "As estimated" chip) · _opt the chosen alternative (index) or null.
// The item's own fields always hold the numbers as shown (scaleEntry(_base, _f)).

const NUMBER_FIELDS = ['calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg']
let keySeq = 0

const plain = (item) => Object.fromEntries(Object.entries(item || {}).filter(([key]) => !key.startsWith('_')))
const pickNumbers = (item) => Object.fromEntries(NUMBER_FIELDS.map((field) => [field, isNum(item[field]) ? item[field] : null]))

function prepareItem(raw) {
  const base = plain(raw)
  if (!Array.isArray(base.locked)) base.locked = []
  return { ...base, _k: `rv${++keySeq}`, _base: base, _f: 1, _orig: pickNumbers(base), _opt: null }
}

// estimateFood() result → review state. query: what the user typed or said (kept for the entries).
export function prepareEstimate(result, query) {
  const source = result && typeof result === 'object' ? result : {}
  const transcript = typeof source.transcript === 'string' ? source.transcript.trim() : ''
  return {
    items: (Array.isArray(source.items) ? source.items : []).map(prepareItem),
    clarify: source.clarify || null,
    notFood: source.notFood === true,
    transcript,
    query: (typeof query === 'string' && query.trim()) || transcript || '',
    removed: [],
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
export function canAutoLog(result) {
  const items = Array.isArray(result?.items) ? result.items : []
  return items.length > 0 && !result.clarify && !result.notFood && items.every((item) => isNum(item.confidence) && item.confidence >= 0.8)
}

// Saves the reviewed items as entries (replacing a name-only entry when given) with an Undo toast.
// Returns false when there was nothing to log.
export function logEstimate({ review, meal, date, source, replace, today, meals, unit }) {
  const items = reviewItems(review)
  const rows = itemsToEntries(items, { date, meal, source, query: review.query })
  if (!rows.length) return false
  const totals = reviewTotals(items)
  const what = items.length === 1 ? items[0].name || 'food' : `${items.length} items`
  const where = `${mealName(meals, meal)}${date !== today ? `, ${dayLabel(date, today)}` : ''}`
  const message = `Logged ${what} to ${where} · ${energyNumber(totals.calories, unit)} ${unitLabel(unit)}`
  if (replace?.id) {
    const undoDelete = deleteEntry(replace.id)
    const undoAdd = addEntries(rows)
    toast(message, { action: { label: 'Undo', onClick: () => { undoAdd(); undoDelete() } } })
  } else {
    addEntries(rows, { toastLabel: message })
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
  return { ...item, ...patch, locked, _base: base }
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

// onBusyChange(busy): told when a "Fix" request starts and ends, so the parent can hold its
// Save/Log button (logging mid-Fix would save the uncorrected items and drop the correction).
export default function EstimateReview({ result, onChange, meal, onMealChange, date, compact = false, meals, disabled = false, onBusyChange }) {
  const food = useFood()
  const unit = food.prefs.energyUnit
  const mealList = Array.isArray(meals) && meals.length ? meals : food.prefs.meals
  const [openKeys, setOpenKeys] = useState(() => new Set())
  const [editKey, setEditKey] = useState(null)
  const [fixText, setFixText] = useState('')
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState('')
  const fixRef = useRef(null)
  const fixId = useId()
  const busyRef = useRef(onBusyChange)
  busyRef.current = onBusyChange

  useEffect(() => () => fixRef.current?.abort(), [])
  useEffect(() => {
    busyRef.current?.(fixing)
  }, [fixing])
  // Unmounting mid-Fix aborts it; the parent shouldn't stay held.
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
  const busy = disabled || fixing

  const update = (patch) => onChange?.({ ...result, ...patch })
  const setItem = (key, next) => update({ items: items.map((item) => (item._k === key ? next : item)) })
  const toggle = (key) => setOpenKeys((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

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
      onChange?.(prepared)
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

  return (
    <div className={`food-rv${compact ? ' is-compact' : ''}`} aria-busy={fixing || undefined}>
      {compact && onMealChange && (
        <div className="food-rv-top">
          <MealSelect meals={mealList} value={meal} onChange={onMealChange} />
        </div>
      )}

      {result.query && !compact && <p className="food-rv-query">“{result.query}”</p>}

      {result.notFood && !items.length && (
        <p className="food-rv-note"><Icon name="info" size={16} />That doesn’t look like food. Describe what you ate, or try another photo.</p>
      )}
      {!result.notFood && !items.length && !result.clarify && (
        <p className="food-rv-note"><Icon name="info" size={16} />{lastRemoved ? 'No items left.' : 'No food found in that. Try describing it differently.'}</p>
      )}

      {items.length > 0 && (
        <ul className="food-rv-list">
          {items.map((item) => (
            <ReviewItem
              key={item._k}
              item={item}
              unit={unit}
              open={openKeys.has(item._k)}
              editing={editKey === item._k}
              disabled={busy}
              compact={compact}
              onToggle={() => toggle(item._k)}
              onEdit={() => {
                setOpenKeys((current) => new Set([...current, item._k]))
                setEditKey(item._k)
              }}
              onChange={(next) => setItem(item._k, next)}
              onRemove={() => removeItem(item)}
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

      <p className="food-rv-disclaimer">AI estimates can be off by 20% or more — adjust portions if you know them.</p>
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

function ReviewItem({ item, unit, open, editing, disabled, compact, onToggle, onEdit, onChange, onRemove }) {
  const level = confidenceLevel(item.confidence)
  const step = stepFor(item)
  const minusTarget = step.next(-1)
  const kcal = entryCalories(item)
  const hasKcal = isNum(item.calories) || kcal > 0
  const options = Array.isArray(item._base.options) ? item._base.options : []
  const assumptions = Array.isArray(item.assumptions) ? item.assumptions : []
  const name = item.name || 'Food'

  function applyOption(index) {
    const option = index === null ? null : options[index]
    const swapped = option ? Object.fromEntries(['calories', 'proteinG', 'carbsG', 'fatG'].filter((field) => isNum(option[field])).map((field) => [field, option[field]])) : {}
    const numbers = { ...item._orig, ...swapped }
    const base = { ...item._base, ...numbers }
    onChange(withFactor({ ...item, _base: base, _opt: index }, item._f))
  }

  return (
    <li className={`food-rv-item${level === 'low' ? ' is-low' : ''}${open ? ' is-open' : ''}`}>
      <div className="food-rv-head">
        <button type="button" className="food-rv-name" onClick={open ? onToggle : onEdit} aria-expanded={open} aria-label={`${name}${open ? '' : ' — edit'}`}>
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

      {level === 'low' && <p className="food-rv-check"><Icon name="alert" size={14} />Check the portion</p>}

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

      {!open && assumptions.length > 0 && !compact && (
        <button type="button" className="food-rv-assume is-collapsed" onClick={onToggle}>Assumed: {assumptions.join('; ')}</button>
      )}

      {open && (
        <div className="food-rv-detail">
          {assumptions.length > 0 && <p className="food-rv-assume">Assumed: {assumptions.join('; ')}</p>}
          {editing ? (
            <ItemEditor item={item} unit={unit} disabled={disabled} onChange={onChange} />
          ) : (
            <button type="button" className="food-rv-link food-rv-edit" onClick={onEdit} disabled={disabled}>
              <Icon name="pencil" size={14} />Edit name and numbers
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function ItemEditor({ item, unit, disabled, onChange }) {
  const nameRef = useRef(null)
  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true })
  }, [])
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
          onChange={(event) => onChange({ ...item, name: event.target.value, _base: { ...item._base, name: event.target.value } })}
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

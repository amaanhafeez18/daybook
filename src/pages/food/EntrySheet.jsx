import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button, IconButton } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { readPref, writePref } from '../../lib/api.js'
import { isISODate, todayISO } from '../../lib/dates.js'
import { energyInUnit, energyToKcal, findFavorite, macroCalories } from '../../lib/food/nutrition.js'
import { addEntries, deleteEntry, deleteFavorite, estimateFood, saveFavorite, updateEntry, useFood } from '../../lib/food/state.js'
import { dayLabel, energyNumber, entryName, fmtNum, isNum, mealIdFor, toNum, unitLabel } from './format.js'

// Manual add / edit with progressive disclosure (research §6.2): name, calories, meal and a
// favourite star first; then "Add portion"; "More details" for protein / carbs / fat; "Even more"
// for fiber, sugar, sodium, sat fat, alcohol, caffeine, brand, time, date and a note. The open
// level is remembered on this device (settings can force the macros open). "Estimate with AI"
// fills only the blank fields, sending the typed numbers as fixed.

const LEVEL_PREF = 'foodEntryLevel'
const UNITS = ['g', 'ml', 'oz', 'fl oz', 'cup', 'tbsp', 'tsp', 'piece', 'slice', 'serving', 'bowl', 'glass', 'can', 'small', 'medium', 'large']
const SCALED = ['calories', 'grams', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg', 'satFatG', 'alcoholG', 'caffeineMg']
const EXTRA_FIELDS = ['satFatG', 'alcoholG', 'caffeineMg']
const MORE_FIELDS = ['fiberG', 'sugarG', 'sodiumMg', 'satFatG', 'alcoholG', 'caffeineMg', 'brand', 'note']
const MACRO_FIELDS = ['proteinG', 'carbsG', 'fatG']

const text = (value) => (typeof value === 'string' ? value : '')
const numText = (value, dp = 1) => (isNum(value) ? String(Math.round(value * 10 ** dp) / 10 ** dp) : '')

function blankForm(defaults, meals) {
  return {
    name: text(defaults?.name),
    brand: '',
    calories: '',
    amount: '',
    unit: '',
    grams: '',
    proteinG: '',
    carbsG: '',
    fatG: '',
    fiberG: '',
    sugarG: '',
    sodiumMg: '',
    satFatG: '',
    alcoholG: '',
    caffeineMg: '',
    time: '',
    date: isISODate(defaults?.date) ? defaults.date : todayISO(),
    note: '',
    meal: mealIdFor(defaults?.meal || meals[0]?.id, meals),
  }
}

function formFromEntry(entry, unit, meals) {
  const extra = entry.extra && typeof entry.extra === 'object' ? entry.extra : {}
  const kcal = toNum(entry.calories)
  return {
    name: text(entry.name),
    brand: text(entry.brand),
    calories: kcal === null ? '' : String(Math.round(energyInUnit(kcal, unit))),
    amount: numText(toNum(entry.amount), 2),
    unit: text(entry.unit),
    grams: numText(toNum(entry.grams)),
    proteinG: numText(toNum(entry.proteinG)),
    carbsG: numText(toNum(entry.carbsG)),
    fatG: numText(toNum(entry.fatG)),
    fiberG: numText(toNum(entry.fiberG)),
    sugarG: numText(toNum(entry.sugarG)),
    sodiumMg: numText(toNum(entry.sodiumMg), 0),
    satFatG: numText(toNum(extra.satFatG)),
    alcoholG: numText(toNum(extra.alcoholG)),
    caffeineMg: numText(toNum(extra.caffeineMg), 0),
    time: text(entry.time),
    date: isISODate(entry.date) ? entry.date : todayISO(),
    note: text(entry.note),
    meal: mealIdFor(entry.meal, meals),
  }
}

// Numbers at the current amount, for proportional scaling when the amount changes.
function captureBase(form, unit) {
  const amount = toNum(form.amount)
  if (amount === null || amount <= 0) return null
  const values = {}
  for (const field of SCALED) {
    const value = toNum(form[field])
    if (value !== null) values[field] = field === 'calories' ? energyToKcal(value, unit) : value
  }
  return Object.keys(values).length ? { amount, values } : null
}

export default function EntrySheet({ open, onClose, entry = null, defaults, today }) {
  const food = useFood()
  const { meals, energyUnit: unit, showDetails } = food.prefs
  const [form, setForm] = useState(() => blankForm(defaults, meals))
  const [starChoice, setStarChoice] = useState(null) // null: follow whether it is a favorite
  const [portionOpen, setPortionOpen] = useState(false)
  const [level, setLevel] = useState(0)
  const [ai, setAi] = useState({ busy: false, info: null, error: '' })
  const baseRef = useRef(null)
  const aiRef = useRef(null)
  const formRef = useRef(form)
  formRef.current = form // the latest values, for the AI fill that lands after an await
  const ids = { name: useId(), cal: useId(), amount: useId(), unit: useId(), grams: useId(), date: useId(), time: useId(), note: useId(), brand: useId(), list: useId() }
  const editing = !!entry?.id
  const day = today || todayISO()

  // Reset whenever the sheet opens (or switches entry).
  useEffect(() => {
    if (!open) return
    aiRef.current?.abort()
    const next = entry ? formFromEntry(entry, unit, meals) : blankForm(defaults, meals)
    setForm(next)
    setStarChoice(null)
    setAi({ busy: false, info: null, error: '' })
    baseRef.current = captureBase(next, unit)
    setPortionOpen(!!(next.amount || next.unit || next.grams))
    const remembered = Number(readPref(LEVEL_PREF, 0)) || 0
    const filledMore = MORE_FIELDS.some((field) => next[field]) || (editing && next.time)
    const filledMacros = MACRO_FIELDS.some((field) => next[field])
    setLevel(Math.max(remembered, showDetails ? 1 : 0, filledMacros ? 1 : 0, filledMore ? 2 : 0))
  }, [open, entry?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => aiRef.current?.abort(), [])

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  // A nutrient typed directly moves the scaling base with it.
  function setNumber(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value }
      const base = baseRef.current
      const amount = toNum(next.amount)
      if (base && amount) {
        const n = toNum(value)
        const values = { ...base.values }
        if (n === null) delete values[field]
        else values[field] = ((field === 'calories' ? energyToKcal(n, unit) : n) * base.amount) / amount
        baseRef.current = { ...base, values }
      }
      return next
    })
  }

  // Changing the amount scales every number in proportion (when there is a base to scale from).
  function setAmount(value) {
    setForm((current) => {
      const next = { ...current, amount: value }
      const amount = toNum(value)
      const base = baseRef.current
      if (amount !== null && amount > 0 && base) {
        const factor = amount / base.amount
        for (const [field, baseValue] of Object.entries(base.values)) {
          const scaled = baseValue * factor
          next[field] = field === 'calories' ? String(Math.round(energyInUnit(scaled, unit))) : numText(scaled, field.endsWith('Mg') ? 0 : 1)
        }
      }
      return next
    })
  }

  // The numbers typed so far belong to the amount typed so far: scaling starts from there (set when
  // the amount field is left or stepped, so typing "12" doesn't scale from "1").
  function ensureBase() {
    if (!baseRef.current) baseRef.current = captureBase(form, unit)
  }

  function stepAmount(dir) {
    ensureBase()
    const amount = toNum(form.amount) ?? 0
    let target
    if (dir > 0) target = amount < 1 ? (amount < 0.5 ? 0.5 : 1) : Math.floor(amount + 1e-9) === amount ? amount + 1 : Math.ceil(amount * 2) / 2
    else target = amount <= 1 ? Math.max(0.25, amount - 0.25) : Math.floor(amount) === amount ? amount - 1 : Math.floor(amount * 2) / 2
    if (!toNum(form.amount) && dir > 0) target = 1
    setAmount(String(Math.round(target * 100) / 100))
  }

  const macroKcal = useMemo(() => macroCalories({
    proteinG: toNum(form.proteinG), carbsG: toNum(form.carbsG), fatG: toNum(form.fatG), fiberG: toNum(form.fiberG), extra: { alcoholG: toNum(form.alcoholG) },
  }), [form.proteinG, form.carbsG, form.fatG, form.fiberG, form.alcoholG])

  const typedCalories = toNum(form.calories)
  const kcal = typedCalories !== null ? energyToKcal(typedCalories, unit) : macroKcal
  const name = form.name.trim()
  const valid = !!name || (isNum(kcal) && kcal >= 0 && (typedCalories !== null || macroKcal !== null))
  const invalidNumber = SCALED.concat(['amount']).some((field) => form[field].trim() && (toNum(form[field]) === null || toNum(form[field]) < 0))
  const favorite = findFavorite(food.favorites, { name: form.name, brand: form.brand, favoriteId: entry?.favoriteId })
  const star = starChoice ?? !!favorite

  function openLevel(next) {
    setLevel(next)
    writePref(LEVEL_PREF, next)
  }

  function buildRow() {
    const number = (field) => {
      const value = toNum(form[field])
      return value === null || value < 0 ? null : value
    }
    const extra = { ...(entry?.extra && typeof entry.extra === 'object' ? entry.extra : {}) }
    for (const field of EXTRA_FIELDS) {
      const value = number(field)
      if (value === null) delete extra[field]
      else extra[field] = value
    }
    const row = {
      name: name || null,
      brand: form.brand.trim() || null,
      amount: number('amount'),
      unit: form.unit.trim() || null,
      grams: number('grams'),
      calories: typedCalories === null ? null : Math.round(energyToKcal(typedCalories, unit) * 10) / 10,
      proteinG: number('proteinG'),
      carbsG: number('carbsG'),
      fatG: number('fatG'),
      fiberG: number('fiberG'),
      sugarG: number('sugarG'),
      sodiumMg: number('sodiumMg'),
      extra,
      note: form.note.trim() || null,
      meal: form.meal,
      date: form.date,
      time: form.time || null,
    }
    if (ai.info && ai.info.filled.includes('calories')) {
      row.source = entry?.source && entry.source !== 'manual' && entry.source !== 'quick' ? entry.source : 'ai_text'
      row.ai = { query: ai.info.query, confidence: ai.info.confidence, assumptions: ai.info.assumptions }
    } else if (!editing) {
      row.source = name ? 'manual' : 'quick'
    }
    if (favorite && star) row.favoriteId = favorite.id
    return row
  }

  function save() {
    if (!valid || invalidNumber) return
    const row = buildRow()
    try {
      if (starChoice === true && !favorite && row.name) row.favoriteId = saveFavorite(row)?.id ?? null
      if (starChoice === false && favorite) deleteFavorite(favorite.id)
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
    if (editing) {
      const undo = updateEntry(entry.id, row)
      if (row.date !== entry.date) toast(`Moved to ${dayLabel(row.date, day)}`, { action: { label: 'Undo', onClick: undo } })
    } else {
      const label = row.name ? `Added ${row.name}` : 'Added'
      const energy = isNum(kcal) ? ` · ${energyNumber(kcal, unit)} ${unitLabel(unit)}` : ''
      addEntries([row], { toastLabel: `${label}${energy}` })
    }
    onClose()
  }

  function remove() {
    const undo = deleteEntry(entry.id)
    toast(`Deleted ${entryName(entry)}`, { action: { label: 'Undo', onClick: undo } })
    onClose()
  }

  // "Estimate with AI": the typed numbers go along as fixed; only blank fields are filled.
  async function estimate() {
    if (!name) {
      setAi((current) => ({ ...current, error: 'Add a name first, e.g. “chicken wrap”.' }))
      return
    }
    const parts = [name]
    if (form.brand.trim()) parts.push(`from ${form.brand.trim()}`)
    if (toNum(form.amount)) parts.push(`${form.amount} ${form.unit}`.trim())
    if (toNum(form.grams)) parts.push(`${form.grams} g`)
    if (typedCalories !== null) parts.push(`${Math.round(energyToKcal(typedCalories, unit))} calories`)
    for (const [field, label] of [['proteinG', 'protein'], ['carbsG', 'carbs'], ['fatG', 'fat']]) if (toNum(form[field]) !== null) parts.push(`${form[field]} g ${label}`)
    const query = parts.join(', ')
    const controller = new AbortController()
    aiRef.current?.abort()
    aiRef.current = controller
    setAi({ busy: true, info: null, error: '' })
    try {
      const result = await estimateFood({ text: query, meal: form.meal, date: form.date, signal: controller.signal })
      if (controller.signal.aborted) return
      const items = result.items
      if (!items.length) {
        setAi({ busy: false, info: null, error: result.clarify || (result.notFood ? 'That doesn’t look like food.' : 'Couldn’t estimate that — try a more specific name.') })
        return
      }
      const sum = (field) => {
        const values = items.map((item) => item[field]).filter(isNum)
        return values.length ? values.reduce((a, b) => a + b, 0) : null
      }
      const single = items.length === 1 ? items[0] : null
      const found = {
        calories: sum('calories'), proteinG: sum('proteinG'), carbsG: sum('carbsG'), fatG: sum('fatG'),
        fiberG: sum('fiberG'), sugarG: sum('sugarG'), sodiumMg: sum('sodiumMg'), grams: sum('grams'),
        alcoholG: items.map((item) => item.extra?.alcoholG).filter(isNum).reduce((a, b) => a + b, 0) || null,
        caffeineMg: items.map((item) => item.extra?.caffeineMg).filter(isNum).reduce((a, b) => a + b, 0) || null,
      }
      const filled = []
      const next = { ...formRef.current }
      for (const [field, value] of Object.entries(found)) {
        if (value === null || next[field].trim()) continue
        next[field] = field === 'calories' ? String(Math.round(energyInUnit(value, unit))) : numText(value, field.endsWith('Mg') ? 0 : 1)
        filled.push(field)
      }
      if (single && !next.amount.trim() && !next.unit.trim() && isNum(single.amount)) {
        next.amount = numText(single.amount, 2)
        next.unit = text(single.unit)
        filled.push('amount')
      }
      if (single?.brand && !next.brand.trim()) {
        next.brand = single.brand
        filled.push('brand')
      }
      setForm(next)
      baseRef.current = captureBase(next, unit)
      if (filled.some((field) => ['amount', 'grams'].includes(field))) setPortionOpen(true)
      if (filled.some((field) => MACRO_FIELDS.includes(field))) setLevel((current) => Math.max(current, 1))
      const confidences = items.map((item) => item.confidence).filter(isNum)
      setAi({
        busy: false,
        error: '',
        info: {
          query,
          filled,
          confidence: confidences.length ? Math.min(...confidences) : null,
          assumptions: items.flatMap((item) => item.assumptions || []).slice(0, 3),
        },
      })
    } catch (error) {
      if (error?.name === 'AbortError') return
      setAi({ busy: false, info: null, error: error?.message || 'Couldn’t estimate that right now.' })
    }
  }

  const saveLabel = editing
    ? 'Save'
    : isNum(kcal) && valid ? `Add ${energyNumber(kcal, unit)} ${unitLabel(unit)}` : 'Add'
  const macroPlaceholder = macroKcal !== null ? `≈ ${fmtNum(Math.round(energyInUnit(macroKcal, unit)))} from macros` : '0'

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit food' : defaults?.quick ? 'Quick calories' : 'Add food'}
      initialFocus={!editing}
      footer={(
        <>
          {editing && <IconButton icon="trash" label="Delete" className="food-es-delete" onClick={remove} />}
          <Button className="btn-grow" onClick={save} disabled={!valid || invalidNumber}>{saveLabel}</Button>
        </>
      )}
    >
      <form className="food-es" onSubmit={(event) => { event.preventDefault(); save() }}>
        <div className="food-es-name">
          <label htmlFor={ids.name} className="sr-only">Name</label>
          <input
            id={ids.name}
            className="input input-lg"
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="What did you eat? (optional)"
            maxLength={120}
            autoComplete="off"
            enterKeyHint="next"
            data-autofocus={!defaults?.quick || undefined}
          />
          <button
            type="button"
            className={`food-es-star${star ? ' is-on' : ''}`}
            aria-pressed={star}
            aria-label={star ? 'Remove from favorites' : 'Save as a favorite'}
            title={star ? 'Favorite' : 'Save as a favorite'}
            disabled={!name}
            onClick={() => setStarChoice(!star)}
          >
            <Icon name="star" size={22} />
          </button>
        </div>

        <div className="food-es-cal">
          <label htmlFor={ids.cal} className="food-es-label">Calories</label>
          <div className="food-es-cal-field">
            <input
              id={ids.cal}
              className="food-es-cal-input"
              inputMode="decimal"
              value={form.calories}
              onChange={(event) => setNumber('calories', event.target.value)}
              placeholder={macroPlaceholder}
              autoComplete="off"
              enterKeyHint="done"
              data-autofocus={defaults?.quick || undefined}
            />
            <span className="food-es-unit">{unitLabel(unit)}</span>
          </div>
        </div>

        <div className="food-es-meals" role="radiogroup" aria-label="Meal">
          {meals.map((meal) => (
            <button key={meal.id} type="button" role="radio" aria-checked={form.meal === meal.id} className={`chip chip-sm food-chip${form.meal === meal.id ? ' is-active' : ''}`} onClick={() => set('meal', meal.id)}>
              {meal.name}
            </button>
          ))}
        </div>

        {portionOpen ? (
          <div className="food-es-portion">
            <span className="food-es-label">Portion</span>
            <div className="food-es-portion-row">
              <span className="food-es-stepper" role="group" aria-label="Amount">
                <button type="button" aria-label="Less" onClick={() => stepAmount(-1)} disabled={!toNum(form.amount) || toNum(form.amount) <= 0.25}><Icon name="minus" size={16} strokeWidth={2.4} /></button>
                <input id={ids.amount} className="food-es-amount" inputMode="decimal" value={form.amount} onChange={(event) => setAmount(event.target.value)} onBlur={ensureBase} placeholder="1" aria-label="Amount" autoComplete="off" />
                <button type="button" aria-label="More" onClick={() => stepAmount(1)}><Icon name="plus" size={16} strokeWidth={2.4} /></button>
              </span>
              <input id={ids.unit} className="input food-es-unit-input" list={ids.list} value={form.unit} onChange={(event) => set('unit', event.target.value)} placeholder="unit" aria-label="Unit" autoComplete="off" maxLength={24} />
              <datalist id={ids.list}>{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
              <span className="food-es-grams">
                <input id={ids.grams} className="input" inputMode="decimal" value={form.grams} onChange={(event) => setNumber('grams', event.target.value)} placeholder="—" aria-label="Weight in grams" autoComplete="off" />
                <span>g</span>
              </span>
            </div>
            {baseRef.current && <p className="food-es-hint">Changing the amount scales the numbers.</p>}
          </div>
        ) : (
          <button type="button" className="food-es-disclose" onClick={() => setPortionOpen(true)}>
            <Icon name="plusCircle" size={18} />Add portion
          </button>
        )}

        {level >= 1 ? (
          <div className="food-es-group">
            <span className="food-es-label">Macros</span>
            <div className="food-es-grid is-3">
              <Num label="Protein" suffix="g" value={form.proteinG} onChange={(value) => setNumber('proteinG', value)} />
              <Num label="Carbs" suffix="g" value={form.carbsG} onChange={(value) => setNumber('carbsG', value)} />
              <Num label="Fat" suffix="g" value={form.fatG} onChange={(value) => setNumber('fatG', value)} />
            </div>
          </div>
        ) : (
          <button type="button" className="food-es-disclose" onClick={() => openLevel(1)}>
            More details<Icon name="chevronRight" size={16} />
          </button>
        )}

        {level >= 2 ? (
          <div className="food-es-group">
            <span className="food-es-label">More</span>
            <div className="food-es-grid is-3">
              <Num label="Fiber" suffix="g" value={form.fiberG} onChange={(value) => setNumber('fiberG', value)} />
              <Num label="Sugar" suffix="g" value={form.sugarG} onChange={(value) => setNumber('sugarG', value)} />
              <Num label="Sodium" suffix="mg" value={form.sodiumMg} onChange={(value) => setNumber('sodiumMg', value)} />
              <Num label="Sat fat" suffix="g" value={form.satFatG} onChange={(value) => setNumber('satFatG', value)} />
              <Num label="Alcohol" suffix="g" value={form.alcoholG} onChange={(value) => setNumber('alcoholG', value)} />
              <Num label="Caffeine" suffix="mg" value={form.caffeineMg} onChange={(value) => setNumber('caffeineMg', value)} />
            </div>
            <div className="food-es-grid is-2">
              <label className="food-es-field is-wide" htmlFor={ids.brand}>
                <span>Brand</span>
                <input id={ids.brand} className="input" value={form.brand} onChange={(event) => set('brand', event.target.value)} maxLength={80} autoComplete="off" />
              </label>
              <label className="food-es-field" htmlFor={ids.time}>
                <span>Time</span>
                <input id={ids.time} type="time" className="input" value={form.time} onChange={(event) => set('time', event.target.value)} />
              </label>
              <label className="food-es-field" htmlFor={ids.date}>
                <span>Date</span>
                <input id={ids.date} type="date" className="input" value={form.date} onChange={(event) => isISODate(event.target.value) && set('date', event.target.value)} />
              </label>
              <label className="food-es-field is-wide" htmlFor={ids.note}>
                <span>Note</span>
                <textarea id={ids.note} className="input textarea" rows={2} value={form.note} onChange={(event) => set('note', event.target.value)} maxLength={1000} />
              </label>
            </div>
          </div>
        ) : level >= 1 ? (
          <button type="button" className="food-es-disclose" onClick={() => openLevel(2)}>
            Even more<Icon name="chevronRight" size={16} />
          </button>
        ) : null}

        <div className="food-es-ai">
          <button type="button" className="food-es-ai-btn" onClick={ai.busy ? () => { aiRef.current?.abort(); setAi({ busy: false, info: null, error: '' }) } : estimate}>
            {ai.busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="wand" size={18} />}
            {ai.busy ? 'Estimating… tap to stop' : 'Estimate with AI'}
          </button>
          {ai.info && (
            <p className="food-es-ai-note" role="status">
              {ai.info.filled.length ? `Filled ${ai.info.filled.length} blank field${ai.info.filled.length === 1 ? '' : 's'} with an estimate.` : 'Nothing blank to fill.'}
              {ai.info.assumptions.length > 0 && ` Assumed: ${ai.info.assumptions.join('; ')}.`}
            </p>
          )}
          {ai.error && <p className="food-es-ai-note is-error" role="alert">{ai.error}</p>}
        </div>

        {!valid && Object.entries(form).some(([field, value]) => !['date', 'meal', 'name', 'calories', 'time'].includes(field) && value) && <p className="food-es-hint">Add a name or calories to save.</p>}
        {invalidNumber && <p className="food-es-hint is-error" role="alert">Numbers can’t be negative or contain letters.</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  )
}

function Num({ label, suffix, value, onChange }) {
  const id = useId()
  return (
    <label className="food-es-field" htmlFor={id}>
      <span>{label}</span>
      <span className="food-es-num">
        <input id={id} className="input" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="—" autoComplete="off" enterKeyHint="done" />
        <span aria-hidden="true">{suffix}</span>
      </span>
    </label>
  )
}

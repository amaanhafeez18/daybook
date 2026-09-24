import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Disclosure from '../../components/ui/Disclosure.jsx'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button, EmptyState, IconButton, Skeleton } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { energyInUnit, energyToKcal, entryCalories } from '../../lib/food/nutrition.js'
import { deleteFavorite, rememberFoods, updateFavorite, useFood } from '../../lib/food/state.js'
import { DetailTop, MigrationNote, SwipeRow } from './common.jsx'
import { FoodGlyph, fmtSavedDay, hostOf, safeUrl } from './EstimateReview.jsx'
import { quickLog } from './QuickAddBar.jsx'
import { defaultMeal, energyNumber, entryName, fmtGrams, isNum, portionText, toNum, unitLabel } from './format.js'

// #/food/foods: "My foods" (settings.food.favorites) — foods saved with their exact numbers from a
// nutrition label, a barcode, the web, a starred entry or typed in, which the estimate reuses when
// the food is mentioned again. Search, tap to edit (name, portion and calories first; brand,
// macros, other nutrients, other names, barcode and where the numbers came from under "More
// details"), swipe or Delete with Undo, and "Log" to add one to today.

const PAGE = 50
const UNITS = ['g', 'ml', 'oz', 'fl oz', 'cup', 'tbsp', 'tsp', 'piece', 'slice', 'serving', 'bar', 'scoop', 'bowl', 'glass', 'can', 'bottle', 'pack']
const NUMBER_FIELDS = ['amount', 'grams', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg']
const DETAIL_FIELDS = ['brand', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg', 'aliases', 'barcode']

// Where a saved food's numbers came from, for its badge: { icon, text, url? }. Older favorites
// (starred before My foods) have no source.
export function savedBadge(food) {
  const url = safeUrl(food?.sourceUrl)
  const glyph = (name) => <FoodGlyph name={name} size={12} strokeWidth={2} />
  const icon = (name) => <Icon name={name} size={12} strokeWidth={2} />
  switch (food?.source) {
    case 'label': return { icon: icon('fileText'), text: 'Label', url }
    case 'barcode': return { icon: glyph('barcode'), text: 'Barcode', url }
    case 'web': return { icon: glyph('globe'), text: url && hostOf(url) ? `Web · ${hostOf(url)}` : 'Web', url }
    case 'user': return { icon: icon('pencil'), text: 'Your numbers', url }
    case 'estimate': return { icon: icon('sparkles'), text: 'Estimate', url }
    case 'entry': return { icon: icon('history'), text: 'From your log', url }
    default: return { icon: icon('star'), text: 'Starred', url }
  }
}

function matches(food, query) {
  if (!query) return true
  const digits = query.replace(/[\s-]/g, '')
  if (/^\d{4,}$/.test(digits) && typeof food.barcode === 'string' && food.barcode.includes(digits)) return true
  return [food.name, food.brand, ...(food.aliases || [])].filter(Boolean).join(' ').toLowerCase().includes(query)
}

export default function MyFoodsView({ today, loaded }) {
  const food = useFood()
  const { meals, energyUnit: unit } = food.prefs
  const favorites = food.favorites
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [editing, setEditing] = useState(null) // { food } (null food: a new one) while the sheet is open
  // The sheet keeps showing what it opened with while it slides away.
  const lastEditing = useRef(null)
  if (editing) lastEditing.current = editing
  const q = query.trim().toLowerCase()
  const list = useMemo(() => favorites.filter((item) => matches(item, q)), [favorites, q])

  useEffect(() => setShown(PAGE), [q])

  function remove(item) {
    const undo = deleteFavorite(item.id)
    toast(`Removed ${entryName(item)} from My foods`, { action: { label: 'Undo', onClick: undo } })
  }

  function log(item) {
    quickLog(item, { meal: defaultMeal(meals), date: today, favorites, meals, unit, today })
  }

  return (
    <div className="food-myfoods">
      <DetailTop>
        <Button size="sm" icon="plus" onClick={() => setEditing({ food: null })} disabled={!loaded}>Add</Button>
      </DetailTop>
      <header className="food-page-head">
        <h1>My foods</h1>
        <p className="page-subtitle">Exact numbers from labels, barcodes and the web — used again when you mention the food.</p>
      </header>
      <MigrationNote />

      {!loaded ? (
        <section className="card"><Skeleton lines={5} /></section>
      ) : !favorites.length ? (
        <section className="card">
          <EmptyState icon="bookmark" title="No saved foods yet" action={<Button icon="plus" onClick={() => setEditing({ food: null })}>Add a food</Button>}>
            Foods you save keep their exact numbers, so next time you mention one, those numbers are used. Star a food when you log it, keep a label, barcode or web lookup, or add one here.
          </EmptyState>
        </section>
      ) : (
        <>
          {(favorites.length > 5 || query) && (
            <label className="search-field search-field-wide food-my-search">
              <Icon name="search" size={18} />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search my foods" aria-label="Search my foods" autoComplete="off" enterKeyHint="search" />
            </label>
          )}
          <div className="food-section-head">
            <h2 id="food-my-title">{q ? 'Matches' : 'Saved'}</h2>
            <span className="food-section-count">{list.length}</span>
          </div>
          {list.length ? (
            <ul className="card-list food-list food-my-list" aria-labelledby="food-my-title">
              {list.slice(0, shown).map((item) => (
                <SavedRow key={item.id} item={item} unit={unit} onEdit={() => setEditing({ food: item })} onDelete={() => remove(item)} onLog={() => log(item)} />
              ))}
            </ul>
          ) : (
            <p className="food-my-empty">No saved foods match “{query.trim()}”.</p>
          )}
          {list.length > shown && (
            <button type="button" className="food-more-btn" onClick={() => setShown((value) => value + PAGE)}>Show more</button>
          )}
        </>
      )}

      <SavedFoodSheet open={!!editing} food={(editing || lastEditing.current)?.food || null} unit={unit} onClose={() => setEditing(null)} />
    </div>
  )
}

function SavedRow({ item, unit, onEdit, onDelete, onLog }) {
  const name = entryName(item)
  const kcal = entryCalories(item)
  const portion = portionText(item)
  const badge = savedBadge(item)
  const day = fmtSavedDay(item.verifiedAt || item.updatedAt)
  const macros = [item.proteinG, item.carbsG, item.fatG].some(isNum)
    ? `P ${fmtGrams(item.proteinG ?? 0)} · C ${fmtGrams(item.carbsG ?? 0)} · F ${fmtGrams(item.fatG ?? 0)}`
    : null
  return (
    <SwipeRow className="food-row" onDelete={onDelete}>
      <div className="food-row-inner">
        <button type="button" className="food-row-main food-my-main" onClick={onEdit} aria-label={`${name}${kcal > 0 ? `, ${energyNumber(kcal, unit)} ${unitLabel(unit)}` : ''}. Edit`}>
          <span className="food-row-text">
            <span className="food-row-name">{name}</span>
            {/* The portion (and brand, macros) first; where the numbers came from on its own line,
                so a long badge never squeezes "2 slices" out at phone width. */}
            {(portion || item.brand || macros) && (
              <span className="food-row-sub">
                {portion && <span className="food-my-portion">{portion}</span>}
                {item.brand && <span>{item.brand}</span>}
                {macros && <span>{macros}</span>}
              </span>
            )}
            <span className="food-row-sub"><span className="food-badge food-my-badge">{badge.icon}{badge.text}{day ? `, ${day}` : ''}</span></span>
          </span>
          <span className={`food-row-kcal${kcal > 0 ? '' : ' is-empty'}`}>
            {kcal > 0 ? <>{energyNumber(kcal, unit)} <small>{unitLabel(unit)}</small></> : '—'}
          </span>
        </button>
        <button type="button" className="food-my-log" onClick={onLog} aria-label={`Log ${name} now`}>
          <Icon name="plus" size={14} strokeWidth={2.6} />Log
        </button>
      </div>
    </SwipeRow>
  )
}

// ---- edit / add sheet ------------------------------------------------------------------------------

const numText = (value, dp = 1) => (isNum(value) ? String(Math.round(value * 10 ** dp) / 10 ** dp) : '')
const str = (value) => (typeof value === 'string' ? value : '')

function formFrom(food, unit) {
  const kcal = toNum(food?.calories)
  return {
    name: str(food?.name),
    brand: str(food?.brand),
    amount: numText(toNum(food?.amount), 2),
    unit: str(food?.unit),
    grams: numText(toNum(food?.grams)),
    calories: kcal === null ? '' : String(Math.round(energyInUnit(kcal, unit))),
    proteinG: numText(toNum(food?.proteinG)),
    carbsG: numText(toNum(food?.carbsG)),
    fatG: numText(toNum(food?.fatG)),
    fiberG: numText(toNum(food?.fiberG)),
    sugarG: numText(toNum(food?.sugarG)),
    sodiumMg: numText(toNum(food?.sodiumMg), 0),
    aliases: Array.isArray(food?.aliases) ? food.aliases.join(', ') : '',
    barcode: str(food?.barcode),
  }
}

// The source line: "From a nutrition label · Sep 23" (with a link to the page it came from).
function SourceNote({ food }) {
  if (!food) return null
  const url = safeUrl(food.sourceUrl) || (food.source === 'barcode' && food.barcode ? `https://world.openfoodfacts.org/product/${food.barcode}` : null)
  const what = {
    label: 'From a nutrition label',
    barcode: 'From Open Food Facts (barcode)',
    web: 'From the web',
    user: 'Numbers you entered',
    estimate: 'From an AI estimate',
    entry: 'Saved from your log',
  }[food.source] || 'Starred when it was logged'
  const day = fmtSavedDay(food.verifiedAt || food.updatedAt)
  const badge = savedBadge(food)
  return (
    <p className="food-my-source">
      {badge.icon}
      <span>
        {what}{day ? ` · ${day}` : ''}
        {url && (
          <>
            {' · '}
            <a href={url} target="_blank" rel="noopener noreferrer">{hostOf(url) || 'Source'}<span className="sr-only"> (opens in a new tab)</span></a>
          </>
        )}
      </span>
    </p>
  )
}

function SavedFoodSheet({ open, food, unit, onClose }) {
  const [form, setForm] = useState(() => formFrom(food, unit))
  const [error, setError] = useState('')
  // Bumped each time the sheet opens, so "More details" mounts again and opens (or not) around
  // the food it now shows rather than keeping the last one's state.
  const [discKey, setDiscKey] = useState(0)
  const ids = { name: useId(), brand: useId(), amount: useId(), unit: useId(), grams: useId(), cal: useId(), aliases: useId(), barcode: useId(), list: useId() }
  const editing = !!food?.id

  useEffect(() => {
    if (!open) return
    setForm(formFrom(food, unit))
    setError('')
    setDiscKey((value) => value + 1)
  }, [open, food?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
    setError('')
  }
  const number = (field) => {
    const value = toNum(form[field])
    return value === null || value < 0 ? null : value
  }
  const invalid = NUMBER_FIELDS.some((field) => form[field].trim() && (toNum(form[field]) === null || toNum(form[field]) < 0))
  const barcode = form.barcode.replace(/[\s-]/g, '')
  const badBarcode = !!barcode && !/^\d{6,14}$/.test(barcode)
  const name = form.name.trim()
  // What "More details" holds, for its closed summary and for opening it by itself.
  const hasDetails = DETAIL_FIELDS.some((field) => form[field].trim())
  const macroLine = [['proteinG', 'P'], ['carbsG', 'C'], ['fatG', 'F']].filter(([field]) => form[field].trim()).map(([field, letter]) => `${letter} ${form[field].trim()}`).join(' · ')
  const aliasCount = form.aliases.split(/[,\n]/).map((alias) => alias.trim()).filter(Boolean).length
  const detailLine = [
    form.brand.trim(),
    macroLine,
    [['fiberG', 'Fiber'], ['sugarG', 'Sugar'], ['sodiumMg', 'Sodium']].filter(([field]) => form[field].trim()).map(([, label]) => label).join(', '),
    aliasCount ? `${aliasCount} other name${aliasCount === 1 ? '' : 's'}` : '',
    barcode ? 'barcode' : '',
  ].filter(Boolean).join(' · ')

  function save() {
    if (!name || invalid || badBarcode) return
    const typedKcal = number('calories')
    const values = {
      name,
      brand: form.brand.trim() || null,
      amount: number('amount'),
      unit: form.unit.trim() || null,
      grams: number('grams'),
      calories: typedKcal === null ? null : Math.round(energyToKcal(typedKcal, unit) * 10) / 10,
      proteinG: number('proteinG'),
      carbsG: number('carbsG'),
      fatG: number('fatG'),
      fiberG: number('fiberG'),
      sugarG: number('sugarG'),
      sodiumMg: number('sodiumMg'),
    }
    const aliases = form.aliases.split(/[,\n]/).map((alias) => alias.trim()).filter(Boolean)
    const now = new Date().toISOString()
    try {
      if (editing) {
        // Numbers changed by hand are the owner's own from now on.
        const changed = ['amount', 'grams', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg'].some((field) => {
          const before = isNum(food[field]) ? food[field] : null
          const after = values[field]
          return before === null || after === null ? before !== after : Math.abs(before - after) > (field === 'calories' ? 0.5 : 0.05)
        })
        const undo = updateFavorite(food.id, {
          ...values,
          aliases,
          barcode: barcode || null,
          ...(changed ? { source: 'user', verifiedAt: now } : {}),
        })
        toast(`Updated ${name}`, { action: { label: 'Undo', onClick: undo } })
      } else {
        const undo = rememberFoods([{ food: { ...values, aliases }, source: 'user', verifiedAt: now, ...(barcode ? { barcode } : {}) }])
        toast(`Saved ${name} to My foods`, { action: { label: 'Undo', onClick: undo } })
      }
      onClose()
    } catch (err) {
      setError(err?.message || 'Couldn’t save that.')
    }
  }

  function remove() {
    if (!food?.id) return
    const undo = deleteFavorite(food.id)
    toast(`Removed ${entryName(food)} from My foods`, { action: { label: 'Undo', onClick: undo } })
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit saved food' : 'Add to My foods'}
      initialFocus={!editing}
      footer={(
        <>
          {editing && <IconButton icon="trash" label="Delete from My foods" className="food-es-delete" onClick={remove} />}
          <Button className="btn-grow" onClick={save} disabled={!name || invalid || badBarcode}>{editing ? 'Save' : 'Add to My foods'}</Button>
        </>
      )}
    >
      <form className="food-es food-my-form" onSubmit={(event) => { event.preventDefault(); save() }}>
        <label className="food-es-field is-wide" htmlFor={ids.name}>
          <span>Name</span>
          <input id={ids.name} className="input" value={form.name} onChange={(event) => set('name', event.target.value)} maxLength={120} autoComplete="off" enterKeyHint="next" placeholder="e.g. Protein bar" data-autofocus={!editing || undefined} />
        </label>

        <div className="food-es-group">
          <span className="food-es-label">Portion</span>
          <div className="food-es-grid is-3">
            <label className="food-es-field" htmlFor={ids.amount}>
              <span>Amount</span>
              <input id={ids.amount} className="input" inputMode="decimal" value={form.amount} onChange={(event) => set('amount', event.target.value)} placeholder="1" autoComplete="off" enterKeyHint="next" />
            </label>
            <label className="food-es-field" htmlFor={ids.unit}>
              <span>Unit</span>
              <input id={ids.unit} className="input" list={ids.list} value={form.unit} onChange={(event) => set('unit', event.target.value)} placeholder="serving" maxLength={24} autoComplete="off" enterKeyHint="next" />
              <datalist id={ids.list}>{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
            </label>
            <Num label="Weight" suffix="g" value={form.grams} onChange={(value) => set('grams', value)} />
          </div>
        </div>

        <div className="food-es-group">
          <Num label={`Calories for this portion`} suffix={unitLabel(unit)} value={form.calories} onChange={(value) => set('calories', value)} wide />
        </div>

        <Disclosure key={discKey} id="food-saved-more" label="More details" summary={detailLine || 'Brand, protein, carbs, fat, other names, barcode'} hasValues={hasDetails} className="food-my-more">
          <label className="food-es-field is-wide" htmlFor={ids.brand}>
            <span>Brand</span>
            <input id={ids.brand} className="input" value={form.brand} onChange={(event) => set('brand', event.target.value)} maxLength={80} autoComplete="off" enterKeyHint="next" placeholder="Optional" />
          </label>

          <div className="food-es-group">
            <span className="food-es-label">Nutrition for this portion</span>
            <div className="food-es-grid is-3">
              <Num label="Protein" suffix="g" value={form.proteinG} onChange={(value) => set('proteinG', value)} />
              <Num label="Carbs" suffix="g" value={form.carbsG} onChange={(value) => set('carbsG', value)} />
              <Num label="Fat" suffix="g" value={form.fatG} onChange={(value) => set('fatG', value)} />
              <Num label="Fiber" suffix="g" value={form.fiberG} onChange={(value) => set('fiberG', value)} />
              <Num label="Sugar" suffix="g" value={form.sugarG} onChange={(value) => set('sugarG', value)} />
              <Num label="Sodium" suffix="mg" value={form.sodiumMg} onChange={(value) => set('sodiumMg', value)} />
            </div>
          </div>

          <div className="food-es-group">
            <label className="food-es-label" htmlFor={ids.aliases}>Other names</label>
            <input id={ids.aliases} className="input" value={form.aliases} onChange={(event) => set('aliases', event.target.value)} placeholder="e.g. my usual bar, quest bar" autoComplete="off" enterKeyHint="next" />
            <p className="food-es-hint">Separate with commas. Mentioning any of these uses this food’s numbers.</p>
          </div>

          <div className="food-es-group">
            <label className="food-es-label" htmlFor={ids.barcode}>Barcode</label>
            <input id={ids.barcode} className="input" inputMode="numeric" value={form.barcode} onChange={(event) => set('barcode', event.target.value)} placeholder="Optional" maxLength={20} autoComplete="off" enterKeyHint="done" />
            {badBarcode && <p className="food-es-hint is-error" role="alert">A barcode is 6 to 14 digits.</p>}
          </div>

          {editing && <SourceNote food={food} />}
        </Disclosure>

        {!name && <p className="food-es-hint">Add a name to save.</p>}
        {invalid && <p className="food-es-hint is-error" role="alert">Numbers can’t be negative or contain letters.</p>}
        {error && <p className="food-es-hint is-error" role="alert">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  )
}

function Num({ label, suffix, value, onChange, wide = false }) {
  const id = useId()
  return (
    <label className={`food-es-field${wide ? ' food-my-energy' : ''}`} htmlFor={id}>
      <span>{label}</span>
      <span className="food-es-num">
        <input id={id} className="input" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="—" autoComplete="off" enterKeyHint="done" />
        <span aria-hidden="true">{suffix}</span>
      </span>
    </label>
  )
}

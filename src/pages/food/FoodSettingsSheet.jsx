import { useId, useRef, useState } from 'react'
import Disclosure from '../../components/ui/Disclosure.jsx'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { IconButton, Segmented, Switch } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { updateGym, useGym } from '../../lib/gym/state.js'
import { MEALS_DEFAULT, entryCalories } from '../../lib/food/nutrition.js'
import { deleteFavorite, setWebSetting, updateFood, useFood, useWebSetting } from '../../lib/food/state.js'
import { navigate } from '../../lib/router.js'
import { NUTRIENT_INFO, energyNumber, entryName, fmtEnergy, fmtInt, portionText, unitLabel } from './format.js'

// Food settings. Basics: goals (link), meals (rename, reorder, 3–6; a disclosure that shows the
// names while closed) and units. Everything else sits in an "Advanced" disclosure that remembers
// whether it was left open: which nutrients show, the ring, week start, the Add food sheet's
// default, AI review, web search (settings.assistantWeb, shared with the assistant) and My foods
// (link + the saved list). The weight unit is the gym's (one setting).

const ENERGY_UNITS = [{ id: 'kcal', label: 'kcal' }, { id: 'kJ', label: 'kJ' }]
const WEIGHT_UNITS = [{ id: 'kg', label: 'kg' }, { id: 'lb', label: 'lb' }]
const RING_MODES = [{ id: 'remaining', label: 'Left' }, { id: 'eaten', label: 'Eaten' }]
const WEEK_STARTS = [{ id: 1, label: 'Mon' }, { id: 0, label: 'Sun' }, { id: 6, label: 'Sat' }]
const AI_REVIEW = [{ id: 'always', label: 'Always review' }, { id: 'autoHigh', label: 'Auto-log if sure' }]
const WEB_MODES = [{ id: 'ask', label: 'Ask first' }, { id: 'always', label: 'Always' }, { id: 'off', label: 'Off' }]
const WEB_NOTES = {
  ask: 'Used for exact macros of branded foods. Each search costs a little, so it only runs when you tap Search the web.',
  always: 'Used for exact macros of branded foods. Each search costs a little; it may run without asking when exact numbers would help.',
  off: 'Never searches the web. Your saved foods still apply.',
}
const FAVORITES_SHOWN = 10

function setPrefs(patch) {
  updateFood((food) => ({ prefs: { ...food.prefs, ...patch } }))
}

function Group({ title, footer, children }) {
  return (
    <section className="food-cfg-group">
      {title && <h3 className="food-cfg-title">{title}</h3>}
      <div className="food-cfg-card">{children}</div>
      {footer && <p className="food-cfg-foot">{footer}</p>}
    </section>
  )
}

function Row({ label, hint, children, stacked = false }) {
  return (
    <div className={`food-cfg-row${stacked ? ' is-stacked' : ''}`}>
      <span className="food-cfg-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <span className="food-cfg-control">{children}</span>
    </div>
  )
}

export default function FoodSettingsSheet({ open, onClose }) {
  const food = useFood()
  const gym = useGym()
  const web = useWebSetting()
  const { prefs, goals, favorites } = food
  const saved = favorites.filter((favorite) => ['label', 'barcode', 'web', 'user'].includes(favorite.source)).length
  const unit = prefs.energyUnit
  const weightUnit = gym.prefs.unit === 'lb' ? 'lb' : 'kg'
  const goalParts = [
    goals.calories ? fmtEnergy(goals.calories, unit) : null,
    goals.protein ? `P ${fmtInt(goals.protein)}` : null,
    goals.carbs ? `C ${fmtInt(goals.carbs)}` : null,
    goals.fat ? `F ${fmtInt(goals.fat)}` : null,
  ].filter(Boolean)

  function toggleNutrient(key) {
    const has = prefs.nutrients.includes(key)
    const next = has ? prefs.nutrients.filter((item) => item !== key) : Object.keys(NUTRIENT_INFO).filter((item) => item === key || prefs.nutrients.includes(item))
    setPrefs({ nutrients: next })
  }

  function removeFavorite(favorite) {
    const undo = deleteFavorite(favorite.id)
    toast(`Removed ${entryName(favorite)} from My foods`, { action: { label: 'Undo', onClick: undo } })
  }

  const mealNames = prefs.meals.map((meal) => meal.name).join(' · ')
  const nutrientNames = Object.values(NUTRIENT_INFO).filter((info) => prefs.nutrients.includes(info.key)).map((info) => info.label).join(', ') || 'none'
  const webLabel = WEB_MODES.find((mode) => mode.id === web)?.label || 'Ask first'
  const advancedSummary = `${nutrientNames} · ${prefs.aiReview === 'autoHigh' ? 'Auto-log if sure' : 'Always review'} · Web: ${webLabel.toLowerCase()}`

  return (
    <Sheet open={open} onClose={onClose} title="Food settings" initialFocus={false}>
      <div className="food-cfg">
        <Group title="Basics">
          <button type="button" className="food-cfg-row food-cfg-link" onClick={() => { onClose(); navigate('food/goals') }}>
            <span className="food-cfg-label">
              <span>Daily goals</span>
              <small>{goalParts.length ? goalParts.join(' · ') : 'Not set — calculate or enter your own'}</small>
            </span>
            <Icon name="chevronRight" size={18} />
          </button>
          <div className="food-cfg-row is-disclosure">
            <Disclosure id="food-settings-meals" label="Meals" summary={mealNames}>
              <MealsEditor meals={prefs.meals} />
              <p className="food-cfg-foot food-cfg-foot-inset">Tap a name to rename it. Use 3 to 6 meals; food logged in a removed meal shows under Snacks (or your last meal).</p>
            </Disclosure>
          </div>
          <Row label="Energy"><Segmented options={ENERGY_UNITS} value={unit} onChange={(value) => setPrefs({ energyUnit: value })} label="Energy unit" /></Row>
          <Row label="Body weight" hint="Shared with Gym"><Segmented options={WEIGHT_UNITS} value={weightUnit} onChange={(value) => updateGym((g) => ({ prefs: { ...g.prefs, unit: value } }))} label="Weight unit" /></Row>
        </Group>

        <section className="food-cfg-group food-cfg-advanced">
          <Disclosure id="food-settings-advanced" label="Advanced" summary={advancedSummary}>
            <Group title="Display">
              <Row label="Ring shows"><Segmented options={RING_MODES} value={prefs.ring} onChange={(value) => setPrefs({ ring: value })} label="Ring shows" /></Row>
              <Row label="Week starts"><Segmented options={WEEK_STARTS} value={prefs.weekStart} onChange={(value) => setPrefs({ weekStart: value })} label="Week starts on" /></Row>
              <div className="food-cfg-row is-switch">
                <Switch checked={prefs.showDetails} onChange={(value) => setPrefs({ showDetails: value })} label="Open with portion and macros" description="The Add food sheet starts with More options open" />
              </div>
            </Group>

            <Group title="Nutrients shown" footer="Shown under the ring and on the Insights page. Protein, carbs and fat count toward calories; sugar and sodium goals are limits.">
              <div className="food-cfg-row is-chips">
                {Object.values(NUTRIENT_INFO).map((info) => {
                  const on = prefs.nutrients.includes(info.key)
                  return (
                    <button key={info.key} type="button" className={`chip chip-sm food-chip${on ? ' is-active' : ''}`} aria-pressed={on} onClick={() => toggleNutrient(info.key)}>
                      {on && <Icon name="check" size={14} strokeWidth={2.6} />}{info.label}
                    </button>
                  )
                })}
              </div>
            </Group>

            <Group title="AI estimates" footer={prefs.aiReview === 'autoHigh' ? 'Estimates where every item is at least 80% sure are logged straight away, with Undo.' : 'Every AI estimate opens for review before it’s logged.'}>
              <Row label="After an estimate" stacked>
                <Segmented options={AI_REVIEW} value={prefs.aiReview} onChange={(value) => setPrefs({ aiReview: value })} label="AI estimates" />
              </Row>
            </Group>

            <Group title="Web search" footer={WEB_NOTES[web]}>
              <Row label="Look up exact numbers online" hint="Shared with the assistant" stacked>
                <Segmented options={WEB_MODES} value={web} onChange={setWebSetting} label="Web search" />
              </Row>
            </Group>

            <Group title={`My foods${favorites.length ? ` (${favorites.length})` : ''}`} footer="Foods you star, and labels, barcodes and web lookups you log, are saved with their exact numbers and used again when you mention the food.">
              <button type="button" className="food-cfg-row food-cfg-link" onClick={() => { onClose(); navigate('food/foods') }}>
                <span className="food-cfg-label">
                  <span>Open My foods</span>
                  <small>{favorites.length ? `${favorites.length} saved${saved ? ` · ${saved} with exact numbers` : ''}` : 'Nothing saved yet'}</small>
                </span>
                <Icon name="chevronRight" size={18} />
              </button>
              {favorites.length > 0 && (
                <ul className="food-cfg-favs">
                  {favorites.slice(0, FAVORITES_SHOWN).map((favorite) => {
                    const kcal = entryCalories(favorite)
                    const portion = portionText(favorite)
                    return (
                      <li key={favorite.id} className="food-cfg-row">
                        <span className="food-cfg-label">
                          <span>{entryName(favorite)}</span>
                          <small>{[portion, kcal > 0 ? `${energyNumber(kcal, unit)} ${unitLabel(unit)}` : null].filter(Boolean).join(' · ') || 'No calories'}</small>
                        </span>
                        <IconButton icon="trash" label={`Remove ${entryName(favorite)} from My foods`} className="food-cfg-remove" size={18} onClick={() => removeFavorite(favorite)} />
                      </li>
                    )
                  })}
                </ul>
              )}
              {favorites.length > FAVORITES_SHOWN && (
                <button type="button" className="food-cfg-row food-cfg-link" onClick={() => { onClose(); navigate('food/foods') }}>
                  <span className="food-cfg-label"><span>See all {favorites.length} in My foods</span></span>
                  <Icon name="chevronRight" size={18} />
                </button>
              )}
            </Group>
          </Disclosure>
        </section>

        <p className="food-cfg-note">
          <Icon name="info" size={16} />
          <span>Not for medical nutrition therapy (for example diabetes carb counting or allergies). AI estimates can be off by 20% or more.</span>
        </p>
      </div>
    </Sheet>
  )
}

function MealsEditor({ meals }) {
  const [drafts, setDrafts] = useState({})
  const inputs = useRef({})
  const hintId = useId()
  const isDefault = meals.length === MEALS_DEFAULT.length && meals.every((meal, i) => meal.id === MEALS_DEFAULT[i].id && meal.name === MEALS_DEFAULT[i].name)

  const save = (next) => setPrefs({ meals: next.map(({ id, name }) => ({ id, name })) })

  function commit(id) {
    const text = (drafts[id] ?? '').trim()
    setDrafts((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    if (!text) return
    if (meals.find((meal) => meal.id === id)?.name !== text) save(meals.map((meal) => (meal.id === id ? { ...meal, name: text.slice(0, 40) } : meal)))
  }

  function move(index, dir) {
    const next = [...meals]
    const [meal] = next.splice(index, 1)
    next.splice(index + dir, 0, meal)
    save(next)
  }

  function add() {
    if (meals.length >= 6) return
    const id = `meal-${Date.now().toString(36)}`
    save([...meals, { id, name: `Meal ${meals.length + 1}` }])
    setTimeout(() => inputs.current[id]?.focus(), 60)
  }

  function remove(meal) {
    if (meals.length <= 3) return
    const before = meals
    save(meals.filter((item) => item.id !== meal.id))
    toast(`Removed ${meal.name}`, { action: { label: 'Undo', onClick: () => save(before) } })
  }

  return (
    <>
      <ul className="food-cfg-meals" aria-describedby={hintId}>
        {meals.map((meal, index) => (
          <li key={meal.id} className="food-cfg-row food-cfg-meal">
            <input
              ref={(node) => { inputs.current[meal.id] = node }}
              className="food-cfg-meal-input"
              value={drafts[meal.id] ?? meal.name}
              onChange={(event) => setDrafts((current) => ({ ...current, [meal.id]: event.target.value }))}
              onBlur={() => commit(meal.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              maxLength={40}
              aria-label={`Meal ${index + 1} name`}
              enterKeyHint="done"
              autoComplete="off"
            />
            <span className="food-cfg-meal-actions">
              <IconButton icon="chevronUp" label={`Move ${meal.name} up`} size={18} disabled={index === 0} onClick={() => move(index, -1)} />
              <IconButton icon="chevronDown" label={`Move ${meal.name} down`} size={18} disabled={index === meals.length - 1} onClick={() => move(index, 1)} />
              <IconButton icon="minusCircle" label={`Remove ${meal.name}`} size={18} className="food-cfg-remove" disabled={meals.length <= 3} onClick={() => remove(meal)} />
            </span>
          </li>
        ))}
      </ul>
      <div className="food-cfg-row food-cfg-meal-foot" id={hintId}>
        <button type="button" className="food-cfg-action" onClick={add} disabled={meals.length >= 6}>
          <Icon name="plusCircle" size={18} />Add meal
        </button>
        {!isDefault && (
          <button
            type="button"
            className="food-cfg-action is-quiet"
            onClick={() => {
              const before = meals
              save(MEALS_DEFAULT.map((meal) => ({ ...meal })))
              toast('Meals reset', { action: { label: 'Undo', onClick: () => save(before) } })
            }}
          >
            Reset
          </button>
        )}
      </div>
    </>
  )
}

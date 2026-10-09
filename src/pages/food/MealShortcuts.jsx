import { useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { entryCalories, foodKey } from '../../lib/food/nutrition.js'
import { lastMealDay, mealChips } from '../../lib/food/shortcuts.js'
import { copyMeal } from '../../lib/food/state.js'
import { quickLog } from './QuickAddBar.jsx'
import { energyNumber, entryName, fmtEnergy, mealTime, pastDayName, plural } from './format.js'
import '../../components/food-quick.css'

// One-tap chips for a meal: up to 3 foods usually logged in it (with their calories) and
// "Same as <day>" (the latest of the last 14 days with that meal logged). Used by the Food page's
// empty meals and the Health card's current meal. Once one is tapped the chips hold still until
// the meal or day changes: a logged food shows a check (tap it again to take it back out) instead
// of dropping out of the list, so a quick second tap can't land on a different chip.

const NONE = Object.freeze({})
const SAME = 'same'
const chipKey = (item) => item.key || foodKey(item.name, item.brand)

// sameAs: offer "Same as <day>" (only makes sense while the meal is empty that day).
// active: false skips working the chips out (e.g. a meal that already has food in it); chips that
// are held still show. → { chips, same, added: { [key]: undo }, held, mark(key, undo | null) }.
export function useMealShortcuts({ entries, meal, date, today, meals, sameAs = true, active = true }) {
  const scope = `${meal.id}|${date}`
  const [held, setHeld] = useState(null) // { scope, chips, same, added: { [key]: undo } }
  if (held && held.scope !== scope) setHeld(null)
  const current = held && held.scope === scope ? held : null
  const live = useMemo(() => (current || !active ? null : {
    chips: mealChips(entries, meal.id, { hhmm: mealTime(meal.id), today, date, meals, limit: 3 }),
    same: sameAs ? lastMealDay(entries, meal.id, date, meals) : null,
  }), [current, active, entries, meal.id, date, today, meals, sameAs])
  // A food taken back out some other way (the toast's Undo, a swipe) no longer shows as added.
  const added = useMemo(() => {
    if (!current) return NONE
    const ids = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry?.id))
    const out = {}
    for (const [key, undo] of Object.entries(current.added)) {
      if (undo.entries?.some((row) => ids.has(row.id))) out[key] = undo
    }
    return out
  }, [current, entries])
  const shown = current || live || { chips: [], same: null }

  // Holds the chips as shown now (the first time) and records what a tap added or took out.
  function mark(key, undo) {
    setHeld((prev) => {
      const base = prev && prev.scope === scope ? prev : { scope, chips: shown.chips, same: shown.same, added: {} }
      const next = { ...base.added }
      if (undo) next[key] = undo
      else delete next[key]
      return { ...base, added: next }
    })
  }

  return { chips: shown.chips, same: shown.same, added, held: !!current, mark }
}

export const hasShortcuts = (shortcuts) => !!shortcuts && (shortcuts.chips.length > 0 || !!shortcuts.same)

export default function MealShortcuts({ shortcuts, meal, date, today, food, className = '' }) {
  const { meals, energyUnit: unit } = food.prefs
  if (!hasShortcuts(shortcuts)) return null
  const { chips, same, added = NONE } = shortcuts
  const sameName = same ? pastDayName(same.date, today) : ''

  // Logs a chip's food, or takes it back out when it was added from here.
  function toggleChip(item, key) {
    if (added[key]) {
      added[key]()
      shortcuts.mark?.(key, null)
      return
    }
    const undo = quickLog(item, { meal: meal.id, date, favorites: food.favorites, meals, unit, today })
    if (undo.entries?.length) shortcuts.mark?.(key, undo)
  }

  function copySame() {
    if (added[SAME]) {
      added[SAME]()
      shortcuts.mark?.(SAME, null)
      return
    }
    try {
      const undo = copyMeal(same.date, meal.id, date)
      // "yesterday’s breakfast", "Monday’s breakfast", else "breakfast on Wed 23 Sep" (has digits).
      const from = /\d/.test(sameName) ?`${meal.name.toLowerCase()} on ${sameName}` : `${sameName}’s ${meal.name.toLowerCase()}`
      toast(`Copied ${plural(undo.entries.length, 'item')} from ${from}`, { action: { label: 'Undo', onClick: undo } })
      if (undo.entries.length) shortcuts.mark?.(SAME, undo)
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  const sameAdded = !!added[SAME]
  return (
    <div className={`food-chips ${className}`.trim()} role="group" aria-label={`Quick add to ${meal.name}`}>
      {chips.map((item) => {
        const kcal = entryCalories(item)
        const key = chipKey(item)
        const isAdded = !!added[key]
        return (
          <button
            key={key}
            type="button"
            className={`food-suggest${isAdded ? ' is-added' : ''}`}
            aria-pressed={isAdded}
            onClick={() => toggleChip(item, key)}
            aria-label={`${isAdded ? 'Added' : 'Log'} ${entryName(item)}${kcal ? `, ${fmtEnergy(kcal, unit)}` : ''}`}
          >
            <Icon name={isAdded ? 'check' : 'plus'} size={14} strokeWidth={2.4} />
            <span>{entryName(item)}</span>
            {kcal > 0 && <small className="food-suggest-kcal" aria-hidden="true">{energyNumber(kcal, unit)}</small>}
          </button>
        )
      })}
      {same && (
        <button
          type="button"
          className={`food-suggest is-copy${sameAdded ? ' is-added' : ''}`}
          aria-pressed={sameAdded}
          onClick={copySame}
          aria-label={`Same as ${sameName}: ${plural(same.rows.length, 'item')}, ${fmtEnergy(same.kcal, unit)}`}
        >
          <Icon name={sameAdded ? 'check' : 'repeat'} size={14} strokeWidth={sameAdded ? 2.4 : undefined} />
          <span>Same as {sameName}</span>
          {same.kcal > 0 && <small className="food-suggest-kcal" aria-hidden="true">{energyNumber(same.kcal, unit)}</small>}
        </button>
      )}
    </div>
  )
}

import { useMemo } from 'react'
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
// empty meals and the Health card's current meal.

// sameAs: offer "Same as <day>" (only makes sense while the meal is empty that day).
export function useMealShortcuts({ entries, meal, date, today, meals, sameAs = true }) {
  return useMemo(() => ({
    chips: mealChips(entries, meal.id, { hhmm: mealTime(meal.id), today, date, meals, limit: 3 }),
    same: sameAs ? lastMealDay(entries, meal.id, date, meals) : null,
  }), [entries, meal.id, date, today, meals, sameAs])
}

export const hasShortcuts = (shortcuts) => !!shortcuts && (shortcuts.chips.length > 0 || !!shortcuts.same)

export default function MealShortcuts({ shortcuts, meal, date, today, food, className = '' }) {
  const { meals, energyUnit: unit } = food.prefs
  if (!hasShortcuts(shortcuts)) return null
  const { chips, same } = shortcuts
  const sameName = same ? pastDayName(same.date, today) : ''

  function logChip(item) {
    quickLog(item, { meal: meal.id, date, favorites: food.favorites, meals, unit, today })
  }

  function copySame() {
    try {
      const undo = copyMeal(same.date, meal.id, date)
      // "yesterday’s breakfast", "Monday’s breakfast", else "breakfast on Wed 23 Sep" (has digits).
      const from = /\d/.test(sameName) ?`${meal.name.toLowerCase()} on ${sameName}` : `${sameName}’s ${meal.name.toLowerCase()}`
      toast(`Copied ${plural(undo.entries.length, 'item')} from ${from}`, { action: { label: 'Undo', onClick: undo } })
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  return (
    <div className={`food-chips ${className}`.trim()} role="group" aria-label={`Quick add to ${meal.name}`}>
      {chips.map((item) => {
        const kcal = entryCalories(item)
        return (
          <button key={item.key || foodKey(item.name, item.brand)} type="button" className="food-suggest" onClick={() => logChip(item)} aria-label={`Log ${entryName(item)}${kcal ? `, ${fmtEnergy(kcal, unit)}` : ''}`}>
            <Icon name="plus" size={14} strokeWidth={2.4} />
            <span>{entryName(item)}</span>
            {kcal > 0 && <small className="food-suggest-kcal" aria-hidden="true">{energyNumber(kcal, unit)}</small>}
          </button>
        )
      })}
      {same && (
        <button type="button" className="food-suggest is-copy" onClick={copySame} aria-label={`Same as ${sameName}: ${plural(same.rows.length, 'item')}, ${fmtEnergy(same.kcal, unit)}`}>
          <Icon name="repeat" size={14} />
          <span>Same as {sameName}</span>
          {same.kcal > 0 && <small className="food-suggest-kcal" aria-hidden="true">{energyNumber(same.kcal, unit)}</small>}
        </button>
      )}
    </div>
  )
}

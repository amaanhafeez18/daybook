import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button, IconButton, Skeleton } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addDaysISO, isISODate, weekdayIndex } from '../../lib/dates.js'
import {
  cleanEntry, dayTotals, entryCalories, entryMeal, findFavorite, foodKey, logStreak, macroCalories, mealTotals, suggestions, weightSeries, weightTrend,
} from '../../lib/food/nutrition.js'
import {
  addEntries, copyDay, copyMeal, dayEntries, deleteEntry, deleteFavorite, saveFavorite, updateEntry, updateFood, useBodyWeights, useFood, useFoodEntries,
  useWeightUnit,
} from '../../lib/food/state.js'
import { navigate } from '../../lib/router.js'
import { useStore } from '../../lib/store.js'
import { Menu, MigrationNote, SwipeRow } from './common.jsx'
import { Sparkline } from './charts.jsx'
import EntrySheet from './EntrySheet.jsx'
import EstimateSheet from './EstimateSheet.jsx'
import FoodSettingsSheet from './FoodSettingsSheet.jsx'
import QuickAddBar, { quickLog } from './QuickAddBar.jsx'
import { MacroBars, Ring, ringState } from './ring.jsx'
import WeightSheet from './WeightSheet.jsx'
import {
  confidenceLevel, dayLabel, defaultMeal, energyNumber, entryConfidence, entryName, fmtEnergy, fmtWeight, fmtWeightChange, isEstimate, isNum,
  mealName, mealTime, openDatePicker, plural, portionText, shortDay, unitLabel, weekdayLetter, weightUnitLabel,
} from './format.js'

// #/food and #/food/day/<date>: the day's ring, meals and weight, with the quick-add bar.

function weekStartOf(date, firstWeekday) {
  const offset = (weekdayIndex(date) - firstWeekday + 7) % 7
  return addDaysISO(date, -offset)
}

export function goToDay(date, today) {
  const hash = date === today ? '#/food' : `#/food/day/${date}`
  if (window.location.hash !== hash) window.location.replace(hash)
}

// A copy of an entry to add again (new id and creation time).
function copyOf(entry, patch) {
  const clean = cleanEntry(entry)
  return { ...clean, id: null, createdAt: null, source: 'copy', ...patch }
}

export default function DayView({ date, today, loaded }) {
  const food = useFood()
  const entries = useFoodEntries()
  const bodyWeights = useBodyWeights()
  const weightUnit = useWeightUnit()
  const offline = useStore((state) => state.offline)
  const { meals, energyUnit: unit, weekStart } = food.prefs
  const [targetMeal, setTargetMeal] = useState(null)
  const [sheet, setSheet] = useState(null) // { type: 'entry' | 'actions' | 'weight' | 'copyDay' | 'settings', ... }
  const [estimate, setEstimate] = useState(null)
  const barRef = useRef(null)
  // The entry sheet keeps showing what it opened with while it slides away.
  const entrySheet = useRef(null)
  if (sheet?.type === 'entry') entrySheet.current = sheet

  useEffect(() => setTargetMeal(null), [date])

  const rows = useMemo(() => dayEntries(entries, date, meals), [entries, date, meals])
  const totals = useMemo(() => dayTotals(rows), [rows])
  const groups = useMemo(() => mealTotals(rows, meals), [rows, meals])
  const streak = useMemo(() => logStreak(entries, today), [entries, today])
  const currentMeal = targetMeal || defaultMeal(meals)

  function startEstimate(partial) {
    const request = { key: `${Date.now()}`, date, meal: targetMeal, ...partial }
    setTargetMeal(null)
    if (offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      if (request.text && !request.replace) {
        addEntries([{ name: request.text.slice(0, 120), meal: request.meal || currentMeal, date, source: request.source || 'ai_text' }], {
          toastLabel: `You’re offline — saved “${request.text.slice(0, 32)}” without calories. Tap Estimate on it later.`,
        })
      } else {
        toast('You’re offline — AI estimates need a connection.', { tone: 'error' })
      }
      return
    }
    setEstimate(request)
  }

  function openEntry(defaults) {
    setSheet({ type: 'entry', defaults: { meal: currentMeal, date, ...defaults } })
  }

  function addTo(mealId) {
    setTargetMeal(mealId)
    // Inside the tap, so iOS opens the keyboard.
    barRef.current?.open()
  }

  function removeEntry(entry) {
    const undo = deleteEntry(entry.id)
    toast(`Deleted ${entryName(entry)}`, { action: { label: 'Undo', onClick: undo } })
  }

  function estimateEntry(entry) {
    const portion = portionText(entry)
    startEstimate({ text: [entry.name, portion, entry.brand ? `(${entry.brand})` : ''].filter(Boolean).join(' '), source: entry.source === 'manual' ? 'ai_text' : entry.source, meal: entry.meal, replace: entry })
  }

  const hasEntries = rows.length > 0

  return (
    <div className="food-day">
      <header className="page-header food-head">
        <div className="food-head-text">
          {streak.current >= 2 && <p className="eyebrow food-streak"><Icon name="flame" size={14} />{streak.current}-day logging streak</p>}
          <h1>Food</h1>
        </div>
        <div className="food-head-actions">
          <IconButton icon="barChart" label="Insights" className="food-head-btn" size={21} onClick={() => navigate('food/insights')} />
          <Menu
            items={[
              { label: 'Copy this day to…', icon: 'copy', onClick: () => setSheet({ type: 'copyDay' }), disabled: !hasEntries },
              { label: 'Goals', icon: 'target', onClick: () => navigate('food/goals') },
              { label: 'Weight', icon: 'scale', onClick: () => navigate('food/weight') },
              { label: 'My foods', icon: 'bookmark', onClick: () => navigate('food/foods') },
              { label: 'Food settings', icon: 'settings', onClick: () => setSheet({ type: 'settings' }) },
            ]}
          />
        </div>
      </header>

      <MigrationNote />

      <DaySwitcher date={date} today={today} />
      <WeekStrip date={date} today={today} entries={entries} weekStart={weekStart} goal={food.goals.calories} unit={unit} />

      <div className="food-day-grid">
        <div className="food-day-side">
          {loaded ? (
            <SummaryCard totals={totals} food={food} rows={rows} />
          ) : (
            <section className="card food-summary" aria-busy="true"><Skeleton lines={4} /></section>
          )}
          <WeightCard bodyWeights={bodyWeights} unit={weightUnit} today={today} targetKg={food.profile.targetKg} loaded={loaded} onLog={() => setSheet({ type: 'weight' })} />
        </div>

        <div className="food-day-main">
          {!loaded ? (
            <section className="card"><Skeleton lines={5} /></section>
          ) : groups.map(({ meal, entries: mealRows, totals: mealSum }) => (
            <MealSection
              key={meal.id}
              meal={meal}
              rows={mealRows}
              kcal={mealSum.calories}
              date={date}
              today={today}
              allEntries={entries}
              food={food}
              onAdd={() => addTo(meal.id)}
              onOpen={(entry) => setSheet({ type: 'entry', entry })}
              onMore={(entry) => setSheet({ type: 'actions', entry })}
              onDelete={removeEntry}
              onEstimate={estimateEntry}
            />
          ))}
        </div>
      </div>

      <QuickAddBar
        date={date}
        today={today}
        meal={currentMeal}
        mealChosen={!!targetMeal}
        onMealChange={setTargetMeal}
        entries={entries}
        food={food}
        controlRef={barRef}
        onEstimate={startEstimate}
        onManual={openEntry}
      />

      <EntrySheet
        open={sheet?.type === 'entry'}
        entry={entrySheet.current?.entry || null}
        defaults={entrySheet.current?.defaults}
        today={today}
        onClose={() => setSheet(null)}
      />
      <RowActionsSheet
        entry={sheet?.type === 'actions' ? sheet.entry : null}
        food={food}
        today={today}
        onClose={() => setSheet(null)}
        onEdit={(entry) => setSheet({ type: 'entry', entry })}
        onDelete={(entry) => { setSheet(null); removeEntry(entry) }}
      />
      <WeightSheet open={sheet?.type === 'weight'} date={date} today={today} onClose={() => setSheet(null)} />
      <CopyDaySheet open={sheet?.type === 'copyDay'} date={date} today={today} count={rows.length} onClose={() => setSheet(null)} />
      <FoodSettingsSheet open={sheet?.type === 'settings'} onClose={() => setSheet(null)} />
      <EstimateSheet request={estimate} today={today} onClose={() => setEstimate(null)} onManual={openEntry} />
    </div>
  )
}

// ---- date switcher & week strip ------------------------------------------------------------

function useSwipe(onSwipe) {
  const start = useRef(null)
  return {
    onPointerDown(event) {
      if (event.pointerType === 'mouse') return
      start.current = { x: event.clientX, y: event.clientY }
    },
    onPointerUp(event) {
      const from = start.current
      start.current = null
      if (!from) return
      const dx = event.clientX - from.x
      const dy = event.clientY - from.y
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1)
    },
    onPointerCancel() {
      start.current = null
    },
  }
}

function DaySwitcher({ date, today }) {
  const swipe = useSwipe((dir) => goToDay(addDaysISO(date, dir), today))
  const label = dayLabel(date, today)
  const relative = label !== shortDay(date)
  return (
    <div className="food-switch" {...swipe}>
      <IconButton icon="chevronLeft" label="Previous day" className="food-switch-btn" onClick={() => goToDay(addDaysISO(date, -1), today)} />
      <label className="food-switch-label">
        <span className="food-switch-text">
          <strong>{label}</strong>
          {relative && <span> · {shortDay(date)}</span>}
        </span>
        <Icon name="chevronDown" size={14} strokeWidth={2.4} />
        <input type="date" value={date} aria-label="Choose a day" onClick={openDatePicker} onChange={(event) => isISODate(event.target.value) && goToDay(event.target.value, today)} />
      </label>
      <IconButton icon="chevronRight" label="Next day" className="food-switch-btn" onClick={() => goToDay(addDaysISO(date, 1), today)} />
      {date !== today && (
        <button type="button" className="food-switch-today" onClick={() => goToDay(today, today)}>Today</button>
      )}
    </div>
  )
}

function WeekStrip({ date, today, entries, weekStart, goal, unit }) {
  const start = weekStartOf(date, weekStart)
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(start, i)), [start])
  const kcalByDay = useMemo(() => {
    const set = new Set(days)
    const byDay = new Map(days.map((day) => [day, []]))
    for (const entry of entries) if (set.has(entry.date)) byDay.get(entry.date).push(entry)
    return new Map(days.map((day) => {
      const totals = dayTotals(byDay.get(day))
      return [day, { kcal: totals.calories, count: totals.count }]
    }))
  }, [entries, days])
  const swipe = useSwipe((dir) => goToDay(addDaysISO(date, dir * 7), today))

  return (
    <ol className="food-week" aria-label={`Week of ${shortDay(start)}`} {...swipe}>
      {days.map((day) => {
        const { kcal, count } = kcalByDay.get(day)
        const state = count ? ringState(kcal, goal) : { progress: 0, tone: 'accent' }
        const selected = day === date
        const future = day > today
        const summary = count ? `${fmtEnergy(kcal, unit)}${goal ? ` of ${fmtEnergy(goal, unit)}` : ''}` : 'nothing logged'
        return (
          <li key={day}>
            <button
              type="button"
              className={`food-week-day${selected ? ' is-selected' : ''}${day === today ? ' is-today' : ''}${future ? ' is-future' : ''}`}
              aria-current={selected ? 'date' : undefined}
              aria-label={`${shortDay(day)}, ${summary}`}
              onClick={() => goToDay(day, today)}
            >
              <span className="food-week-wd" aria-hidden="true">{weekdayLetter(day)}</span>
              <Ring size={36} stroke={3.5} progress={state.progress} tone={state.tone}>
                <span className="food-week-num" aria-hidden="true">{Number(day.slice(8, 10))}</span>
              </Ring>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ---- summary ring ---------------------------------------------------------------------------

function SummaryCard({ totals, food, rows }) {
  const { goals, prefs } = food
  const unit = prefs.energyUnit
  const goal = goals.calories
  const eaten = totals.calories
  const { progress, tone, over } = ringState(eaten, goal)
  const showEaten = !goal || prefs.ring === 'eaten'
  const left = goal ? goal - eaten : null
  const value = showEaten ? eaten : Math.abs(left)
  const label = showEaten ? 'eaten' : over ? 'over' : 'left'
  const uncounted = rows.filter((entry) => !isNum(entry.calories) && macroCalories(entry) === null).length

  function toggle() {
    updateFood((current) => ({ prefs: { ...current.prefs, ring: current.prefs.ring === 'eaten' ? 'remaining' : 'eaten' } }))
  }

  return (
    <section className="card food-summary" aria-label="Calories">
      <div className="food-summary-main">
        <button
          type="button"
          className="food-summary-ring"
          onClick={toggle}
          disabled={!goal}
          aria-label={`${energyNumber(value, unit)} ${unitLabel(unit)} ${label}${goal ? `. Show calories ${showEaten ? 'left' : 'eaten'} instead` : ''}`}
        >
          <Ring size={132} stroke={12} progress={progress} tone={tone}>
            <span className={`food-ring-value${label === 'over' ? ' is-over' : ''}`}>{energyNumber(value, unit)}</span>
            <span className="food-ring-label">{unitLabel(unit)} {label}</span>
          </Ring>
        </button>
        <dl className="food-summary-stats">
          {!showEaten && <Stat label="Eaten" value={energyNumber(eaten, unit)} />}
          {goal && showEaten && <Stat label={over ? 'Over' : 'Left'} value={energyNumber(Math.abs(left), unit)} over={over} />}
          {goal ? <Stat label="Goal" value={energyNumber(goal, unit)} /> : <Stat label="Logged" value={plural(rows.length, 'item')} />}
          {!goal && (
            <div className="food-summary-nogoal">
              <dt className="sr-only">Goal</dt>
              <dd><a href="#/food/goals" className="food-link">Set a goal<Icon name="chevronRight" size={15} /></a></dd>
            </div>
          )}
        </dl>
      </div>
      <MacroBars totals={totals} goals={goals} nutrients={prefs.nutrients} className="food-summary-macros" />
      {uncounted > 0 && <p className="food-summary-note">{plural(uncounted, 'item')} without calories {uncounted === 1 ? 'isn’t' : 'aren’t'} counted.</p>}
    </section>
  )
}

function Stat({ label, value, over = false }) {
  return (
    <div className={`food-summary-stat${over ? ' is-over' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

// ---- meals ------------------------------------------------------------------------------------

function MealSection({ meal, rows, kcal, date, today, allEntries, food, onAdd, onOpen, onMore, onDelete, onEstimate }) {
  const unit = food.prefs.energyUnit
  const headingId = `food-meal-${meal.id}`
  return (
    <section className="food-meal" aria-labelledby={headingId}>
      <div className="food-meal-head">
        <h2 id={headingId}>{meal.name}</h2>
        {rows.length > 0 && <span className="food-meal-kcal">{energyNumber(kcal, unit)} <small>{unitLabel(unit)}</small></span>}
        <IconButton icon="plus" label={`Add to ${meal.name}`} className="food-meal-add" size={20} onClick={onAdd} />
      </div>
      {rows.length ? (
        <ul className="card-list food-list">
          {rows.map((entry) => (
            <EntryRow key={entry.id} entry={entry} unit={unit} onOpen={() => onOpen(entry)} onMore={() => onMore(entry)} onDelete={() => onDelete(entry)} onEstimate={() => onEstimate(entry)} />
          ))}
        </ul>
      ) : (
        <EmptyMeal meal={meal} date={date} today={today} allEntries={allEntries} food={food} onAdd={onAdd} />
      )}
    </section>
  )
}

function EntryRow({ entry, unit, onOpen, onMore, onDelete, onEstimate }) {
  const name = entryName(entry)
  const counted = isNum(entry.calories) || macroCalories(entry) !== null
  const estimate = counted && isEstimate(entry)
  const level = confidenceLevel(entryConfidence(entry))
  const approx = estimate && level && level !== 'high'
  const portion = portionText(entry)
  return (
    <SwipeRow className="food-row" onDelete={onDelete} onLongPress={onMore}>
      <div className="food-row-inner">
        <button type="button" className="food-row-main" onClick={onOpen}>
          <span className="food-row-text">
            <span className="food-row-name">{name}</span>
            {(portion || entry.brand || estimate || !counted) && (
              <span className="food-row-sub">
                {portion && <span>{portion}</span>}
                {entry.brand && <span>{entry.brand}</span>}
                {estimate && <span className="food-badge"><Icon name="sparkles" size={11} strokeWidth={2} />Estimate</span>}
                {!counted && <span className="food-row-hint">Add calories</span>}
              </span>
            )}
          </span>
          <span className={`food-row-kcal${counted ? '' : ' is-empty'}`}>
            {counted ? (
              <>
                {approx && <span className="food-row-approx" title="Estimate">~</span>}
                {energyNumber(entryCalories(entry), unit)}
              </>
            ) : '—'}
          </span>
        </button>
        {!counted && entry.name && (
          <button type="button" className="food-row-estimate" onClick={onEstimate} aria-label={`Estimate calories for ${name}`}>
            <Icon name="sparkles" size={14} />Estimate
          </button>
        )}
        <button type="button" className="icon-btn food-row-more" onClick={onMore} aria-label={`More actions for ${name}`}>
          <Icon name="more" size={20} />
        </button>
      </div>
    </SwipeRow>
  )
}

function EmptyMeal({ meal, date, today, allEntries, food, onAdd }) {
  const { meals, energyUnit: unit } = food.prefs
  const yesterday = addDaysISO(date, -1)
  // Suggestions for this meal: foods logged in it before (within the scoring window).
  const chips = useMemo(() => {
    const inMeal = new Set(allEntries.filter((entry) => entry.meal === meal.id).map((entry) => foodKey(entry.name, entry.brand)))
    return suggestions(allEntries, meal.id, mealTime(meal.id), today, 8).filter((item) => inMeal.has(item.key)).slice(0, 3)
  }, [allEntries, meal.id, today])
  const yesterdayRows = useMemo(
    () => dayEntries(allEntries, yesterday, meals).filter((entry) => entryMeal(entry, meals) === meal.id),
    [allEntries, yesterday, meals, meal.id],
  )

  function logChip(item) {
    quickLog(item, { meal: meal.id, date, favorites: food.favorites, meals, unit, today })
  }

  function sameAsYesterday() {
    try {
      const undo = copyMeal(yesterday, meal.id, date)
      const count = undo.entries.length
      toast(`Copied ${plural(count, 'item')} from yesterday’s ${meal.name.toLowerCase()}`, { action: { label: 'Undo', onClick: undo } })
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  if (!chips.length && !yesterdayRows.length) {
    return (
      <button type="button" className="food-meal-ghost" onClick={onAdd}>
        <Icon name="plus" size={16} />Add {meal.name.toLowerCase()}
      </button>
    )
  }
  const yesterdayKcal = yesterdayRows.reduce((sum, entry) => sum + entryCalories(entry), 0)
  return (
    <div className="food-chips" role="group" aria-label={`Quick add to ${meal.name}`}>
      {chips.map((item) => {
        const kcal = entryCalories(item)
        return (
          <button key={item.key || foodKey(item.name, item.brand)} type="button" className="food-suggest" onClick={() => logChip(item)} aria-label={`Log ${entryName(item)}${kcal ? `, ${fmtEnergy(kcal, unit)}` : ''}`}>
            <Icon name="plus" size={14} strokeWidth={2.4} />
            <span>{entryName(item)}</span>
          </button>
        )
      })}
      {yesterdayRows.length > 0 && (
        <button type="button" className="food-suggest is-copy" onClick={sameAsYesterday} aria-label={`Same as yesterday: ${plural(yesterdayRows.length, 'item')}, ${fmtEnergy(yesterdayKcal, unit)}`}>
          <Icon name="repeat" size={14} />
          <span>Same as yesterday</span>
        </button>
      )}
    </div>
  )
}

// ---- weight -----------------------------------------------------------------------------------

function WeightCard({ bodyWeights, unit, today, targetKg, loaded, onLog }) {
  const trend = useMemo(() => weightTrend(bodyWeights, today, { targetKg }), [bodyWeights, today, targetKg])
  const spark = useMemo(() => weightSeries(bodyWeights, addDaysISO(today, -29), today).map((point) => point.kg), [bodyWeights, today])
  const u = weightUnitLabel(unit)
  const change = trend.weeklyChangeKg
  const icon = isNum(change) && Math.abs(change) >= 0.05 ? (change < 0 ? 'trendingDown' : 'trendingUp') : null

  return (
    <section className="card food-weight" aria-labelledby="food-weight-title">
      <div className="food-card-head">
        <h2 id="food-weight-title" className="food-card-title"><Icon name="scale" size={18} />Weight</h2>
        <Button variant="secondary" size="sm" icon="plus" onClick={onLog}>Log</Button>
      </div>
      {!loaded ? <Skeleton lines={2} /> : trend.latestKg === null ? (
        <p className="food-weight-empty">Log your weight a few times a week to see a smoothed trend here.</p>
      ) : (
        <button type="button" className="food-weight-body" onClick={() => navigate('food/weight')} aria-label={`Weight ${fmtWeight(trend.latestKg, unit)} ${u}. Open weight details`}>
          <span className="food-weight-text">
            <span className="food-weight-now">
              <strong>{fmtWeight(trend.latestKg, unit)}</strong>
              <small>{u}{trend.latestDate && trend.latestDate !== today ? ` · ${dayLabel(trend.latestDate, today)}` : ''}</small>
            </span>
            <span className="food-weight-change">
              {isNum(change) ? (
                <>
                  {icon && <Icon name={icon} size={15} />}
                  {fmtWeightChange(change, unit)} {u}/wk
                </>
              ) : 'Trend after a few weigh-ins'}
            </span>
          </span>
          <Sparkline values={spark} width={96} height={34} />
          <Icon name="chevronRight" size={18} className="food-weight-chevron" />
        </button>
      )}
    </section>
  )
}

// ---- row actions ------------------------------------------------------------------------------

function RowActionsSheet({ entry, food, today, onClose, onEdit, onDelete }) {
  const last = useRef(entry)
  if (entry) last.current = entry
  const shown = entry || last.current
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyTo, setCopyTo] = useState(today)
  const { meals, energyUnit: unit } = food.prefs

  useEffect(() => {
    if (!entry) return
    setCopyOpen(false)
    setCopyTo(entry.date === today ? addDaysISO(today, 1) : today)
  }, [entry?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null
  const name = entryName(shown)
  const favorite = findFavorite(food.favorites, shown)
  const current = entryMeal(shown, meals)
  const counted = isNum(shown.calories) || macroCalories(shown) !== null
  const description = [portionText(shown), counted ? fmtEnergy(entryCalories(shown), unit) : 'No calories'].filter(Boolean).join(' · ')

  function move(mealId) {
    if (!entry || mealId === current) return
    const undo = updateEntry(entry.id, { meal: mealId })
    toast(`Moved ${name} to ${mealName(meals, mealId)}`, { action: { label: 'Undo', onClick: undo } })
    onClose()
  }

  function duplicate() {
    addEntries([copyOf(entry)], { toastLabel: `Duplicated ${name}` })
    onClose()
  }

  function copyToDay() {
    if (!isISODate(copyTo)) return
    addEntries([copyOf(entry, { date: copyTo })], { toastLabel: `Copied ${name} to ${dayLabel(copyTo, today)}` })
    onClose()
  }

  function toggleFavorite() {
    try {
      if (favorite) {
        const undo = deleteFavorite(favorite.id)
        toast(`Removed ${name} from favorites`, { action: { label: 'Undo', onClick: undo } })
      } else {
        const saved = saveFavorite(entry)
        toast(`Added ${name} to favorites`, { action: { label: 'Undo', onClick: () => saved && deleteFavorite(saved.id) } })
      }
      onClose()
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  return (
    <Sheet open={!!entry} onClose={onClose} title={name} description={description} initialFocus={false} size="sm">
      <div className="food-act">
        <p className="food-act-label">Move to</p>
        <div className="food-act-meals" role="radiogroup" aria-label="Meal">
          {meals.map((meal) => (
            <button key={meal.id} type="button" role="radio" aria-checked={meal.id === current} className={`chip chip-sm food-chip${meal.id === current ? ' is-active' : ''}`} onClick={() => move(meal.id)}>
              {meal.name}
            </button>
          ))}
        </div>
        <div className="food-act-list">
          <button type="button" className="food-act-row" onClick={() => onEdit(entry)}><Icon name="pencil" size={19} />Edit</button>
          <button type="button" className="food-act-row" onClick={duplicate}><Icon name="copy" size={19} />Duplicate</button>
          <button type="button" className="food-act-row" aria-expanded={copyOpen} onClick={() => setCopyOpen((value) => !value)}><Icon name="calendar" size={19} />Copy to another day</button>
          {copyOpen && (
            <div className="food-act-copy">
              <label className="food-pick">
                <span className="sr-only">Copy to</span>
                <span className="food-pick-text">{dayLabel(copyTo, today)}</span>
                <Icon name="chevronDown" size={15} strokeWidth={2.2} />
                <input type="date" value={copyTo} onClick={openDatePicker} onChange={(event) => isISODate(event.target.value) && setCopyTo(event.target.value)} />
              </label>
              <Button size="sm" onClick={copyToDay}>Copy</Button>
            </div>
          )}
          <button type="button" className="food-act-row" onClick={toggleFavorite} disabled={!shown.name}>
            <Icon name="star" size={19} className={favorite ? 'is-filled' : ''} />{favorite ? 'Remove from favorites' : 'Add to favorites'}
          </button>
          <button type="button" className="food-act-row is-danger" onClick={() => onDelete(entry)}><Icon name="trash" size={19} />Delete</button>
        </div>
      </div>
    </Sheet>
  )
}

// ---- copy day ---------------------------------------------------------------------------------

function CopyDaySheet({ open, onClose, date, today, count }) {
  const [target, setTarget] = useState(today)
  useEffect(() => {
    if (open) setTarget(date === today ? addDaysISO(today, 1) : today)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function copy() {
    if (!isISODate(target) || target === date) return
    try {
      const undo = copyDay(date, target)
      const copied = undo.entries.length
      toast(copied ? `Copied ${plural(copied, 'item')} to ${dayLabel(target, today)}` : 'Nothing to copy', copied ? { action: { label: 'Undo', onClick: undo } } : undefined)
      onClose()
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  const quick = [today, addDaysISO(today, 1)].filter((day) => day !== date)
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Copy this day"
      description={`${plural(count, 'item')} from ${dayLabel(date, today).toLowerCase() === 'today' ? 'today' : dayLabel(date, today)}`}
      size="sm"
      initialFocus={false}
      footer={<Button className="btn-grow" onClick={copy} disabled={!count || target === date}>Copy to {dayLabel(target, today)}</Button>}
    >
      <div className="food-copy">
        <div className="food-copy-quick" role="group" aria-label="Copy to">
          {quick.map((day) => (
            <button key={day} type="button" className={`chip chip-sm food-chip${target === day ? ' is-active' : ''}`} aria-pressed={target === day} onClick={() => setTarget(day)}>
              {dayLabel(day, today)}
            </button>
          ))}
          <label className={`food-pick${quick.includes(target) ? '' : ' is-active'}`}>
            <span className="food-pick-text">{quick.includes(target) ? 'Other day' : shortDay(target)}</span>
            <Icon name="chevronDown" size={15} strokeWidth={2.2} />
            <input type="date" value={target} aria-label="Choose a day" onClick={openDatePicker} onChange={(event) => isISODate(event.target.value) && setTarget(event.target.value)} />
          </label>
        </div>
        <p className="food-copy-hint">Copies are added to anything already logged that day.</p>
      </div>
    </Sheet>
  )
}

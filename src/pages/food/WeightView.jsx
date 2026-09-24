import { useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Button, EmptyState, Segmented, Skeleton } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addDaysISO } from '../../lib/dates.js'
import { weightTrend } from '../../lib/food/nutrition.js'
import { deleteBodyWeight, useBodyWeights, useFood, useWeightUnit } from '../../lib/food/state.js'
import { navigate } from '../../lib/router.js'
import { DetailTop, MigrationNote, StatTile, SwipeRow } from './common.jsx'
import { WeightChart } from './charts.jsx'
import WeightSheet from './WeightSheet.jsx'
import { dayLabel, fmtNum, fmtWeight, fmtWeightChange, isNum, kgToUnit, shortDay, weightUnitLabel } from './format.js'

// #/food/weight: the shared body-weight log (Gym and Food) — trend chart with range chips, the
// trend, weekly change, pace and ETA to the goal weight, and every weigh-in (swipe to delete).

const RANGES = [
  { id: '1m', label: '1M', days: 31 },
  { id: '3m', label: '3M', days: 92 },
  { id: '1y', label: '1Y', days: 366 },
  { id: 'all', label: 'All', days: null },
]
const PAGE = 30

export default function WeightView({ today, loaded }) {
  const bodyWeights = useBodyWeights()
  const unit = useWeightUnit()
  const food = useFood()
  const targetKg = food.profile.targetKg
  const [range, setRange] = useState('3m')
  const [sheet, setSheet] = useState(null) // { date } while logging
  const [shown, setShown] = useState(PAGE)
  const u = weightUnitLabel(unit)

  const trend = useMemo(() => weightTrend(bodyWeights, today, { targetKg }), [bodyWeights, today, targetKg])
  const points = useMemo(() => {
    const days = RANGES.find((item) => item.id === range)?.days
    if (!days) return trend.points
    const from = addDaysISO(today, -(days - 1))
    return trend.points.filter((point) => point.date >= from)
  }, [trend.points, range, today])

  function remove(entry) {
    const undo = deleteBodyWeight(entry.id)
    toast(`Deleted ${fmtWeight(entry.kg, unit)} ${u} · ${dayLabel(entry.date, today)}`, { action: { label: 'Undo', onClick: undo } })
  }

  const pace = trend.paceKgPerWeek
  const eta = trend.etaWeeks
  const etaText = eta === 0 ? 'Reached' : trend.etaDate ? shortDay(trend.etaDate) : null
  const heading = isNum(trend.trendKg) ? trend.trendKg : trend.latestKg
  // One plain sentence under the number: what happened this week and where it's going.
  let headline
  if (!isNum(trend.trendKg)) headline = 'A few more weigh-ins and your trend shows here.'
  else if (!isNum(trend.weeklyChangeKg)) headline = 'Keep weighing in — the weekly change needs two weeks of data.'
  else {
    const change = kgToUnit(trend.weeklyChangeKg, unit)
    const rounded = Math.round(change * 10) / 10
    const dir = rounded === 0 ? 'Steady this week' : `${rounded < 0 ? 'Down' : 'Up'} ${fmtNum(Math.abs(rounded), 1)} ${u} this week`
    const going = isNum(pace) && Math.abs(pace) >= 0.01 ? ` · about ${fmtNum(Math.abs(kgToUnit(pace, unit)), 2)} ${u} a week` : ''
    headline = `${dir}${going}${isNum(targetKg) && etaText && eta !== 0 ? ` · goal around ${etaText}` : ''}`
  }

  return (
    <div className="food-weightview">
      <DetailTop>
        <Button size="sm" icon="plus" onClick={() => setSheet({ date: today })}>Weigh in</Button>
      </DetailTop>
      <header className="food-page-head">
        <h1>Weight</h1>
        <p className="page-subtitle">Shared with Gym</p>
      </header>
      <MigrationNote />

      {!loaded ? (
        <section className="card"><Skeleton lines={5} /></section>
      ) : !bodyWeights.length ? (
        <section className="card">
          <EmptyState icon="scale" title="No weigh-ins yet" action={<Button icon="plus" onClick={() => setSheet({ date: today })}>Weigh in</Button>}>
            Weigh in a few mornings a week — the trend smooths out day-to-day water swings.
          </EmptyState>
        </section>
      ) : (
        <>
          <section className="card food-wv-card">
            <div className="food-wv-now">
              <strong>{fmtWeight(heading, unit)}</strong>
              <span>{u} {isNum(trend.trendKg) ? '· 7-day trend' : `· ${dayLabel(trend.latestDate, today)}`}</span>
            </div>
            <p className="food-wv-line">{headline}</p>
            <Segmented options={RANGES} value={range} onChange={setRange} label="Range" className="food-wv-range" />
            <WeightChart points={points} unit={unit} targetKg={targetKg} ariaLabel={`Weight trend, ${RANGES.find((item) => item.id === range)?.label}`} />
            {!trend.reliable && trend.weighIns28 > 0 && (
              <p className="food-chart-note"><Icon name="info" size={14} />Weigh in 3× a week for a reliable trend ({trend.weighIns28} in the last 4 weeks).</p>
            )}
            <p className="food-chart-note">The trend averages your last 7 days, so one heavy or light morning barely moves it.</p>
          </section>

          <div className="food-stats">
            <StatTile label="Latest weigh-in" value={fmtWeight(trend.latestKg, unit)} sub={`${u} · ${dayLabel(trend.latestDate, today)}`} />
            <StatTile label="This week" value={isNum(trend.weeklyChangeKg) ? fmtWeightChange(trend.weeklyChangeKg, unit) : '—'} sub={isNum(trend.weeklyChangeKg) ? `${u} vs a week ago` : 'Needs 2 weeks of data'} />
            <StatTile label="Pace" value={isNum(pace) ? fmtWeightChange(pace, unit, 2) : '—'} sub={isNum(pace) ? `${u} a week, over 4 weeks` : 'Needs a few weeks'} />
            <StatTile
              label="Goal"
              value={isNum(targetKg) ? `${fmtWeight(targetKg, unit)}` : '—'}
              sub={isNum(targetKg) ? (etaText ? (eta === 0 ? 'You’re there' : `Around ${etaText}`) : 'Not heading there yet') : <button type="button" className="food-link" onClick={() => navigate('food/goals')}>Set a goal weight</button>}
            />
          </div>

          <section className="food-wv-list-wrap" aria-labelledby="food-wv-list-title">
            <div className="food-section-head">
              <h2 id="food-wv-list-title">Weigh-ins</h2>
              <span className="food-section-count">{bodyWeights.length}</span>
            </div>
            <ul className="card-list food-list food-wv-list">
              {bodyWeights.slice(0, shown).map((entry, index) => {
                const older = bodyWeights[index + 1]
                const delta = older ? entry.kg - older.kg : null
                return (
                  <SwipeRow key={entry.id} className="food-row" onDelete={() => remove(entry)}>
                    <div className="food-row-inner">
                      <button type="button" className="food-row-main" onClick={() => setSheet({ date: entry.date })} aria-label={`${shortDay(entry.date)}: ${fmtWeight(entry.kg, unit)} ${u}. Edit`}>
                        <span className="food-row-text">
                          <span className="food-row-name">{dayLabel(entry.date, today)}</span>
                          {delta !== null && <span className="food-row-sub">{fmtWeightChange(delta, unit)} {u} vs {shortDay(older.date)}</span>}
                        </span>
                        <span className="food-row-kcal">{fmtNum(kgToUnit(entry.kg, unit), 1)} <small>{u}</small></span>
                      </button>
                      <button type="button" className="icon-btn food-row-more" onClick={() => remove(entry)} aria-label={`Delete the ${shortDay(entry.date)} weigh-in`}>
                        <Icon name="trash" size={18} />
                      </button>
                    </div>
                  </SwipeRow>
                )
              })}
            </ul>
            {bodyWeights.length > shown && (
              <button type="button" className="food-more-btn" onClick={() => setShown((value) => value + PAGE)}>Show more</button>
            )}
          </section>
        </>
      )}

      <WeightSheet open={!!sheet} date={sheet?.date || today} today={today} onClose={() => setSheet(null)} />
    </div>
  )
}

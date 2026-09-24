import { useMemo } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { EmptyState, IconButton, Skeleton } from '../../components/ui/primitives.jsx'
import { addDaysISO, isISODate, weekdayIndex } from '../../lib/dates.js'
import { weeklyInsights } from '../../lib/food/nutrition.js'
import { useBodyWeights, useFood, useFoodEntries, useWeightUnit } from '../../lib/food/state.js'
import { navigate } from '../../lib/router.js'
import { DetailTop, StatTile } from './common.jsx'
import { CalorieBars } from './charts.jsx'
import { energyNumber, entryName, fmtGrams, fmtInt, fmtNum, fmtWeight, fmtWeightChange, isNum, plural, shortDay, unitLabel, weekRange, weekdayLetter, weightUnitLabel } from './format.js'

// #/food/insights[/<week start>]: templated summary sentences, then calories (bars against the
// goal band), protein days, macro split, weight, consistency, top foods and the closest /
// furthest day. Everything taps through to its day.

function weekStartOf(date, firstWeekday) {
  const offset = (weekdayIndex(date) - firstWeekday + 7) % 7
  return addDaysISO(date, -offset)
}

const openDay = (date) => navigate(`food/day/${date}`)

function Delta({ value, unit, digits = 0, suffix = '', label = 'vs last week' }) {
  if (!isNum(value)) return null
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits
  if (rounded === 0) return <span className="food-ins-delta">Same as last week</span>
  return (
    <span className="food-ins-delta">
      <Icon name={rounded > 0 ? 'arrowUp' : 'arrowDown'} size={13} strokeWidth={2.4} />
      {unit ? `${energyNumber(Math.abs(rounded), unit)} ${unitLabel(unit)}` : `${fmtNum(Math.abs(rounded), digits)}${suffix}`} {label}
    </span>
  )
}

function Card({ title, icon, children, action }) {
  return (
    <section className="card food-ins-card">
      <div className="food-card-head">
        <h2 className="food-card-title">{icon && <Icon name={icon} size={18} />}{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function InsightsView({ today, param, loaded }) {
  const food = useFood()
  const entries = useFoodEntries()
  const bodyWeights = useBodyWeights()
  const weightUnit = useWeightUnit()
  const { prefs, goals, profile } = food
  const unit = prefs.energyUnit
  const current = weekStartOf(today, prefs.weekStart)
  const start = isISODate(param) ? weekStartOf(param < current ? param : current, prefs.weekStart) : current
  const week = useMemo(
    () => weeklyInsights(entries, bodyWeights, goals, start, today, { targetKg: profile.targetKg, energyUnit: unit, weightUnit, weekStart: prefs.weekStart }),
    [entries, bodyWeights, goals, start, today, profile.targetKg, unit, weightUnit, prefs.weekStart],
  )
  const u = weightUnitLabel(weightUnit)
  const goToWeek = (next) => window.location.replace(next === current ? '#/food/insights' : `#/food/insights/${next}`)
  const isCurrent = start === current
  const hasFood = week.loggedDays > 0 || week.days.some((day) => day.logged)

  const switcher = (
    <div className="food-switch food-ins-switch">
      <IconButton icon="chevronLeft" label="Previous week" className="food-switch-btn" onClick={() => goToWeek(addDaysISO(start, -7))} />
      <span className="food-switch-label is-static">
        <span className="food-switch-text"><strong>{isCurrent ? 'This week' : weekRange(week.weekStart, week.weekEnd)}</strong>{isCurrent && <span> · {weekRange(week.weekStart, week.weekEnd)}</span>}</span>
      </span>
      <IconButton icon="chevronRight" label="Next week" className="food-switch-btn" disabled={isCurrent} onClick={() => goToWeek(addDaysISO(start, 7))} />
    </div>
  )

  return (
    <div className="food-ins">
      <DetailTop />
      <header className="food-page-head">
        <h1>Insights</h1>
      </header>
      {switcher}

      {!loaded ? (
        <section className="card"><Skeleton lines={6} /></section>
      ) : (
        <>
          <section className="card food-ins-summary" aria-label="Summary">
            {week.summary.map((line, index) => <p key={line} className={index === 0 ? 'food-ins-headline' : 'food-ins-detail'}>{line}</p>)}
            {!isCurrent || week.complete ? null : <p className="food-ins-summary-note">Today isn’t counted in averages until it’s over.</p>}
          </section>

          {!hasFood && week.weight.trendKg === null ? (
            <section className="card">
              <EmptyState icon="barChart" title={isCurrent ? 'Nothing logged yet this week' : 'Nothing logged this week'} action={isCurrent ? <button type="button" className="btn btn-primary" onClick={() => navigate('food')}>Log food</button> : null}>
                Log what you eat and your weight, and your week’s patterns show up here.
              </EmptyState>
            </section>
          ) : (
            <div className="food-ins-grid">
              <Card title="Calories" icon="flame">
                <div className="food-ins-figures">
                  <div className="food-ins-figure">
                    <strong>{isNum(week.avgKcal) ? energyNumber(week.avgKcal, unit) : '—'}</strong>
                    <span>{unitLabel(unit)} a day on average</span>
                  </div>
                  <div className="food-ins-figure-side">
                    <span>{week.loggedDays ? `${plural(week.loggedDays, 'day')} counted` : 'No finished days yet'}</span>
                    {goals.calories && week.loggedDays > 0 && <span>On target {week.onTargetDays} of {week.loggedDays}</span>}
                    <Delta value={week.vsLastWeek.avgKcal} unit={unit} />
                  </div>
                </div>
                {goals.calories && isNum(week.budgetKcal) && week.loggedDays > 0 && (
                  <p className="food-ins-line">
                    {week.budgetKcal === 0 ? 'Right on budget' : `${energyNumber(Math.abs(week.budgetKcal), unit)} ${unitLabel(unit)} ${week.budgetKcal > 0 ? 'under' : 'over'} budget`} for the days logged.
                  </p>
                )}
                <CalorieBars days={week.days} goal={goals.calories} unit={unit} onOpen={openDay} />
                {!goals.calories && <p className="food-chart-note"><Icon name="target" size={14} /><button type="button" className="food-link" onClick={() => navigate('food/goals')}>Set a calorie goal</button> to see days on target.</p>}
              </Card>

              <ProteinCard week={week} goals={goals} />
              <MacroSplitCard split={week.macroSplit} />

              <Card title="Weight" icon="scale" action={<button type="button" className="food-link" onClick={() => navigate('food/weight')}>Details<Icon name="chevronRight" size={15} /></button>}>
                {week.weight.trendKg === null ? (
                  <p className="food-ins-empty">{week.weight.weighIns ? 'Weigh in a few times a week to see a trend.' : 'No weigh-ins this week.'}</p>
                ) : (
                  <>
                    <div className="food-stats is-inline">
                      <StatTile label="Trend" value={fmtWeight(week.weight.trendKg, weightUnit)} sub={`${u} · 7-day average`} />
                      <StatTile label="This week" value={isNum(week.weight.weeklyChangeKg) ? fmtWeightChange(week.weight.weeklyChangeKg, weightUnit) : '—'} sub={isNum(week.weight.weeklyChangePct) ? `${u} · ${fmtNum(week.weight.weeklyChangePct, 1)}%` : u} />
                      <StatTile label="Pace" value={isNum(week.weight.paceKgPerWeek) ? fmtWeightChange(week.weight.paceKgPerWeek, weightUnit, 2) : '—'} sub={`${u} a week`} />
                    </div>
                    {week.weight.lowWeighIns && <p className="food-chart-note"><Icon name="info" size={14} />Weigh in 3× a week for a reliable trend.</p>}
                    <p className="food-chart-note">The trend averages the last 7 days; the pace is how fast it has moved over 4 weeks.</p>
                  </>
                )}
              </Card>

              <Card title="Consistency" icon="calendarCheck">
                <div className="food-stats is-inline">
                  <StatTile label="Logged" value={`${week.days.filter((day) => day.logged && !day.future).length}/${Math.max(1, Math.min(7, week.elapsedDays + (isCurrent ? 1 : 0)))}`} sub="days this week" />
                  <StatTile label="Streak" value={fmtInt(week.streak.current)} sub={week.streak.current === 1 ? 'day in a row' : 'days in a row'} />
                  <StatTile label="Longest" value={fmtInt(week.streak.longest)} sub={week.streak.longest === 1 ? 'day' : 'days'} />
                </div>
              </Card>

              <FoodsCard week={week} unit={unit} />
              <DaysCard week={week} goals={goals} unit={unit} today={today} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

const PROTEIN_STATUS = { hit: 'Hit', close: 'Close', miss: 'Under' }

function ProteinCard({ week, goals }) {
  const { protein } = week
  const target = goals.protein
  if (!target && !(protein.avgG > 0)) return null
  return (
    <Card title="Protein" icon="target">
      <div className="food-ins-figures">
        <div className="food-ins-figure">
          <strong>{isNum(protein.avgG) ? fmtGrams(protein.avgG) : '—'}<small> g</small></strong>
          <span>{target ? `a day · goal ${fmtInt(target)} g${isNum(protein.pct) ? ` (${protein.pct}%)` : ''}` : 'a day on average'}</span>
        </div>
        <div className="food-ins-figure-side">
          {target && week.loggedDays > 0 && <span>Hit {protein.hitDays} · close {protein.closeDays}</span>}
          <Delta value={week.vsLastWeek.avgProteinG} digits={0} suffix=" g" />
        </div>
      </div>
      <ol className="food-ins-dots" aria-label="Protein by day">
        {week.days.map((day) => {
          const status = day.proteinStatus
          const label = day.future ? 'coming up' : !day.logged ? 'nothing logged' : `${fmtGrams(day.proteinG)} g${status ? `, ${PROTEIN_STATUS[status].toLowerCase()}` : ''}`
          return (
            <li key={day.date}>
              <button type="button" className={`food-ins-dot-btn${day.inProgress ? ' is-today' : ''}`} disabled={day.future} onClick={() => openDay(day.date)} aria-label={`${shortDay(day.date)}: ${label}`}>
                <span className="food-ins-dot-wd" aria-hidden="true">{weekdayLetter(day.date)}</span>
                <span className={`food-ins-dot is-${day.logged ? status || 'plain' : 'none'}`} aria-hidden="true">
                  {status === 'hit' && <Icon name="check" size={12} strokeWidth={3} />}
                </span>
                <span className="food-ins-dot-value" aria-hidden="true">{day.logged ? fmtGrams(day.proteinG) : '–'}</span>
              </button>
            </li>
          )
        })}
      </ol>
      {target && (
        <p className="food-ins-key">
          <span><i className="food-ins-dot is-hit" />Hit</span>
          <span><i className="food-ins-dot is-close" />Within 10%</span>
          <span><i className="food-ins-dot is-miss" />Under</span>
        </p>
      )}
    </Card>
  )
}

function MacroSplitCard({ split }) {
  const parts = [
    { key: 'protein', label: 'Protein', pct: split.proteinPct },
    { key: 'carbs', label: 'Carbs', pct: split.carbsPct },
    { key: 'fat', label: 'Fat', pct: split.fatPct },
  ]
  return (
    <Card title="Macro split" icon="pieChart">
      {split.show ? (
        <>
          <div className="food-ins-split" role="img" aria-label={parts.map((part) => `${part.label} ${part.pct}%`).join(', ')}>
            {parts.map((part) => (part.pct > 0 ? <span key={part.key} className={`is-${part.key}`} style={{ flexGrow: part.pct }} /> : null))}
          </div>
          <ul className="food-ins-legend">
            {parts.map((part) => (
              <li key={part.key}><i className={`is-${part.key}`} aria-hidden="true" />{part.label}<strong>{part.pct}%</strong></li>
            ))}
          </ul>
          <p className="food-chart-note">Where your calories came from, for the entries that have protein, carbs and fat ({Math.round(split.coverage * 100)}% of the week’s calories).</p>
        </>
      ) : (
        <p className="food-ins-empty">Add protein, carbs and fat to your entries (AI estimates include them) to see your split.</p>
      )}
    </Card>
  )
}

function FoodsCard({ week, unit }) {
  if (!week.topFoods.length && !week.biggestSources.length) return null
  return (
    <Card title="Foods" icon="utensils">
      {week.topFoods.length > 0 && (
        <>
          <h3 className="food-ins-sub">Most logged</h3>
          <ol className="food-ins-list">
            {week.topFoods.map((item, index) => (
              <li key={item.key}>
                <span className="food-ins-rank">{index + 1}</span>
                <span className="food-ins-name">{entryName(item)}</span>
                <span className="food-ins-val">{item.count}×</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {week.biggestSources.length > 0 && (
        <>
          <h3 className="food-ins-sub">Biggest calorie sources</h3>
          <ol className="food-ins-list">
            {week.biggestSources.map((item, index) => (
              <li key={item.key}>
                <span className="food-ins-rank">{index + 1}</span>
                <span className="food-ins-name">{entryName(item)}</span>
                <span className="food-ins-val">{energyNumber(item.kcal, unit)} <small>{Math.round(item.share * 100)}%</small></span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  )
}

function DaysCard({ week, goals, unit, today }) {
  const rows = goals.calories
    ? [
      { label: 'Closest to goal', day: week.closestDay },
      { label: 'Furthest from goal', day: week.furthestDay },
    ]
    : [
      { label: 'Most protein', day: week.highestProteinDay },
      { label: 'Most calories', day: week.highestKcalDay },
    ]
  const shown = rows.filter((row) => row.day)
  if (!shown.length) return null
  return (
    <Card title="Days" icon="calendar">
      <ul className="food-ins-days">
        {shown.map(({ label, day }) => (
          <li key={label}>
            <button type="button" className="food-ins-day" onClick={() => openDay(day.date)}>
              <span className="food-ins-day-text">
                <small>{label}</small>
                <span>{shortDay(day.date)}{day.date === today ? ' (today)' : ''}</span>
              </span>
              <span className="food-ins-day-val">
                {energyNumber(day.calories, unit)} <small>{unitLabel(unit)}</small>
                {isNum(day.diffPct) && <small className="food-ins-day-diff">{day.diffPct > 0 ? '+' : day.diffPct < 0 ? '−' : ''}{Math.abs(day.diffPct)}%</small>}
              </span>
              <Icon name="chevronRight" size={16} className="food-ins-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

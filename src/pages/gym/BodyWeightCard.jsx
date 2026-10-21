import { useMemo, useState } from 'react'
import Disclosure from '../../components/ui/Disclosure.jsx'
import WeighIn from '../../components/WeighIn.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { IconButton, Segmented } from '../../components/ui/primitives.jsx'
import { addDaysISO, formatDateShort, relativeDay } from '../../lib/dates.js'
import { weekStart } from '../../lib/gym/schedule.js'
import { deleteBodyWeight, useBodyWeights } from '../../lib/gym/state.js'
import { formatNumber, fromKg } from '../../lib/gym/units.js'
import { DEFAULT_WEIGHT_RANGE, WEIGHT_RANGES, rangeStart, weeklyWeights } from '../../lib/weighIn.js'
import { LineChart } from './charts.jsx'

// Body weight on Gym → Progress: the shared weigh-in display (latest weigh-in, its weekly trend and
// "Weigh in"), then week by week: each week's average and how it moved from the week before (an
// average smooths out day-to-day water swings). The chart over 1M/3M/1Y/All and every weigh-in,
// with delete, sit behind one tap.
const WEEKS = 8
const SHOWN_WEEKS = 6

export default function BodyWeightCard({ today, unit, firstWeekday }) {
  const entries = useBodyWeights()
  const weeks = useMemo(() => weeklyWeights(entries, today, firstWeekday, WEEKS).filter((week) => week.avgKg !== null).slice(0, SHOWN_WEEKS), [entries, today, firstWeekday])
  const kg = (value, dp = 1) => formatNumber(fromKg(value, unit), dp)

  return (
    <WeighIn today={today} className="gym-pg-bw">
      {() => (
        <>
          {weeks.length > 0 && (
            <div className="gym-pg-bw-weeks">
              <h4 className="ui-label">Week by week</h4>
              <ul>
                {weeks.map((week) => {
                  const change = week.changeKg === null ? null : Math.round(fromKg(week.changeKg, unit) * 10) / 10
                  const label = weekLabel(week.weekStart, today, firstWeekday)
                  return (
                    <li key={week.weekStart}>
                      <span className="gym-pg-bw-week">{label}</span>
                      <span className="gym-pg-bw-avg">
                        {kg(week.avgKg)} <small>{unit} avg</small>
                      </span>
                      <span className={`gym-pg-bw-change${change === null || change === 0 ? '' : change < 0 ? ' is-down' : ' is-up'}`}>
                        {change === null ? '' : change === 0 ? 'same' : `${change > 0 ? '+' : '−'}${formatNumber(Math.abs(change), 1)}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {entries.length > 1 && <AllWeighIns entries={entries} today={today} unit={unit} />}
        </>
      )}
    </WeighIn>
  )
}

// 'This week', 'Last week', else 'Week of Sep 28'.
export function weekLabel(start, today, firstWeekday) {
  const current = weekStart(today, firstWeekday)
  if (start === current) return 'This week'
  if (start === addDaysISO(current, -7)) return 'Last week'
  return `Week of ${formatDateShort(start)}`
}

function AllWeighIns({ entries, today, unit }) {
  const [range, setRange] = useState(DEFAULT_WEIGHT_RANGE)
  const [showAll, setShowAll] = useState(false)
  const from = rangeStart(range, today)
  const points = useMemo(
    () => entries.filter((entry) => !from || entry.date >= from).slice().reverse().map((entry) => ({ x: entry.date, y: fromKg(entry.kg, unit) })),
    [entries, from, unit],
  )
  const weight = (value) => `${formatNumber(fromKg(value, unit), 1)} ${unit}`
  const remove = (entry) => {
    const undo = deleteBodyWeight(entry.id)
    toast(`Removed ${weight(entry.kg)} from ${formatDateShort(entry.date)}`, { action: { label: 'Undo', onClick: undo } })
  }
  const list = showAll ? entries : entries.slice(0, 10)

  return (
    <Disclosure id="gym-progress-weight" label="Chart & all weigh-ins" summary={`${entries.length} weigh-ins`} className="gym-pg-disclosure">
      <Segmented options={WEIGHT_RANGES} value={range} onChange={setRange} label="Body weight range" className="wi-range" />
      <LineChart
        points={points}
        formatY={(value) => `${formatNumber(value, 1)} ${unit}`}
        formatTick={(value) => formatNumber(value, 1)}
        height={170}
        ariaLabel={`Body weight in ${unit}`}
        emptyText="Only one weigh-in in this range. Try a longer range."
      />
      <ul className="gym-st-bw-list">
        {list.map((entry, i) => {
          const previous = entries[i + 1]
          const delta = previous ? entry.kg - previous.kg : null
          const day = relativeDay(entry.date, today)
          return (
            <li key={entry.id}>
              <span className="gym-st-bw-date">{day}{day !== formatDateShort(entry.date) ? ` · ${formatDateShort(entry.date)}` : ''}</span>
              <strong>{weight(entry.kg)}</strong>
              <span className="gym-st-bw-delta">
                {delta === null || Math.abs(delta) < 1e-9 ? '' : `${delta > 0 ? '+' : '−'}${formatNumber(Math.abs(fromKg(delta, unit)), 1)}`}
              </span>
              <IconButton icon="trash" label={`Delete ${weight(entry.kg)} on ${formatDateShort(entry.date)}`} size={17} className="gym-st-bw-delete" onClick={() => remove(entry)} />
            </li>
          )
        })}
      </ul>
      {entries.length > 10 && (
        <button type="button" className="link-btn gym-st-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show all ${entries.length}`}
        </button>
      )}
    </Disclosure>
  )
}

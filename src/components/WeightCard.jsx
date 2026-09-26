import { Suspense, lazy, useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button } from './ui/primitives.jsx'
import { addDaysISO, relativeDay } from '../lib/dates.js'
import { latestBodyWeight, useBodyWeights, useWeightUnit } from '../lib/food/state.js'
import { fmtWeight, fmtWeightChange, weightUnitLabel } from '../pages/food/format.js'
import './today.css'

// Health → Today's weight line: the latest weigh-in, the change over the past week, and a Log
// button (the Food page's own weigh-in sheet). The line opens the weight chart.
const WeightSheet = lazy(() => import('../pages/food/WeightSheet.jsx'))

export default function WeightCard({ today, loaded = true }) {
  const bodyWeights = useBodyWeights()
  const unit = useWeightUnit()
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)

  const view = useMemo(() => {
    const latest = (Array.isArray(bodyWeights) ? bodyWeights : [])
      .filter((entry) => typeof entry?.date === 'string' && entry.date <= today && Number(entry.kg) > 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null
    if (!latest) return { main: 'No weigh-in yet', sub: 'Log your weight to see the trend' }
    const weekAgo = latestBodyWeight(bodyWeights, addDaysISO(today, -7))
    const change = weekAgo !== null && latest.date > addDaysISO(today, -7) ? Number(latest.kg) - weekAgo : null
    const when = relativeDay(latest.date, today)
    return {
      main: `${fmtWeight(latest.kg, unit)} ${weightUnitLabel(unit)}`,
      sub: `${when}${change !== null ? ` · ${fmtWeightChange(change, unit)} ${weightUnitLabel(unit)} this week` : ''}`,
    }
  }, [bodyWeights, today, unit])

  if (!loaded) return null
  return (
    <>
      <section className="card td-headline td-weight" aria-label="Weight">
        <div className="td-hl-line">
          <a className="td-weight-main" href="#/food/weight">
            <span className="td-hl-icon is-soft"><Icon name="weight" size={18} /></span>
            <span className="td-hl-text">
              <span className="td-hl-main">{view.main}</span>
              <span className="td-hl-sub">{view.sub}</span>
            </span>
          </a>
          <Button variant="secondary" size="sm" onClick={() => { setUsed(true); setOpen(true) }}>Log</Button>
        </div>
      </section>
      {used && (
        <Suspense fallback={null}>
          <WeightSheet open={open} onClose={() => setOpen(false)} date={today} today={today} />
        </Suspense>
      )}
    </>
  )
}

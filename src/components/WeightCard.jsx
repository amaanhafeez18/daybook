import { Suspense, lazy, useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { readPref, writePref } from '../lib/api.js'
import { addDaysISO, relativeDay } from '../lib/dates.js'
import { weighInNudge } from '../lib/food/coach.js'
import { latestBodyWeight, setNudge, useBodyWeights, useFood, useWeightUnit } from '../lib/food/state.js'
import { fmtWeight, fmtWeightChange, weightUnitLabel } from '../pages/food/format.js'
import './today.css'
import './food-quick.css' // the shared Health card header (see the end of that file)

// Health → Today's weight line: the latest weigh-in, the change over the past week, and a Log
// button (the Food page's own weigh-in sheet). The line opens the weight chart. When the last
// weigh-in was 4–30 days ago (and the reminder is on in Food settings → Nudges), the second line
// says so in the accent colour, with × to hide it for the day on this device.
const WeightSheet = lazy(() => import('../pages/food/WeightSheet.jsx'))

const NUDGE_PREF = 'food.nudge.weighIn' // the day the weigh-in nudge was hidden (this device)

export default function WeightCard({ today, loaded = true }) {
  const bodyWeights = useBodyWeights()
  const unit = useWeightUnit()
  const nudgeOn = useFood().prefs.nudges?.weighIn !== false
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  const [hiddenOn, setHiddenOn] = useState(() => readPref(NUDGE_PREF, null))

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
  const nudge = useMemo(() => (nudgeOn && hiddenOn !== today ? weighInNudge(bodyWeights, today) : null), [nudgeOn, hiddenOn, bodyWeights, today])

  function hideNudge() {
    writePref(NUDGE_PREF, today)
    setHiddenOn(today)
    toast('Hidden for today', {
      action: {
        label: 'Turn off',
        onClick: () => {
          const undo = setNudge('weighIn', false)
          toast('Weigh-in reminder turned off', { action: { label: 'Undo', onClick: undo } })
        },
      },
    })
  }

  if (!loaded) return null
  return (
    <>
      <section className="card td-headline td-weight" aria-label="Weight">
        <div className="td-hl-line">
          <a className="td-weight-main" href="#/food/weight">
            <span className="td-hl-icon is-soft"><Icon name="weight" size={20} /></span>
            <span className="td-hl-text">
              <span className="td-hl-main">{view.main}</span>
              <span className={`td-hl-sub${nudge ? ' td-nudge' : ''}`}>
                {nudge ? `Last weigh-in ${nudge.days} days ago` : view.sub}
              </span>
            </span>
          </a>
          {nudge && (
            <button type="button" className="td-nudge-x" onClick={hideNudge} aria-label="Hide the weigh-in reminder for today">
              <Icon name="close" size={16} />
            </button>
          )}
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

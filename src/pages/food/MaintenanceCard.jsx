import { useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { diffDays } from '../../lib/dates.js'
import { haptic } from '../../lib/haptics.js'
import { maintenanceOffer } from '../../lib/food/coach.js'
import { approxEnergy, calcGoals, goalFromMaintenance, maintenanceLine, measuredMaintenance } from '../../lib/food/nutrition.js'
import { applyMaintenanceGoal, dismissMaintenance, latestBodyWeight, useBodyWeights, useFoodEntries } from '../../lib/food/state.js'
import { useStore } from '../../lib/store.js'
import { NUTRIENT_INFO, energyNumber, fmtEnergy, fmtInt, inUnits, isNum, unitLabel } from './format.js'
import '../../components/food-quick.css' // .food-mx-* (with the other food coach styles)

// Food → Goals: what you actually burn, measured from what you've logged and how your weight
// trend moved (measuredMaintenance), with a two-tap "Update my goal" that keeps the pace you're
// after. While there isn't enough to go on it shows how close it is; nothing changes the goal
// without the two taps.

const GRAM_KEYS = ['carbs', 'fat', 'fiber', 'protein']

function changeText(change, unit) {
  if (change.key === 'calories') {
    const from = isNum(change.from) ? energyNumber(change.from, unit) : '—'
    return `Calories ${from} → ${energyNumber(change.to, unit)} ${unitLabel(unit)}`
  }
  const label = NUTRIENT_INFO[change.key]?.label || change.key
  return `${label} ${isNum(change.from) ? fmtInt(change.from) : '—'} → ${isNum(change.to) ? fmtInt(change.to) : '—'} g`
}

// "Calories 2,100 → 1,800 kcal", "Carbs 230 → 155 g", "Protein stays 150 g".
function planLines(plan, goals, unit) {
  const lines = []
  const calories = plan.changes.find((change) => change.key === 'calories')
  if (calories) lines.push(changeText(calories, unit))
  for (const key of GRAM_KEYS) {
    const change = plan.changes.find((item) => item.key === key)
    if (change) lines.push(changeText(change, unit))
    else if ((key === 'protein' || key === 'fat') && isNum(goals[key])) lines.push(`${NUTRIENT_INFO[key].label} stays ${fmtInt(goals[key])} g`)
  }
  return lines
}

export default function MaintenanceCard({ food, unit, weightUnit, today }) {
  const entries = useFoodEntries()
  const bodyWeights = useBodyWeights()
  const hydrated = useStore((state) => state.hydrated)
  const [confirming, setConfirming] = useState(false)
  const latestKg = latestBodyWeight(bodyWeights)
  const weighedOn = useMemo(
    () => (Array.isArray(bodyWeights) ? bodyWeights : []).filter((row) => typeof row?.date === 'string' && row.date <= today).map((row) => row.date).sort().pop() || null,
    [bodyWeights, today],
  )
  const formulaTdee = useMemo(() => calcGoals(food.profile, { weightKg: latestKg, today }).tdee, [food.profile, latestKg, today])
  const m = useMemo(() => measuredMaintenance(entries, bodyWeights, today, { formulaTdee }), [entries, bodyWeights, today, formulaTdee])
  const plan = useMemo(() => goalFromMaintenance(m, food, { weightKg: latestKg, today }), [m, food, latestKg, today])

  if (!hydrated) return null

  if (m.status === 'gathering') {
    const { progress } = m
    // Shown once there's a weigh-in in the last 28 days, today's included (the measuring window
    // ends yesterday, so progress.weighIns doesn't count one made today).
    if (!weighedOn || diffDays(weighedOn, today) > 27 || progress.loggedDays < 3) return null
    const met = progress.keptDays >= progress.needDays && progress.weighIns >= progress.needWeighIns
    return (
      <section className="card food-mx is-quiet" aria-label="Measured maintenance">
        <span className="ui-label food-mx-label"><Icon name="scale" size={15} />Measured maintenance</span>
        <p className="food-mx-text">
          {met
            ? 'Almost there. Keep logging and weighing in, and check back in a few days.'
            : `Keep logging: ${Math.min(progress.keptDays, progress.needDays)} of ${progress.needDays} days · ${Math.min(progress.weighIns, progress.needWeighIns)} of ${progress.needWeighIns} weigh-ins`}
        </p>
        <p className="food-mx-hint">Your logs and weight trend will show what you actually burn.</p>
      </section>
    )
  }

  if (m.status !== 'ready') {
    return (
      <section className="card food-mx is-quiet" aria-label="Measured maintenance">
        <span className="ui-label food-mx-label"><Icon name="scale" size={15} />Measured maintenance</span>
        <p className="food-mx-text">Not steady enough to measure yet. Big weight swings or missed logs. Check back in a week.</p>
      </section>
    )
  }

  const offer = maintenanceOffer(plan, m.kcal, food.coach?.maintenance, today)
  const good = m.confidence === 'good'

  function update() {
    if (!plan) return
    let undo
    try {
      undo = applyMaintenanceGoal(plan, m, { today, weightKg: latestKg, weighedOn })
    } catch (error) {
      toast(error?.message || 'Couldn’t update your goal.', { tone: 'error' })
      return
    }
    setConfirming(false)
    haptic('success')
    toast(`Goal updated to ${fmtEnergy(plan.calories, unit)}`, { action: { label: 'Undo', onClick: undo } })
  }

  function notNow() {
    const undo = dismissMaintenance(m.kcal, today)
    setConfirming(false)
    toast('Hidden until the estimate changes', { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <section className="card food-mx" aria-label="Measured maintenance">
      <span className="ui-label food-mx-label"><Icon name="scale" size={15} />Measured maintenance</span>
      <div className="food-mx-head">
        <strong className="food-mx-num">~{approxEnergy(m.kcal, unit, 50)}<small>{unitLabel(unit)}</small></strong>
        <span className={`food-mx-pill${good ? ' is-good' : ''}`}>{good ? 'Good estimate' : 'Early estimate'}</span>
      </div>
      <p className="food-mx-text">{maintenanceLine(m, { unit, weightUnit })}</p>
      {m.differsFromFormula && isNum(formulaTdee) && (
        <p className="food-mx-warn">
          <Icon name="info" size={15} />
          <span>Very different from the formula ({approxEnergy(formulaTdee, unit, 50)}). Check you’re logging everything.</span>
        </p>
      )}
      {offer === 'fits' && <p className="food-mx-hint"><Icon name="check" size={15} strokeWidth={2.6} />Your goal already fits what you burn.</p>}
      {offer === 'offer' && plan && (confirming ? (
        <div className="food-mx-confirm">
          <ul className="food-mx-changes">
            {planLines(plan, food.goals, unit).map((line) => <li key={line}>{line}</li>)}
          </ul>
          {plan.warnings.map((warning) => <p key={warning} className="food-mx-hint"><Icon name="info" size={15} />{inUnits(warning, unit, weightUnit)}</p>)}
          <div className="food-mx-actions">
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button className="btn-grow" icon="check" onClick={update}>Update</Button>
          </div>
        </div>
      ) : (
        <div className="food-mx-actions">
          <Button variant="secondary" onClick={notNow}>Not now</Button>
          <Button className="btn-grow" onClick={() => setConfirming(true)}>Update my goal</Button>
        </div>
      ))}
    </section>
  )
}

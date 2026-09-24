import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Disclosure from '../../components/ui/Disclosure.jsx'
import Icon from '../../components/ui/Icon.jsx'
import { Button, Segmented } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { addDaysISO } from '../../lib/dates.js'
import { ACTIVITY_LEVELS, KCAL_PER_G, RATE_OPTIONS, calcGoals, energyInUnit, energyToKcal } from '../../lib/food/nutrition.js'
import { addBodyWeight, deleteBodyWeight, getFood, latestBodyWeight, setGoals, updateFood, useBodyWeights, useFood, useWeightUnit } from '../../lib/food/state.js'
import { refresh, useStore } from '../../lib/store.js'
import { DetailTop, goBack } from './common.jsx'
import { NUTRIENT_INFO, fmtInt, fmtNum, isNum, kgToUnit, shortDay, toNum, unitLabel, unitToKg, weightUnitLabel } from './format.js'

// #/food/goals. The default path is "Calculate for me": a few facts about you, your activity and
// what you're after → a daily calorie goal (Mifflin-St Jeor, or Katch-McArdle with a body fat %)
// with safety floors, explained in plain words, and macros you can adjust. Body fat sits behind
// "More options"; typing your own numbers instead is one link away ("Set goals manually"), and is
// where the page starts when the current goals were set that way. Every goal is optional.

const SEXES = [{ id: 'female', label: 'Female' }, { id: 'male', label: 'Male' }, { id: 'none', label: 'Not given' }]
const GOAL_TYPES = [{ id: 'lose', label: 'Lose' }, { id: 'maintain', label: 'Maintain' }, { id: 'gain', label: 'Gain' }]
const HEIGHT_UNITS = [{ id: 'cm', label: 'cm' }, { id: 'ftin', label: 'ft / in' }]
// Research §3: 0.25/0.5/0.75/1 kg is shown as 0.5/1/1.5/2 lb; gain 0.1/0.25/0.5 kg as ¼/½/1 lb.
const LB_LABELS = { 0.1: '0.25', 0.25: '0.5', 0.5: '1', 0.75: '1.5', 1: '2' }
const MANUAL_KEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium']
const MANUAL_MAIN = ['calories', 'protein', 'carbs', 'fat']

const numText = (value, dp = 1) => (isNum(value) ? String(Math.round(value * 10 ** dp) / 10 ** dp) : '')

// A pace as its chip reads ('0.5 lb' for 0.25 kg, research §3); other values to two decimals.
function paceLabel(kg, weightUnit) {
  const abs = Math.abs(kg)
  if (weightUnit !== 'lb') return `${fmtNum(abs, 2)} kg`
  const known = Object.keys(LB_LABELS).find((key) => Math.abs(Number(key) - abs) < 0.005)
  return `${known ? LB_LABELS[known] : fmtNum(kgToUnit(abs, 'lb'), 2)} lb`
}

// Thousands grouped while the field isn't being edited ('2,730'); the raw digits while it is.
function useGroupedText(value, dp = 0) {
  const [focused, setFocused] = useState(false)
  const n = toNum(value)
  const shown = focused || n === null ? value : fmtNum(n, dp)
  return { shown, onFocus: () => setFocused(true), onBlur: () => setFocused(false) }
}

function profileForm(profile, latestKg, weightUnit) {
  const cm = profile.heightCm
  // To the nearest half inch, carried into feet (182 cm → 5 ft 11.5 in, never "5 ft 12 in"), so a
  // height saved in ft/in shows as it was typed.
  const inches = isNum(cm) ? Math.round((cm / 2.54) * 2) / 2 : null
  const feet = inches !== null ? Math.floor(inches / 12) : null
  return {
    sex: profile.sex || 'none',
    birthYear: profile.birthYear ? String(profile.birthYear) : '',
    heightCm: numText(cm, 0),
    feet: feet !== null ? String(feet) : '',
    inches: inches !== null ? String(inches - feet * 12) : '',
    weight: latestKg ? numText(kgToUnit(latestKg, weightUnit), 1) : '',
    activity: profile.activity || 'moderate',
    goal: profile.goal || 'maintain',
    rate: profile.rateKgPerWeek,
    target: isNum(profile.targetKg) ? numText(kgToUnit(profile.targetKg, weightUnit), 1) : '',
    bodyFat: isNum(profile.bodyFatPct) ? numText(profile.bodyFatPct, 1) : '',
  }
}

export default function GoalWizard({ today }) {
  const food = useFood()
  const bodyWeights = useBodyWeights()
  const weightUnit = useWeightUnit()
  const hydrated = useStore((state) => state.hydrated)
  const loadFailed = useStore((state) => state.loaded && !state.syncing && !state.hydrated)
  const unit = food.prefs.energyUnit
  const latestKg = latestBodyWeight(bodyWeights)
  const [mode, setMode] = useState(() => (food.goals.source === 'manual' && food.goals.calories ? 'manual' : 'calc'))
  const [step, setStep] = useState(1)
  const [heightUnit, setHeightUnit] = useState(weightUnit === 'lb' ? 'ftin' : 'cm')
  const [form, setForm] = useState(() => profileForm(food.profile, latestKg, weightUnit))
  const [macros, setMacros] = useState(null)
  const dirty = useRef(false)
  const topRef = useRef(null)

  // Data that arrives after the page opened (first load) fills the form, unless it was edited.
  useEffect(() => {
    if (dirty.current) return
    setForm(profileForm(food.profile, latestKg, weightUnit))
  }, [hydrated, latestKg, weightUnit]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    window.scrollTo({ top: 0 })
  }, [step, mode])

  const set = (field, value) => {
    dirty.current = true
    setForm((current) => ({ ...current, [field]: value }))
  }

  const heightCm = heightUnit === 'cm'
    ? toNum(form.heightCm)
    : (toNum(form.feet) !== null || toNum(form.inches) !== null) ? ((toNum(form.feet) ?? 0) * 12 + (toNum(form.inches) ?? 0)) * 2.54 : null
  const weightKg = unitToKg(toNum(form.weight), weightUnit)
  const targetKg = unitToKg(toNum(form.target), weightUnit)
  const profile = useMemo(() => ({
    sex: form.sex === 'none' ? null : form.sex,
    birthYear: toNum(form.birthYear),
    heightCm: isNum(heightCm) ? Math.round(heightCm * 10) / 10 : null,
    activity: form.activity,
    goal: form.goal,
    rateKgPerWeek: form.goal === 'maintain' ? food.profile.rateKgPerWeek : form.rate,
    targetKg: isNum(targetKg) ? Math.round(targetKg * 10) / 10 : null,
    bodyFatPct: toNum(form.bodyFat),
  }), [form, heightCm, targetKg, food.profile.rateKgPerWeek])
  const result = useMemo(() => calcGoals(profile, { weightKg, today }), [profile, weightKg, today])

  const rates = RATE_OPTIONS[form.goal] || []
  const rateLabel = (kg) => paceLabel(kg, weightUnit)

  // A new goal type starts at its own default pace (lose 0.5, gain 0.25 kg a week) rather than
  // carrying over a pace chosen for the other direction (0.5 is the largest gain pace).
  function chooseGoal(goal) {
    dirty.current = true
    setForm((current) => {
      if (goal === current.goal) return current
      const rate = goal === 'lose' ? 0.5 : goal === 'gain' ? 0.25 : current.rate
      return { ...current, goal, rate }
    })
  }

  function calculate(event) {
    event?.preventDefault()
    if (result.missing.length) return
    setMacros({
      calories: String(Math.round(energyInUnit(result.calories, unit))),
      protein: String(result.protein),
      carbs: String(result.carbs),
      fat: String(result.fat),
      fiber: String(result.fiber),
    })
    setStep(2)
  }

  // Saves goals (and the profile, and today's weight when it was typed in); Undo restores all.
  function saveCalculated() {
    const values = Object.fromEntries(Object.entries(macros).map(([key, value]) => [key, toNum(value)]))
    const kcal = isNum(values.calories) ? energyToKcal(values.calories, unit) : null
    const beforeProfile = getFood().profile
    const undoGoals = setGoals({ calories: kcal, protein: values.protein, carbs: values.carbs, fat: values.fat, fiber: values.fiber, source: 'calculator' })
    updateFood((current) => ({ profile: { ...current.profile, ...profile } }))
    let undoWeight = null
    if (isNum(weightKg) && (!isNum(latestKg) || Math.abs(weightKg - latestKg) > 0.05)) {
      try {
        const existing = bodyWeights.find((entry) => entry.date === today)
        const saved = addBodyWeight(today, Math.round(weightKg * 1000) / 1000)
        undoWeight = existing ? () => addBodyWeight(today, existing.kg) : () => saved && deleteBodyWeight(saved.id)
      } catch {
        // the goal still saves; the weight just isn't logged
      }
    }
    toast(undoWeight ? 'Goals saved · weight logged for today' : 'Goals saved', {
      action: {
        label: 'Undo',
        onClick: () => {
          undoGoals()
          updateFood({ profile: beforeProfile })
          undoWeight?.()
        },
      },
    })
    goBack('food')
  }

  const header = (
    <>
      <DetailTop />
      <header className="food-page-head" ref={topRef}>
        <h1>Goals</h1>
        <p className="page-subtitle">{mode === 'manual' ? 'Type your own daily goals. Every goal is optional.' : 'A daily calorie goal worked out from a few facts about you. Change it any time.'}</p>
      </header>
    </>
  )

  if (!hydrated) {
    return (
      <div className="food-goals">
        {header}
        {loadFailed ? (
          <div className="food-note" role="status">
            <Icon name="cloudOff" size={18} />
            <span>Your goals haven’t loaded yet — check your connection. <button type="button" className="food-link" onClick={() => refresh().catch(() => {})}>Try again</button></span>
          </div>
        ) : (
          <p className="food-note" role="status"><span className="spinner" aria-hidden="true" />Loading your goals…</p>
        )}
      </div>
    )
  }

  const switchMode = (next) => {
    setMode(next)
    setStep(1)
  }

  return (
    <div className="food-goals">
      {header}

      {mode === 'manual' ? (
        <>
          <ManualGoals food={food} unit={unit} />
          <p className="food-goals-switch">
            <button type="button" className="food-link" onClick={() => switchMode('calc')}><Icon name="calculator" size={16} />Calculate for me instead</button>
          </p>
        </>
      ) : step === 1 ? (
        <form className="food-cfg" onSubmit={calculate}>
          <section className="food-cfg-group">
            <h3 className="food-cfg-title">About you</h3>
            <div className="food-cfg-card">
              <div className="food-cfg-row is-stacked">
                <span className="food-cfg-label"><span>Sex</span><small>Optional — it changes the calculation a little</small></span>
                <Segmented options={SEXES} value={form.sex} onChange={(value) => set('sex', value)} label="Sex" />
              </div>
              <FieldRow label="Birth year" value={form.birthYear} onChange={(value) => set('birthYear', value.replace(/[^\d]/g, '').slice(0, 4))} placeholder="1996" inputMode="numeric" />
              <div className="food-cfg-row is-stacked">
                <span className="food-cfg-label food-cfg-label-row">
                  <span>Height</span>
                  <Segmented options={HEIGHT_UNITS} value={heightUnit} onChange={setHeightUnit} label="Height unit" className="food-seg-sm" />
                </span>
                {heightUnit === 'cm' ? (
                  <UnitInput value={form.heightCm} onChange={(value) => set('heightCm', value)} suffix="cm" label="Height in centimetres" placeholder="175" />
                ) : (
                  <span className="food-goal-ftin">
                    <UnitInput value={form.feet} onChange={(value) => set('feet', value)} suffix="ft" label="Feet" placeholder="5" inputMode="numeric" />
                    <UnitInput value={form.inches} onChange={(value) => set('inches', value)} suffix="in" label="Inches" placeholder="9" />
                  </span>
                )}
              </div>
              <div className="food-cfg-row is-stacked">
                <span className="food-cfg-label"><span>Current weight</span><small>{isNum(latestKg) ? 'From your weigh-ins' : 'Also saved as today’s weigh-in'}</small></span>
                <UnitInput value={form.weight} onChange={(value) => set('weight', value)} suffix={weightUnitLabel(weightUnit)} label="Current weight" placeholder={weightUnit === 'lb' ? '170' : '75'} />
              </div>
            </div>
          </section>

          <section className="food-cfg-group">
            <h3 className="food-cfg-title">Activity</h3>
            <div className="food-cfg-card" role="radiogroup" aria-label="Activity">
              {ACTIVITY_LEVELS.map((level) => (
                <button key={level.id} type="button" role="radio" aria-checked={form.activity === level.id} className={`food-cfg-row food-choice${form.activity === level.id ? ' is-active' : ''}`} onClick={() => set('activity', level.id)}>
                  <span className="food-cfg-label"><span>{level.label}</span><small>{level.detail}</small></span>
                  <span className="food-choice-mark" aria-hidden="true">{form.activity === level.id && <Icon name="check" size={18} strokeWidth={2.6} />}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="food-cfg-group">
            <h3 className="food-cfg-title">Goal</h3>
            <div className="food-cfg-card">
              <div className="food-cfg-row is-stacked">
                <Segmented options={GOAL_TYPES} value={form.goal} onChange={chooseGoal} label="Goal" />
              </div>
              {rates.length > 0 && (
                <div className="food-cfg-row is-stacked">
                  <span className="food-cfg-label"><span>Pace per week</span><small>Slower is easier to keep up</small></span>
                  <span className="food-goal-rates" role="radiogroup" aria-label="Pace per week">
                    {rates.map((kg) => (
                      <button key={kg} type="button" role="radio" aria-checked={form.rate === kg} className={`chip chip-sm food-chip${form.rate === kg ? ' is-active' : ''}`} onClick={() => set('rate', kg)}>
                        {rateLabel(kg)}
                      </button>
                    ))}
                  </span>
                </div>
              )}
              {form.goal !== 'maintain' && (
                <div className="food-cfg-row is-stacked">
                  <span className="food-cfg-label"><span>Goal weight</span><small>Optional — shows on your weight chart with an estimated date</small></span>
                  <UnitInput value={form.target} onChange={(value) => set('target', value)} suffix={weightUnitLabel(weightUnit)} label="Goal weight" placeholder="—" />
                </div>
              )}
            </div>
          </section>

          <Disclosure id="food-goals-more" label="More options" summary={form.bodyFat.trim() ? `Body fat ${form.bodyFat.trim()}%` : 'Body fat %'} hasValues={!!form.bodyFat.trim() || isNum(food.profile.bodyFatPct)} className="food-goals-more">
            <section className="food-cfg-group">
              <div className="food-cfg-card">
                <div className="food-cfg-row is-stacked">
                  <span className="food-cfg-label"><span>Body fat</span><small>Optional — if you know it, the calculation uses your lean mass instead of height and age</small></span>
                  <UnitInput value={form.bodyFat} onChange={(value) => set('bodyFat', value)} suffix="%" label="Body fat percent" placeholder="—" />
                </div>
              </div>
            </section>
          </Disclosure>

          {result.missing.length > 0 && <p className="food-cfg-foot">{result.warnings[0]}</p>}
          <Button type="submit" size="lg" className="btn-block" disabled={result.missing.length > 0}>Calculate</Button>
          <p className="food-goals-switch">
            <button type="button" className="food-link" onClick={() => switchMode('manual')}><Icon name="pencil" size={16} />Set goals manually instead</button>
          </p>
        </form>
      ) : (
        <GoalResult result={result} profile={profile} unit={unit} weightUnit={weightUnit} today={today} macros={macros} setMacros={setMacros} onBack={() => setStep(1)} onSave={saveCalculated} />
      )}
    </div>
  )
}

function FieldRow({ label, value, onChange, placeholder, inputMode = 'decimal', suffix }) {
  const id = useId()
  return (
    <div className="food-cfg-row">
      <label className="food-cfg-label" htmlFor={id}><span>{label}</span></label>
      <span className="food-cfg-control">
        <span className="food-unit-input">
          <input id={id} className="input" inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" enterKeyHint="done" />
          {suffix && <span>{suffix}</span>}
        </span>
      </span>
    </div>
  )
}

// grouped: a number that can reach the thousands (calories) shows grouped while not being edited.
function UnitInput({ value, onChange, suffix, label, placeholder, inputMode = 'decimal', grouped = false }) {
  const text = useGroupedText(value, 2)
  return (
    <span className="food-unit-input">
      <input
        className="input"
        inputMode={inputMode}
        value={grouped ? text.shown : value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={grouped ? text.onFocus : undefined}
        onBlur={grouped ? text.onBlur : undefined}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        enterKeyHint="done"
      />
      <span aria-hidden="true">{suffix}</span>
    </span>
  )
}

function GoalResult({ result, profile, unit, weightUnit, today, macros, setMacros, onBack, onSave }) {
  const u = weightUnitLabel(weightUnit)
  const e = unitLabel(unit)
  const kcal = energyToKcal(toNum(macros.calories), unit)
  const grams = { protein: toNum(macros.protein), carbs: toNum(macros.carbs), fat: toNum(macros.fat) }
  const macroKcal = (grams.protein ?? 0) * KCAL_PER_G.protein + (grams.carbs ?? 0) * KCAL_PER_G.carbs + (grams.fat ?? 0) * KCAL_PER_G.fat
  const pct = (key) => (isNum(kcal) && kcal > 0 && isNum(grams[key]) ? Math.round((grams[key] * KCAL_PER_G[key] * 100) / kcal) : null)
  const mismatch = isNum(kcal) && kcal > 0 && Math.abs(macroKcal - kcal) > Math.max(50, kcal * 0.05)
  const pace = result.pace
  const paceText = isNum(pace) && Math.abs(pace) >= 0.01
    ? `${pace < 0 ? 'Losing' : 'Gaining'} about ${paceLabel(pace, weightUnit)} a week`
    : 'Holding your weight steady'
  const hero = useGroupedText(macros.calories)
  const etaDate = isNum(result.etaWeeks) && result.etaWeeks > 0 ? addDaysISO(today, Math.ceil(result.etaWeeks * 7)) : null
  const blocked = result.blocked ? result.warnings[0] : null
  const warnings = result.blocked ? result.warnings.slice(1) : result.warnings
  const set = (key, value) => setMacros((current) => ({ ...current, [key]: value }))
  const valid = isNum(toNum(macros.calories)) && toNum(macros.calories) > 0
  const macroLine = ['protein', 'carbs', 'fat', 'fiber'].map((key) => `${NUTRIENT_INFO[key].short} ${macros[key] || '—'} g`).join(' · ')
  // The gap between the goal and maintenance, as it reads: "300 kcal under".
  const gap = isNum(result.tdee) ? Math.round(energyInUnit(result.calories - result.tdee, unit)) : null

  return (
    <div className="food-cfg food-goal-result">
      {blocked && <p className="food-note is-warning"><Icon name="info" size={18} /><span>{blocked}</span></p>}

      <section className="card food-goal-hero">
        <span className="food-goal-hero-label">Daily calories</span>
        <span className="food-goal-hero-value">
          {/* Grouped while not being edited ('2,730'), and as wide as its text: a 5-digit kJ goal
              (10,878) must not be cut off. */}
          <input
            className="food-goal-hero-input"
            inputMode="numeric"
            value={hero.shown}
            onChange={(event) => set('calories', event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            onFocus={hero.onFocus}
            onBlur={hero.onBlur}
            aria-label={`Daily calories in ${e}`}
            style={{ width: `${Math.max(3, String(hero.shown || '').length) + 0.6}ch` }}
          />
          <small>{e}</small>
        </span>
        <span className="food-goal-hero-sub">{paceText}{etaDate && isNum(profile.targetKg) ? ` · ${fmtNum(kgToUnit(profile.targetKg, weightUnit), 1)} ${u} around ${shortDay(etaDate)}` : ''}</span>
        <span className="food-goal-hero-hint">Tap the number to change it.</span>
      </section>

      {warnings.length > 0 && (
        <ul className="food-goal-warnings">
          {warnings.map((warning) => <li key={warning}><Icon name="info" size={16} />{warning}</li>)}
        </ul>
      )}

      {!valid && <p className="food-cfg-foot">Enter a calorie goal above to save.</p>}

      <Disclosure id="food-goals-how" label="How this was worked out" className="food-goals-how">
        <ol className="food-goal-steps">
          <li>
            <strong>{fmtInt(energyInUnit(result.bmr, unit))} {e} at rest.</strong>
            <span>What your body uses in a day doing nothing at all (sometimes called BMR{result.method === 'katch' ? ', from your lean mass' : ', from your weight, height, age and sex'}).</span>
          </li>
          <li>
            <strong>{fmtInt(energyInUnit(result.tdee, unit))} {e} to stay the same.</strong>
            <span>At rest plus your activity level — eating this much keeps your weight steady (your maintenance).</span>
          </li>
          <li>
            <strong>{fmtInt(energyInUnit(result.calories, unit))} {e} a day{gap !== null && gap !== 0 ? ` is ${fmtInt(Math.abs(gap))} ${gap < 0 ? 'under' : 'over'} that` : ''}.</strong>
            <span>{isNum(pace) && Math.abs(pace) >= 0.01 ? `That gap adds up to about ${paceLabel(pace, weightUnit)} a week.` : 'No gap, so your weight should hold.'}{result.floorApplied ? ' It was raised to a safe minimum.' : ''}</span>
          </li>
        </ol>
      </Disclosure>

      <Disclosure id="food-goals-macros" label="Protein, carbs and fat" summary={macroLine} className="food-goals-macros">
        <section className="food-cfg-group">
          <div className="food-cfg-card">
            {['protein', 'carbs', 'fat', 'fiber'].map((key) => (
              <div key={key} className={`food-cfg-row food-goal-macro is-${key}`}>
                <span className="food-cfg-label">
                  <span className="food-goal-macro-name">{NUTRIENT_INFO[key].label}</span>
                  {key !== 'fiber' && pct(key) !== null && <small>{pct(key)}% of calories</small>}
                  {key === 'fiber' && <small>About 14 g per 1,000 kcal</small>}
                </span>
                <span className="food-cfg-control">
                  <UnitInput value={macros[key]} onChange={(value) => set(key, value)} suffix="g" label={`${NUTRIENT_INFO[key].label} grams`} placeholder="—" />
                </span>
              </div>
            ))}
          </div>
          <p className="food-cfg-foot">
            {mismatch
              ? `Protein, carbs and fat add up to ${fmtInt(energyInUnit(macroKcal, unit))} ${e} — ${macroKcal > kcal ? 'more' : 'less'} than the calorie goal.`
              : `Protein ${fmtNum(result.refKg ? result.protein / result.refKg : 0, 1)} g per kg of body weight; fat about ${Math.round(((result.fat * 9) / result.calories) * 100)}% of calories; carbs make up the rest.`}
          </p>
        </section>
      </Disclosure>

      <p className="food-cfg-foot">Estimates, not prescriptions — your real maintenance shows up in your weight trend after a few weeks. Not for medical nutrition therapy.</p>

      <div className="food-goal-actions">
        <Button variant="secondary" onClick={onBack} icon="chevronLeft">Edit details</Button>
        <Button className="btn-grow" onClick={onSave} disabled={!valid}>Save goals</Button>
      </div>
    </div>
  )
}

function ManualGoals({ food, unit }) {
  const { goals, prefs } = food
  const keys = MANUAL_KEYS.filter((key) => key === 'calories' || ['protein', 'carbs', 'fat', 'fiber'].includes(key) || prefs.nutrients.includes(key))
  const moreKeys = keys.filter((key) => !MANUAL_MAIN.includes(key))
  const [values, setValues] = useState(() => Object.fromEntries(MANUAL_KEYS.map((key) => [key, isNum(goals[key]) ? String(Math.round(key === 'calories' ? energyInUnit(goals[key], unit) : goals[key])) : ''])))
  const invalid = keys.some((key) => values[key].trim() && (toNum(values[key]) === null || toNum(values[key]) < 0))
  const kcal = energyToKcal(toNum(values.calories), unit)
  const macroKcal = ['protein', 'carbs', 'fat'].reduce((sum, key) => sum + (toNum(values[key]) ?? 0) * KCAL_PER_G[key], 0)
  const hasMacros = ['protein', 'carbs', 'fat'].some((key) => toNum(values[key]) !== null)
  const moreSet = moreKeys.filter((key) => values[key].trim())
  const moreSummary = moreSet.length
    ? moreSet.map((key) => `${NUTRIENT_INFO[key].label} ${values[key].trim()} ${NUTRIENT_INFO[key].unit}`).join(' · ')
    : moreKeys.map((key) => NUTRIENT_INFO[key].label).join(', ')

  function save(event) {
    event?.preventDefault()
    if (invalid) return
    const next = { source: 'manual' }
    for (const key of MANUAL_KEYS) {
      const n = toNum(values[key])
      next[key] = n === null || n <= 0 ? null : key === 'calories' ? energyToKcal(n, unit) : n
    }
    const undo = setGoals(next)
    toast('Goals saved', { action: { label: 'Undo', onClick: undo } })
    goBack('food')
  }

  const row = (key) => {
    const info = NUTRIENT_INFO[key]
    const label = key === 'calories' ? 'Calories' : info.label
    const suffix = key === 'calories' ? unitLabel(unit) : info.unit
    return (
      <div key={key} className={`food-cfg-row${info ? ` food-goal-macro is-${key}` : ''}`}>
        <span className="food-cfg-label">
          <span className={info ? 'food-goal-macro-name' : ''}>{label}</span>
          {info?.limit && <small>A limit: stay under it</small>}
        </span>
        <span className="food-cfg-control">
          <UnitInput value={values[key]} onChange={(value) => setValues((current) => ({ ...current, [key]: value }))} suffix={suffix} label={`${label} goal`} placeholder="—" grouped={key === 'calories'} />
        </span>
      </div>
    )
  }

  return (
    <form className="food-cfg" onSubmit={save}>
      <section className="food-cfg-group">
        <h3 className="food-cfg-title">Daily goals</h3>
        <div className="food-cfg-card">{MANUAL_MAIN.map(row)}</div>
        <p className="food-cfg-foot">
          {hasMacros && isNum(kcal) && kcal > 0
            ? `Protein, carbs and fat add up to ${fmtInt(energyInUnit(macroKcal, unit))} ${unitLabel(unit)}.`
            : 'Leave a field empty for no goal — its bar then shows grams only.'}
        </p>
      </section>
      {moreKeys.length > 0 && (
        <Disclosure id="food-goals-manual-more" label="More goals" summary={moreSummary} hasValues={moreSet.length > 0} className="food-goals-manual-more">
          <section className="food-cfg-group">
            <div className="food-cfg-card">{moreKeys.map(row)}</div>
            <p className="food-cfg-foot">Sugar and sodium goals appear here when they’re shown (Food settings → Advanced → Nutrients shown).</p>
          </section>
        </Disclosure>
      )}
      {invalid && <p className="field-error" role="alert">Goals must be positive numbers.</p>}
      <Button type="submit" size="lg" className="btn-block" disabled={invalid}>Save goals</Button>
    </form>
  )
}

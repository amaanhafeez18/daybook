import { useEffect, useId, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { isISODate } from '../../lib/dates.js'
import { addBodyWeight, deleteBodyWeight, latestBodyWeight, useBodyWeights, useWeightUnit } from '../../lib/food/state.js'
import { dayLabel, fmtNum, kgToUnit, toNum, unitToKg, weightUnitLabel } from './format.js'

// Log a weigh-in: a big number prefilled with the last weight (or that day's), ±0.1 steppers and
// the date (the viewed day by default). One entry per day: saving again replaces that day's value.

export default function WeightSheet({ open, onClose, date, today }) {
  const bodyWeights = useBodyWeights()
  const unit = useWeightUnit()
  const [value, setValue] = useState('')
  const [day, setDay] = useState(date || today)
  const [error, setError] = useState('')
  const inputId = useId()
  const dateId = useId()

  const existing = bodyWeights.find((entry) => entry.date === day) || null

  useEffect(() => {
    if (!open) return
    const start = isISODate(date) && date <= today ? date : today
    setDay(start)
    const onDay = bodyWeights.find((entry) => entry.date === start)
    const kg = onDay ? onDay.kg : latestBodyWeight(bodyWeights, start) ?? latestBodyWeight(bodyWeights)
    setValue(kg ? String(Math.round(kgToUnit(kg, unit) * 10) / 10) : '')
    setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const number = toNum(value)
  const valid = number !== null && number > 0 && unitToKg(number, unit) <= 700

  function step(delta) {
    const base = number ?? kgToUnit(latestBodyWeight(bodyWeights) ?? (unit === 'lb' ? 70 / 0.45359237 : 70), unit)
    setValue(String(Math.max(0.1, Math.round((base + delta) * 10) / 10)))
  }

  function save() {
    if (!valid) {
      setError('Enter your weight.')
      return
    }
    const kg = Math.round(unitToKg(number, unit) * 1000) / 1000
    const previous = existing ? existing.kg : null
    try {
      const saved = addBodyWeight(day, kg)
      const label = `${fmtNum(number, 1)} ${weightUnitLabel(unit)}${day !== today ? ` · ${dayLabel(day, today)}` : ''}`
      toast(previous !== null ? `Updated to ${label}` : `Logged ${label}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            if (previous !== null) addBodyWeight(day, previous)
            else if (saved?.id) deleteBodyWeight(saved.id)
          },
        },
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Couldn’t save that weight.')
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log weight"
      size="sm"
      footer={<Button className="btn-grow" onClick={save} disabled={!valid}>{existing ? 'Update' : 'Save'}</Button>}
    >
      <form className="food-ws" onSubmit={(event) => { event.preventDefault(); save() }}>
        <div className="food-ws-number">
          <button type="button" className="food-ws-step" onClick={() => step(-0.1)} aria-label={`Minus 0.1 ${weightUnitLabel(unit)}`}>
            <Icon name="minus" size={22} strokeWidth={2.4} />
          </button>
          <label htmlFor={inputId} className="food-ws-field">
            <span className="sr-only">Weight in {weightUnitLabel(unit)}</span>
            <input
              id={inputId}
              className="food-ws-input"
              inputMode="decimal"
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                setError('')
              }}
              onFocus={(event) => event.target.select?.()}
              placeholder="0.0"
              autoComplete="off"
              enterKeyHint="done"
              data-autofocus
            />
            <span className="food-ws-unit">{weightUnitLabel(unit)}</span>
          </label>
          <button type="button" className="food-ws-step" onClick={() => step(0.1)} aria-label={`Plus 0.1 ${weightUnitLabel(unit)}`}>
            <Icon name="plus" size={22} strokeWidth={2.4} />
          </button>
        </div>
        <label className="food-ws-date" htmlFor={dateId}>
          <span>Date</span>
          <input id={dateId} type="date" className="input" value={day} max={today} onChange={(event) => isISODate(event.target.value) && setDay(event.target.value)} />
        </label>
        {existing && <p className="food-ws-hint">Replaces the {fmtNum(kgToUnit(existing.kg, unit), 1)} {weightUnitLabel(unit)} logged {day === today ? 'today' : `for ${dayLabel(day, today)}`}.</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  )
}

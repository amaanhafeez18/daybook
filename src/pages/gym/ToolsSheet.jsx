import { useEffect, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Segmented, Switch } from '../../components/ui/primitives.jsx'
import { useGym } from '../../lib/gym/state.js'
import { barFor, e1rm, loadStep, plateBreakdown, projectedWeight, roundDown } from '../../lib/gym/stats.js'
import { LB, formatNumber, formatWeight, fromKg, toKg } from '../../lib/gym/units.js'
import { NumberInput, WeightInput } from './common.jsx'
import './exercises.css'

// Plate calculator, e1RM and percentage calculators. ToolsSheet has all three as tabs;
// PlateCalculatorSheet is the plate calculator on its own (from a barbell set's menu).

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const DEFAULT_PAIRS = 2
const TABS = [
  { id: 'plates', label: 'Plates' },
  { id: '1rm', label: '1RM' },
  { id: 'percent', label: 'Percent' },
]
const BARS = [
  { id: 'olympic', label: 'Olympic' },
  { id: 'womens', label: 'Women’s' },
  { id: 'ez', label: 'EZ curl' },
  { id: 'trap', label: 'Trap' },
  { id: 'smith', label: 'Smith machine' },
  { id: 'landmine', label: 'Landmine' },
]
const FORMULA_NAMES = { brzycki: 'Brzycki', epley: 'Epley', lombardi: 'Lombardi', oconner: 'O’Conner', wathan: 'Wathan' }

// IWF colours by the nearest kg size; lb plates take the colour of their nearest kg plate.
const PLATE_LOOK = [
  { kg: 25, tone: 'red', height: 88, thick: 16 },
  { kg: 20, tone: 'blue', height: 88, thick: 14.5 },
  { kg: 15, tone: 'yellow', height: 82, thick: 12.5 },
  { kg: 10, tone: 'green', height: 74, thick: 11 },
  { kg: 5, tone: 'white', height: 56, thick: 9 },
  { kg: 2.5, tone: 'grey', height: 44, thick: 7.5 },
  { kg: 1.25, tone: 'grey', height: 36, thick: 6 },
  { kg: 0.5, tone: 'grey', height: 30, thick: 5 },
]
function plateLook(size, unit) {
  const kg = toKg(size, unit)
  return PLATE_LOOK.reduce((best, look) => (Math.abs(look.kg - kg) < Math.abs(best.kg - kg) ? look : best), PLATE_LOOK[0])
}

const sizeText = (size) => formatNumber(size, 2)
const estimate = (kg, unit) => `${formatNumber(fromKg(kg, unit), 1)} ${unit}`

export default function ToolsSheet({ open, onClose, initialTab = 'plates', initialKg, exercise }) {
  return <Tools open={open} onClose={onClose} initialTab={initialTab} initialKg={initialKg} exercise={exercise} />
}

export function PlateCalculatorSheet({ open, onClose, initialKg, exercise }) {
  return <Tools open={open} onClose={onClose} initialTab="plates" initialKg={initialKg} exercise={exercise} platesOnly />
}

function Tools({ open, onClose, initialTab, initialKg, exercise, platesOnly = false }) {
  const gym = useGym()
  const prefs = gym.prefs
  const unit = prefs.unit
  const [tab, setTab] = useState('plates')
  const [plateKg, setPlateKg] = useState(null)
  const [barId, setBarId] = useState('olympic')
  const [collars, setCollars] = useState(false)
  const [rmKg, setRmKg] = useState(null)
  const [rmReps, setRmReps] = useState(null)
  const [baseKg, setBaseKg] = useState(null)
  const [pct, setPct] = useState(80)

  useEffect(() => {
    if (!open) return
    const start = isNum(initialKg) && initialKg > 0 ? initialKg : null
    setTab(platesOnly ? 'plates' : TABS.some((item) => item.id === initialTab) ? initialTab : 'plates')
    setPlateKg(start)
    setBarId(barFor(exercise, prefs).id)
    setCollars(prefs.collarKg > 0)
    setRmKg(start)
    setRmReps(null)
    setBaseKg(start)
    setPct(80)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = platesOnly ? 'Plate calculator' : 'Calculators'
  const description = exercise?.name || undefined

  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} size="md" initialFocus={false}>
      <div className={`gym-tools${platesOnly ? ' is-single' : ''}`}>
        {!platesOnly && <Segmented options={TABS} value={tab} onChange={setTab} label="Calculator" className="gym-tools-tabs" />}
        {tab === 'plates' && (
          <PlatesTab
            prefs={prefs}
            unit={unit}
            targetKg={plateKg}
            onTarget={setPlateKg}
            barId={barId}
            onBar={setBarId}
            collars={collars}
            onCollars={setCollars}
          />
        )}
        {tab === '1rm' && (
          <OneRepMaxTab
            prefs={prefs}
            unit={unit}
            weightKg={rmKg}
            onWeight={setRmKg}
            reps={rmReps}
            onReps={setRmReps}
            onUseAsBase={(kg) => {
              setBaseKg(kg)
              setTab('percent')
            }}
          />
        )}
        {tab === 'percent' && (
          <PercentTab
            unit={unit}
            exercise={exercise}
            baseKg={baseKg}
            onBase={setBaseKg}
            pct={pct}
            onPct={setPct}
            onPlates={(kg) => {
              setPlateKg(kg)
              setTab('plates')
            }}
          />
        )}
      </div>
    </Sheet>
  )
}

// ---- plates ---------------------------------------------------------------------------------

function PlatesTab({ prefs, unit, targetKg, onTarget, barId, onBar, collars, onCollars }) {
  const bars = useMemo(() => BARS.map((bar) => ({ ...bar, ...barFor({ bar: bar.id }, prefs), label: bar.label })), [prefs])
  const bar = bars.find((item) => item.id === barId) || bars[0]
  const plates = prefs.plates?.[unit]
  const collarKg = collars ? (prefs.collarKg > 0 ? prefs.collarKg : unit === 'lb' ? 5 * LB : 2.5) : 0
  const smallest = Array.isArray(plates) && plates.length ? Math.min(...plates) : unit === 'lb' ? 2.5 : 1.25
  const stepUnits = smallest * bar.sleeves
  const storedPairs = prefs.plates?.pairs
  // Limited plates: a size with no count yet (say, after switching units) counts as 2 pairs, the
  // same as Gym settings shows it.
  const pairs = useMemo(() => {
    if (!storedPairs || typeof storedPairs !== 'object') return null
    const out = { ...storedPairs }
    for (const size of Array.isArray(plates) ? plates : []) if (out[String(size)] === undefined) out[String(size)] = DEFAULT_PAIRS
    return out
  }, [storedPairs, plates])

  const result = useMemo(
    () => (isNum(targetKg) ? plateBreakdown(targetKg, { unit, barKg: bar.barKg, collarKg, plates, pairs, sleeves: bar.sleeves }) : null),
    [targetKg, unit, bar.barKg, bar.sleeves, collarKg, plates, pairs],
  )

  const bump = (direction) => {
    const current = isNum(targetKg) ? fromKg(targetKg, unit) : fromKg(bar.barKg, unit)
    const next = Math.max(0, Math.round(current / stepUnits) * stepUnits + direction * stepUnits)
    onTarget(toKg(Number(next.toFixed(4)), unit))
  }

  const sideWord = bar.sleeves === 1 ? 'On the sleeve' : 'Each side'
  const shown = result ? (result.exact ? result.perSide : (result.below || result.above)?.perSide || []) : []

  return (
    <div className="gym-tools-pane">
      <div className="gym-tools-target">
        <button type="button" className="gym-tools-step" onClick={() => bump(-1)} aria-label={`Minus ${sizeText(stepUnits)} ${unit}`}>
          <Icon name="minus" size={20} />
        </button>
        <div className="gym-tools-target-field">
          <WeightInput valueKg={targetKg} unit={unit} onChange={onTarget} placeholder="Weight" ariaLabel={`Target weight in ${unit}`} className="gym-tools-big" />
          <span className="gym-tools-unit" aria-hidden="true">{unit}</span>
        </div>
        <button type="button" className="gym-tools-step" onClick={() => bump(1)} aria-label={`Plus ${sizeText(stepUnits)} ${unit}`}>
          <Icon name="plus" size={20} />
        </button>
      </div>

      <div className="gym-tools-options">
        <label className="gym-tools-bar">
          <span className="gym-tools-label">Bar</span>
          <select className="input" value={bar.id} onChange={(event) => onBar(event.target.value)}>
            {bars.map((item) => (
              <option key={item.id} value={item.id}>{item.label} · {item.barKg > 0 ? formatWeight(item.barKg, unit) : 'no bar weight'}</option>
            ))}
          </select>
        </label>
        <div className="gym-tools-collars">
          <Switch
            label="Collars"
            description={`${formatWeight(prefs.collarKg > 0 ? prefs.collarKg : unit === 'lb' ? 5 * LB : 2.5, unit)} each`}
            checked={collars}
            onChange={onCollars}
          />
        </div>
      </div>

      <div className="gym-tools-result" aria-live="polite">
        {!result ? (
          <p className="gym-tools-hint">Enter the total weight you want to lift, bar included.</p>
        ) : result.belowBar ? (
          <p className="gym-tools-hint">That’s less than the empty bar{collarKg ? ' with collars' : ''} ({formatWeight(bar.barKg + collarKg * bar.sleeves, unit)}).</p>
        ) : (
          <>
            {result.exact ? (
              <div className="gym-tools-answer">
                <span className="gym-tools-label">{sideWord}</span>
                <strong className="gym-tools-plates">{result.perSide.length ? result.perSide.map(sizeText).join(' · ') : 'Just the bar'}</strong>
              </div>
            ) : (
              <div className="gym-tools-miss">
                <p className="gym-tools-hint">Your plates can’t make {formatWeight(targetKg, unit)} exactly.</p>
                {[['Closest below', result.below], ['Closest above', result.above]].map(([label, option]) => option && (
                  <div key={label} className="gym-tools-option">
                    <div>
                      <span className="gym-tools-label">{label}</span>
                      <strong>{formatWeight(option.totalKg, unit)}</strong>
                      <span className="gym-tools-option-plates">
                        {sideWord}: {option.perSide.length ? option.perSide.map(sizeText).join(' · ') : 'just the bar'}
                      </span>
                    </div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onTarget(option.totalKg)}>Use</button>
                  </div>
                ))}
              </div>
            )}
            <BarDiagram plates={shown} unit={unit} sleeves={bar.sleeves} />
            {shown.length > 0 && <PlateChips plates={shown} unit={unit} />}
          </>
        )}
      </div>
    </div>
  )
}

function PlateChips({ plates, unit }) {
  const groups = []
  for (const size of plates) {
    const last = groups[groups.length - 1]
    if (last && last.size === size) last.count += 1
    else groups.push({ size, count: 1 })
  }
  return (
    <ul className="gym-plate-chips" aria-label="Plates per side">
      {groups.map((group) => (
        <li key={group.size}>
          <span className={`gym-plate-swatch is-${plateLook(group.size, unit).tone}`} aria-hidden="true" />
          {sizeText(group.size)} {unit}
          {group.count > 1 && <span className="gym-plate-times">×{group.count}</span>}
        </li>
      ))}
    </ul>
  )
}

// A loaded bar drawn to scale-ish: heaviest plates against the collar, lighter ones outside.
function BarDiagram({ plates, unit, sleeves }) {
  const W = 320
  const H = 100
  const mid = H / 2
  const sleeve = 86
  const looks = plates.map((size) => plateLook(size, unit))
  const total = looks.reduce((sum, look) => sum + look.thick + 1, 0)
  const scale = total > sleeve - 4 ? (sleeve - 4) / total : 1
  const single = sleeves === 1
  const stopL = single ? null : 104
  const stopR = single ? 214 : 216

  const stack = (fromX, direction) => {
    let x = fromX
    return looks.map((look, i) => {
      const thick = look.thick * scale
      const rectX = direction > 0 ? x : x - thick
      x += direction * (thick + scale)
      return (
        <rect
          key={i}
          className={`gym-plate is-${look.tone}`}
          x={rectX}
          y={mid - look.height / 2}
          width={thick}
          height={look.height}
          rx={Math.min(2.5, thick / 2)}
        />
      )
    })
  }

  const label = plates.length
    ? `${single ? 'Sleeve' : 'Each side'} holds ${plates.map((size) => `${sizeText(size)} ${unit}`).join(', ')}`
    : 'Empty bar'

  return (
    <svg className="gym-plate-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {single ? (
        <rect className="gym-bar-metal" x={14} y={mid - 3} width={stopR - 14} height={6} rx={3} />
      ) : (
        <>
          <rect className="gym-bar-metal" x={stopL + 8} y={mid - 3} width={stopR - stopL - 8} height={6} rx={3} />
          <rect className="gym-bar-metal" x={stopL - sleeve - 2} y={mid - 6} width={sleeve + 2} height={12} rx={2} />
          <rect className="gym-bar-stop" x={stopL} y={mid - 11} width={8} height={22} rx={2} />
          {stack(stopL, -1)}
        </>
      )}
      <rect className="gym-bar-metal" x={stopR + 8} y={mid - 6} width={sleeve + 2} height={12} rx={2} />
      <rect className="gym-bar-stop" x={stopR} y={mid - 11} width={8} height={22} rx={2} />
      {stack(stopR + 8, 1)}
    </svg>
  )
}

// ---- 1RM ------------------------------------------------------------------------------------

function OneRepMaxTab({ prefs, unit, weightKg, onWeight, reps, onReps, onUseAsBase }) {
  const oneRm = isNum(weightKg) && isNum(reps) ? e1rm(weightKg, reps, prefs.e1rmFormula) : null
  const tooMany = isNum(reps) && reps > 12
  const rows = oneRm ? Array.from({ length: 12 }, (_, i) => ({ reps: i + 1, kg: projectedWeight(oneRm, i + 1) })) : []

  return (
    <div className="gym-tools-pane">
      <div className="gym-tools-pair">
        <label className="gym-tools-cell">
          <span className="gym-tools-label">Weight ({unit})</span>
          <WeightInput valueKg={weightKg} unit={unit} onChange={onWeight} placeholder="0" ariaLabel={`Weight in ${unit}`} enterKeyHint="next" />
        </label>
        <span className="gym-tools-times" aria-hidden="true">×</span>
        <label className="gym-tools-cell">
          <span className="gym-tools-label">Reps</span>
          <NumberInput value={reps} onChange={onReps} placeholder="0" ariaLabel="Reps" min={1} max={100} />
        </label>
      </div>

      {tooMany ? (
        <p className="gym-tools-hint">Estimates are only reliable up to 12 reps. Try a heavier set.</p>
      ) : !oneRm ? (
        <p className="gym-tools-hint">Enter a set you did, like 80 {unit} × 5, to estimate your one-rep max.</p>
      ) : (
        <>
          <div className="gym-tools-hero">
            <span className="gym-tools-label">Estimated 1RM</span>
            <strong>{estimate(oneRm, unit)}</strong>
            <span className="gym-tools-sub">{FORMULA_NAMES[prefs.e1rmFormula] || 'Brzycki'} formula</span>
          </div>
          <table className="gym-tools-table">
            <caption className="sr-only">Estimated weight for 1 to 12 reps</caption>
            <thead><tr><th scope="col">Reps</th><th scope="col" className="is-num">Weight</th><th scope="col" className="is-num">% of 1RM</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.reps}>
                  <td>{row.reps}</td>
                  <td className="is-num">{estimate(row.kg, unit)}</td>
                  <td className="is-num gym-tools-muted">{Math.round((row.kg / oneRm) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-secondary btn-block" onClick={() => onUseAsBase(oneRm)}>
            Work out percentages of {estimate(oneRm, unit)}
            <Icon name="arrowRight" size={16} />
          </button>
        </>
      )}
    </div>
  )
}

// ---- percent --------------------------------------------------------------------------------

const PCT_ROWS = Array.from({ length: 11 }, (_, i) => 50 + i * 5)

function PercentTab({ unit, exercise, baseKg, onBase, pct, onPct, onPlates }) {
  const stepKg = loadStep(exercise || { equipment: 'barbell' }, unit)
  const exactKg = isNum(baseKg) && isNum(pct) ? (baseKg * pct) / 100 : null
  const loadKg = exactKg !== null ? roundDown(exactKg, stepKg) : null
  const barbell = !exercise || exercise.equipment === 'barbell' || exercise.equipment === 'smith_machine'
  const clampPct = (value) => Math.min(100, Math.max(1, value))

  return (
    <div className="gym-tools-pane">
      <label className="gym-tools-cell">
        <span className="gym-tools-label">Base weight ({unit}): your 1RM or a working weight</span>
        <WeightInput valueKg={baseKg} unit={unit} onChange={onBase} placeholder="0" ariaLabel={`Base weight in ${unit}`} />
      </label>

      <div className="gym-tools-cell">
        <span className="gym-tools-label" id="gym-tools-pct-label">Percentage</span>
        <div className="gym-tools-slider">
          <input
            type="range"
            min={40}
            max={100}
            step={1}
            value={Math.min(100, Math.max(40, isNum(pct) ? pct : 80))}
            onChange={(event) => onPct(Number(event.target.value))}
            aria-labelledby="gym-tools-pct-label"
          />
          <div className="gym-tools-pct">
            <NumberInput value={pct} onChange={(value) => onPct(isNum(value) ? clampPct(value) : value)} ariaLabel="Percentage" min={1} max={100} decimal />
            <span aria-hidden="true">%</span>
          </div>
        </div>
      </div>

      {loadKg === null ? (
        <p className="gym-tools-hint">Enter a base weight to see the load for each percentage.</p>
      ) : (
        <>
          <div className="gym-tools-hero">
            <span className="gym-tools-label">{formatNumber(pct, 1)}% of {formatWeight(baseKg, unit)}</span>
            <strong>{formatWeight(loadKg, unit)}</strong>
            <span className="gym-tools-sub">
              Rounded down to the nearest {formatWeight(stepKg, unit)}
              {Math.abs(exactKg - loadKg) > 1e-6 ? ` (exact ${formatWeight(exactKg, unit)})` : ''}
            </span>
            {barbell && loadKg > 0 && (
              <button type="button" className="link-btn gym-tools-link" onClick={() => onPlates(loadKg)}>
                Plates for {formatWeight(loadKg, unit)}
              </button>
            )}
          </div>
          <table className="gym-tools-table">
            <caption className="sr-only">Load for 50 to 100 percent</caption>
            <thead><tr><th scope="col">Percent</th><th scope="col" className="is-num">Load</th></tr></thead>
            <tbody>
              {PCT_ROWS.map((row) => (
                <tr key={row} className={row === pct ? 'is-current' : ''}>
                  <td>
                    <button type="button" className="gym-tools-row-btn" onClick={() => onPct(row)} aria-pressed={row === pct}>{row}%</button>
                  </td>
                  <td className="is-num">{formatWeight(roundDown((baseKg * row) / 100, stepKg), unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

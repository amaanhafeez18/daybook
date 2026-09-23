import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { IconButton, Segmented, Switch } from '../../components/ui/primitives.jsx'
import { confirmAction, toast } from '../../components/ui/feedback.jsx'
import { todayISO } from '../../lib/dates.js'
import { emptySchedule, setDeloadEvery } from '../../lib/gym/schedule.js'
import { sessionsToCsv } from '../../lib/gym/stats.js'
import { DEFAULT_PREFS, getGym, updateGym, useGym, useGymSessions } from '../../lib/gym/state.js'
import { LB, formatNumber } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { getState, updateSettings, useStore } from '../../lib/store.js'
import { DurationInput, NumberInput, WeightInput } from './common.jsx'
import './gym.css'

const FORMULAS = [
  { id: 'brzycki', label: 'Brzycki (default)' },
  { id: 'epley', label: 'Epley' },
  { id: 'lombardi', label: 'Lombardi' },
  { id: 'oconner', label: 'O’Conner' },
  { id: 'wathan', label: 'Wathan' },
]
const WEEKDAYS = [{ id: 1, label: 'Monday' }, { id: 0, label: 'Sunday' }, { id: 6, label: 'Saturday' }]
const DELOAD_OPTIONS = [0, 3, 4, 5, 6, 8, 10, 12]
const PLATE_OPTIONS = { kg: [50, 25, 20, 15, 10, 5, 2.5, 2, 1.25, 1, 0.5, 0.25], lb: [100, 55, 45, 35, 25, 15, 10, 5, 2.5, 1.25] }
const BARS = [
  { id: 'olympic', label: 'Olympic bar' },
  { id: 'womens', label: 'Women’s bar' },
  { id: 'ez', label: 'EZ bar' },
  { id: 'trap', label: 'Trap bar' },
  { id: 'smith', label: 'Smith machine' },
  { id: 'landmine', label: 'Landmine', hint: 'One loaded end' },
]
// Standard bars; an untouched kg default reads as the lb standard for lb users (like the plate maths).
const KG_BARS = { olympic: 20, womens: 15, ez: 10, trap: 25, smith: 15, landmine: 0 }
const LB_BARS = { olympic: 45, womens: 35, ez: 25, trap: 55, smith: 35, landmine: 0 }
const DEFAULT_REMINDER_TIME = '17:00'

const DEFAULT_PAIRS = 2 // a plate size with no count yet counts as 2 pairs (as the plate calculator does)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const sameNumber = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9

function setPrefs(patch) {
  updateGym((gym) => ({ prefs: { ...gym.prefs, ...(typeof patch === 'function' ? patch(gym.prefs) : patch) } }))
}

// Limited-plate counts, with every size in `sizes` that has no count yet set to DEFAULT_PAIRS.
function seedPairs(pairs, sizes) {
  const out = { ...(pairs || {}) }
  for (const size of sizes) if (out[String(size)] === undefined) out[String(size)] = DEFAULT_PAIRS
  return out
}

// Switching units while Limited plates is on gives the new unit's sizes a count straight away, so
// the calculator and this sheet agree (both treat a missing count as 2 pairs).
function setUnit(unit) {
  setPrefs((p) => ({ unit, ...(p.plates.pairs ? { plates: { ...p.plates, pairs: seedPairs(p.plates.pairs, p.plates[unit]) } } : {}) }))
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const prefersShare = () => isIOS() || window.matchMedia?.('(pointer: coarse)').matches

function Group({ title, footer, children }) {
  return (
    <section className="gym-cfg-group">
      {title && <h3 className="gym-cfg-title">{title}</h3>}
      <div className="gym-cfg-card">{children}</div>
      {footer && <p className="gym-cfg-foot">{footer}</p>}
    </section>
  )
}

function Row({ label, hint, htmlFor, children, className = '' }) {
  return (
    <div className={`gym-cfg-row ${className}`}>
      <span className="gym-cfg-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <small>{hint}</small>}
      </span>
      <span className="gym-cfg-control">{children}</span>
    </div>
  )
}

function SwitchRow(props) {
  return <div className="gym-cfg-row is-switch"><Switch {...props} /></div>
}

function Stepper({ label, value, min, max, onChange, format = String }) {
  return (
    <span className="gym-td-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Icon name="minus" size={16} strokeWidth={2.4} />
      </button>
      <output className="gym-td-stepper-value" aria-live="polite">{format(value)}</output>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Icon name="plus" size={16} strokeWidth={2.4} />
      </button>
    </span>
  )
}

export default function GymSettingsSheet({ open, onClose }) {
  const gym = useGym()
  const sessions = useGymSessions()
  const notifications = useStore((state) => state.data.settings?.notifications)
  const { prefs } = gym
  const { unit } = prefs
  const deloadEvery = gym.schedule.deload?.everyWeeks || 0
  const reminderOn = notifications?.gym === true
  const reminderTime = typeof notifications?.gymTime === 'string' && /^\d{2}:\d{2}$/.test(notifications.gymTime) ? notifications.gymTime : DEFAULT_REMINDER_TIME

  function setReminder(patch) {
    const current = getState().data.settings?.notifications
    updateSettings({ notifications: { ...(current && typeof current === 'object' ? current : {}), gym: reminderOn, gymTime: reminderTime, ...patch } })
  }

  function setDeload(weeks) {
    try {
      updateGym((current) => ({ schedule: setDeloadEvery(current.schedule, weeks, todayISO()) }))
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  // ---- warm-up scheme ----
  const scheme = prefs.warmupScheme.length ? prefs.warmupScheme : DEFAULT_PREFS.warmupScheme
  const setScheme = (next) => setPrefs({ warmupScheme: next.map((row) => ({ ...row })) })
  const editWarmup = (index, patch) => setScheme(scheme.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  function addWarmup() {
    const last = scheme[scheme.length - 1]
    const pct = last ? Math.min(1, Math.round(((last.bar ? 0.4 : last.pct) + 0.1) * 100) / 100) : 0.5
    setScheme([...scheme, { pct, reps: Math.max(1, (last?.reps ?? 3) - 1) }])
  }

  // ---- plates ----
  function togglePlate(plateUnit, size) {
    const current = prefs.plates[plateUnit]
    if (current.includes(size)) {
      if (current.length <= 1) {
        toast('Keep at least one plate size.')
        return
      }
      setPrefs((p) => ({ plates: { ...p.plates, [plateUnit]: p.plates[plateUnit].filter((item) => item !== size) } }))
    } else {
      setPrefs((p) => ({
        plates: {
          ...p.plates,
          [plateUnit]: [...p.plates[plateUnit], size].sort((a, b) => b - a),
          ...(p.plates.pairs && plateUnit === p.unit ? { pairs: seedPairs(p.plates.pairs, [size]) } : {}),
        },
      }))
    }
  }
  const limited = prefs.plates.pairs !== null
  function setLimited(on) {
    setPrefs((p) => ({ plates: { ...p.plates, pairs: on ? seedPairs(p.plates.pairs, p.plates[p.unit]) : null } }))
  }
  const setPairs = (size, pairs) => setPrefs((p) => ({ plates: { ...p.plates, pairs: { ...(p.plates.pairs || {}), [String(size)]: pairs } } }))
  const pairsOf = (size) => {
    const count = prefs.plates.pairs?.[String(size)]
    return Number.isInteger(count) && count >= 0 ? count : DEFAULT_PAIRS
  }

  // ---- bars ----
  const shownBarKg = (id) => {
    const stored = prefs.bars[id]
    return unit === 'lb' && sameNumber(stored, KG_BARS[id]) ? LB_BARS[id] * LB : stored
  }

  // ---- data ----
  async function exportCsv() {
    if (!sessions.length) return
    const csv = sessionsToCsv(sessions, unit, gym.routines)
    const filename = `daybook-workouts-${todayISO()}.csv`
    if (prefersShare() && typeof File === 'function' && navigator.share) {
      try {
        const file = new File([csv], filename, { type: 'text/csv' })
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Daybook workouts' })
          return
        }
      } catch (error) {
        if (error?.name === 'AbortError') return
        // otherwise fall back to a download
      }
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    toast(`Exported ${sessions.length} workout${sessions.length === 1 ? '' : 's'}`, { tone: 'success' })
  }

  async function startOver() {
    const ok = await confirmAction({
      title: 'Start over?',
      message: 'This deletes your schedule, routines and folders. Your workout history, custom exercises and body weights are kept.',
      confirmLabel: 'Start over',
    })
    if (!ok) return
    const before = getGym()
    if (!before.routines.length && !before.schedule.versions.length && !before.folders.length) {
      onClose()
      return
    }
    updateGym({ schedule: emptySchedule(), routines: [], folders: [] })
    onClose()
    navigate('gym')
    toast('Plan cleared. Pick a new one whenever you’re ready.')
  }

  const weekdayOptions = WEEKDAYS.some((day) => day.id === prefs.firstWeekday) ? WEEKDAYS : [...WEEKDAYS, { id: prefs.firstWeekday, label: 'Custom' }]
  const deloadOptions = DELOAD_OPTIONS.includes(deloadEvery) ? DELOAD_OPTIONS : [...DELOAD_OPTIONS, deloadEvery].sort((a, b) => a - b)
  const minWarmLabel = (row) => {
    if (!(row.minKg > 0) && !(row.minLb > 0)) return null
    if (unit === 'lb') return `${row.minLb > 0 ? row.minLb : row.minKg === 100 ? 225 : formatNumber(row.minKg / LB, 0)} lb or more`
    return `${formatNumber(row.minKg > 0 ? row.minKg : row.minLb * LB, 1)} kg or more`
  }

  return (
    <Sheet open={open} onClose={onClose} title="Gym settings" size="md" initialFocus={false}>
      <div className="gym-cfg">
        <Group title="Units">
          <Row label="Weight">
            <Segmented label="Weight unit" value={unit} onChange={setUnit} options={[{ id: 'kg', label: 'kg' }, { id: 'lb', label: 'lb' }]} size="sm" />
          </Row>
          <Row label="Distance">
            <Segmented label="Distance unit" value={prefs.distanceUnit} onChange={(value) => setPrefs({ distanceUnit: value })} options={[{ id: 'km', label: 'km' }, { id: 'mi', label: 'mi' }]} size="sm" />
          </Row>
        </Group>

        <Group title="Week" footer="Used for the calendar, weekly goal, streaks and deload weeks.">
          <Row label="Week starts on" className="is-stacked">
            <Segmented label="First day of the week" value={prefs.firstWeekday} onChange={(value) => setPrefs({ firstWeekday: value })} options={weekdayOptions} size="sm" />
          </Row>
          <Row label="Weekly goal" hint="Workouts per week">
            <Stepper label="Weekly goal" value={prefs.weeklyGoal} min={1} max={14} onChange={(weeklyGoal) => setPrefs({ weeklyGoal })} />
          </Row>
        </Group>

        <Group title="Workout">
          <Row label="Default rest" hint="For new custom exercises" htmlFor="gym-cfg-rest">
            <DurationInput id="gym-cfg-rest" valueSec={prefs.defaultRest} placeholder="2:00" ariaLabel="Default rest (m:ss)" onChange={(sec) => sec !== null && setPrefs({ defaultRest: clamp(sec, 0, 600) })} />
          </Row>
          <Row label="Warm-up rest" hint="After a W set" htmlFor="gym-cfg-warm-rest">
            <DurationInput id="gym-cfg-warm-rest" valueSec={prefs.warmupRest} placeholder="0:45" ariaLabel="Warm-up rest (m:ss)" onChange={(sec) => sec !== null && setPrefs({ warmupRest: clamp(sec, 0, 600) })} />
          </Row>
          <Row label="Previous values" className="is-stacked">
            <Segmented label="Previous values come from" value={prefs.previousSource} onChange={(value) => setPrefs({ previousSource: value })} options={[{ id: 'any', label: 'Any workout' }, { id: 'routine', label: 'Same routine' }]} size="sm" />
          </Row>
          <SwitchRow label="Progression suggestions" description="Suggest the next weight and reps from last time" checked={prefs.progression} onChange={(progression) => setPrefs({ progression })} />
          <SwitchRow label="RPE column" description="Rate effort 6–10 on each set" checked={prefs.showRpe} onChange={(showRpe) => setPrefs({ showRpe })} />
          <SwitchRow label="Timer sound" description="Beep when rest is over" checked={prefs.timerSound} onChange={(timerSound) => setPrefs({ timerSound })} />
          <SwitchRow label="Keep screen awake" description="While a workout is running" checked={prefs.keepAwake} onChange={(keepAwake) => setPrefs({ keepAwake })} />
        </Group>

        <Group title="Stats & records">
          <Row label="e1RM formula" htmlFor="gym-cfg-formula">
            <select id="gym-cfg-formula" className="input gym-cfg-select" value={prefs.e1rmFormula} onChange={(event) => setPrefs({ e1rmFormula: event.target.value })}>
              {FORMULAS.map((formula) => <option key={formula.id} value={formula.id}>{formula.label}</option>)}
            </select>
          </Row>
          <SwitchRow label="Count reps in reserve" description="Use RPE to estimate e1RM (off by default)" checked={prefs.useRir} onChange={(useRir) => setPrefs({ useRir })} />
          <SwitchRow label="Bodyweight in volume" description="Pull-ups, dips and similar count your body weight" checked={prefs.bodyweightInVolume} onChange={(bodyweightInVolume) => setPrefs({ bodyweightInVolume })} />
        </Group>

        <Group title="Deload" footer="A deload week halves your sets and takes about 10% off the weights. For a one-off, use ⋯ on the Today tab.">
          <Row label="Deload every" htmlFor="gym-cfg-deload">
            <select id="gym-cfg-deload" className="input gym-cfg-select" value={deloadEvery} onChange={(event) => setDeload(Number(event.target.value))}>
              {deloadOptions.map((weeks) => <option key={weeks} value={weeks}>{weeks ? `${weeks} weeks` : 'Off'}</option>)}
            </select>
          </Row>
        </Group>

        <Group title="Warm-up sets" footer="Percent of your working weight, lightest first. “Add warm-up sets” in a workout uses these rows.">
          {scheme.map((row, index) => (
            <div className="gym-cfg-row gym-cfg-warm-row" key={index}>
              <span className="gym-cfg-warm-num" aria-hidden="true">W</span>
              {row.bar ? (
                <span className="gym-cfg-warm-bar">Empty bar</span>
              ) : (
                <span className="gym-cfg-warm-field">
                  <NumberInput value={Math.round(row.pct * 100)} min={1} max={150} ariaLabel={`Warm-up ${index + 1} percent of working weight`} onChange={(value) => value !== null && editWarmup(index, { pct: value / 100 })} />
                  <span>%</span>
                </span>
              )}
              <span className="gym-cfg-warm-times" aria-hidden="true">×</span>
              <span className="gym-cfg-warm-field">
                <NumberInput value={row.reps} min={1} max={50} ariaLabel={`Warm-up ${index + 1} reps`} onChange={(value) => value !== null && editWarmup(index, { reps: value })} />
                <span>reps</span>
              </span>
              <IconButton icon="minus" label={`Remove warm-up ${index + 1}`} className="icon-btn-sm gym-cfg-warm-remove" disabled={scheme.length <= 1} onClick={() => setScheme(scheme.filter((_, i) => i !== index))} />
              {minWarmLabel(row) && <small className="gym-cfg-warm-min">Only when the working weight is {minWarmLabel(row)}</small>}
            </div>
          ))}
          <div className="gym-cfg-row gym-cfg-buttons">
            <button type="button" className="link-btn" onClick={addWarmup}><Icon name="plus" size={16} />Add row</button>
            <button type="button" className="link-btn" onClick={() => setScheme(DEFAULT_PREFS.warmupScheme)}>Reset to default</button>
          </div>
        </Group>

        <Group title="Plates & bars" footer="The plate calculator uses what you have. Limited plates finds the closest load you can actually build.">
          {['kg', 'lb'].map((plateUnit) => {
            const options = [...new Set([...PLATE_OPTIONS[plateUnit], ...prefs.plates[plateUnit]])].sort((a, b) => b - a)
            return (
              <div className="gym-cfg-row is-stacked" key={plateUnit}>
                <span className="gym-cfg-label"><span>{plateUnit === 'kg' ? 'Kilogram plates' : 'Pound plates'}</span></span>
                <span className="gym-cfg-plates" role="group" aria-label={plateUnit === 'kg' ? 'Kilogram plates' : 'Pound plates'}>
                  {options.map((size) => {
                    const on = prefs.plates[plateUnit].includes(size)
                    return (
                      <button key={size} type="button" className={`chip chip-sm gym-cfg-plate${on ? ' is-active' : ''}`} aria-pressed={on} onClick={() => togglePlate(plateUnit, size)}>
                        {formatNumber(size, 2)}
                      </button>
                    )
                  })}
                </span>
              </div>
            )
          })}
          <SwitchRow label="Limited plates" description={`Pairs of each ${unit} plate you own`} checked={limited} onChange={setLimited} />
          {limited && prefs.plates[unit].map((size) => (
            <Row key={size} label={`${formatNumber(size, 2)} ${unit}`} className="is-sub">
              <span className="gym-cfg-inline">
                <NumberInput value={pairsOf(size)} min={0} max={20} placeholder={String(DEFAULT_PAIRS)} ariaLabel={`Pairs of ${formatNumber(size, 2)} ${unit} plates`} onChange={(value) => value !== null && setPairs(size, value)} />
                <span>pairs</span>
              </span>
            </Row>
          ))}
          {BARS.map((bar) => (
            <Row key={bar.id} label={bar.label} hint={bar.hint}>
              <span className="gym-cfg-inline">
                <WeightInput valueKg={shownBarKg(bar.id)} unit={unit} ariaLabel={`${bar.label} weight in ${unit}`} onChange={(kg) => kg !== null && setPrefs((p) => ({ bars: { ...p.bars, [bar.id]: clamp(kg, 0, 100) } }))} />
                <span>{unit}</span>
              </span>
            </Row>
          ))}
          <Row label="Collars" hint="Each, 0 if you don’t count them">
            <span className="gym-cfg-inline">
              <WeightInput valueKg={prefs.collarKg} unit={unit} placeholder="0" ariaLabel={`Collar weight in ${unit}`} onChange={(kg) => setPrefs({ collarKg: kg === null ? 0 : clamp(kg, 0, 25) })} />
              <span>{unit}</span>
            </span>
          </Row>
        </Group>

        <Group title="Workout reminder" footer="Arrives on devices with notifications turned on in Settings, on planned workout days you haven’t trained yet.">
          <SwitchRow label="Remind me to train" description="Not on rest, skipped or done days" checked={reminderOn} onChange={(gymOn) => setReminder({ gym: gymOn })} />
          {reminderOn && (
            <Row label="Time" htmlFor="gym-cfg-reminder">
              <input id="gym-cfg-reminder" className="input gym-cfg-time" type="time" value={reminderTime} onChange={(event) => setReminder({ gymTime: event.target.value || DEFAULT_REMINDER_TIME })} />
            </Row>
          )}
        </Group>

        <Group title="Data">
          <button type="button" className="gym-cfg-row gym-cfg-action" onClick={exportCsv} disabled={!sessions.length}>
            <span className="gym-cfg-action-icon"><Icon name="download" size={17} /></span>
            <span className="gym-cfg-label">
              <span>Export workouts (CSV)</span>
              <small>{sessions.length ? `${sessions.length} workout${sessions.length === 1 ? '' : 's'} · one row per set · weights in kg and lb` : 'No workouts to export yet'}</small>
            </span>
          </button>
          <button type="button" className="gym-cfg-row gym-cfg-action is-danger" onClick={startOver}>
            <span className="gym-cfg-action-icon"><Icon name="refresh" size={17} /></span>
            <span className="gym-cfg-label">
              <span>Start over</span>
              <small>Clear routines and schedule. History is kept.</small>
            </span>
          </button>
        </Group>
      </div>
    </Sheet>
  )
}

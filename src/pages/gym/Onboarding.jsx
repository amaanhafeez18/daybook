import { useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Segmented } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { WEEKDAY_SHORT, addDaysISO, weekdayIndex } from '../../lib/dates.js'
import { TEMPLATES, buildTemplate } from '../../lib/gym/library.js'
import { resolveRange } from '../../lib/gym/schedule.js'
import { applyTemplate, getGym, newGymId, routineColor, updateGym, useGym } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import './gym.css'

// First run: pick a split (it creates editable routines plus a schedule starting today) or build
// your own. Shown on the Today tab until a routine or schedule exists.

const TEMPLATE_ICONS = { 'ppl-r': 'repeat', ppl2: 'layers', 'upper-lower': 'shuffle', bro: 'target', 'full-body': 'zap', custom: 'pencil' }

function previewIds() {
  let n = 0
  return () => `preview-${n++}`
}

function slotInfo(slot, routines) {
  if (slot?.kind !== 'routine') return { name: 'Rest', color: null }
  const routine = routines.find((item) => item.id === slot.routineId)
  return { name: routine?.name || 'Workout', color: routine ? routineColor(routine) : null }
}

export default function Onboarding({ today }) {
  const gym = useGym()
  const { unit, firstWeekday } = gym.prefs
  const [selected, setSelected] = useState(null)
  const [anchor, setAnchor] = useState(0)

  const templates = useMemo(() => TEMPLATES.map((template) => {
    if (template.id === 'custom') return { ...template, built: null }
    const built = buildTemplate(template.id, today, previewIds())
    const version = built.schedule.versions[0]
    return { ...template, built, version, rotation: version?.mode === 'rotation' }
  }), [today])

  const chosen = templates.find((template) => template.id === selected) || null

  // The first seven days under the chosen template and "Start today with" choice.
  const firstWeek = useMemo(() => {
    if (!chosen?.built) return []
    const version = { ...chosen.version, anchorIndex: chosen.rotation ? anchor : 0 }
    const plan = { schedule: { ...chosen.built.schedule, versions: [version] }, routines: chosen.built.routines, prefs: { firstWeekday } }
    return resolveRange(plan, [], today, addDaysISO(today, 6), today)
  }, [chosen, anchor, today, firstWeekday])

  function pick(id) {
    setSelected((current) => (current === id ? null : id))
    setAnchor(0)
  }

  function choose(template) {
    if (template.id === 'custom') {
      navigate('gym/routine/new')
      return
    }
    const result = buildTemplate(template.id, today, newGymId)
    const version = result.schedule.versions[0]
    if (version && template.rotation) version.anchorIndex = Math.min(Math.max(0, anchor), version.cycle.length - 1)
    const before = getGym().schedule
    const ids = new Set(result.routines.map((routine) => routine.id))
    try {
      applyTemplate(result)
    } catch (error) {
      toast(error.message, { tone: 'error' })
      return
    }
    toast(`Plan ready: ${template.name}`, {
      action: {
        label: 'Undo',
        onClick: () => updateGym((current) => ({ routines: current.routines.filter((routine) => !ids.has(routine.id)), schedule: before })),
      },
    })
  }

  return (
    <div className="gym-onb">
      <section className="gym-onb-hero">
        <span className="gym-onb-mark" aria-hidden="true"><Icon name="dumbbell" size={30} strokeWidth={2} /></span>
        <h2>Plan your training</h2>
        <p>Pick a split to start with. It creates routines you can edit and a schedule that knows what’s next, even when life gets in the way.</p>
      </section>

      <div className="card gym-onb-unit">
        <span className="gym-onb-unit-label">Weights in</span>
        <Segmented
          label="Weight unit"
          value={unit}
          onChange={(value) => updateGym((current) => ({ prefs: { ...current.prefs, unit: value } }))}
          options={[{ id: 'kg', label: 'Kilograms' }, { id: 'lb', label: 'Pounds' }]}
          className="gym-onb-segmented"
        />
      </div>

      <ul className="gym-onb-tpl-list">
        {templates.map((template) => {
          const open = selected === template.id
          return (
            <li key={template.id} className={`card gym-onb-tpl${open ? ' is-open' : ''}`}>
              <button type="button" className="gym-onb-tpl-head" aria-expanded={open} onClick={() => pick(template.id)}>
                <span className="gym-onb-tpl-icon" aria-hidden="true"><Icon name={TEMPLATE_ICONS[template.id] || 'dumbbell'} size={20} strokeWidth={2} /></span>
                <span className="gym-onb-tpl-text">
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                  {template.built && <TemplatePreview template={template} firstWeekday={firstWeekday} />}
                </span>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={18} className="gym-td-chevron" />
              </button>

              {open && (
                <div className="gym-onb-tpl-body">
                  {template.rotation && (
                    <label className="gym-onb-tpl-field">
                      <span>Start today with</span>
                      <select className="input" value={anchor} onChange={(event) => setAnchor(Number(event.target.value))}>
                        {template.version.cycle.map((slot, index) => (
                          <option key={index} value={index}>Day {index + 1}: {slotInfo(slot, template.built.routines).name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {firstWeek.length > 0 && (
                    <div className="gym-onb-tpl-week">
                      <span className="gym-onb-tpl-week-title">Your first week</span>
                      <ol className="gym-onb-week">
                        {firstWeek.map((day) => {
                          const info = slotInfo(day.shown, template.built.routines)
                          return (
                            <li key={day.date} className={info.color ? 'is-workout' : 'is-rest'} style={info.color ? { '--gym-rc': info.color } : undefined}>
                              <span className="gym-onb-week-day">{day.date === today ? 'Today' : WEEKDAY_SHORT[weekdayIndex(day.date)]}</span>
                              <span className="gym-onb-week-slot">{info.name}</span>
                            </li>
                          )
                        })}
                      </ol>
                    </div>
                  )}
                  {template.built && (
                    <p className="gym-onb-tpl-meta">
                      {template.built.routines.length} routines · {template.built.routines.reduce((sum, routine) => sum + routine.exercises.length, 0)} exercises with starter sets and rep ranges
                    </p>
                  )}
                  <button type="button" className="btn btn-primary btn-block" onClick={() => choose(template)}>
                    {template.id === 'custom' ? 'Create my first routine' : `Use ${template.name}`}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="gym-onb-foot">You can change units, rest times and more in Gym settings (the gear above).</p>
    </div>
  )
}

function TemplatePreview({ template, firstWeekday }) {
  const { version, built } = template
  if (!version) return null
  if (template.rotation) {
    return (
      <span className="gym-onb-tpl-preview" role="img" aria-label={`Rotation: ${version.cycle.map((slot) => slotInfo(slot, built.routines).name).join(', ')}`}>
        {version.cycle.map((slot, index) => {
          const info = slotInfo(slot, built.routines)
          return (
            <span key={index} className={`gym-onb-tpl-pill${info.color ? '' : ' is-rest'}`} style={info.color ? { '--gym-rc': info.color } : undefined} aria-hidden="true">
              {info.name}
            </span>
          )
        })}
        <Icon name="repeat" size={14} className="gym-onb-tpl-repeat" />
      </span>
    )
  }
  const order = Array.from({ length: 7 }, (_, i) => (firstWeekday + i) % 7)
  const legend = built.routines.filter((routine) => version.weekly.some((slot) => slot.kind === 'routine' && slot.routineId === routine.id))
  return (
    <span className="gym-onb-tpl-weekly-wrap">
      <span className="gym-onb-tpl-weekly" aria-label={order.map((weekday) => `${WEEKDAY_SHORT[weekday]} ${slotInfo(version.weekly[weekday], built.routines).name}`).join(', ')} role="img">
        {order.map((weekday) => {
          const info = slotInfo(version.weekly[weekday], built.routines)
          return (
            <span key={weekday} className={`gym-onb-tpl-daycell${info.color ? '' : ' is-rest'}`} style={info.color ? { '--gym-rc': info.color } : undefined} title={`${WEEKDAY_SHORT[weekday]}: ${info.name}`}>
              {WEEKDAY_SHORT[weekday].slice(0, 1)}
            </span>
          )
        })}
      </span>
      <span className="gym-onb-tpl-legend" aria-hidden="true">
        {legend.map((routine) => (
          <span key={routine.id} style={{ '--gym-rc': routineColor(routine) }}>{routine.name}</span>
        ))}
      </span>
    </span>
  )
}

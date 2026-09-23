import { useMemo, useRef } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { WEEKDAY_SHORT, addDaysISO, diffDays, formatDateLong, formatDateShort, weekdayIndex } from '../../lib/dates.js'
import * as sched from '../../lib/gym/schedule.js'
import { routineColor, shiftDay, skipDay, slotLabel, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import './gym.css'

// Skip one day, or shift the whole plan a day from it, each with a live preview of the next three
// days under that change. Used by the Today tab and by the calendar for any date from today on.

function dayName(date, today) {
  const delta = diffDays(today, date)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta > 1 && delta < 7) return WEEKDAY_SHORT[weekdayIndex(date)]
  return formatDateShort(date)
}

function cell(day, gym) {
  const changed = day.override ? 'Changed' : ''
  switch (day.status) {
    case 'done': return { kind: 'done', label: day.sessions[0]?.name?.trim() || 'Workout', caption: 'Done', routine: null }
    case 'skipped': return { kind: 'skipped', label: slotLabel(day.shown, gym), caption: 'Skipped', routine: day.routine }
    case 'shifted': return { kind: 'shifted', label: 'Rest', caption: 'Shifted', routine: null }
    case 'rest': return { kind: 'rest', label: 'Rest', caption: changed, routine: null }
    case 'none': return { kind: 'none', label: 'No plan', caption: '', routine: null }
    default: return { kind: 'planned', label: slotLabel(day.shown, gym), caption: changed, routine: day.routine }
  }
}

function previewText(cells, days, today) {
  return cells.map((item, i) => {
    const suffix = item.kind === 'skipped' ? ' (skipped)' : item.kind === 'done' ? ' (done)' : ''
    return `${dayName(days[i].date, today)}: ${item.kind === 'shifted' ? 'rest' : item.label}${suffix}`
  }).join(' · ')
}

function Preview({ days, base, today, gym }) {
  const cells = days.map((day) => cell(day, gym))
  const before = base.map((day) => cell(day, gym))
  return (
    <>
      <span className="sr-only">{previewText(cells, days, today)}</span>
      <span className="gym-skip-preview" aria-hidden="true">
        {cells.map((item, i) => {
          const was = before[i]
          const changed = !was || was.kind !== item.kind || was.label !== item.label
          return (
            <span key={days[i].date} className={`gym-skip-preview-day is-${item.kind}${changed ? ' is-changed' : ''}`}>
              <span className="gym-skip-preview-when">{dayName(days[i].date, today)}</span>
              <span className="gym-skip-preview-slot">
                {item.routine && <span className="gym-skip-preview-dot" style={{ background: routineColor(item.routine) }} />}
                <span className="gym-skip-preview-label">{item.label}</span>
              </span>
              <span className="gym-skip-preview-caption">{item.caption || '\u00a0'}</span>
            </span>
          )
        })}
      </span>
    </>
  )
}

export default function SkipSheet({ open, onClose, date }) {
  const today = useToday()
  const gym = useGym()
  const sessions = useGymSessions()
  const day = date || today
  const isToday = day === today

  const model = useMemo(() => {
    const end = addDaysISO(day, 2)
    const base = sched.resolveRange(gym, sessions, day, end, today)
    const current = base[0]
    if (!current) return null
    const hasSession = current.sessions.length > 0
    const attempt = (change) => {
      try {
        return { days: sched.resolveRange({ ...gym, schedule: change() }, sessions, day, end, today), error: null }
      } catch (error) {
        return { days: null, error: error.message }
      }
    }
    const skip = attempt(() => sched.skipDay(gym.schedule, day, today, hasSession))
    const shift = attempt(() => sched.shiftDay(gym.schedule, day, today, hasSession))
    const label = slotLabel(current.shown, gym)
    let skipBlocked = skip.error
    if (!skipBlocked) {
      if (current.status === 'none') skipBlocked = 'Nothing is planned on this day.'
      else if (current.status === 'skipped') skipBlocked = 'This day is already skipped.'
      else if (current.shown.kind === 'rest') skipBlocked = 'It’s a rest day, so there’s nothing to skip. You can still shift.'
      else if (current.shown.kind === 'shifted') skipBlocked = 'This day is already shifted.'
    }
    let shiftBlocked = shift.error
    if (!shiftBlocked) {
      if (current.status === 'none') shiftBlocked = 'There’s no plan to shift yet.'
      else if (current.shifted) shiftBlocked = 'Your plan is already shifted from this day.'
    }
    return { base, current, hasSession, label, skip, shift, skipBlocked, shiftBlocked, isRest: current.shown.kind === 'rest' }
  }, [gym, sessions, day, today])

  // Keep showing what was chosen while the sheet slides away (the schedule has changed by then).
  const shown = useRef(model)
  if (open || !shown.current) shown.current = model
  const m = shown.current

  function choose(kind) {
    if (!m) return
    const when = isToday ? 'today' : `on ${dayName(day, today)}`
    try {
      if (kind === 'skip') {
        const undo = skipDay(day)
        onClose()
        toast(isToday ? `Skipped today’s ${m.label}` : `Skipped ${m.label} ${when}`, { action: { label: 'Undo', onClick: undo } })
      } else {
        const undo = shiftDay(day)
        onClose()
        const nextDay = dayName(addDaysISO(day, 1), today).toLowerCase()
        toast(m.isRest ? 'Added a rest day. Your plan moves a day later.' : `${m.label} moves to ${nextDay === 'tomorrow' ? 'tomorrow' : nextDay}`, {
          action: { label: 'Undo', onClick: undo },
        })
      }
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  const title = isToday ? (m?.isRest ? 'Shift your plan' : 'Skip today’s workout?') : `Skip or shift ${formatDateShort(day)}`
  const description = m ? `${isToday ? 'Today' : formatDateLong(day)}: ${m.current.status === 'skipped' ? `${m.label} (skipped)` : m.label}` : undefined

  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} size="sm" initialFocus={false}>
      {!m ? null : m.hasSession ? (
        <p className="gym-td-sheet-note">This day already has a workout logged, so it can’t be skipped or shifted.</p>
      ) : (
        <div className="gym-skip-choices">
          <button type="button" className="gym-skip-choice is-skip" disabled={!!m.skipBlocked} onClick={() => choose('skip')}>
            <span className="gym-skip-choice-head">
              <span className="gym-skip-choice-icon" aria-hidden="true"><Icon name="skipForward" size={20} strokeWidth={2} /></span>
              <span className="gym-skip-choice-text">
                <strong>{isToday ? 'Skip today only' : 'Skip this day only'}</strong>
                <small>Take the day off. Nothing else moves.</small>
              </span>
            </span>
            {m.skipBlocked
              ? <span className="gym-skip-choice-blocked">{m.skipBlocked}</span>
              : <Preview days={m.skip.days} base={m.base} today={today} gym={gym} />}
          </button>

          <button type="button" className="gym-skip-choice is-shift" disabled={!!m.shiftBlocked} onClick={() => choose('shift')}>
            <span className="gym-skip-choice-head">
              <span className="gym-skip-choice-icon" aria-hidden="true"><Icon name="arrowRight" size={20} strokeWidth={2} /></span>
              <span className="gym-skip-choice-text">
                <strong>Shift schedule forward a day</strong>
                <small>
                  {m.isRest
                    ? 'Adds an extra rest day. Everything from here moves one day later.'
                    : `${m.label} moves to ${isToday ? 'tomorrow' : 'the next day'} and everything after slides a day.`}
                </small>
              </span>
            </span>
            {m.shiftBlocked
              ? <span className="gym-skip-choice-blocked">{m.shiftBlocked}</span>
              : <Preview days={m.shift.days} base={m.base} today={today} gym={gym} />}
          </button>
        </div>
      )}
    </Sheet>
  )
}

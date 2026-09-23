import { useMemo } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { formatDateLong, formatDateShort, todayISO } from '../../lib/dates.js'
import * as sched from '../../lib/gym/schedule.js'
import { estimateMinutes } from '../../lib/gym/stats.js'
import { getGym, overrideDay, slotLabel, updateGym, useGym, useGymSessions, useToday } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import { RoutineDot } from './common.jsx'
import './gym.css'

// One-off change of what a day shows (a routine or Rest). Tomorrow and the rest of the plan are
// unaffected. Used by the Today tab and by the calendar for any date from today on.

const REST = Object.freeze({ kind: 'rest' })
const sameSlot = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'routine' || a.routineId === b.routineId)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Removes only the override on `date` (and a moved partner's back-link); a shift or skip on the
// same day stays. Returns an undo that restores the overrides it changed, or null.
function clearOverride(date) {
  const before = getGym().schedule
  if (!before.overrides[date]) return null
  let next = sched.clearDay(before, date, todayISO())
  if (before.shifts.includes(date) && !next.shifts.includes(date)) next = { ...next, shifts: [...next.shifts, date].sort() }
  if (before.skips[date] && !next.skips[date]) next = { ...next, skips: { ...next.skips, [date]: before.skips[date] } }
  const keys = [...new Set([...Object.keys(before.overrides), ...Object.keys(next.overrides)])]
    .filter((key) => JSON.stringify(before.overrides[key]) !== JSON.stringify(next.overrides[key]))
  updateGym({ schedule: next })
  return () => updateGym((gym) => {
    const overrides = { ...gym.schedule.overrides }
    for (const key of keys) {
      if (before.overrides[key] === undefined) delete overrides[key]
      else overrides[key] = before.overrides[key]
    }
    return { schedule: sched.normalizeSchedule({ ...gym.schedule, overrides }) }
  })
}

export default function ChangeWorkoutSheet({ open, onClose, date }) {
  const today = useToday()
  const gym = useGym()
  const sessions = useGymSessions()
  const day = date || today
  const isToday = day === today
  const resolved = useMemo(() => sched.resolveDay(gym, sessions, day, today), [gym, sessions, day, today])
  const { planned, shown, override } = resolved
  const moved = !!(override?.movedFrom || override?.movedTo)
  const when = isToday ? 'Today' : formatDateShort(day)

  function done(message, undo) {
    onClose()
    toast(message, undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
  }

  function backToPlan() {
    try {
      const undo = clearOverride(day)
      done(`${when} is back to ${slotLabel(planned, gym)}`, undo)
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  function choose(slot) {
    if (override && !moved && sameSlot(slot, planned)) {
      backToPlan()
      return
    }
    if (sameSlot(slot, shown)) {
      onClose()
      return
    }
    try {
      const undo = overrideDay(day, slot)
      done(`${when} is now ${slot.kind === 'rest' ? 'a rest day' : slotLabel(slot, gym)}`, undo)
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  const options = [
    ...gym.routines.map((routine) => ({ key: routine.id, slot: { kind: 'routine', routineId: routine.id }, routine })),
    { key: 'rest', slot: REST, routine: null },
  ]

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={isToday ? 'Change today’s workout' : `Change ${formatDateShort(day)}`}
      description={isToday ? 'Just for today. Tomorrow and the rest of your plan stay the same.' : `${formatDateLong(day)} only. The rest of your plan stays the same.`}
      size="sm"
      initialFocus={false}
      footer={override ? (
        <button type="button" className="btn btn-secondary btn-block" onClick={backToPlan}>
          <Icon name="undo" size={18} />
          Back to plan · {slotLabel(planned, gym)}
        </button>
      ) : null}
    >
      <div className="gym-td-pick-list" role="radiogroup" aria-label="Workout for this day">
        {options.map(({ key, slot, routine }) => {
          const current = sameSlot(slot, shown)
          const isPlanned = sameSlot(slot, planned)
          const minutes = routine ? estimateMinutes(routine) : 0
          return (
            <button key={key} type="button" role="radio" aria-checked={current} className={`gym-td-pick-row${current ? ' is-current' : ''}`} onClick={() => choose(slot)}>
              {routine
                ? <RoutineDot routine={routine} size={12} />
                : <span className="gym-td-pick-icon is-rest" aria-hidden="true"><Icon name="moon" size={13} strokeWidth={2.2} /></span>}
              <span className="gym-td-pick-text">
                <strong>{routine ? routine.name?.trim() || 'Untitled routine' : 'Rest'}</strong>
                <small>
                  {routine
                    ? [plural(routine.exercises.length, 'exercise'), minutes ? `~${minutes} min` : null].filter(Boolean).join(' · ')
                    : 'Take the day off'}
                </small>
              </span>
              {isPlanned && override && <span className="gym-td-badge">Planned</span>}
              <span className="gym-td-pick-check" aria-hidden="true">{current && <Icon name="check" size={18} strokeWidth={2.6} />}</span>
            </button>
          )
        })}
      </div>
      {!gym.routines.length && (
        <p className="gym-td-sheet-note">
          No routines yet.{' '}
          <button type="button" className="link-btn" onClick={() => { onClose(); navigate('gym/routine/new') }}>Create a routine</button>
        </p>
      )}
    </Sheet>
  )
}

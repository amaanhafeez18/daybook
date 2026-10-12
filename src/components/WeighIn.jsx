import { Suspense, lazy, useId, useMemo, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button, Skeleton } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { readPref, writePref } from '../lib/api.js'
import { isISODate, relativeDay } from '../lib/dates.js'
import { weighInNudge } from '../lib/food/coach.js'
import { setNudge, useBodyWeights, useFood, useWeightUnit } from '../lib/food/state.js'
import { haptic } from '../lib/haptics.js'
import { primeKeyboard } from '../lib/keyboard.js'
import { navigate } from '../lib/router.js'
import { useAnimatedNumber } from '../lib/useAnimatedNumber.js'
import { weighInSummary } from '../lib/weighIn.js'
import { fmtNum, fmtWeightChange, kgToUnit, weightUnitLabel } from '../pages/food/format.js'
import './weigh-in.css'

// The one weigh-in display (Health Today, Food Today, Gym Today, Gym Stats): the scale icon and
// "Weight", the latest weigh-in as a big number in the user's unit, its date, ONE change figure
// (weightTrend's smoothed weekly change, "−0.3 kg/wk" — lib/weighIn.js) with a 30-day trend
// sparkline, and one "Weigh in" capsule that opens the shared WeightSheet.
// When the last weigh-in was 4–30 days ago (and the reminder is on in Food settings → Nudges) a
// soft strip says so, with × to hide it for the day on this device ("Turn off" in the toast).
//   to        route the number opens (e.g. 'food/weight', 'gym/stats'); none = not a link
//   link      { label, to }: a text link in the header instead of the capsule (Gym's "Stats")
//   capsule   false hides the header capsule (Gym Today has its own inline entry, Stats its form)
//   nudge     false leaves the weigh-in reminder out
//   bare      no card and no header: just the number, for a card that already has a title
//   date      the day the sheet opens on (the viewed day on Food); defaults to today. The reminder
//             always opens it on today.
//   headingLevel  2 where the card sits among h2 sections (Food Today); 3 otherwise
//   children  ({ open }) => extra rows under the number (Gym's inline entry)
const WeightSheet = lazy(() => import('../pages/food/WeightSheet.jsx'))

const NUDGE_PREF = 'food.nudge.weighIn' // the day the weigh-in nudge was hidden (this device)

function Spark({ values }) {
  if (!Array.isArray(values) || values.length < 2) return null
  const width = 88
  const height = 32
  const pad = 3
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const x = (i) => pad + (i / (values.length - 1)) * (width - pad * 2)
  const y = (value) => pad + (1 - (value - min) / span) * (height - pad * 2)
  const d = values.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join('')
  const last = values.length - 1
  return (
    <svg className="wi-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <circle cx={x(last)} cy={y(values[last])} r={3} />
    </svg>
  )
}

export default function WeighIn({
  today, loaded = true, date, to, link, capsule = true, nudge: withNudge = true, bare = false, headingLevel = 3, className = '', children,
}) {
  const bodyWeights = useBodyWeights()
  const unit = useWeightUnit()
  const nudgeOn = useFood().prefs.nudges?.weighIn !== false
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  const [sheetDate, setSheetDate] = useState(null)
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const [hiddenOn, setHiddenOn] = useState(() => readPref(NUDGE_PREF, null))
  const titleId = useId()
  const u = weightUnitLabel(unit)

  const summary = useMemo(() => weighInSummary(bodyWeights, today, unit), [bodyWeights, today, unit])
  const nudge = useMemo(
    () => (withNudge && nudgeOn && hiddenOn !== today ? weighInNudge(bodyWeights, today) : null),
    [withNudge, nudgeOn, hiddenOn, bodyWeights, today],
  )
  const value = summary ? Math.round(kgToUnit(summary.latestKg, unit) * 10) / 10 : null
  const shown = useAnimatedNumber(value)

  // `day` pins the sheet's date (the reminder means today); buttons pass their click event, so
  // only an ISO date counts.
  function openSheet(day) {
    haptic()
    primeKeyboard() // the keyboard rises with the sheet (iPhone)
    setSheetDate(isISODate(day) ? day : null)
    setUsed(true)
    setOpen(true)
  }

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

  // The one change figure: the smoothed weekly trend. Without one yet, a full-width hint under the
  // number says why (so the short date line never wraps next to the sparkline).
  let change = null
  let hint = null
  if (summary) {
    const text = summary.direction === null ? null : fmtWeightChange(summary.weeklyChangeKg, unit)
    if (text === null) {
      change = { spoken: 'no weekly trend yet' }
      hint = summary.noTrend === 'sparse'
        ? 'Weigh in twice a week to see your weekly trend.'
        : 'Your weekly trend shows after a few more weigh-ins.'
    } else if (summary.direction === 'steady') change = { text: 'Steady', spoken: 'steady this week' }
    else {
      const down = summary.direction === 'down'
      change = {
        icon: down ? 'trendingDown' : 'trendingUp',
        text: `${text} ${u}/wk`,
        spoken: `${down ? 'down' : 'up'} ${text.replace(/^[+−]/, '')} ${u} a week`,
      }
    }
  }
  const when = summary ? relativeDay(summary.latestDate, today) : ''

  const figures = summary && (
    <>
      <span className="wi-text">
        <span className="wi-now">
          <strong className="wi-value">{fmtNum(shown, 1)}</strong>
          <span className="wi-unit">{u}</span>
        </span>
        <span className="wi-meta">
          <span className="wi-when">{when}</span>
          {change.text && (
            <span className="wi-change">
              {change.icon && <Icon name={change.icon} size={15} strokeWidth={2.2} />}
              {change.text}
            </span>
          )}
        </span>
      </span>
      <Spark values={summary.spark} />
      {to && <Icon name="chevronRight" size={18} className="wi-chevron" />}
    </>
  )
  const spokenWhen = when === 'Today' || when === 'Yesterday' ? when.toLowerCase() : when
  const spoken = summary ? `Weight ${fmtNum(value, 1)} ${u}, ${spokenWhen}, ${change.spoken}` : ''

  const body = !loaded ? (
    <Skeleton lines={2} />
  ) : !summary ? (
    <p className="wi-empty">Weigh in a few mornings a week and a smoothed trend shows here.</p>
  ) : to ? (
    <button type="button" className="wi-body is-link" onClick={() => navigate(to)} aria-label={`${spoken}. Open weight details`}>{figures}</button>
  ) : (
    <div className="wi-body" role="group" aria-label={spoken}>{figures}</div>
  )

  const content = (
    <>
      {!bare && (
        <div className="wi-head">
          <span className="wi-icon" aria-hidden="true"><Icon name="scale" size={20} /></span>
          <Heading id={titleId} className="wi-title">Weight</Heading>
          {link && <button type="button" className="link-btn wi-link" onClick={() => navigate(link.to)}>{link.label}</button>}
          {capsule && <Button variant="secondary" size="sm" icon="plus" className="wi-capsule" onClick={openSheet}>Weigh in</Button>}
        </div>
      )}
      {body}
      {loaded && hint && <p className="wi-hint">{hint}</p>}
      {loaded && nudge && (
        <div className="wi-nudge">
          <button type="button" className="wi-nudge-main" onClick={() => openSheet(today)}>
            <Icon name="scale" size={16} />
            <span><strong>Last weigh-in {nudge.days} days ago</strong> · Weigh in</span>
          </button>
          <button type="button" className="wi-nudge-x" onClick={hideNudge} aria-label="Hide the weigh-in reminder for today">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {loaded && (typeof children === 'function' ? children({ open: openSheet, summary }) : children)}
    </>
  )

  return (
    <>
      {bare ? (
        <div className={`wi-bare ${className}`}>{content}</div>
      ) : (
        <section className={`card wi-card ${className}`} aria-labelledby={titleId}>{content}</section>
      )}
      {used && (
        <Suspense fallback={null}>
          <WeightSheet open={open} onClose={() => setOpen(false)} date={sheetDate || date || today} today={today} />
        </Suspense>
      )}
    </>
  )
}

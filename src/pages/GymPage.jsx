import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { Button, IconButton, Skeleton } from '../components/ui/primitives.jsx'
import { startedMs, useClock, workoutClock, workoutWhen } from '../components/WorkoutPill.jsx'
import { formatDateLong, formatDateShort } from '../lib/dates.js'
import { isBackfillWorkout } from '../lib/gym/stats.js'
import { hasPlan, routineById, routineColor, useActiveWorkout, useGym, useToday } from '../lib/gym/state.js'
import { formatDuration } from '../lib/gym/units.js'
import { navigate } from '../lib/router.js'
import { refresh, useStore } from '../lib/store.js'
import TodayTab from './gym/TodayTab.jsx'
import CalendarTab from './gym/CalendarTab.jsx'
import RoutinesTab from './gym/RoutinesTab.jsx'
import HistoryTab from './gym/HistoryTab.jsx'
import ExercisesTab from './gym/ExercisesTab.jsx'
import WorkoutScreen from './gym/WorkoutScreen.jsx'
import SessionDetail from './gym/SessionDetail.jsx'
import RoutineEditor from './gym/RoutineEditor.jsx'
import ExerciseDetail from './gym/ExerciseDetail.jsx'
import StatsView from './gym/StatsView.jsx'
import Onboarding from './gym/Onboarding.jsx'
import ToolsSheet from './gym/ToolsSheet.jsx'
import GymSettingsSheet from './gym/GymSettingsSheet.jsx'
import './gym/gym-common.css'
import './gym/gym.css'

// #/gym/<view>/<param>: five tabs under one header, and detail views that take the whole page.

const TABS = [
  { id: 'today', label: 'Today', hash: '#/gym' },
  { id: 'calendar', label: 'Calendar', hash: '#/gym/calendar' },
  { id: 'routines', label: 'Routines', hash: '#/gym/routines' },
  { id: 'history', label: 'History', hash: '#/gym/history' },
  { id: 'exercises', label: 'Exercises', hash: '#/gym/exercises' },
]
const TAB_VIEWS = { today: TodayTab, calendar: CalendarTab, routines: RoutinesTab, history: HistoryTab, exercises: ExercisesTab }
const DETAIL_VIEWS = { workout: WorkoutScreen, session: SessionDetail, routine: RoutineEditor, exercise: ExerciseDetail, stats: StatsView }

function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  const view = parts[1] || 'today'
  if (!TAB_VIEWS[view] && !DETAIL_VIEWS[view]) return { view: 'today', param: null }
  let param = parts.slice(2).join('/')
  try {
    param = decodeURIComponent(param)
  } catch {
    // keep the raw text
  }
  return { view, param: param || null }
}

export default function GymPage() {
  const [route, setRoute] = useState(parseHash)
  const today = useToday()
  const gym = useGym()
  const active = useActiveWorkout()
  // Real data (cache or server) has arrived; until then an empty gym only means "not loaded yet".
  const hydrated = useStore((state) => state.hydrated)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Scroll position of the tab a detail view was opened from, restored on the way back.
  const tabScroll = useRef({ view: null, y: 0 })
  const previous = useRef(route)

  useEffect(() => {
    const onHash = () => {
      const next = parseHash()
      setRoute((current) => (current.view === next.view && current.param === next.param ? current : next))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useLayoutEffect(() => {
    const from = previous.current
    previous.current = route
    if (from === route) return
    const leavingTab = !!TAB_VIEWS[from.view] && !!DETAIL_VIEWS[route.view]
    const returning = !!TAB_VIEWS[route.view] && !!DETAIL_VIEWS[from.view] && tabScroll.current.view === route.view
    if (leavingTab) tabScroll.current = { view: from.view, y: window.scrollY }
    const y = returning ? tabScroll.current.y : 0
    window.scrollTo({ top: 0 })
    if (y) requestAnimationFrame(() => window.scrollTo({ top: y }))
  }, [route])

  const Detail = DETAIL_VIEWS[route.view]
  if (Detail) {
    return (
      <div className="gym-shell gym-shell-detail">
        <Detail today={today} param={route.param} />
      </div>
    )
  }

  // Onboarding only for a gym that really has no plan: before the data has loaded (new device,
  // after signing in, a failed first load) it would offer templates that replace the saved plan.
  const noPlan = route.view === 'today' && !hasPlan(gym)
  const Tab = noPlan ? (hydrated ? Onboarding : PlanLoading) : TAB_VIEWS[route.view]

  return (
    <div className="gym-shell">
      <header className="page-header gym-shell-head">
        <div className="gym-shell-head-text">
          <p className="eyebrow">{formatDateLong(today)}</p>
          <h1>Gym</h1>
        </div>
        <div className="gym-shell-head-actions">
          <IconButton icon="calculator" label="Plate & 1RM calculators" className="gym-shell-head-btn" size={21} onClick={() => setToolsOpen(true)} />
          <IconButton icon="settings" label="Gym settings" className="gym-shell-head-btn" size={21} onClick={() => setSettingsOpen(true)} />
        </div>
      </header>

      {active && <ResumeBanner active={active} gym={gym} today={today} />}

      <nav className="segmented gym-shell-tabs" role="tablist" aria-label="Gym sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={route.view === tab.id}
            className={route.view === tab.id ? 'is-active' : ''}
            onClick={() => {
              if (route.view !== tab.id) window.location.replace(tab.hash)
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="gym-shell-body" role="tabpanel" aria-label={TABS.find((tab) => tab.id === route.view)?.label}>
        <Tab today={today} />
      </div>

      <ToolsSheet open={toolsOpen} onClose={() => setToolsOpen(false)} initialTab="plates" />
      <GymSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

// Stands in for Onboarding until the saved plan has loaded, with a retry once a load has failed.
function PlanLoading() {
  const failed = useStore((state) => state.loaded && !state.syncing)
  return (
    <div className="form-stack" aria-busy={!failed}>
      <Skeleton lines={4} />
      {failed ? (
        <>
          <p className="muted" role="status">Your gym plan hasn’t loaded yet.</p>
          <Button variant="secondary" icon="refresh" onClick={() => refresh().catch(() => {})}>Try again</Button>
        </>
      ) : <p className="sr-only" role="status">Loading your gym plan…</p>}
    </div>
  )
}

function ResumeBanner({ active, gym, today }) {
  // A past workout being typed in has a date, not a clock; a live one keeps its clock past midnight
  // (capped like the floating pill's: hours later it reads 'Started 9:05 AM').
  const backfill = isBackfillWorkout(active)
  const restEnd = Number(active.rest?.endAt)
  const resting = Number.isFinite(restEnd) && restEnd > Date.now()
  const now = useClock(!backfill || resting, resting ? restEnd : startedMs(active) ?? 0)

  const routine = routineById(gym, active.routineId)
  const name = active.name?.trim() || routine?.name?.trim() || 'Workout'
  const restLeft = resting ? Math.ceil((restEnd - now) / 1000) : 0
  const when = restLeft > 0
    ? `Rest ${formatDuration(restLeft)}`
    : backfill ? formatDateShort(active.date) : workoutClock(active, now) || workoutWhen(active, today)

  return (
    <button
      type="button"
      className={`gym-shell-resume${routine ? ' has-routine' : ''}`}
      style={routine ? { '--gym-rc': routineColor(routine) } : undefined}
      onClick={() => navigate('gym/workout')}
    >
      <span className="gym-shell-resume-pulse" aria-hidden="true" />
      <span className="gym-shell-resume-text">
        <strong>{name}</strong>
        <span>{backfill ? 'Logging a past workout' : 'in progress'}</span>
      </span>
      {when && <span className="gym-shell-resume-time" aria-live="off">{when}</span>}
      <span className="gym-shell-resume-cta">
        Resume
        <Icon name="chevronRight" size={16} strokeWidth={2.4} />
      </span>
    </button>
  )
}

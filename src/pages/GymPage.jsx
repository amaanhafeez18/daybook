import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { Button, IconButton, Skeleton } from '../components/ui/primitives.jsx'
import { startedMs, useClock, workoutClock, workoutWhen } from '../components/WorkoutPill.jsx'
import { formatDateLong, formatDateShort } from '../lib/dates.js'
import { isBackfillWorkout } from '../lib/gym/stats.js'
import { hasPlan, routineById, routineColor, useActiveWorkout, useGym, useToday } from '../lib/gym/state.js'
import { formatDuration } from '../lib/gym/units.js'
import { lazyPage, lazySheet, whenIdle } from '../lib/lazyPage.js'
import { navigate, subscribeRoute } from '../lib/router.js'
import { refresh, useStore } from '../lib/store.js'
import { goBack } from './gym/common.jsx'
import { useSlidingThumb } from '../components/ui/useSlidingThumb.js'
import TodayTab from './gym/TodayTab.jsx'
import './gym/gym-common.css'
import './gym/gym.css'
import './gym/browse.css'

// Views opened from a tap (not the tabs or a running workout) load on demand, which keeps the Gym
// chunk small; they're warmed a moment after the Gym page opens so the first tap is instant (and
// slides in with the view already drawn: a view still loading would slide in as a skeleton).
// Only the Today tab ships with the Gym page; the other tabs, the workout screen and the rarely
// used sheets load on their own, warmed in a quiet moment after the page opens (WARM_VIEWS), so
// switching to them stays instant.
const CalendarTab = lazyPage(() => import('./gym/CalendarTab.jsx'))
const RoutinesTab = lazyPage(() => import('./gym/RoutinesTab.jsx'))
const ProgressTab = lazyPage(() => import('./gym/ProgressTab.jsx'))
const AllWorkouts = lazyPage(() => import('./gym/HistoryTab.jsx'))
const ExercisesTab = lazyPage(() => import('./gym/ExercisesTab.jsx'))
const WorkoutScreen = lazyPage(() => import('./gym/WorkoutScreen.jsx'), 'gym-workout')
const Onboarding = lazyPage(() => import('./gym/Onboarding.jsx'))
const ToolsSheet = lazySheet(() => import('./gym/ToolsSheet.jsx'))
const SessionDetail = lazyPage(() => import('./gym/SessionDetail.jsx'))
const RoutineEditor = lazyPage(() => import('./gym/RoutineEditor.jsx'))
const ExerciseDetail = lazyPage(() => import('./gym/ExerciseDetail.jsx'))
const GymSettingsSheet = lazyPage(() => import('./gym/GymSettingsSheet.jsx'))
// #/gym/visuals: review grid of every exercise visual (not linked anywhere).
const VisualsGallery = lazyPage(() => import('./gym/visuals/VisualsGallery.jsx'))
const WARM_VIEWS = [WorkoutScreen, RoutinesTab, ProgressTab, CalendarTab, SessionDetail, ExerciseDetail, RoutineEditor, GymSettingsSheet, AllWorkouts]

// #/gym/<view>/<param>: three tabs under one header (Calendar is a view of its own, opened from
// Today's week strip, under the Today tab), the exercise library (opened from Routines)
// as a page of its own, and detail views that take the whole page.

const TABS = [
  { id: 'today', label: 'Today', hash: '#/gym' },
  { id: 'routines', label: 'Routines', hash: '#/gym/routines' },
  { id: 'history', label: 'Progress', hash: '#/gym/history' },
]
const TAB_VIEWS = { today: TodayTab, calendar: CalendarTab, routines: RoutinesTab, history: ProgressTab }
const PAGE_VIEWS = { exercises: ExercisesPage, workouts: AllWorkouts }
const DETAIL_VIEWS = { workout: WorkoutScreen, session: SessionDetail, routine: RoutineEditor, exercise: ExerciseDetail, visuals: VisualsGallery }
// #/gym/settings: the Today tab with the Gym settings sheet open (linked from Settings).
const SHEET_VIEWS = { settings: true }
const knownView = (view) => !!(TAB_VIEWS[view] || PAGE_VIEWS[view] || DETAIL_VIEWS[view] || SHEET_VIEWS[view])
// How deep a view sits: tabs, then the library, then details. Going deeper keeps the scroll
// position of the view left behind; coming back up restores it. (lib/router.js navLevel has the
// same levels for the slide between views.)
const viewLevel = (view) => (TAB_VIEWS[view] || SHEET_VIEWS[view] ? 0 : PAGE_VIEWS[view] ? 1 : 2)

function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  // #/gym/stats was its own page; Stats is now the Progress tab (#/gym/history).
  const view = parts[1] === 'stats' ? 'history' : parts[1] || 'today'
  if (!knownView(view)) return { view: 'today', param: null }
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
  const [settingsUsed, setSettingsUsed] = useState(false) // mounted once opened, so it can animate closed
  // Scroll positions of the views a deeper one was opened from, restored on the way back.
  const scrolls = useRef({})
  const leftAt = useRef(0) // window.scrollY when the route last changed
  const previous = useRef(route)

  useEffect(() => {
    return whenIdle(() => {
      for (const view of WARM_VIEWS) view.preload().catch(() => {})
    }, 600)
  }, [])

  // Through the app's one route dispatcher, so a slide to a detail view draws the new view (and
  // its scroll, below) inside the transition.
  useEffect(() => subscribeRoute(() => {
    leftAt.current = window.scrollY // before the new view renders (a shorter one would clamp it)
    const next = parseHash()
    setRoute((current) => (current.view === next.view && current.param === next.param ? current : next))
  }), [])

  // The settings route opens the sheet; closing it goes back to the Today tab.
  useEffect(() => {
    if (route.view !== 'settings') return
    setSettingsUsed(true)
    setSettingsOpen(true)
  }, [route])

  const closeSettings = () => {
    setSettingsOpen(false)
    if (parseHash().view === 'settings') window.location.replace('#/gym')
  }

  useLayoutEffect(() => {
    const from = previous.current
    previous.current = route
    if (from === route) return
    const deeper = viewLevel(route.view) > viewLevel(from.view)
    const returning = viewLevel(route.view) < viewLevel(from.view)
    if (deeper) scrolls.current[from.view] = leftAt.current
    const y = returning ? scrolls.current[route.view] || 0 : 0
    // At once (this runs inside the slide's update); once more next frame if the view was still
    // too short to get there.
    window.scrollTo({ top: y })
    if (y && Math.abs(window.scrollY - y) > 1) requestAnimationFrame(() => window.scrollTo({ top: y }))
  }, [route])

  const Detail = DETAIL_VIEWS[route.view] || PAGE_VIEWS[route.view]
  if (Detail) {
    return (
      <div className="gym-shell gym-shell-detail">
        <Suspense fallback={<Skeleton lines={4} />}>
          <Detail today={today} param={route.param} />
        </Suspense>
      </div>
    )
  }

  // Onboarding only for a gym that really has no plan: before the data has loaded (new device,
  // after signing in, a failed first load) it would offer templates that replace the saved plan.
  const tabView = TAB_VIEWS[route.view] ? route.view : 'today'
  const tabShown = tabView === 'calendar' ? 'today' : tabView // the calendar sits under Today
  const noPlan = tabView === 'today' && !hasPlan(gym)
  const Tab = noPlan ? (hydrated ? Onboarding : PlanLoading) : TAB_VIEWS[tabView]

  return (
    // gym-shell-today: the Today tab takes the wider desktop column (shell.css) for its two columns.
    <div className={`gym-shell${tabView === 'today' && !noPlan ? ' gym-shell-today' : ''}`}>
      <header className="page-header gym-shell-head">
        <div className="gym-shell-head-text">
          <p className="eyebrow">{formatDateLong(today)}</p>
          <h1>Gym</h1>
        </div>
        <div className="gym-shell-head-actions">
          <IconButton icon="settings" label="Gym settings" className="gym-shell-head-btn" size={21} onClick={() => {
            setSettingsUsed(true)
            setSettingsOpen(true)
          }} />
        </div>
      </header>

      {active && <ResumeBanner active={active} gym={gym} today={today} />}

      <GymTabs active={tabShown} view={route.view} />

      <div className="gym-shell-body" role="tabpanel" aria-label={tabView === 'calendar' ? 'Calendar' : TABS.find((tab) => tab.id === tabView)?.label}>
        <Suspense fallback={<Skeleton lines={4} />}>
          <Tab today={today} />
        </Suspense>
      </div>

      <ToolsSheet open={toolsOpen} onClose={() => setToolsOpen(false)} initialTab="plates" />
      {settingsUsed && (
        <Suspense fallback={null}>
          <GymSettingsSheet open={settingsOpen} onClose={closeSettings} />
        </Suspense>
      )}
    </div>
  )
}

// The section tabs; the highlight slides to the chosen one (useSlidingThumb). Its own component,
// so the measuring starts afresh each time the tabs come back from a detail view.
function GymTabs({ active, view }) {
  const ref = useRef(null)
  useSlidingThumb(ref, active)
  return (
    <nav ref={ref} className="segmented gym-shell-tabs gym-tabs" role="tablist" aria-label="Gym sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? 'is-active' : ''}
          onClick={() => {
            if (view !== tab.id) window.location.replace(tab.hash)
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

// The exercise library: rarely needed, so it's a row on the Routines tab rather than a tab.
function ExercisesPage({ today }) {
  return (
    <div className="gym-st gym-br-page">
      <div className="gym-xd-top">
        <button type="button" className="gym-xd-back" onClick={() => goBack('gym/routines')}>
          <Icon name="chevronLeft" size={22} />
          Routines
        </button>
      </div>
      <ExercisesTab today={today} />
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

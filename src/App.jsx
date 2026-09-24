import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import AuthScreen from './components/AuthScreen.jsx'
import Icon, { BrandMark } from './components/ui/Icon.jsx'
import { Avatar } from './components/ui/primitives.jsx'
import { ConfirmHost, Toaster, toast } from './components/ui/feedback.jsx'
import TodayPage from './pages/TodayPage.jsx'
import WorkoutPill from './components/WorkoutPill.jsx'
import Welcome from './components/Welcome.jsx'
import { SESSION_EXPIRED_EVENT, clearSession, fetchSession, getCachedUser, getToken, readJson, readPref, tokenUserId, writePref } from './lib/api.js'
import { getState, hydrateFromCache, refresh, resetStore, retryUnsaved, updateSettings, useData, useStore } from './lib/store.js'
import { ensureFriendReminders } from './lib/planner.js'
import { syncSubscription } from './lib/notifications.js'
import { applyTheme } from './lib/theme.js'
import { toISO } from './lib/dates.js'
import { useNow } from './lib/environment.js'
import './components/today.css'
import './components/shell.css'

// Only Today ships in the first bundle; other pages load on first visit (then stay cached).
const PAGE_LOADERS = {
  tasks: () => import('./pages/TasksPage.jsx'),
  calendar: () => import('./pages/CalendarPage.jsx'),
  people: () => import('./pages/PeoplePage.jsx'),
  assistant: () => import('./pages/AssistantPage.jsx'),
  journal: () => import('./pages/JournalPage.jsx'),
  gym: () => import('./pages/GymPage.jsx'),
  food: () => import('./pages/FoodPage.jsx'),
  settings: () => import('./pages/SettingsPage.jsx'),
}
const TasksPage = lazy(PAGE_LOADERS.tasks)
const CalendarPage = lazy(PAGE_LOADERS.calendar)
const PeoplePage = lazy(PAGE_LOADERS.people)
const AssistantPage = lazy(PAGE_LOADERS.assistant)
const JournalPage = lazy(PAGE_LOADERS.journal)
const GymPage = lazy(PAGE_LOADERS.gym)
const FoodPage = lazy(PAGE_LOADERS.food)
const SettingsPage = lazy(PAGE_LOADERS.settings)
// Warmed one by one once the first screen is up, so the first visit to a tab doesn't wait for its
// code (it's precached by the service worker, so this costs no network). Most used first.
const PREFETCH_ORDER = ['tasks', 'calendar', 'assistant', 'people', 'food', 'gym', 'journal']

// Phones: the five tabs sit in the bottom bar, the daily extras are top-bar icons and Settings is
// the avatar on the left of the top bar. Desktop: tabs + extras in the sidebar, Settings at its foot.
const TABS = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'assistant', label: 'Assistant', icon: 'sparkles' },
]
const EXTRAS = [
  { id: 'journal', label: 'Journal', icon: 'journal' },
  { id: 'gym', label: 'Gym', icon: 'dumbbell' },
  { id: 'food', label: 'Food', icon: 'utensils' },
]
const SETTINGS = { id: 'settings', label: 'Settings', icon: 'settings' }
const PAGES = [...TABS, ...EXTRAS, SETTINGS]
const ROUTES = PAGES.map((item) => item.id)
const LEGACY_ROUTES = { summary: 'today', ai: 'assistant', friends: 'people' }

// Tapping the link of the page already showing (same hash, so nothing would happen) scrolls it
// back to the top, like tapping the current tab on iOS. From a sub-view (#/gym/stats) it still goes home.
function scrollIfCurrent(event, id) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const current = window.location.hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (current !== id) return
  event.preventDefault()
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })
}

// The live workout (#/gym/workout, and its summary) is 'focus mode': html.is-focus hides the top bar
// and tab bar on phones (shell.css, workout.css); its minimise chevron leads back out.
const FOCUS_HASH = /^#\/?gym\/workout(?:[/?]|$)/
const FOCUS_CLASS = 'is-focus'

function useFocusMode() {
  useEffect(() => {
    const root = document.documentElement
    const update = () => root.classList.toggle(FOCUS_CLASS, FOCUS_HASH.test(window.location.hash))
    update()
    window.addEventListener('hashchange', update)
    return () => {
      window.removeEventListener('hashchange', update)
      root.classList.remove(FOCUS_CLASS)
    }
  }, [])
}

// The first path segment picks the page; pages with sub-views (#/gym/workout, #/food/day/<date>)
// read the rest of the hash themselves.
function routeFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  const route = LEGACY_ROUTES[raw] || raw
  return ROUTES.includes(route) ? route : null
}

export default function App() {
  const [user, setUser] = useState(() => (getToken() ? getCachedUser() : null))
  // Only block on the network when there's a token but no cached user to show.
  const [checking, setChecking] = useState(() => !!getToken() && !getCachedUser())

  const signOut = useCallback((message) => {
    // Several requests can report the same expired session; only the first one shows the toast.
    const hadSession = !!getToken()
    clearSession()
    resetStore()
    applyTheme({})
    setUser(null)
    if (message && hadSession) toast(message)
  }, [])

  useEffect(() => {
    applyTheme(readJson('daybook.data.settings', {}) || {})
    if (!getToken()) return
    fetchSession()
      .then((current) => {
        if (current === undefined) return // the session changed during the check
        if (current) setUser(current)
        else signOut('Your session expired. Please log in again.')
      })
      .catch(() => {}) // offline: keep working from the cache
      .finally(() => setChecking(false))
  }, [signOut])

  useEffect(() => {
    const onExpired = () => signOut('Your session expired. Please log in again.')
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [signOut])

  // Another tab signed out or into a different account: start over with that session, instead
  // of saving this tab's data with the other account's token.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== 'daybook.session.token') return
      const token = getToken()
      if (token ? tokenUserId(token) === user?.id : !user) return // same account (e.g. renewed token) or already signed out
      resetStore()
      window.location.reload()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [user])

  if (checking) return <><Splash /><Toaster /></>

  return (
    <>
      {user
        ? <Shell user={user} onUserChange={setUser} onSignOut={signOut} />
        : <AuthScreen onAuthenticated={setUser} />}
      <Toaster />
      <ConfirmHost />
    </>
  )
}

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading Daybook">
      <BrandMark size={56} />
    </div>
  )
}

function Shell({ user, onUserChange, onSignOut }) {
  // The device cache goes in before anything reads the store, so the very first frame already shows
  // the user's data instead of loading placeholders. (Nothing is subscribed yet at this point.)
  useState(() => hydrateFromCache())
  const [route, setRoute] = useState(() => routeFromHash() || readPref('lastRoute', 'today'))
  // Only the few settings the shell uses (not the whole object), and no sync state: saving then
  // doesn't re-render the open page (SyncStatus and SaveErrors below watch that themselves).
  const rawName = useStore((state) => state.data.settings?.displayName)
  const appearance = useStore((state) => state.data.settings?.appearance)
  const darkMode = useStore((state) => state.data.settings?.darkMode)
  const accent = useStore((state) => state.data.settings?.theme)
  const loaded = useStore((state) => state.loaded)

  // Data: cache first (above), then the server; refresh again whenever the app returns to the foreground.
  useEffect(() => {
    const saveTimeZone = () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (timeZone && getState().data.settings.timeZone !== timeZone) updateSettings({ timeZone })
    }
    refresh().then(() => { ensureFriendReminders(); saveTimeZone(); syncSubscription(user.id) }).catch(() => ensureFriendReminders())
    let last = Date.now()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      retryUnsaved()
      if (Date.now() - last > 30000) {
        last = Date.now()
        refresh().then(() => { ensureFriendReminders(); syncSubscription(user.id) }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [user.id])

  useEffect(() => { applyTheme({ appearance, darkMode, theme: accent }) }, [appearance, darkMode, accent])
  useFocusMode()

  useEffect(() => {
    let index = 0
    let timer = setTimeout(function next() {
      const id = PREFETCH_ORDER[index++]
      if (!id) return
      if (id !== route) PAGE_LOADERS[id]().catch(() => {})
      timer = setTimeout(next, 400)
    }, 1500)
    return () => clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => {
      const next = routeFromHash()
      if (next) setRoute(next)
    }
    window.addEventListener('hashchange', onHash)
    if (!routeFromHash()) window.history.replaceState(null, '', `#/${route}`)
    return () => window.removeEventListener('hashchange', onHash)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    writePref('lastRoute', route)
    window.scrollTo({ top: 0 })
    document.title = `${PAGES.find((item) => item.id === route)?.label || 'Daybook'} · Daybook`
  }, [route])

  // iOS-style navigation bar: once the large page title scrolls away, a compact title appears.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 44)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const displayName = rawName?.trim() || user.username
  const routeLabel = PAGES.find((item) => item.id === route)?.label || 'Daybook'

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">
          <BrandMark size={30} />
          <span>Daybook</span>
        </div>
        <ul className="nav-list">
          {[...TABS, ...EXTRAS].map((item) => (
            <li key={item.id} className={EXTRAS.includes(item) ? 'nav-extra' : undefined}>
              <NavLink item={item} active={route === item.id} />
            </li>
          ))}
        </ul>
        <ul className="nav-list nav-secondary">
          <li>
            <NavLink item={SETTINGS} active={route === SETTINGS.id} />
          </li>
        </ul>
      </nav>

      <div className="shell-main">
        <header className={`topbar ${scrolled ? 'is-scrolled' : ''}`}>
          <a
            href="#/settings"
            className={`topbar-brand td-avatar-btn ${route === 'settings' ? 'is-active' : ''}`}
            aria-label="Settings"
            title="Settings"
            aria-current={route === 'settings' ? 'page' : undefined}
            onClick={(event) => scrollIfCurrent(event, 'settings')}
          >
            <Avatar name={displayName} size={32} />
          </a>
          <span className="topbar-title" aria-hidden={!scrolled}>{routeLabel}</span>
          <SyncStatus />
          <SaveErrors />
          <div className="topbar-actions">
            {EXTRAS.map((item) => (
              <a
                key={item.id}
                href={`#/${item.id}`}
                className={`icon-btn ${route === item.id ? 'is-active' : ''}`}
                title={item.label}
                aria-current={route === item.id ? 'page' : undefined}
                onClick={(event) => scrollIfCurrent(event, item.id)}
              >
                <Icon name={item.icon} size={21} />
                <span className="sr-only">{item.label}</span>
                {item.id === 'journal' && <JournalDot />}
              </a>
            ))}
          </div>
        </header>

        <main id="main" className={`page page-${route}`} tabIndex={-1}>
          <ErrorBoundary key={route}>
            <Suspense fallback={<PageFallback />}>
              {route === 'today' && <TodayPage displayName={displayName} loaded={loaded} />}
              {route === 'tasks' && <TasksPage loaded={loaded} />}
              {route === 'calendar' && <CalendarPage />}
              {route === 'people' && <PeoplePage loaded={loaded} />}
              {route === 'assistant' && <AssistantPage displayName={displayName} />}
              {route === 'journal' && <JournalPage />}
              {route === 'gym' && <GymPage />}
              {route === 'food' && <FoodPage loaded={loaded} />}
              {route === 'settings' && <SettingsPage user={user} onUserChange={onUserChange} onSignOut={onSignOut} />}
            </Suspense>
          </ErrorBoundary>
        </main>
        <WorkoutPill />
      </div>
      <Welcome user={user} />
    </div>
  )
}

// The sync badge and save errors follow the save state on their own, so a save re-renders only them.
function SyncStatus() {
  const syncing = useStore((state) => state.syncing)
  const offline = useStore((state) => state.offline)
  const pendingSaves = useStore((state) => state.pendingSaves)
  return <SyncBadge state={offline ? 'offline' : pendingSaves > 0 || syncing ? 'syncing' : 'synced'} />
}

function SaveErrors() {
  const saveError = useStore((state) => state.saveError)
  useEffect(() => {
    if (saveError) toast(`Couldn’t sync: ${saveError}`, { tone: 'error', action: { label: 'Retry', onClick: retryUnsaved } })
  }, [saveError])
  return null
}

function NavLink({ item, active }) {
  return (
    <a
      href={`#/${item.id}`}
      className={`nav-item ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={(event) => scrollIfCurrent(event, item.id)}
    >
      <span className="nav-icon"><Icon name={item.icon} size={24} strokeWidth={active ? 2.1 : 1.8} /></span>
      <span className="nav-label">{item.label}</span>
      {item.id === 'tasks' && <OverdueBadge />}
      {item.id === 'journal' && <JournalDot />}
    </a>
  )
}

// Overdue open tasks, on the Tasks tab. Its own component, so the minute tick (for midnight)
// doesn't re-render the shell.
function OverdueBadge() {
  const tasks = useData('tasks')
  const today = toISO(useNow(60000))
  const count = useMemo(() => tasks.filter((task) => !task.archived && !task.done && task.date && task.date < today).length, [tasks, today])
  if (!count) return null
  return (
    <span className="td-nav-badge">
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">, {count} overdue</span>
    </span>
  )
}

// Evening nudge (from 18:00) on the Journal icon while today has no entry yet.
function JournalDot() {
  const entries = useData('journalEntries')
  const loaded = useStore((state) => state.loaded)
  const now = useNow(60000)
  const today = toISO(now)
  if (!loaded || now.getHours() < 18 || entries.some((entry) => entry.date === today)) return null
  return (
    <>
      <span className="td-dot" aria-hidden="true" />
      <span className="sr-only">, nothing written today</span>
    </>
  )
}

// Compact: a cloud + "Offline", or just a spinner while saving. A tap explains.
function SyncBadge({ state }) {
  if (state === 'synced') return <span className="sync-badge is-hidden" aria-hidden="true" />
  const offline = state === 'offline'
  return (
    <button
      type="button"
      className={`sync-badge td-sync is-${state}`}
      aria-label={offline ? 'Offline: changes are saved on this device' : 'Saving changes'}
      onClick={() => toast(offline
        ? 'You’re offline. Changes are saved on this device and sync when you’re back online.'
        : 'Saving your changes…')}
    >
      <Icon name={offline ? 'cloudOff' : 'refresh'} size={14} strokeWidth={2} />
      {offline && <span className="td-sync-text" aria-hidden="true">Offline</span>}
    </button>
  )
}

function PageFallback() {
  return (
    <div className="page-fallback" aria-hidden="true">
      <span className="skeleton skeleton-title" />
      <span className="skeleton" />
      <span className="skeleton" style={{ width: '70%' }} />
    </div>
  )
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Page crashed:', error)
    // Bring the top bar and tab bar back, so a crashed workout screen isn't a dead end.
    document.documentElement.classList.remove(FOCUS_CLASS)
  }

  render() {
    if (!this.state.error) return this.props.children
    // A new deployment can make an old lazily-loaded page file disappear; a reload fixes it.
    const chunkError = /Loading chunk|dynamically imported module|Importing a module script failed/i.test(String(this.state.error?.message))
    return (
      <div className="empty-state page-error">
        <span className="empty-icon"><Icon name="alert" size={24} /></span>
        <h3>{chunkError ? 'Daybook was updated' : 'Something went wrong on this page'}</h3>
        <p>{chunkError ? 'Reload to get the latest version.' : 'Your data is safe. Reloading usually fixes this.'}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
}

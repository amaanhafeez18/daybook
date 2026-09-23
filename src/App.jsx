import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import AuthScreen from './components/AuthScreen.jsx'
import Icon, { BrandMark } from './components/ui/Icon.jsx'
import { ConfirmHost, Toaster, toast } from './components/ui/feedback.jsx'
import TodayPage from './pages/TodayPage.jsx'
import WorkoutPill from './components/WorkoutPill.jsx'
import { SESSION_EXPIRED_EVENT, clearSession, fetchSession, getCachedUser, getToken, readJson, readPref, tokenUserId, writePref } from './lib/api.js'
import { getState, hydrateFromCache, refresh, resetStore, retryUnsaved, updateSettings, useStore } from './lib/store.js'
import { ensureFriendReminders } from './lib/planner.js'
import { syncSubscription } from './lib/notifications.js'
import { applyTheme } from './lib/theme.js'

// Only Today ships in the first bundle; other pages load on first visit (then stay cached).
const TasksPage = lazy(() => import('./pages/TasksPage.jsx'))
const CalendarPage = lazy(() => import('./pages/CalendarPage.jsx'))
const PeoplePage = lazy(() => import('./pages/PeoplePage.jsx'))
const AssistantPage = lazy(() => import('./pages/AssistantPage.jsx'))
const JournalPage = lazy(() => import('./pages/JournalPage.jsx'))
const GymPage = lazy(() => import('./pages/GymPage.jsx'))
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'))

const NAV = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'assistant', label: 'Assistant', icon: 'sparkles' },
]
const SECONDARY = [
  { id: 'journal', label: 'Journal', icon: 'journal' },
  { id: 'gym', label: 'Gym', icon: 'dumbbell' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]
const ROUTES = [...NAV, ...SECONDARY].map((item) => item.id)
const LEGACY_ROUTES = { summary: 'today', ai: 'assistant', friends: 'people' }

// The first path segment picks the page; pages with sub-views (#/gym/workout, #/gym/session/<id>)
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
  const [route, setRoute] = useState(() => routeFromHash() || readPref('lastRoute', 'today'))
  const settings = useStore((state) => state.data.settings)
  const loaded = useStore((state) => state.loaded)
  const syncing = useStore((state) => state.syncing)
  const offline = useStore((state) => state.offline)
  const pendingSaves = useStore((state) => state.pendingSaves)
  const saveError = useStore((state) => state.saveError)

  // Data: cache first, then the server; refresh again whenever the app returns to the foreground.
  useEffect(() => {
    hydrateFromCache()
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

  useEffect(() => { applyTheme(settings) }, [settings])

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
    document.title = `${[...NAV, ...SECONDARY].find((item) => item.id === route)?.label || 'Daybook'} · Daybook`
  }, [route])

  // iOS-style navigation bar: once the large page title scrolls away, a compact title appears.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 44)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (saveError) toast(`Couldn’t sync: ${saveError}`, { tone: 'error', action: { label: 'Retry', onClick: retryUnsaved } })
  }, [saveError])

  const displayName = settings?.displayName?.trim() || user.username
  const syncState = offline ? 'offline' : pendingSaves > 0 || syncing ? 'syncing' : 'synced'
  const routeLabel = [...NAV, ...SECONDARY].find((item) => item.id === route)?.label || 'Daybook'

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">
          <BrandMark size={30} />
          <span>Daybook</span>
        </div>
        <ul className="nav-list">
          {NAV.map((item) => (
            <li key={item.id}>
              <a href={`#/${item.id}`} className={`nav-item ${route === item.id ? 'is-active' : ''}`} aria-current={route === item.id ? 'page' : undefined} aria-label={item.label} title={item.label}>
                <span className="nav-icon"><Icon name={item.icon} size={24} strokeWidth={route === item.id ? 2.1 : 1.8} /></span>
                <span className="nav-label">{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <ul className="nav-list nav-secondary">
          {SECONDARY.map((item) => (
            <li key={item.id}>
              <a href={`#/${item.id}`} className={`nav-item ${route === item.id ? 'is-active' : ''}`} aria-current={route === item.id ? 'page' : undefined}>
                <span className="nav-icon"><Icon name={item.icon} size={22} /></span>
                <span className="nav-label">{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="shell-main">
        <header className={`topbar ${scrolled ? 'is-scrolled' : ''}`}>
          <div className="topbar-brand">
            <BrandMark size={28} />
          </div>
          <span className="topbar-title" aria-hidden={!scrolled}>{routeLabel}</span>
          <SyncBadge state={syncState} />
          <div className="topbar-actions">
            {SECONDARY.map((item) => (
              <a key={item.id} href={`#/${item.id}`} className={`icon-btn ${route === item.id ? 'is-active' : ''}`} aria-label={item.label} title={item.label} aria-current={route === item.id ? 'page' : undefined}>
                <Icon name={item.icon} size={21} />
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
              {route === 'settings' && <SettingsPage user={user} onUserChange={onUserChange} onSignOut={onSignOut} />}
            </Suspense>
          </ErrorBoundary>
        </main>
        <WorkoutPill />
      </div>
    </div>
  )
}

function SyncBadge({ state }) {
  if (state === 'synced') return <span className="sync-badge is-hidden" aria-hidden="true" />
  return (
    <span className={`sync-badge is-${state}`} role="status">
      <Icon name={state === 'offline' ? 'cloudOff' : 'refresh'} size={14} />
      {state === 'offline' ? 'Offline · saved on this device' : 'Syncing…'}
    </span>
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

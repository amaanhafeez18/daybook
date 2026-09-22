import React, { useEffect, useState } from 'react'
import TabBar from './components/TabBar.jsx'
import TasksTab from './components/TasksTab.jsx'
import CalendarTab from './components/CalendarTab.jsx'
import FriendsTab from './components/FriendsTab.jsx'
import AITab from './components/AITab.jsx'
import JournalTab from './components/JournalTab.jsx'
import DailySummaryTab from './components/DailySummaryTab.jsx'
import SettingsTab from './components/SettingsTab.jsx'
import { authRequest, clearSession, load, readCachedData, validateSession } from './lib/storage.js'
import { applyTheme, SETTINGS_CHANGED_EVENT } from './lib/theme.js'

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'ai', label: 'AI' },
]

const MORE_TABS = [
  { id: 'friends', label: 'Friends' },
  { id: 'journal', label: 'Journal' },
  { id: 'settings', label: 'Settings' },
]

const ALL_TAB_IDS = [...TABS, ...MORE_TABS].map((item) => item.id)
const LAST_TAB_KEY = 'daybook.lastTab'

function readLastTab() {
  try {
    const saved = localStorage.getItem(LAST_TAB_KEY)
    return ALL_TAB_IDS.includes(saved) ? saved : 'summary'
  } catch {
    return 'summary'
  }
}

const initialForm = {
  username: '',
  password: '',
  recoveryAnswer: '',
  newPassword: '',
}

export default function App() {
  const [tab, setTab] = useState(readLastTab)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [resetUsername, setResetUsername] = useState('')
  const [dataVersion, setDataVersion] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    // Apply the cached theme immediately so the app doesn't flash the default look.
    applyTheme(readCachedData('settings', {}))

    async function bootstrap() {
      const sessionUser = await validateSession()
      setUser(sessionUser)
      setLoading(false)
    }

    bootstrap()
  }, [])

  useEffect(() => {
    if (!user) return
    let active = true
    load('settings', {}).then((settings) => {
      if (!active) return
      applyTheme(settings)
      setDisplayName(settings.displayName || '')
    })

    function onSettingsChanged(event) {
      applyTheme(event.detail)
      setDisplayName(event.detail?.displayName || '')
    }
    function onSaveError(event) {
      setSaveError(event.detail?.message || 'Your last change could not be saved.')
    }
    function onSaveOk() {
      setSaveError('')
    }
    function onSessionExpired() {
      signOut()
      setError('Your session expired. Please log in again.')
    }

    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    window.addEventListener('daybook:save-error', onSaveError)
    window.addEventListener('daybook:save-ok', onSaveOk)
    window.addEventListener('daybook:session-expired', onSessionExpired)
    return () => {
      active = false
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
      window.removeEventListener('daybook:save-error', onSaveError)
      window.removeEventListener('daybook:save-ok', onSaveOk)
      window.removeEventListener('daybook:session-expired', onSessionExpired)
    }
  }, [user])

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setError('')
  }

  async function submitAuth(e) {
    e.preventDefault()
    setError('')

    try {
      if (mode === 'signup') {
        const response = await authRequest('signup', {
          username: form.username,
          password: form.password,
          recoveryAnswer: form.recoveryAnswer,
        })
        setUser(response.user)
        setMode('login')
        setForm(initialForm)
        return
      }

      if (mode === 'login') {
        const response = await authRequest('login', {
          username: form.username,
          password: form.password,
        })
        setUser(response.user)
        setForm(initialForm)
        return
      }

      if (mode === 'forgot') {
        const response = await authRequest('forgot', {
          username: form.username,
        })
        setQuestion(response.question)
        setResetUsername(form.username)
        setMode('reset')
        setForm({ ...initialForm, username: form.username })
        return
      }

      if (mode === 'reset') {
        const answer = (form.recoveryAnswer || '').trim().toLowerCase()
        if (!answer || !form.newPassword) {
          setError('Please enter the answer and a new password.')
          return
        }

        const response = await authRequest('reset', {
          username: resetUsername || form.username,
          answer,
          newPassword: form.newPassword,
        })

        setUser(response.user)
        setForm(initialForm)
        setQuestion('')
        setResetUsername('')
        setMode('login')
      }
    } catch (err) {
      setError(err.message)
    }
  }

  function signOut() {
    clearSession()
    applyTheme({})
    setUser(null)
    setDisplayName('')
    setSaveError('')
    setMode('login')
    setForm(initialForm)
    setQuestion('')
    setResetUsername('')
  }

  function changeTab(nextTab) {
    setTab(nextTab)
    setMoreOpen(false)
    try { localStorage.setItem(LAST_TAB_KEY, nextTab) } catch { /* ignore */ }
  }

  if (loading) {
    return <div className="app auth-loading">Loading Daybook…</div>
  }

  if (!user) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="app-mark" aria-hidden="true" />
            <h1>Daybook</h1>
          </div>

          <h2>
            {mode === 'login' && 'Welcome back'}
            {mode === 'signup' && 'Create account'}
            {mode === 'forgot' && 'Reset password'}
            {mode === 'reset' && 'Set a new password'}
          </h2>

          <form className="auth-form" onSubmit={submitAuth}>
            {mode !== 'reset' && (
              <input
                type="text"
                placeholder="Username"
                autoComplete="username"
                autoCapitalize="none"
                value={form.username}
                onChange={(e) => updateForm('username', e.target.value)}
              />
            )}

            {(mode === 'login' || mode === 'signup') && (
              <input
                type="password"
                placeholder="Password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={form.password}
                onChange={(e) => updateForm('password', e.target.value)}
              />
            )}

            {mode === 'signup' && (
              <>
                <div className="help-text">Security question: What is that you are worried about?</div>
                <input
                  type="text"
                  placeholder="Type 'me' as your answer"
                  value={form.recoveryAnswer}
                  onChange={(e) => updateForm('recoveryAnswer', e.target.value)}
                />
              </>
            )}

            {mode === 'forgot' && (
              <div className="help-text">Enter your username and we’ll check your reset question.</div>
            )}

            {mode === 'reset' && (
              <>
                <div className="help-text">{question}</div>
                <input
                  type="text"
                  placeholder="Answer (type 'me')"
                  value={form.recoveryAnswer}
                  onChange={(e) => updateForm('recoveryAnswer', e.target.value)}
                />
                <input
                  type="password"
                  placeholder="New password"
                  autoComplete="new-password"
                  value={form.newPassword}
                  onChange={(e) => updateForm('newPassword', e.target.value)}
                />
              </>
            )}

            {error && <div className="auth-error">{error}</div>}

            <button type="submit" className="btn-accent auth-submit">
              {mode === 'login' && 'Log in'}
              {mode === 'signup' && 'Create account'}
              {mode === 'forgot' && 'Continue'}
              {mode === 'reset' && 'Save new password'}
            </button>
          </form>

          <div className="auth-links">
            {mode !== 'login' && (
              <button type="button" className="link-btn" onClick={() => { setMode('login'); setError(''); setForm(initialForm); }}>
                Back to login
              </button>
            )}
            {mode === 'login' && (
              <button type="button" className="link-btn" onClick={() => { setMode('signup'); setError(''); setForm(initialForm); }}>
                Create account
              </button>
            )}
            {mode === 'login' && (
              <button type="button" className="link-btn" onClick={() => { setMode('forgot'); setError(''); setForm({ ...initialForm, username: form.username }); }}>
                Forgot password?
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app">
      <header className="app-header">
        <span className="app-mark" aria-hidden="true" />
        <div className="app-header-user">
          <h1>Daybook</h1>
          <span className="user-pill">{displayName.trim() || user.username}</span>
        </div>
        <button className="link-btn header-signout" onClick={signOut}>Log out</button>
      </header>

      {saveError && (
        <div className="save-error-banner" role="alert">
          <span>Couldn’t save your last change: {saveError}</span>
          <button type="button" className="row-delete" aria-label="Dismiss" onClick={() => setSaveError('')}>×</button>
        </div>
      )}

      <main className="app-main">
        {tab === 'tasks' && <TasksTab key={`tasks-${dataVersion}`} />}
        {tab === 'calendar' && <CalendarTab key={`calendar-${dataVersion}`} />}
        {tab === 'friends' && <FriendsTab key={`friends-${dataVersion}`} />}
        {tab === 'summary' && <DailySummaryTab key={`summary-${dataVersion}`} />}
        {tab === 'settings' && <SettingsTab key={`settings-${dataVersion}`} user={user} onLogout={signOut} />}
        {tab === 'journal' && <JournalTab key={`journal-${dataVersion}`} />}
        {tab === 'ai' && <AITab onDataChanged={() => setDataVersion((value) => value + 1)} />}
      </main>

      {moreOpen && <div className="more-menu-backdrop" onClick={() => setMoreOpen(false)} />}
      <TabBar tabs={TABS} active={tab} onChange={changeTab}>
        <div className="more-menu-wrap">
          <button className={`tab-btn more-menu-toggle ${MORE_TABS.some((item) => item.id === tab) ? 'is-active' : ''}`} onClick={() => setMoreOpen((value) => !value)} aria-expanded={moreOpen} aria-haspopup="menu">
            <span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span>
            <span>{MORE_TABS.find((item) => item.id === tab)?.label || 'More'}</span>
          </button>
          {moreOpen && (
            <div className="more-menu" role="menu">
              {MORE_TABS.map((item) => (
                <button key={item.id} role="menuitem" className={tab === item.id ? 'is-active' : ''} onClick={() => changeTab(item.id)}>{item.label}</button>
              ))}
            </div>
          )}
        </div>
      </TabBar>
      </div>
    </ErrorBoundary>
  )
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app auth-loading">
          <div>
            <h2>Daybook needs a refresh</h2>
            <p className="empty-note">Something interrupted this view. Your saved data is still safe.</p>
            <button className="btn-accent" onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

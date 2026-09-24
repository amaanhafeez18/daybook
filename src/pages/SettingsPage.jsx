import { useEffect, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { Avatar, Button, Field, PasswordInput, Segmented, Switch } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import { RECOVERY_QUESTIONS } from '../components/AuthScreen.jsx'
import ClassSheet from '../components/ClassSheet.jsx'
import { authRequest, clearUserCaches, writePref } from '../lib/api.js'
import { navigate } from '../lib/router.js'
import { flushAll, getState, refresh, resetStore, updateSettings, useData, useStore } from '../lib/store.js'
import { discardActive, flushActive, getActiveWorkout, updateGym } from '../lib/gym/state.js'
import { classSchedule } from '../lib/planner.js'
import { ACCENTS, APPEARANCES, resolveAppearance } from '../lib/theme.js'
import { PRAYER_METHODS } from '../lib/environment.js'
import { formatDateShort } from '../lib/dates.js'
import { LEAD_OPTIONS, currentSubscription, disableNotifications, enableNotifications, leadLabel, notificationPrefs, pushSupport, sendTestNotification, syncSubscription } from '../lib/notifications.js'
import '../components/settings.css'

// settings.assistantWeb (also set in Food settings): when the assistant and food search may use the web.
const WEB_OPTIONS = [{ id: 'ask', label: 'Ask first' }, { id: 'always', label: 'Always' }, { id: 'off', label: 'Off' }]
const WEB_HINTS = {
  ask: 'For branded foods and things it doesn’t know, the assistant asks before searching the web.',
  always: 'Searches the web without asking when it needs exact numbers or facts.',
  off: 'Never searches the web. Your saved foods and estimates still work.',
}

// #/settings/<id> opens Settings scrolled to that section (e.g. the prayer card's "Method" link).
const SECTION_IDS = new Set(['notifications', 'assistant', 'classes', 'prayer', 'appearance', 'profile', 'security', 'account', 'danger'])

function useSectionLink() {
  useEffect(() => {
    let frame = 0
    let landedTimer = 0
    const jump = () => {
      const id = window.location.hash.match(/^#\/?settings\/([a-z-]+)/)?.[1]
      if (!id || !SECTION_IDS.has(id)) return
      cancelAnimationFrame(frame)
      // The shell scrolls to the top on a route change, after this page's effects: wait a frame.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          // Back to the plain route, so tapping Settings again scrolls to the top.
          window.history.replaceState(null, '', '#/settings')
          const section = document.getElementById(id)
          if (!section) return
          const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          section.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
          section.classList.add('set-landed')
          clearTimeout(landedTimer)
          landedTimer = setTimeout(() => section.classList.remove('set-landed'), 1800)
        })
      })
    }
    jump()
    window.addEventListener('hashchange', jump)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(landedTimer)
      window.removeEventListener('hashchange', jump)
    }
  }, [])
}

export default function SettingsPage({ user, onUserChange, onSignOut }) {
  const settings = useData('settings')
  const classes = useData('classes')
  const lastSyncedAt = useStore((state) => state.lastSyncedAt)
  const syncing = useStore((state) => state.syncing)
  const [nameDraft, setNameDraft] = useState(settings.displayName || '')
  const [classSheet, setClassSheet] = useState(null)
  const [securitySheet, setSecuritySheet] = useState(null) // 'password' | 'recovery'

  useSectionLink()
  useEffect(() => { setNameDraft(settings.displayName || '') }, [settings.displayName])

  function saveName() {
    if ((settings.displayName || '') !== nameDraft.trim()) updateSettings({ displayName: nameDraft.trim() })
  }

  async function signOut() {
    const ok = await confirmAction({ title: 'Log out?', message: 'Your data stays safe in your account.', confirmLabel: 'Log out', tone: 'default' })
    if (!ok) return
    // Stop this device's reminders while the token can still delete the server row.
    // disableNotifications swallows its own API error, then unsubscribes locally.
    await Promise.race([disableNotifications().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))])
    onSignOut()
  }

  return (
    <div className="settings-page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <NotificationSettings settings={settings} />

      <section className="settings-group" id="assistant">
        <h2>Assistant</h2>
        <div className="card settings-card">
          <Switch
            label="Ask before making changes"
            description="The assistant shows what it understood and waits for your Yes"
            checked={settings.assistantConfirm !== 'off'}
            onChange={(checked) => updateSettings({ assistantConfirm: checked ? 'all' : 'off' })}
          />
          <div className="field">
            <span className="field-label">Web search</span>
            <Segmented options={WEB_OPTIONS} value={WEB_HINTS[settings.assistantWeb] ? settings.assistantWeb : 'ask'} onChange={(assistantWeb) => updateSettings({ assistantWeb })} label="Web search" />
            <p className="field-hint">{WEB_HINTS[settings.assistantWeb] || WEB_HINTS.ask}</p>
          </div>
        </div>
      </section>

      <section className="settings-group" id="classes">
        <div className="settings-group-header">
          <h2>Classes</h2>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setClassSheet({})}>Add class</Button>
        </div>
        <div className="card settings-card settings-list">
          {classes.length === 0 ? <p className="muted">Add your timetable and it shows up on Today and the calendar.</p> : classes.map((item) => (
            <button key={item.id} type="button" className="settings-row" onClick={() => setClassSheet(item)}>
              <span className="settings-row-icon"><Icon name="graduation" size={18} /></span>
              <span className="settings-row-text">
                <strong>{item.name}</strong>
                <small>{classSchedule(item).map((slot) => `${slot.day}${slot.time ? ` ${slot.time.split('-')[0].trim()}` : ''}`).join(' · ')}{item.endDate ? ` · until ${formatDateShort(item.endDate)}` : ''}</small>
              </span>
              <Icon name="chevronRight" size={18} />
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group" id="prayer">
        <h2>Prayer times</h2>
        <div className="card settings-card">
          <Switch label="Show prayer times on Today" checked={settings.showPrayerTimes !== false} onChange={(checked) => updateSettings({ showPrayerTimes: checked })} />
          {settings.showPrayerTimes !== false && (
            <>
              <Field label="Calculation method" hint="Automatic uses the standard authority for your location.">
                {(id) => (
                  <select id={id} className="input" value={settings.prayerMethod || 'auto'} onChange={(event) => updateSettings({ prayerMethod: event.target.value })}>
                    {PRAYER_METHODS.map((method) => <option key={method.id} value={method.id}>{method.label}</option>)}
                  </select>
                )}
              </Field>
              <div className="field">
                <span className="field-label">Asr time</span>
                <Segmented options={[{ id: 0, label: 'Standard' }, { id: 1, label: 'Hanafi' }]} value={Number(settings.prayerSchool || 0)} onChange={(prayerSchool) => updateSettings({ prayerSchool })} label="Asr calculation" />
                <p className="field-hint">Standard: Shafi‘i, Maliki, Hanbali. Hanafi Asr is later in the afternoon.</p>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="settings-group" id="appearance">
        <h2>Appearance</h2>
        <div className="card settings-card">
          <div className="field">
            <span className="field-label">Theme</span>
            <Segmented options={APPEARANCES.map((item) => ({ ...item, icon: item.id === 'light' ? 'sun' : item.id === 'dark' ? 'moon' : 'settings' }))} value={resolveAppearance(settings)} onChange={(appearance) => updateSettings({ appearance, darkMode: appearance === 'dark' })} label="Theme" />
          </div>
          <div className="field">
            <span className="field-label">Accent colour</span>
            <div className="swatches" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((accent) => (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={(settings.theme || 'sunset') === accent.id}
                  className={`swatch ${(settings.theme || 'sunset') === accent.id ? 'is-active' : ''}`}
                  style={{ '--swatch': accent.swatch }}
                  onClick={() => updateSettings({ theme: accent.id })}
                >
                  <span className="swatch-color" aria-hidden="true"><Icon name="check" size={16} strokeWidth={3} /></span>
                  {accent.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" id="profile">
        <h2>Profile</h2>
        <div className="card settings-card">
          <div className="profile-row">
            <Avatar name={nameDraft || user.username} size={52} />
            <div>
              <strong>{nameDraft || user.username}</strong>
              <small>@{user.username}</small>
            </div>
          </div>
          <Field label="Display name" hint="Used in greetings and by the assistant.">
            {(id) => (
              <input
                id={id}
                className="input"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                placeholder={user.username}
                maxLength={40}
              />
            )}
          </Field>
        </div>
      </section>

      <section className="settings-group" id="security">
        <h2>Security</h2>
        <div className="card settings-card settings-list">
          <button type="button" className="settings-row" onClick={() => setSecuritySheet('password')}>
            <span className="settings-row-icon"><Icon name="lock" size={18} /></span>
            <span className="settings-row-text"><strong>Change password</strong><small>Signs out your other devices</small></span>
            <Icon name="chevronRight" size={18} />
          </button>
          <button type="button" className="settings-row" onClick={() => setSecuritySheet('recovery')}>
            <span className="settings-row-icon"><Icon name="undo" size={18} /></span>
            <span className="settings-row-text">
              <strong>Recovery question</strong>
              <small>{user.hasRecovery ? 'Set — used to reset a forgotten password' : 'Not set — you can’t reset a forgotten password'}</small>
            </span>
            {!user.hasRecovery && <span className="badge badge-warning">Set up</span>}
            <Icon name="chevronRight" size={18} />
          </button>
        </div>
      </section>

      <section className="settings-group" id="account">
        <h2>Account</h2>
        <div className="card settings-card settings-list">
          <div className="settings-row is-static">
            <span className="settings-row-icon"><Icon name="refresh" size={18} /></span>
            <span className="settings-row-text">
              <strong>Sync</strong>
              <small>{syncing ? 'Syncing…' : lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Not synced yet'}</small>
            </span>
            <Button variant="secondary" size="sm" loading={syncing} onClick={() => refresh().then(() => toast('Up to date')).catch((error) => toast(error.message, { tone: 'error' }))}>Sync now</Button>
          </div>
          <button type="button" className="settings-row is-danger" onClick={signOut}>
            <span className="settings-row-icon"><Icon name="logout" size={18} /></span>
            <span className="settings-row-text"><strong>Log out</strong></span>
          </button>
        </div>
      </section>

      <DangerZone username={user.username} />

      <p className="settings-footnote">Daybook · Your data syncs across your devices.</p>

      <ClassSheet item={classSheet} onClose={() => setClassSheet(null)} />
      <PasswordSheet open={securitySheet === 'password'} onClose={() => setSecuritySheet(null)} onUserChange={onUserChange} />
      <RecoverySheet open={securitySheet === 'recovery'} onClose={() => setSecuritySheet(null)} onUserChange={onUserChange} />
    </div>
  )
}

// ---- danger zone: clear all data -------------------------------------------------------------
// Two confirmations, then the password. The server deletes everything except the account; this
// device then drops its copies and reloads the (now empty) data without signing out.

const STEP_GAP_MS = 240 // lets one dialog slide away before the next appears (Sheet exit is 180 ms)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const WIPE_MESSAGE = (
  <>
    This deletes your tasks, calendar, people &amp; catch-ups, classes, journal, notes, gym plan, routines &amp; workouts, food log, body weights, assistant chat &amp; memories, and settings, on all your devices.
    <span className="set-confirm-keep">Your account and login stay, and so does this device’s notification permission.</span>
  </>
)

function DangerZone({ username }) {
  const [sheetOpen, setSheetOpen] = useState(false)

  async function start() {
    const first = await confirmAction({ title: 'Clear all your data?', message: WIPE_MESSAGE, confirmLabel: 'Continue' })
    if (first !== true) return
    await pause(STEP_GAP_MS)
    const second = await confirmAction({ title: 'Are you absolutely sure?', message: 'This can’t be undone.', confirmLabel: 'Yes, clear everything' })
    if (second !== true) return
    await pause(STEP_GAP_MS)
    setSheetOpen(true)
  }

  return (
    <section className="settings-group set-danger" id="danger">
      <h2>Danger zone</h2>
      <div className="card settings-card settings-list">
        <button type="button" className="settings-row is-danger" onClick={start}>
          <span className="settings-row-icon"><Icon name="trash" size={18} /></span>
          <span className="settings-row-text">
            <strong>Clear all data</strong>
            <small>Everything except your account</small>
          </span>
        </button>
      </div>
      <p className="set-footnote">Deletes what you’ve added to Daybook on all your devices. You stay logged in.</p>
      <WipeSheet open={sheetOpen} onClose={() => setSheetOpen(false)} username={username} />
    </section>
  )
}

// Module-level, so it finishes even if Settings is left while the request is in flight.
async function clearAllData(password) {
  // Send edits still waiting to be saved (and the active workout) first, so none of them can
  // reach the server after the wipe and bring data back.
  flushActive()
  await flushAll().catch(() => {})
  await authRequest('wipe', { password })
  // The workout in progress lives on this device too; drop it before the store forgets it.
  const active = getActiveWorkout()
  const closedWorkoutId = active?.id
  if (active) discardActive()
  resetStore()
  clearUserCaches({ keepSession: true })
  refresh()
    .then(() => {
      // Reminders need the time zone, and this device stays registered for them.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (timeZone && getState().data.settings.timeZone !== timeZone) updateSettings({ timeZone })
      // discardActive's save was dropped with the store, and the wipe removed the settings row. Mark
      // the workout closed again, so another device still showing it can't push it back.
      if (typeof closedWorkoutId === 'string' && closedWorkoutId) updateGym({ active: null, closedId: closedWorkoutId })
    })
    .catch(() => {}) // offline: the next refresh loads the empty account
}

function WipeSheet({ open, onClose, username }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('') // wrong password: shown on the field
  const [problem, setProblem] = useState('') // anything else (rate limit, offline, server)
  const [busy, setBusy] = useState(false)
  const [shaking, setShaking] = useState(false)
  const fieldRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setPassword('')
    setError('')
    setProblem('')
    setShaking(false)
  }, [open])

  async function submit(event) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError('')
    setProblem('')
    try {
      await clearAllData(password)
      setPassword('')
      onClose()
      toast('All data cleared', { tone: 'success' })
    } catch (err) {
      if (err.payload?.code === 'wrong_password') {
        setError('Wrong password.')
        setShaking(true)
        const input = fieldRef.current?.querySelector('input')
        input?.focus({ preventScroll: true })
        input?.select()
      } else {
        setProblem(err.message || 'Something went wrong. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Confirm with your password"
      size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" type="submit" form="wipe-form" className="btn-grow" loading={busy} disabled={!password || busy}>Delete all data</Button>
        </>
      )}
    >
      <form id="wipe-form" className="form-stack" onSubmit={submit} noValidate>
        <div className="set-wipe-note">
          <span className="set-wipe-icon" aria-hidden="true"><Icon name="trash" size={18} /></span>
          <p>Everything you’ve added to Daybook is deleted for good. Your account stays and you stay logged in.</p>
        </div>
        <div ref={fieldRef} className={`set-wipe-field ${shaking ? 'is-shaking' : ''}`} onAnimationEnd={() => setShaking(false)}>
          <Field label="Password" error={error}>
            {(id) => (
              <PasswordInput
                id={id}
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(''); setProblem('') }}
                autoComplete="current-password"
                aria-invalid={error ? true : undefined}
                readOnly={busy}
                data-autofocus
              />
            )}
          </Field>
        </div>
        {/* Lets password managers (iOS Keychain) offer this account's password. After the password
            field, so the sheet still focuses the password first. */}
        <input type="text" name="username" autoComplete="username" value={username || ''} readOnly hidden />
        {problem && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{problem}</span></div>}
      </form>
    </Sheet>
  )
}

// ---- notifications -----------------------------------------------------------------------

const DEVICE_STATUS = {
  install: 'Add Daybook to your Home Screen (Share → Add to Home Screen), then open it from there to turn on notifications.',
  unsupported: 'This browser doesn’t support notifications.',
  dev: 'Available in the installed app (not the local dev server).',
  denied: 'Blocked. Allow notifications for Daybook in your phone’s Settings → Notifications.',
}

function NotificationSettings({ settings }) {
  const prefs = notificationPrefs(settings)
  const [support, setSupport] = useState(pushSupport)
  const [enabledHere, setEnabledHere] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { currentSubscription().then((subscription) => setEnabledHere(!!subscription)).catch(() => {}) }, [])

  const set = (patch) => updateSettings({ notifications: { ...prefs, ...patch } })

  async function enable() {
    setBusy(true)
    try {
      await enableNotifications()
      setEnabledHere(true)
      toast('Notifications are on for this device', { tone: 'success' })
    } catch (error) {
      toast(error.message, { tone: 'error', duration: 7000 })
    } finally {
      setSupport(pushSupport())
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    await disableNotifications()
    setEnabledHere(false)
    setBusy(false)
    toast('Notifications are off for this device')
  }

  async function test() {
    try {
      await sendTestNotification()
      toast('Test sent — it should arrive in a few seconds')
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  const on = support === 'granted' && enabledHere
  // The server only sends workout reminders once a gym schedule exists.
  const gymVersions = settings.gym?.schedule?.versions
  const hasGymPlan = Array.isArray(gymVersions) && gymVersions.length > 0
  const allDayValue = prefs.allDayTime ? prefs.allDayMode : 'off'
  // The assistant can store any lead; show it rather than a wrong option.
  const leadOptions = LEAD_OPTIONS.filter((option) => option.value !== 1440)
  const taskLead = Number(prefs.taskLead)
  if (Number.isFinite(taskLead) && !leadOptions.some((option) => option.value === taskLead)) leadOptions.push({ value: taskLead, label: leadLabel(taskLead) })

  return (
    <section className="settings-group" id="notifications">
      <h2>Notifications</h2>
      <div className="card settings-card settings-list">
        <div className="settings-row is-static">
          <span className="settings-row-icon"><Icon name="bell" size={18} /></span>
          <span className="settings-row-text">
            <strong>This device</strong>
            <small>{DEVICE_STATUS[support] || (on ? 'On — reminders arrive here' : 'Off')}</small>
          </span>
          {!DEVICE_STATUS[support] && (on
            ? <Button variant="secondary" size="sm" loading={busy} onClick={disable}>Turn off</Button>
            : <Button size="sm" loading={busy} onClick={enable}>Turn on</Button>)}
        </div>
        {on && (
          <button type="button" className="settings-row" onClick={test}>
            <span className="settings-row-icon"><Icon name="send" size={18} /></span>
            <span className="settings-row-text"><strong>Send a test notification</strong></span>
          </button>
        )}
      </div>

      <div className="card settings-card pref-card">
        <div className="pref-row">
          <label htmlFor="pref-lead">Tasks with a time</label>
          <select id="pref-lead" className="input" value={prefs.taskLead} onChange={(event) => set({ taskLead: Number(event.target.value) })}>
            {leadOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="pref-row">
          <label htmlFor="pref-allday">Tasks without a time</label>
          <select id="pref-allday" className="input" value={allDayValue} onChange={(event) => (event.target.value === 'off' ? set({ allDayTime: '' }) : set({ allDayMode: event.target.value, allDayTime: prefs.allDayTime || '09:00' }))}>
            <option value="day">On the day</option>
            <option value="before">The day before</option>
            <option value="off">No reminder</option>
          </select>
        </div>
        {allDayValue !== 'off' && (
          <div className="pref-row">
            <label htmlFor="pref-allday-time">Remind at</label>
            <input id="pref-allday-time" className="input" type="time" value={prefs.allDayTime} onChange={(event) => set({ allDayTime: event.target.value || '09:00' })} />
          </div>
        )}
      </div>

      <div className="card settings-card pref-card">
        <Switch label="Morning summary" description="What’s due, overdue, classes, birthdays and gym" checked={prefs.dailySummary} onChange={(dailySummary) => set({ dailySummary })} />
        {prefs.dailySummary && (
          <div className="pref-row">
            <label htmlFor="pref-summary">Time</label>
            <input id="pref-summary" className="input" type="time" value={prefs.dailySummaryTime} onChange={(event) => set({ dailySummaryTime: event.target.value || '08:00' })} />
          </div>
        )}
        <Switch label="Evening check-in" description="Anything still open or overdue" checked={prefs.overdue} onChange={(overdue) => set({ overdue })} />
        {prefs.overdue && (
          <div className="pref-row">
            <label htmlFor="pref-evening">Time</label>
            <input id="pref-evening" className="input" type="time" value={prefs.overdueTime} onChange={(event) => set({ overdueTime: event.target.value || '18:00' })} />
          </div>
        )}
        <Switch label="Workout reminder" description="On gym days, at a time you choose" checked={!!prefs.gym} onChange={(gym) => set({ gym })} />
        {prefs.gym && (
          <>
            <div className="pref-row">
              <label htmlFor="pref-gym">Time</label>
              <input id="pref-gym" className="input" type="time" value={prefs.gymTime} onChange={(event) => set({ gymTime: event.target.value || '17:00' })} />
            </div>
            {!hasGymPlan && (
              <div className="pref-row">
                <span className="field-hint">Starts once you set up a gym plan.</span>
                <button type="button" className="link-btn" onClick={() => navigate('gym')}>Set up</button>
              </div>
            )}
          </>
        )}
        <Switch label="Catch-ups and birthdays" description="Reminders to reach out to people" checked={prefs.people} onChange={(people) => set({ people })} />
        <Switch label="Quiet hours" description="Hold reminders until quiet hours end" checked={prefs.quietHours} onChange={(quietHours) => set({ quietHours })} />
        {prefs.quietHours && (
          <div className="pref-row">
            <label htmlFor="pref-quiet-start">From</label>
            <span className="pref-range">
              <input id="pref-quiet-start" className="input" type="time" value={prefs.quietStart} onChange={(event) => set({ quietStart: event.target.value || '22:00' })} />
              <span>to</span>
              <input aria-label="Quiet hours end" className="input" type="time" value={prefs.quietEnd} onChange={(event) => set({ quietEnd: event.target.value || '07:00' })} />
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

// ---- security ----------------------------------------------------------------------------

function PasswordSheet({ open, onClose, onUserChange }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setForm({ currentPassword: '', newPassword: '' }); setError('') } }, [open])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      // The server signs out (and stops reminders on) every other device; keep this one's.
      const keepEndpoint = (await currentSubscription().catch(() => null))?.endpoint
      const response = await authRequest('change', { ...form, keepEndpoint })
      if (response.user) onUserChange(response.user)
      // Other devices' push registrations were removed; make sure this one is still registered.
      writePref('pushSync', null)
      if (response.user) syncSubscription(response.user.id)
      toast('Password updated. Your other devices were signed out.', { tone: 'success' })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Change password" footer={<Button type="submit" form="password-form" className="btn-grow" loading={busy}>Update password</Button>}>
      <form id="password-form" className="form-stack" onSubmit={submit}>
        <Field label="Current password">
          {(id) => <PasswordInput id={id} value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} autoComplete="current-password" data-autofocus />}
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          {(id) => <PasswordInput id={id} value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} autoComplete="new-password" />}
        </Field>
        {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{error}</span></div>}
      </form>
    </Sheet>
  )
}

function RecoverySheet({ open, onClose, onUserChange }) {
  const [question, setQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [custom, setCustom] = useState('')
  const [answer, setAnswer] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setQuestion(RECOVERY_QUESTIONS[0])
    setCustom('')
    setAnswer('')
    setCurrentPassword('')
    setError('')
  }, [open])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await authRequest('set_recovery', { question: question === 'custom' ? custom.trim() : question, answer, currentPassword })
      if (response.user) onUserChange(response.user)
      toast('Recovery question saved', { tone: 'success' })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Recovery question" description="Answer it to reset your password if you ever forget it." footer={<Button type="submit" form="recovery-form" className="btn-grow" loading={busy}>Save</Button>}>
      <form id="recovery-form" className="form-stack" onSubmit={submit}>
        <Field label="Question">
          {(id) => (
            <select id={id} className="input" value={question} onChange={(event) => setQuestion(event.target.value)}>
              {RECOVERY_QUESTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
              <option value="custom">Write my own question…</option>
            </select>
          )}
        </Field>
        {question === 'custom' && (
          <Field label="Your question">
            {(id) => <input id={id} className="input" value={custom} onChange={(event) => setCustom(event.target.value)} maxLength={200} />}
          </Field>
        )}
        <Field label="Answer" hint="Not case-sensitive. At least 3 characters.">
          {(id) => <input id={id} className="input" value={answer} onChange={(event) => setAnswer(event.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Current password" hint="Confirms it’s you.">
          {(id) => <PasswordInput id={id} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />}
        </Field>
        {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={18} /><span>{error}</span></div>}
      </form>
    </Sheet>
  )
}

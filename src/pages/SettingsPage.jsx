import { useEffect, useMemo, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { Avatar, Button, Field, PasswordInput, Segmented, Switch } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import { RECOVERY_QUESTIONS } from '../components/AuthScreen.jsx'
import { authRequest } from '../lib/api.js'
import { refresh, updateSettings, useData, useStore } from '../lib/store.js'
import { classSchedule, deleteClass, deleteTaskForever, restoreTask, saveClass } from '../lib/planner.js'
import { ACCENTS, APPEARANCES, resolveAppearance } from '../lib/theme.js'
import { PRAYER_METHODS } from '../lib/environment.js'
import { formatDateShort, formatTime, timeToMinutes } from '../lib/dates.js'
import { LEAD_OPTIONS, currentSubscription, disableNotifications, enableNotifications, notificationPrefs, pushSupport, sendTestNotification } from '../lib/notifications.js'

export default function SettingsPage({ user, onUserChange, onSignOut }) {
  const settings = useData('settings')
  const classes = useData('classes')
  const tasks = useData('tasks')
  const lastSyncedAt = useStore((state) => state.lastSyncedAt)
  const syncing = useStore((state) => state.syncing)
  const [nameDraft, setNameDraft] = useState(settings.displayName || '')
  const [classSheet, setClassSheet] = useState(null)
  const [securitySheet, setSecuritySheet] = useState(null) // 'password' | 'recovery'
  const [showArchived, setShowArchived] = useState(false)
  const archived = useMemo(() => tasks.filter((task) => task.archived).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))), [tasks])

  useEffect(() => { setNameDraft(settings.displayName || '') }, [settings.displayName])

  function saveName() {
    if ((settings.displayName || '') !== nameDraft.trim()) updateSettings({ displayName: nameDraft.trim() })
  }

  async function removeForever(task) {
    const ok = await confirmAction({ title: 'Delete permanently?', message: `“${task.text}” will be gone for good.`, confirmLabel: 'Delete' })
    if (ok) deleteTaskForever(task.id)
  }

  async function signOut() {
    const ok = await confirmAction({ title: 'Log out?', message: 'Your data stays safe in your account.', confirmLabel: 'Log out', tone: 'default' })
    if (ok) onSignOut()
  }

  return (
    <div className="settings-page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <section className="settings-group">
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

      <section className="settings-group">
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

      <NotificationSettings settings={settings} />

      <section className="settings-group">
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

      <section className="settings-group">
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

      <section className="settings-group">
        <h2>Archived tasks</h2>
        <div className="card settings-card settings-list">
          {archived.length === 0 ? <p className="muted">Archived tasks can be restored from here.</p> : (
            <>
              <button type="button" className="settings-row" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived}>
                <span className="settings-row-icon"><Icon name="archive" size={18} /></span>
                <span className="settings-row-text"><strong>{archived.length} archived task{archived.length === 1 ? '' : 's'}</strong></span>
                <Icon name={showArchived ? 'chevronDown' : 'chevronRight'} size={18} />
              </button>
              {showArchived && archived.map((task) => (
                <div key={task.id} className="settings-row is-static">
                  <span className="settings-row-text">
                    <strong>{task.text}</strong>
                    {task.date && <small>{formatDateShort(task.date)}</small>}
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => { restoreTask(task.id); toast('Task restored') }}>Restore</Button>
                  <button type="button" className="icon-btn icon-btn-sm" onClick={() => removeForever(task)} aria-label={`Delete ${task.text} permanently`}><Icon name="trash" size={16} /></button>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="settings-group">
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

      <section className="settings-group">
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

      <p className="settings-footnote">Daybook · Your data syncs across your devices.</p>

      <ClassSheet item={classSheet} onClose={() => setClassSheet(null)} />
      <PasswordSheet open={securitySheet === 'password'} onClose={() => setSecuritySheet(null)} onUserChange={onUserChange} />
      <RecoverySheet open={securitySheet === 'recovery'} onClose={() => setSecuritySheet(null)} onUserChange={onUserChange} />
    </div>
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
  const allDayValue = prefs.allDayTime ? prefs.allDayMode : 'off'

  return (
    <section className="settings-group">
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
            {LEAD_OPTIONS.filter((option) => option.value !== 1440).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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
        <Switch label="Morning summary" description="What’s due, overdue, classes and birthdays" checked={prefs.dailySummary} onChange={(dailySummary) => set({ dailySummary })} />
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

// ---- classes -----------------------------------------------------------------------------

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function toHHMM(minutes) {
  if (minutes === null || minutes === undefined) return ''
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function splitRange(text) {
  const [start, end] = String(text || '').split(/\s*[-–]\s*/)
  return { start: toHHMM(timeToMinutes(start)), end: toHHMM(timeToMinutes(end)) }
}

function ClassSheet({ item, onClose }) {
  const open = !!item
  const editing = item?.id ? item : null
  const [name, setName] = useState('')
  const [endDate, setEndDate] = useState('')
  const [slots, setSlots] = useState({}) // day -> { start, end, room }
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setName(editing?.name || '')
    setEndDate(editing?.endDate || '')
    const next = {}
    for (const slot of editing ? classSchedule(editing) : []) next[slot.day] = { ...splitRange(slot.time), room: slot.room || '' }
    setSlots(next)
  }, [open, editing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDay = (day) => setSlots((current) => {
    const next = { ...current }
    if (next[day]) delete next[day]
    else next[day] = { ...(Object.values(current)[0] || { start: '', end: '', room: '' }) }
    return next
  })
  const setSlot = (day, field, value) => setSlots((current) => ({ ...current, [day]: { ...current[day], [field]: value } }))

  function submit(event) {
    event.preventDefault()
    const days = DAY_ORDER.filter((day) => slots[day])
    if (!name.trim()) return setError('Give the class a name.')
    if (!days.length) return setError('Pick at least one day.')
    const dayDetails = Object.fromEntries(days.map((day) => {
      const { start, end, room } = slots[day]
      const time = start ? `${formatTime(start)}${end ? ` - ${formatTime(end)}` : ''}` : ''
      return [day, { time, room: room.trim() }]
    }))
    saveClass({ ...(editing || {}), name: name.trim(), days, dayDetails, endDate, time: undefined, room: undefined })
    toast(editing ? 'Class updated' : 'Class added')
    onClose()
  }

  function remove() {
    const undo = deleteClass(editing.id)
    onClose()
    toast(`Removed ${editing.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit class' : 'Add a class'}
      footer={(
        <>
          {editing && <Button variant="ghost" icon="trash" onClick={remove}>Remove</Button>}
          <Button type="submit" form="class-form" className="btn-grow">{editing ? 'Save' : 'Add class'}</Button>
        </>
      )}
    >
      <form id="class-form" className="form-stack" onSubmit={submit}>
        <Field label="Class" error={error}>
          {(id) => <input id={id} className="input input-lg" value={name} onChange={(event) => { setName(event.target.value); setError('') }} placeholder="e.g. Biology" autoComplete="off" data-autofocus />}
        </Field>
        <div className="field">
          <span className="field-label">Days</span>
          <div className="chip-row">
            {DAY_ORDER.map((day) => (
              <button key={day} type="button" className={`chip ${slots[day] ? 'is-active' : ''}`} aria-pressed={!!slots[day]} onClick={() => toggleDay(day)}>{day}</button>
            ))}
          </div>
        </div>
        {DAY_ORDER.filter((day) => slots[day]).map((day) => (
          <fieldset key={day} className="slot">
            <legend>{day}</legend>
            <div className="field-row field-row-3">
              <label className="mini-field"><span>Starts</span><input className="input" type="time" value={slots[day].start} onChange={(event) => setSlot(day, 'start', event.target.value)} /></label>
              <label className="mini-field"><span>Ends</span><input className="input" type="time" value={slots[day].end} onChange={(event) => setSlot(day, 'end', event.target.value)} /></label>
              <label className="mini-field"><span>Room</span><input className="input" value={slots[day].room} onChange={(event) => setSlot(day, 'room', event.target.value)} placeholder="Optional" /></label>
            </div>
          </fieldset>
        ))}
        <Field label="Last day of classes" hint="Optional — classes stop showing after this date.">
          {(id) => <input id={id} className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />}
        </Field>
      </form>
    </Sheet>
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
      const response = await authRequest('change', form)
      if (response.user) onUserChange(response.user)
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

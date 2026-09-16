import { useEffect, useState } from 'react'
import { authRequest, load, save, setToken } from '../lib/storage.js'

const DEFAULT_SETTINGS = {
  darkMode: false,
  theme: 'sunset',
  displayName: '',
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function SettingsTab({ user, onLogout }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [classes, setClasses] = useState([])
  const [classForm, setClassForm] = useState({ name: '', days: [], time: '', room: '' })
  const [status, setStatus] = useState('')

  useEffect(() => {
    let active = true

    Promise.all([
      load('settings', DEFAULT_SETTINGS),
      load('classes', []),
    ]).then(([settingsData, classData]) => {
      if (!active) return
      setSettings({ ...DEFAULT_SETTINGS, ...settingsData })
      setClasses(classData)
      applyTheme({ ...DEFAULT_SETTINGS, ...settingsData })
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  function updateSettings(next) {
    const merged = { ...settings, ...next }
    setSettings(merged)
    save('settings', merged)
    applyTheme(merged)
  }

  function updateClassField(field, value) {
    setClassForm((prev) => ({ ...prev, [field]: value }))
  }

  function toggleDay(day) {
    setClassForm((prev) => {
      const exists = prev.days.includes(day)
      const nextDays = exists ? prev.days.filter((item) => item !== day) : [...prev.days, day]
      return { ...prev, days: nextDays }
    })
  }

  function addClass(e) {
    e.preventDefault()
    const trimmedName = classForm.name.trim()
    if (!trimmedName || classForm.days.length === 0) {
      setStatus('Add a class name and at least one day.')
      return
    }

    const nextClass = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name: trimmedName,
      days: classForm.days,
      time: classForm.time,
      room: classForm.room,
    }

    const nextClasses = [...classes, nextClass]
    setClasses(nextClasses)
    save('classes', nextClasses)
    setClassForm({ name: '', days: [], time: '', room: '' })
    setStatus('Class added.')
  }

  function removeClass(id) {
    const nextClasses = classes.filter((item) => item.id !== id)
    setClasses(nextClasses)
    save('classes', nextClasses)
  }

  async function handlePasswordChange(e) {
    e.preventDefault()
    setStatus('This prototype uses the forgot-password flow. Use the reset link from the login screen for password changes.')
  }

  return (
    <section className="tab-panel">
      <div className="settings-panel">
        <h2 className="section-label">Configuration</h2>

        <div className="settings-card">
          <label className="setting-row">
            <span>Display name</span>
            <input
              type="text"
              value={settings.displayName}
              onChange={(e) => updateSettings({ displayName: e.target.value })}
              placeholder={user?.username || 'Your name'}
            />
          </label>

          <label className="setting-row checkbox-row">
            <span>Dark mode</span>
            <input
              type="checkbox"
              checked={!!settings.darkMode}
              onChange={(e) => updateSettings({ darkMode: e.target.checked })}
            />
          </label>

          <label className="setting-row">
            <span>Theme</span>
            <select value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value })}>
              <option value="sunset">Sunset</option>
              <option value="forest">Forest</option>
              <option value="midnight">Midnight</option>
            </select>
          </label>
        </div>

        <h2 className="section-label">Password</h2>
        <form className="settings-card" onSubmit={handlePasswordChange}>
          <label className="setting-row">
            <span>Current password</span>
            <input type="password" placeholder="Current password" />
          </label>
          <label className="setting-row">
            <span>New password</span>
            <input type="password" placeholder="New password" />
          </label>
          <button type="submit" className="btn-small">Update password</button>
        </form>

        <h2 className="section-label">Calendar</h2>
        <div className="settings-card actions-stack">
          <button type="button" className="btn-small" onClick={() => window.open('https://calendar.google.com/calendar/u/0/r/settings/export', '_blank', 'noopener,noreferrer')}>
            Import from Google Calendar
          </button>
          <button type="button" className="btn-small btn-ghost" onClick={onLogout}>Log out</button>
        </div>

        <h2 className="section-label">Classes</h2>
        <form className="settings-card" onSubmit={addClass}>
          <label className="setting-row">
            <span>Name</span>
            <input type="text" value={classForm.name} onChange={(e) => updateClassField('name', e.target.value)} placeholder="e.g. Biology" />
          </label>

          <div className="day-picker">
            {DAYS.map((day) => (
              <button
                key={day}
                type="button"
                className={`day-pill ${classForm.days.includes(day) ? 'is-on' : ''}`}
                onClick={() => toggleDay(day)}
              >
                {day}
              </button>
            ))}
          </div>

          <label className="setting-row">
            <span>Time</span>
            <input type="text" value={classForm.time} onChange={(e) => updateClassField('time', e.target.value)} placeholder="9:00 AM - 10:30 AM" />
          </label>

          <label className="setting-row">
            <span>Room</span>
            <input type="text" value={classForm.room} onChange={(e) => updateClassField('room', e.target.value)} placeholder="Room 204" />
          </label>

          <button type="submit" className="btn-small">Add class</button>
        </form>

        {classes.length > 0 && (
          <ul className="class-list">
            {classes.map((item) => (
              <li key={item.id} className="class-row">
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.days.join(', ')}</span>
                  {item.time && <span>{item.time}</span>}
                  {item.room && <span>{item.room}</span>}
                </div>
                <button type="button" className="row-delete" aria-label="Remove class" onClick={() => removeClass(item.id)}>×</button>
              </li>
            ))}
          </ul>
        )}

        {status && <p className="settings-status">{status}</p>}
      </div>
    </section>
  )
}

function applyTheme(settings) {
  const isDark = !!settings.darkMode
  document.body.dataset.theme = settings.theme || 'sunset'
  document.body.classList.toggle('is-dark', isDark)
}

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
  const [classForm, setClassForm] = useState({ name: '', days: [], endDate: '', dayDetails: {} })
  const [showClassForm, setShowClassForm] = useState(false)
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

  function updateDayDetail(day, field, value) {
    setClassForm((prev) => ({
      ...prev,
      dayDetails: { ...prev.dayDetails, [day]: { ...prev.dayDetails[day], [field]: value } },
    }))
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
      endDate: classForm.endDate,
      dayDetails: classForm.dayDetails,
    }

    const nextClasses = [...classes, nextClass]
    setClasses(nextClasses)
    save('classes', nextClasses)
    setClassForm({ name: '', days: [], endDate: '', dayDetails: {} })
    setShowClassForm(false)
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
          <button type="button" className="btn-small btn-ghost" onClick={onLogout}>Log out</button>
        </div>

        <h2 className="section-label">Classes</h2>
        <button type="button" className="btn-accent" onClick={() => setShowClassForm(true)}>Add class</button>

        {showClassForm && <div className="friend-modal-backdrop" onClick={() => setShowClassForm(false)}>
        <form className="friend-modal" onSubmit={addClass} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>New class</h3>
            <button type="button" className="row-delete" onClick={() => setShowClassForm(false)}>×</button>
          </div>
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

          {classForm.days.map((day) => (
            <div className="class-day-detail" key={day}>
              <strong>{day}</strong>
              <input type="text" placeholder="Time, e.g. 9:00 AM - 10:30 AM" value={classForm.dayDetails[day]?.time || ''} onChange={(e) => updateDayDetail(day, 'time', e.target.value)} />
              <input type="text" placeholder="Room (optional)" value={classForm.dayDetails[day]?.room || ''} onChange={(e) => updateDayDetail(day, 'room', e.target.value)} />
            </div>
          ))}

          <label className="setting-row">
            <span>Classes end</span>
            <input type="date" value={classForm.endDate} onChange={(e) => updateClassField('endDate', e.target.value)} />
          </label>

          <div className="friend-modal-actions">
            <button type="button" className="btn-small btn-ghost" onClick={() => setShowClassForm(false)}>Cancel</button>
            <button type="submit" className="btn-small">Save class</button>
          </div>
        </form>
        </div>}

        {classes.length > 0 && (
          <ul className="class-list">
            {classes.map((item) => (
              <li key={item.id} className="class-row">
                <div>
                  <strong>{item.name}</strong>
                  <span>{getClassDays(item).join(', ')}</span>
                  {item.endDate && <span>Ends {item.endDate}</span>}
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

function getClassDays(item) {
  return (item.days || []).map((day) => typeof day === 'string' ? day : day.day)
}

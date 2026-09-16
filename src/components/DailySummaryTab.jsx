import { useEffect, useMemo, useState } from 'react'
import { load, todayISO } from '../lib/storage.js'

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function DailySummaryTab() {
  const [tasks, setTasks] = useState([])
  const [classes, setClasses] = useState([])
  const [weather, setWeather] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    Promise.all([
      load('tasks', []),
      load('classes', []),
    ]).then(([taskData, classData]) => {
      if (!active) return
      setTasks(taskData)
      setClasses(classData)
    })

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords
          try {
            const response = await fetch(
              `${WEATHER_URL}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`
            )
            const payload = await response.json()
            if (active) {
              setWeather(payload)
            }
          } catch {
            if (active) setError('Weather unavailable right now.')
          }
        },
        () => {
          if (active) setError('Location access denied. Weather is unavailable.')
        }
      )
    } else {
      setError('This browser does not support location-based weather.')
    }

    return () => {
      active = false
    }
  }, [])

  const todayKey = todayISO()
  const tomorrowKey = addDays(todayKey, 1)

  const todayTasks = useMemo(
    () => tasks.filter((task) => task.date === todayKey),
    [tasks, todayKey]
  )

  const tomorrowTasks = useMemo(
    () => tasks.filter((task) => task.date === tomorrowKey),
    [tasks, tomorrowKey]
  )

  const todayClasses = useMemo(
    () => classes.filter((item) => item.days?.includes(getDayName(new Date()))),
    [classes]
  )

  const currentTemp = weather?.current?.temperature_2m
  const currentWeatherCode = weather?.current?.weather_code

  return (
    <section className="tab-panel">
      <div className="summary-grid">
        <div className="summary-card">
          <h3>Due today</h3>
          {todayTasks.length === 0 ? (
            <p className="empty-note">Nothing is due today.</p>
          ) : (
            <ul className="mini-list">
              {todayTasks.map((task) => (
                <li key={task.id}>{task.text}{task.time ? ` · ${task.time}` : ''}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="summary-card">
          <h3>Due tomorrow</h3>
          {tomorrowTasks.length === 0 ? (
            <p className="empty-note">Nothing is due tomorrow.</p>
          ) : (
            <ul className="mini-list">
              {tomorrowTasks.map((task) => (
                <li key={task.id}>{task.text}{task.time ? ` · ${task.time}` : ''}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="summary-card">
          <h3>Weather</h3>
          {error ? (
            <p className="empty-note">{error}</p>
          ) : currentTemp === undefined ? (
            <p className="empty-note">Loading weather…</p>
          ) : (
            <>
              <div className="weather-temp">{Math.round(currentTemp)}°C</div>
              <div className="weather-label">{describeWeather(currentWeatherCode)}</div>
            </>
          )}
        </div>
      </div>

      <div className="summary-card classes-summary">
        <h3>Today’s classes</h3>
        {todayClasses.length === 0 ? (
          <p className="empty-note">No classes scheduled for today.</p>
        ) : (
          <ul className="mini-list">
            {todayClasses.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.time}</span>
                {item.room ? <span> · {item.room}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function addDays(iso, delta) {
  const date = new Date(`${iso}T12:00:00`)
  date.setDate(date.getDate() + delta)
  return date.toISOString().slice(0, 10)
}

function getDayName(date) {
  return WEEKDAY_LABELS[date.getDay()]
}

function describeWeather(code) {
  if (code === undefined || code === null) return 'Weather unknown'
  if (code === 0) return 'Clear sky'
  if ([1, 2, 3].includes(code)) return 'Mostly clear'
  if ([45, 48].includes(code)) return 'Foggy'
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow'
  if ([95, 96, 99].includes(code)) return 'Thunderstorm'
  return 'Cloudy'
}

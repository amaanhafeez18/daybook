import { useEffect, useMemo, useState } from 'react'
import { load, todayISO } from '../lib/storage.js'

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function DailySummaryTab() {
  const [tasks, setTasks] = useState([])
  const [classes, setClasses] = useState([])
  const [weather, setWeather] = useState(null)
  const [prayerTimes, setPrayerTimes] = useState(null)
  const [error, setError] = useState('')
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    let active = true

    Promise.all([
      load('tasks', []),
      load('classes', []),
    ]).then(([taskData, classData]) => {
      if (!active) return
      setTasks(taskData)
      setClasses(classData)
      setDataLoading(false)
    }).catch(() => {
      if (active) setDataLoading(false)
    })

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords
          try {
            const response = await fetch(
              `${WEATHER_URL}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&forecast_days=1&timezone=auto`
            )
            if (!response.ok) throw new Error('Weather request failed')
            const payload = await response.json()
            if (active) {
              setWeather(payload)
            }

            try {
              const prayerResponse = await fetch(
                `https://api.aladhan.com/v1/timings?latitude=${latitude}&longitude=${longitude}&method=2`
              )
              const prayerPayload = await prayerResponse.json()
              if (active && prayerPayload.data?.timings) setPrayerTimes(prayerPayload.data.timings)
            } catch {
              // Prayer times remain unavailable without blocking the weather card.
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
    () => tasks.filter((task) => taskDate(task) === todayKey),
    [tasks, todayKey]
  )

  const openTodayTasks = todayTasks.filter((task) => !task.done)
  const completedTodayTasks = todayTasks.length - openTodayTasks.length

  const tomorrowTasks = useMemo(
    () => tasks.filter((task) => taskDate(task) === tomorrowKey),
    [tasks, tomorrowKey]
  )

  const todayClasses = useMemo(
    () => classes.filter((item) => item.days?.includes(getDayName(new Date()))),
    [classes]
  )

  const currentTemp = weather?.current?.temperature_2m
  const currentWeatherCode = weather?.current?.weather_code
  const prayer = getPrayerStatus(prayerTimes)
  const current = weather?.current
  const daily = weather?.daily

  return (
    <section className="tab-panel">
      <div className="summary-heading">
        <div>
          <p className="eyebrow">Daily overview</p>
          <h2>{formatToday()}</h2>
        </div>
        <div className="summary-progress" aria-label={`${completedTodayTasks} of ${todayTasks.length} tasks complete`}>
          <strong>{completedTodayTasks}/{todayTasks.length}</strong>
          <span>tasks done</span>
        </div>
      </div>
      <div className="summary-grid">
        <div className="summary-card">
          <h3>Due today</h3>
          {dataLoading ? (
            <p className="empty-note">Loading today’s plan…</p>
          ) : todayTasks.length === 0 ? (
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
          {dataLoading ? (
            <p className="empty-note">Loading tomorrow’s plan…</p>
          ) : tomorrowTasks.length === 0 ? (
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
              <div className="weather-details">
                <span>Feels like {Math.round(current.apparent_temperature)}°C</span>
                <span>Humidity {current.relative_humidity_2m}%</span>
                <span>Wind {Math.round(current.wind_speed_10m)} km/h</span>
                <span>Rain {current.precipitation} mm</span>
                {daily?.temperature_2m_max?.[0] !== undefined && (
                  <span>High {Math.round(daily.temperature_2m_max[0])}° / Low {Math.round(daily.temperature_2m_min[0])}°</span>
                )}
              </div>
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

      <div className="summary-card prayer-summary">
        <h3>Muslim prayer times</h3>
        {!prayerTimes ? (
          <p className="empty-note">Allow location access to calculate prayer times.</p>
        ) : (
          <>
            <div className="prayer-current">Current prayer: <strong>{prayer.current}</strong></div>
            <div className="prayer-next">Next: <strong>{prayer.next}</strong> at {prayer.nextTime}</div>
            <ul className="mini-list prayer-list">
              {prayer.entries.map(([name, time]) => <li key={name}><span>{name}</span><span>{time}</span></li>)}
            </ul>
          </>
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

function taskDate(task) {
  if (!task?.date) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(task.date)) return task.date
  const parsed = new Date(task.date)
  if (Number.isNaN(parsed.getTime())) return ''
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

function getPrayerStatus(timings) {
  if (!timings) {
    return { current: 'Unavailable', next: 'Unavailable', nextTime: '--:--', entries: [] }
  }
  const entries = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']
    .map((name) => [name, timings[name]?.split(' ')[0]])
    .filter(([, time]) => time)
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const upcoming = entries.find(([, time]) => toMinutes(time) > currentMinutes) || entries[0]
  const upcomingIndex = entries.findIndex(([name]) => name === upcoming[0])
  const current = upcomingIndex > 0 ? entries[upcomingIndex - 1][0] : 'Isha'
  return {
    current,
    next: upcoming[0],
    nextTime: upcoming[1],
    entries,
  }
}

function formatToday() {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

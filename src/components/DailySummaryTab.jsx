import { useEffect, useMemo, useState } from 'react'
import { addDaysISO, formatTime12, load, todayISO } from '../lib/storage.js'

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PRAYER_CACHE_KEY = 'daybook.prayer.cache'

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
              `${WEATHER_URL}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&forecast_days=2&timezone=auto`
            )
            if (!response.ok) throw new Error('Weather request failed')
            const payload = await response.json()
            if (active) {
              setWeather(payload)
            }

            const cached = readPrayerCache(latitude, longitude)
            if (cached) {
              if (active) setPrayerTimes(cached)
            } else {
              try {
                const prayerResponse = await fetch(
                  `https://api.aladhan.com/v1/timings?latitude=${latitude}&longitude=${longitude}&method=2`
                )
                const prayerPayload = await prayerResponse.json()
                if (prayerPayload.data?.timings) {
                  savePrayerCache(latitude, longitude, prayerPayload.data.timings)
                  if (active) setPrayerTimes(prayerPayload.data.timings)
                }
              } catch {
                // Prayer times remain unavailable without blocking the weather card.
              }
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
  const tomorrowKey = addDaysISO(todayKey, 1)

  const todayTasks = useMemo(
    () => sortByTime(tasks.filter((task) => !task.archived && taskDate(task) === todayKey)),
    [tasks, todayKey]
  )

  const openTodayTasks = todayTasks.filter((task) => !task.done)
  const completedTodayTasks = todayTasks.length - openTodayTasks.length

  const tomorrowTasks = useMemo(
    () => sortByTime(tasks.filter((task) => !task.archived && !task.done && taskDate(task) === tomorrowKey)),
    [tasks, tomorrowKey]
  )

  const todayClasses = useMemo(() => {
    const dayName = getDayName(new Date())
    return classes
      .filter((item) => (!item.endDate || todayKey <= item.endDate) && hasClassDay(item, dayName))
      .map((item) => ({ ...item, ...classDetailsFor(item, dayName) }))
  }, [classes, todayKey])

  const currentTemp = weather?.current?.temperature_2m
  const currentWeatherCode = weather?.current?.weather_code
  const prayer = getPrayerStatus(prayerTimes)
  const current = weather?.current
  const daily = weather?.daily
  const hourlySummary = getNext24Hours(weather)

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
                <li key={task.id} className={task.done ? 'is-done' : ''}>{task.done ? '✓ ' : ''}{task.text}{task.time ? ` · ${formatTime12(task.time)}` : ''}</li>
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
                <li key={task.id}>{task.text}{task.time ? ` · ${formatTime12(task.time)}` : ''}</li>
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
              {hourlySummary && <p className="weather-next-line">Next 24 hours: {hourlySummary}</p>}
            </>
          )}
        </div>

        <div className="summary-card prayer-summary">
          <h3>Muslim prayer times</h3>
          {!prayerTimes ? (
            <p className="empty-note">{error && !error.startsWith('Location') ? 'Prayer times are unavailable right now.' : 'Allow location access to calculate prayer times.'}</p>
          ) : (
            <>
              <div className="prayer-current">Current: <strong>{prayer.current}</strong></div>
              <div className="prayer-next">Next: <strong>{prayer.next}</strong> at {prayer.nextTime}</div>
              <ul className="mini-list prayer-list">
                {prayer.entries.map(([name, time]) => <li key={name}><span>{name}</span><span>{time}</span></li>)}
              </ul>
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
                {item.time ? <span> · {item.time}</span> : null}
                {item.room ? <span> · {item.room}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

    </section>
  )
}

function sortByTime(list) {
  return [...list].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))
}

function classDetailsFor(item, dayName) {
  const entry = (item.days || []).find((day) => typeof day === 'object' && day?.day?.startsWith(dayName))
  const details = item.dayDetails?.[dayName] || entry || {}
  return { time: details.time || item.time || '', room: details.room || item.room || '' }
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
  if ([1, 2].includes(code)) return 'Mostly clear'
  if (code === 3) return 'Overcast'
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
    .map((name) => [name, formatPrayerTime(timings[name])])
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
  const [clock, suffix] = time.split(' ')
  let [hours, minutes] = clock.split(':').map(Number)
  if (suffix === 'PM' && hours < 12) hours += 12
  if (suffix === 'AM' && hours === 12) hours = 0
  return hours * 60 + minutes
}

function hasClassDay(item, dayName) {
  return (item.days || []).some((day) => typeof day === 'string'
    ? day === dayName || day === dayName.slice(0, 3)
    : day?.day === dayName || day?.day === dayName.slice(0, 3))
}

function formatPrayerTime(value) {
  if (!value) return ''
  const [hours, minutes] = value.split(' ')[0].split(':').map(Number)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const displayHour = hours % 12 || 12
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`
}

function readPrayerCache(latitude, longitude) {
  try {
    const cached = JSON.parse(localStorage.getItem(PRAYER_CACHE_KEY) || 'null')
    const sameLocation = cached && Math.abs(cached.latitude - latitude) < 0.2 && Math.abs(cached.longitude - longitude) < 0.2
    return sameLocation && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000 ? cached.timings : null
  } catch {
    return null
  }
}

function savePrayerCache(latitude, longitude, timings) {
  try {
    localStorage.setItem(PRAYER_CACHE_KEY, JSON.stringify({ latitude, longitude, timings, savedAt: Date.now() }))
  } catch {
    // Caching is an optimization and should never block the summary.
  }
}

function getNext24Hours(payload) {
  const times = payload?.hourly?.time
  const temperatures = payload?.hourly?.temperature_2m
  const codes = payload?.hourly?.weather_code
  if (!times?.length || !temperatures?.length) return ''
  const now = Date.now()
  const points = times.map((time, index) => ({ time: new Date(time).getTime(), temperature: temperatures[index], code: codes?.[index] })).filter((point) => point.time >= now - 60 * 60 * 1000).slice(0, 24)
  if (!points.length) return ''
  const high = Math.max(...points.map((point) => point.temperature))
  const low = Math.min(...points.map((point) => point.temperature))
  const rain = points.some((point) => [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(point.code))
  return `${Math.round(low)}° to ${Math.round(high)}°${rain ? ', rain possible' : ', mostly dry'}`
}

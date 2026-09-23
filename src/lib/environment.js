import { useCallback, useEffect, useState } from 'react'
import { readPref, writePref } from './api.js'
import { todayISO } from './dates.js'

const WEATHER_TTL_MS = 30 * 60 * 1000
const LOCATION_TTL_MS = 6 * 60 * 60 * 1000

// Re-renders every `intervalMs` so countdowns and "now" markers stay current.
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

// ---- location ------------------------------------------------------------------------------
// Uses the last known position straight away and refreshes it quietly when permission is
// already granted. Never shows the browser prompt unless the user taps the button.

export function useLocation() {
  const [coords, setCoords] = useState(() => readPref('location', null))
  const [status, setStatus] = useState(() => (typeof navigator !== 'undefined' && navigator.geolocation ? 'idle' : 'unsupported'))

  const locate = useCallback(() => {
    if (!navigator.geolocation) return
    setStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = { lat: Number(position.coords.latitude.toFixed(3)), lon: Number(position.coords.longitude.toFixed(3)), savedAt: Date.now() }
        writePref('location', next)
        setCoords(next)
        setStatus('granted')
      },
      (error) => setStatus(error.code === 1 ? 'denied' : 'error'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: LOCATION_TTL_MS },
    )
  }, [])

  useEffect(() => {
    if (!navigator.geolocation) return
    const fresh = coords && Date.now() - coords.savedAt < LOCATION_TTL_MS
    if (!navigator.permissions?.query) {
      if (coords && !fresh) locate()
      return
    }
    navigator.permissions.query({ name: 'geolocation' }).then((permission) => {
      if (permission.state === 'granted') {
        setStatus('granted')
        if (!fresh) locate()
      } else if (permission.state === 'denied') {
        setStatus('denied')
      } else {
        setStatus(coords ? 'granted' : 'prompt')
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { coords, status, locate }
}

// ---- weather (Open-Meteo, no key) ----------------------------------------------------------

export function useWeather(coords) {
  const [weather, setWeather] = useState(() => {
    const cached = readPref('weather', null)
    return cached && coords && sameSpot(cached.coords, coords) ? cached.data : null
  })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!coords) return undefined
    const cached = readPref('weather', null)
    if (cached && sameSpot(cached.coords, coords) && Date.now() - cached.savedAt < WEATHER_TTL_MS) {
      setWeather(cached.data)
      return undefined
    }
    const controller = new AbortController()
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}`
      + '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,is_day'
      + '&hourly=temperature_2m,weather_code,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&forecast_days=2&timezone=auto'
    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Weather unavailable'))))
      .then((data) => {
        writePref('weather', { coords, data, savedAt: Date.now() })
        setWeather(data)
        setError('')
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError('Weather is unavailable right now.')
      })
    return () => controller.abort()
  }, [coords?.lat, coords?.lon]) // eslint-disable-line react-hooks/exhaustive-deps

  return { weather, error }
}

function sameSpot(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 0.05 && Math.abs(a.lon - b.lon) < 0.05
}

export function describeWeather(code, isDay = 1) {
  if (code === 0) return { label: isDay ? 'Clear' : 'Clear night', icon: isDay ? 'sun' : 'moon' }
  if (code === 1 || code === 2) return { label: 'Partly cloudy', icon: isDay ? 'cloudSun' : 'cloud' }
  if (code === 3) return { label: 'Overcast', icon: 'cloud' }
  if (code === 45 || code === 48) return { label: 'Foggy', icon: 'fog' }
  if ([51, 53, 55, 56, 57].includes(code)) return { label: 'Drizzle', icon: 'rain' }
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: code >= 80 ? 'Showers' : 'Rain', icon: 'rain' }
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: 'Snow', icon: 'snow' }
  if ([95, 96, 99].includes(code)) return { label: 'Thunderstorms', icon: 'storm' }
  return { label: 'Cloudy', icon: 'cloud' }
}

// Next few hours from the hourly forecast: [{ label, temp, icon }].
export function upcomingHours(weather, count = 5) {
  const times = weather?.hourly?.time || []
  const now = Date.now()
  const result = []
  for (let index = 0; index < times.length && result.length < count; index += 1) {
    const time = new Date(times[index]).getTime()
    if (time < now - 30 * 60 * 1000) continue
    const date = new Date(times[index])
    result.push({
      key: times[index],
      label: result.length === 0 ? 'Now' : date.toLocaleTimeString(undefined, { hour: 'numeric' }),
      temp: Math.round(weather.hourly.temperature_2m[index]),
      rain: weather.hourly.precipitation_probability?.[index] ?? null,
      icon: describeWeather(weather.hourly.weather_code[index], date.getHours() >= 6 && date.getHours() < 19 ? 1 : 0).icon,
    })
  }
  return result
}

// ---- prayer times (Aladhan) -----------------------------------------------------------------

export const PRAYER_METHODS = [
  { id: 'auto', label: 'Automatic for my location' },
  { id: '1', label: 'Karachi (University of Islamic Sciences)' },
  { id: '2', label: 'North America (ISNA)' },
  { id: '3', label: 'Muslim World League' },
  { id: '4', label: 'Umm al-Qura, Makkah' },
  { id: '5', label: 'Egyptian General Authority' },
  { id: '8', label: 'Gulf Region' },
  { id: '16', label: 'Dubai' },
  { id: '9', label: 'Kuwait' },
  { id: '10', label: 'Qatar' },
  { id: '13', label: 'Diyanet (Turkey)' },
  { id: '11', label: 'Singapore (MUIS)' },
  { id: '17', label: 'Malaysia (JAKIM)' },
  { id: '20', label: 'Indonesia (Kemenag)' },
  { id: '12', label: 'France (UOIF)' },
  { id: '15', label: 'Moonsighting Committee' },
  { id: '7', label: 'Tehran' },
]

const PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']

export function usePrayerTimes(coords, { method = 'auto', school = 0 } = {}) {
  const date = todayISO()
  const cacheKey = coords ? `${date}|${coords.lat.toFixed(2)},${coords.lon.toFixed(2)}|${method}|${school}` : ''
  const [timings, setTimings] = useState(() => {
    const cached = readPref('prayer', null)
    return cached?.key === cacheKey ? cached.timings : null
  })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!coords) return undefined
    const cached = readPref('prayer', null)
    if (cached?.key === cacheKey) {
      setTimings(cached.timings)
      return undefined
    }
    const controller = new AbortController()
    const [year, month, day] = date.split('-')
    // Without a method the API picks the standard one for the location (e.g. Karachi in Pakistan).
    const url = `https://api.aladhan.com/v1/timings/${day}-${month}-${year}?latitude=${coords.lat}&longitude=${coords.lon}`
      + `${method !== 'auto' ? `&method=${method}` : ''}&school=${school}`
    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Prayer times unavailable'))))
      .then((payload) => {
        const next = payload?.data?.timings
        if (!next) throw new Error('Prayer times unavailable')
        writePref('prayer', { key: cacheKey, timings: next })
        setTimings(next)
        setError('')
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError('Prayer times are unavailable right now.')
      })
    return () => controller.abort()
  }, [cacheKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { timings, error }
}

// Current and next prayer, with minutes until the next one.
export function prayerSchedule(timings, now = new Date()) {
  if (!timings) return null
  const minutesNow = now.getHours() * 60 + now.getMinutes()
  const entries = PRAYERS.map((name) => {
    const [hours, minutes] = String(timings[name] || '').split(' ')[0].split(':').map(Number)
    return { name, minutes: hours * 60 + minutes, label: formatClock(hours, minutes) }
  }).filter((entry) => !Number.isNaN(entry.minutes))
  const prayers = entries.filter((entry) => entry.name !== 'Sunrise')
  let next = prayers.find((entry) => entry.minutes > minutesNow)
  let until = next ? next.minutes - minutesNow : null
  if (!next && prayers.length) {
    next = prayers[0]
    until = 24 * 60 - minutesNow + next.minutes
  }
  const current = [...prayers].reverse().find((entry) => entry.minutes <= minutesNow) || prayers[prayers.length - 1]
  return { entries, next, current, until }
}

function formatClock(hours, minutes) {
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`
}

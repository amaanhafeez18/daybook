import { useCallback, useEffect, useState } from 'react'
import { readPref, writePref } from './api.js'
import { getState, updateSettings, useStore } from './store.js'
import { WEEKDAY_SHORT, todayISO, weekdayIndex } from './dates.js'

const WEATHER_TTL_MS = 30 * 60 * 1000
// Bumped when the request asks for more fields: an older cached payload still shows straight away,
// but counts as stale so the new fields are fetched (v2: 7 days + daily weather codes).
const WEATHER_CACHE_VERSION = 2
const LOCATION_TTL_MS = 6 * 60 * 60 * 1000

// Re-renders every `intervalMs` so countdowns and "now" markers stay current.
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const tick = () => setNow(new Date())
    const timer = setInterval(tick, intervalMs)
    // Timers pause while the app is in the background: catch up as soon as it's back.
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs])
  return now
}

// ---- location ------------------------------------------------------------------------------
// Uses the last known position straight away and refreshes it quietly when permission is
// already granted. Never shows the browser prompt unless the user taps the button.

// The server needs the location too (prayer-time reminders), so it's kept in settings as well.
function syncLocationToSettings({ lat, lon }) {
  const { hydrated, data } = getState()
  if (!hydrated) return // settings not in yet; the mount effect below tries again once they are
  const saved = data.settings?.location
  if (saved && Math.abs(saved.lat - lat) < 0.01 && Math.abs(saved.lon - lon) < 0.01) return
  updateSettings({ location: { lat, lon } })
}

export function useLocation() {
  const [coords, setCoords] = useState(() => readPref('location', null))
  const [status, setStatus] = useState(() => (typeof navigator !== 'undefined' && navigator.geolocation ? 'idle' : 'unsupported'))
  const hydrated = useStore((state) => state.hydrated)

  // A location saved on this device before settings knew about it still reaches the server.
  useEffect(() => {
    if (hydrated && coords) syncLocationToSettings(coords)
  }, [hydrated, coords])

  // `quiet` refreshes (on launch) don't surface a timeout/unavailable error; the user didn't ask.
  const request = useCallback((maxAge, quiet = false) => {
    if (!navigator.geolocation) return
    setStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = { lat: Number(position.coords.latitude.toFixed(3)), lon: Number(position.coords.longitude.toFixed(3)), savedAt: Date.now() }
        writePref('location', next)
        syncLocationToSettings(next)
        setCoords(next)
        setStatus('granted')
      },
      (error) => setStatus(error.code === 1 ? 'denied' : quiet ? 'idle' : 'error'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: maxAge },
    )
  }, [])

  // A tap should get the current spot, not a position cached hours ago somewhere else.
  const locate = useCallback(() => request(60000), [request])

  useEffect(() => {
    if (!navigator.geolocation) return
    const fresh = coords && Date.now() - coords.savedAt < LOCATION_TTL_MS
    if (!navigator.permissions?.query) {
      if (coords && !fresh) request(LOCATION_TTL_MS, true)
      return
    }
    navigator.permissions.query({ name: 'geolocation' }).then((permission) => {
      if (permission.state === 'granted') {
        setStatus('granted')
        if (!fresh) request(LOCATION_TTL_MS, true)
      } else if (permission.state === 'denied') {
        setStatus('denied')
      } else {
        setStatus(coords ? 'granted' : 'prompt')
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // iOS reports 'prompt' on every launch, so a stale position is only refreshed when the user asks.
  const stale = !!coords && Date.now() - coords.savedAt >= LOCATION_TTL_MS
  return { coords, status, locate, stale }
}

// ---- weather (Open-Meteo, no key) ----------------------------------------------------------

export function useWeather(coords) {
  const [weather, setWeather] = useState(() => {
    const cached = readPref('weather', null)
    return cached && coords && sameSpot(cached.coords, coords) ? cached.data : null
  })
  const [error, setError] = useState('')
  // Changes every WEATHER_TTL_MS, so a screen left open (re-rendered by useNow) refetches.
  const bucket = Math.floor(Date.now() / WEATHER_TTL_MS)

  useEffect(() => {
    if (!coords) return undefined
    const cached = readPref('weather', null)
    if (cached && sameSpot(cached.coords, coords)) {
      setWeather(cached.data)
      if (cached.v === WEATHER_CACHE_VERSION && Date.now() - cached.savedAt < WEATHER_TTL_MS) return undefined
    }
    const controller = new AbortController()
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}`
      + '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,is_day'
      + '&hourly=temperature_2m,weather_code,precipitation_probability,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&forecast_days=7&timezone=auto'
    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Weather unavailable'))))
      .then((data) => {
        writePref('weather', { v: WEATHER_CACHE_VERSION, coords, data, savedAt: Date.now() })
        setWeather(data)
        setError('')
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError('Weather is unavailable right now.')
      })
    return () => controller.abort()
  }, [coords?.lat, coords?.lon, bucket]) // eslint-disable-line react-hooks/exhaustive-deps

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
    // Payloads cached before is_day was requested fall back to a fixed daytime window.
    const isDay = weather.hourly.is_day?.[index] ?? (date.getHours() >= 6 && date.getHours() < 19 ? 1 : 0)
    result.push({
      key: times[index],
      label: result.length === 0 ? 'Now' : date.toLocaleTimeString(undefined, { hour: 'numeric' }),
      temp: Math.round(weather.hourly.temperature_2m[index]),
      rain: weather.hourly.precipitation_probability?.[index] ?? null,
      icon: describeWeather(weather.hourly.weather_code[index], isDay).icon,
    })
  }
  return result
}

// The next `count` days after `today` from the daily forecast:
// [{ date, label: 'Thu', icon, condition, high, low, rainChance }]. Empty for a payload cached
// before daily weather codes were requested (the card then just leaves the row out).
export function dailyForecast(weather, count = 6, today = todayISO()) {
  const daily = weather?.daily
  const dates = Array.isArray(daily?.time) ? daily.time : []
  const codes = Array.isArray(daily?.weather_code) ? daily.weather_code : null
  if (!codes) return []
  const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null)
  const result = []
  for (let index = 0; index < dates.length && result.length < count; index += 1) {
    const date = dates[index]
    if (typeof date !== 'string' || date <= today) continue
    const high = round(daily.temperature_2m_max?.[index])
    const low = round(daily.temperature_2m_min?.[index])
    if (high === null && low === null) continue
    const condition = describeWeather(codes[index], 1)
    result.push({
      date,
      label: WEEKDAY_SHORT[weekdayIndex(date)],
      icon: condition.icon,
      condition: condition.label,
      high,
      low,
      rainChance: round(daily.precipitation_probability_max?.[index]),
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

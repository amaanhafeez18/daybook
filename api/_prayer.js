// Prayer times for a location and day from Aladhan (the same source the Today card uses, so the
// reminders match what the app shows). Cached in memory per day/location/method, so the every-minute
// reminder job asks the service about once a day per user while the function stays warm.
const CACHE = new Map()
const CACHE_MAX = 500

export const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']

const hhmm = (value) => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/)
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : ''
}

export function prayerRequestUrl({ lat, lon }, date, settings = {}) {
  const [year, month, day] = date.split('-')
  const method = settings.prayerMethod && settings.prayerMethod !== 'auto' ? `&method=${encodeURIComponent(settings.prayerMethod)}` : ''
  const school = Number(settings.prayerSchool || 0) === 1 ? 1 : 0
  return `https://api.aladhan.com/v1/timings/${day}-${month}-${year}?latitude=${Number(lat)}&longitude=${Number(lon)}${method}&school=${school}`
}

// → { date, method, asr, times24h: { Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha } } (HH:MM local to the location)
export async function fetchPrayerDay(location, date, settings = {}, { fetchImpl = fetch } = {}) {
  const lat = Number(location?.lat)
  const lon = Number(location?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Location unknown.')
  const key = `${date}|${lat.toFixed(3)},${lon.toFixed(3)}|${settings.prayerMethod || 'auto'}|${Number(settings.prayerSchool || 0)}`
  const cached = CACHE.get(key)
  if (cached) return cached
  const response = await fetchImpl(prayerRequestUrl({ lat, lon }, date, settings), { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
  if (!response.ok) throw new Error('The prayer times service is unavailable right now.')
  const payload = await response.json()
  const timings = payload?.data?.timings || {}
  const times24h = { Fajr: hhmm(timings.Fajr), Sunrise: hhmm(timings.Sunrise), Dhuhr: hhmm(timings.Dhuhr), Asr: hhmm(timings.Asr), Maghrib: hhmm(timings.Maghrib), Isha: hhmm(timings.Isha) }
  if (!times24h.Fajr || !times24h.Isha) throw new Error('The prayer times service gave no times.')
  const result = {
    date,
    method: payload?.data?.meta?.method?.name || 'Automatic',
    asr: Number(settings.prayerSchool || 0) === 1 ? 'Hanafi' : 'Standard',
    times24h,
  }
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
  CACHE.set(key, result)
  return result
}

// The user's saved location ({ lat, lon } in settings, synced from "Use my location" on Today), or null.
export function savedLocation(settings) {
  const location = settings?.location
  const lat = Number(location?.lat)
  const lon = Number(location?.lon)
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

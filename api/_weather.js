// The day's chance of rain for the morning summary (api/cron.js). Open-Meteo, no key needed. Cached
// in memory per location and day, so a warm function asks the service about once a day per user.
const CACHE = new Map() // key → { chance, until }
const CACHE_MAX = 500
const RETRY_MS = 10 * 60 * 1000 // a failed lookup isn't retried every minute while the summary is due

export function rainRequestUrl(lat, lon, date, timeZone) {
  const zone = typeof timeZone === 'string' && timeZone ? timeZone : 'auto'
  return `https://api.open-meteo.com/v1/forecast?latitude=${Number(lat)}&longitude=${Number(lon)}`
    + `&daily=precipitation_probability_max&timezone=${encodeURIComponent(zone)}&start_date=${date}&end_date=${date}`
}

function remember(key, chance, until) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
  CACHE.set(key, { chance, until })
  return chance
}

// → the highest chance of rain (0–100) on `date` (YYYY-MM-DD, local to the location), or null when
// unknown. Never throws: the summary goes out without weather instead. Gives up after 2 s.
export async function fetchRainChance(lat, lon, date, timeZone, { fetchImpl = fetch, now = Date.now() } = {}) {
  const latitude = Number(lat)
  const longitude = Number(lon)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  const key = `${date}|${latitude.toFixed(2)},${longitude.toFixed(2)}`
  const cached = CACHE.get(key)
  if (cached && cached.until > now) return cached.chance
  try {
    const response = await fetchImpl(rainRequestUrl(latitude, longitude, date, timeZone), { signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined })
    if (!response.ok) return remember(key, null, now + RETRY_MS)
    const payload = await response.json()
    const raw = payload?.daily?.precipitation_probability_max?.[0]
    const value = raw == null ? NaN : Number(raw)
    if (!Number.isFinite(value)) return remember(key, null, now + RETRY_MS)
    return remember(key, Math.min(100, Math.max(0, Math.round(value))), Infinity)
  } catch {
    return remember(key, null, now + RETRY_MS)
  }
}

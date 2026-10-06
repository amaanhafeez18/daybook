// Pure helpers for the location weather and prayer times use: the one saved with the account
// (settings.location), a city chosen by hand, and the city search. No browser or React code (it's
// part of the main bundle through lib/environment.js, and tests/setup.test.mjs checks it).

const DAY_MS = 24 * 60 * 60 * 1000
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// settings.location as numbers ({ lat, lon } plus name/manual/at when known), or null. The same
// test as api/_prayer.js savedLocation(), which reads only lat and lon.
export function savedCoords(settings) {
  const location = settings?.location
  if (!isObject(location)) return null
  const lat = Number(location.lat)
  const lon = Number(location.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const out = { lat, lon }
  if (typeof location.name === 'string' && location.name.trim()) out.name = location.name.trim()
  if (location.manual === true) out.manual = true
  if (Number.isFinite(Number(location.at)) && Number(location.at) > 0) out.at = Number(location.at)
  return out
}

// Whether a position from the device should replace the saved one: always when the user asked for
// it (`force`, a tap on "Use my location"); otherwise only a real move, and never over a city
// chosen by hand (manual), which GPS refreshes on launch don't overwrite.
export function shouldSaveLocation(saved, next, { force = false } = {}) {
  if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return false
  if (!saved || force) return true
  if (saved.manual) return false
  return Math.abs(saved.lat - next.lat) >= 0.01 || Math.abs(saved.lon - next.lon) >= 0.01
}

// "Updated just now" / "today" / "yesterday" / "3 days ago" for a saved position.
export function updatedLabel(at, now = Date.now()) {
  const stamp = Number(at)
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const ms = Math.max(0, now - stamp)
  if (ms < 60 * 60 * 1000) return 'Updated just now'
  const days = Math.floor(ms / DAY_MS)
  if (days < 1) return 'Updated today'
  if (days === 1) return 'Updated yesterday'
  return `Updated ${days} days ago`
}

// ---- choose a city (Open-Meteo geocoding, free, no key) ----------------------------------------

export function geocodeUrl(query) {
  const name = String(query || '').trim().slice(0, 80)
  if (name.length < 2) return ''
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`
}

// The API's results as [{ id, name, label: 'Lahore, Punjab, Pakistan', lat, lon }] (3 decimals,
// like a device position), skipping anything without usable coordinates.
export function cityResults(payload) {
  const round = (value) => Math.round(value * 1000) / 1000
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results.flatMap((item, index) => {
    const lat = Number(item?.latitude)
    const lon = Number(item?.longitude)
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return []
    const parts = [name, item.admin1, item.country].filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim())
    const label = parts.filter((part, i) => parts.indexOf(part) === i).join(', ')
    return [{ id: String(item.id ?? `${index}-${lat},${lon}`), name, label, lat: round(lat), lon: round(lon) }]
  })
}

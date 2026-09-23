// Unit conversion and formatting. Storage is always kg, metres and seconds; only display converts.
// Pure module with zero imports.

export const LB = 0.45359237

const METERS = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144 }

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function toKg(value, unit) {
  const n = finite(value)
  if (n === null) return null
  return unit === 'lb' ? n * LB : n
}

export function fromKg(kg, unit) {
  const n = finite(kg)
  if (n === null) return null
  return unit === 'lb' ? n / LB : n
}

// Rounds half away from zero; the tiny nudge keeps 1.005 → 1.01 despite binary floats.
function roundTo(n, dp) {
  const factor = 10 ** dp
  const rounded = Math.round(Math.abs(n) * factor * (1 + 1e-12)) / factor
  return n < 0 && rounded !== 0 ? -rounded : rounded
}

// Up to `dp` decimals, trailing zeros trimmed, no grouping: 45, 102.5, 0.25.
export function formatNumber(n, dp = 2) {
  const value = finite(n)
  if (value === null) return '—'
  const places = Number.isInteger(dp) && dp >= 0 ? Math.min(dp, 10) : 2
  return String(roundTo(value, places))
}

export function formatWeight(kg, unit, options = {}) {
  const value = fromKg(kg, unit)
  if (value === null) return '—'
  const text = formatNumber(value, 2)
  return options?.withUnit === false ? text : `${text} ${unit === 'lb' ? 'lb' : 'kg'}`
}

// Accepts '12.5', '12,5', ' 7 ', '.5'; '' or anything else → null.
export function parseDecimal(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null
  if (typeof text !== 'string') return null
  const clean = text.trim().replace(',', '.')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(clean)) return null
  return Number(clean)
}

// 65 → '1:05', 3723 → '1:02:03'.
export function formatDuration(sec) {
  const value = finite(sec)
  if (value === null) return '—'
  const total = Math.max(0, Math.round(value))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// 'm:ss', 'h:mm:ss' or plain seconds ('90', '45.5') → whole seconds, else null.
export function parseDuration(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.round(text) : null
  if (typeof text !== 'string') return null
  const clean = text.trim()
  if (!clean) return null
  if (/^\d+(?:[.,]\d+)?$/.test(clean)) return Math.round(Number(clean.replace(',', '.')))
  const parts = clean.match(/^(\d+):(\d+)(?::(\d+))?$/)
  if (!parts) return null
  const [a, b, c] = parts.slice(1).map((part) => (part === undefined ? null : Number(part)))
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c
}

export function toMeters(value, unit) {
  const n = finite(value)
  if (n === null) return null
  return n * (METERS[unit] ?? 1)
}

export function fromMeters(m, unit) {
  const n = finite(m)
  if (n === null) return null
  return n / (METERS[unit] ?? 1)
}

export function formatDistance(m, unit) {
  const value = fromMeters(m, unit)
  if (value === null) return '—'
  return `${formatNumber(value, 2)} ${METERS[unit] ? unit : 'm'}`
}

// Seconds per km → '5:30 /km', or per mile when the distance unit is imperial.
export function formatPace(secPerKm, distanceUnit) {
  const value = finite(secPerKm)
  if (value === null || value <= 0) return '—'
  const imperial = distanceUnit === 'mi' || distanceUnit === 'yd'
  return `${formatDuration(imperial ? value * (METERS.mi / 1000) : value)} /${imperial ? 'mi' : 'km'}`
}

let volumeFormatter = null

// '12,450 kg': whole numbers with the viewer's locale grouping.
export function formatVolume(kg, unit) {
  const value = fromKg(kg, unit)
  if (value === null) return '—'
  if (!volumeFormatter) volumeFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  return `${volumeFormatter.format(Math.round(value) || 0)} ${unit === 'lb' ? 'lb' : 'kg'}`
}

// Progress photos (Gym → Progress): private photos kept as attachments with targetType 'progress'
// and targetId = the day they're for ('2026-10-21'). Pure helpers (no browser or React code).
import { diffDays } from './dates.js'

export const PHOTO_TARGET = 'progress'
// A photo every 4 weeks or so: after that the card offers another one.
export const PHOTO_EVERY_DAYS = 28

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

// The progress photos in the attachments list, oldest first (by their day, then when added).
export function progressPhotos(attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments
    .filter((item) => item && item.targetType === PHOTO_TARGET && item.kind !== 'pdf' && isDate(item.targetId))
    .sort((a, b) => a.targetId.localeCompare(b.targetId) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
}

// { days } when the newest photo is PHOTO_EVERY_DAYS or more old; null otherwise (and with none:
// the empty card already asks).
export function photoNudge(photos, today, every = PHOTO_EVERY_DAYS) {
  const last = photos?.[photos.length - 1]
  if (!last || !isDate(today)) return null
  const days = diffDays(last.targetId, today)
  return days >= every ? { days } : null
}

// The body weight (kg) logged closest to `date`, within maxDays either side; null without one.
export function weightNear(bodyWeights, date, maxDays = 3) {
  if (!Array.isArray(bodyWeights) || !isDate(date)) return null
  let best = null
  for (const entry of bodyWeights) {
    if (!entry || !isDate(entry.date) || !Number.isFinite(entry.kg)) continue
    const gap = Math.abs(diffDays(entry.date, date))
    if (gap > maxDays) continue
    if (!best || gap < best.gap || (gap === best.gap && entry.date > best.date)) best = { gap, date: entry.date, kg: entry.kg }
  }
  return best ? best.kg : null
}

// 'Same day', '1 day apart', '5 weeks apart', '4 months apart', '1 year apart'.
export function apartText(fromDate, toDate) {
  const days = Math.abs(diffDays(fromDate, toDate))
  if (!days) return 'Same day'
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} apart`
  if (days < 14) return unit(days, 'day')
  if (days < 63) return unit(Math.round(days / 7), 'week')
  if (days < 365) return unit(Math.round(days / 30.44), 'month')
  return unit(Math.round((days / 365.25) * 10) / 10, 'year')
}

// 'Time for another' wording: '5 weeks ago', '2 months ago'.
export function agoText(days) {
  if (days < 14) return `${days} days ago`
  if (days < 63) return `${Math.round(days / 7)} weeks ago`
  const months = Math.round(days / 30.44)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

// The pair a comparison opens with: the first photo and the newest.
export function defaultPair(photos) {
  if (!Array.isArray(photos) || photos.length < 2) return null
  return [photos[0].id, photos[photos.length - 1].id]
}

// Quiet updates (src/main.jsx): a new version is applied without asking when nobody would notice,
// at launch or when coming back to the app after a while, before the first tap, and only when
// nothing could be lost. Otherwise the "Update" toast offers it as before. The reload lands on the
// same screen at the same scroll. Pure rules here, so they can be tested.

export const QUIET_AWAY_MS = 10 * 60 * 1000 // back after at least this long away
export const QUIET_WINDOW_MS = 3000 // ...or at launch: this long, until the first tap or key
export const SCROLL_KEY = 'daybook.update.scroll'
export const WORKOUT_KEY = 'daybook.gym.active' // lib/gym/state.js ACTIVE_KEY (read here directly so
// the entry bundle doesn't load the gym code)

// Whether a return to the app opens a quiet window: it was hidden long enough.
export function awayLongEnough(hiddenAt, now) {
  return hiddenAt > 0 && now - hiddenAt >= QUIET_AWAY_MS
}

// Whether a waiting update may be applied right now without asking. `typed` = text or photos left in
// a field that isn't focused (a half-typed message lives only in memory), `replying` = the assistant
// is still writing a reply, `inCall` = a voice chat is open (a reload would cut it off).
export function canUpdateQuietly({ inWindow, waiting, unsaved, sheetOpen, typing, workoutActive, typed = false, replying = false, inCall = false }) {
  return !!inWindow && !!waiting && !unsaved && !sheetOpen && !typing && !workoutActive && !typed && !replying && !inCall
}

// Whether a field holds text someone typed and a reload would lose: a non-empty textarea or text-like
// input that can be edited. Search boxes, dates and numbers don't count, nor fields inside
// [data-autosave] (they save themselves when the app is hidden). Works on plain objects for tests.
export function holdsTypedText(field) {
  if (!field || field.readOnly || field.disabled) return false
  const tag = String(field.tagName || '').toUpperCase()
  const texty = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(?:text|email|url|tel)$/.test(field.type || 'text'))
  if (!texty) return false
  if (typeof field.closest === 'function' && field.closest('[data-autosave]')) return false
  return String(field.value || '').trim() !== ''
}

// What to keep across the reload, and whether a saved one still applies (same screen, recent).
export function scrollMemo(y, hash, now) {
  return { y: Math.max(0, Math.round(y || 0)), hash: hash || '', at: now }
}
export function scrollToRestore(memo, hash, now) {
  if (!memo || typeof memo !== 'object' || !(memo.y > 0)) return null
  if ((memo.hash || '') !== (hash || '')) return null
  if (!(now - memo.at >= 0 && now - memo.at < 60000)) return null
  return memo.y
}

// Whether the stored active workout says one is running (any non-empty value but null).
export function workoutRunning(raw) {
  if (!raw) return false
  try {
    return JSON.parse(raw) != null
  } catch {
    return true // unreadable: assume it matters
  }
}

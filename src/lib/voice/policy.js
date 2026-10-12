// Voice chat rules with no I/O: the echo check, the caps and timers, and the headphone guess.
// Pure (no imports, no browser code), so node --test runs it (tests/voice-client.test.mjs).

export const WARN_LEFT_SEC = 60 // "1 min left" before the call's limit
export const SILENCE_WARN_SEC = 15 // "Still there?" this long before hanging up
export const BUDGET_WARN = 0.8 // the one-time "80% of this month's budget" bar
export const ECHO_MIN_WORDS = 3
export const ECHO_THRESHOLD = 0.6
export const ECHO_WINDOW_WORDS = 30
export const HOLD_MIN_MS = 300 // a shorter press is a tap: "Hold while you talk"
export const HOLD_TAIL_MS = 250 // keep listening this long after the release (the last word)
export const HOLD_SLIDE_PX = 80 // sliding this far off the button cancels the hold

const HEADPHONES = /airpods|headphone|headset|earbud|buds|beats|bluetooth|hands-?free/i

// Where the sound goes, from the mic's label: 'headphones' when it's a headset, else the phone's
// speaker (touch devices) or a computer's.
export function routeFromLabel(label = '', { touch = true } = {}) {
  if (HEADPHONES.test(String(label || ''))) return 'headphones'
  return touch ? 'speaker' : 'desktop'
}

const words = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9'\s]/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

// How much a heard turn looks like Daybook's own voice picked up by the mic: the best word-set
// Jaccard between the heard words and a stretch of Daybook's last 30 words about as long (an echo is
// usually a piece of what was said, so the whole 30 would dilute it). 0..1.
export function echoScore(heard, assistantWords) {
  const said = (Array.isArray(assistantWords) ? assistantWords.join(' ') : String(assistantWords || ''))
  const recent = words(said).slice(-ECHO_WINDOW_WORDS)
  const user = words(heard)
  if (!user.length || !recent.length) return 0
  const target = new Set(user)
  let best = 0
  // One word shorter only for longer turns: "yes add it" after "Should I add it?" is an answer.
  const sizes = user.length >= 6 ? [user.length - 1, user.length, user.length + 1] : [user.length, user.length + 1]
  for (const size of sizes) {
    if (size >= recent.length) {
      best = Math.max(best, jaccard(target, new Set(recent)))
      continue
    }
    for (let start = 0; start + size <= recent.length; start += 1) {
      best = Math.max(best, jaccard(target, new Set(recent.slice(start, start + size))))
      if (best >= 1) return 1
    }
  }
  return best
}

// Whether a finished user transcript is Daybook hearing itself (open mic on the speaker).
export function isEcho(heard, assistantWords, { minWords = ECHO_MIN_WORDS, threshold = ECHO_THRESHOLD } = {}) {
  if (words(heard).length < minWords) return false
  return echoScore(heard, assistantWords) >= threshold
}

// The caps, checked every second. All times in seconds.
//   elapsedSec    this realtime session's time so far
//   sessionSec    its limit from the server (already min(call length, today's minutes left))
//   dailyLeftSec  today's voice minutes left as of `dailyAt` seconds into the session (checkpoints
//                 refresh it: another device may have used some); Infinity when not tracked
//   spentUsd      this month's AI spend including this call; budgetUsd 0 = no budget
//   idleSec       time with nothing happening; `busy` (speech, Daybook talking, a tool running, the
//                 keyboard open) holds the silence timer
// → { end: null|'budget'|'daily'|'cap'|'quiet', leftSec, daily (the daily cap is the closer one),
//     warnTime, warnBudget, warnSilence, budgetPct, idleLeftSec }
export function capCheck({
  elapsedSec = 0, sessionSec = Infinity, dailyLeftSec = Infinity, dailyAt = 0,
  spentUsd = 0, budgetUsd = 0, idleSec = 0, silenceSec = 60, busy = false,
} = {}) {
  const num = (value, fallback) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback)
  const elapsed = Math.max(0, num(elapsedSec, 0))
  const sessionLeft = num(sessionSec, Infinity) - elapsed
  const dailyLeft = num(dailyLeftSec, Infinity) - Math.max(0, elapsed - num(dailyAt, 0))
  const leftSec = Math.min(sessionLeft, dailyLeft)
  const daily = dailyLeft <= sessionLeft
  const budget = num(budgetUsd, 0)
  const budgetPct = budget > 0 ? Math.max(0, num(spentUsd, 0)) / budget : 0
  const silence = Math.max(1, num(silenceSec, 60))
  const idle = busy ? 0 : Math.max(0, num(idleSec, 0))
  const idleLeftSec = silence - idle
  let end = null
  if (budget > 0 && budgetPct >= 1) end = 'budget'
  else if (leftSec <= 0) end = daily ? 'daily' : 'cap'
  else if (idleLeftSec <= 0) end = 'quiet'
  return {
    end,
    leftSec: Math.max(0, Math.ceil(leftSec)),
    daily,
    warnTime: !end && leftSec <= WARN_LEFT_SEC,
    warnBudget: budget > 0 && budgetPct >= BUDGET_WARN,
    warnSilence: !end && idleLeftSec <= SILENCE_WARN_SEC,
    budgetPct,
    idleLeftSec: Math.max(0, Math.ceil(idleLeftSec)),
  }
}

// Whether a voice chat that ended this way can go on (a new segment), given what's left.
export const CONTINUE_ENDS = new Set(['cap', 'quiet', 'background', 'network', 'interrupted', 'navigated'])
export function canContinue(end, { dailyLeftSec = Infinity, budgetPct = 0 } = {}) {
  return CONTINUE_ENDS.has(end) && !(Number(dailyLeftSec) < 60) && !(Number(budgetPct) >= 1)
}

// "4:12" from seconds.
export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = String(total % 60).padStart(2, '0')
  if (minutes < 60) return `${minutes}:${rest}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
}

// A new voice chat id (server: /^talk_[a-z0-9]{8,32}$/).
export function newTalkId(random = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let index = 0; index < 16; index += 1) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  return `talk_${id}`
}

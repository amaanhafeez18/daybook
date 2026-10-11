// A light tap you can feel (iPhone with iOS 18+, Android). Call it only inside a tap's own handler
// (click or pointerup): both platforms ignore it anywhere else. Where it isn't supported it does
// nothing, so callers never need to check.
//
//   haptic()            ticking a task, flipping a switch, dropping a dragged item
//   haptic('success')   a bigger moment (day done, a new PR)
//   haptic('warning')   something was turned down
//
// Android has navigator.vibrate. iOS has no vibration API, but tapping a native switch control
// (<input type=checkbox switch>, Safari 18) gives the system's light tick, so a hidden one is kept
// on the page and clicked (one tick for every kind: a second click outside the tap wouldn't count).
import { isTyping } from './keyboard.js'

const PATTERNS = { light: 10, success: [10, 50, 10], warning: [10, 50, 10] }

let label = null
let lastTick = 0
// One tick per tap: a Checkbox's light tick and the caller's own 'success' in the same handler
// would otherwise click the switch twice (Android's vibrate just replaces the pattern).
const TICK_GAP_MS = 80

// The hidden switch, made on first use. Not display:none (iOS doesn't tick for an unrendered control):
// transparent, 1px, fixed and untouchable instead. Its clicks stop at the label, so outside-click
// closers on document (menus, the assistant's ⋯ dropdown) never see them.
function switchLabel() {
  if (label?.isConnected) return label
  label = document.createElement('label')
  label.setAttribute('aria-hidden', 'true')
  label.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.tabIndex = -1
  label.appendChild(input)
  label.addEventListener('click', (event) => event.stopPropagation())
  document.body.appendChild(label)
  return label
}

export function canSwitchHaptic() {
  return typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype
}

export function haptic(kind = 'light') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  try {
    const active = document.activeElement
    // Clicking anything while a field has focus can close the keyboard.
    if (isTyping(active)) return
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERNS[kind] ?? PATTERNS.light)
      return
    }
    if (!canSwitchHaptic() || !document.body) return
    const now = Date.now()
    if (now - lastTick < TICK_GAP_MS) return
    lastTick = now
    switchLabel().click()
    // Clicking a label can move focus to its control: put it back where it was.
    if (document.activeElement !== active) {
      if (active && active !== document.body) active.focus?.({ preventScroll: true })
      else document.activeElement?.blur?.()
    }
  } catch {
    // never let a nicety break the tap that called it
  }
}

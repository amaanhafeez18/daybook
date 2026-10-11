import { useEffect, useReducer, useRef } from 'react'
import { prefersReducedMotion } from './motion.js'

// A number that counts to its new value (calories left after logging, a ring's total) instead of
// jumping. A rAF tween with ease-out, landing exactly on the new value.
//   const shown = useAnimatedNumber(caloriesLeft)
//   <span aria-label={`${caloriesLeft} kcal left`}>{Math.round(shown)}</span>
// The first render shows the value as it is (nothing counts up on open), and so does Reduce Motion,
// a hidden tab, or anything that isn't a finite number (null, '' or '—' pass straight through).
// While it moves it keeps the decimals of the numbers involved (72.5 → 73.25 steps in hundredths,
// 1800 → 1650 in whole numbers), so it can go straight into the same formatting. Screen readers
// should get the final value (aria-label), never the frames.

export const easeOutCubic = (p) => 1 - (1 - p) ** 3

function decimals(value) {
  const text = String(value)
  const dot = text.indexOf('.')
  return dot === -1 || /e/i.test(text) ? 0 : Math.min(3, text.length - dot - 1)
}

// The value `progress` (0..1) of the way from `from` to `to`, eased and rounded to the decimals
// of either end; exactly `to` at the end.
export function tweenValue(from, to, progress) {
  if (progress >= 1) return to
  if (progress <= 0) return from
  const raw = from + (to - from) * easeOutCubic(progress)
  const factor = 10 ** Math.max(decimals(from), decimals(to))
  return Math.round(raw * factor) / factor
}

const animatable = (from, to) => typeof from === 'number' && typeof to === 'number'
  && Number.isFinite(from) && Number.isFinite(to) && from !== to

export function useAnimatedNumber(value, { ms = 450 } = {}) {
  const [, redraw] = useReducer((count) => count + 1, 0)
  const shown = useRef(value) // what is on screen now
  const target = useRef(value)
  // A new value: unless it can count there, show it straight away (in this render, no flash of the
  // old one). Otherwise this render still shows where it is, and the effect starts the count.
  if (target.current !== value) {
    target.current = value
    const still = prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden)
    if (still || !animatable(shown.current, value) || !(ms > 0)) shown.current = value
  }

  useEffect(() => {
    const from = shown.current
    if (!animatable(from, value)) return undefined
    let frame = 0
    let start = 0
    const step = (now) => {
      if (!start) start = now
      const progress = Math.min(1, (now - start) / ms)
      shown.current = tweenValue(from, value, progress)
      redraw()
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    // Interrupted by a newer value: it counts on from wherever it got to.
    return () => cancelAnimationFrame(frame)
  }, [value, ms])

  return shown.current
}

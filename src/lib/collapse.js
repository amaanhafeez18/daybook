import { prefersReducedMotion } from './motion.js'

// Folds an element away: its height, vertical padding and margins go to 0 while it fades, so the
// rows below close the gap smoothly. Resolves when done (at once under Reduce Motion, without
// WAAPI, or for a detached element). The element stays folded (fill: forwards) until it's removed;
// to bring it back, cancel its animations (el.getAnimations().forEach((a) => a.cancel())).
const FALLBACK_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

function easing() {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim()
    return /^cubic-bezier\(|^ease|^linear$/.test(value) ? value : FALLBACK_EASE
  } catch {
    return FALLBACK_EASE
  }
}

export function collapseOut(el, { ms = 260 } = {}) {
  if (!el || !el.isConnected || typeof el.animate !== 'function' || prefersReducedMotion()) return Promise.resolve()
  const style = getComputedStyle(el)
  const from = {
    height: `${el.offsetHeight}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: style.opacity,
  }
  const to = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }
  el.style.overflow = 'hidden'
  el.style.boxSizing = 'border-box'
  let animation
  try {
    animation = el.animate([from, to], { duration: ms, easing: easing(), fill: 'forwards' })
  } catch {
    return Promise.resolve()
  }
  // A hidden tab can hold the animation back: never wait much longer than it should take.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms + 150)
    animation.finished.then(() => {
      clearTimeout(timer)
      resolve()
    }, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// Undoes collapseOut on an element that's staying after all.
export function restoreCollapsed(el) {
  if (!el) return
  try {
    for (const animation of el.getAnimations?.() || []) {
      if (animation.effect?.getKeyframes?.().some((frame) => frame.height === '0px')) animation.cancel()
    }
  } catch {
    // best effort
  }
  el.style.removeProperty('overflow')
  el.style.removeProperty('box-sizing')
}

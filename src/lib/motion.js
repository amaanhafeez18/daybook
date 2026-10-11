// Reduce Motion, in one place. CSS handles it with @media (prefers-reduced-motion: reduce); this is
// for the motion started from JS (smooth scrolls, timed exits). Safe to call outside a browser.

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// For scrollTo / scrollIntoView: `{ behavior: scrollBehavior() }` jumps instead of gliding when the
// user asked for less motion.
export const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth')

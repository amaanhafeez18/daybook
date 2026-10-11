// Reduce Motion, in one place. CSS handles it with @media (prefers-reduced-motion: reduce); this is
// for the motion started from JS (smooth scrolls, timed exits). Safe to call outside a browser.

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// For scrollTo / scrollIntoView: `{ behavior: scrollBehavior() }` jumps instead of gliding when the
// user asked for less motion.
export const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth')

// Only rows that were just added play their entrance ('rise' on .task-row.is-new, .agenda-item.is-new,
// .msg.is-new in App.css), so coming back to a tab or paging days doesn't replay every row. A record
// counts as new for `ms` after its createdAt (a little either way, for clocks that disagree).
export function freshClass(record, ms = 1500, now = Date.now()) {
  const created = typeof record?.createdAt === 'string' ? Date.parse(record.createdAt) : NaN
  if (!Number.isFinite(created)) return ''
  const age = now - created
  return age < ms && age > -ms ? 'is-new' : ''
}

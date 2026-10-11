import { flushSync } from 'react-dom'
import { prefersReducedMotion } from './motion.js'

// Hash routes (#/tasks) keep the browser/Android back button working and allow deep links.
// One hashchange listener for the whole app: it stamps each history entry's depth (for goBack),
// works out how the move should look (classify) and then tells the subscribers (subscribeRoute),
// inside a View Transition when the device has them and the move is a push, pop, slide up/down or
// crossfade. Tab switches stay instant.

// `transition: 'fade'` crossfades this one move (the Plan | Health pill).
let nextKind = null
export function navigate(route, { transition } = {}) {
  if (window.location.hash === `#/${route}`) return
  nextKind = transition || null
  window.location.hash = `/${route}`
}

// ---- history depth ----------------------------------------------------------------------------
// The home-screen app has no browser back button, so detail views have their own. It goes back
// only when there is an in-app entry behind this one; otherwise it opens the fallback view.
// Each entry's depth is stamped into history.state (0 = where the app started), so it survives
// reloads and tells back/forward apart from new navigation.

const DEPTH_KEY = 'daybookDepth'
let depth = 0

function readDepth() {
  const state = window.history.state
  return state && typeof state === 'object' && Number.isInteger(state[DEPTH_KEY]) ? state[DEPTH_KEY] : null
}

function stampDepth(value) {
  depth = value
  try {
    const state = window.history.state
    window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), [DEPTH_KEY]: value }, '')
  } catch {
    // replaceState can be rate-limited; the in-memory depth still works
  }
}

export function goBack(fallback = 'gym') {
  if (depth > 0 && window.history.length > 1) window.history.back()
  else navigate(fallback)
}

// ---- how a move looks -------------------------------------------------------------------------

// The live workout and the routine editor are 'focus mode' (App.jsx hides the bars there).
export const FOCUS_HASH = /^#\/?gym\/(?:workout|routine)(?:[/?]|$)/

const GYM_TABS = new Set(['', 'today', 'calendar', 'routines', 'history', 'settings'])
const GYM_DETAILS = new Set(['workout', 'session', 'routine', 'exercise', 'stats', 'visuals'])
const FOOD_DETAILS = new Set(['insights', 'weight', 'goals', 'foods'])

// '#/gym/exercise/12?x' → { page: 'gym', view: 'exercise', param: '12' }
export function parseNavHash(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  return { page: parts[0] || '', view: parts[1] || '', param: parts.slice(2).join('/') }
}

// How deep a view sits inside its page, matching GymPage's viewLevel and FoodPage's scroll memory:
// gym tabs 0, the exercise library 1, details 2; food today 0, its other screens 1, a day opened
// from Insights 2. Unknown gym views show the Today tab, so they're 0 too.
export function navLevel({ page, view, param }) {
  if (page === 'gym') return GYM_TABS.has(view) ? 0 : view === 'exercises' ? 1 : GYM_DETAILS.has(view) ? 2 : 0
  if (page === 'food') {
    if (FOOD_DETAILS.has(view)) return 1
    return view === 'day' && param ? 2 : 0
  }
  return 0
}

// Views that page through days or weeks in place (food day, food insights): moving between them
// keeps the same view, so it never slides.
const sameView = (a, b) => a.page === b.page && (a.view || 'day') === (b.view || 'day')

// 'push' | 'pop' | 'up' | 'down' | 'none'. `direction` is how history moved: 'back' (a known
// entry nearer the start), 'forward', 'new' (a new entry, or location.replace) or 'same' (the
// same entry, e.g. a replaced routine id).
export function classify(from, to, direction = 'new') {
  if (from === to) return 'none'
  const fromFocus = FOCUS_HASH.test(from)
  const toFocus = FOCUS_HASH.test(to)
  if (toFocus !== fromFocus) return toFocus ? 'up' : 'down'
  if (toFocus) return 'none'
  const a = parseNavHash(from)
  const b = parseNavHash(to)
  if (a.page !== b.page || !a.page) return 'none' // another tab
  if (sameView(a, b)) {
    // Another exercise or session from a detail view; paging days and weeks stays still.
    if (a.view === b.view && GYM_DETAILS.has(a.view) && a.page === 'gym' && a.param !== b.param && direction !== 'same') {
      return direction === 'back' ? 'pop' : 'push'
    }
    return 'none'
  }
  const levelA = navLevel(a)
  const levelB = navLevel(b)
  if (levelA === 0 && levelB === 0) return 'none' // gym tabs
  if (direction === 'back') return 'pop'
  if (direction === 'same') return 'none'
  return levelB >= levelA ? 'push' : 'pop'
}

// ---- dispatch ---------------------------------------------------------------------------------

const listeners = new Set()
let lastHash = typeof window !== 'undefined' ? window.location.hash : ''
let navToken = 0

function canTransition() {
  const root = document.documentElement
  return typeof document.startViewTransition === 'function'
    && !prefersReducedMotion()
    && document.visibilityState === 'visible'
    && !root.classList.contains('has-sheet')
}

function hashOf(url) {
  if (typeof url !== 'string') return null
  const index = url.indexOf('#')
  return index === -1 ? '' : url.slice(index)
}

function onHashChange(event) {
  // Depth first, so the move's direction is known.
  const previous = depth
  const known = readDepth()
  let direction
  if (known === null) {
    stampDepth(depth + 1)
    direction = 'new'
  } else {
    depth = known
    direction = known < previous ? 'back' : known > previous ? 'forward' : 'same'
  }

  const from = hashOf(event?.oldURL) ?? lastHash
  const to = window.location.hash
  lastHash = to
  const hinted = nextKind
  nextKind = null
  const kind = hinted || classify(from, to, direction)
  const detail = { from, to, kind, direction }
  // A copy: pages that mount during this update subscribe, and read the hash themselves. One that
  // throws doesn't stop the others (each used to be its own hashchange listener).
  const run = () => {
    for (const listener of [...listeners]) {
      try {
        listener(detail)
      } catch (error) {
        console.error(error)
      }
    }
  }

  if (kind === 'none' || !canTransition()) {
    run()
    return
  }
  const root = document.documentElement
  const token = ++navToken
  root.dataset.nav = kind
  const clear = () => {
    if (token === navToken) delete root.dataset.nav
  }
  try {
    const transition = document.startViewTransition(() => flushSync(run))
    transition.ready.catch(() => {}) // skipped by the next move: not an error
    transition.finished.then(clear, clear)
  } catch {
    clear()
    run()
  }
}

if (typeof window !== 'undefined') {
  const initial = readDepth()
  if (initial === null) stampDepth(0)
  else depth = initial
  window.addEventListener('hashchange', onHashChange)
}

// fn({ from, to, kind, direction }) after every hash change; returns the unsubscribe.
export function subscribeRoute(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

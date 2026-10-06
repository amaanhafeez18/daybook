// The on-screen keyboard (phones). iOS doesn't resize the page for it: it only shrinks the visual
// viewport, so a sheet fixed to the bottom ends up behind it. While anything watches (an open sheet,
// a visible toast), <html> gets --kb (the keyboard's height), --vvh (the visible height) and the
// class kb-open while a keyboard is up; shell.css moves sheets and toasts above it.

const KEYBOARD_MIN_PX = 80 // smaller changes are browser toolbars, not a keyboard
const TEXT_INPUTS = /^(?:text|search|email|url|tel|password|number|date|time|datetime-local|month|week)$/

// The keyboard's height in px (0 when there's none), from the layout viewport's height and the
// visual viewport's height, offset (iOS pans it to show the field) and zoom.
export function keyboardInset({ layoutHeight, height, offsetTop = 0, scale = 1 }) {
  if (!(layoutHeight > 0) || !(height > 0)) return 0
  if (Math.abs(scale - 1) > 0.01) return 0 // pinch-zoomed: the smaller viewport isn't a keyboard
  const covered = Math.round(layoutHeight - height - offsetTop)
  return covered >= KEYBOARD_MIN_PX ? covered : 0
}

// How far to scroll a container (px, positive = down) so that `field` shows inside `box` with
// `margin` to spare. Both are { top, bottom } in the same coordinates; a field taller than the
// room shows its top.
export function revealOffset(field, box, margin = 16) {
  const room = box.bottom - box.top - margin * 2
  if (field.bottom - field.top > room || field.top < box.top + margin) return Math.round(field.top - box.top - margin)
  if (field.bottom > box.bottom - margin) return Math.round(field.bottom - box.bottom + margin)
  return 0
}

// Whether the focused element brings up a keyboard (or iOS's picker, which takes the same room).
export function isTyping(element) {
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && TEXT_INPUTS.test(element.type || 'text')
}

// Scrolls the focused field into view inside its sheet's scrolling body (if it's in `container`).
export function revealFocused(container) {
  const field = document.activeElement
  if (!container || !isTyping(field) || !container.contains(field)) return
  const body = field.closest('.sheet-body')
  if (!body) return
  const delta = revealOffset(field.getBoundingClientRect(), body.getBoundingClientRect())
  if (delta) body.scrollTop += delta
}

const watchers = new Set()
let stopWatching = null

// Starts following the keyboard (shared by every caller); `onChange(kb)` runs after each update.
// Returns the function that stops this caller's watch; the last one out clears the variables.
export function watchKeyboard(onChange) {
  if (typeof window === 'undefined' || !window.visualViewport) return () => {}
  const watcher = { onChange }
  watchers.add(watcher)
  if (!stopWatching) stopWatching = startWatching()
  return () => {
    if (!watchers.delete(watcher) || watchers.size) return
    stopWatching?.()
    stopWatching = null
  }
}

function startWatching() {
  const viewport = window.visualViewport
  const root = document.documentElement
  let frame = 0
  let shown = ''
  const update = () => {
    frame = 0
    const kb = isTyping(document.activeElement)
      ? keyboardInset({ layoutHeight: window.innerHeight, height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale })
      : 0
    const vvh = Math.round(viewport.height)
    // Written only when something changed: each write restyles the whole page.
    if (shown !== `${kb}/${vvh}`) {
      shown = `${kb}/${vvh}`
      root.style.setProperty('--kb', `${kb}px`)
      root.style.setProperty('--vvh', `${vvh}px`)
      root.classList.toggle('kb-open', kb > 0)
    }
    for (const watcher of watchers) watcher.onChange?.(kb)
  }
  // Once per frame: moving between fields is a focusout and a focusin, which mustn't flicker.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  update()
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
  return () => {
    cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    document.removeEventListener('focusin', schedule)
    document.removeEventListener('focusout', schedule)
    root.style.removeProperty('--kb')
    root.style.removeProperty('--vvh')
    root.classList.remove('kb-open')
  }
}

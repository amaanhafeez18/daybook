import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'
import { focusBeforePrime, isTyping, revealFocused, watchKeyboard } from '../../lib/keyboard.js'
import { prefersReducedMotion } from '../../lib/motion.js'
import { NO_SHEET_DRAG, contentDragIntent } from './sheetDrag.js'
import '../shell.css'

// How long a closing sheet stays mounted is read from its exit animation in the CSS (App.css:
// sheet-down on phones, dialog-out on desktop; apple.css may retime them), so the two can't drift
// apart. EXIT_MS is only the fallback when no duration can be read; EXIT_MAX_MS caps a bad value.
const EXIT_MS = 180
const EXIT_MAX_MS = 600
let openSheets = 0
// Open sheets in stacking order; only the topmost one handles Escape and traps Tab.
const sheetStack = []
const handledEscapes = new WeakSet()

// Drag to close (phones, where sheets are bottom sheets: App.css switches to dialogs at 640px).
const PHONE_QUERY = '(max-width: 639px)'
const DRAG_SLOP_PX = 6 // movement before a press on the handle/header counts as a drag
const DRAG_CLOSE_PX = 100 // released this far down, the sheet closes
const FLICK_PX_PER_MS = 0.5 // ...or sooner, with a quick flick down
const NOT_A_HANDLE = 'button, a, input, textarea, select, label, [contenteditable]'

// Bottom sheet on phones, centred dialog on wider screens. Closes on Escape, backdrop tap or (on
// phones) a swipe down on its handle or header, or on its content while that is scrolled to the top
// (sheetDrag.js; mark a child data-no-sheet-drag to keep it out); moves focus inside while open and
// returns it afterwards, locks page scroll, and stays above the on-screen keyboard (lib/keyboard.js;
// an add button can call primeKeyboard() so the keyboard rises with the sheet).
// dragBody: the body drags like the handle, wherever the press starts (short sheets that never
// scroll, e.g. an exercise's animation).
// grouped: a sheet made of grouped lists (menus, settings, pickers) gets the opaque iOS grouped
// background instead of glass (.sheet-grouped: --sheet-grouped-bg, cells in --sheet-cell).
export default function Sheet({ open, onClose, title, description, children, footer, size = 'md', initialFocus = true, role = 'dialog', describedBy, dragBody = false, grouped = false }) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef(null)
  const backdropRef = useRef(null)
  const bodyRef = useRef(null)
  const returnFocusRef = useRef(null)
  // The key handler is added once per opening; the ref gives it the latest onClose (which may
  // depend on state, e.g. "unsaved changes?").
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const openRef = useRef(open)
  openRef.current = open
  const titleId = useId()
  const descId = useId()
  const drag = useDragToClose(panelRef, backdropRef, onCloseRef, openRef)
  // While it animates out the sheet is still there: a second tap on the backdrop or × must
  // not close it again (a form would keep what it just saved as a draft). shell.css also stops the
  // closing sheet taking taps, so a double-clicked Add doesn't add twice.
  const close = () => {
    if (openRef.current) onCloseRef.current?.()
  }

  useEffect(() => {
    if (open) {
      drag.reset() // reopened while it was still sliding away after a swipe
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (mounted) setClosing(true)
    return undefined
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once .is-closing is on the layer (a layout effect: after the DOM update, before paint), the exit
  // animation is known: unmount when it has run. Reopening first clears the timer.
  useLayoutEffect(() => {
    if (!closing) return undefined
    const ms = exitDuration(panelRef.current)
    // Let go after a swipe: the backdrop fades from where the drag left it, over the same time.
    const backdrop = backdropRef.current
    if (backdrop && backdrop.style.opacity !== '') Object.assign(backdrop.style, { transition: `opacity ${ms}ms ease`, opacity: '0' })
    const timer = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, ms)
    return () => clearTimeout(timer)
  }, [closing])

  useEffect(() => {
    if (!mounted || closing) return undefined
    // Opened with primeKeyboard(): the hidden field has focus, but focus goes back to what had it.
    returnFocusRef.current = focusBeforePrime(document.activeElement)
    openSheets += 1
    sheetStack.push(panelRef)
    document.documentElement.classList.add('has-sheet')

    const focusTimer = setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      // A field marked data-autofocus wins over whichever input comes first in the DOM.
      const target = initialFocus ? panel.querySelector('[data-autofocus]') || panel.querySelector('input:not([type=hidden]), textarea, select') : null
      ;(target || panel).focus({ preventScroll: true })
    }, 40)

    const onKeyDown = (event) => {
      // Every open sheet listens on document, so only the topmost one acts. A handled Escape is
      // remembered, so a sheet below skips it even if the top one has already left the stack.
      if (sheetStack[sheetStack.length - 1] !== panelRef) return
      if (event.key === 'Escape' && !handledEscapes.has(event)) {
        handledEscapes.add(event)
        event.stopPropagation()
        close()
      }
      if (event.key === 'Tab') trapFocus(event, panelRef.current)
    }
    document.addEventListener('keydown', onKeyDown)

    // iPhone keyboard: the sheet sits above it (shell.css, from --kb), and the field being typed in
    // stays in view when the keyboard opens or resizes, and when focus moves to another field.
    let shownKb = 0
    const stopKeyboard = watchKeyboard((kb) => {
      if (kb > 0 && kb !== shownKb) revealFocused(panelRef.current)
      shownKb = kb
    })
    let revealFrame = 0
    const onFocusIn = () => {
      cancelAnimationFrame(revealFrame)
      revealFrame = requestAnimationFrame(() => {
        if (shownKb > 0) revealFocused(panelRef.current)
      })
    }
    const panel = panelRef.current
    panel?.addEventListener('focusin', onFocusIn)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      stopKeyboard()
      cancelAnimationFrame(revealFrame)
      panel?.removeEventListener('focusin', onFocusIn)
      openSheets -= 1
      const index = sheetStack.indexOf(panelRef)
      if (index !== -1) sheetStack.splice(index, 1)
      if (openSheets <= 0) document.documentElement.classList.remove('has-sheet')
      returnFocusRef.current?.focus?.({ preventScroll: true })
    }
  }, [mounted, closing]) // eslint-disable-line react-hooks/exhaustive-deps

  // Pull down on the content (phones). Touch events, not pointer events: only a non-passive
  // touchmove can stop the body scrolling once the pull is taken. A dragBody sheet already drags
  // from its body with the pointer.
  useEffect(() => {
    const body = bodyRef.current
    if (!mounted || closing || dragBody || !body) return undefined
    let touch = null // { x, y, t, decided: 'drag' | 'ignore' | undefined }
    const onTouchStart = (event) => {
      touch = null
      if (event.touches.length !== 1 || !window.matchMedia?.(PHONE_QUERY).matches) return
      const target = event.target
      const field = document.activeElement
      if (target.closest?.(NO_SHEET_DRAG)) return
      if (isTyping(field) && (field === target || field.contains?.(target))) return
      if (scrolledInside(target, body)) return
      const point = event.touches[0]
      touch = { x: point.clientX, y: point.clientY, t: event.timeStamp }
    }
    const onTouchMove = (event) => {
      if (!touch || touch.decided === 'ignore') return
      const point = event.touches[0]
      if (!point) return
      if (!touch.decided) {
        const intent = contentDragIntent({ dx: point.clientX - touch.x, dy: point.clientY - touch.y, scrollTop: body.scrollTop })
        if (intent === 'wait') return
        // Too late to take it (the browser is already scrolling): leave it be.
        if (intent === 'ignore' || !event.cancelable) {
          touch.decided = 'ignore'
          return
        }
        touch.decided = 'drag'
        drag.start(touch.y, touch.t, 'touch')
      }
      if (event.cancelable) event.preventDefault()
      drag.move(point.clientY, event.timeStamp, 'touch')
    }
    const onTouchEnd = (event) => {
      const was = touch
      touch = null
      if (was?.decided !== 'drag') return
      const point = event.changedTouches[0]
      drag.end(point ? point.clientY : was.y, event.timeStamp, event.type === 'touchend', 'touch')
    }
    body.addEventListener('touchstart', onTouchStart, { passive: true })
    body.addEventListener('touchmove', onTouchMove, { passive: false })
    body.addEventListener('touchend', onTouchEnd)
    body.addEventListener('touchcancel', onTouchEnd)
    return () => {
      body.removeEventListener('touchstart', onTouchStart)
      body.removeEventListener('touchmove', onTouchMove)
      body.removeEventListener('touchend', onTouchEnd)
      body.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [mounted, closing, dragBody]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null

  return createPortal(
    <div className={`sheet-layer ${closing ? 'is-closing' : ''}`}>
      <div ref={backdropRef} className="sheet-backdrop" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sheet sheet-${size}${grouped ? ' sheet-grouped' : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={describedBy || (title && description ? descId : undefined)}
        tabIndex={-1}
      >
        {/* The bar is 5px; its row gives it a 24px touch area without taking more room. */}
        <div className="sheet-grab" aria-hidden="true" {...drag.handlers}>
          <div className="sheet-handle" />
        </div>
        {title && (
          <header className="sheet-header" {...drag.handlers}>
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && <p id={descId}>{description}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={close} aria-label="Close">
              <Icon name="close" />
            </button>
          </header>
        )}
        <div ref={bodyRef} className={`sheet-body${dragBody ? ' is-draggable' : ''}`} {...(dragBody ? drag.handlers : {})}>{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

// Swipe down to close: from the handle or the header with the pointer (or the body of a dragBody
// sheet, which doesn't scroll), and from the content with touch (the effect in Sheet above). The
// sheet follows the finger, the backdrop fades with it, and on release it closes past
// DRAG_CLOSE_PX or on a flick, otherwise springs back. Closing goes through onClose like the × does,
// so a sheet that asks "discard changes?" first still can; if it stays open, the sheet springs back.
// The core works on (y, time) so pointer and touch share it; `id` keeps two sources from mixing.
function useDragToClose(panelRef, backdropRef, onCloseRef, openRef) {
  const state = useRef(null)
  const settleTimer = useRef(0)

  useEffect(() => () => clearTimeout(settleTimer.current), [])

  const clearInline = () => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    panel?.classList.remove('is-dragging')
    if (panel) Object.assign(panel.style, { transform: '', transition: '' })
    if (backdrop) Object.assign(backdrop.style, { opacity: '', transition: '' })
  }

  const reset = () => {
    clearTimeout(settleTimer.current)
    state.current = null
    clearInline()
  }

  const springBack = () => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel) return
    const still = prefersReducedMotion()
    panel.style.transition = still ? '' : 'transform 0.42s var(--ios-sheet, cubic-bezier(0.32, 0.72, 0, 1))'
    panel.style.transform = ''
    if (backdrop) {
      backdrop.style.transition = still ? '' : 'opacity 0.3s ease'
      backdrop.style.opacity = ''
    }
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(clearInline, still ? 0 : 450)
  }

  const start = (y, time, id) => {
    // A drag whose release never arrived: put the sheet back before starting over.
    if (state.current?.active) springBack()
    state.current = { id, startY: y, dy: 0, active: false, samples: [[time, y]] }
  }

  const move = (y, time, id) => {
    const drag = state.current
    const panel = panelRef.current
    if (!drag || drag.id !== id || !panel) return
    const raw = y - drag.startY
    if (!drag.active) {
      if (Math.abs(raw) < DRAG_SLOP_PX) return
      drag.active = true
      clearTimeout(settleTimer.current)
      // Still sliding in (or springing back): take over from wherever it is now.
      panel.getAnimations?.().forEach((animation) => animation.finish())
      backdropRef.current?.getAnimations?.().forEach((animation) => animation.finish())
      panel.classList.add('is-dragging')
      panel.style.transition = 'none'
      if (backdropRef.current) backdropRef.current.style.transition = 'none'
    }
    // Upwards it only gives a little, like iOS.
    const dy = raw >= 0 ? raw : -Math.min(16, Math.sqrt(-raw) * 1.5)
    drag.dy = dy
    drag.samples.push([time, y])
    if (drag.samples.length > 8) drag.samples.shift()
    panel.style.transform = `translate3d(0, ${dy}px, 0)`
    if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / (panel.offsetHeight || 400)))
  }

  // released: the finger lifted (a cancel never closes).
  const end = (y, time, released, id) => {
    const drag = state.current
    if (!drag || drag.id !== id) return
    state.current = null
    if (!drag.active) return
    panelRef.current?.classList.remove('is-dragging')
    drag.samples.push([time, y])
    const close = released
      && (drag.dy > DRAG_CLOSE_PX || (drag.dy > 20 && releaseSpeed(drag.samples) > FLICK_PX_PER_MS))
    if (!close) {
      springBack()
      return
    }
    // The closing animation (App.css) slides it the rest of the way from where it is now; the
    // backdrop stays where the drag left it until the close starts (the layout effect above fades
    // it over the exit's own duration).
    const panel = panelRef.current
    if (panel) panel.style.transition = ''
    onCloseRef.current?.()
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      if (openRef.current) springBack()
    }, 80)
  }

  const onPointerDown = (event) => {
    if (!event.isPrimary || event.button !== 0) return
    if (!window.matchMedia?.(PHONE_QUERY).matches) return
    if (event.target.closest?.(NOT_A_HANDLE)) return
    start(event.clientY, event.timeStamp, event.pointerId)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // not capturable (pointer already gone): the move/up events still arrive while over the sheet
    }
  }

  const onPointerMove = (event) => move(event.clientY, event.timeStamp, event.pointerId)

  const onPointerEnd = (event) => end(event.clientY, event.timeStamp, event.type === 'pointerup', event.pointerId)

  return {
    reset,
    start,
    move,
    end,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      // Normally after pointerup (nothing left to do); otherwise the drag was cut short: spring back.
      onLostPointerCapture: onPointerEnd,
    },
  }
}

// Whether the touch is inside something that scrolls on its own and isn't at its top (a list in
// the sheet): pulling down there scrolls that, not the sheet.
function scrolledInside(target, body) {
  for (let node = target; node && node !== body; node = node.parentElement) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true
  }
  return false
}

// The closing sheet's exit animation length in ms (duration + delay of the longest one listed), read
// from the computed style. Reduce Motion: App.css shortens every animation to ~0, so this is ~0 too.
function exitDuration(panel) {
  if (prefersReducedMotion()) return 0
  if (!panel) return EXIT_MS
  const style = window.getComputedStyle(panel)
  if (!style.animationName || style.animationName === 'none') return EXIT_MS
  const durations = toMs(style.animationDuration)
  const delays = toMs(style.animationDelay)
  const longest = Math.max(...durations.map((duration, index) => duration + (delays[index % delays.length] || 0)))
  // A few ms over, so the last frame (the sheet fully off screen) is painted before it's removed.
  return Number.isFinite(longest) && longest > 0 ? Math.min(longest + 20, EXIT_MAX_MS) : EXIT_MS
}

// '0.18s, 200ms' -> [180, 200]
function toMs(list) {
  return String(list || '').split(',').map((part) => {
    const value = parseFloat(part)
    if (!Number.isFinite(value)) return 0
    return part.trim().endsWith('ms') ? value : value * 1000
  })
}

// Downward speed (px/ms) over the last 100ms before release; 0 when the finger had stopped.
function releaseSpeed(samples) {
  const last = samples[samples.length - 1]
  const first = samples.find(([time]) => last[0] - time <= 100) || last
  const elapsed = last[0] - first[0]
  return elapsed > 0 ? (last[1] - first[1]) / elapsed : 0
}

function trapFocus(event, container) {
  if (!container) return
  const focusable = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && element.offsetParent !== null)
  if (!focusable.length) {
    event.preventDefault()
    container.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  // Focus on the panel itself (or somewhere outside it) wraps too, so Shift+Tab can't escape.
  const outside = active === container || !container.contains(active)
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault()
    first.focus()
  }
}

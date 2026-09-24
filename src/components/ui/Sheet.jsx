import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'
import '../shell.css'

const EXIT_MS = 180
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
// phones) a swipe down on its handle or header; moves focus inside while open and returns it
// afterwards, and locks page scroll.
export default function Sheet({ open, onClose, title, description, children, footer, size = 'md', initialFocus = true, role = 'dialog', describedBy }) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef(null)
  const backdropRef = useRef(null)
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

  useEffect(() => {
    if (open) {
      drag.reset() // reopened while it was still sliding away after a swipe
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (!mounted) return undefined
    setClosing(true)
    const timer = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, EXIT_MS)
    return () => clearTimeout(timer)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mounted || closing) return undefined
    returnFocusRef.current = document.activeElement
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
        onCloseRef.current?.()
      }
      if (event.key === 'Tab') trapFocus(event, panelRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      openSheets -= 1
      const index = sheetStack.indexOf(panelRef)
      if (index !== -1) sheetStack.splice(index, 1)
      if (openSheets <= 0) document.documentElement.classList.remove('has-sheet')
      returnFocusRef.current?.focus?.({ preventScroll: true })
    }
  }, [mounted, closing]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null

  return createPortal(
    <div className={`sheet-layer ${closing ? 'is-closing' : ''}`}>
      <div ref={backdropRef} className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sheet sheet-${size}`}
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
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </header>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

// Swipe down to close, from the handle or the header (never the scrolling body). The sheet follows
// the finger, the backdrop fades with it, and on release it closes past DRAG_CLOSE_PX or on a flick,
// otherwise springs back. Closing goes through onClose like the × does, so a sheet that asks
// "discard changes?" first still can; if it stays open, the sheet springs back.
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
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    panel.style.transition = still ? '' : 'transform 0.42s var(--ios-sheet, cubic-bezier(0.32, 0.72, 0, 1))'
    panel.style.transform = ''
    if (backdrop) {
      backdrop.style.transition = still ? '' : 'opacity 0.3s ease'
      backdrop.style.opacity = ''
    }
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(clearInline, still ? 0 : 450)
  }

  const onPointerDown = (event) => {
    if (!event.isPrimary || event.button !== 0) return
    if (!window.matchMedia?.(PHONE_QUERY).matches) return
    if (event.target.closest?.(NOT_A_HANDLE)) return
    // A drag whose release never arrived: put the sheet back before starting over.
    if (state.current?.active) springBack()
    state.current = { id: event.pointerId, startY: event.clientY, dy: 0, active: false, samples: [[event.timeStamp, event.clientY]] }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // not capturable (pointer already gone): the move/up events still arrive while over the sheet
    }
  }

  const onPointerMove = (event) => {
    const drag = state.current
    const panel = panelRef.current
    if (!drag || event.pointerId !== drag.id || !panel) return
    const raw = event.clientY - drag.startY
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
    drag.samples.push([event.timeStamp, event.clientY])
    if (drag.samples.length > 8) drag.samples.shift()
    panel.style.transform = `translate3d(0, ${dy}px, 0)`
    if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / (panel.offsetHeight || 400)))
  }

  const onPointerEnd = (event) => {
    const drag = state.current
    if (!drag || event.pointerId !== drag.id) return
    state.current = null
    if (!drag.active) return
    panelRef.current?.classList.remove('is-dragging')
    drag.samples.push([event.timeStamp, event.clientY])
    const close = event.type === 'pointerup'
      && (drag.dy > DRAG_CLOSE_PX || (drag.dy > 20 && releaseSpeed(drag.samples) > FLICK_PX_PER_MS))
    if (!close) {
      springBack()
      return
    }
    // The closing animation (App.css) slides it the rest of the way from where it is now.
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (panel) panel.style.transition = ''
    if (backdrop) Object.assign(backdrop.style, { transition: `opacity ${EXIT_MS}ms ease`, opacity: '0' })
    onCloseRef.current?.()
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      if (openRef.current) springBack()
    }, 80)
  }

  return {
    reset,
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

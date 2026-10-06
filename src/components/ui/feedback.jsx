import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Sheet from './Sheet.jsx'
import { watchKeyboard } from '../../lib/keyboard.js'
import { addToast, toastDuration, toastText } from '../../lib/toastQueue.js'

// ---- toasts ------------------------------------------------------------------------------
// toast('Task archived', { action: { label: 'Undo', onClick } }) — short-lived, non-blocking
// messages. Reversible actions use an Undo toast instead of an "are you sure?" dialog.
// They stay 7s with a button and ~8s for errors (lib/toastQueue.js), wait while touched, hovered
// or focused, and swipe away sideways. Repeats merge ("Completed (3)"); `key` makes a toast
// replace an earlier one with the same key instead. Phones show at most two; while a sheet is
// open they show at the top (shell.css).

let toastListener = null
let toastId = 0
const PHONE_QUERY = '(max-width: 639px)'
const SWIPE_SLOP_PX = 8
const SWIPE_DISMISS_PX = 80
const SWIPE_FLICK_PX_PER_MS = 0.6
const RESUME_MIN_MS = 2000 // after a pause, a toast stays at least this long

export function toast(message, { action, tone = 'default', duration, key } = {}) {
  const stamp = ++toastId
  toastListener?.({ id: stamp, stamp, key, message, action, tone, duration: duration ?? toastDuration({ tone, action }) })
}

export function Toaster() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    toastListener = (item) => {
      const limit = window.matchMedia?.(PHONE_QUERY).matches ? 2 : 3
      setToasts((current) => addToast(current, item, limit))
    }
    return () => { toastListener = null }
  }, [])

  // While toasts show, follow the on-screen keyboard so they sit above it (shell.css).
  const showing = toasts.length > 0
  useEffect(() => (showing ? watchKeyboard() : undefined), [showing])

  const dismiss = (id) => setToasts((current) => current.filter((item) => item.id !== id))

  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => <ToastItem key={item.id} item={item} onDismiss={() => dismiss(item.id)} />)}
    </div>
  )
}

function ToastItem({ item, onDismiss }) {
  const ref = useRef(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const timer = useToastTimer(item, onDismissRef)
  const swipe = useSwipeAway(ref, timer, onDismissRef)

  return (
    <div
      ref={ref}
      className={`toast toast-${item.tone}`}
      role={item.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') timer.hold('hover') }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') timer.release('hover') }}
      onFocus={() => timer.hold('focus')}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) timer.release('focus') }}
      {...swipe}
    >
      {item.tone === 'error' && <Icon name="alert" size={18} />}
      {item.tone === 'success' && <Icon name="check" size={18} />}
      <span className="toast-message">{toastText(item)}</span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action.onClick()
            onDismiss()
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

// The toast's countdown, paused while anything holds it ('hover', 'touch', 'focus'). A repeat
// merged into it (a new stamp) starts it over.
function useToastTimer(item, onDismissRef) {
  const holds = useRef(new Set())
  const clock = useRef({ id: 0, left: item.duration, since: 0 })

  const run = () => {
    clearTimeout(clock.current.id)
    if (holds.current.size) return
    clock.current.since = Date.now()
    clock.current.id = setTimeout(() => onDismissRef.current(), clock.current.left)
  }

  useEffect(() => {
    clock.current.left = item.duration
    run()
    return () => clearTimeout(clock.current.id)
  }, [item.stamp]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    hold(reason) {
      if (!holds.current.size) {
        clearTimeout(clock.current.id)
        clock.current.left = Math.max(RESUME_MIN_MS, clock.current.left - (Date.now() - clock.current.since))
      }
      holds.current.add(reason)
    },
    release(reason) {
      if (holds.current.delete(reason) && !holds.current.size) run()
    },
  }
}

// Swipe sideways to dismiss: the toast follows the finger (or mouse) and fades; released far
// enough or flicked, it slides off; otherwise it springs back. Vertical moves stay page scrolls.
function useSwipeAway(ref, timer, onDismissRef) {
  const swipe = useRef(null)

  const settle = (dismiss, dx) => {
    const element = ref.current
    if (!element) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    element.classList.remove('is-swiping')
    element.style.transition = still ? '' : 'transform 0.2s ease, opacity 0.2s ease'
    if (dismiss) {
      Object.assign(element.style, { transform: `translateX(${dx < 0 ? -110 : 110}%)`, opacity: '0' })
      setTimeout(() => onDismissRef.current(), still ? 0 : 180)
    } else {
      Object.assign(element.style, { transform: '', opacity: '' })
    }
  }

  const end = (event) => {
    const current = swipe.current
    if (!current || event.pointerId !== current.id) return
    swipe.current = null
    if (event.pointerType !== 'mouse') timer.release('touch')
    if (!current.active) return
    const far = Math.abs(current.dx) > SWIPE_DISMISS_PX
      || (Math.abs(current.dx) > 24 && flickSpeed(current.samples, event.timeStamp) > SWIPE_FLICK_PX_PER_MS)
    settle(event.type === 'pointerup' && far, current.dx)
  }

  return {
    onPointerDown(event) {
      if (!event.isPrimary || event.button !== 0) return
      if (event.pointerType !== 'mouse') timer.hold('touch')
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false, samples: [] }
    },
    onPointerMove(event) {
      const current = swipe.current
      const element = ref.current
      if (!current || event.pointerId !== current.id || !element) return
      const dx = event.clientX - current.x
      if (!current.active) {
        if (Math.abs(dx) < SWIPE_SLOP_PX || Math.abs(dx) < Math.abs(event.clientY - current.y)) return
        current.active = true
        element.classList.add('is-swiping')
        element.style.transition = 'none'
        try {
          element.setPointerCapture(event.pointerId) // the release can't land on Undo
        } catch {
          // the pointer is already gone: its pointerup/cancel still ends the swipe
        }
      }
      current.dx = dx
      current.samples.push([event.timeStamp, dx])
      if (current.samples.length > 8) current.samples.shift()
      element.style.transform = `translateX(${dx}px)`
      element.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 260))
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
}

// Sideways speed (px/ms) over the last 100ms before `now`; 0 when the finger had stopped.
function flickSpeed(samples, now) {
  const recent = samples.filter(([time]) => now - time <= 100)
  if (recent.length < 2) return 0
  const [startAt, startX] = recent[0]
  const [endAt, endX] = recent[recent.length - 1]
  return endAt > startAt ? Math.abs(endX - startX) / (endAt - startAt) : 0
}

// ---- confirmation ------------------------------------------------------------------------
// Only for permanent actions: `if (await confirmAction({...})) ...`
// Resolves true (confirm button), false (the cancel button, which cancelLabel can name as an
// action, e.g. 'Resume') or null (dismissed: backdrop, Escape or close).

let confirmListener = null

export function confirmAction({ title, message, confirmLabel = 'Delete', tone = 'danger', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    if (!confirmListener) {
      resolve(window.confirm(message || title))
      return
    }
    confirmListener({ title, message, confirmLabel, tone, cancelLabel, resolve })
  })
}

export function ConfirmHost() {
  const [request, setRequest] = useState(null)
  const [open, setOpen] = useState(false)
  const pending = useRef(null)
  const messageId = useId()

  useEffect(() => {
    confirmListener = (next) => {
      pending.current?.resolve(null) // a newer question replaces one still open
      pending.current = next
      setRequest(next)
      setOpen(true)
    }
    return () => {
      confirmListener = null
      pending.current?.resolve(null)
      pending.current = null
    }
  }, [])

  const settle = (value) => {
    if (pending.current === request) pending.current = null
    request?.resolve(value)
    setOpen(false)
  }

  return (
    <Sheet
      open={open}
      onClose={() => settle(null)}
      title={request?.title}
      size="sm"
      initialFocus={false}
      role="alertdialog"
      describedBy={request?.message ? messageId : undefined}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>{request?.cancelLabel || 'Cancel'}</button>
          <button type="button" className={`btn ${request?.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => settle(true)} data-autofocus>
            {request?.confirmLabel}
          </button>
        </>
      )}
    >
      {request?.message && <p id={messageId} className="confirm-message">{request.message}</p>}
    </Sheet>
  )
}

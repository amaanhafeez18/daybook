import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { collapseOut, restoreCollapsed } from '../../lib/collapse.js'
import { clickEndsGesture } from '../../lib/food/gesture.js'
import { swallowNextClick } from './useLongPress.js'
import './swipe.css'

const OPEN_X = 88 // px the Delete button takes when a row is swiped open
const LONG_PRESS_MS = 480

// The one swipe row the app uses (food entries, saved foods, weigh-ins, workouts, journal): a list
// row that swipes left to reveal Delete (a long swipe deletes at once). onLongPress also
// runs on a press-and-hold or a right click. The row's own buttons keep working; a tap after a
// swipe only closes the row. A deleted row folds away (the rows below close the gap) before
// onDelete runs; at once under Reduce Motion.
export function SwipeRow({ as: Tag = 'li', className = '', onDelete, deleteLabel = 'Delete', onLongPress, children }) {
  const rowRef = useRef(null)
  const slideRef = useRef(null)
  const drag = useRef(null)
  // A swipe or press-and-hold just happened: { x, y, at } of its release. The click a mouse (or a
  // held touch) sends for the same gesture is ignored; a touch swipe sends none, and the next real
  // tap (e.g. on the Delete it revealed) must still work, so only a click at that spot, within a
  // moment, counts as the gesture's own (clickEndsGesture).
  const gesture = useRef(null)
  const longTimer = useRef(null)
  const endTimer = useRef(null)
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  const deleteRef = useRef(onDelete)
  deleteRef.current = onDelete

  useEffect(() => () => {
    clearTimeout(longTimer.current)
    clearTimeout(endTimer.current)
  }, [])

  // Folds the row away, then deletes it. slid: it was swiped off, so let that slide finish first.
  function leave(slid) {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    const row = rowRef.current
    const fold = () => (row ? collapseOut(row).catch(() => {}) : Promise.resolve())
    const wait = slid ? new Promise((resolve) => setTimeout(resolve, 160)) : Promise.resolve()
    wait.then(fold).then(() => {
      deleteRef.current?.()
      // Still here (the delete didn't happen): open the row back up.
      requestAnimationFrame(() => {
        if (!row?.isConnected) return
        restoreCollapsed(row)
        row.style.overflow = ''
        row.style.boxSizing = ''
        if (slideRef.current) slideRef.current.style.transform = ''
        row.classList.remove('is-swiping')
        leavingRef.current = false
        setLeaving(false)
      })
    })
  }

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!rowRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function slideTo(x) {
    const slide = slideRef.current
    if (slide) {
      slide.style.transition = ''
      slide.style.transform = x ? `translateX(${x}px)` : ''
    }
    clearTimeout(endTimer.current)
    if (!x) endTimer.current = setTimeout(() => rowRef.current?.classList.remove('is-swiping'), 340)
  }

  function close() {
    setOpen(false)
    slideTo(0)
  }

  const onPointerDown = (event) => {
    gesture.current = null
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest?.('.swipe-row-action')) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: open ? -OPEN_X : 0, offset: null, active: false, width: rowRef.current?.offsetWidth || 320 }
    clearTimeout(longTimer.current)
    if (onLongPress && !open) {
      longTimer.current = setTimeout(() => {
        if (drag.current && !drag.current.active) {
          const { x, y } = drag.current
          drag.current = null
          gesture.current = { x, y, at: null } // stamped when the press is released
          swallowNextClick()
          onLongPress()
        }
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (event) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.active) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(longTimer.current)
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      if (!onDelete || Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      if (!open && dx > 0) {
        drag.current = null
        return
      }
      d.active = true
      try {
        rowRef.current?.setPointerCapture?.(event.pointerId)
      } catch {
        // capture is best-effort
      }
      clearTimeout(endTimer.current)
      rowRef.current?.classList.add('is-swiping')
      if (slideRef.current) slideRef.current.style.transition = 'none'
    }
    d.offset = Math.max(-d.width * 0.92, Math.min(0, d.base + dx))
    if (slideRef.current) slideRef.current.style.transform = `translateX(${d.offset}px)`
  }

  const finish = (cancelled, event) => {
    clearTimeout(longTimer.current)
    const at = Number.isFinite(event?.timeStamp) ? event.timeStamp : performance.now()
    const d = drag.current
    drag.current = null
    if (!d?.active) {
      if (gesture.current && gesture.current.at === null) gesture.current = { ...gesture.current, at } // a press-and-hold released
      return
    }
    gesture.current = { x: event?.clientX ?? d.x, y: event?.clientY ?? d.y, at }
    const offset = cancelled ? d.base : d.offset ?? d.base
    if (!cancelled && offset < -d.width * 0.55) {
      if (slideRef.current) {
        slideRef.current.style.transition = ''
        slideRef.current.style.transform = `translateX(${-d.width}px)`
      }
      setOpen(false)
      leave(true)
      return
    }
    const next = offset < -OPEN_X / 2
    setOpen(next)
    slideTo(next ? -OPEN_X : 0)
  }

  const onClickCapture = (event) => {
    const mark = gesture.current
    gesture.current = null
    if (clickEndsGesture(mark, event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (open && !event.target.closest?.('.swipe-row-action')) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <Tag
      ref={rowRef}
      className={`swipe-row${open ? ' is-open' : ''}${leaving ? ' is-leaving' : ''} ${className}`}
      aria-hidden={leaving || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(false, event)}
      onPointerCancel={(event) => finish(true, event)}
      onClickCapture={onClickCapture}
      onContextMenu={onLongPress ? (event) => {
        event.preventDefault()
        clearTimeout(longTimer.current)
        drag.current = null
        onLongPress()
      } : undefined}
    >
      {onDelete && (
        <button
          type="button"
          className="swipe-row-action"
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          onClick={() => {
            setOpen(false)
            leave(false)
          }}
        >
          <Icon name="trash" size={18} />
          {deleteLabel}
        </button>
      )}
      <div ref={slideRef} className="swipe-row-slide">{children}</div>
    </Tag>
  )
}

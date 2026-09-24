import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { IconButton } from '../../components/ui/primitives.jsx'
import { useStore } from '../../lib/store.js'
import { goBack } from '../gym/common.jsx'

// Pieces shared by the Food page views: the in-page back button, a ⋯ menu, swipe-to-delete rows,
// stat tiles and the "database needs updating" note.

export { goBack }

export function DetailTop({ backLabel = 'Food', fallback = 'food', children }) {
  return (
    <div className="food-detail-top">
      <button type="button" className="food-back" onClick={() => goBack(fallback)}>
        <Icon name="chevronLeft" size={22} />
        {backLabel}
      </button>
      {children && <div className="food-detail-actions">{children}</div>}
    </div>
  )
}

// A popover menu under a round ⋯ button. items: [{ label, icon, onClick, danger?, disabled? }];
// { divider: true } draws a line between groups (edit · go to · settings).
export function Menu({ items, label = 'More options', icon = 'more', className = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const shown = items.filter(Boolean)
  if (!shown.some((item) => !item.divider)) return null
  return (
    <div className={`food-menu-wrap ${className}`} ref={ref}>
      <IconButton icon={icon} label={label} className="food-head-btn" size={21} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
      {open && (
        <div className="food-menu" role="menu">
          {shown.map((item, index) => (item.divider ? (
            <span key={`divider-${index}`} className="food-menu-divider" role="separator" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'is-danger' : ''}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              <span>{item.label}</span>
              <Icon name={item.icon} size={18} />
            </button>
          )))}
        </div>
      )}
    </div>
  )
}

const OPEN_X = 88 // px the Delete button takes when a row is swiped open
const LONG_PRESS_MS = 480

// A list row that swipes left to reveal Delete (a long swipe deletes at once). onLongPress also
// runs on a press-and-hold or a right click. The row's own buttons keep working; a tap after a
// swipe only closes the row.
export function SwipeRow({ as: Tag = 'li', className = '', onDelete, deleteLabel = 'Delete', onLongPress, children }) {
  const rowRef = useRef(null)
  const slideRef = useRef(null)
  const drag = useRef(null)
  const suppress = useRef(false)
  const longTimer = useRef(null)
  const endTimer = useRef(null)
  const [open, setOpen] = useState(false)

  useEffect(() => () => {
    clearTimeout(longTimer.current)
    clearTimeout(endTimer.current)
  }, [])

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
    suppress.current = false
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest?.('.food-swipe-delete')) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: open ? -OPEN_X : 0, offset: null, active: false, width: rowRef.current?.offsetWidth || 320 }
    clearTimeout(longTimer.current)
    if (onLongPress && !open) {
      longTimer.current = setTimeout(() => {
        if (drag.current && !drag.current.active) {
          drag.current = null
          suppress.current = true
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

  const finish = (cancelled) => {
    clearTimeout(longTimer.current)
    const d = drag.current
    drag.current = null
    if (!d?.active) return
    suppress.current = true
    const offset = cancelled ? d.base : d.offset ?? d.base
    if (!cancelled && offset < -d.width * 0.55) {
      if (slideRef.current) {
        slideRef.current.style.transition = ''
        slideRef.current.style.transform = `translateX(${-d.width}px)`
      }
      setOpen(false)
      onDelete()
      return
    }
    const next = offset < -OPEN_X / 2
    setOpen(next)
    slideTo(next ? -OPEN_X : 0)
  }

  const onClickCapture = (event) => {
    if (suppress.current) {
      suppress.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (open && !event.target.closest?.('.food-swipe-delete')) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <Tag
      ref={rowRef}
      className={`food-swipe${open ? ' is-open' : ''} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
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
          className="food-swipe-delete"
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          onClick={() => {
            close()
            onDelete()
          }}
        >
          <Icon name="trash" size={18} />
          {deleteLabel}
        </button>
      )}
      <div ref={slideRef} className="food-swipe-slide">{children}</div>
    </Tag>
  )
}

export function StatTile({ label, value, sub, tone }) {
  return (
    <div className={`food-stat${tone ? ` is-${tone}` : ''}`}>
      <span className="food-stat-label">{label}</span>
      <span className="food-stat-value">{value ?? '—'}</span>
      {sub != null && sub !== '' && <span className="food-stat-sub">{sub}</span>}
    </div>
  )
}

// The sync error from a save that needs a database update (food table or body weights).
export function MigrationNote() {
  const error = useStore((state) => state.saveError)
  if (!error || !/Food data|Gym data/.test(error)) return null
  return (
    <p className="food-note is-warning" role="status">
      <Icon name="alert" size={18} />
      <span>{error} Until then, entries stay on this device.</span>
    </p>
  )
}

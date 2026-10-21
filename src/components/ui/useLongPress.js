import { useEffect, useRef } from 'react'

// Press and hold (touch) or right-click (mouse) on an element → onLongPress, like iOS context menus.
// Spread the returned handlers on the element. A finger that moves (a scroll or swipe) cancels it,
// and the click the hold's release sends is swallowed, so the row's own tap doesn't fire too.
//   const press = useLongPress(() => setPeek(true))
//   <li {...press}>…</li>
const HOLD_MS = 480
const SLOP_PX = 8

// After a hold opens something (a peek sheet), the finger's release still sends a click at that
// spot, which would land on the new sheet's backdrop and close it at once. Swallows the next
// click anywhere, for a moment after the hold.
export function swallowNextClick(ms = 900) {
  if (typeof document === 'undefined') return
  const swallow = (event) => {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
  const stop = () => {
    clearTimeout(timer)
    document.removeEventListener('click', swallow, true)
  }
  const timer = setTimeout(stop, ms)
  document.addEventListener('click', swallow, true)
}

export function useLongPress(onLongPress) {
  const timer = useRef(0)
  const start = useRef(null)
  const fired = useRef(false)
  const callback = useRef(onLongPress)
  callback.current = onLongPress

  useEffect(() => () => clearTimeout(timer.current), [])

  const cancel = () => {
    clearTimeout(timer.current)
    start.current = null
  }

  return {
    onPointerDown(event) {
      fired.current = false
      if (event.pointerType === 'mouse' || !callback.current) return
      start.current = { x: event.clientX, y: event.clientY }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (!start.current) return
        start.current = null
        fired.current = true
        swallowNextClick()
        callback.current?.()
      }, HOLD_MS)
    },
    onPointerMove(event) {
      const from = start.current
      if (from && (Math.abs(event.clientX - from.x) > SLOP_PX || Math.abs(event.clientY - from.y) > SLOP_PX)) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(event) {
      if (!fired.current) return
      fired.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    onContextMenu(event) {
      if (!callback.current) return
      event.preventDefault()
      cancel()
      callback.current()
    },
  }
}

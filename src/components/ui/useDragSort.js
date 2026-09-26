import { useLayoutEffect, useRef, useState } from 'react'
import './drag.css'

// Drag to reorder, for a vertical list (axis 'y') or wrapping chips (axis 'xy').
//   const sort = useDragSort({ keys, onMove: (from, to) => …, longPress })
//   <li {...sort.item(key)}> … <button {...sort.handle(key)}> … </li>
// `keys` are the items' keys in their current order; onMove(from, to) moves one item (the parent
// updates its own state). item() goes on the element that moves, handle() on what is grabbed: the
// whole item, or a grip. Mouse and pen start after a few pixels. On touch, a grip (CSS
// touch-action: none) starts straight away; with longPress (whole chips in a scrolling sheet) the
// finger holds still for a moment first, so a swipe still scrolls. Arrow keys on a handle move the
// item one place. The others slide out of the way; near the edge of a scrolling sheet it scrolls.

const MOUSE_SLOP = 4
const TOUCH_SLOP = 8
const LONG_PRESS_MS = 260
const EDGE_PX = 56
const MAX_SCROLL_STEP = 14

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Where an element sits in the layout, without a transform that is moving it (a slide in progress).
function layoutRect(el) {
  const rect = el.getBoundingClientRect()
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return rect
  const m = new DOMMatrixReadOnly(transform)
  return { left: rect.left - m.e, top: rect.top - m.f, right: rect.right - m.e, bottom: rect.bottom - m.f, width: rect.width, height: rect.height }
}

function scrollParent(el) {
  for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement || document.documentElement
}

export function useDragSort({ keys, onMove, longPress = false, axis = 'y' }) {
  const els = useRef(new Map())
  const drag = useRef(null)
  const before = useRef(null) // rects just before a move, for the slide
  const suppressClick = useRef(false)
  const latest = useRef({ keys, onMove, axis })
  latest.current = { keys, onMove, axis }
  const [dragging, setDragging] = useState(null)

  // The dragged item follows the pointer (measured without its own transform).
  const place = () => {
    const d = drag.current
    const el = d?.active ? els.current.get(d.key) : null
    if (!el) return
    el.style.transform = ''
    const rect = el.getBoundingClientRect()
    el.style.transform = `translate(${d.x - d.grabX - rect.left}px, ${d.y - d.grabY - rect.top}px)`
  }

  // Its new index: the other items whose middle comes before the dragged item's middle (reading
  // order for chips). Counting like this can't flip back and forth between two items of different sizes.
  const reorder = () => {
    const d = drag.current
    if (!d?.active) return
    const { keys: order, onMove: move, axis: dir } = latest.current
    const el = els.current.get(d.key)
    const from = order.indexOf(d.key)
    if (!el || from < 0) return
    const size = el.getBoundingClientRect()
    const cx = d.x - d.grabX + size.width / 2
    const cy = d.y - d.grabY + size.height / 2
    let to = 0
    for (const key of order) {
      const other = key === d.key ? null : els.current.get(key)
      if (!other) continue
      const r = layoutRect(other)
      const earlier = dir === 'xy'
        ? (r.bottom <= cy ? true : r.top > cy ? false : r.left + r.width / 2 < cx)
        : r.top + r.height / 2 < cy
      if (earlier) to += 1
    }
    if (to === from) return
    before.current = new Map([...els.current].map(([key, node]) => [key, node.getBoundingClientRect()]))
    move(from, to)
  }

  // After a move renders: the dragged item re-attaches to the pointer and the rest slide into place.
  const orderKey = keys.join('\u0001')
  useLayoutEffect(() => {
    const rects = before.current
    before.current = null
    place()
    if (!rects || reducedMotion()) return
    for (const [key, rect] of rects) {
      const el = els.current.get(key)
      if (!el || key === drag.current?.key) continue
      const now = el.getBoundingClientRect()
      const dx = rect.left - now.left
      const dy = rect.top - now.top
      if (!dx && !dy) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      el.getBoundingClientRect()
      el.style.transition = 'transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)'
      el.style.transform = ''
      clearTimeout(el.dragSlideTimer)
      el.dragSlideTimer = setTimeout(() => { el.style.transition = '' }, 200)
    }
  }, [orderKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const autoScroll = () => {
    const d = drag.current
    if (!d?.active) return
    const scroller = d.scroller
    const box = scroller === document.scrollingElement || scroller === document.documentElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect()
    let step = 0
    if (d.y < box.top + EDGE_PX) step = -Math.ceil(((box.top + EDGE_PX - d.y) / EDGE_PX) * MAX_SCROLL_STEP)
    else if (d.y > box.bottom - EDGE_PX) step = Math.ceil(((d.y - (box.bottom - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_STEP)
    if (step) {
      const was = scroller.scrollTop
      scroller.scrollTop += step
      if (scroller.scrollTop !== was) {
        place()
        reorder()
      }
    }
    d.frame = requestAnimationFrame(autoScroll)
  }

  const blockTouchScroll = (event) => {
    if (drag.current?.active && event.cancelable) event.preventDefault()
  }

  const activate = () => {
    const d = drag.current
    if (!d || d.active) return
    d.active = true
    d.scroller = scrollParent(els.current.get(d.key))
    try { d.handle.setPointerCapture?.(d.pointerId) } catch { /* the pointer may be gone */ }
    window.addEventListener('touchmove', blockTouchScroll, { passive: false })
    navigator.vibrate?.(8)
    setDragging(d.key)
    place()
    d.frame = requestAnimationFrame(autoScroll)
  }

  const finish = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    clearTimeout(d.timer)
    cancelAnimationFrame(d.frame)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('touchmove', blockTouchScroll)
    if (!d.active) return
    suppressClick.current = true
    setTimeout(() => { suppressClick.current = false }, 0)
    const el = els.current.get(d.key)
    if (el) {
      // Glide from the finger into its slot.
      const rect = el.getBoundingClientRect()
      el.style.transform = ''
      const slot = el.getBoundingClientRect()
      if (!reducedMotion() && (rect.left !== slot.left || rect.top !== slot.top)) {
        el.style.transition = 'none'
        el.style.transform = `translate(${rect.left - slot.left}px, ${rect.top - slot.top}px)`
        el.getBoundingClientRect()
        el.style.transition = 'transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)'
        el.style.transform = ''
        clearTimeout(el.dragSlideTimer)
        el.dragSlideTimer = setTimeout(() => { el.style.transition = '' }, 200)
      }
    }
    setDragging(null)
  }

  function onPointerMove(event) {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    d.x = event.clientX
    d.y = event.clientY
    if (!d.active) {
      const moved = Math.hypot(d.x - d.startX, d.y - d.startY)
      if (d.touch && d.waiting) {
        if (moved > TOUCH_SLOP) finish() // a swipe: let it scroll
        return
      }
      if (moved < (d.touch ? 2 : MOUSE_SLOP)) return
      activate()
    }
    place()
    reorder()
  }

  const start = (event, key) => {
    if (drag.current || (event.pointerType === 'mouse' && event.button !== 0)) return
    const el = els.current.get(key)
    if (!el) return
    const rect = el.getBoundingClientRect()
    const touch = event.pointerType === 'touch'
    drag.current = {
      key,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      touch,
      waiting: touch && longPress,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
    }
    if (touch && longPress) {
      drag.current.timer = setTimeout(() => {
        if (!drag.current) return
        drag.current.waiting = false
        activate()
      }, LONG_PRESS_MS)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const keyMove = (event, key) => {
    const { keys: order, onMove: move } = latest.current
    const from = order.indexOf(key)
    const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
    if (!delta || from < 0) return
    event.preventDefault()
    const to = from + delta
    if (to < 0 || to >= order.length) return
    before.current = new Map([...els.current].map(([k, node]) => [k, node.getBoundingClientRect()]))
    move(from, to)
  }

  return {
    dragging,
    item: (key) => ({
      ref: (el) => {
        if (el) els.current.set(key, el)
        else els.current.delete(key)
      },
      'data-dragging': dragging === key ? '' : undefined,
    }),
    handle: (key, { keyboard = true } = {}) => ({
      onPointerDown: (event) => start(event, key),
      // A drag isn't a tap, and a long press shouldn't open the phone's menu.
      onClickCapture: (event) => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
      },
      onContextMenu: (event) => { if (drag.current) event.preventDefault() },
      ...(keyboard ? { onKeyDown: (event) => keyMove(event, key) } : {}),
    }),
  }
}

// The list with one item moved from one index to another.
export function moveItem(list, from, to) {
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

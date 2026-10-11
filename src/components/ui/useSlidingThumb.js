import { useLayoutEffect } from 'react'

// A selection that slides: the highlight behind a segmented control, the Plan | Health pill or the
// tab bar glides to the new choice instead of jumping.
//   const ref = useRef(null)
//   useSlidingThumb(ref, value)
//   <div ref={ref} className="segmented">…<button className={on ? 'is-active' : ''}>…</div>
// It measures the active child (a direct child, or the one link/button inside a direct child, e.g.
// li > a: marked .is-active, aria-checked, aria-selected or aria-current="page") and writes its box
// to --thumb-x/--thumb-y/--thumb-w/--thumb-h on the container. The container gets .has-thumb (the
// CSS draws a ::before thumb there and makes the active child's own background transparent), then
// .thumb-live a frame after the first paint, so the thumb never animates in from nowhere: only a
// change of selection moves it. A ResizeObserver keeps it in place when the control resizes.
// The thumb is a pseudo-element, so assistive tech never sees it. CSS: glass.css (and apple.css
// inside cards and sheets); Reduce Motion drops the transition there.

const ACTIVE = [
  ':scope > .is-active',
  ':scope > * > .is-active',
  ':scope > [aria-checked="true"]',
  ':scope > [aria-selected="true"]',
  ':scope > * > [aria-current="page"]',
].join(', ')

// The active element's box inside the container's padding box (where an absolutely positioned
// ::before with left/top 0 starts), or null when it isn't laid out (display: none, zero size).
// Walks offsetParent up to the container; when the container isn't one (not positioned) it falls
// back to the two rectangles.
export function thumbBox(active, container) {
  const w = active?.offsetWidth || 0
  const h = active?.offsetHeight || 0
  if (!w || !h || !container) return null
  let x = 0
  let y = 0
  let node = active
  while (node && node !== container) {
    x += node.offsetLeft || 0
    y += node.offsetTop || 0
    node = node.offsetParent
  }
  if (node !== container) {
    if (typeof active.getBoundingClientRect !== 'function') return null
    const a = active.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    x = a.left - c.left - (container.clientLeft || 0) + (container.scrollLeft || 0)
    y = a.top - c.top - (container.clientTop || 0) + (container.scrollTop || 0)
  }
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w, h }
}

export function useSlidingThumb(containerRef, activeKey) {
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    let liveFrame = 0
    const place = () => {
      const active = container.querySelector(ACTIVE)
      const box = active ? thumbBox(active, container) : null
      if (!box) {
        cancelAnimationFrame(liveFrame)
        liveFrame = 0
        container.classList.remove('has-thumb', 'thumb-live')
        container.style.removeProperty('--thumb-w')
        return
      }
      const { style } = container
      style.setProperty('--thumb-x', `${box.x}px`)
      style.setProperty('--thumb-y', `${box.y}px`)
      style.setProperty('--thumb-w', `${box.w}px`)
      style.setProperty('--thumb-h', `${box.h}px`)
      // First placement (or back from hidden): show it in place, and only then allow it to move.
      // Two frames: a layout effect runs before the first paint, and so does the next frame's rAF.
      if (!container.classList.contains('has-thumb')) {
        container.classList.remove('thumb-live')
        container.classList.add('has-thumb')
      }
      if (!container.classList.contains('thumb-live') && !liveFrame) {
        liveFrame = requestAnimationFrame(() => {
          liveFrame = requestAnimationFrame(() => {
            liveFrame = 0
            container.classList.add('thumb-live')
          })
        })
      }
    }
    place()
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(place)
      observer.observe(container)
      for (const child of container.children) observer.observe(child)
    }
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(liveFrame)
    }
  }, [containerRef, activeKey])

  // React rewrites the whole class attribute when the container's className prop changes, which
  // drops the two classes added here: put them back (the thumb is already where it belongs).
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || container.classList.contains('has-thumb') || !container.style.getPropertyValue('--thumb-w')) return
    container.classList.add('has-thumb', 'thumb-live')
  })
}

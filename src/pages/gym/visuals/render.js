// SVG rendering for exercise visuals: scenes → elements, the (animated) figure and the muscle map.
// Written with createElement rather than JSX so node tests can render it to a string.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { LOOP_MS, groundLine, keyScene, keysBox, phaseScene, viewBox } from './visual.js'
import { bestSide, muscleMapScene } from './musclemap.js'

const r2 = (n) => Math.round(n * 100) / 100
// Hairlines stay one pixel-ish at every size.
const HAIRLINE = new Set(['thin', 'ground'])

function shape(item, key) {
  const cls = `r-${item.role || 'body'}`
  switch (item.k) {
    case 'seg':
      return HAIRLINE.has(item.role)
        ? h('line', { key, x1: r2(item.a[0]), y1: r2(item.a[1]), x2: r2(item.b[0]), y2: r2(item.b[1]), className: cls, strokeWidth: 1.25, vectorEffect: 'non-scaling-stroke' })
        : h('line', { key, x1: r2(item.a[0]), y1: r2(item.a[1]), x2: r2(item.b[0]), y2: r2(item.b[1]), className: cls, strokeWidth: r2(item.w) })
    case 'dot':
      return h('circle', { key, cx: r2(item.c[0]), cy: r2(item.c[1]), r: r2(item.r), className: cls, strokeWidth: 0 })
    case 'ring':
      return h('circle', { key, cx: r2(item.c[0]), cy: r2(item.c[1]), r: r2(item.r), className: `${cls} f-${item.fill || 'none'}`, strokeWidth: r2(item.w) })
    case 'poly':
      return h('polygon', { key, points: item.pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' '), className: cls, strokeWidth: 1.2 })
    case 'ell':
      return h('ellipse', { key, cx: r2(item.c[0]), cy: r2(item.c[1]), rx: r2(item.rx), ry: r2(item.ry), transform: item.rot ? `rotate(${r2(item.rot)} ${r2(item.c[0])} ${r2(item.c[1])})` : undefined, className: cls, strokeWidth: 0 })
    default:
      return null
  }
}

export const shapes = (items, prefix = '') => items.map((item, i) => shape(item, `${prefix}${i}`))

function Svg({ box, size, className, label, children }) {
  return h('svg', {
    className: `gvis ${className || ''}`.trim(),
    viewBox: box.map(r2).join(' '),
    width: size,
    height: size,
    role: label ? 'img' : undefined,
    'aria-label': label || undefined,
    'aria-hidden': label ? undefined : true,
    focusable: 'false',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, children)
}

// ---- playback --------------------------------------------------------------------------------

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return undefined
    const onChange = () => setReduced(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

// True while the element is on screen and the page is visible.
function useOnScreen(ref, enabled) {
  const [seen, setSeen] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    if (!enabled) return undefined
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting), { rootMargin: '40px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, enabled])
  useEffect(() => {
    if (!enabled) return undefined
    const onChange = () => setPageVisible(document.visibilityState !== 'hidden')
    onChange() // it may have changed while this was off
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [enabled])
  return enabled && seen && pageVisible
}

// Hover or press on the row the thumbnail sits in. A list row (.gym-lib-item) wins over the
// picture's own button, so hovering anywhere on the row plays it.
function useRowHover(ref, enabled) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!enabled) return undefined
    const row = ref.current?.closest('.gym-lib-item') || ref.current?.closest('button, a, li, [role="button"]')
    if (!row) return undefined
    const on = () => setActive(true)
    const off = () => setActive(false)
    const events = [['pointerenter', on], ['pointerdown', on], ['pointerleave', off], ['pointercancel', off], ['focusin', on], ['focusout', off]]
    for (const [name, fn] of events) row.addEventListener(name, fn)
    return () => {
      for (const [name, fn] of events) row.removeEventListener(name, fn)
    }
  }, [ref, enabled])
  return active
}

// One rAF loop per playing figure, at most ~30 updates a second.
function usePhase(playing, duration) {
  const [phase, setPhase] = useState(0)
  const phaseRef = useRef(0)
  useEffect(() => {
    if (!playing) return undefined
    let frame = 0
    let last = 0
    const start = performance.now() - phaseRef.current * duration
    const tick = (now) => {
      if (now - last >= 32) {
        last = now
        phaseRef.current = ((now - start) / duration) % 1
        setPhase(phaseRef.current)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration])
  return phase
}

// ---- the figure ------------------------------------------------------------------------------

// animate: true (loops while on screen), 'hover' (loops while its row is hovered or pressed),
// false (still). Thumbnails crop tightly around the still pose; animated figures use a box that
// holds the whole loop. Reduced motion shows the start pose faintly under the end pose.
export function Figure({ vis, size = 120, animate = false, tight = false, label, className }) {
  const ref = useRef(null)
  const reduced = useReducedMotion()
  const info = vis.info
  const still = info.thumb
  const hover = useRowHover(ref, animate === 'hover' && !reduced)
  // 'hover' rows only watch the screen while hovered: a list of them needs no observer per row.
  const onScreen = useOnScreen(ref, (animate === true || hover) && !reduced)
  const playing = !reduced && onScreen && (animate === true || hover)
  // A still thumbnail crops tightly; anything that can move keeps one box for the whole loop, at
  // rest and while playing. A 'hover' one uses the box from its key poses: the loop box takes 25
  // scene solves, too many for a whole list at once.
  const box = useMemo(() => (animate === 'hover' ? keysBox(vis) : tight && !animate ? viewBox(vis, still) : viewBox(vis)), [vis, still, tight, animate])
  const duration = info.hold ? LOOP_MS * 1.6 : LOOP_MS
  const phase = usePhase(playing, duration)

  let body
  if (playing) body = shapes(phaseScene(vis, phase).items, 'p')
  else if (reduced && animate === true && info.keys.length > 1) {
    // The other end of the movement, faint, under the still pose.
    const other = still === 0 ? info.keys.length - 1 : 0
    body = [...shapes(keyScene(vis, other, { ghost: true }).items, 'g'), ...shapes(keyScene(vis, still).items, 's')]
  } else body = shapes(keyScene(vis, still).items, 's')
  const ground = groundLine(box)
  const showGround = ground && keyScene(vis, still).ground

  return h('span', { ref, className: 'gvis-wrap' },
    h(Svg, { box, size, className, label }, showGround ? shape(ground, 'ground') : null, body))
}

// ---- the muscle map --------------------------------------------------------------------------

export function MuscleMap({ muscles, size = 120, only = null, label, className }) {
  const view = only === 'best' ? bestSide(muscles) : only
  const items = useMemo(() => muscleMapScene(muscles, view), [muscles, view])
  const box = view ? [22, 2, 56, 96] : [0, 2, 100, 96]
  const width = view ? Math.round(size * 0.58) : size
  return h('svg', {
    className: `gvis gvis-map ${className || ''}`.trim(),
    viewBox: box.join(' '),
    width,
    height: Math.round(size * 0.96),
    role: label ? 'img' : undefined,
    'aria-label': label || undefined,
    'aria-hidden': label ? undefined : true,
    focusable: 'false',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, shapes(items, 'm'))
}

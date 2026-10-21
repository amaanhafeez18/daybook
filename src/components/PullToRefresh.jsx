import { useEffect, useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { haptic } from '../lib/haptics.js'
import { FOCUS_HASH } from '../lib/router.js'
import { refresh } from '../lib/store.js'
import './pull-to-refresh.css'

// Pull down from the top of any main screen to sync: the arrow turns as you pull, a release past the
// mark refreshes everything (store.refresh, plus a 'daybook:refresh' window event for screens with
// data of their own) and the spinner stays until it's done. Mounted once in the app shell. Not in
// sheets, the workout and routine editors, the assistant chat, a voice call, or while typing.
// html/body have overscroll-behavior none, so iOS's own bounce never competes with it.
const MAX_PX = 110 // how far the indicator travels
const ARM_PX = 66 // a release past this refreshes
const RESIST = 0.5 // finger distance → indicator distance
const MIN_SPIN_MS = 600 // the spinner shows at least this long, so a fast sync still reads as one
const SKIP = '.sheet, [role="dialog"], [data-no-pull], [data-no-sheet-drag], input, textarea, select, [contenteditable="true"], .swipe-row.is-swiping'

function blocked(target) {
  const root = document.documentElement
  if (root.classList.contains('kb-open') || root.classList.contains('voice-open')) return true
  if (FOCUS_HASH.test(window.location.hash) || /^#\/?assistant(?:[/?]|$)/.test(window.location.hash)) return true
  return Boolean(target?.closest?.(SKIP))
}

export default function PullToRefresh() {
  const [pull, setPull] = useState({ y: 0, phase: 'idle' }) // idle | pulling | refreshing | done
  const touch = useRef(null)
  const current = useRef(pull) // the latest pull, for the touch handlers
  current.current = pull
  const show = (next) => {
    current.current = next
    setPull(next)
  }

  useEffect(() => {
    const onStart = (event) => {
      if (current.current.phase === 'refreshing' || event.touches.length !== 1 || window.scrollY > 0 || blocked(event.target)) return
      const t = event.touches[0]
      touch.current = { x: t.clientX, y: t.clientY, vertical: false, y0: 0 }
    }
    const onMove = (event) => {
      const start = touch.current
      if (!start) return
      const t = event.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (!start.vertical) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { touch.current = null; return }
        if (dy < -6 || window.scrollY > 0) { touch.current = null; return }
        if (dy < 10) return
        start.vertical = true
      }
      show({ y: Math.max(0, Math.min(MAX_PX, dy * RESIST)), phase: 'pulling' })
    }
    const onEnd = () => {
      const start = touch.current
      touch.current = null
      if (!start?.vertical) return
      const now = current.current
      if (now.phase !== 'pulling') return
      if (now.y < ARM_PX) {
        show({ y: 0, phase: 'idle' })
        return
      }
      haptic('light') // touchend is the gesture's own user activation
      show({ y: ARM_PX, phase: 'refreshing' })
      window.dispatchEvent(new CustomEvent('daybook:refresh'))
      Promise.all([refresh().catch(() => {}), new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS))]).then(() => {
        show({ y: 0, phase: 'done' })
        setTimeout(() => {
          if (current.current.phase === 'done') show({ y: 0, phase: 'idle' })
        }, 300)
      })
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  if (pull.phase === 'idle') return null
  const progress = Math.min(1, pull.y / ARM_PX)
  const armed = pull.y >= ARM_PX
  return (
    <div
      className={`ptr is-${pull.phase}${armed ? ' is-armed' : ''}`}
      style={{ '--ptr-y': `${pull.y}px`, '--ptr-p': progress }}
      role="status"
      aria-live="polite"
    >
      <span className="ptr-dot">
        <Icon name={pull.phase === 'refreshing' || pull.phase === 'done' ? 'refresh' : 'arrowDown'} size={18} strokeWidth={2.4} />
      </span>
      <span className="sr-only">{pull.phase === 'refreshing' ? 'Syncing' : armed ? 'Release to sync' : ''}</span>
    </div>
  )
}

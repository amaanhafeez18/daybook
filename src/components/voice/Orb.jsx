import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '../../lib/motion.js'

// The voice chat's orb: a soft blob in the accent colour that breathes with the microphone while
// listening and with Daybook's voice while it talks, with a turning sheen while it thinks or works.
// Canvas 2D, one rAF loop, paused while the page is hidden. Reduce Motion: a still disc whose ring
// shows the level by its opacity (4 times a second); the label under it carries the meaning.
//
// level(): 0..1 right now (session.voiceLevel). activity: connecting|listening|hearing|thinking|
// working|speaking. muted: greyed, with a badge drawn by the parent.

const POINTS = 48
const TAU = Math.PI * 2

function accentColors() {
  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--accent').trim() || '#B9561F'
  const soft = style.getPropertyValue('--accent-soft').trim() || 'rgba(185, 86, 31, 0.11)'
  return { accent, soft }
}

// Cheap smooth noise: three sines per angle, moving over time.
const wave = (angle, time, a, b, c) => Math.sin(angle * 3 + time * a) * 0.5 + Math.sin(angle * 5 - time * b) * 0.3 + Math.sin(angle * 2 + time * c) * 0.2

export default function Orb({ activity, status, muted, level }) {
  const canvasRef = useRef(null)
  const ringRef = useRef(null)
  const latest = useRef({ activity, status, muted, level })
  latest.current = { activity, status, muted, level }
  const reduced = prefersReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined
    let colors = accentColors()
    let size = 0
    let frame = 0
    let smooth = 0
    let spin = 0
    let last = performance.now()
    let ringTimer = 0

    const resize = () => {
      const box = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      size = Math.max(1, Math.round(Math.min(box.width, box.height)))
      canvas.width = Math.round(size * dpr)
      canvas.height = Math.round(size * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (reduced) drawStill()
    }

    // The colours follow the theme (light/dark, the accent picked in Settings).
    const themeObserver = new MutationObserver(() => {
      colors = accentColors()
      if (reduced) drawStill()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance', 'data-accent'] })

    // The current path filled in the accent (grey when muted or not live), then a soft highlight
    // over it, so it reads as a sphere in light and dark.
    function paint(radius, cx, cy, greyed) {
      context.fillStyle = greyed ? 'rgb(132, 134, 142)' : colors.accent
      context.fill()
      const shine = context.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.05, cx, cy, radius * 1.1)
      shine.addColorStop(0, 'rgba(255, 255, 255, 0.55)')
      shine.addColorStop(0.45, 'rgba(255, 255, 255, 0.08)')
      shine.addColorStop(1, 'rgba(0, 0, 0, 0.12)')
      context.fillStyle = shine
      context.fill()
    }

    function drawStill() {
      if (!size) return
      const { activity: now, muted: off, status: state } = latest.current
      const cx = size / 2
      const cy = size / 2
      const radius = size * 0.34
      context.clearRect(0, 0, size, size)
      context.globalAlpha = state === 'live' ? 1 : 0.55
      context.beginPath()
      context.arc(cx, cy, radius, 0, TAU)
      paint(radius, cx, cy, off || state !== 'live')
      context.globalAlpha = 1
      if (now === 'thinking' || now === 'working') {
        context.beginPath()
        context.arc(cx, cy, radius * 0.45, 0, TAU)
        context.fillStyle = 'rgba(255, 255, 255, 0.22)'
        context.fill()
      }
    }

    function draw(time) {
      frame = 0
      if (document.hidden) return
      const dt = Math.min(64, time - last)
      last = time
      const { activity: now, muted: off, status: state, level: read } = latest.current
      const active = state === 'live'
      const raw = active && typeof read === 'function' ? Math.max(0, Math.min(1, read(time) || 0)) : 0
      // Fast attack, slow release.
      smooth += (raw - smooth) * (raw > smooth ? 0.5 : 0.12)
      const t = time / 1000
      const cx = size / 2
      const cy = size / 2
      const base = size * (now === 'speaking' ? 0.33 : 0.31)
      const breathe = active ? 0 : Math.sin(t * 1.6) * 0.03
      const amp = 0.2 * smooth
      context.clearRect(0, 0, size, size)

      // The glow.
      const glow = context.createRadialGradient(cx, cy, base * 0.6, cx, cy, size * 0.5)
      glow.addColorStop(0, colors.soft)
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
      context.globalAlpha = Math.min(1, 0.6 + 1.2 * smooth)
      context.fillStyle = glow
      context.fillRect(0, 0, size, size)
      context.globalAlpha = 1

      // The blob.
      context.beginPath()
      for (let index = 0; index <= POINTS; index += 1) {
        const angle = (index / POINTS) * TAU
        const r = base * (1 + breathe + 0.05 * wave(angle, t, 0.9, 0.7, 1.3) + amp * (0.6 + 0.4 * wave(angle, t * 3, 2.1, 1.7, 2.9)))
        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.closePath()
      context.globalAlpha = active ? 1 : 0.5
      paint(base, cx, cy, off || !active)

      // Thinking or working: a turning sheen.
      if (active && (now === 'thinking' || now === 'working') && typeof context.createConicGradient === 'function') {
        spin += dt * 0.0025 * (now === 'working' ? 1.4 : 1)
        const sheen = context.createConicGradient(spin, cx, cy)
        sheen.addColorStop(0, 'rgba(255, 255, 255, 0)')
        sheen.addColorStop(0.15, 'rgba(255, 255, 255, 0.35)')
        sheen.addColorStop(0.3, 'rgba(255, 255, 255, 0)')
        sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
        context.fillStyle = sheen
        context.fill()
      }
      context.globalAlpha = 1
      frame = requestAnimationFrame(draw)
    }

    const start = () => {
      if (reduced) {
        drawStill()
        clearInterval(ringTimer)
        // The ring's opacity follows the level instead of any movement.
        ringTimer = setInterval(() => {
          const { level: read, status: state, muted: off } = latest.current
          const value = state === 'live' && !off && typeof read === 'function' ? Math.max(0, Math.min(1, read() || 0)) : 0
          if (ringRef.current) ringRef.current.style.opacity = String(0.15 + 0.85 * value)
          drawStill()
        }, 250)
        return
      }
      if (!frame && !document.hidden) {
        last = performance.now()
        frame = requestAnimationFrame(draw)
      }
    }
    const onVisible = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame)
        frame = 0
      } else start()
    }

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    observer?.observe(canvas)
    resize()
    start()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelAnimationFrame(frame)
      clearInterval(ringTimer)
      observer?.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reduced])

  return (
    <div className={`voice-orb is-${activity} ${muted ? 'is-muted' : ''} ${reduced ? 'is-still' : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} className="voice-orb-canvas" />
      {reduced && <span ref={ringRef} className="voice-orb-ring" />}
    </div>
  )
}

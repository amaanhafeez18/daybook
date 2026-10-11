import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion.js'
import './burst.css'

// A one-off burst of 12 accent dots (0.9 s) behind something worth celebrating: "All done for today",
// a new PR's medal, the weekly goal. It plays each time `active` turns true, then removes itself.
// Put it inside an element with position: relative; it's centred there and never takes a tap.
// radius: how far the dots fly (px). Decorative only (aria-hidden); nothing under Reduce Motion.
//   <div style={{ position: 'relative' }}><Burst active={justDone} /><Medal /></div>
const PLAY_MS = 1100 // the longest dot (0.9 s + its stagger), with a little to spare
const DOTS = Array.from({ length: 12 }, (_, index) => index)

export default function Burst({ active = false, radius }) {
  const [play, setPlay] = useState(0) // bumped per burst, so a second one restarts the animation
  const was = useRef(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    const turnedOn = active && !was.current
    was.current = active
    if (!turnedOn || prefersReducedMotion()) return
    setPlay((count) => count + 1)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPlay(0), PLAY_MS)
  }, [active])
  if (!play) return null
  return (
    <span key={play} className="burst" aria-hidden="true" style={radius ? { '--burst-r': `${radius}px` } : undefined}>
      {DOTS.map((index) => <i key={index} style={{ '--i': index }} />)}
    </span>
  )
}

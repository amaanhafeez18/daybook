import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion.js'
import { useAnimatedNumber } from '../../lib/useAnimatedNumber.js'
import { NUTRIENT_INFO, fmtNutrient, isNum } from './format.js'
import './food-shared.css'

// Progress ring and macro bars, shared by the Food page and the Today food card.

// Ring keys that have swept in this session (e.g. 'fq:2026-10-11'), so the sweep plays on the
// first open of the day and not on every visit.
const introSeen = new Set()

// true while a ring with this key should still show empty: its first frame paints at the full
// dashoffset, then two frames later the key is used up and the arc sweeps to its value through
// the CSS transition. No sweep under Reduce Motion or without a key.
function useIntro(key) {
  const fresh = !!key && !introSeen.has(key) && !prefersReducedMotion()
  const [, rerender] = useState(0)
  useEffect(() => {
    if (!fresh) return undefined
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        introSeen.add(key)
        rerender((n) => n + 1)
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [fresh, key])
  return fresh
}

// progress 0–1 (clamped). tone: 'accent' (default), 'over' (amber) or 'muted'.
// intro: a key (once per day, e.g. `fq:${today}`) to sweep the arc in from empty the first time
// it mounts; pass it only once the numbers are loaded.
export function Ring({ size = 132, stroke = 12, progress = 0, tone = 'accent', className = '', label, intro = null, children }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, isNum(progress) ? progress : 0))
  const sweeping = useIntro(p > 0 ? intro : null)
  return (
    <span className={`food-ring is-${tone} ${className}`} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="food-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {p > 0 && (
          <circle
            className="food-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${c} ${c}`}
            strokeDashoffset={sweeping ? c : c * (1 - p)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      {children && <span className="food-ring-center">{children}</span>}
    </span>
  )
}

// Ring state for a day: progress toward the calorie goal, amber once over it.
export function ringState(eaten, goal) {
  if (!isNum(goal) || goal <= 0) return { progress: eaten > 0 ? 1 : 0, tone: 'muted', over: false }
  const over = eaten > goal
  return { progress: over ? 1 : eaten / goal, tone: over ? 'over' : 'accent', over }
}

// One nutrient: name, eaten / target, and a thin bar (grams only without a target). Limits
// (sugar, sodium) turn amber past the target; the text always says the numbers.
export function MacroBar({ nutrient, eaten, target }) {
  const info = NUTRIENT_INFO[nutrient]
  // Counts to the new value after logging; screen readers get the final one. (Before the early
  // return: hooks run on every render.)
  const shown = useAnimatedNumber(isNum(eaten) ? eaten : 0)
  if (!info) return null
  const hasTarget = isNum(target) && target > 0
  const pct = hasTarget ? Math.min(100, (Math.max(0, eaten) / target) * 100) : 0
  const over = hasTarget && info.limit && eaten > target
  const unitText = hasTarget ? ` / ${fmtNutrient(nutrient, target)} ${info.unit}` : ` ${info.unit}`
  return (
    <div className={`food-macro is-${nutrient}${over ? ' is-over' : ''}`}>
      <div className="food-macro-top">
        <span className="food-macro-name">{info.label}</span>
        <span className="food-macro-value">
          <span className="sr-only">{fmtNutrient(nutrient, eaten)}{unitText}</span>
          <span aria-hidden="true">
            <span className="num-display">{fmtNutrient(nutrient, isNum(eaten) ? shown : eaten)}</span>
            <small>{unitText}</small>
          </span>
        </span>
      </div>
      <span className={`food-macro-track${hasTarget ? '' : ' is-empty'}`} aria-hidden="true">
        {hasTarget && <span className="food-macro-fill" style={{ width: `${pct}%` }} />}
      </span>
    </div>
  )
}

export function MacroBars({ totals, goals, nutrients, className = '' }) {
  const list = (Array.isArray(nutrients) ? nutrients : []).filter((key) => NUTRIENT_INFO[key])
  if (!list.length) return null
  return (
    <div className={`food-macros ${className}`}>
      {list.map((key) => (
        <MacroBar key={key} nutrient={key} eaten={totals?.[NUTRIENT_INFO[key].field] ?? 0} target={goals?.[key]} />
      ))}
    </div>
  )
}

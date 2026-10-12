import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import { formatUsd } from '../../lib/aiPricing.js'
import { dayCost, featureFigures } from '../../lib/aiUsageClient.js'
import './usage.css'

// The last 30 days of AI spend, following the app's chart rules (food and gym charts): one hue
// (the accent; voice solid, everything else in its soft tint, stacked), a hairline grid, one y-axis
// in dollars, a tooltip on hover or tap (the whole plot is the hit area, arrow keys step through the
// days) and a "Table" toggle with the same numbers. The budget's daily pace is a dashed line when it
// fits the chart; when spending is far below it, a line under the chart says so instead.

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const tidy = (value) => Number(value.toPrecision(12))

function niceScale(max, count = 3) {
  const hi = max > 0 ? max : 0.01
  const raw = hi / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const n = raw / magnitude
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude
  const top = tidy(Math.ceil(hi / step - 1e-9) * step)
  const ticks = []
  for (let i = 0; i * step <= top + step * 1e-6 && i < 12; i++) ticks.push(tidy(i * step))
  return { hi: top > 0 ? top : step, ticks }
}

const axisMoney = (value) => (value === 0 ? '$0' : value < 0.1 ? `${Math.round(value * 100)}¢` : value < 10 ? `$${Number(value.toFixed(2))}` : `$${Math.round(value)}`)
const dayLabel = (iso, options) => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(new Date(`${iso}T00:00:00Z`))
  } catch {
    return iso
  }
}

function barPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`
}

// The element's layout width (clientWidth: a sheet's opening scale transform doesn't shrink it). A
// callback ref, so an element that mounts later (after the empty state) is measured too.
function useWidth() {
  const [element, setElement] = useState(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!element) return undefined
    const measure = () => setWidth(Math.floor(element.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}

// days: summary.last30 ([{ day: 'YYYY-MM-DD', usd, byFeature }], oldest first). budgetUsd: 0 = none.
export default function UsageBars({ days, budgetUsd = 0, daysInMonth = 30, since = '', features = [], height = 170 }) {
  const [wrapRef, width] = useWidth()
  const [table, setTable] = useState(false)
  const [active, setActive] = useState(null)
  const svgRef = useRef(null)
  const tipRef = useRef(null)
  const list = useMemo(() => (Array.isArray(days) ? days : []).filter((day) => day && typeof day.day === 'string').map((day) => {
    const voice = featureFigures(day.byFeature, 'voice').usd
    const total = dayCost(day)
    return { day: day.day, total, voice: Math.min(voice, total), other: Math.max(0, total - voice), byFeature: day.byFeature }
  }), [days])
  const empty = !list.some((day) => day.total > 0)
  const pace = budgetUsd > 0 ? budgetUsd / Math.max(28, Number(daysInMonth) || 30) : 0
  const maxBar = Math.max(0, ...list.map((day) => day.total))
  // The pace line only when the bars would still read next to it.
  const showPace = pace > 0 && maxBar >= pace * 0.3
  useEffect(() => setActive(null), [list.length])

  const geo = useMemo(() => {
    if (!list.length || width < 60) return null
    const scale = niceScale(Math.max(maxBar, showPace ? pace * 1.05 : 0))
    const labels = scale.ticks.map(axisMoney)
    const padL = clamp(Math.max(...labels.map((text) => text.length * 6.4)) + 12, 28, 64)
    const padR = 4
    const padT = 10
    const padB = 24
    const plotW = Math.max(20, width - padL - padR)
    const plotH = Math.max(20, height - padT - padB)
    const slot = plotW / list.length
    const barW = Math.max(3, Math.min(14, slot * 0.62))
    const y = (value) => padT + (1 - value / scale.hi) * plotH
    const bars = list.map((day, i) => {
      const x = padL + slot * i + (slot - barW) / 2
      const top = y(day.total)
      const split = y(day.voice)
      return { x, cx: padL + slot * (i + 0.5), top, split, base: padT + plotH }
    })
    return { padL, padR, padT, plotW, plotH, slot, barW, scale, labels, bars, y }
  }, [list, width, height, maxBar, pace, showPace])

  const indexAt = (clientX) => {
    if (!geo || !svgRef.current) return 0
    const px = clientX - svgRef.current.getBoundingClientRect().left
    return clamp(Math.floor((px - geo.padL) / geo.slot), 0, list.length - 1)
  }
  const current = active !== null && active < list.length ? active : null
  const focus = current !== null ? list[current] : null

  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !geo || current === null) return
    const bar = geo.bars[current]
    const left = clamp(bar.cx - tip.offsetWidth / 2, 0, Math.max(0, width - tip.offsetWidth))
    let top = Math.min(bar.top, bar.base - 2) - tip.offsetHeight - 10
    if (top < -4) top = bar.base - tip.offsetHeight - 4
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  })

  const handlers = {
    onPointerDown: (event) => setActive(indexAt(event.clientX)),
    onPointerMove: (event) => { if (event.pointerType === 'mouse' || event.buttons) setActive(indexAt(event.clientX)) },
    onPointerLeave: (event) => { if (event.pointerType === 'mouse' && !tipRef.current?.contains(event.relatedTarget)) setActive(null) },
    onFocus: () => { if (current === null && list.length) setActive(list.length - 1) },
    onKeyDown: (event) => {
      if (!list.length) return
      const last = list.length - 1
      const moves = { ArrowRight: current === null ? last : Math.min(last, current + 1), ArrowLeft: current === null ? last : Math.max(0, current - 1), Home: 0, End: last, Escape: null }
      if (!(event.key in moves)) return
      // Escape with nothing selected is left for the sheet (it closes); with a day selected it only clears it.
      if (event.key === 'Escape' && current === null) return
      event.preventDefault()
      if (event.key === 'Escape') event.stopPropagation() // Sheet listens on document, above the app's root
      setActive(moves[event.key])
    },
  }

  const sinceText = since ? dayLabel(since, { month: 'short', day: 'numeric' }) : 'today'
  if (empty) return <p className="usage-empty">Usage shows here from {sinceText}.</p>

  const lines = (day) => features
    .map((feature) => ({ ...feature, usd: featureFigures(day.byFeature, feature.id).usd }))
    .filter((feature) => feature.usd > 0)

  // Tick labels about once a week, always the last day.
  const tickEvery = Math.max(1, Math.round(list.length / 4))

  return (
    <div className="usage-chart" ref={wrapRef}>
      {table ? (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption className="sr-only">AI spend per day, last 30 days</caption>
            <thead><tr><th scope="col">Day</th><th scope="col" className="is-num">Total</th><th scope="col" className="is-num">Voice</th><th scope="col" className="is-num">Other</th></tr></thead>
            <tbody>
              {[...list].reverse().map((day) => (
                <tr key={day.day}>
                  <td>{dayLabel(day.day, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className="is-num">{day.total > 0 ? formatUsd(day.total) : '—'}</td>
                  <td className="is-num">{day.voice > 0 ? formatUsd(day.voice) : '—'}</td>
                  <td className="is-num">{day.other > 0 ? formatUsd(day.other) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-plot" style={{ height }}>
          {geo && (
            <svg ref={svgRef} className="usage-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="AI spend per day, last 30 days" tabIndex={0} {...handlers}>
              <g className="usage-grid">
                {geo.scale.ticks.map((value, k) => {
                  const y = Math.round(geo.y(value)) + 0.5
                  return (
                    <g key={value}>
                      <line x1={geo.padL} x2={width - geo.padR} y1={y} y2={y} />
                      <text x={geo.padL - 8} y={y} dy="0.32em" textAnchor="end">{geo.labels[k]}</text>
                    </g>
                  )
                })}
              </g>
              <g className="usage-axis">
                {list.map((day, i) => ((list.length - 1 - i) % tickEvery === 0 ? (
                  <text key={day.day} x={clamp(geo.bars[i].cx, geo.padL + 16, width - 18)} y={height - 7} textAnchor="middle">{dayLabel(day.day, { month: 'short', day: 'numeric' })}</text>
                ) : null))}
              </g>
              {geo.bars.map((bar, i) => {
                const day = list[i]
                if (day.total <= 0) return null
                const dim = current !== null && current !== i ? ' is-dim' : ''
                const totalH = Math.max(1.5, bar.base - bar.top)
                const voiceH = day.voice > 0 ? Math.max(1.5, bar.base - bar.split) : 0
                return (
                  <g key={day.day} className={`usage-bar${dim}`}>
                    <path className="usage-bar-other" d={barPath(bar.x, bar.base - totalH, geo.barW, totalH, 3)} />
                    {voiceH > 0 && <path className="usage-bar-voice" d={barPath(bar.x, bar.base - voiceH, geo.barW, voiceH, voiceH >= totalH - 0.5 ? 3 : 0)} />}
                  </g>
                )
              })}
              {showPace && (
                <line className="usage-pace" x1={geo.padL} x2={width - geo.padR} y1={geo.y(pace)} y2={geo.y(pace)} />
              )}
            </svg>
          )}
          {geo && focus && (
            <div className="usage-tip" ref={tipRef} onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}>
              <strong>{focus.total > 0 ? formatUsd(focus.total) : '$0'}</strong>
              <span>{dayLabel(focus.day, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              {lines(focus).map((feature) => <span key={feature.id} className="usage-tip-line">{feature.label} {formatUsd(feature.usd)}</span>)}
            </div>
          )}
        </div>
      )}
      <div className="usage-keyrow">
        <span className="usage-key"><i className="is-voice" />Voice</span>
        <span className="usage-key"><i className="is-other" />Everything else</span>
        {showPace && <span className="usage-key"><i className="is-pace" />Budget pace</span>}
        <button type="button" className="usage-toggle" aria-pressed={table} onClick={() => setTable((value) => !value)}>
          <Icon name={table ? 'chart' : 'list'} size={15} />
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {pace > 0 && !showPace && <p className="usage-pace-note">Well under your budget’s pace of {formatUsd(pace)} a day.</p>}
    </div>
  )
}

// Spent against a monthly budget: a bar with a tick at 80% (where the heads-up comes).
export function BudgetMeter({ spent, budget, warnAt = 0.8, label }) {
  const pct = budget > 0 ? Math.max(0, spent) / budget : 0
  const state = pct >= 1 ? 'is-over' : pct >= warnAt ? 'is-warn' : ''
  return (
    <div
      className={`usage-meter ${state}`}
      role="meter"
      aria-label={label || 'Monthly AI budget'}
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={Math.min(budget, Math.max(0, Number(spent.toFixed(2))))}
      aria-valuetext={`${formatUsd(spent)} of ${formatUsd(budget)}`}
    >
      <span className="usage-meter-fill" style={{ width: `${Math.min(100, pct * 100)}%` }} />
      <span className="usage-meter-tick" style={{ left: `${warnAt * 100}%` }} aria-hidden="true" />
    </div>
  )
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { energyInUnit } from '../../lib/food/nutrition.js'
import { energyNumber, fmtNum, isNum, kgToUnit, shortDay, unitLabel, weekdayShort, weightUnitLabel } from './format.js'

// Food charts, following the gym charts' rules: one series colour (--food-chart), 2px lines,
// hairline grid, one y-axis, a crosshair / tooltip on hover or tap (the whole plot is the hit
// area) and a "Table" toggle with the same numbers.

const DAY_MS = 86400000
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const tidy = (value) => Number(value.toPrecision(12))
const textWidth = (text) => String(text).length * 6.4
// Whole days since 1970 for a 'YYYY-MM-DD' (UTC maths, so time zones and DST don't matter).
const dayNum = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
const tickFormats = {}
function tickLabel(t, long) {
  const key = long ? 'long' : 'short'
  if (!tickFormats[key]) tickFormats[key] = new Intl.DateTimeFormat(undefined, long ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return tickFormats[key].format(new Date(t * DAY_MS))
}

function niceScale(min, max, { count = 4, zero = false } = {}) {
  let lo = zero ? Math.min(0, min) : min
  let hi = zero ? Math.max(0, max) : max
  if (!(hi > lo)) {
    const pad = Math.abs(hi) * 0.05 || 1
    if (!zero) lo -= pad
    hi += pad
  }
  const raw = (hi - lo) / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const n = raw / magnitude
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude
  const start = tidy(Math.floor(lo / step + 1e-9) * step)
  const end = tidy(Math.ceil(hi / step - 1e-9) * step)
  const ticks = []
  for (let i = 0; start + i * step <= end + step * 1e-6 && i < 20; i++) ticks.push(tidy(start + i * step))
  return { lo: start, hi: end > start ? end : start + step, ticks }
}

function useWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

// Hover (mouse) or tap (touch) to inspect; arrow keys step through the points.
function useInspector(count, tipRef) {
  const [active, setActive] = useState(null)
  const current = active !== null && active < count ? active : null
  useEffect(() => setActive(null), [count])
  const handlers = (indexAt) => ({
    onPointerDown: (event) => setActive(indexAt(event.clientX)),
    onPointerMove: (event) => {
      if (event.pointerType === 'mouse' || event.buttons) setActive(indexAt(event.clientX))
    },
    onPointerLeave: (event) => {
      if (event.pointerType === 'mouse' && !tipRef.current?.contains(event.relatedTarget)) setActive(null)
    },
    onFocus: () => {
      if (current === null && count) setActive(count - 1)
    },
    onKeyDown: (event) => {
      if (!count) return
      const last = count - 1
      let next = current
      if (event.key === 'ArrowRight') next = current === null ? last : Math.min(last, current + 1)
      else if (event.key === 'ArrowLeft') next = current === null ? last : Math.max(0, current - 1)
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = last
      else if (event.key === 'Escape') next = null
      else return
      event.preventDefault()
      setActive(next)
    },
  })
  return { current, setActive, handlers }
}

function useTipPlacement(tipRef, anchor, width) {
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !anchor) return
    const left = clamp(anchor.x - tip.offsetWidth / 2, 0, Math.max(0, width - tip.offsetWidth))
    let top = anchor.y - tip.offsetHeight - 12
    if (top < -4) top = anchor.y + 14
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  })
}

function TableToggle({ table, onToggle }) {
  return (
    <div className="food-chart-foot">
      <button type="button" className="food-chart-toggle" aria-pressed={table} onClick={onToggle}>
        <Icon name={table ? 'chart' : 'list'} size={15} />
        {table ? 'Chart' : 'Table'}
      </button>
    </div>
  )
}

// ---- weight --------------------------------------------------------------------------------
// points: weightTrend().points — { date, kg (weigh-ins only), trend }. Pale dots for weigh-ins,
// a solid 7-day trend line and a dashed goal line.

export function WeightChart({ points, unit, targetKg, height = 210, ariaLabel = 'Weight trend' }) {
  const [wrapRef, width] = useWidth()
  const [table, setTable] = useState(false)
  const svgRef = useRef(null)
  const tipRef = useRef(null)
  const u = weightUnitLabel(unit)

  const data = useMemo(() => (Array.isArray(points) ? points : [])
    .filter((point) => point && (isNum(point.kg) || isNum(point.trend)))
    .map((point) => ({ date: point.date, t: dayNum(point.date), kg: kgToUnit(point.kg, unit), trend: kgToUnit(point.trend, unit) })), [points, unit])
  const goal = isNum(targetKg) ? kgToUnit(targetKg, unit) : null
  const weighIns = data.filter((point) => isNum(point.kg))

  const geo = useMemo(() => {
    if (data.length < 2 || width < 60) return null
    const values = data.flatMap((point) => [point.kg, point.trend]).filter(isNum)
    if (goal !== null) values.push(goal)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const pad = max > min ? (max - min) * 0.1 : 1
    const scale = niceScale(min - pad, max + pad, { count: 4 })
    const labels = scale.ticks.map((value) => fmtNum(value, 1))
    const padL = clamp(Math.max(...labels.map(textWidth)) + 12, 28, 80)
    const padR = 10
    const padT = 12
    const padB = 26
    const plotW = Math.max(20, width - padL - padR)
    const plotH = Math.max(20, height - padT - padB)
    const t0 = data[0].t
    const t1 = Math.max(data[data.length - 1].t, t0 + 1)
    const x = (t) => padL + ((t - t0) / (t1 - t0)) * plotW
    const y = (value) => padT + (1 - (value - scale.lo) / (scale.hi - scale.lo)) * plotH
    let line = ''
    let drawing = false
    for (const point of data) {
      if (!isNum(point.trend)) {
        drawing = false
        continue
      }
      line += `${drawing ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point.trend).toFixed(1)}`
      drawing = true
    }
    const spanDays = t1 - t0
    const n = clamp(Math.min(Math.floor(plotW / 76) + 1, spanDays + 1), 2, 5)
    const xTicks = []
    const seen = new Set()
    for (let k = 0; k < n; k++) {
      const t = Math.round(t0 + ((t1 - t0) * k) / (n - 1))
      const label = tickLabel(t, spanDays > 150)
      if (seen.has(label)) continue
      seen.add(label)
      xTicks.push({ x: x(t), label, anchor: k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle' })
    }
    return { padL, padR, padT, plotW, plotH, scale, labels, x, y, line, xTicks }
  }, [data, width, height, goal])

  const indexAt = (clientX) => {
    if (!geo || !svgRef.current) return 0
    const px = clientX - svgRef.current.getBoundingClientRect().left
    let best = 0
    for (let i = 1; i < data.length; i++) if (Math.abs(geo.x(data[i].t) - px) < Math.abs(geo.x(data[best].t) - px)) best = i
    return best
  }
  const { current, setActive, handlers } = useInspector(data.length, tipRef)
  const focus = current !== null ? data[current] : null
  const anchor = geo && focus ? { x: geo.x(focus.t), y: geo.y(isNum(focus.trend) ? focus.trend : focus.kg) } : null
  useTipPlacement(tipRef, anchor, width)
  const dotR = weighIns.length > 120 ? 2.5 : 3.5

  let body
  if (data.length < 2) {
    body = (
      <div className="food-chart-empty" style={{ minHeight: height }}>
        {weighIns.length === 1 && <strong>{fmtNum(weighIns[0].kg, 1)} {u}</strong>}
        <p>{weighIns.length ? 'Log a few more weigh-ins to see your trend.' : 'No weigh-ins in this range.'}</p>
      </div>
    )
  } else if (table) {
    body = (
      <div className="food-chart-table-wrap" style={{ maxHeight: Math.max(height + 60, 260) }}>
        <table className="food-chart-table">
          <caption className="sr-only">{ariaLabel}</caption>
          <thead><tr><th scope="col">Date</th><th scope="col" className="is-num">Weigh-in</th><th scope="col" className="is-num">Trend</th></tr></thead>
          <tbody>
            {weighIns.slice().reverse().map((point) => (
              <tr key={point.date}>
                <td>{shortDay(point.date)}</td>
                <td className="is-num">{fmtNum(point.kg, 1)}</td>
                <td className="is-num">{isNum(point.trend) ? fmtNum(point.trend, 1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="food-chart-plot" style={{ height }}>
        {geo && (
          <svg ref={svgRef} className="food-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} tabIndex={0} {...handlers(indexAt)}>
            <g className="food-chart-grid">
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
            <g className="food-chart-axis">
              {geo.xTicks.map((tick) => <text key={`${tick.label}-${tick.x}`} x={tick.x} y={height - 8} textAnchor={tick.anchor}>{tick.label}</text>)}
            </g>
            {goal !== null && (
              <g className="food-chart-goal">
                <line x1={geo.padL} x2={width - geo.padR} y1={geo.y(goal)} y2={geo.y(goal)} />
                <text x={width - geo.padR - 2} y={geo.y(goal) - 6} textAnchor="end">Goal {fmtNum(goal, 1)}</text>
              </g>
            )}
            {weighIns.map((point) => <circle key={point.date} className="food-chart-raw" cx={geo.x(point.t)} cy={geo.y(point.kg)} r={dotR} />)}
            {geo.line && <path className="food-chart-line" d={geo.line} />}
            {focus && (
              <>
                <line className="food-chart-cross" x1={geo.x(focus.t)} x2={geo.x(focus.t)} y1={geo.padT} y2={geo.padT + geo.plotH} />
                {isNum(focus.trend) && (
                  <g>
                    <circle className="food-chart-ring" cx={geo.x(focus.t)} cy={geo.y(focus.trend)} r={7} />
                    <circle className="food-chart-dot" cx={geo.x(focus.t)} cy={geo.y(focus.trend)} r={5} />
                  </g>
                )}
              </>
            )}
          </svg>
        )}
        {geo && focus && (
          <div className="food-chart-tip" ref={tipRef} onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}>
            <strong>{isNum(focus.trend) ? `${fmtNum(focus.trend, 1)} ${u}` : `${fmtNum(focus.kg, 1)} ${u}`}</strong>
            <span>{shortDay(focus.date)}{isNum(focus.trend) ? ' · trend' : ''}</span>
            {isNum(focus.kg) && isNum(focus.trend) && <span>Weighed {fmtNum(focus.kg, 1)} {u}</span>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="food-chart" ref={wrapRef}>
      {body}
      {data.length >= 2 && (
        <div className="food-chart-keyrow">
          <span className="food-chart-key"><i className="is-line" />7-day trend</span>
          <span className="food-chart-key"><i className="is-dot" />Weigh-ins</span>
          {goal !== null && <span className="food-chart-key"><i className="is-goal" />Goal</span>}
          <TableToggle table={table} onToggle={() => setTable((value) => !value)} />
        </div>
      )}
    </div>
  )
}

// ---- calories per day ----------------------------------------------------------------------
// days: weeklyInsights().days. Bars for logged days (today lighter while in progress, outlined
// when under half the goal: maybe incomplete, amber when more than 10% over), the goal as a
// dashed line inside a ±10% band. Tapping a bar offers to open that day.

function barPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`
}

export function CalorieBars({ days, goal, unit, onOpen, height = 190 }) {
  const [wrapRef, width] = useWidth()
  const [table, setTable] = useState(false)
  const svgRef = useRef(null)
  const tipRef = useRef(null)
  const list = Array.isArray(days) ? days : []
  const goalValue = isNum(goal) && goal > 0 ? energyInUnit(goal, unit) : null

  const geo = useMemo(() => {
    if (!list.length || width < 60) return null
    const values = list.map((day) => (day.logged ? energyInUnit(day.calories, unit) : 0))
    const max = Math.max(1, ...values, goalValue ? goalValue * 1.1 : 0)
    const scale = niceScale(0, max, { count: height >= 160 ? 4 : 3, zero: true })
    const labels = scale.ticks.map((value) => fmtNum(value, 0))
    const padL = clamp(Math.max(...labels.map(textWidth)) + 12, 28, 80)
    const padR = 4
    const padT = 12
    const padB = 26
    const plotW = Math.max(20, width - padL - padR)
    const plotH = Math.max(20, height - padT - padB)
    const slot = plotW / list.length
    const barW = Math.max(4, Math.min(24, slot * 0.58))
    const y = (value) => padT + (1 - value / scale.hi) * plotH
    const rects = list.map((day, i) => {
      const value = values[i]
      const top = y(value)
      return { x: padL + slot * i + (slot - barW) / 2, y: top, h: padT + plotH - top, cx: padL + slot * (i + 0.5), value }
    })
    return { padL, padR, padT, plotW, plotH, slot, barW, scale, labels, rects, y }
  }, [list, width, height, unit, goalValue])

  const indexAt = (clientX) => {
    if (!geo || !svgRef.current) return 0
    const px = clientX - svgRef.current.getBoundingClientRect().left
    return clamp(Math.floor((px - geo.padL) / geo.slot), 0, list.length - 1)
  }
  const { current, setActive, handlers } = useInspector(list.length, tipRef)
  const focus = current !== null ? list[current] : null
  const anchor = geo && focus ? { x: geo.rects[current].cx, y: Math.min(geo.rects[current].y, geo.padT + geo.plotH - 2) } : null
  useTipPlacement(tipRef, anchor, width)

  const statusText = (day) => {
    if (day.future) return 'Coming up'
    if (!day.logged) return 'Nothing logged'
    if (!goal) return day.inProgress ? 'So far today' : ''
    const diff = Math.round(energyInUnit(day.calories - goal, unit))
    const text = diff === 0 ? 'On goal' : `${energyNumber(Math.abs(day.calories - goal), unit)} ${diff > 0 ? 'over' : 'under'}`
    return day.inProgress ? `${text} so far` : day.maybeIncomplete ? `${text} · maybe incomplete` : text
  }

  let body
  if (table) {
    body = (
      <div className="food-chart-table-wrap">
        <table className="food-chart-table">
          <caption className="sr-only">Calories per day</caption>
          <thead><tr><th scope="col">Day</th><th scope="col" className="is-num">{unitLabel(unit)}</th><th scope="col">vs goal</th></tr></thead>
          <tbody>
            {list.map((day) => (
              <tr key={day.date}>
                <td>{onOpen && !day.future ? <button type="button" className="food-chart-table-link" onClick={() => onOpen(day.date)}>{shortDay(day.date)}</button> : shortDay(day.date)}</td>
                <td className="is-num">{day.logged ? energyNumber(day.calories, unit) : '—'}</td>
                <td className="food-chart-table-sub">{statusText(day)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="food-chart-plot" style={{ height }}>
        {geo && (
          <svg ref={svgRef} className="food-chart-svg is-clickable" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Calories per day this week" tabIndex={0} {...handlers(indexAt)}>
            {goalValue && (
              <rect className="food-chart-band" x={geo.padL} width={geo.plotW} y={geo.y(goalValue * 1.1)} height={Math.max(0, geo.y(goalValue * 0.9) - geo.y(goalValue * 1.1))} />
            )}
            <g className="food-chart-grid">
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
            <g className="food-chart-axis">
              {list.map((day, i) => (
                <text key={day.date} x={geo.rects[i].cx} y={height - 8} textAnchor="middle" className={day.inProgress ? 'is-today' : ''}>{weekdayShort(day.date)}</text>
              ))}
            </g>
            {geo.rects.map((rect, i) => {
              const day = list[i]
              if (!day.logged || rect.h < 0.5) return null
              const over = day.calorieStatus === 'over'
              const cls = `food-chart-bar${over ? ' is-over' : ''}${day.inProgress ? ' is-progress' : ''}${day.maybeIncomplete && !day.inProgress ? ' is-hollow' : ''}${current !== null && current !== i ? ' is-dim' : ''}`
              return <path key={day.date} className={cls} d={barPath(rect.x, rect.y, geo.barW, rect.h, 4)} />
            })}
            {goalValue && (
              <g className="food-chart-goal">
                <line x1={geo.padL} x2={width - geo.padR} y1={geo.y(goalValue)} y2={geo.y(goalValue)} />
              </g>
            )}
          </svg>
        )}
        {geo && focus && (
          <div className="food-chart-tip" ref={tipRef} onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}>
            <strong>{focus.logged ? `${energyNumber(focus.calories, unit)} ${unitLabel(unit)}` : '—'}</strong>
            <span>{shortDay(focus.date)}{statusText(focus) ? ` · ${statusText(focus)}` : ''}</span>
            {onOpen && !focus.future && (
              <button type="button" className="food-chart-tip-action" onClick={() => onOpen(focus.date)}>
                Open day<Icon name="chevronRight" size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="food-chart" ref={wrapRef}>
      {body}
      <div className="food-chart-keyrow">
        {goalValue && <span className="food-chart-key"><i className="is-band" />Goal ±10%</span>}
        {list.some((day) => day.calorieStatus === 'over') && <span className="food-chart-key"><i className="is-over" />Over</span>}
        {list.some((day) => day.maybeIncomplete && !day.inProgress) && <span className="food-chart-key"><i className="is-hollow" />Maybe incomplete</span>}
        <TableToggle table={table} onToggle={() => setTable((value) => !value)} />
      </div>
    </div>
  )
}

// ---- sparkline -----------------------------------------------------------------------------

export function Sparkline({ values, width = 88, height = 30 }) {
  const list = (Array.isArray(values) ? values : []).filter(isNum)
  if (list.length < 2) return null
  const min = Math.min(...list)
  const max = Math.max(...list)
  const span = max - min || 1
  const pad = 3
  const x = (i) => pad + (i / (list.length - 1)) * (width - pad * 2)
  const y = (value) => pad + (1 - (value - min) / span) * (height - pad * 2)
  const d = list.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join('')
  const last = list.length - 1
  return (
    <svg className="food-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <circle cx={x(last)} cy={y(list[last])} r={3} />
    </svg>
  )
}


import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { formatDateShort, parseISO } from '../../lib/dates.js'
import './gym-common.css'
import './exercises.css'

// Single-series SVG charts for the gym screens. One colour (--gym-chart), no legend (the section
// title names the series), hairline grid, one y-axis, crosshair + tooltip on hover/tap (the whole
// plot is the hit area, nearest point by x), and a "Table" toggle with the same data.

const DAY = 86400000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const tidy = (value) => Number(value.toPrecision(12))

let compactFormat = null
function compactNumber(value) {
  if (!compactFormat) compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
  return compactFormat.format(value)
}
const defaultFormat = (value) => (isNum(value) ? String(tidy(Math.round(value * 100) / 100)) : '—')

let dayFormat = null
let monthFormat = null
function axisDate(ms, spanDays) {
  const date = new Date(ms)
  if (spanDays >= 150) {
    if (!monthFormat) monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short' })
    return `${monthFormat.format(date)} ’${String(date.getFullYear()).slice(2)}`
  }
  if (!dayFormat) dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat.format(date)
}

// Rough label width at 11px (the axis font); good enough to reserve the left gutter.
const textWidth = (text) => String(text).length * 6.4

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]

function niceStep(span, count, time = false) {
  const raw = span / Math.max(1, count)
  if (time) return TIME_STEPS.find((step) => step >= raw) || Math.ceil(raw / 3600) * 3600
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const n = raw / magnitude
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude
}

// Round domain and ticks around [min, max]; `zero` anchors at 0, `integer` keeps whole steps.
function niceScale(min, max, { count = 4, zero = false, integer = false, time = false } = {}) {
  let lo = zero ? Math.min(0, min) : min
  let hi = zero ? Math.max(0, max) : max
  if (!(hi > lo)) {
    const pad = Math.abs(hi) * 0.05 || 1
    if (!zero) lo -= pad
    hi += pad
  }
  let step = niceStep(hi - lo, count, time)
  if (integer) step = Math.max(1, Math.ceil(step))
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

// Shared pointer/keyboard behaviour: mouse hovers to inspect and clicks to open; touch taps to
// inspect and taps the same point again (or the tooltip button) to open.
function useInspector(count, onOpen, tipRef) {
  const [active, setActive] = useState(null)
  const pointerType = useRef('mouse')
  const activeAtDown = useRef(null)
  const pressing = useRef(false)
  const current = active !== null && active < count ? active : null

  useEffect(() => {
    setActive(null)
  }, [count])

  const handlers = (indexAt) => ({
    onPointerDown: (event) => {
      pointerType.current = event.pointerType || 'mouse'
      pressing.current = true
      activeAtDown.current = current
      setActive(indexAt(event.clientX))
    },
    onPointerUp: () => {
      pressing.current = false
    },
    onPointerCancel: () => {
      pressing.current = false
    },
    onPointerMove: (event) => {
      if (event.pointerType === 'mouse' || event.buttons) setActive(indexAt(event.clientX))
    },
    onPointerLeave: (event) => {
      // Moving onto the tooltip's button keeps it open.
      if (event.pointerType === 'mouse' && !tipRef?.current?.contains(event.relatedTarget)) setActive(null)
    },
    onClick: (event) => {
      const index = indexAt(event.clientX)
      if (pointerType.current === 'mouse' || activeAtDown.current === index) onOpen(index)
    },
    onFocus: () => {
      if (!pressing.current && current === null && count) setActive(count - 1)
    },
    onKeyDown: (event) => {
      if (!count) return
      const last = count - 1
      let next = current
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current === null ? last : Math.min(last, current + 1)
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current === null ? last : Math.max(0, current - 1)
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = last
      else if (event.key === 'Escape') next = null
      else if (event.key === 'Enter' || event.key === ' ') {
        if (current !== null) {
          event.preventDefault()
          onOpen(current)
        }
        return
      } else return
      event.preventDefault()
      setActive(next)
    },
  })

  return { current, setActive, handlers }
}

// Keeps the tooltip inside the chart: centred over the mark, above it when there is room.
function useTipPlacement(tipRef, anchor, width) {
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !anchor) return
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    const left = clamp(anchor.x - w / 2, 0, Math.max(0, width - w))
    let top = anchor.y - h - 12
    if (top < -4) top = anchor.y + 14
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  })
}

function TableToggle({ table, onToggle }) {
  return (
    <div className="gym-chart-foot">
      <button type="button" className="gym-chart-toggle" aria-pressed={table} onClick={onToggle}>
        <Icon name={table ? 'chart' : 'list'} size={15} />
        {table ? 'Chart' : 'Table'}
      </button>
    </div>
  )
}

// ---- line ----------------------------------------------------------------------------------

export function LineChart({ points, formatY = defaultFormat, formatTick, height = 180, ariaLabel = 'Line chart', actionLabel = 'Open', emptyText = 'Log 2+ workouts to see a trend', timeAxis = false }) {
  const [wrapRef, width] = useWidth()
  const [table, setTable] = useState(false)
  const svgRef = useRef(null)
  const tipRef = useRef(null)

  const data = useMemo(() => (Array.isArray(points) ? points : [])
    .filter((point) => point && isNum(point.y) && typeof point.x === 'string' && ISO_DATE.test(point.x))
    .map((point, index) => ({ ...point, t: parseISO(point.x).getTime(), index }))
    .sort((a, b) => a.t - b.t || a.index - b.index), [points])

  const geo = useMemo(() => {
    if (data.length < 2 || width < 40) return null
    const ys = data.map((point) => point.y)
    const min = Math.min(...ys)
    const max = Math.max(...ys)
    const pad = max > min ? (max - min) * 0.12 : Math.abs(max) * 0.05 || 1
    const scale = niceScale(min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad, { count: height >= 160 ? 4 : 3, time: timeAxis })
    const tick = formatTick || formatY
    const labels = scale.ticks.map((value) => String(tick(value)))
    const padL = clamp(Math.max(...labels.map(textWidth)) + 12, 28, 110)
    const padR = 12
    const padT = 12
    const padB = 26
    const plotW = Math.max(20, width - padL - padR)
    const plotH = Math.max(20, height - padT - padB)
    const t0 = data[0].t
    const t1 = data[data.length - 1].t
    const byIndex = t1 - t0 < DAY / 2
    const xs = data.map((point, i) => padL + (byIndex ? (plotW * i) / (data.length - 1) : ((point.t - t0) / (t1 - t0)) * plotW))
    const y = (value) => padT + (1 - (value - scale.lo) / (scale.hi - scale.lo)) * plotH
    const pts = data.map((point, i) => ({ x: xs[i], y: y(point.y) }))
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')
    const base = padT + plotH
    const area = `${line}L${pts[pts.length - 1].x.toFixed(1)},${base}L${pts[0].x.toFixed(1)},${base}Z`
    const spanDays = (t1 - t0) / DAY
    let xTicks
    if (byIndex) {
      xTicks = [{ x: padL + plotW / 2, label: formatDateShort(data[0].x), anchor: 'middle' }]
    } else {
      const n = clamp(Math.min(Math.floor(plotW / 72) + 1, Math.round(spanDays) + 1), 2, 5)
      xTicks = []
      const seen = new Set()
      for (let k = 0; k < n; k++) {
        const label = axisDate(t0 + ((t1 - t0) * k) / (n - 1), spanDays)
        if (seen.has(label)) continue
        seen.add(label)
        xTicks.push({ x: padL + (plotW * k) / (n - 1), label, anchor: k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle' })
      }
    }
    return { padL, padR, padT, plotW, plotH, scale, labels, xs, pts, line, area, xTicks, y }
  }, [data, width, height, formatY, formatTick, timeAxis])

  const indexAt = (clientX) => {
    if (!geo || !svgRef.current) return 0
    const x = clientX - svgRef.current.getBoundingClientRect().left
    let best = 0
    for (let i = 1; i < geo.xs.length; i++) if (Math.abs(geo.xs[i] - x) < Math.abs(geo.xs[best] - x)) best = i
    return best
  }
  const open = (index) => data[index]?.onClick?.()
  const { current, setActive, handlers } = useInspector(data.length, open, tipRef)
  const anchor = geo && current !== null ? geo.pts[current] : null
  useTipPlacement(tipRef, anchor, width)

  const clickable = data.some((point) => typeof point.onClick === 'function')
  const showDots = data.length <= 20
  const last = data.length - 1

  let body
  if (data.length < 2) {
    body = (
      <div className="gym-chart-empty" style={{ minHeight: height }}>
        {data.length === 1 && (
          <>
            <strong>{formatY(data[0].y)}</strong>
            <span>{formatDateShort(data[0].x)}{data[0].label ? ` · ${data[0].label}` : ''}</span>
          </>
        )}
        <p>{emptyText}</p>
      </div>
    )
  } else if (table) {
    body = (
      <div className="gym-chart-table-wrap" style={{ maxHeight: Math.max(height + 60, 240) }}>
        <table className="gym-chart-table">
          <caption className="sr-only">{ariaLabel}</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col" className="is-num">Value</th></tr>
          </thead>
          <tbody>
            {data.slice().reverse().map((point) => (
              <tr key={`${point.x}-${point.index}`}>
                <td>
                  {point.onClick ? (
                    <button type="button" className="gym-chart-table-link" onClick={point.onClick}>{formatDateShort(point.x)}</button>
                  ) : formatDateShort(point.x)}
                  {point.label && <span className="gym-chart-table-sub">{point.label}</span>}
                </td>
                <td className="is-num">{formatY(point.y)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="gym-chart-plot" style={{ height }}>
        {geo && (
          <svg
            ref={svgRef}
            className={`gym-chart-svg${clickable ? ' is-clickable' : ''}`}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            {...handlers(indexAt)}
          >
            <g className="gym-chart-grid">
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
            <g className="gym-chart-axis">
              {geo.xTicks.map((tick) => (
                <text key={`${tick.label}-${tick.x}`} x={tick.x} y={height - 8} textAnchor={tick.anchor}>{tick.label}</text>
              ))}
            </g>
            <path className="gym-chart-area" d={geo.area} />
            <path className="gym-chart-line" d={geo.line} />
            {current !== null && (
              <line className="gym-chart-cross" x1={geo.pts[current].x} x2={geo.pts[current].x} y1={geo.padT} y2={geo.padT + geo.plotH} />
            )}
            {showDots && geo.pts.map((p, i) => (i === last || i === current ? null : (
              <g key={i}>
                <circle className="gym-chart-ring" cx={p.x} cy={p.y} r={6} />
                <circle className="gym-chart-dot" cx={p.x} cy={p.y} r={4} />
              </g>
            )))}
            {current !== last && (
              <g>
                <circle className="gym-chart-ring" cx={geo.pts[last].x} cy={geo.pts[last].y} r={6.5} />
                <circle className="gym-chart-dot" cx={geo.pts[last].x} cy={geo.pts[last].y} r={4.5} />
              </g>
            )}
            {current !== null && (
              <g>
                <circle className="gym-chart-ring" cx={geo.pts[current].x} cy={geo.pts[current].y} r={7.5} />
                <circle className="gym-chart-dot" cx={geo.pts[current].x} cy={geo.pts[current].y} r={5.5} />
              </g>
            )}
          </svg>
        )}
        {geo && current !== null && (
          <div className="gym-chart-tip" ref={tipRef}>
            <strong>{formatY(data[current].y)}</strong>
            <span>{formatDateShort(data[current].x)}{data[current].label ? ` · ${data[current].label}` : ''}</span>
            {data[current].onClick && (
              <button
                type="button"
                className="gym-chart-tip-action"
                onClick={data[current].onClick}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse' && !svgRef.current?.contains(event.relatedTarget)) setActive(null)
                }}
              >
                {actionLabel}
                <Icon name="chevronRight" size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="gym-chart" ref={wrapRef}>
      {body}
      {data.length >= 2 && <TableToggle table={table} onToggle={() => setTable((value) => !value)} />}
    </div>
  )
}

// ---- bars ----------------------------------------------------------------------------------

function barPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`
}

export function BarChart({ bars, formatValue = defaultFormat, formatTick, band, bandLabel, height = 180, ariaLabel = 'Bar chart' }) {
  const [wrapRef, width] = useWidth()
  const [table, setTable] = useState(false)
  const svgRef = useRef(null)
  const tipRef = useRef(null)

  const data = useMemo(() => (Array.isArray(bars) ? bars : [])
    .filter(Boolean)
    .map((bar, index) => ({ ...bar, key: bar.key ?? index, value: isNum(bar.value) ? Math.max(0, bar.value) : 0 })), [bars])
  const bandRange = Array.isArray(band) && isNum(band[0]) && isNum(band[1]) && band[1] > band[0] ? band : null

  const geo = useMemo(() => {
    if (!data.length || width < 40) return null
    const values = data.map((bar) => bar.value)
    const max = Math.max(0, ...values, bandRange ? bandRange[1] : 0)
    const integer = values.every(Number.isInteger)
    const scale = niceScale(0, max, { count: height >= 160 ? 4 : 3, zero: true, integer })
    const tick = formatTick || compactNumber
    const labels = scale.ticks.map((value) => String(tick(value)))
    const padL = clamp(Math.max(...labels.map(textWidth)) + 12, 24, 96)
    const padR = 4
    const padT = 10
    const padB = 26
    const plotW = Math.max(20, width - padL - padR)
    const plotH = Math.max(20, height - padT - padB)
    const slot = plotW / data.length
    const barW = Math.max(2, Math.min(24, slot * 0.62, slot - 2))
    const y = (value) => padT + (1 - value / scale.hi) * plotH
    const rects = data.map((bar, i) => {
      const top = y(bar.value)
      return { x: padL + slot * i + (slot - barW) / 2, y: top, h: padT + plotH - top, cx: padL + slot * (i + 0.5) }
    })
    const maxLabels = Math.max(1, Math.min(data.length, Math.floor(plotW / 58)))
    const every = Math.ceil(data.length / maxLabels)
    const labelled = new Set(data.map((_, i) => i).filter((i) => (data.length - 1 - i) % every === 0))
    return { padL, padR, padT, plotW, plotH, slot, barW, scale, labels, rects, labelled, y }
  }, [data, width, height, formatTick, bandRange?.[0], bandRange?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  const indexAt = (clientX) => {
    if (!geo || !svgRef.current) return 0
    const x = clientX - svgRef.current.getBoundingClientRect().left
    return clamp(Math.floor((x - geo.padL) / geo.slot), 0, data.length - 1)
  }
  const { current, handlers } = useInspector(data.length, () => {}, tipRef)
  const anchor = geo && current !== null ? { x: geo.rects[current].cx, y: Math.min(geo.rects[current].y, geo.padT + geo.plotH - 2) } : null
  useTipPlacement(tipRef, anchor, width)

  let body
  if (!data.length) {
    body = <div className="gym-chart-empty" style={{ minHeight: height }}><p>No data yet</p></div>
  } else if (table) {
    body = (
      <div className="gym-chart-table-wrap" style={{ maxHeight: Math.max(height + 60, 240) }}>
        <table className="gym-chart-table">
          <caption className="sr-only">{ariaLabel}</caption>
          <thead>
            <tr><th scope="col">Period</th><th scope="col" className="is-num">Value</th></tr>
          </thead>
          <tbody>
            {data.slice().reverse().map((bar) => (
              <tr key={bar.key}>
                <td>{bar.label}{bar.sub && <span className="gym-chart-table-sub">{bar.sub}</span>}</td>
                <td className="is-num">{formatValue(bar.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="gym-chart-plot" style={{ height }}>
        {geo && (
          <svg
            ref={svgRef}
            className="gym-chart-svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            {...handlers(indexAt)}
          >
            {bandRange && (
              <g className="gym-chart-band">
                <rect x={geo.padL} width={geo.plotW} y={geo.y(bandRange[1])} height={geo.y(bandRange[0]) - geo.y(bandRange[1])} />
                <text x={width - geo.padR - 6} y={geo.y(bandRange[1]) + 13} textAnchor="end">{bandLabel || `${bandRange[0]}–${bandRange[1]}`}</text>
              </g>
            )}
            <g className="gym-chart-grid">
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
            <g className="gym-chart-axis">
              {data.map((bar, i) => (geo.labelled.has(i) ? (
                <text key={bar.key} x={clamp(geo.rects[i].cx, geo.padL + textWidth(bar.label) / 2, width - geo.padR - textWidth(bar.label) / 2)} y={height - 8} textAnchor="middle">{bar.label}</text>
              ) : null))}
            </g>
            {geo.rects.map((rect, i) => (rect.h >= 0.5 ? (
              <path
                key={data[i].key}
                className={`gym-chart-bar${current !== null && current !== i ? ' is-dim' : ''}`}
                d={barPath(rect.x, rect.y, geo.barW, rect.h, 4)}
              />
            ) : null))}
          </svg>
        )}
        {geo && current !== null && (
          <div className="gym-chart-tip" ref={tipRef}>
            <strong>{formatValue(data[current].value)}</strong>
            <span>{data[current].label}{data[current].sub ? ` · ${data[current].sub}` : ''}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="gym-chart" ref={wrapRef}>
      {body}
      {data.length > 0 && <TableToggle table={table} onToggle={() => setTable((value) => !value)} />}
    </div>
  )
}

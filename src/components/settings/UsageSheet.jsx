import { useEffect, useId, useMemo, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import Sheet from '../ui/Sheet.jsx'
import Disclosure from '../ui/Disclosure.jsx'
import { Button, Segmented } from '../ui/primitives.jsx'
import { FEATURES } from '../../lib/aiLedger.js'
import { PRICES_CHECKED, REALTIME_PRICES, TEXT_PRICES, TRANSCRIBE_PER_MIN, WEB_SEARCH_PER_CALL, capCeiling, estimateMonth, formatUsd } from '../../lib/aiPricing.js'
import { BUDGET_WARN, VOICE_OPTIONS } from '../../lib/voice/prefs.js'
import { featureFigures } from '../../lib/aiUsageClient.js'
import UsageBars, { BudgetMeter } from './UsageBars.jsx'
import './usage.css'

// Settings → Voice & AI cost → "Usage & cost calculator": what Daybook's AI features have cost
// (today, this month, last month; by feature; the last 30 days) and an "Estimate a month"
// calculator that uses the owner's own measured rates once there are enough of them. The numbers
// are worked out from the usage OpenAI reports with each reply; the OpenAI bill is the final word.

const PERIODS = [{ id: 'today', label: 'Today' }, { id: 'month', label: 'This month' }, { id: 'lastMonth', label: 'Last month' }]
const FEATURE_ICONS = { voice: 'waveform', chat: 'message', note: 'mic', food: 'utensils', brief: 'sunrise' }
const VOICE_MODEL = 'gpt-realtime-2.1-mini'
const TEXT_MODEL = 'gpt-5-mini'
const USAGE_URL = 'https://platform.openai.com/usage'

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
// "About $14 a month": whole dollars from $10, cents below.
export const roughUsd = (usd) => (usd >= 9.995 ? `$${Math.round(usd).toLocaleString('en-US')}` : formatUsd(usd))
const minutesText = (seconds) => (seconds > 0 && seconds < 60 ? '<1 min' : `${Math.round(seconds / 60)} min`)
const round5 = (value) => Math.max(0, Math.min(60, Math.round((Number(value) || 0) / 5) * 5))
const nearest = (value, options) => options.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), options[0])

function monthName(key, options = { month: 'long' }) {
  if (!/^\d{4}-\d{2}$/.test(String(key || ''))) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`))
  } catch {
    return ''
  }
}
export function shortDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
  } catch {
    return iso
  }
}
// The last day of the summary's month ('Oct 31').
const monthEnd = (summary) => (summary?.month?.key && summary.daysInMonth ? shortDate(`${summary.month.key}-${String(summary.daysInMonth).padStart(2, '0')}`) : '')

// What a feature's line says beside its amount ("42 min · 9 calls", "118 messages").
function featureDetail(id, figures) {
  const { n, seconds } = figures
  if (id === 'voice') return n || seconds ? `${minutesText(seconds)} · ${plural(n, 'call', 'calls')}` : ''
  if (!n) return ''
  if (id === 'chat') return plural(n, 'message', 'messages')
  if (id === 'note') return plural(n, 'voice note', 'voice notes')
  if (id === 'food') return plural(n, 'lookup', 'lookups')
  if (id === 'brief') return plural(n, 'note', 'notes')
  return plural(n, 'use', 'uses')
}

// usage: useAiUsage() from the settings section. prefs: voicePrefs(settings). budget: budgetUsd(settings).
export default function UsageSheet({ open, onClose, usage, prefs, budget }) {
  const [period, setPeriod] = useState('month')
  const summary = usage?.summary || null
  const unavailable = usage?.available === false

  let body
  if (unavailable) {
    body = <p className="usage-note">Usage tracking needs the 2026-09-23 database update.</p>
  } else if (!summary) {
    body = usage?.loading || !usage?.error
      ? <p className="usage-note" role="status">Loading your usage…</p>
      : (
        <div className="usage-note">
          <p>{usage.error}</p>
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => usage.refresh?.()}>Try again</Button>
        </div>
      )
  } else {
    body = (
      <>
        <Segmented options={PERIODS} value={period} onChange={setPeriod} label="Period" className="usage-periods" />
        <PeriodTotals summary={summary} period={period} budget={budget} />
        <FeatureList summary={summary} period={period} />
        <section className="usage-section" aria-labelledby="usage-30-title">
          <h3 id="usage-30-title" className="usage-heading">Last 30 days</h3>
          <UsageBars days={summary.last30} budgetUsd={budget} daysInMonth={summary.daysInMonth} since={summary.since || ''} features={FEATURES} />
        </section>
      </>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title="AI usage" description="What Daybook’s AI features have cost on your OpenAI account." initialFocus={false} grouped>
      <div className="usage-sheet">
        {body}
        <Estimate summary={summary} prefs={prefs} budget={budget} />
        <Disclosure id="usage-assumptions" label="How this is worked out" className="usage-disclosure">
          <Assumptions since={summary?.since} />
        </Disclosure>
      </div>
    </Sheet>
  )
}

function PeriodTotals({ summary, period, budget }) {
  const totals = period === 'today' ? summary.today : period === 'lastMonth' ? summary.lastMonth : summary.month
  const total = Number(totals?.total) || 0
  const spent = Number(summary.month?.total) || 0
  const resets = shortDate(summary.budget?.resetsOn)
  return (
    <div className="usage-totals">
      <p className="usage-big" aria-live="polite">{formatUsd(total)}</p>
      {period === 'today' && <p className="usage-sub">So far today</p>}
      {period === 'lastMonth' && <p className="usage-sub">{monthName(summary.lastMonth?.key) || 'Last month'}</p>}
      {period === 'month' && (
        <>
          <p className="usage-sub">{monthName(summary.month?.key) || 'This month'}{Number(summary.projected) > total ? ` · on pace for ${formatUsd(summary.projected)}${monthEnd(summary) ? ` by ${monthEnd(summary)}` : ''}` : ''}</p>
          {budget > 0 && (
            <div className="usage-budget">
              <BudgetMeter spent={spent} budget={budget} warnAt={BUDGET_WARN} />
              <p className="usage-sub">{formatUsd(spent)} of your {formatUsd(budget)} budget{resets ? ` · resets ${resets}` : ''}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FeatureList({ summary, period }) {
  const totals = period === 'today' ? summary.today : period === 'lastMonth' ? summary.lastMonth : summary.month
  const unpriced = Array.isArray(summary.unpriced) ? summary.unpriced.filter(Boolean) : []
  return (
    <section className="usage-section" aria-labelledby="usage-features-title">
      <h3 id="usage-features-title" className="usage-heading">By feature</h3>
      <ul className="usage-features">
        {FEATURES.map((feature) => {
          const figures = featureFigures(totals?.byFeature, feature.id)
          const detail = featureDetail(feature.id, figures)
          const quiet = !figures.usd && !figures.n
          return (
            <li key={feature.id} className={quiet ? 'is-quiet' : ''}>
              <span className="usage-feature-icon" aria-hidden="true"><Icon name={FEATURE_ICONS[feature.id] || 'sparkles'} size={17} /></span>
              <span className="usage-feature-text">
                <strong>{feature.label}</strong>
                {detail && <small>{detail}</small>}
                {feature.id === 'voice' && figures.handoffUsd > 0 && <small>incl. {formatUsd(figures.handoffUsd)} handed to the full assistant</small>}
              </span>
              <span className="usage-feature-usd">{figures.usd > 0 ? formatUsd(figures.usd) : '—'}</span>
            </li>
          )
        })}
      </ul>
      {unpriced.length > 0 && <p className="usage-note">Some usage is priced at fallback rates (a model this version doesn’t know: {unpriced.slice(0, 3).join(', ')}).</p>}
    </section>
  )
}

function Slider({ label, value, min, max, step, onChange, valueText }) {
  const id = useId()
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <div className="usage-slider">
      <div className="usage-slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{valueText}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-valuetext={valueText} style={{ '--fill': `${fill}%` }} />
    </div>
  )
}

// "Estimate a month": voice minutes a day, call length and typed messages a day → about $X a month,
// with a range, using the owner's own rates when there's enough data ("from your usage").
function Estimate({ summary, prefs, budget }) {
  const averages = summary?.averages || null
  const [voiceMin, setVoiceMin] = useState(() => round5(prefs.enabled ? prefs.dailyMinutes : 0))
  const [callMin, setCallMin] = useState(prefs.sessionMinutes)
  const [chatPerDay, setChatPerDay] = useState(() => (averages?.chatPerDay ? Math.max(5, round5(averages.chatPerDay)) : 10))
  // The daily limit or call length changed in Settings while the sheet was closed: start from them.
  useEffect(() => { setCallMin(prefs.sessionMinutes) }, [prefs.sessionMinutes])

  const estimate = useMemo(() => estimateMonth({ voiceMinutesPerDay: voiceMin, callMinutes: callMin, chatPerDay, measured: summary?.perUnit || {} }), [voiceMin, callMin, chatPerDay, summary])
  const ceiling = capCeiling({ dailyMinutes: prefs.dailyMinutes, sessionMinutes: prefs.sessionMinutes, budgetUsd: budget })
  // The what-if above ignores the limits; when they would cut it short, say where it stops (voice at
  // its cap, everything at the monthly budget).
  const cappedTotal = (() => {
    let total = (prefs.enabled ? Math.min(estimate.voice, ceiling.capped) : 0) + estimate.chat
    if (budget > 0) total = Math.min(total, budget)
    return total
  })()
  const limited = cappedTotal < estimate.total - 0.5 ? cappedTotal : null
  const enoughData = (Number(averages?.days) || 0) >= 3
  const tag = (basis) => (basis === 'yours' ? 'from your usage' : 'typical')

  function applyAverages() {
    if (!averages) return
    setVoiceMin(round5(averages.voiceMinutesPerDay))
    if (Number(averages.callMinutes) > 0) setCallMin(nearest(Number(averages.callMinutes), VOICE_OPTIONS.sessionMinutes))
    setChatPerDay(round5(averages.chatPerDay))
  }

  return (
    <section className="usage-section usage-estimate" aria-labelledby="usage-estimate-title">
      <h3 id="usage-estimate-title" className="usage-heading">Estimate a month</h3>
      <Slider label="Voice chat a day" value={voiceMin} min={0} max={60} step={5} onChange={setVoiceMin} valueText={voiceMin ? `${voiceMin} min` : 'None'} />
      <div className="usage-slider">
        <div className="usage-slider-head"><span className="usage-slider-label">Typical call</span></div>
        <Segmented options={VOICE_OPTIONS.sessionMinutes.map((value) => ({ id: value, label: `${value} min` }))} value={callMin} onChange={setCallMin} label="Typical call length" />
        <p className="usage-hint">Shorter calls cost less a minute: every reply re-reads the whole call.</p>
      </div>
      <Slider label="Typed messages a day" value={chatPerDay} min={0} max={60} step={5} onChange={setChatPerDay} valueText={chatPerDay ? String(chatPerDay) : 'None'} />
      <div className="usage-result" aria-live="polite">
        <p className="usage-result-main">About <strong>{roughUsd(estimate.total)}</strong> a month</p>
        {estimate.high - estimate.low >= 0.01 && <p className="usage-sub">Usually {roughUsd(estimate.low)}–{roughUsd(estimate.high)}</p>}
        {limited !== null && <p className="usage-sub usage-limited">With your limits it stops at about <strong>{roughUsd(limited)}</strong></p>}
        <ul className="usage-breakdown">
          <li><span>Voice chats</span><span>{roughUsd(estimate.voice)} · {tag(estimate.basis?.voice)}</span></li>
          <li><span>Typing to the assistant</span><span>{roughUsd(estimate.chat)} · {tag(estimate.basis?.chat)}</span></li>
        </ul>
        <p className="usage-sub">{prefs.enabled ? `Your limits cap voice at about ${roughUsd(ceiling.capped)} a month.` : 'Voice chats are off, so they cost nothing.'}</p>
      </div>
      <Button variant="secondary" size="sm" icon="history" disabled={!enoughData} onClick={applyAverages}>Use my averages</Button>
      {!enoughData && <p className="usage-hint">Available after 3 days of use.</p>}
    </section>
  )
}

const perMillion = (value) => `$${Number(value) < 0.1 ? Number(value).toFixed(3) : Number(value).toFixed(2)}`

function Assumptions({ since }) {
  const voice = REALTIME_PRICES[VOICE_MODEL] || {}
  const text = TEXT_PRICES[TEXT_MODEL] || {}
  const checked = shortDate(PRICES_CHECKED)
  const year = String(PRICES_CHECKED).slice(0, 4)
  const rows = [
    { label: 'Voice chats: your voice and its voice', model: VOICE_MODEL, inp: perMillion(voice.audioIn), cached: perMillion(voice.audioCached), out: perMillion(voice.audioOut) },
    { label: 'Voice chats: words and the day’s context', model: VOICE_MODEL, inp: perMillion(voice.textIn), cached: perMillion(voice.textCached), out: perMillion(voice.textOut) },
    { label: 'Assistant (typing), food AI, morning note', model: TEXT_MODEL, inp: perMillion(text.in), cached: perMillion(text.cached), out: perMillion(text.out) },
  ]
  return (
    <div className="usage-assumptions">
      <div className="usage-table-wrap">
        <table className="usage-table usage-prices">
          <caption>US$ per million tokens</caption>
          <thead><tr><th scope="col">What</th><th scope="col" className="is-num">In</th><th scope="col" className="is-num">Reused</th><th scope="col" className="is-num">Out</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}<small>{row.model}</small></td>
                <td className="is-num">{row.inp}</td>
                <td className="is-num">{row.cached}</td>
                <td className="is-num">{row.out}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="usage-price-list">
        <li>Live captions in voice chats: ${TRANSCRIBE_PER_MIN['gpt-transcribe']} a minute</li>
        <li>Voice notes: ${TRANSCRIBE_PER_MIN['gpt-4o-mini-transcribe']} a minute</li>
        <li>Web searches: ${WEB_SEARCH_PER_CALL.toFixed(2)} each</li>
      </ul>
      <p className="usage-hint">Prices as of {checked}{checked && !checked.includes(year) ? `, ${year}` : ''}. A typical voice minute is about 4–5¢; longer calls cost more a minute because every reply re-reads the call so far.</p>
      <p className="usage-hint">
        Recorded from the usage OpenAI reports with each reply. Your bill at{' '}
        <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">platform.openai.com/usage</a>{' '}
        is the final word.{since ? ` Tracking since ${shortDate(since)}.` : ''}
      </p>
    </div>
  )
}

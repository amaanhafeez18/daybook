import { useEffect, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import Disclosure from '../ui/Disclosure.jsx'
import { Button, Segmented, Switch } from '../ui/primitives.jsx'
import { readPref, writePref } from '../../lib/api.js'
import { updateSettings } from '../../lib/store.js'
import { capCeiling, formatUsd, worstCaveat } from '../../lib/aiPricing.js'
import { BUDGET_DEFAULT, BUDGET_OPTIONS, BUDGET_WARN, VOICE_DEFAULTS, VOICE_OPTIONS, VOICE_RECOMMENDED, budgetUsd, voicePrefs } from '../../lib/voice/prefs.js'
import { useAiUsage } from '../../lib/aiUsageClient.js'
import { rawVoice } from '../voice/TalkButton.jsx'
import VoicePicker, { voiceLabel } from '../voice/VoicePicker.jsx'
import { BudgetMeter } from './UsageBars.jsx'
import UsageSheet from './UsageSheet.jsx'
import './usage.css'

// Settings → "Voice & AI cost" (#/settings/voice; #/settings/usage also opens the calculator).
// Basics: voice chat on or off, how you talk (per device), Daybook's voice (a sheet with a sample of
// each), the daily limit with what it can cost at most, and this month's AI spend against the
// budget. Everything else sits under one "Advanced".
// settings.voice (synced) holds the voice prefs and settings.aiBudgetUsd the monthly budget (both
// normalized by lib/voice/prefs.js; missing means the default). How you talk and the iPhone call
// audio switch are per device (readPref 'voice.mode', 'voice.audioSession').

const MODE_OPTIONS = [{ id: 'open', label: 'Open mic' }, { id: 'hold', label: 'Hold to talk' }]
const MODE_HINTS = {
  open: 'Best with AirPods: just talk, and you can interrupt.',
  hold: 'Best on the phone speaker: hold the button while you talk.',
}
const QUIET_LABELS = { 30: '30 s', 60: '1 min', 120: '2 min' }
const USAGE_HASH = /^#\/?settings\/usage\b/
const quietLabel = (seconds) => QUIET_LABELS[seconds] || `${seconds} s`
const budgetLabel = (usd) => (usd > 0 ? `$${Number(usd.toFixed(2))}` : 'Off')

export default function VoiceSettings({ settings, openUsage = false }) {
  const prefs = voicePrefs(settings)
  const budget = budgetUsd(settings)
  const usage = useAiUsage({ maxAgeMs: 0 })
  const [mode, setMode] = useState(() => (readPref('voice.mode', 'open') === 'hold' ? 'hold' : 'open'))
  const [callAudio, setCallAudio] = useState(() => readPref('voice.audioSession', 'play-and-record') !== 'auto')
  const [sheetOpen, setSheetOpen] = useState(openUsage)
  const [voiceOpen, setVoiceOpen] = useState(false)

  // #/settings/usage while Settings is already open (the assistant's link, the call summary).
  useEffect(() => {
    const onHash = () => { if (USAGE_HASH.test(window.location.hash)) setSheetOpen(true) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const setVoice = (patch) => updateSettings({ voice: { ...rawVoice(settings), ...patch } })
  const chooseMode = (next) => {
    setMode(next)
    writePref('voice.mode', next)
  }
  const chooseCallAudio = (on) => {
    setCallAudio(on)
    writePref('voice.audioSession', on ? 'play-and-record' : 'auto')
  }

  const summary = usage.summary
  const ceiling = capCeiling({ dailyMinutes: prefs.dailyMinutes, sessionMinutes: prefs.sessionMinutes, budgetUsd: budget })
  const todayMinutes = summary ? Math.round((Number(summary.voiceSecondsToday) || 0) / 60) : null
  const limitNote = `${todayMinutes !== null ? `Today: ${todayMinutes} of ${prefs.dailyMinutes} min. ` : ''}At this limit voice costs at most about ${formatUsd(ceiling.capped)} a month${budget > 0 && ceiling.capped >= budget ? ' (your budget)' : worstCaveat(ceiling, budget)}.`

  // The assistant can set any budget up to $500; show it rather than a wrong choice.
  const budgetOptions = BUDGET_OPTIONS.map((value) => ({ id: value, label: budgetLabel(value) }))
  if (!BUDGET_OPTIONS.includes(budget)) budgetOptions.push({ id: budget, label: budgetLabel(budget) })

  const advanced = [`${prefs.sessionMinutes}-min calls`, `hang up after ${quietLabel(prefs.silenceSeconds)} quiet`, budget > 0 ? `${budgetLabel(budget)} budget` : 'no budget']
  if (!callAudio) advanced.push('call audio off')
  const advancedCustom = prefs.sessionMinutes !== VOICE_DEFAULTS.sessionMinutes || prefs.silenceSeconds !== VOICE_DEFAULTS.silenceSeconds
    || budget !== BUDGET_DEFAULT || !callAudio

  return (
    <section className="settings-group" id="voice">
      <h2>Voice &amp; AI cost</h2>
      <div className="card set-list">
        <div className="set-row is-switch">
          <Switch label="Voice chat" description="Talk with the assistant like a phone call. About 4–5¢ a minute; off costs nothing." checked={prefs.enabled} onChange={(enabled) => setVoice({ enabled })} />
        </div>
        {prefs.enabled && (
          <>
            <div className="set-row is-stacked">
              <span className="set-label">How you talk</span>
              <Segmented options={MODE_OPTIONS} value={mode} onChange={chooseMode} label="How you talk" />
              <p className="set-note">{MODE_HINTS[mode]}</p>
            </div>
            <button type="button" className="set-row set-link-row usage-open-row voice-pick-row" onClick={() => setVoiceOpen(true)} aria-haspopup="dialog">
              <span className="usage-open-icon" aria-hidden="true"><Icon name="waveform" size={18} /></span>
              <span className="set-label">Voice</span>
              <span className="set-link-value">{voiceLabel(prefs.voice)}{VOICE_RECOMMENDED.includes(prefs.voice) ? ' · Recommended' : ''}</span>
              <Icon name="chevronRight" size={18} />
            </button>
            <div className="set-row is-stacked">
              <span className="set-label">Daily limit</span>
              <Segmented options={VOICE_OPTIONS.dailyMinutes.map((value) => ({ id: value, label: `${value} min` }))} value={prefs.dailyMinutes} onChange={(dailyMinutes) => setVoice({ dailyMinutes })} label="Daily voice limit" />
              <p className="set-note">{limitNote}</p>
            </div>
          </>
        )}
      </div>

      <div className="card set-list usage-glance">
        <UsageGlance usage={usage} budget={budget} />
        <button type="button" className="set-row set-link-row usage-open-row" onClick={() => setSheetOpen(true)}>
          <span className="usage-open-icon" aria-hidden="true"><Icon name="calculator" size={18} /></span>
          <span className="set-label">Usage &amp; cost calculator</span>
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <Disclosure id="settings-voice-advanced" label="Advanced" summary={advanced.join(' · ')} hasValues={advancedCustom} className="set-disclosure">
        <div className="card set-list">
          <div className="set-row is-stacked">
            <span className="set-label">Call length</span>
            <Segmented options={VOICE_OPTIONS.sessionMinutes.map((value) => ({ id: value, label: `${value} min` }))} value={prefs.sessionMinutes} onChange={(sessionMinutes) => setVoice({ sessionMinutes })} label="Call length" />
            <p className="set-note">Shorter calls cost less a minute, and you can always continue.</p>
          </div>
          <div className="set-row is-stacked">
            <span className="set-label">Hang up after quiet</span>
            <Segmented options={VOICE_OPTIONS.silenceSeconds.map((value) => ({ id: value, label: quietLabel(value) }))} value={prefs.silenceSeconds} onChange={(silenceSeconds) => setVoice({ silenceSeconds })} label="Hang up after quiet" />
          </div>
          <div className="set-row is-stacked">
            <span className="set-label">Monthly AI budget</span>
            <Segmented options={budgetOptions} value={budget} onChange={(aiBudgetUsd) => updateSettings({ aiBudgetUsd })} label="Monthly AI budget" className="usage-budget-seg" />
            <p className="set-note">{budget > 0 ? 'Voice chats pause when this month’s AI spend reaches it. Typing keeps working.' : 'No budget: voice chats stop only at the daily limit.'}</p>
          </div>
          <div className="set-row is-switch">
            <Switch label="iPhone call audio" description="Turn off if voice replies are too quiet or come from the earpiece. This device only." checked={callAudio} onChange={chooseCallAudio} />
          </div>
        </div>
        <p className="set-footnote">Your voice and today’s plan go to OpenAI, like typed chat. If iPhone keeps asking for the mic: Settings → Apps → Safari → Microphone → Allow.</p>
      </Disclosure>

      <VoicePicker open={voiceOpen} onClose={() => setVoiceOpen(false)} value={prefs.voice} onChange={(voice) => setVoice({ voice })} />
      <UsageSheet open={sheetOpen} onClose={() => setSheetOpen(false)} usage={usage} prefs={prefs} budget={budget} />
    </section>
  )
}

// This month's AI spend at a glance: the total, the budget meter (tick at 80%), today and where the
// month is heading. Paints from this device's copy, then the fresh numbers.
function UsageGlance({ usage, budget }) {
  const summary = usage.summary
  if (usage.available === false) {
    return <div className="set-row is-stacked"><p className="set-note">Usage tracking needs the 2026-09-23 database update.</p></div>
  }
  if (!summary) {
    return (
      <div className="set-row is-stacked">
        <div className="usage-glance-head"><span className="set-label">This month</span><strong className="usage-glance-total is-loading">{usage.error ? '—' : '…'}</strong></div>
        {usage.error && !usage.loading
          ? <p className="set-note">{usage.error} <Button variant="ghost" size="sm" onClick={() => usage.refresh()}>Try again</Button></p>
          : <p className="set-note" role="status">Loading…</p>}
      </div>
    )
  }
  const spent = Number(summary.month?.total) || 0
  const today = Number(summary.today?.total) || 0
  const projected = Number(summary.projected) || 0
  const state = summary.budget?.state
  return (
    <div className="set-row is-stacked">
      <div className="usage-glance-head">
        <span className="set-label">This month</span>
        <strong className="usage-glance-total">{formatUsd(spent)}</strong>
      </div>
      {budget > 0 && <BudgetMeter spent={spent} budget={budget} warnAt={BUDGET_WARN} />}
      <p className="set-note">
        Today {formatUsd(today)}{projected > spent ? ` · on pace for ${formatUsd(projected)}` : ''}
        {budget > 0 ? ` · budget ${formatUsd(budget)}` : ''}
      </p>
      {state === 'over' && <p className="set-note usage-warn">This month’s budget is used up, so voice is paused. Typing still works.</p>}
      {state === 'warn' && <p className="set-note usage-warn">You’ve used {Math.floor((Number(summary.budget?.pct) || 0) * 100)}% of this month’s budget.</p>}
    </div>
  )
}

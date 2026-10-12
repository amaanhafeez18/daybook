import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import ActionChips from '../ActionChips.jsx'
import { useData } from '../../lib/store.js'
import { formatUsd } from '../../lib/aiPricing.js'
import { voicePrefs } from '../../lib/voice/prefs.js'
import { startVoice, useVoice } from '../../lib/voice/session.js'
import { spokenNumbersToDigits } from '../../lib/voice/transcript.js'
import { talkChanges, talkContinuable, talkGist, talkLength, talkTitle, visibleActions } from '../../lib/assistantChat.js'
import { freshClass, scrollBehavior } from '../../lib/motion.js'
import './talk.css'

// One voice chat in the chat history. Folded: "Voice chat · 9:12 PM · 11 min" with a chevron, the
// last thing Daybook said (two lines), "2 changes · ≈ 38¢", and the chips of what changed (with
// Undo). Tapping the header opens the transcript in place: its last lines first ("Show all N lines"
// for the rest), in the page's own scroll (never a box that scrolls inside the card), with the full
// time range under it. The cards waiting for a Yes (on the call itself or on a request it handed to
// the full assistant) show under it, drawn by the page (`renderCard`), so they work exactly like
// the chat's own. A call that stopped by itself (time limit, quiet, the app was left) can be
// continued for a while. Daybook's lines show numbers as digits, also in chats saved before that.

const RECENT_LINES = 6

export default function TalkCard({ message, proposals = [], isLast = false, busy = false, onUndo, renderCard }) {
  const talk = message.talk
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const transcriptId = useId()
  const endRef = useRef(null)
  const listRef = useRef(null)
  const settings = useData('settings')
  const voice = useVoice()
  const actions = Array.isArray(message.actions) ? message.actions : []
  const chips = visibleActions(actions, '', { createdAt: message.createdAt })
  const changes = talkChanges(actions)
  const gist = spokenNumbersToDigits(talkGist(talk))
  const turns = (Array.isArray(talk.turns) ? talk.turns : []).filter((turn) => turn && typeof turn.t === 'string' && turn.t.trim())
  const hidden = all ? 0 : Math.max(0, turns.length - RECENT_LINES)
  const shownTurns = hidden ? turns.slice(-RECENT_LINES) : turns
  const usd = Number(talk.usd)
  const cost = Number.isFinite(usd) && usd > 0 ? `≈ ${formatUsd(usd, { cents: true })}` : ''
  const thisCall = voice?.talkId === talk.id && ['connecting', 'live', 'paused', 'ending'].includes(voice?.status)
  const canContinue = !thisCall && voicePrefs(settings).enabled && talkContinuable(talk)
  const cut = talk.end === 'cut' || talk.end === 'error'
  // The header keeps the start time only; the range ("9:12–9:23 PM") goes under the open transcript.
  // A call from another day has its date in the header, so its length moves to the line below
  // (else "Voice chat · Oct 11, 11:21 PM · 11 min" is cut off on a phone).
  const started = new Date(talk.startedAt || '')
  const otherDay = Number.isFinite(started.getTime()) && started.toDateString() !== new Date().toDateString()
  const seconds = Number(talk.seconds)
  const length = otherDay && Number.isFinite(seconds) && seconds > 0 ? talkLength(seconds) : ''
  const title = talkTitle({ ...talk, endedAt: null, ...(otherDay ? { seconds: 0 } : {}) })
  const span = talkTitle({ ...talk, seconds: 0 }).replace(/^Voice chat( · )?/, '')
  const meta = [length, changes ? (changes === 1 ? '1 change' : `${changes} changes`) : '', cost].filter(Boolean).join(' · ')

  // Opening it keeps the end of the card (the newest lines, the chips) in view above the composer.
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }))
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <div className={`msg msg-assistant talk-msg ${freshClass(message)}`}>
      <span className="assistant-avatar talk-avatar" aria-hidden="true"><Icon name="waveform" size={16} strokeWidth={2.2} /></span>
      <div className={`msg-body talk-card ${proposals.length ? 'has-card' : ''} ${open ? 'is-open' : ''}`}>
        <button type="button" className="talk-card-head" aria-expanded={open} aria-controls={transcriptId} onClick={() => {
          setOpen((value) => !value)
          setAll(false)
        }}>
          <span className="talk-card-title"><strong>{title}</strong></span>
          <Icon name="chevronDown" size={18} strokeWidth={2.2} className={`talk-card-chevron ${open ? 'is-open' : ''}`} />
          <span className="sr-only">{open ? 'Hide the transcript' : 'Show the transcript'}</span>
        </button>
        {thisCall && <p className="talk-card-live"><span className="talk-live-dot" aria-hidden="true" />In progress</p>}
        {!open && gist && <p className="talk-card-gist">{gist}</p>}
        {!open && meta && <p className="talk-card-meta">{meta}</p>}
        {open && (
          <div id={transcriptId} className="talk-transcript" role="log" aria-label="Transcript">
            {Number(talk.trimmed) > 0 && !hidden && <p className="talk-transcript-note">{talk.trimmed} earlier {talk.trimmed === 1 ? 'line isn’t' : 'lines aren’t'} kept.</p>}
            {hidden > 0 && (
              <button type="button" className="talk-show-all" onClick={() => {
                setAll(true)
                // The button goes away: keep keyboard and VoiceOver focus on the list it opened.
                requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }))
              }}>
                <Icon name="chevronUp" size={15} strokeWidth={2.2} />
                Show all {turns.length} lines
              </button>
            )}
            {turns.length === 0 && <p className="talk-transcript-note">Nothing was said.</p>}
            <ol ref={listRef} tabIndex={-1} className="talk-lines">
              {shownTurns.map((turn, index) => (
                <li key={turn.id || `${hidden}-${index}`} className={turn.r === 'a' ? 'is-daybook' : 'is-you'}>
                  <span className="sr-only">{turn.r === 'a' ? 'Daybook: ' : turn.r === 't' ? 'You typed: ' : 'You: '}</span>
                  {turn.r === 't' && <Icon name="keyboard" size={13} className="talk-typed" />}
                  <span>{turn.r === 'a' ? spokenNumbersToDigits(turn.t) : turn.t}</span>
                </li>
              ))}
            </ol>
            {cut && <p className="talk-transcript-note">The call was cut off here.</p>}
            <p className="talk-transcript-foot">{[span, meta].filter(Boolean).join(' · ')}</p>
          </div>
        )}
        {proposals.map((item, index) => (
          <div key={item.proposal.id} className="talk-card-proposal">
            {renderCard?.(item, isLast && index === proposals.length - 1, busy)}
          </div>
        ))}
        <ActionChips actions={chips} createdAt={message.createdAt} onUndo={onUndo} />
        {canContinue && (
          <button type="button" className="talk-continue" onClick={() => startVoice({ intent: talk.intent || 'chat', from: 'chat', continueTalkId: talk.id })}>
            <Icon name="waveform" size={16} strokeWidth={2.2} />
            Continue this voice chat
          </button>
        )}
        <span ref={endRef} className="talk-card-end" aria-hidden="true" />
      </div>
    </div>
  )
}

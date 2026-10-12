import { useId, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import ActionChips from '../ActionChips.jsx'
import { useData } from '../../lib/store.js'
import { formatUsd } from '../../lib/aiPricing.js'
import { voicePrefs } from '../../lib/voice/prefs.js'
import { startVoice, useVoice } from '../../lib/voice/session.js'
import { talkChanges, talkContinuable, talkGist, talkTitle, visibleActions } from '../../lib/assistantChat.js'
import { freshClass } from '../../lib/motion.js'
import './talk.css'

// One voice chat in the chat history: "Voice chat · 9:12–9:23 PM · 11 min · ≈ 38¢", the last thing
// Daybook said, and what changed (with Undo). Tapping the header shows the whole transcript in place.
// The cards waiting for a Yes (on the call itself or on a request it handed to the full assistant)
// show under it, drawn by the page (`renderCard`), so they work exactly like the chat's own.
// A call that stopped by itself (time limit, quiet, the app was left) can be continued for a while.
export default function TalkCard({ message, proposals = [], isLast = false, busy = false, onUndo, renderCard }) {
  const talk = message.talk
  const [open, setOpen] = useState(false)
  const transcriptId = useId()
  const settings = useData('settings')
  const voice = useVoice()
  const actions = Array.isArray(message.actions) ? message.actions : []
  const chips = visibleActions(actions, '', { createdAt: message.createdAt })
  const changes = talkChanges(actions)
  const gist = talkGist(talk)
  const turns = (Array.isArray(talk.turns) ? talk.turns : []).filter((turn) => turn && typeof turn.t === 'string' && turn.t.trim())
  const usd = Number(talk.usd)
  const cost = Number.isFinite(usd) && usd > 0 ? `≈ ${formatUsd(usd, { cents: true })}` : ''
  const thisCall = voice?.talkId === talk.id && ['connecting', 'live', 'paused', 'ending'].includes(voice?.status)
  const canContinue = !thisCall && voicePrefs(settings).enabled && talkContinuable(talk)
  const cut = talk.end === 'cut' || talk.end === 'error'
  const title = talkTitle(talk)

  return (
    <div className={`msg msg-assistant talk-msg ${freshClass(message)}`}>
      <span className="assistant-avatar talk-avatar" aria-hidden="true"><Icon name="waveform" size={16} strokeWidth={2.2} /></span>
      <div className={`msg-body talk-card ${proposals.length ? 'has-card' : ''}`}>
        <button type="button" className="talk-card-head" aria-expanded={open} aria-controls={transcriptId} onClick={() => setOpen((value) => !value)}>
          <span className="talk-card-title">
            <strong>{title}</strong>
            {cost && <span className="talk-card-cost">{cost}</span>}
          </span>
          <Icon name="chevronDown" size={16} strokeWidth={2.2} className={`talk-card-chevron ${open ? 'is-open' : ''}`} />
          <span className="sr-only">{open ? 'Hide the transcript' : 'Show the transcript'}</span>
        </button>
        {thisCall && <p className="talk-card-live"><span className="talk-live-dot" aria-hidden="true" />In progress</p>}
        {!open && gist && <p className="talk-card-gist">{gist}</p>}
        {!open && changes > 0 && <p className="talk-card-meta">{changes === 1 ? '1 change' : `${changes} changes`}</p>}
        {open && (
          <div id={transcriptId} className="talk-transcript" role="log" aria-label="Transcript">
            {Number(talk.trimmed) > 0 && <p className="talk-transcript-note">{talk.trimmed} earlier {talk.trimmed === 1 ? 'line isn’t' : 'lines aren’t'} kept.</p>}
            {turns.length === 0 && <p className="talk-transcript-note">Nothing was said.</p>}
            <ol>
              {turns.map((turn, index) => (
                <li key={turn.id || index} className={turn.r === 'a' ? 'is-daybook' : 'is-you'}>
                  <span className="sr-only">{turn.r === 'a' ? 'Daybook: ' : turn.r === 't' ? 'You typed: ' : 'You: '}</span>
                  {turn.r === 't' && <Icon name="keyboard" size={13} className="talk-typed" />}
                  <span>{turn.t}</span>
                </li>
              ))}
            </ol>
            {cut && <p className="talk-transcript-note">The call was cut off here.</p>}
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
      </div>
    </div>
  )
}

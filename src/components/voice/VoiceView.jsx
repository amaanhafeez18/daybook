import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../ui/Icon.jsx'
import { ActionSheet } from '../ui/ActionSheet.jsx'
import { AutoTextarea } from '../ui/primitives.jsx'
import ActionChips from '../ActionChips.jsx'
import { ProposalCard } from '../../pages/AssistantPage.jsx'
import { haptic } from '../../lib/haptics.js'
import { isTyping, watchKeyboard } from '../../lib/keyboard.js'
import { formatUsd } from '../../lib/aiPricing.js'
import { scrollBehavior } from '../../lib/motion.js'
import { HOLD_SLIDE_PX, clock } from '../../lib/voice/policy.js'
import { latestPair } from '../../lib/voice/transcript.js'
import {
  closeVoice, decideCard, dismissNotice, endVoice, holdEnd, holdStart, interrupt, keepGoing, retryVoice, sendTyped, setKeyboard, setMode,
  setQuiet, setTypingFocus, todayMinutes, toggleMute, undoCard, useVoice, voiceLevel,
} from '../../lib/voice/session.js'
import Orb from './Orb.jsx'
import VoiceSummary from './VoiceSummary.jsx'
import { cardWords } from './cardWords.js'
import './voice.css'

// The voice chat screen: a full-screen layer over the app (not a route: the page's hash never
// changes during a call). Top: close, the timer with the running cost, the mic mode. Middle: the
// orb, what it's doing, the latest exchange as captions, and the cards (Undo chips, "Working on it…",
// then a change waiting for a yes, nearest the thumb). Everything in the middle is one scrolling
// column that follows the newest line and card (unless they scrolled up to read), so a card never
// covers the captions; while a card waits, the orb shrinks so the read-back and the card fit on one
// screen. Bottom: keyboard, Mute or Hold to talk, End. Desktop: a centred panel; Space holds, M mutes,
// K types, Esc ends. A phone on its side: the orb on the left, the conversation on the right.
//
// `voice`, `inline` and `level` are for the dev preview (#/voice-preview): a fixed state drawn in
// place instead of the live call's, with no focus trap and no keys, and a made-up orb level.

const STATUS_TEXT = {
  connecting: 'Connecting…',
  hearing: 'Listening…',
  thinking: 'Thinking…',
  working: 'Working on it…',
}

const MODE_TEXT = { open: 'Open mic', hold: 'Hold to talk' }
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function statusText(voice) {
  if (voice.status === 'connecting') return 'Connecting…'
  if (voice.status === 'ending') return 'Saving…'
  if (voice.status !== 'live') return ''
  if (voice.activity === 'speaking') return voice.mode === 'hold' ? 'Hold to interrupt' : 'Tap to interrupt'
  if (voice.muted && voice.mode === 'open') return 'Muted'
  if (voice.activity === 'listening') return voice.mode === 'hold' ? 'Hold to talk' : 'Listening…'
  return STATUS_TEXT[voice.activity] || ''
}

// The same text, at most every 1.5 s, for screen readers.
function useThrottled(value, ms) {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, ms - (Date.now() - last.current))
    const timer = setTimeout(() => {
      last.current = Date.now()
      setShown(value)
    }, wait)
    return () => clearTimeout(timer)
  }, [value, ms])
  return shown
}

export default function VoiceView({ voice: given = null, inline = false, level = voiceLevel }) {
  const current = useVoice()
  const voice = given || current
  const layerRef = useRef(null)
  const returnFocus = useRef(null)
  const statusRef = useRef(voice.status)
  statusRef.current = voice.status

  // Focus moves in on open and back out on close; Tab stays inside.
  useEffect(() => {
    if (inline) return undefined
    returnFocus.current = document.activeElement
    const layer = layerRef.current
    layer?.focus({ preventScroll: true })
    const onKey = (event) => {
      if (document.documentElement.classList.contains('has-sheet') || !layer) return
      // Esc on the summary or an error closes (the live call handles its own: it ends the call).
      if (event.key === 'Escape' && !['live', 'connecting'].includes(statusRef.current) && !event.defaultPrevented) {
        event.preventDefault()
        closeVoice()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...layer.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === layer)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const target = returnFocus.current
      if (target?.isConnected) target.focus?.({ preventScroll: true })
    }
  }, [inline])

  const showSummary = voice.status === 'paused' || voice.status === 'ended' || voice.status === 'ending'

  const layer = (
    <div className={`voice-layer is-${voice.status} ${inline ? 'is-inline' : ''}`} role="dialog" aria-modal={inline ? undefined : 'true'} aria-label="Voice chat" ref={layerRef} tabIndex={-1}>
      <div className="voice-panel">
        {voice.status === 'error'
          ? <VoiceError voice={voice} />
          : showSummary
            ? <SummaryScreen voice={voice} />
            : <LiveCall voice={voice} inline={inline} level={level} />}
      </div>
    </div>
  )
  return inline ? layer : createPortal(layer, document.body)
}

function SummaryScreen({ voice }) {
  return (
    <>
      <div className="voice-top">
        <span className="voice-top-spacer" />
        <span className="voice-title">Voice chat</span>
        <button type="button" className="voice-round-btn" onClick={() => closeVoice()} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="voice-scroll">
        <VoiceSummary voice={voice} />
      </div>
    </>
  )
}

// ---- the live call ---------------------------------------------------------------------------------

// A settled card (Done) stays in view for a moment, then only its chips remain (they say the same).
const DONE_SHOWN_MS = 2600
const OPEN_CARD = new Set(['pending', 'executing'])

function LiveCall({ voice, inline = false, level = voiceLevel }) {
  const [modeOpen, setModeOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [detail, setDetail] = useState(false)
  const live = voice.status === 'live'
  const label = statusText(voice)
  const announced = useThrottled(label, 1500)
  const scrollRef = useRef(null)
  const cardRef = useRef(null)
  const pinned = useRef(true) // following the newest line; off once they scroll up to read
  const proposal = voice.proposal
  const cardOpen = OPEN_CARD.has(proposal?.status)
  const showCard = useCardShown(proposal, voice.actions)
  // The keyboard (Quiet replies) takes half the screen, and iOS vh ignores it: compact then too.
  const compact = cardOpen || voice.working > 0 || transcriptOpen || Boolean(voice.keyboard)
  const lastTurn = voice.turns[voice.turns.length - 1]

  const onScroll = () => {
    const element = scrollRef.current
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }
  // Before paint, so a growing caption or a new card never flashes below the fold.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [voice.turns.length, lastTurn?.text?.length, proposal?.id, proposal?.status, showCard, voice.actions.length, voice.working, transcriptOpen, compact, voice.keyboard, voice.notice?.id])
  // A new card waiting for a yes (or the waiting card changed in place: same id, next revision): back
  // to following, and the card's buttons come into view.
  useEffect(() => {
    if (!proposal?.id || proposal.status !== 'pending') return undefined
    pinned.current = true
    const frame = requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: 'end', behavior: scrollBehavior() }))
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.id, proposal?.revision])

  // Desktop keys: Space holds (hold mode), M mutes, K types, Esc ends. Never while typing or while
  // a sheet (the mode menu) is open.
  useEffect(() => {
    if (inline) return undefined
    let spaceDown = false
    const blocked = () => document.documentElement.classList.contains('has-sheet') || isTyping(document.activeElement)
    const onDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape' && !document.documentElement.classList.contains('has-sheet')) {
        if (isTyping(document.activeElement)) {
          document.activeElement.blur()
          setKeyboard(false)
          return
        }
        event.preventDefault()
        endVoice('user')
        return
      }
      if (blocked() || event.repeat) {
        if (event.key === ' ' && spaceDown) event.preventDefault()
        return
      }
      const key = event.key.toLowerCase()
      if (key === ' ' && voice.mode === 'hold' && live) {
        event.preventDefault()
        spaceDown = true
        holdStart()
      } else if (key === 'm' && voice.mode === 'open' && live) {
        event.preventDefault()
        toggleMute()
      } else if (key === 'k' && live) {
        event.preventDefault()
        setKeyboard(true)
      }
    }
    const onUp = (event) => {
      if (event.key === ' ' && spaceDown) {
        spaceDown = false
        event.preventDefault()
        holdEnd()
      }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      if (spaceDown) holdEnd()
    }
  }, [voice.mode, live, inline])

  useEffect(() => {
    if (!detail) return undefined
    const timer = setTimeout(() => setDetail(false), 3500)
    return () => clearTimeout(timer)
  }, [detail])

  const today = detail ? todayMinutes() : null
  const { user, assistant } = latestPair(voice.turns)
  const speaking = voice.activity === 'speaking'
  // Screen readers hear finished turns only (captions change many times a second): what they said,
  // and Daybook's text replies when replies are quiet (spoken ones are already heard).
  const finished = [...(voice.turns || [])].reverse().find((turn) => !turn.partial && turn.phase !== 'commentary'
    && String(turn.text || '').trim() && (turn.r === 'u' || (turn.r === 'a' && voice.quiet)))
  const finishedText = finished ? `${finished.r === 'a' ? 'Daybook' : 'You'}: ${finished.text}` : ''
  const words = cardWords(proposal)

  return (
    <>
      <div className="voice-top">
        <button type="button" className="voice-round-btn" onClick={() => endVoice('user')} aria-label="End and save the voice chat" title="End and save">
          <Icon name="close" size={20} />
        </button>
        <button
          type="button"
          className={`voice-pill voice-timer ${voice.warnTime ? 'is-warn' : ''}`}
          onClick={() => setDetail((value) => !value)}
          aria-label={`${clock(voice.seconds)} so far, about ${formatUsd(voice.usd)}${voice.warnTime ? `, ${Math.ceil((voice.leftSec || 0) / 60)} minute left` : ''}`}
        >
          {voice.warnTime && <span className="voice-timer-left">{Math.max(1, Math.ceil((voice.leftSec || 0) / 60))} min left ·</span>}
          <span>{clock(voice.seconds)}</span>
          {/* In the last minute the cost gives way (tap for it), so the pill keeps Open mic on screen. */}
          {!voice.warnTime && <span aria-hidden="true">·</span>}
          {!voice.warnTime && <span>≈{formatUsd(voice.usd, { cents: true })}</span>}
        </button>
        <button type="button" className="voice-pill voice-mode" onClick={() => setModeOpen(true)} aria-haspopup="dialog">
          <Icon name={voice.mode === 'hold' ? 'speaker' : 'headphones'} size={15} />
          {MODE_TEXT[voice.mode]}
          <Icon name="chevronDown" size={14} />
        </button>
      </div>
      {detail && (
        <p className="voice-detail" role="status">
          This call ≈ {formatUsd(voice.usd)}{today ? ` · today ${today.used} of ${today.daily} min` : ''}
        </p>
      )}
      <Notice notice={voice.notice} />

      <div ref={scrollRef} onScroll={onScroll} className={`voice-scroll ${compact ? 'is-compact' : ''}`}>
        <div className="voice-stage">
          <OrbButton voice={voice} speaking={speaking} level={level} />
          <p className="voice-status" aria-hidden="true">{label || ' '}</p>
          <p className="sr-only" aria-live="polite">{announced}</p>
          <p className="sr-only" aria-live="polite">{finishedText}</p>
          <p className="sr-only" aria-live="polite">{ackText(voice.ack)}</p>
        </div>

        <div className="voice-talk">
          {transcriptOpen
            ? <Transcript turns={voice.turns} onClose={() => setTranscriptOpen(false)} />
            : <Captions user={user} assistant={assistant} />}
          {!transcriptOpen && voice.turns.length > 2 && (
            <button type="button" className="voice-transcript-toggle" onClick={() => setTranscriptOpen(true)} aria-expanded="false">
              Transcript
              <Icon name="chevronUp" size={14} />
            </button>
          )}

          <div className="voice-cards">
            {voice.actions.length > 0 && <ActionChips actions={voice.actions.slice(-6)} createdAt={voice.startedAt} onUndo={(undoId) => {
              haptic()
              return undoCard(undoId)
            }} />}
            {voice.working > 0 && (
              <p className="voice-working" role="status">
                <span className="spinner" aria-hidden="true" />
                Working on it…
              </p>
            )}
            {proposal && showCard && (
              <div key={proposal.id} className="voice-proposal" ref={cardRef}>
                <ProposalCard
                  proposal={proposal}
                  createdAt={proposal.createdAt}
                  // A card that was replaced or cancelled folds to one line.
                  isLast={cardOpen || ['done', 'partial', 'failed'].includes(proposal.status)}
                  busy={voice.deciding || proposal.status === 'executing'}
                  arriving={proposal.status === 'pending'}
                  yesLabel={words.yes}
                  onDecide={(decision) => {
                    haptic(decision === 'yes' ? 'success' : 'light')
                    decideCard(proposal.id, decision)
                  }}
                />
                {proposal.status === 'pending' && (
                  <p className="voice-proposal-hint">{proposal.revision > 1 ? 'Updated · ' : ''}or say “{words.say}”</p>
                )}
              </div>
            )}
          </div>

          {live && !voice.hasUserTurn && voice.startChips.length > 0 && (
            <div className="voice-start-chips" role="group" aria-label="Ideas to start">
              {voice.startChips.map((chip) => (
                <button key={chip.id} type="button" className="chip" onClick={() => {
                  haptic()
                  sendTyped(chip.text)
                }}>{chip.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {voice.keyboard ? <KeyboardBar voice={voice} /> : <Controls voice={voice} live={live} />}

      <ActionSheet
        open={modeOpen}
        onClose={() => setModeOpen(false)}
        title="How you talk"
        actions={[
          { id: 'open', icon: 'headphones', label: 'Open mic', hint: 'Best with AirPods: just talk, and you can interrupt.', checked: voice.mode === 'open', onClick: () => setMode('open') },
          { id: 'hold', icon: 'speaker', label: 'Hold to talk', hint: 'Best on the phone speaker.', checked: voice.mode === 'hold', onClick: () => setMode('hold') },
        ]}
      />
    </>
  )
}

// The last Save / No tapped on the card, for screen readers (Daybook also says it out loud).
function ackText(ack) {
  if (!ack) return ''
  // No tapped on a card a spoken yes had already saved comes back not-ok, but it is saved.
  if (ack.already && ['done', 'executing', 'partial'].includes(ack.status)) return 'Already saved.'
  if (ack.already && ack.status === 'cancelled') return 'Not saved.'
  if (!ack.ok) return 'That didn’t work.'
  if (ack.decision === 'no') return 'Not saved.'
  if (ack.status === 'partial') return 'Saved some of it.'
  return ack.already ? 'Already saved.' : 'Saved.'
}

// Whether the card is still drawn: a Done card gives way to its chips after a moment (the chips
// carry the same news, with Undo); anything else stays.
function useCardShown(proposal, actions) {
  const [hiddenId, setHiddenId] = useState(null)
  const id = proposal?.id || null
  const done = proposal?.status === 'done'
  const hasChips = (Array.isArray(actions) ? actions : []).some((action) => action?.ok)
  useEffect(() => {
    if (!id || !done || !hasChips) return undefined
    const timer = setTimeout(() => setHiddenId(id), DONE_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [id, done, hasChips])
  return !(id && done && hasChips && hiddenId === id)
}

function OrbButton({ voice, speaking, level }) {
  const muted = voice.muted && voice.mode === 'open'
  const orb = <Orb activity={voice.activity} status={voice.status} muted={muted} level={level} />
  return (
    <div className="voice-orb-wrap">
      {speaking ? (
        <button type="button" className="voice-orb-btn" onClick={() => {
          haptic()
          interrupt()
        }} aria-label="Interrupt">
          {orb}
        </button>
      ) : orb}
      {muted && <span className="voice-orb-badge" aria-hidden="true"><Icon name="micOff" size={18} /></span>}
    </div>
  )
}

function Captions({ user, assistant }) {
  return (
    <div className="voice-captions" aria-live="off" aria-label="Captions">
      {user && (
        <p className={`voice-cap-user ${user.partial && !user.text ? 'is-waiting' : ''}`}>
          {user.r === 't' && <Icon name="keyboard" size={14} />}
          {user.text || <span className="voice-dots" aria-label="Listening"><i /><i /><i /></span>}
        </p>
      )}
      {assistant && (
        <p className={`voice-cap-daybook ${assistant.phase === 'commentary' ? 'is-preamble' : ''} ${assistant.interrupted ? 'is-cut' : ''}`}>
          {assistant.text}
          {assistant.interrupted && '…'}
        </p>
      )}
    </div>
  )
}

// The whole conversation, in the call's one scrolling column (no scroller of its own: the column
// follows the newest line).
function Transcript({ turns, onClose }) {
  return (
    <section className="voice-transcript" aria-label="Transcript">
      <button type="button" className="voice-transcript-toggle" onClick={onClose} aria-expanded="true">
        Hide transcript
        <Icon name="chevronDown" size={14} />
      </button>
      <ol className="voice-transcript-list" aria-live="off">
        {turns.filter((turn) => String(turn.text || '').trim()).map((turn) => (
          <li key={turn.id} className={`voice-turn is-${turn.r} ${turn.phase === 'commentary' ? 'is-preamble' : ''} ${turn.interrupted ? 'is-cut' : ''}`}>
            {turn.r === 't' && <Icon name="keyboard" size={13} />}
            <span className="sr-only">{turn.r === 'a' ? 'Daybook: ' : 'You: '}</span>
            {turn.text}
            {turn.interrupted && '…'}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Notice({ notice }) {
  if (!notice) return null
  return (
    <div className={`voice-notice is-${notice.tone || 'info'}`} role="status">
      {notice.id === 'silence'
        ? (
          <>
            {/* the countdown changes every second: screen readers get one fixed line */}
            <span className="voice-notice-text" aria-hidden="true">{notice.text}</span>
            <span className="sr-only">Still there? The call will hang up soon.</span>
          </>
        )
        : <span className="voice-notice-text">{notice.text}</span>}
      {notice.action === 'keep' && <button type="button" className="voice-notice-btn" onClick={keepGoing}>Keep going</button>}
      {notice.action === 'switch' && <button type="button" className="voice-notice-btn" onClick={() => setMode('hold')}>Switch</button>}
      {notice.tone !== 'hint' && (
        <button type="button" className="voice-notice-close" onClick={dismissNotice} aria-label="Dismiss">
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  )
}

function Controls({ voice, live }) {
  return (
    <div className="voice-controls">
      <button type="button" className="voice-ctrl" onClick={() => {
        haptic()
        setKeyboard(true)
      }} disabled={!live} aria-label="Type instead">
        <Icon name="keyboard" size={24} />
      </button>
      {voice.mode === 'hold'
        ? <HoldButton holding={voice.holding} disabled={!live} />
        : (
          <button type="button" className={`voice-ctrl voice-ctrl-main ${voice.muted ? 'is-on' : ''}`} onClick={() => {
            haptic()
            toggleMute()
          }} disabled={!live} aria-pressed={voice.muted} aria-label={voice.muted ? 'Unmute' : 'Mute'}>
            <Icon name={voice.muted ? 'micOff' : 'mic'} size={28} />
            <span className="voice-ctrl-label">{voice.muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
      <button type="button" className="voice-ctrl voice-ctrl-end" onClick={() => {
        haptic()
        endVoice('user')
      }} aria-label="End voice chat">
        <Icon name="phoneOff" size={24} />
      </button>
    </div>
  )
}

// Press and hold: pointer capture, no callout or text selection; sliding 80 px off cancels.
function HoldButton({ holding, disabled }) {
  const start = useRef(null)
  const cancelled = useRef(false)
  const onDown = (event) => {
    if (disabled || event.button > 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // older browsers
    }
    start.current = { x: event.clientX, y: event.clientY }
    cancelled.current = false
    haptic()
    holdStart()
  }
  const onMove = (event) => {
    if (!start.current || cancelled.current) return
    if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > HOLD_SLIDE_PX) {
      cancelled.current = true
      holdEnd({ cancel: true })
    }
  }
  const onUp = () => {
    if (!start.current) return
    start.current = null
    if (!cancelled.current) {
      haptic()
      holdEnd()
    }
  }
  const onCancel = () => {
    if (!start.current) return
    start.current = null
    holdEnd({ cancel: true })
  }
  return (
    <button
      type="button"
      className={`voice-ctrl voice-ctrl-main voice-hold ${holding ? 'is-holding' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onLostPointerCapture={onUp}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
          event.preventDefault()
          event.stopPropagation()
          holdStart()
        }
      }}
      onKeyUp={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          holdEnd()
        }
      }}
      disabled={disabled}
      aria-pressed={holding}
      aria-label="Hold to talk"
    >
      <Icon name="mic" size={28} />
      <span className="voice-ctrl-label">{holding ? 'Listening' : 'Hold to talk'}</span>
    </button>
  )
}

// Typing into the same live conversation. The field is 16 px (no iOS zoom) and rides above the
// keyboard; while it has focus the mic is off.
function KeyboardBar({ voice }) {
  const [text, setText] = useState('')
  const fieldRef = useRef(null)
  useEffect(() => {
    const stop = watchKeyboard()
    fieldRef.current?.querySelector('textarea')?.focus()
    return () => {
      stop()
      setTypingFocus(false)
    }
  }, [])
  const submit = () => {
    if (sendTyped(text)) setText('')
  }
  return (
    <div className="voice-keyboard">
      <div className="voice-keyboard-row" ref={fieldRef}>
        <button type="button" className="voice-round-btn" onClick={() => setKeyboard(false)} aria-label="Close the keyboard">
          <Icon name="close" size={20} />
        </button>
        <AutoTextarea
          value={text}
          minRows={1}
          maxRows={5}
          className="voice-input"
          placeholder="Type to Daybook…"
          aria-label="Message"
          enterKeyHint="send"
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setTypingFocus(true)}
          onBlur={() => setTypingFocus(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button type="button" className="voice-send" onClick={submit} disabled={!text.trim() || voice.status !== 'live'} aria-label="Send">
          <Icon name="send" size={20} strokeWidth={2.4} />
        </button>
      </div>
      <label className="voice-quiet">
        <input type="checkbox" role="switch" className="switch" checked={voice.quiet} onChange={(event) => {
          haptic()
          setQuiet(event.target.checked)
        }} />
        <span>Quiet replies <small>(text only, no voice)</small></span>
      </label>
    </div>
  )
}

// ---- when the call couldn't start -------------------------------------------------------------------

const SETTINGS_CODES = new Set(['off', 'daily', 'budget', 'setup'])
const RETRY_CODES = new Set(['mic_denied', 'mic_busy', 'mic_failed', 'connect', 'offline', 'busy'])

function typeInstead() {
  const onAssistant = /^#\/?assistant(?:[/?]|$)/.test(window.location.hash)
  closeVoice(onAssistant ? {} : { then: 'assistant' })
  if (onAssistant) setTimeout(() => document.querySelector('#main textarea')?.focus(), 60)
}

function VoiceError({ voice }) {
  const { code, message } = voice.error || {}
  const desktop = typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches
  const text = code === 'mic_denied' && desktop
    ? 'Microphone is blocked for Daybook. Allow it from the mic icon in the address bar, then try again.'
    : message || 'Couldn’t start the voice chat.'
  return (
    <>
      <div className="voice-top">
        <span className="voice-top-spacer" />
        <span className="voice-title">Voice chat</span>
        <button type="button" className="voice-round-btn" onClick={() => closeVoice()} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="voice-scroll">
        <div className="voice-error" role="alert">
          <span className="voice-error-icon" aria-hidden="true"><Icon name={code?.startsWith('mic') ? 'micOff' : code === 'offline' ? 'cloudOff' : 'alert'} size={28} /></span>
          <p className="voice-error-text">{text}</p>
          <div className="voice-summary-actions">
            {RETRY_CODES.has(code) && (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={retryVoice}>Try again</button>
            )}
            <button type="button" className={`btn ${RETRY_CODES.has(code) ? 'btn-secondary' : 'btn-primary'} btn-lg btn-block`} onClick={typeInstead}>
              <Icon name="keyboard" size={18} />
              Type instead
            </button>
            {SETTINGS_CODES.has(code) && (
              <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={() => closeVoice({ then: 'settings/voice' })}>
                <Icon name="settings" size={18} />
                Settings
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

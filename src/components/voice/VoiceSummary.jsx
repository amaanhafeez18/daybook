import Icon from '../ui/Icon.jsx'
import ActionChips from '../ActionChips.jsx'
import { ProposalCard } from '../../pages/AssistantPage.jsx'
import { formatUsd } from '../../lib/aiPricing.js'
import { closeVoice, continueVoice, decideCard, endVoice, undoCard } from '../../lib/voice/session.js'

// After a voice chat: saved to the chat, how long, about what it cost, what changed (with Undo),
// links to where the changes are, and Continue when a limit or leaving the app ended it. A paused
// call (left the app, a phone call, the connection) shows the same screen with Continue first.

const END_TEXT = {
  user: null,
  cap: 'That’s the call length limit. You can carry on in a new call.',
  daily: 'You’ve used today’s voice minutes. Typing still works.',
  budget: 'This month’s AI budget is used up, so voice is paused. Typing still works.',
  quiet: 'Hung up after a quiet spell.',
  error: 'The call ended because of a connection problem.',
}

const PAUSE_TEXT = {
  background: 'Paused when you left',
  interrupted: 'Paused for a call or Siri',
  network: 'Paused: the connection dropped',
  navigated: 'Paused',
}

// Where each kind of change lives (deep links only here, never during the call).
const LINKS = [
  { route: 'tasks', label: 'Open Tasks', icon: 'tasks', tools: /^(create_task|update_task|create_event)$/ },
  { route: 'journal', label: 'Open Journal', icon: 'journal', tools: /^write_journal$/ },
  { route: 'people', label: 'Open People', icon: 'people', tools: /^(create_friend|update_friend|log_contact)$/ },
  { route: 'food', label: 'Open Food', icon: 'utensils', tools: /^food_/ },
  { route: 'gym', label: 'Open Gym', icon: 'dumbbell', tools: /^gym_/ },
]

function minutesText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} s`
  return `${Math.round(total / 60)} min`
}

export default function VoiceSummary({ voice }) {
  const { summary, actions, proposal, deciding, status, pauseReason, startedAt } = voice
  const paused = status === 'paused'
  const changes = (actions || []).filter((action) => action?.ok && !action.undone).length
  const links = LINKS.filter((link) => (actions || []).some((action) => action?.ok && !action.undone && link.tools.test(String(action.tool || ''))))
  const saved = summary?.saved
  const reason = summary?.end
  const note = paused ? null : END_TEXT[reason] || null
  const facts = [minutesText(summary?.seconds ?? voice.seconds), `≈ ${formatUsd(summary?.usd ?? voice.usd)}`, changes ? `${changes} change${changes === 1 ? '' : 's'}` : null].filter(Boolean)

  return (
    <div className="voice-summary">
      <div className="voice-summary-head">
        <span className={`voice-summary-icon ${paused ? 'is-paused' : ''}`} aria-hidden="true">
          <Icon name={paused ? 'pause' : saved === false ? 'alert' : 'check'} size={26} strokeWidth={2.2} />
        </span>
        <h2 className="voice-summary-title">
          {paused ? PAUSE_TEXT[pauseReason] || 'Paused' : saved === null || status === 'ending' ? 'Saving to your chat…' : saved === false ? 'Not saved yet' : summary?.empty ? 'Voice chat ended' : 'Saved to your chat'}
        </h2>
        <p className="voice-summary-facts">{facts.join(' · ')}</p>
        {saved === false && !paused && <p className="voice-summary-note">It will try again the next time you open Daybook.</p>}
        {note && <p className="voice-summary-note">{note}</p>}
      </div>

      {proposal && (
        <div className="voice-cards">
          <ProposalCard proposal={proposal} createdAt={proposal.createdAt} isLast busy={deciding} onDecide={(decision) => decideCard(proposal.id, decision)} />
        </div>
      )}
      {actions?.length > 0 && (
        <div className="voice-cards">
          <ActionChips actions={actions} createdAt={startedAt} onUndo={undoCard} />
        </div>
      )}

      {!paused && links.length > 0 && (
        <div className="voice-links">
          {links.map((link) => (
            <button key={link.route} type="button" className="chip voice-link" onClick={() => closeVoice({ then: link.route })}>
              <Icon name={link.icon} size={16} />
              {link.label}
            </button>
          ))}
        </div>
      )}

      <div className="voice-summary-actions">
        {summary?.canContinue && (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={continueVoice}>
            <Icon name="waveform" size={18} />
            {paused ? 'Continue' : 'Continue talking'}
          </button>
        )}
        <button
          type="button"
          className={`btn ${summary?.canContinue ? 'btn-secondary' : 'btn-primary'} btn-lg btn-block`}
          onClick={() => (paused ? endVoice('user') : closeVoice())}
        >
          {paused ? 'End' : 'Done'}
        </button>
      </div>
    </div>
  )
}

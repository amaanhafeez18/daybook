import Icon from './ui/Icon.jsx'
import { canUndo } from '../lib/assistantChat.js'
import './assistant.css'
import './voice/talk.css'

// What the assistant did, one chip per change: done (with Undo for about an hour), failed, or
// undone. Shared by the chat (under a reply, and in a voice chat's card) and the live voice chat,
// so the chips look and behave the same everywhere. `actions` are shown as given (the caller picks
// which: see visibleActions); `onUndo(undoId)` takes one back. Nothing offers Undo while `streaming`.
export default function ActionChips({ actions, createdAt, streaming = false, onUndo, className = '' }) {
  const list = (Array.isArray(actions) ? actions : []).filter((action) => action && (action.message || action.ok === false))
  if (!list.length) return null
  return (
    <ul className={`action-chips asst-chips ${className}`}>
      {list.map((action, index) => {
        const undoable = !streaming && !!onUndo && canUndo(action, createdAt)
        return (
          <li key={action.undoId || index} className={`${action.ok ? 'is-ok' : 'is-failed'} ${action.undone ? 'is-undone' : ''} ${undoable ? 'has-undo' : ''}`}>
            <Icon name={action.undone ? 'undo' : action.ok ? 'check' : 'alert'} size={14} />
            <span className="asst-chip-msg">{action.message || 'That didn’t work.'}</span>
            {action.undone && <span className="asst-undone">Undone</span>}
            {undoable && (
              <button type="button" className="asst-undo" onClick={() => onUndo(action.undoId)} disabled={!!action.undoing} aria-label={`Undo: ${action.message}`}>
                {action.undoing ? <span className="spinner" aria-hidden="true" /> : 'Undo'}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

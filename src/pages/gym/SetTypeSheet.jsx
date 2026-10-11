import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import '../../components/ui/action-sheet.css'
import { SetTypeBadge } from './common.jsx'

// Choosing a set's type (Normal, Warm-up, Drop set, Failure): one grouped bottom sheet, the same in
// the workout and in the routine editor. It is laid out like the shared ActionSheet (.gym-as-*
// rows), with the set badge where an action's icon would be. onPick gets the chosen type (the caller
// decides what picking the current one again means); `extra` adds one more group of actions after
// it (the workout's "Delete set"; the routine editor has a delete button on every set instead).

export const SET_TYPE_OPTIONS = [
  { type: 'normal', label: 'Normal', hint: 'Counts toward weight lifted, sets and records' },
  { type: 'warmup', label: 'Warm-up', hint: 'Left out of weight lifted, set counts and PRs' },
  { type: 'drop', label: 'Drop set', hint: 'Lighter set straight after, no rest before it' },
  { type: 'failure', label: 'Failure', hint: 'A working set taken to failure' },
]

export default function SetTypeSheet({ open, onClose, title = 'Set', type = 'normal', number, onPick, extra }) {
  const actions = (extra || []).filter(Boolean)
  return (
    <Sheet open={open} onClose={onClose} title={title} description="Choose the set type" size="sm" initialFocus={false} grouped>
      <div className="gym-as-groups">
        <div className="gym-as-list gym-st-list">
          {SET_TYPE_OPTIONS.map((option) => {
            const selected = type === option.type
            return (
              <button
                key={option.type}
                type="button"
                className="gym-as-row"
                aria-pressed={selected}
                onClick={() => {
                  onPick(option.type)
                  onClose()
                }}
              >
                <span className="gym-st-badge" aria-hidden="true">
                  <SetTypeBadge type={option.type} number={option.type === 'normal' ? number ?? 1 : undefined} />
                </span>
                <span className="gym-as-label">
                  {option.label}
                  <small>{selected && option.type !== 'normal' ? 'Tap again to make it a normal set' : option.hint}</small>
                </span>
                {selected && <Icon name="check" size={18} strokeWidth={2.4} className="gym-as-check" />}
              </button>
            )
          })}
        </div>
        {actions.length > 0 && (
          <div className="gym-as-list">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={`gym-as-row${action.danger ? ' is-danger' : ''}`}
                onClick={() => {
                  onClose()
                  action.onClick()
                }}
              >
                {action.icon && <Icon name={action.icon} size={20} />}
                <span className="gym-as-label">{action.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}

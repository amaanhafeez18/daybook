import Icon from './Icon.jsx'
import Sheet from './Sheet.jsx'
import './action-sheet.css'

// ---- action sheets -----------------------------------------------------------------------------
// The one ⋯ menu the app uses everywhere: an iOS-style titled sheet with grouped actions. Pass a
// flat list (one group) or a list of lists (groups, separated); destructive actions go last with
// `danger`. A falsy entry is skipped, so callers can write `cond && { … }`.
// (Moved from pages/gym/common.jsx, which re-exports it; the .gym-as-* class names stay.)
// `grouped`: an opaque grouped sheet with white / #2C2C2E cells, the same look as SetTypeSheet.

export function ActionSheet({ open, onClose, title, description, actions }) {
  const groups = (Array.isArray(actions?.[0]) ? actions : [actions || []])
    .map((group) => (Array.isArray(group) ? group.filter(Boolean) : []))
    .filter((group) => group.length)
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} size="sm" initialFocus={false} grouped>
      <div className="gym-as-groups">
        {groups.map((group, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="gym-as-list">
            {group.map((action) => (
              <button
                key={action.id}
                type="button"
                className={`gym-as-row${action.danger ? ' is-danger' : ''}`}
                disabled={action.disabled}
                aria-current={action.checked ? 'true' : undefined}
                onClick={() => {
                  onClose()
                  action.onClick()
                }}
              >
                {action.icon && <Icon name={action.icon} size={20} />}
                <span className="gym-as-label">
                  {action.label}
                  {action.hint && <small>{action.hint}</small>}
                </span>
                {action.value && <span className="gym-as-value">{action.value}</span>}
                {action.checked && <Icon name="check" size={18} strokeWidth={2.4} className="gym-as-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  )
}

export default ActionSheet

import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Callout from '../../components/ui/Callout.jsx'
import { ActionSheet } from '../../components/ui/ActionSheet.jsx'
import { IconButton } from '../../components/ui/primitives.jsx'
import { useStore } from '../../lib/store.js'
import { goBack } from '../gym/common.jsx'

// Pieces shared by the Food page views: the in-page back button, a ⋯ menu, swipe-to-delete rows
// (the shared ui/SwipeRow), stat tiles and the "database needs updating" note.

export { goBack }
export { SwipeRow } from '../../components/ui/SwipeRow.jsx'

export function DetailTop({ backLabel = 'Food', fallback = 'food', children }) {
  return (
    <div className="food-detail-top">
      <button type="button" className="food-back" onClick={() => goBack(fallback)}>
        <Icon name="chevronLeft" size={22} />
        {backLabel}
      </button>
      {children && <div className="food-detail-actions">{children}</div>}
    </div>
  )
}

// A round ⋯ button that opens the app's grouped action sheet (components/ui/ActionSheet), as every
// other ⋯ does. items: [{ label, icon, onClick, danger?, disabled? }]; { divider: true } starts a new
// group (edit · go to · settings), so destructive or rare actions can sit in their own group last.
export function Menu({ items, label = 'More options', title, icon = 'more', className = '' }) {
  const [open, setOpen] = useState(false)
  const groups = [[]]
  for (const item of items) {
    if (!item) continue
    if (item.divider) groups.push([])
    else groups[groups.length - 1].push({ ...item, id: item.id || item.label })
  }
  const actions = groups.filter((group) => group.length)
  if (!actions.length) return null
  return (
    <div className={`food-menu-wrap ${className}`}>
      <IconButton icon={icon} label={label} className="food-head-btn" size={21} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      <ActionSheet open={open} onClose={() => setOpen(false)} title={title} actions={actions} />
    </div>
  )
}

export function StatTile({ label, value, sub, tone }) {
  return (
    <div className={`food-stat${tone ? ` is-${tone}` : ''}`}>
      <span className="food-stat-label">{label}</span>
      <span className="food-stat-value">{value ?? '—'}</span>
      {sub != null && sub !== '' && <span className="food-stat-sub">{sub}</span>}
    </div>
  )
}

const MIGRATION_ERROR = /Food data|Gym data/
const isMigrationError = (message) => typeof message === 'string' && MIGRATION_ERROR.test(message)

// The sync error from a save that needs a database update (food table or body weights). Read per
// list (state.saveErrors), so another list's failure (a timeout on settings) can't hide it; a store
// without saveErrors only has the newest failure (saveError).
function selectMigrationError(state) {
  const errors = state.saveErrors
  if (!errors || typeof errors !== 'object') return isMigrationError(state.saveError) ? state.saveError : ''
  return [errors.foodEntries, errors.bodyWeights, errors.gymSessions].find(isMigrationError) || ''
}

export function MigrationNote() {
  const error = useStore(selectMigrationError)
  if (!error) return null
  return (
    <Callout tone="warning" icon="cloudOff" role="status" className="food-callout">{error} Until then, entries stay on this device.</Callout>
  )
}

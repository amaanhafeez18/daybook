import { toast } from '../../components/ui/feedback.jsx'
import { orphanMatches, orphanSummary } from '../../lib/gym/stats.js'
import { getGym, relinkSessions } from '../../lib/gym/state.js'
import { getState } from '../../lib/store.js'

// Past workouts whose routine was deleted (a rebuilt plan gives routines new ids) can be pointed
// at a current routine again. Always offered, never done silently: one tap, then Undo.

const storedSessions = () => getState().data.gymSessions

// Relinks the matches (stats.orphanMatches) and confirms with Undo; false when nothing changed.
// Matches whose routine is gone by now (its creation was undone) are dropped.
export function linkMatches(matches, label) {
  const routineIds = new Set(getGym().routines.map((routine) => routine.id))
  const live = (Array.isArray(matches) ? matches : []).filter((match) => routineIds.has(match?.routineId))
  if (!live.length) return false
  let undo = null
  try {
    undo = relinkSessions(live)
  } catch (error) {
    toast(error?.message || 'Couldn’t link the workouts.', { tone: 'error' })
    return false
  }
  if (!undo) return false
  toast(`Linked ${label ?? orphanSummary(live)}`, { tone: 'success', action: { label: 'Undo', onClick: undo } })
  return true
}

// After routines were created: "Link 4 past Push workouts?" when old workouts carry their names.
export function offerRelink(routineIds) {
  const ids = [...(routineIds || [])].filter((id) => id != null)
  if (!ids.length) return
  const matches = orphanMatches(storedSessions(), getGym().routines, { routineIds: ids })
  if (!matches.length) return
  // Matched again on tap: the new routines may have been undone (or the workouts linked) since.
  const onClick = () => linkMatches(orphanMatches(storedSessions(), getGym().routines, { routineIds: ids }))
  toast(`Link ${orphanSummary(matches)}?`, { duration: 8000, action: { label: 'Link', onClick } })
}

import { useRef, useState } from 'react'
import { toast } from './ui/feedback.jsx'

// The one way a form sheet closes with unsaved changes: nothing is asked and nothing is lost. The
// changes are kept and a "Draft kept · Reopen" toast brings the sheet back with them (the same
// promise the task, person and class sheets make with lib/drafts.js).
//
//   const keeper = useDraftKeeper(open)
//   <Sheet open={keeper.shown} onClose={() => (dirty ? keeper.keep(state, onClose) : keeper.done(onClose))}>
//   when the sheet opens: setState(keeper.take() ?? fresh())   (take = the kept state after Reopen)
//   after saving:         keeper.done(onClose)
//
// The draft lives as long as the sheet stays mounted (lazy sheets do), which covers the toast.
export function useDraftKeeper(open) {
  const [reopened, setReopened] = useState(false)
  const kept = useRef(null)
  const shown = open || reopened
  return {
    shown,
    keep(value, onClose) {
      kept.current = value
      toast('Draft kept', { key: 'draft-kept', action: { label: 'Reopen', onClick: () => setReopened(true) } })
      setReopened(false)
      onClose?.()
    },
    // The kept draft when the sheet is opening from Reopen; null for a normal open. (No side
    // effect, so it is safe to call while rendering.)
    take() {
      return reopened ? kept.current : null
    },
    done(onClose) {
      kept.current = null
      setReopened(false)
      onClose?.()
    },
  }
}

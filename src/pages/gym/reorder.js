// Drag to reorder for the gym lists (routine editor, Routines tab, the workout's Reorder mode), on
// top of components/ui/useDragSort.js: a grip on each row (long press not needed), arrow keys on
// the grip. While a row is being dragged the new order lives here; it is handed to onCommit once,
// on drop (or straight away for an arrow key), so nothing is saved per pixel and supersets the row
// only passes over aren't split on the way.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { moveItem, useDragSort } from '../../components/ui/useDragSort.js'

export { joinDropped, orderByIds } from './reorderRows.js'

// { keys, sort }: render the rows in `keys` order with sort.item(key) / sort.handle(key).
// onCommit(order, movedKey, dragged): dragged is false for an arrow key (one step), so callers can
// treat it like their Move up / Move down.
export function useLocalReorder(ids, onCommit) {
  const [pending, setPending] = useState(null) // { order, moved } until committed
  const dragged = useRef(false)
  const refocus = useRef(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const keys = pending ? pending.order : ids

  const sort = useDragSort({
    keys,
    onMove: (from, to) => {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (active?.classList?.contains('drag-grip')) refocus.current = active
      setPending({ order: moveItem(keys, from, to), moved: keys[from] })
    },
  })
  if (sort.dragging != null) dragged.current = true

  // React moves the row's element, which can drop focus from its grip: put it back (arrow keys).
  // Only a grip: an input focused elsewhere isn't pulled back (that would reopen the keyboard).
  useLayoutEffect(() => {
    const element = refocus.current
    refocus.current = null
    if (element?.isConnected && document.activeElement !== element) element.focus({ preventScroll: true })
  })

  useEffect(() => {
    if (sort.dragging != null) return
    const wasDragged = dragged.current
    dragged.current = false
    if (!pending) return
    setPending(null)
    commitRef.current?.(pending.order, pending.moved, wasDragged)
  }, [sort.dragging, pending])

  return { keys, sort }
}

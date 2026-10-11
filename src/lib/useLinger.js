import { useCallback, useEffect, useMemo, useState } from 'react'

// A ticked-off row stays where it was for a moment (with Undo right there), then folds away. The
// hook tracks which ids do that; the list keeps rendering them in place:
//   lingering: ids still shown although done (it includes the ones in `leaving`)
//   leaving:   ids whose row should collapse now (TaskRow `leaving`), then call onLeft(id)
// Newly done ids are spotted during render, not in an effect: an effect runs after the row was
// already dropped from the list, and bringing it back remounts it (the tick animation restarts).

const LEAVE_GRACE_MS = 1500 // a leaving row that never reports back is let go after this

export const EMPTY_LINGER = Object.freeze({ open: null, lingering: new Map(), leaving: new Map() })

// One step of the state, pure: prev → next (prev itself when nothing changed).
// openIds / doneIds: the ids open and done right now (arrays or Sets); now: ms; ms: the pause.
// - an id that was open last time and is done now starts lingering (since `now`)
// - one that lingered for `ms` starts leaving
// - one reopened (Undo during the pause) or gone (deleted, archived) is simply dropped
// - one left leaving for longer than LEAVE_GRACE_MS is dropped too
export function lingerStep(prev = EMPTY_LINGER, openIds = [], doneIds = [], now = 0, ms = 1200) {
  const open = openIds instanceof Set ? openIds : new Set(openIds)
  const done = doneIds instanceof Set ? doneIds : new Set(doneIds)
  let changed = false
  const lingering = new Map()
  const leaving = new Map()
  for (const [id, since] of prev.lingering) {
    if (!done.has(id)) changed = true
    else if (now - since >= ms) {
      leaving.set(id, now)
      changed = true
    } else lingering.set(id, since)
  }
  for (const [id, since] of prev.leaving) {
    if (!done.has(id) || now - since >= LEAVE_GRACE_MS) changed = true
    else leaving.set(id, since)
  }
  if (prev.open) {
    for (const id of prev.open) {
      if (done.has(id) && !lingering.has(id) && !leaving.has(id)) {
        lingering.set(id, now)
        changed = true
      }
    }
  }
  const sameOpen = prev.open && prev.open.size === open.size && [...open].every((id) => prev.open.has(id))
  if (!changed && sameOpen) return prev
  return { open: sameOpen ? prev.open : open, lingering, leaving }
}

// The ids shown although done: lingering plus leaving.
export const shownIds = (state) => new Set([...state.lingering.keys(), ...state.leaving.keys()])

const keyOf = (ids) => [...ids].join('\u0001')

// useLinger(openIds, doneIds, { ms }) → { lingering: Set, leaving: Set, onLeft(id) }
export function useLinger(openIds, doneIds, { ms = 1200 } = {}) {
  const key = `${keyOf(openIds)}|${keyOf(doneIds)}`
  const [state, setState] = useState(() => ({ ...lingerStep(EMPTY_LINGER, openIds, doneIds, Date.now(), ms), key, done: new Set(doneIds) }))
  let current = state
  if (state.key !== key) {
    // Setting state while rendering: React re-renders this component straight away, before
    // children see the new lists, so a ticked row never drops out for a frame.
    current = { ...lingerStep(state, openIds, doneIds, Date.now(), ms), key, done: new Set(doneIds) }
    setState(current)
  }

  // Move lingering ids on to leaving once their pause is over.
  const { lingering, leaving } = current
  useEffect(() => {
    if (!lingering.size && !leaving.size) return undefined
    const now = Date.now()
    const due = [...lingering.values()].map((since) => since + ms)
      .concat([...leaving.values()].map((since) => since + LEAVE_GRACE_MS))
    const wait = Math.max(0, Math.min(...due) - now)
    const timer = setTimeout(() => {
      setState((prev) => {
        const next = lingerStep(prev, prev.open || [], prev.done, Date.now(), ms)
        return next === prev ? prev : { ...next, key: prev.key, done: prev.done }
      })
    }, wait + 16)
    return () => clearTimeout(timer)
  }, [lingering, leaving, ms])

  const onLeft = useCallback((id) => {
    setState((prev) => {
      if (!prev.leaving.has(id)) return prev
      const nextLeaving = new Map(prev.leaving)
      nextLeaving.delete(id)
      return { ...prev, leaving: nextLeaving }
    })
  }, [])

  const shown = useMemo(() => shownIds({ lingering, leaving }), [lingering, leaving])
  const leavingIds = useMemo(() => new Set(leaving.keys()), [leaving])
  return { lingering: shown, leaving: leavingIds, onLeft }
}

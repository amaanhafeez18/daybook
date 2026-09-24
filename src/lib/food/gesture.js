// Pure helpers for the food page's swipe rows (no DOM or React), so they can be unit-tested.

// After a mouse drag, or a press-and-hold that was released without moving, the browser sends a
// click for the same touch or button; the row must ignore that one and nothing else. A touch swipe
// sends no click at all, so an "ignore the next click" flag would swallow the user's next real tap
// (on the Delete button it just revealed). This tells the two apart: the gesture's trailing click
// arrives within a moment of the release, at the same spot.
//   mark: { x, y, at } — where the pointer was released and when (event timeStamps).
//   click: { clientX, clientY, timeStamp } — the click to judge.
export function clickEndsGesture(mark, click, { withinMs = 500, withinPx = 12 } = {}) {
  if (!mark || !click) return false
  const at = Number(mark.at)
  const when = Number(click.timeStamp)
  if (!Number.isFinite(at) || !Number.isFinite(when)) return false
  const elapsed = when - at
  if (elapsed < -1 || elapsed > withinMs) return false
  const dx = Number(click.clientX ?? 0) - Number(mark.x ?? 0)
  const dy = Number(click.clientY ?? 0) - Number(mark.y ?? 0)
  return Math.hypot(dx, dy) <= withinPx
}

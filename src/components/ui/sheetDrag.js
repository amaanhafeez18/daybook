// Pull-down-to-close from a sheet's content (Sheet.jsx), the decision part. Pure, so it can be tested.
//
// A touch in the sheet's body becomes a close drag only when the body is scrolled to the top and the
// finger's first clear movement is downwards and mostly vertical. Anything else (scrolling the list,
// a sideways swipe on a chip row, a pull while the content is scrolled) is left to the browser.
// The decision is made once per touch, within a few px: browsers start scrolling after about 10 px,
// and only touchmoves before that can still be cancelled.

export const CONTENT_SLOP_PX = 6
const VERTICAL_RATIO = 1.2 // |dy| must beat |dx| by this much

// 'wait' (not moved enough to tell), 'drag' (take it: the sheet follows) or 'ignore' (let it scroll).
export function contentDragIntent({ dx, dy, scrollTop = 0, slop = CONTENT_SLOP_PX }) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'ignore'
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return 'wait'
  if (scrollTop > 0) return 'ignore'
  if (dy > 0 && dy >= Math.abs(dx) * VERTICAL_RATIO) return 'drag'
  return 'ignore'
}

// Where a pull must never start: anything marked data-no-sheet-drag (sliders, drag-to-sort lists,
// the food tray), range inputs, and the field being typed in.
export const NO_SHEET_DRAG = '[data-no-sheet-drag], input[type="range"]'

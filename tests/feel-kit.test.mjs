import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { contentDragIntent } from '../src/components/ui/sheetDrag.js'
import { thumbBox } from '../src/components/ui/useSlidingThumb.js'
import { easeOutCubic, tweenValue } from '../src/lib/useAnimatedNumber.js'
import { awayLongEnough, canUpdateQuietly, holdsTypedText, QUIET_AWAY_MS, scrollMemo, scrollToRestore, workoutRunning } from '../src/lib/quietUpdate.js'
import { haptic } from '../src/lib/haptics.js'
import { focusBeforePrime, primeKeyboard } from '../src/lib/keyboard.js'

describe('contentDragIntent (pull a sheet down from its content)', () => {
  test('waits until the finger has clearly moved', () => {
    assert.equal(contentDragIntent({ dx: 2, dy: 4, scrollTop: 0 }), 'wait')
  })

  test('a downward, mostly vertical pull at the top takes the sheet', () => {
    assert.equal(contentDragIntent({ dx: 1, dy: 8, scrollTop: 0 }), 'drag')
    assert.equal(contentDragIntent({ dx: -5, dy: 7, scrollTop: 0 }), 'drag')
  })

  test('scrolled content scrolls instead', () => {
    assert.equal(contentDragIntent({ dx: 0, dy: 12, scrollTop: 40 }), 'ignore')
  })

  test('an upward or sideways first move is left to the browser', () => {
    assert.equal(contentDragIntent({ dx: 0, dy: -10, scrollTop: 0 }), 'ignore')
    assert.equal(contentDragIntent({ dx: 10, dy: 6, scrollTop: 0 }), 'ignore')
    assert.equal(contentDragIntent({ dx: 8, dy: 8, scrollTop: 0 }), 'ignore')
  })

  test('missing numbers never take the sheet', () => {
    assert.equal(contentDragIntent({ dx: NaN, dy: 20 }), 'ignore')
  })
})

describe('thumbBox (sliding selection)', () => {
  const container = { offsetWidth: 300, offsetHeight: 36 }

  test('the active child inside its positioned container', () => {
    const button = { offsetWidth: 96, offsetHeight: 30, offsetLeft: 101, offsetTop: 3, offsetParent: container }
    assert.deepEqual(thumbBox(button, container), { x: 101, y: 3, w: 96, h: 30 })
  })

  test('a link inside a list item adds up the offsets on the way', () => {
    const li = { offsetWidth: 80, offsetHeight: 50, offsetLeft: 160, offsetTop: 0, offsetParent: container }
    const link = { offsetWidth: 80, offsetHeight: 50, offsetLeft: 0, offsetTop: 0, offsetParent: li }
    assert.deepEqual(thumbBox(link, container), { x: 160, y: 0, w: 80, h: 50 })
  })

  test('an unpositioned container falls back to the rectangles', () => {
    const outer = {}
    const box = { clientLeft: 1, clientTop: 1, scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 20, top: 100 }) }
    const button = {
      offsetWidth: 60, offsetHeight: 28, offsetLeft: 74, offsetTop: 104, offsetParent: outer,
      getBoundingClientRect: () => ({ left: 74, top: 104 }),
    }
    assert.deepEqual(thumbBox(button, box), { x: 53, y: 3, w: 60, h: 28 })
  })

  test('nothing to show while hidden', () => {
    assert.equal(thumbBox({ offsetWidth: 0, offsetHeight: 0, offsetParent: null }, container), null)
    assert.equal(thumbBox(null, container), null)
  })
})

describe('tweenValue (numbers that count)', () => {
  test('starts where it was and lands exactly on the new value', () => {
    assert.equal(tweenValue(1800, 1650, 0), 1800)
    assert.equal(tweenValue(1800, 1650, 1), 1650)
    assert.equal(tweenValue(72.5, 73.25, 1), 73.25)
  })

  test('eases out: most of the way early on', () => {
    assert.ok(easeOutCubic(0.5) > 0.8)
    const half = tweenValue(0, 100, 0.5)
    assert.ok(half > 80 && half < 100)
  })

  test('keeps the decimals of the numbers involved', () => {
    assert.equal(Number.isInteger(tweenValue(1800, 1650, 0.37)), true)
    const weight = tweenValue(72.5, 73.25, 0.4)
    assert.equal(Math.round(weight * 100) / 100, weight)
  })
})

describe('quiet updates', () => {
  const safe = { inWindow: true, waiting: true, unsaved: false, sheetOpen: false, typing: false, workoutActive: false }

  test('applies quietly only when nothing could be lost', () => {
    assert.equal(canUpdateQuietly(safe), true)
    for (const key of ['unsaved', 'sheetOpen', 'typing', 'workoutActive', 'typed', 'replying']) {
      assert.equal(canUpdateQuietly({ ...safe, [key]: true }), false, key)
    }
    assert.equal(canUpdateQuietly({ ...safe, inWindow: false }), false)
    assert.equal(canUpdateQuietly({ ...safe, waiting: false }), false)
  })

  test('text left in a field counts as typed, saved-elsewhere fields do not', () => {
    const inAutosave = (selector) => (selector === '[data-autosave]' ? {} : null)
    assert.equal(holdsTypedText({ tagName: 'TEXTAREA', value: 'Half a message' }), true)
    assert.equal(holdsTypedText({ tagName: 'INPUT', type: 'text', value: 'Call the bank' }), true)
    assert.equal(holdsTypedText({ tagName: 'INPUT', value: 'no type = text' }), true)
    assert.equal(holdsTypedText({ tagName: 'INPUT', type: 'text', value: '   ' }), false)
    assert.equal(holdsTypedText({ tagName: 'INPUT', type: 'search', value: 'milk' }), false)
    assert.equal(holdsTypedText({ tagName: 'INPUT', type: 'date', value: '2026-01-05' }), false)
    assert.equal(holdsTypedText({ tagName: 'INPUT', type: 'text', value: 'x', readOnly: true }), false)
    assert.equal(holdsTypedText({ tagName: 'TEXTAREA', value: 'x', disabled: true }), false)
    assert.equal(holdsTypedText({ tagName: 'TEXTAREA', value: 'Journal text', closest: inAutosave }), false)
    assert.equal(holdsTypedText(null), false)
  })

  test('a return opens the window only after a while away', () => {
    const now = 10_000_000
    assert.equal(awayLongEnough(now - QUIET_AWAY_MS, now), true)
    assert.equal(awayLongEnough(now - 60_000, now), false)
    assert.equal(awayLongEnough(0, now), false)
  })

  test('the scroll comes back on the same screen only', () => {
    const memo = scrollMemo(640.4, '#/tasks', 1000)
    assert.equal(scrollToRestore(memo, '#/tasks', 2000), 640)
    assert.equal(scrollToRestore(memo, '#/today', 2000), null)
    assert.equal(scrollToRestore(memo, '#/tasks', 1000 + 120_000), null)
    assert.equal(scrollToRestore(scrollMemo(0, '#/tasks', 1000), '#/tasks', 2000), null)
    assert.equal(scrollToRestore('junk', '#/tasks', 2000), null)
  })

  test('a stored workout counts as running', () => {
    assert.equal(workoutRunning(null), false)
    assert.equal(workoutRunning('null'), false)
    assert.equal(workoutRunning('{"id":"w1"}'), true)
    assert.equal(workoutRunning('{broken'), true)
  })
})

describe('feel helpers outside a browser', () => {
  test('haptic and primeKeyboard do nothing without a page', () => {
    assert.doesNotThrow(() => haptic())
    assert.doesNotThrow(() => haptic('success'))
    assert.doesNotThrow(() => primeKeyboard())
  })

  test('focusBeforePrime passes other elements through', () => {
    const element = {}
    assert.equal(focusBeforePrime(element), element)
    assert.equal(focusBeforePrime(null), null)
  })
})

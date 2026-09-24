// Run: node --test tests/food-swipe.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { clickEndsGesture } from '../src/lib/food/gesture.js'

describe('clickEndsGesture (swipe rows)', () => {
  const release = { x: 200, y: 300, at: 1000 }

  test('the click a mouse drag or a held press sends is the gesture’s own', () => {
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 300, timeStamp: 1001 }), true)
    assert.equal(clickEndsGesture(release, { clientX: 205, clientY: 296, timeStamp: 1300 }), true) // iOS may delay it
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 300, timeStamp: 1000 }), true)
  })

  test('a later tap, or one somewhere else, is a new action (a touch swipe sends no click)', () => {
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 300, timeStamp: 1800 }), false) // Delete tapped after a swipe
    assert.equal(clickEndsGesture(release, { clientX: 330, clientY: 300, timeStamp: 1050 }), false) // the Delete button, not the finger's spot
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 330, timeStamp: 1050 }), false)
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 300, timeStamp: 900 }), false) // before the release
  })

  test('tolerances can be tuned and bad input is never a match', () => {
    assert.equal(clickEndsGesture(release, { clientX: 200, clientY: 300, timeStamp: 1600 }, { withinMs: 500 }), false)
    assert.equal(clickEndsGesture(release, { clientX: 230, clientY: 300, timeStamp: 1050 }, { withinPx: 40 }), true)
    assert.equal(clickEndsGesture(null, { clientX: 200, clientY: 300, timeStamp: 1001 }), false)
    assert.equal(clickEndsGesture({ x: 200, y: 300, at: null }, { clientX: 200, clientY: 300, timeStamp: 1001 }), false) // never released
    assert.equal(clickEndsGesture(release, null), false)
    assert.equal(clickEndsGesture(release, { timeStamp: 'x' }), false)
  })
})

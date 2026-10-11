import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LINGER, lingerStep, shownIds } from '../src/lib/useLinger.js'

const ids = (map) => [...map.keys()].sort()

describe('lingerStep', () => {
  test('the first step only remembers what is open', () => {
    const state = lingerStep(EMPTY_LINGER, ['a', 'b'], ['c'], 0)
    assert.deepEqual([...state.open].sort(), ['a', 'b'])
    assert.deepEqual(ids(state.lingering), [])
    assert.deepEqual(ids(state.leaving), [])
  })

  test('an id that goes from open to done lingers, then leaves after the pause', () => {
    let state = lingerStep(EMPTY_LINGER, ['a', 'b'], [], 0)
    state = lingerStep(state, ['b'], ['a'], 100)
    assert.deepEqual(ids(state.lingering), ['a'])
    assert.equal(state.lingering.get('a'), 100)
    // Still within the pause: nothing changes (same object back).
    assert.equal(lingerStep(state, ['b'], ['a'], 1000), state)
    state = lingerStep(state, ['b'], ['a'], 1300)
    assert.deepEqual(ids(state.lingering), [])
    assert.deepEqual(ids(state.leaving), ['a'])
    assert.deepEqual([...shownIds(state)], ['a'])
  })

  test('Undo during the pause just drops the id', () => {
    let state = lingerStep(EMPTY_LINGER, ['a'], [], 0)
    state = lingerStep(state, [], ['a'], 10)
    state = lingerStep(state, ['a'], [], 500)
    assert.deepEqual(ids(state.lingering), [])
    assert.deepEqual(ids(state.leaving), [])
    // Undo while it was leaving too.
    state = lingerStep(state, [], ['a'], 600)
    state = lingerStep(state, [], ['a'], 2000)
    assert.deepEqual(ids(state.leaving), ['a'])
    state = lingerStep(state, ['a'], [], 2100)
    assert.deepEqual(ids(state.leaving), [])
  })

  test('a deleted or archived id is dropped; done ids never seen open do not linger', () => {
    let state = lingerStep(EMPTY_LINGER, ['a'], ['old'], 0)
    state = lingerStep(state, [], ['a', 'old', 'synced'], 10)
    assert.deepEqual(ids(state.lingering), ['a'])
    state = lingerStep(state, [], ['old'], 20)
    assert.deepEqual(ids(state.lingering), [])
  })

  test('a leaving row that never reports back is let go', () => {
    let state = lingerStep(EMPTY_LINGER, ['a'], [], 0)
    state = lingerStep(state, [], ['a'], 0)
    state = lingerStep(state, [], ['a'], 1200)
    assert.deepEqual(ids(state.leaving), ['a'])
    state = lingerStep(state, [], ['a'], 1200 + 1499)
    assert.deepEqual(ids(state.leaving), ['a'])
    state = lingerStep(state, [], ['a'], 1200 + 1500)
    assert.deepEqual(ids(state.leaving), [])
  })

  test('accepts Sets and a custom pause', () => {
    let state = lingerStep(EMPTY_LINGER, new Set(['a']), new Set(), 0, 500)
    state = lingerStep(state, new Set(), new Set(['a']), 0, 500)
    state = lingerStep(state, new Set(), new Set(['a']), 500, 500)
    assert.deepEqual(ids(state.leaving), ['a'])
  })
})

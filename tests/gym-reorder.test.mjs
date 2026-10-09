// Run: node --test tests/gym-reorder.test.mjs
// The gym's drag to reorder: putting rows in a dragged order, and a row dropped inside a superset.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { joinDropped, orderByIds } from '../src/pages/gym/reorderRows.js'

const rows = (...ids) => ids.map((id) => ({ id }))
const ids = (list) => list.map((row) => row.id)

describe('orderByIds', () => {
  test('puts rows in the given order', () => {
    assert.deepEqual(ids(orderByIds(rows('a', 'b', 'c'), ['c', 'a', 'b'])), ['c', 'a', 'b'])
  })

  test('returns the same array when nothing moved', () => {
    const list = rows('a', 'b', 'c')
    assert.equal(orderByIds(list, ['a', 'b', 'c']), list)
  })

  test('rows missing from the order keep their place at the end; unknown ids are ignored', () => {
    assert.deepEqual(ids(orderByIds(rows('a', 'b', 'c', 'd'), ['c', 'zz', 'a'])), ['c', 'a', 'b', 'd'])
  })

  test('a duplicated id is used once, and rows without ids are kept', () => {
    const list = [{ id: 'a' }, { name: 'no id' }, { id: 'b' }]
    const out = orderByIds(list, ['b', 'b', 'a'])
    assert.deepEqual(out.map((row) => row.id ?? row.name), ['b', 'a', 'no id'])
  })

  test('copes with a missing list or order', () => {
    assert.deepEqual(orderByIds(null, ['a']), [])
    const list = rows('a')
    assert.equal(orderByIds(list, null), list)
  })
})

describe('joinDropped', () => {
  const s = (id, supersetId) => ({ id, supersetId })

  test('a row dropped between two rows of one superset joins it', () => {
    const out = joinDropped([s('a', 'x'), s('m'), s('b', 'x')], 'm')
    assert.equal(out[1].supersetId, 'x')
  })

  test('leaves the list alone otherwise', () => {
    const between = [s('a', 'x'), s('m'), s('b', 'y')]
    assert.equal(joinDropped(between, 'm'), between)
    const edge = [s('m'), s('a', 'x'), s('b', 'x')]
    assert.equal(joinDropped(edge, 'm'), edge)
    const already = [s('a', 'x'), s('m', 'x'), s('b', 'x')]
    assert.equal(joinDropped(already, 'm'), already)
    const missing = [s('a', 'x'), s('b', 'x')]
    assert.equal(joinDropped(missing, 'zz'), missing)
  })

  test('does not change the original rows', () => {
    const list = [s('a', 'x'), s('m'), s('b', 'x')]
    joinDropped(list, 'm')
    assert.equal(list[1].supersetId, undefined)
  })
})

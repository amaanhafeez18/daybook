import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agoText, apartText, defaultPair, photoNudge, progressPhotos, weightNear } from '../src/lib/progressPhotos.js'

const photo = (id, date, createdAt = `${date}T09:00:00Z`, extra = {}) => ({ id, targetType: 'progress', targetId: date, kind: 'image', createdAt, ...extra })

describe('progress photos', () => {
  test('progressPhotos keeps dated progress images, oldest first', () => {
    const list = [
      photo('c', '2026-10-20'),
      { id: 'task-photo', targetType: 'task', targetId: 't1', kind: 'image' },
      photo('a', '2026-08-01'),
      photo('pdf', '2026-09-01', undefined, { kind: 'pdf' }),
      photo('bad', 'someday'),
      photo('b2', '2026-09-10', '2026-09-10T20:00:00Z'),
      photo('b1', '2026-09-10', '2026-09-10T08:00:00Z'),
    ]
    assert.deepEqual(progressPhotos(list).map((p) => p.id), ['a', 'b1', 'b2', 'c'])
    assert.deepEqual(progressPhotos(null), [])
  })

  test('photoNudge after four weeks only', () => {
    assert.equal(photoNudge([], '2026-10-21'), null)
    assert.equal(photoNudge([photo('a', '2026-10-01')], '2026-10-21'), null)
    assert.deepEqual(photoNudge([photo('a', '2026-09-23')], '2026-10-21'), { days: 28 })
  })

  test('weightNear picks the closest weigh-in within the window', () => {
    const weights = [{ date: '2026-10-01', kg: 80 }, { date: '2026-10-04', kg: 79.5 }, { date: '2026-10-10', kg: 79 }]
    assert.equal(weightNear(weights, '2026-10-03'), 79.5)
    assert.equal(weightNear(weights, '2026-10-02'), 80) // 1 day from 10-01, 2 from 10-04
    assert.equal(weightNear(weights, '2026-10-20'), null)
    assert.equal(weightNear(weights, '2026-10-07'), 79) // 3 days either side: the later weigh-in wins
  })

  test('apartText and agoText read naturally', () => {
    assert.equal(apartText('2026-10-01', '2026-10-01'), 'Same day')
    assert.equal(apartText('2026-10-01', '2026-10-02'), '1 day apart')
    assert.equal(apartText('2026-09-01', '2026-10-06'), '5 weeks apart')
    assert.equal(apartText('2026-10-06', '2026-06-01'), '4 months apart')
    assert.equal(apartText('2025-10-01', '2026-10-01'), '1 year apart')
    assert.equal(agoText(30), '4 weeks ago')
    assert.equal(agoText(90), '3 months ago')
  })

  test('defaultPair = first and newest', () => {
    assert.equal(defaultPair([photo('a', '2026-10-01')]), null)
    assert.deepEqual(defaultPair([photo('a', '2026-08-01'), photo('b', '2026-09-01'), photo('c', '2026-10-01')]), ['a', 'c'])
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, navLevel, navigate, parseNavHash, setNavigationGuard } from '../src/lib/router.js'
import { canUpdateQuietly } from '../src/lib/quietUpdate.js'
import { freshClass } from '../src/lib/motion.js'
import { clearSessionState, readSessionState, writeSessionState } from '../src/lib/sessionState.js'
import { lazyPage, preloadPage } from '../src/lib/lazyPage.js'

describe('classify', () => {
  test('switching tabs is instant', () => {
    assert.equal(classify('#/today', '#/tasks'), 'none')
    assert.equal(classify('#/tasks', '#/gym'), 'none')
    assert.equal(classify('#/gym/stats', '#/food'), 'none')
    assert.equal(classify('#/tasks', '#/tasks'), 'none')
  })

  test('the gym section tabs and its settings sheet stay still', () => {
    assert.equal(classify('#/gym', '#/gym/calendar'), 'none')
    assert.equal(classify('#/gym/routines', '#/gym/history'), 'none')
    assert.equal(classify('#/gym', '#/gym/settings'), 'none')
  })

  test('a deeper gym view pushes, and back pops', () => {
    assert.equal(classify('#/gym', '#/gym/stats'), 'push')
    assert.equal(classify('#/gym/routines', '#/gym/exercises'), 'push')
    assert.equal(classify('#/gym/exercises', '#/gym/exercise/bench'), 'push')
    assert.equal(classify('#/gym/history', '#/gym/session/abc'), 'push')
    assert.equal(classify('#/gym/session/abc', '#/gym/history', 'back'), 'pop')
    // A fallback link up (no history behind) is still a pop.
    assert.equal(classify('#/gym/stats', '#/gym', 'new'), 'pop')
  })

  test('another exercise from an exercise pushes; history back pops', () => {
    assert.equal(classify('#/gym/exercise/a', '#/gym/exercise/b', 'new'), 'push')
    assert.equal(classify('#/gym/exercise/b', '#/gym/exercise/a', 'back'), 'pop')
  })

  test('the workout and the routine editor slide up and down', () => {
    assert.equal(classify('#/gym', '#/gym/workout'), 'up')
    assert.equal(classify('#/tasks', '#/gym/workout'), 'up')
    assert.equal(classify('#/gym/routines', '#/gym/routine/new'), 'up')
    assert.equal(classify('#/gym/workout', '#/gym'), 'down')
    assert.equal(classify('#/gym/routine/r1', '#/gym/routines', 'back'), 'down')
    // A saved new routine swaps its own entry: no movement.
    assert.equal(classify('#/gym/routine/new', '#/gym/routine/r1', 'same'), 'none')
  })

  test('food: screens push, paging days and weeks stays still', () => {
    assert.equal(classify('#/food', '#/food/insights'), 'push')
    assert.equal(classify('#/food', '#/food/foods'), 'push')
    assert.equal(classify('#/food/insights', '#/food/day/2026-01-05'), 'push')
    assert.equal(classify('#/food/day/2026-01-05', '#/food/insights', 'back'), 'pop')
    assert.equal(classify('#/food/goals', '#/food', 'back'), 'pop')
    assert.equal(classify('#/food', '#/food/day/2026-01-04'), 'none')
    assert.equal(classify('#/food/day/2026-01-04', '#/food/day/2026-01-03'), 'none')
    assert.equal(classify('#/food/insights', '#/food/insights/2026-01-01'), 'none')
  })

  test('the query part is ignored', () => {
    assert.deepEqual(parseNavHash('#/gym/exercise/12?from=x'), { page: 'gym', view: 'exercise', param: '12' })
    assert.equal(navLevel(parseNavHash('#/gym/unknown')), 0)
    assert.equal(navLevel(parseNavHash('#/tasks')), 0)
  })
})

describe('freshClass', () => {
  const now = Date.parse('2026-01-10T12:00:00Z')

  test('a record added a moment ago is new', () => {
    assert.equal(freshClass({ createdAt: '2026-01-10T11:59:59.500Z' }, 1500, now), 'is-new')
  })

  test('an older record, or one without a date, is not', () => {
    assert.equal(freshClass({ createdAt: '2026-01-10T11:59:58Z' }, 1500, now), '')
    assert.equal(freshClass({}, 1500, now), '')
    assert.equal(freshClass(null, 1500, now), '')
    assert.equal(freshClass({ createdAt: 'nonsense' }, 1500, now), '')
  })

  test('a clock a little ahead still counts; far in the future does not', () => {
    assert.equal(freshClass({ createdAt: '2026-01-10T12:00:01Z' }, 1500, now), 'is-new')
    assert.equal(freshClass({ createdAt: '2026-01-10T13:00:00Z' }, 1500, now), '')
  })
})

describe('session state', () => {
  test('kept until cleared (sign-out)', () => {
    writeSessionState('zz-test.query', 'abc')
    assert.equal(readSessionState('zz-test.query', ''), 'abc')
    clearSessionState()
    assert.equal(readSessionState('zz-test.query', ''), '')
  })
})

describe('lazyPage', () => {
  test('preload loads once and is shared by name', async () => {
    let loads = 0
    const Page = lazyPage(async () => {
      loads += 1
      return { default: () => null }
    }, 'zz-test-page')
    assert.equal(typeof Page.preload, 'function')
    await Promise.all([Page.preload(), preloadPage('zz-test-page'), Page.preload()])
    assert.equal(loads, 1)
    assert.equal(await preloadPage('zz-missing'), null)
  })

  test('a failed load can be tried again', async () => {
    let attempts = 0
    const Page = lazyPage(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return { default: () => null }
    })
    await assert.rejects(Page.preload())
    await Page.preload()
    assert.equal(attempts, 2)
  })
})

describe('voice chat guards', () => {
  test('the navigation guard holds a move while a call is live', () => {
    const queued = []
    setNavigationGuard((route) => {
      queued.push(route)
      return false
    })
    try {
      // With the guard holding, navigate() returns before it touches window.location (none in node).
      assert.doesNotThrow(() => navigate('tasks'))
      assert.doesNotThrow(() => navigate('gym/stats', { transition: 'fade' }))
      assert.deepEqual(queued, ['tasks', 'gym/stats'])
    } finally {
      setNavigationGuard(null)
    }
  })

  test('a quiet update never lands during a voice chat', () => {
    const safe = { inWindow: true, waiting: true, unsaved: false, sheetOpen: false, typing: false, workoutActive: false }
    assert.equal(canUpdateQuietly(safe), true)
    assert.equal(canUpdateQuietly({ ...safe, inCall: true }), false)
  })
})

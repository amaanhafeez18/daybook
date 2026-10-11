import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

// lib/appBadge.js in a fake browser: what Settings says this device needs for the icon count, and
// that setting or clearing the badge never throws.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

function fakeBrowser({ ua = IPHONE, standalone = false, badgeApi = true, permission = 'granted', throws = false } = {}) {
  const calls = []
  const navigator = { userAgent: ua, platform: ua === IPHONE ? 'iPhone' : 'Win32', maxTouchPoints: ua === IPHONE ? 5 : 0, standalone }
  if (badgeApi) {
    navigator.setAppBadge = async (n) => { calls.push(['set', n]); if (throws) throw new Error('denied') }
    navigator.clearAppBadge = async () => { calls.push(['clear']); if (throws) throw new Error('denied') }
  }
  const window = { navigator, matchMedia: () => ({ matches: standalone }) }
  if (permission) window.Notification = { permission }
  globalThis.window = window
  globalThis.navigator = navigator
  return calls
}

afterEach(() => {
  delete globalThis.window
  delete globalThis.navigator
})

const { badgeSupport, setIconCount, clearIconCount } = await import('../src/lib/appBadge.js')

describe('badgeSupport', () => {
  test('an iPhone Safari tab is told to install, even without the badge API', () => {
    fakeBrowser({ badgeApi: false })
    assert.equal(badgeSupport(), 'install')
    fakeBrowser({ badgeApi: true })
    assert.equal(badgeSupport(), 'install')
  })

  test('the Home Screen app needs notification permission', () => {
    fakeBrowser({ standalone: true, permission: 'default' })
    assert.equal(badgeSupport(), 'permission')
    fakeBrowser({ standalone: true, permission: 'denied' })
    assert.equal(badgeSupport(), 'permission')
    fakeBrowser({ standalone: true, permission: 'granted' })
    assert.equal(badgeSupport(), 'ok')
  })

  test('a browser without the badge API is unsupported', () => {
    fakeBrowser({ ua: DESKTOP, badgeApi: false })
    assert.equal(badgeSupport(), 'unsupported')
  })

  test('a desktop browser tab with the API needs the installed app', () => {
    fakeBrowser({ ua: DESKTOP })
    assert.equal(badgeSupport(), 'install')
    fakeBrowser({ ua: DESKTOP, standalone: true })
    assert.equal(badgeSupport(), 'ok')
  })
})

describe('setIconCount / clearIconCount', () => {
  test('sets a positive count, rounded and capped at 9999', async () => {
    const calls = fakeBrowser({ standalone: true })
    assert.equal(await setIconCount(3), true)
    assert.equal(await setIconCount(2.6), true)
    assert.equal(await setIconCount(123456), true)
    assert.deepEqual(calls, [['set', 3], ['set', 3], ['set', 9999]])
  })

  test('0 (or junk) clears instead of showing a "0"', async () => {
    const calls = fakeBrowser({ standalone: true })
    await setIconCount(0)
    await setIconCount(-4)
    await setIconCount('x')
    assert.deepEqual(calls, [['clear'], ['clear'], ['clear']])
  })

  test('errors are swallowed and reported as false', async () => {
    fakeBrowser({ standalone: true, throws: true })
    assert.equal(await setIconCount(2), false)
    assert.equal(await clearIconCount(), false)
  })

  test('no badge API: false, nothing called', async () => {
    fakeBrowser({ badgeApi: false })
    assert.equal(await setIconCount(2), false)
    assert.equal(await clearIconCount(), false)
  })

  test('clearIconCount clears', async () => {
    const calls = fakeBrowser({ standalone: true })
    assert.equal(await clearIconCount(), true)
    assert.deepEqual(calls, [['clear']])
  })
})

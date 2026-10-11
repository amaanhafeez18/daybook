import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// iPhone launch images (scripts/make_launch.py): the tags in index.html, the PNGs they point at, and
// the boot shell's capsule numbers the images were drawn from.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const html = read('index.html')

const tags = [...html.matchAll(/<link\s+rel="apple-touch-startup-image"[^>]*>/g)].map(([tag]) => ({
  tag,
  href: /href="([^"]+)"/.exec(tag)?.[1],
  media: /media="([^"]+)"/.exec(tag)?.[1] || '',
}))

function pngHeader(path) {
  const buf = readFileSync(path)
  assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${path} is a PNG`)
  assert.equal(buf.toString('latin1', 12, 16), 'IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] }
}

function device(media) {
  const w = /\(device-width:\s*(\d+)px\)/.exec(media)
  const h = /\(device-height:\s*(\d+)px\)/.exec(media)
  const scheme = /\(prefers-color-scheme:\s*(light|dark)\)/.exec(media)
  return { w: w && Number(w[1]), h: h && Number(h[1]), scheme: scheme && scheme[1] }
}

describe('launch images', () => {
  test('exactly 16 startup-image tags, each pointing at a file in public/', () => {
    assert.equal(tags.length, 16)
    for (const { href, tag } of tags) {
      assert.ok(href && href.startsWith('/launch/'), `absolute /launch/ path: ${tag}`)
      assert.ok(!/crossorigin/i.test(tag), 'no crossorigin')
      assert.ok(statSync(join(root, 'public', href)).isFile(), `${href} exists`)
    }
  })

  test('each PNG is the device size x3, RGB without alpha, under 200 KB', () => {
    for (const { href, media } of tags) {
      const path = join(root, 'public', href)
      const { w, h } = device(media)
      const png = pngHeader(path)
      assert.equal(png.width, w * 3, `${href} width`)
      assert.equal(png.height, h * 3, `${href} height`)
      assert.equal(png.colourType, 2, `${href} is RGB (colour type 2)`)
      assert.ok(statSync(path).size < 200 * 1024, `${href} under 200 KB`)
    }
  })

  test('every media is portrait at dpr 3, with one light and one dark per device', () => {
    const seen = new Map()
    for (const { media } of tags) {
      assert.match(media, /^screen and /)
      assert.match(media, /\(orientation: portrait\)/)
      assert.match(media, /\(-webkit-device-pixel-ratio: 3\)/)
      const { w, h, scheme } = device(media)
      assert.ok(w && h && scheme, `device size and scheme in: ${media}`)
      const key = `${w}x${h}`
      const list = seen.get(key) || []
      list.push(scheme)
      seen.set(key, list)
    }
    assert.equal(seen.size, 8)
    for (const [key, list] of seen) assert.deepEqual(list.sort(), ['dark', 'light'], key)
  })

  test('the boot shell still matches what the images were drawn from (make_launch.py)', () => {
    assert.ok(html.includes('width: min(460px, calc(100% - 24px)); height: 60px;'), '.boot-nav size')
    assert.ok(html.includes('bottom: calc(env(safe-area-inset-bottom, 0px) + 10px)'), '.boot-nav position')
    assert.ok(html.includes('--b-bg: #F2F2F7'), 'light background')
    assert.ok(html.includes('--b-bg: #000000'), 'dark background')
    assert.ok(html.includes('--b-glass: rgba(255, 255, 255, 0.82)'), 'light glass')
    assert.ok(html.includes('--b-glass: rgba(36, 36, 38, 0.82)'), 'dark glass')
    assert.ok(read('src/apple.css').includes('--nav-h: 60px'), 'the real tab bar is 60px too')
  })

  test('the launch images stay out of the service worker precache', () => {
    const config = read('vite.config.js')
    const ignores = /globIgnores:\s*\[([^\]]*)\]/.exec(config)
    assert.ok(ignores, 'workbox.globIgnores is set')
    assert.ok(ignores[1].includes("'launch/**'"))
    assert.ok(ignores[1].includes("'**/node_modules/**/*'"), 'keeps the workbox default')
  })
})

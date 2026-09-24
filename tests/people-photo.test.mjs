import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_PHOTO_MAX_BYTES, AVATAR_PHOTO_SIZE, dataUrlBytes, imageToAvatarDataUrl, isInlinePhoto, squareCrop } from '../src/lib/media.js'

describe('People photos', () => {
  test('squareCrop takes the largest square, centred across', () => {
    assert.deepEqual(squareCrop(4032, 3024), { x: 504, y: 0, size: 3024 })
    assert.deepEqual(squareCrop(500, 500), { x: 0, y: 0, size: 500 })
  })

  test('squareCrop keeps the upper part of a portrait photo (where faces are)', () => {
    const crop = squareCrop(3024, 4032)
    assert.equal(crop.size, 3024)
    assert.equal(crop.x, 0)
    assert.equal(crop.y, 336) // a third of the spare 1008 px, not half
    assert.ok(crop.y + crop.size <= 4032)
  })

  test('squareCrop copes with odd and empty sizes', () => {
    assert.deepEqual(squareCrop(0, 0), { x: 0, y: 0, size: 0 })
    assert.deepEqual(squareCrop(undefined, 'x'), { x: 0, y: 0, size: 0 })
    const odd = squareCrop(101, 60)
    assert.equal(odd.size, 60)
    assert.ok(odd.x >= 0 && odd.x + odd.size <= 101)
  })

  test('isInlinePhoto tells a saved photo from a web link', () => {
    assert.equal(isInlinePhoto('data:image/jpeg;base64,/9j/4AAQ'), true)
    assert.equal(isInlinePhoto('  data:image/png;base64,iVBOR'), true)
    assert.equal(isInlinePhoto('https://example.com/me.jpg'), false)
    assert.equal(isInlinePhoto(''), false)
    assert.equal(isInlinePhoto(null), false)
  })

  test('the size budget fits the avatar sizes the app shows', () => {
    assert.ok(AVATAR_PHOTO_SIZE >= 64 * 3 - 1) // a 64 px avatar on a 3x iPhone screen
    assert.ok(AVATAR_PHOTO_MAX_BYTES <= 15_000)
    // What the row stores: a 15 KB JPEG is about 20k characters of base64.
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(20_000)}`
    assert.equal(dataUrlBytes(dataUrl), 15_000)
  })

  test('imageToAvatarDataUrl refuses anything that is not a photo', async () => {
    await assert.rejects(imageToAvatarDataUrl(null), /Choose a photo/)
    await assert.rejects(imageToAvatarDataUrl(new Blob(['hello'], { type: 'text/plain' })), /Choose a photo/)
    await assert.rejects(imageToAvatarDataUrl(new Blob([], { type: 'image/jpeg' })), /empty/)
  })
})

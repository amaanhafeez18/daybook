import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isTyping, keyboardInset, revealOffset } from '../src/lib/keyboard.js'
import { addToast, toastDuration, toastText } from '../src/lib/toastQueue.js'
import { saveStatus } from '../src/lib/store.js'

describe('keyboardInset', () => {
  test('the part of the layout viewport the keyboard covers', () => {
    assert.equal(keyboardInset({ layoutHeight: 812, height: 476 }), 336)
  })

  test('iOS panning the visual viewport to show the field is not more keyboard', () => {
    assert.equal(keyboardInset({ layoutHeight: 812, height: 476, offsetTop: 120 }), 216)
  })

  test('no keyboard, or a small toolbar change, is 0', () => {
    assert.equal(keyboardInset({ layoutHeight: 812, height: 812 }), 0)
    assert.equal(keyboardInset({ layoutHeight: 812, height: 760 }), 0)
  })

  test('pinch zoom shrinks the viewport but is not a keyboard', () => {
    assert.equal(keyboardInset({ layoutHeight: 812, height: 406, scale: 2 }), 0)
  })

  test('missing numbers are 0, never NaN', () => {
    assert.equal(keyboardInset({ layoutHeight: 0, height: 400 }), 0)
    assert.equal(keyboardInset({ layoutHeight: 812, height: undefined }), 0)
  })
})

describe('revealOffset', () => {
  const box = { top: 100, bottom: 400 }

  test('a field already in view needs no scroll', () => {
    assert.equal(revealOffset({ top: 200, bottom: 240 }, box), 0)
  })

  test('a field below the visible part scrolls down to show it with a margin', () => {
    assert.equal(revealOffset({ top: 420, bottom: 460 }, box), 76)
  })

  test('a field above scrolls up', () => {
    assert.equal(revealOffset({ top: 60, bottom: 100 }, box), -56)
  })

  test('a field taller than the room shows its top', () => {
    assert.equal(revealOffset({ top: 300, bottom: 700 }, box), 184)
    assert.equal(revealOffset({ top: 116, bottom: 900 }, box), 0)
  })
})

describe('isTyping', () => {
  test('text fields, text areas, pickers and editable content bring up a keyboard', () => {
    assert.equal(isTyping({ tagName: 'INPUT', type: 'text' }), true)
    assert.equal(isTyping({ tagName: 'INPUT', type: 'number' }), true)
    assert.equal(isTyping({ tagName: 'INPUT' }), true)
    assert.equal(isTyping({ tagName: 'TEXTAREA' }), true)
    assert.equal(isTyping({ tagName: 'SELECT' }), true)
    assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true)
  })

  test('buttons, checkboxes and nothing focused do not', () => {
    assert.equal(isTyping({ tagName: 'BUTTON' }), false)
    assert.equal(isTyping({ tagName: 'INPUT', type: 'checkbox' }), false)
    assert.equal(isTyping({ tagName: 'INPUT', type: 'range' }), false)
    assert.equal(isTyping(null), false)
  })
})

describe('toasts', () => {
  const make = (id, message, extra = {}) => ({ id, stamp: id, message, tone: 'default', duration: 4500, ...extra })

  test('durations: errors 8s, with a button 7s, otherwise 4.5s', () => {
    assert.equal(toastDuration({ tone: 'error' }), 8000)
    assert.equal(toastDuration({ tone: 'error', action: { label: 'Retry' } }), 8000)
    assert.equal(toastDuration({ action: { label: 'Undo' } }), 7000)
    assert.equal(toastDuration({}), 4500)
    assert.equal(toastDuration(), 4500)
  })

  test('a repeat counts up, keeps its place in the list (id) and takes the newest action', () => {
    const undoFirst = () => 1
    const undoSecond = () => 2
    let list = addToast([], make(1, 'Completed', { action: { label: 'Undo', onClick: undoFirst } }))
    list = addToast(list, make(2, 'Saved'))
    list = addToast(list, make(3, 'Completed', { action: { label: 'Undo', onClick: undoSecond } }))
    assert.deepEqual(list.map((item) => [item.id, item.message, item.count]), [[2, 'Saved', 1], [1, 'Completed', 2]])
    assert.equal(list[1].stamp, 3) // a new stamp restarts its timer
    assert.equal(list[1].action.onClick, undoSecond)
    assert.equal(toastText(list[1]), 'Completed (2)')
    assert.equal(toastText(list[0]), 'Saved')
  })

  test('the same message with another tone is a different toast', () => {
    const list = addToast(addToast([], make(1, 'Done')), make(2, 'Done', { tone: 'error' }))
    assert.equal(list.length, 2)
  })

  test('a keyed toast replaces the one with its key without counting', () => {
    let list = addToast([], make(1, 'Some changes aren’t saved: A', { key: 'save-error' }))
    list = addToast(list, make(2, 'Some changes aren’t saved: B', { key: 'save-error' }))
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 1)
    assert.equal(list[0].count, 1)
    assert.equal(list[0].message, 'Some changes aren’t saved: B')
  })

  test('over the limit the oldest short toast goes, not a long one like "update ready"', () => {
    let list = addToast([], make(1, 'A new version is ready', { duration: 60000 }))
    list = addToast(list, make(2, 'One'), 2)
    list = addToast(list, make(3, 'Two'), 2)
    assert.deepEqual(list.map((item) => item.id), [1, 3])
    list = addToast(list, make(4, 'Three'), 3)
    list = addToast(list, make(5, 'Four'), 3)
    assert.deepEqual(list.map((item) => item.id), [1, 4, 5])
  })

  test('with only long toasts left, the oldest of them goes', () => {
    let list = addToast([], make(1, 'Long one', { duration: 60000 }))
    list = addToast(list, make(2, 'Long two', { duration: 60000 }), 1)
    assert.deepEqual(list.map((item) => item.id), [2])
  })
})

describe('saveStatus', () => {
  test('offline wins, then a save that is taking a while, then a rejected save', () => {
    assert.equal(saveStatus({ offline: true, saveError: 'Nope', pendingSaves: 1 }, true), 'offline')
    assert.equal(saveStatus({ offline: false, saveError: '', pendingSaves: 1 }, true), 'saving')
    assert.equal(saveStatus({ offline: false, saveError: 'Nope', pendingSaves: 0 }, true), 'error')
  })

  test('a retry of a rejected save shows it is running once it takes a while', () => {
    assert.equal(saveStatus({ offline: false, saveError: 'Nope', pendingSaves: 1 }, true), 'saving')
    assert.equal(saveStatus({ offline: false, saveError: 'Nope', pendingSaves: 1 }, false), 'error')
  })

  test('a quick save, or nothing to save, shows nothing', () => {
    assert.equal(saveStatus({ offline: false, saveError: '', pendingSaves: 1 }, false), 'saved')
    assert.equal(saveStatus({ offline: false, saveError: '', pendingSaves: 0 }, true), 'saved')
  })
})

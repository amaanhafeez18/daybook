import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { personInText } from '../src/lib/peopleMatch.js'

const sam = { id: 'f1', name: 'Sam Lee' }
const ali = { id: 'f2', name: 'Ali' }
const mom = { id: 'f3', name: 'Mom' }
const will = { id: 'f4', name: 'Will Park' }
const may = { id: 'f5', name: 'May Chen' }
const jo = { id: 'f6', name: 'Jo' }
const friends = [sam, ali, mom, will, may, jo]
const who = (text, list = friends) => personInText(text, list)?.friend.id ?? null

describe('personInText', () => {
  test('first names and full names, any case, whole words', () => {
    assert.equal(who('Coffee with Sam'), 'f1')
    assert.equal(who('coffee with sam lee'), 'f1')
    assert.equal(who('Call mom'), 'f3')
    assert.equal(who('Lunch w/ Ali!'), 'f2')
    assert.equal(who("Sam's birthday gift"), 'f1')
    assert.deepEqual(personInText('Coffee with Sam', friends), { friend: sam, name: 'Sam' })
  })

  test('no partial words', () => {
    assert.equal(who('Fix the alignment'), null)
    assert.equal(who('Samples for the lab'), null)
    assert.equal(who('Momentum workout'), null)
  })

  test('short first names (under 3 letters) are not matched on their own', () => {
    assert.equal(who('Jo to finish the report'), null)
  })

  test('two people named: no match', () => {
    assert.equal(who('Dinner with Sam and Ali'), null)
  })

  test('two friends with the same first name: only the full name picks one', () => {
    const list = [sam, { id: 'f9', name: 'Sam Park' }]
    assert.equal(who('Coffee with Sam', list), null)
    assert.equal(who('Coffee with Sam Park', list), 'f9')
    assert.equal(who('Coffee with Sam Lee', list), 'f1')
  })

  test('everyday-word names only when capitalised mid-sentence', () => {
    assert.equal(who('Will call the bank back'), null) // sentence start
    assert.equal(who('I will call the bank'), null) // lower case
    assert.equal(who('Dinner with Will'), 'f4')
    assert.equal(who('Mark the calendar', [{ id: 'm', name: 'Mark' }]), null)
    assert.equal(who('Drinks with Mark', [{ id: 'm', name: 'Mark' }]), 'm')
    assert.equal(who('Call Will Park'), 'f4') // a full name is never guarded
  })

  test('month names are not people when they are dates', () => {
    assert.equal(who('Renew passport in May'), null)
    assert.equal(who('Pay rent by May 3'), null)
    assert.equal(who('Rent due May 1'), null)
    assert.equal(who('Coffee with May'), 'f5')
  })

  test('the app\'s own "Talk to" reminders are skipped; other tasks work', () => {
    assert.equal(personInText({ text: 'Talk to Sam Lee', details: 'friend-reminder:f1:2026-10-11' }, friends), null)
    assert.equal(personInText({ text: 'Talk to Sam Lee', details: '' }, friends)?.friend.id, 'f1')
  })

  test('accents and odd input', () => {
    assert.equal(who('Café with José', [{ id: 'j', name: 'José' }]), 'j')
    assert.equal(who('Cafe with Jose', [{ id: 'j', name: 'José' }]), 'j')
    assert.equal(who('', friends), null)
    assert.equal(who('Coffee with Sam', []), null)
    assert.equal(who('Coffee with Sam', null), null)
    assert.equal(personInText(null, friends), null)
    assert.equal(who('Coffee with Sam', [{ id: 'x' }, sam]), 'f1')
  })
})

describe('everyday words, contractions and Title Case are not people', () => {
  const one = (name) => [{ id: 'x', name }]
  test('false positives stay quiet', () => {
    assert.equal(who("Don't forget to call the bank", one('Don')), null)
    assert.equal(who('Don’t forget the keys', one('Don')), null)
    assert.equal(who('Christmas Eve dinner prep', one('Eve')), null)
    assert.equal(who('Buy cat food', one('Cat')), null)
    assert.equal(who('Buy first aid kit', one('Kit')), null)
    assert.equal(who('Renew passport before Jan 15', one('Jan')), null)
    assert.equal(who('Sue the landlord', one('Sue')), null)
    assert.equal(who('Pay Electricity Bill', one('Bill')), null)
  })

  test('the same names used as names still match', () => {
    assert.equal(who('Lunch with Don', one('Don')), 'x')
    assert.equal(who("Drinks for Don's birthday", one('Don')), 'x')
    assert.equal(who('Coffee with Eve', one('Eve')), 'x')
    assert.equal(who("New Year's Eve party", one('Eve')), null)
    assert.equal(who('Call Bill about the trip', one('Bill')), 'x')
    assert.equal(who('Dinner with Jan', one('Jan')), 'x')
    assert.equal(who('Dinner with Will', friends), 'f4')
  })
})

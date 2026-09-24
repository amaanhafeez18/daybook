import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { accountIsEmpty, welcomeDecision } from '../src/components/welcome/rules.js'

const empty = () => ({ tasks: [], events: [], friends: [], contactLogs: [], classes: [], journalEntries: [], voiceNotes: [], gymSessions: [], bodyWeights: [], foodEntries: [], settings: {} })
const loaded = (data, extra = {}) => ({ data, hydrated: true, lastSyncedAt: 1, ...extra })

describe('welcome tour: when it shows', () => {
  test('a brand-new account sees it once the server has answered', () => {
    assert.equal(welcomeDecision(loaded(empty())), 'show')
    assert.equal(welcomeDecision(loaded({ ...empty(), settings: { timeZone: 'Asia/Karachi' } })), 'show')
  })

  test('nothing is decided before real data is in', () => {
    assert.equal(welcomeDecision({ data: empty(), hydrated: false, lastSyncedAt: null }), 'wait')
    assert.equal(welcomeDecision(), 'wait')
    // An empty-looking device cache isn't enough to greet someone: wait for the server.
    assert.equal(welcomeDecision(loaded(empty(), { lastSyncedAt: null })), 'wait')
  })

  test('finished or skipped: never again (until reopened by hand)', () => {
    assert.equal(welcomeDecision(loaded({ ...empty(), settings: { welcomeDone: true } })), 'done')
    assert.equal(welcomeDecision(loaded({ ...empty(), settings: { welcomeDone: true } }, { lastSyncedAt: null })), 'done')
  })

  test('an existing account with data is marked done quietly, even from the cache', () => {
    for (const key of ['tasks', 'events', 'friends', 'classes', 'journalEntries', 'gymSessions', 'foodEntries']) {
      const data = { ...empty(), [key]: [{ id: 'x' }] }
      assert.equal(welcomeDecision(loaded(data)), 'mark-done', key)
      assert.equal(welcomeDecision(loaded(data, { lastSyncedAt: null })), 'mark-done', key)
    }
    assert.equal(welcomeDecision(loaded({ ...empty(), tasks: [{ id: 'x' }], settings: { welcomeDone: true } })), 'done')
  })

  test('settings someone chose count as use; the ones the app writes itself do not', () => {
    for (const settings of [{ displayName: 'Sam' }, { theme: 'lagoon' }, { gym: { routines: [] } }, { food: { goals: {} } }, { notifications: { dailySummary: false } }]) {
      assert.equal(welcomeDecision(loaded({ ...empty(), settings })), 'mark-done', JSON.stringify(settings))
    }
    assert.equal(welcomeDecision(loaded({ ...empty(), settings: { timeZone: 'Europe/London', displayName: '' } })), 'show')
  })

  test('accountIsEmpty tolerates missing lists', () => {
    assert.equal(accountIsEmpty({}), true)
    assert.equal(accountIsEmpty(undefined), true)
    assert.equal(accountIsEmpty({ tasks: [] , friends: [{ id: 1 }] }), false)
  })
})

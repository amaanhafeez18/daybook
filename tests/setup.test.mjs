import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { accountAgeDays, addMinutesHHMM, classLength, commonEndDate, notifyHintState, setupSteps, setupVisible, todayHint } from '../src/lib/setup.js'
import { cityResults, geocodeUrl, savedCoords, shouldSaveLocation, updatedLabel } from '../src/lib/location.js'
import { calorieGoalText, gymPlanSummary, savedFoodsText } from '../src/lib/hub.js'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()
const ALL_ON = { people: true, journal: true, gym: true, food: true }

describe('get set up: who sees it', () => {
  test('an account with nothing in it yet is new', () => {
    assert.equal(accountAgeDays({ tasks: [], settings: {} }, NOW), 0)
    assert.equal(accountAgeDays(undefined, NOW), 0)
    assert.equal(setupVisible({ settings: {} }, NOW), true)
  })

  test('the oldest row says how old the account is', () => {
    const data = { tasks: [{ createdAt: daysAgo(3) }, { createdAt: daysAgo(1) }], friends: [{ createdAt: daysAgo(9) }], settings: {} }
    assert.equal(accountAgeDays(data, NOW), 9)
    assert.equal(setupVisible(data, NOW), true)
    assert.equal(setupVisible({ ...data, classes: [{ createdAt: daysAgo(20) }] }, NOW), false)
  })

  test('rows without createdAt mean an established account: no card', () => {
    assert.equal(accountAgeDays({ tasks: [{ text: 'old' }] }, NOW), null)
    assert.equal(setupVisible({ tasks: [{ text: 'old' }], settings: {} }, NOW), false)
  })

  test('hidden stays hidden', () => {
    assert.equal(setupVisible({ settings: { setupHidden: true } }, NOW), false)
  })
})

describe('get set up: the rows', () => {
  test('one row per area that is on, ticked from the data', () => {
    const steps = setupSteps({ settings: {}, classes: [], friends: [], areas: ALL_ON, push: 'default', subscribed: false })
    assert.deepEqual(steps.map((step) => step.id), ['classes', 'gym', 'food', 'people', 'location', 'reminders'])
    assert.ok(steps.every((step) => !step.done))

    const done = setupSteps({
      settings: { gym: { routines: [{ id: 'r1' }] }, food: { goals: { calories: 2100 } }, location: { lat: 31.5, lon: 74.3 } },
      classes: [{ id: 'c' }], friends: [{ id: 'f' }], areas: ALL_ON, push: 'granted', subscribed: true,
    })
    assert.ok(done.every((step) => step.done))
  })

  test('areas that are off and reminders that cannot work here are left out', () => {
    const steps = setupSteps({ areas: { people: false, journal: true, gym: false, food: true }, push: 'unsupported' })
    assert.deepEqual(steps.map((step) => step.id), ['classes', 'food', 'location'])
    assert.deepEqual(setupSteps({ areas: ALL_ON, push: 'dev' }).map((step) => step.id).includes('reminders'), false)
    assert.equal(setupSteps({ areas: ALL_ON, push: 'install' }).at(-1).id, 'reminders')
  })

  test('a device position counts as a location', () => {
    const location = (args) => setupSteps({ areas: ALL_ON, ...args }).find((step) => step.id === 'location')
    assert.equal(location({ hasCoords: true }).done, true)
    assert.equal(location({ settings: { location: { lat: 'x' } } }).done, false)
  })
})

describe('today: only one hint card', () => {
  const open = [{ id: 'classes', done: false }]
  const finished = [{ id: 'classes', done: true }]

  test('the setup card wins while something is left', () => {
    assert.equal(todayHint({ setup: true, steps: open, push: 'default', standalone: true }), 'setup')
    assert.equal(todayHint({ setup: true, steps: finished, push: 'default', standalone: true }), 'reminders')
  })

  test('reminders in the Home Screen app, install in iPhone Safari, each until dismissed', () => {
    assert.equal(todayHint({ push: 'default', standalone: true }), 'reminders')
    assert.equal(todayHint({ push: 'default', standalone: false }), null)
    assert.equal(todayHint({ push: 'default', standalone: true, dismissed: { reminders: true } }), null)
    assert.equal(todayHint({ push: 'granted', subscribed: true, standalone: true }), null)
    assert.equal(todayHint({ push: 'install' }), 'install')
    assert.equal(todayHint({ push: 'install', dismissed: { install: true } }), null)
  })
})

describe('notifications off here', () => {
  test('what the row under a reminder switch says', () => {
    assert.equal(notifyHintState('granted', true), null)
    assert.equal(notifyHintState('granted', null), null) // still checking
    assert.equal(notifyHintState('granted', false), 'off')
    assert.equal(notifyHintState('default', false), 'off')
    assert.equal(notifyHintState('install', false), 'install')
    assert.equal(notifyHintState('denied', false), 'blocked')
    assert.equal(notifyHintState('unsupported', false), null)
    assert.equal(notifyHintState('dev', false), null)
  })
})

describe('location', () => {
  test('the saved location, read like the server reads it', () => {
    assert.deepEqual(savedCoords({ location: { lat: '31.52', lon: 74.35 } }), { lat: 31.52, lon: 74.35 })
    assert.deepEqual(savedCoords({ location: { lat: 1, lon: 2, name: ' Lahore ', manual: true, at: 5 } }), { lat: 1, lon: 2, name: 'Lahore', manual: true, at: 5 })
    assert.equal(savedCoords({ location: { lat: 91, lon: 0 } }), null)
    assert.equal(savedCoords({ location: null }), null)
    assert.equal(savedCoords({}), null)
  })

  test('GPS refreshes never overwrite a chosen city; a tap on Use my location does', () => {
    const manual = { lat: 31.5, lon: 74.3, manual: true }
    const far = { lat: 40.7, lon: -74 }
    assert.equal(shouldSaveLocation(manual, far), false)
    assert.equal(shouldSaveLocation(manual, far, { force: true }), true)
    assert.equal(shouldSaveLocation(null, far), true)
    assert.equal(shouldSaveLocation({ lat: 40.7, lon: -74 }, { lat: 40.701, lon: -74.002 }), false)
    assert.equal(shouldSaveLocation({ lat: 40.7, lon: -74 }, { lat: 40.8, lon: -74 }), true)
    assert.equal(shouldSaveLocation(null, { lat: NaN, lon: 1 }), false)
  })

  test('how long ago it was updated', () => {
    assert.equal(updatedLabel(NOW - 5 * 60000, NOW), 'Updated just now')
    assert.equal(updatedLabel(NOW - 5 * 3600000, NOW), 'Updated today')
    assert.equal(updatedLabel(NOW - 30 * 3600000, NOW), 'Updated yesterday')
    assert.equal(updatedLabel(NOW - 2 * 86400000, NOW), 'Updated 2 days ago')
    assert.equal(updatedLabel(undefined, NOW), '')
  })

  test('city search: the request and the results', () => {
    assert.equal(geocodeUrl('a'), '')
    assert.equal(geocodeUrl(' São Paulo '), 'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo&count=5&language=en&format=json')
    const results = cityResults({
      results: [
        { id: 1, name: 'Lahore', latitude: 31.558, longitude: 74.35071, admin1: 'Punjab', country: 'Pakistan' },
        { id: 2, name: 'Singapore', latitude: 1.28967, longitude: 103.85007, admin1: 'Singapore', country: 'Singapore' },
        { id: 3, name: 'Nowhere', latitude: 'x', longitude: 0 },
      ],
    })
    assert.deepEqual(results, [
      { id: '1', name: 'Lahore', label: 'Lahore, Punjab, Pakistan', lat: 31.558, lon: 74.351 },
      { id: '2', name: 'Singapore', label: 'Singapore', lat: 1.29, lon: 103.85 },
    ])
    assert.deepEqual(cityResults({}), [])
    assert.deepEqual(cityResults(null), [])
  })
})

describe('faster timetable', () => {
  test('a new class ends on the date most classes share', () => {
    assert.equal(commonEndDate(['2026-12-12', '2026-12-12', '2026-12-19', '', null], '2026-10-06'), '2026-12-12')
    assert.equal(commonEndDate(['2026-12-12', '2026-12-19'], '2026-10-06'), '2026-12-19') // a tie: the later one
    assert.equal(commonEndDate(['2026-05-01', '2026-05-01'], '2026-10-06'), '') // all in the past
    assert.equal(commonEndDate([], '2026-10-06'), '')
  })

  test('the end time follows from the last class’s length, else 50 minutes', () => {
    assert.equal(classLength(['', '9:00 AM', '2:30 PM - 3:45 PM', '8:00 AM - 8:50 AM']), 75)
    assert.equal(classLength(['nonsense']), 50)
    assert.equal(classLength([]), 50)
    assert.equal(addMinutesHHMM('09:00', 50), '09:50')
    assert.equal(addMinutesHHMM('13:40', 75), '14:55')
    assert.equal(addMinutesHHMM('23:30', 50), '23:59')
    assert.equal(addMinutesHHMM('', 50), '')
  })
})

describe('settings hub', () => {
  const routines = [{ id: 'p', name: 'Push' }, { id: 'l', name: 'Pull' }, { id: 'g', name: 'Legs' }, { id: 'u', name: 'Upper' }]
  const slot = (id) => (id ? { kind: 'routine', routineId: id } : { kind: 'rest' })

  test('the gym plan in a few words, in schedule order', () => {
    const gym = { routines, schedule: { versions: [{ id: 'v1', effectiveFrom: '2026-09-01', mode: 'rotation', cycle: [slot('g'), slot('p'), slot(null), slot('l')], anchorIndex: 0 }] } }
    assert.equal(gymPlanSummary(gym, '2026-10-06'), 'Legs, Push, Pull')
    const weekly = { routines, schedule: { versions: [{ id: 'v1', effectiveFrom: '2026-09-01', mode: 'weekly', weekly: [slot('p'), slot('l'), slot('g'), slot('u'), slot('p'), slot(null), slot(null)] }] } }
    assert.equal(gymPlanSummary(weekly, '2026-10-06'), 'Push, Pull, Legs +1')
  })

  test('routines without a schedule, or nothing at all', () => {
    assert.equal(gymPlanSummary({ routines: routines.slice(0, 2) }, '2026-10-06'), 'Push, Pull')
    assert.equal(gymPlanSummary({}, '2026-10-06'), '')
    assert.equal(gymPlanSummary(undefined, '2026-10-06'), '')
  })

  test('food goal and saved foods', () => {
    assert.equal(calorieGoalText({ goals: { calories: 2100 } }), '2,100 kcal a day')
    assert.equal(calorieGoalText({ goals: { calories: 2000 }, prefs: { energyUnit: 'kJ' } }), '8,368 kJ a day')
    assert.equal(calorieGoalText({ goals: {} }), '')
    assert.equal(savedFoodsText({ favorites: [{}, {}] }), '2 saved')
    assert.equal(savedFoodsText({}), '')
  })
})

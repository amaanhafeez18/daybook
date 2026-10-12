import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deadlineKind, dismissRadar, hasPrep, radarWhen, readRadar, restoreRadar, studyPlan, studyTitle, upcomingDeadlines } from '../src/lib/radar.js'

const TODAY = '2026-10-11' // a Sunday
const classes = [
  { id: 'econ', name: 'ECON 101', days: ['Mon', 'Wed'], time: '5:00 PM - 6:15 PM' },
  { id: 'hist', name: 'Modern History', days: ['Tue'], time: '10:00 AM' },
  { id: 'old', name: 'BIOL 110', days: ['Fri'], time: '9:00 AM', endDate: '2026-05-01' },
]
let nextId = 0
const task = (text, date, extra = {}) => ({ id: extra.id || `t${(nextId += 1)}`, text, date, time: '', ...extra })
const titles = (list) => list.map((item) => item.title)

describe('deadlineKind', () => {
  test('exam words on their own', () => {
    assert.deepEqual(deadlineKind('Biology exam'), { exam: true })
    assert.deepEqual(deadlineKind('History essay'), { exam: false })
    assert.deepEqual(deadlineKind('Midterm'), { exam: true })
  })

  test('looser words only with a class', () => {
    assert.equal(deadlineKind('Quiz'), null)
    assert.equal(deadlineKind('Project due'), null)
    assert.deepEqual(deadlineKind('ECON 101 quiz', { hasClass: true }), { exam: true })
    assert.deepEqual(deadlineKind('Econ project due', { hasClass: true }), { exam: false })
  })

  test('everyday uses are not deadlines, even with a class named', () => {
    for (const text of ['Blood test', 'Test drive the new car', 'Eye exam', 'Pub quiz night', 'Quiz night with Sam', 'Rent due', 'Library books due back', 'Watch the NBA finals', 'Vote in the midterm elections', 'Final payment for the trip', 'Covid test before the flight']) {
      assert.equal(deadlineKind(text, { hasClass: true }), null, text)
    }
  })

  test('prep tasks are not deadlines', () => {
    assert.equal(deadlineKind('Study for ECON 101 midterm', { hasClass: true }), null)
    assert.equal(deadlineKind('Review notes for the exam'), null)
  })
})

describe('upcomingDeadlines', () => {
  const tasks = [
    task('ECON 101 midterm', '2026-10-15', { id: 'mid', time: '14:00' }),
    task('Econ problem set due', '2026-10-13', { id: 'ps' }),
    task('History essay', '2026-10-16', { id: 'essay' }),
    task('Blood test', '2026-10-12', { id: 'blood' }),
    task('Quiz night with Sam', '2026-10-14', { id: 'quiz' }),
    task('Biology exam', '2026-10-25', { id: 'far' }), // more than a week away
    task('ECON 101 quiz', TODAY, { id: 'today' }), // today is already on the list
    task('Old exam', '2026-10-12', { id: 'done', done: true }),
    task('Archived exam', '2026-10-12', { id: 'arch', archived: true }),
    task('Talk to Sam', '2026-10-12', { id: 'rem', details: 'friend-reminder:f1:2026-10-12' }),
    task('BIOL 110 quiz', '2026-10-14', { id: 'ended' }), // that class's term is over
  ]
  const events = [
    { id: 'ev-mid', taskId: 'mid', title: 'ECON 101 midterm', date: '2026-10-15', time: '14:00' },
    { id: 'ev-pres', title: 'Modern History presentation', date: '2026-10-14', time: '' },
  ]

  test('finds exams and deadlines in the next week, soonest first, with their class', () => {
    const found = upcomingDeadlines({ tasks, events, classes, today: TODAY })
    assert.deepEqual(titles(found), ['Econ problem set due', 'Modern History presentation', 'ECON 101 midterm', 'History essay'])
    assert.equal(found[0].className, 'ECON 101') // the code letters alone ("Econ")
    assert.equal(found[1].source, 'event')
    assert.equal(found[1].className, 'Modern History')
    assert.deepEqual({ key: found[2].key, exam: found[2].exam, classId: found[2].classId }, { key: 'task:mid', exam: true, classId: 'econ' })
    assert.equal(found[3].className, 'Modern History') // "History": a name word only one class has
  })

  test('dismissed ones stay away', () => {
    const found = upcomingDeadlines({ tasks, events, classes, today: TODAY, dismissed: [{ key: 'task:mid', at: TODAY }, 'event:ev-pres'] })
    assert.deepEqual(titles(found), ['Econ problem set due', 'History essay'])
  })

  test('without classes only the clear exam words count', () => {
    const found = upcomingDeadlines({ tasks, events: [], classes: [], today: TODAY })
    assert.deepEqual(titles(found), ['Econ problem set due', 'ECON 101 midterm', 'History essay'])
  })

  test('a class code shared by two classes does not match on its letters alone', () => {
    const two = [{ id: 'a', name: 'ECON 101', days: [] }, { id: 'b', name: 'ECON 202', days: [] }]
    const found = upcomingDeadlines({ tasks: [task('Econ quiz', '2026-10-13')], classes: two, today: TODAY })
    assert.deepEqual(found, [])
    const coded = upcomingDeadlines({ tasks: [task('econ202 quiz', '2026-10-13')], classes: two, today: TODAY })
    assert.equal(coded[0].classId, 'b')
  })
})

describe('hasPrep', () => {
  const item = { id: 'mid', title: 'ECON 101 midterm', date: '2026-10-15', classId: 'econ', exam: true }

  test('a task about the class before the date counts', () => {
    assert.equal(hasPrep(item, [task('Read ECON 101 chapter 5', '2026-10-13')], { today: TODAY, classes }), true)
    assert.equal(hasPrep(item, [task('Econ flashcards', '')], { today: TODAY, classes }), true) // undated
    assert.equal(hasPrep(item, [task('Econ flashcards', '2026-10-12', { done: true })], { today: TODAY, classes }), true)
  })

  test('the item itself, other classes, later or archived tasks do not', () => {
    const tasks = [
      task('ECON 101 midterm', '2026-10-15', { id: 'mid' }),
      task('Modern History reading', '2026-10-13'),
      task('Econ review', '2026-10-16'),
      task('Econ review', '2026-10-13', { archived: true }),
      task('Econ review', '2026-09-01'),
      task('Econ notes', '', { done: true }), // an old undated one, long done
    ]
    assert.equal(hasPrep(item, tasks, { today: TODAY, classes }), false)
  })

  test('without a class: the title\'s words, or a study task for a bare "Midterm"', () => {
    const bio = { id: 'b', title: 'Biology exam', date: '2026-10-15', exam: true }
    assert.equal(hasPrep(bio, [task('Biology flashcards', '2026-10-13')], { today: TODAY }), true)
    assert.equal(hasPrep(bio, [task('Buy groceries', '2026-10-13')], { today: TODAY }), false)
    const bare = { id: 'm', title: 'Midterm', date: '2026-10-15', exam: true }
    assert.equal(hasPrep(bare, [task('Study session', '2026-10-13')], { today: TODAY }), true)
    assert.equal(hasPrep(bare, [task('Laundry', '2026-10-13')], { today: TODAY }), false)
  })
})

describe('studyPlan', () => {
  const item = { id: 'mid', title: 'ECON 101 midterm', date: '2026-10-15', exam: true }

  test('the two freest evenings before the date, skipping class time', () => {
    // Sun (from 8:30 PM, it's 8 PM now) 90 min, Mon and Wed 6:30-10 PM after class, Tue 5-10 PM.
    const plan = studyPlan({ item, classes, today: TODAY, now: '20:00' })
    assert.deepEqual(plan, [
      { date: '2026-10-13', time: '17:00', text: 'Study for ECON 101 midterm' },
      { date: '2026-10-14', time: '18:30', text: 'Study for ECON 101 midterm' }, // a tie with Mon: nearer the exam
    ])
  })

  test('timed tasks and events take their time; a full evening is skipped', () => {
    const tasks = [task('Dinner', '2026-10-13', { time: '17:00' })]
    const events = [{ id: 'e', title: 'Concert', date: '2026-10-14', time: '17:00 - 22:00' }]
    const plan = studyPlan({ item, tasks, events, classes, today: TODAY, now: '21:30' })
    assert.deepEqual(plan.map((block) => `${block.date} ${block.time}`), ['2026-10-12 18:30', '2026-10-13 17:30'])
  })

  test('nothing for an item today or with no evenings left', () => {
    assert.deepEqual(studyPlan({ item: { ...item, date: TODAY }, today: TODAY }), [])
    assert.deepEqual(studyPlan({ item: { ...item, date: '2026-10-12' }, today: TODAY, now: '21:30' }), [])
    assert.equal(studyPlan({ item: { ...item, date: '2026-10-12' }, today: TODAY, now: '09:00' }).length, 1)
  })

  test('titles', () => {
    assert.equal(studyTitle({ title: 'History essay', exam: false }), 'Work on History essay')
    assert.equal(studyTitle({ title: 'ECON 101 midterm!', exam: true }), 'Study for ECON 101 midterm')
  })
})

describe('labels and settings.radar', () => {
  test('radarWhen', () => {
    assert.equal(radarWhen('2026-10-12', TODAY), 'Tomorrow')
    assert.equal(radarWhen('2026-10-15', TODAY), 'Thu, in 4 days')
    assert.equal(radarWhen('nope', TODAY), '')
  })

  test('dismiss, restore and the cap', () => {
    let radar = readRadar({})
    assert.deepEqual(radar, { dismissed: [] })
    radar = dismissRadar(radar, 'task:a', TODAY)
    radar = dismissRadar(radar, 'task:a', TODAY)
    assert.deepEqual(radar.dismissed, [{ key: 'task:a', at: TODAY }])
    radar = restoreRadar(radar, 'task:a')
    assert.deepEqual(radar.dismissed, [])
    for (let index = 0; index < 60; index += 1) radar = dismissRadar(radar, `task:${index}`, TODAY)
    assert.equal(radar.dismissed.length, 50)
    assert.equal(radar.dismissed[0].key, 'task:10')
    assert.deepEqual(readRadar({ radar: { dismissed: [null, { key: 5 }, { key: 'x' }] } }).dismissed, [{ key: 'x', at: '' }])
    assert.deepEqual(readRadar({ radar: 'junk' }), { dismissed: [] })
  })
})

describe('long course codes, series and look-alikes', () => {
  const uni = [
    { id: 'cs', name: 'COMPSCI 1026A', days: ['Mon'], time: '9:00 AM' },
    { id: 'ec', name: 'ECONOMIC 1021A', days: ['Tue'], time: '1:00 PM' },
  ]

  test('"CS1026 quiz" and "ECON1021 final" name their classes, so the looser words count', () => {
    const tasks = [task('CS1026 quiz', '2026-10-14'), task('ECON1021 final project due', '2026-10-15'), task('XYZ1026 quiz', '2026-10-15')]
    const found = upcomingDeadlines({ tasks, classes: uni, today: TODAY })
    assert.deepEqual(found.map((item) => [item.title, item.classId]), [['CS1026 quiz', 'cs'], ['ECON1021 final project due', 'ec']])
  })

  test('an earlier deadline of the series is not prep for the next one', () => {
    const quiz2 = { id: 'q2', title: 'ECON 101 quiz 2', date: '2026-10-15', exam: true }
    assert.equal(hasPrep(quiz2, [task('ECON 101 quiz 1', '2026-10-08', { done: true })], { today: TODAY, classes }), false)
    const midterm = { id: 'm', title: 'ECON 101 midterm', date: '2026-10-16', exam: true }
    assert.equal(hasPrep(midterm, [task('ECON 101 quiz 3', '2026-10-13')], { today: TODAY, classes }), false)
    const essay2 = { id: 'e2', title: 'History essay 2', date: '2026-10-16', exam: false }
    assert.equal(hasPrep(essay2, [task('History essay 1', '2026-10-09', { done: true })], { today: TODAY, classes: [] }), false)
    // Real prep still counts, also when it names the deadline ("ECON 101 quiz review").
    assert.equal(hasPrep(quiz2, [task('ECON 101 quiz review', '2026-10-13')], { today: TODAY, classes }), true)
    assert.equal(hasPrep(midterm, [task('Study for ECON 101 midterm', '2026-10-14')], { today: TODAY, classes }), true)
  })

  test('everyday "lab report", "homework", "assignment" and "thesis" items are not deadlines', () => {
    for (const text of ['Pick up lab report from clinic', 'Help kids with homework', 'Homework club pickup', 'Submit work assignment', 'Jury duty assignment', 'Assignment of lease signing', 'Thesis meeting with advisor', 'tmrw research for thesis chapter', 'Tomorrow: review essay feedback']) {
      assert.equal(deadlineKind(text), null, text)
    }
    assert.deepEqual(deadlineKind('Thesis draft due'), { exam: false })
    assert.deepEqual(deadlineKind('Lab report', { hasClass: true, how: 'code' }), { exam: false })
    assert.equal(deadlineKind('Lab report'), null)
  })

  test('a class named only by an everyday word of its name unlocks exam words, not "due" or "project"', () => {
    const cs = [{ id: 'x', name: 'Computer Science 201', days: ['Mon'], time: '9:00 AM' }]
    const tasks = [task('Computer repair due', '2026-10-14'), task('Science fair project', '2026-10-14'), task('Science quiz', '2026-10-15'), task('CS 201 project due', '2026-10-16')]
    assert.deepEqual(upcomingDeadlines({ tasks, classes: cs, today: TODAY }).map((item) => item.title), ['Science quiz', 'CS 201 project due'])
  })
})

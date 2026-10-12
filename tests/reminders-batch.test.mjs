// One notification for reminders due together (api/_reminders.js groupDue + combineReminders, sent
// by api/cron.js): the all-day reminders of a run and everything quiet hours held back go out as one
// push; a timed task keeps its own banner (shared only with other timed tasks due in that run); the
// morning summary, the evening check-in, prayer reminders and the workout reminder at its time stay
// on their own. The claim stays per item, so nothing is sent twice.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { combineReminders, dueNotifications, groupDue } from '../api/_reminders.js'

const TODAY = '2026-09-23' // a Wednesday
const TOMORROW = '2026-09-24'
const at = (iso) => Date.parse(iso)
const OFF = { dailySummary: false, overdue: false }

const task = (id, text, extra = {}) => ({ id, text, date: TODAY, time: '', created_at: '2026-09-20T10:00:00Z', ...extra })
const due = (tasks, nowIso, notifications = {}, extra = {}) => dueNotifications({ settings: { timeZone: 'UTC', notifications: { ...OFF, ...notifications }, ...(extra.settings || {}) }, tasks, friends: [], classes: [], gymSessions: [], ...extra.input }, at(nowIso))
const pushes = (list) => groupDue(list).map(combineReminders)

// What api/cron.js does with one run: claim each key once (notification_log's unique key), send each
// group's newly claimed items as one push.
function cronRun(list, log) {
  const sent = []
  for (const group of groupDue(list)) {
    const claimed = group.filter((item) => !log.has(item.key))
    claimed.forEach((item) => log.add(item.key))
    if (claimed.length) sent.push(combineReminders(claimed))
  }
  return sent
}

const gym = {
  schedule: { versions: [{ id: 'v1', effectiveFrom: '2026-09-01', mode: 'weekly', weekly: Array(7).fill({ kind: 'routine', routineId: 'r1' }) }], shifts: [], skips: {}, overrides: {}, deload: { everyWeeks: 0 } },
  routines: [{ id: 'r1', name: 'Push day', exercises: [{ id: 'x1', exerciseId: 'bench-press', sets: [{ reps: 8 }] }] }],
}

describe('all-day reminders due together', () => {
  test('four at 9:00 are one push that opens Today', () => {
    const tasks = [task('a', 'Buy milk'), task('b', 'Pay rent'), task('c', 'Call Ali'), task('d', 'Return books')]
    const list = due(tasks, `${TODAY}T09:00:00Z`)
    assert.equal(list.length, 4)
    const sent = pushes(list)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], { title: '4 tasks due today', body: 'Buy milk, Pay rent, Call Ali and 1 more', url: '/#/today', tag: `reminders-${at(`${TODAY}T09:00:00Z`) / 60000}` })
  })

  test('urgent ones lead, and one on its own is sent as it is', () => {
    const sent = pushes(due([task('a', 'Buy milk'), task('b', 'Pay rent', { priority: 'urgent' })], `${TODAY}T09:00:00Z`))
    assert.equal(sent[0].body, 'Urgent: Pay rent, Buy milk')
    const single = pushes(due([task('a', 'Buy milk')], `${TODAY}T09:00:00Z`))
    assert.deepEqual(single, [{ title: 'Buy milk', body: 'Due today', url: '/#/tasks/a', tag: 'task-a' }])
  })

  test('today and tomorrow together say both, and open the task list', () => {
    const tasks = [task('a', 'Buy milk'), task('b', 'Pay rent'), task('c', 'Essay', { date: TOMORROW, reminder_minutes: 1440 })]
    const [push] = pushes(due(tasks, `${TODAY}T09:00:00Z`))
    assert.equal(push.title, '3 tasks due: 2 today, 1 tomorrow')
    assert.equal(push.url, '/#/tasks')
    const allTomorrow = pushes(due([task('a', 'A', { date: TOMORROW }), task('b', 'B', { date: TOMORROW })], `${TODAY}T09:00:00Z`, { allDayMode: 'before' }))
    assert.equal(allTomorrow[0].title, '2 tasks due tomorrow')
  })

  test('the body stays under 180 characters with long titles', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, `${'Very long task title '.repeat(6)}${i}`))
    const [push] = pushes(due(tasks, `${TODAY}T09:00:00Z`))
    assert.ok(push.body.length <= 180, push.body)
    assert.match(push.body, / and 7 more$/)
    assert.equal(push.title, '10 tasks due today')
  })

  test('the late ping for a task just added joins the all-day batch of that run', () => {
    // A task added at 8:59 with an explicit reminder pings at 9:00, the same moment as the others.
    const late = task('l', 'Late add', { created_at: `${TODAY}T08:59:00Z`, reminder_minutes: 0 })
    const list = due([task('a', 'Buy milk'), late], `${TODAY}T09:00:30Z`, { allDayTime: '08:30' })
    assert.equal(list.length, 2)
    assert.equal(groupDue(list).length, 1)
    assert.equal(pushes(list)[0].title, '2 tasks due today')
  })
})

describe('timed tasks keep their own banner', () => {
  test('a timed task is not merged into the all-day batch', () => {
    // 9:15 with the 15-minute lead fires at 9:00, with the all-day ones.
    const tasks = [task('a', 'Buy milk'), task('b', 'Pay rent'), task('t', 'Dentist', { time: '09:15' })]
    const sent = pushes(due(tasks, `${TODAY}T09:00:00Z`))
    assert.deepEqual(sent.map((push) => push.title).sort(), ['2 tasks due today', 'Dentist'])
    assert.equal(sent.find((push) => push.title === 'Dentist').url, '/#/tasks/t')
  })

  test('timed tasks at the same moment share one', () => {
    const tasks = [task('a', 'Dentist', { time: '15:00' }), task('b', 'Call bank', { time: '15:00' }), task('c', 'Later', { time: '15:10' })]
    const sent = pushes(due(tasks, `${TODAY}T14:45:00Z`))
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], { title: '2 tasks at 3:00 PM', body: 'Dentist, Call bank', url: '/#/today', tag: `reminders-${at(`${TODAY}T14:45:00Z`) / 60000}` })
    // Different times firing in the same minute say each time.
    const mixed = [task('a', 'Dentist', { time: '15:00' }), task('b', 'Call bank', { time: '14:45', reminder_minutes: 0 })]
    const [push] = pushes(due(mixed, `${TODAY}T14:45:00Z`))
    assert.equal(push.title, '2 tasks coming up')
    assert.equal(push.body, 'Dentist (3:00 PM), Call bank (2:45 PM)')
    // "At the time" reminders: due now.
    const now = pushes(due([task('a', 'A', { time: '15:00', reminder_minutes: 0 }), task('b', 'B', { time: '15:00', reminder_minutes: 0 })], `${TODAY}T15:00:00Z`))
    assert.equal(now[0].title, '2 tasks due now')
    // A day ahead: tomorrow's tasks, so the list opens.
    const ahead = pushes(due([task('a', 'A', { date: TOMORROW, time: '09:00', reminder_minutes: 1440 }), task('b', 'B', { date: TOMORROW, time: '09:00', reminder_minutes: 1440 })], `${TODAY}T09:00:00Z`))
    assert.deepEqual([ahead[0].title, ahead[0].url], ['2 tasks tomorrow at 9:00 AM', '/#/tasks'])
  })

  test('a late cron run that finds several timed reminders sends one, with their times', () => {
    const tasks = [task('a', 'Dentist', { time: '15:00' }), task('b', 'Later', { time: '15:01' })]
    const sent = pushes(due(tasks, `${TODAY}T14:50:00Z`))
    assert.deepEqual(sent, [{ title: '2 tasks coming up', body: 'Dentist (3:00 PM), Later (3:01 PM)', url: '/#/today', tag: `reminders-${at(`${TODAY}T14:45:00Z`) / 60000}` }])
  })
})

describe('what stays on its own', () => {
  test('the morning summary, the evening check-in, prayer and the workout reminder', () => {
    const tasks = [task('a', 'Buy milk'), task('b', 'Pay rent')]
    const settings = { gym }
    const list = dueNotifications({
      settings: { timeZone: 'UTC', ...settings, notifications: { dailySummary: true, dailySummaryTime: '09:00', overdue: true, overdueTime: '09:00', gym: true, gymTime: '09:00', prayer: true } },
      tasks, friends: [], classes: [], gymSessions: [], prayerTimings: { Fajr: '05:00', Dhuhr: '09:00', Asr: '15:00', Maghrib: '18:00', Isha: '19:30' },
    }, at(`${TODAY}T09:00:00Z`))
    const groups = groupDue(list)
    const sizes = Object.fromEntries(groups.map((group) => [group[0].kind, group.length]))
    assert.deepEqual(sizes, { allday: 2, summary: 1, evening: 1, gym: 1, prayer: 1 })
    assert.equal(groups.length, 5)
  })
})

describe('quiet hours', () => {
  const quiet = { quietHours: true, quietStart: '22:00', quietEnd: '07:00' }

  test('everything held overnight arrives as one push at the end', () => {
    const tasks = [task('t', 'Call Ali', { time: '06:00' }), task('a', 'Buy milk')]
    const input = { settings: { timeZone: 'UTC', gym, notifications: { ...OFF, ...quiet, allDayTime: '06:00', gym: true, gymTime: '06:30', prayer: true } }, tasks, friends: [], classes: [], gymSessions: [], prayerTimings: { Fajr: '06:55', Dhuhr: '12:00', Asr: '15:00', Maghrib: '18:00', Isha: '19:30' } }
    // Nothing before the end of quiet hours except the prayer (it never waits).
    assert.deepEqual(dueNotifications(input, at(`${TODAY}T06:56:00Z`)).map((item) => item.kind), ['prayer'])
    const list = dueNotifications(input, at(`${TODAY}T07:00:00Z`))
    const groups = groupDue(list)
    assert.equal(groups.length, 2) // the prayer, and one push for the rest
    const held = combineReminders(groups.find((group) => group.length === 3))
    assert.equal(held.title, '3 reminders held overnight')
    assert.equal(held.body, 'Call Ali (6:00 AM), Buy milk, Push day workout')
    assert.equal(held.url, '/#/today')
  })

  test('held all-day tasks read as tasks due, and a reminder held past midnight says today', () => {
    const tasks = [task('a', 'Buy milk', { date: TOMORROW }), task('b', 'Pay rent', { date: TOMORROW })]
    const notifications = { ...quiet, allDayMode: 'before', allDayTime: '23:30' }
    // Planned for 11:30 PM the day before; quiet hours hold it to 7:00 on the day itself.
    const list = due(tasks, `${TOMORROW}T07:00:00Z`, notifications)
    assert.deepEqual(list.map((item) => item.body), ['Due today', 'Due today'])
    assert.ok(list.every((item) => item.held === 'overnight'))
    assert.equal(pushes(list)[0].title, '2 tasks due today')
  })

  test('daytime quiet hours', () => {
    const tasks = [task('t', 'Call Ali', { time: '13:30' }), task('g', 'Gym bag', { time: '13:40' })]
    const list = due(tasks, `${TODAY}T14:00:00Z`, { quietHours: true, quietStart: '13:00', quietEnd: '14:00' })
    assert.equal(groupDue(list).length, 1)
    assert.equal(combineReminders(list).title, '2 reminders from quiet hours')
    assert.equal(combineReminders(list).body, 'Call Ali (1:30 PM), Gym bag (1:40 PM)')
    const mixed = due([...tasks, task('a', 'Buy milk')], `${TODAY}T14:00:00Z`, { quietHours: true, quietStart: '13:00', quietEnd: '14:00', allDayTime: '13:15' })
    assert.equal(pushes(mixed)[0].title, '3 reminders from quiet hours')
  })

  test('a same-day reminder held past midnight says it was due yesterday', () => {
    // 11:30 PM on the day falls in quiet hours (11 PM–7 AM): it arrives the next morning.
    const list = due([task('a', 'Buy milk')], `${TOMORROW}T07:00:00Z`, { quietHours: true, quietStart: '23:00', quietEnd: '07:00', allDayMode: 'day', allDayTime: '23:30' })
    assert.equal(list.length, 1)
    assert.deepEqual([list[0].body, list[0].day, list[0].held], ['Was due yesterday', 'yesterday', 'overnight'])
    assert.equal(pushes(list)[0].body, 'Was due yesterday')
  })

  test('only what was held is called held; it comes before the all-day ones', () => {
    // Quiet hours end at the all-day time: three due today plus one timed task held from 6:30.
    const tasks = [task('a', 'Pay rent'), task('b', 'Buy milk'), task('c', 'Call bank'), task('t', 'Dentist call', { time: '06:45' })]
    const list = due(tasks, `${TODAY}T07:00:00Z`, { quietHours: true, quietStart: '22:00', quietEnd: '07:00', allDayTime: '07:00' })
    assert.equal(list.length, 4)
    assert.equal(list.filter((item) => item.held).length, 1)
    const [push] = pushes(list)
    assert.equal(push.title, '4 reminders, 1 held overnight')
    assert.equal(push.body, 'Dentist call (6:45 AM), Pay rent, Buy milk and 1 more')
  })

  test('no quiet hours: nothing is marked held', () => {
    assert.ok(due([task('t', 'Call Ali', { time: '06:00' }), task('a', 'Buy milk')], `${TODAY}T09:00:00Z`).every((item) => !item.held))
  })
})

describe('the cron claim stays per item', () => {
  test('a batch is sent once; a reminder due in a later run is sent alone', () => {
    const log = new Set()
    const tasks = [task('a', 'Buy milk'), task('b', 'Pay rent'), task('c', 'Call Ali')]
    const first = cronRun(due(tasks, `${TODAY}T09:00:00Z`), log)
    assert.deepEqual(first.map((push) => push.title), ['3 tasks due today'])
    // Still inside the send window: nothing new, nothing sent again.
    assert.deepEqual(cronRun(due(tasks, `${TODAY}T09:01:00Z`), log), [])
    // A task added at 9:10 with an explicit reminder pings alone at 9:11 (the others are claimed).
    const late = task('d', 'Late add', { created_at: `${TODAY}T09:10:00Z`, reminder_minutes: 0 })
    const later = cronRun(due([...tasks, late], `${TODAY}T09:11:00Z`), log)
    assert.deepEqual(later, [{ title: 'Late add', body: 'Due today', url: '/#/tasks/d', tag: 'task-d' }])
  })

  test('a group whose items are partly claimed sends only the rest', () => {
    const log = new Set([`task:a:${TODAY}:allday:day`])
    const sent = cronRun(due([task('a', 'Buy milk'), task('b', 'Pay rent'), task('c', 'Call Ali')], `${TODAY}T09:00:00Z`), log)
    assert.deepEqual(sent.map((push) => [push.title, push.body]), [['2 tasks due today', 'Pay rent, Call Ali']])
  })
})

describe('combineReminders never throws', () => {
  test('junk in, a push out', () => {
    assert.deepEqual(combineReminders(null), { title: undefined, body: undefined, url: undefined, tag: undefined })
    const push = combineReminders([{ title: 'A' }, null, { title: 'B', body: 'x' }])
    assert.equal(push.title, '2 reminders')
    assert.equal(push.body, 'A, B')
    assert.equal(push.tag, 'reminders')
    assert.deepEqual(groupDue(null), [])
    assert.deepEqual(groupDue([null, { key: 'x' }]).length, 2)
  })
})

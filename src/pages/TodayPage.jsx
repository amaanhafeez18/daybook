import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import Burst from '../components/ui/Burst.jsx'
import { Avatar, Button, Card, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import { UnderstoodChip, useQuickParse } from '../components/QuickParse.jsx'
import CitySheet from '../components/CitySheet.jsx'
import TodayHint from '../components/SetupCard.jsx'
import TaskRow from '../components/TaskRow.jsx'
import MorningNote from '../components/MorningNote.jsx'
import TalkButton, { voiceAvailable } from '../components/voice/TalkButton.jsx'
import { voicePrefs } from '../lib/voice/prefs.js'
import { readPref, writePref } from '../lib/api.js'
import { getState, updateSettings, useData } from '../lib/store.js'
import { MOODS, classOver, classesOn, compareTasks, createTask, deleteTaskForever, friendStatus, lastContactMap, saveJournalEntry, updateTask } from '../lib/planner.js'
import { WEEKDAY_SHORT, addDaysISO, compareTimes, dueSentence, formatDateLong, formatDuration, formatTime, formatTimeShort, greeting, nowTimeHHMM, timeAgo, todayISO } from '../lib/dates.js'
import { eveningLeftovers, nowNext, timePassed } from '../lib/agenda.js'
import { useLinger } from '../lib/useLinger.js'
import { haptic } from '../lib/haptics.js'
import { primeKeyboard } from '../lib/keyboard.js'
import { navigate } from '../lib/router.js'
import { writeSessionState } from '../lib/sessionState.js'
import { notificationPrefs } from '../lib/notifications.js'
import { dailyForecast, describeWeather, prayerSchedule, upcomingHours, useLocation, useNow, usePrayerTimes, useWeather } from '../lib/environment.js'
import CardBoundary, { CardSkeleton } from '../components/CardBoundary.jsx'
import { useAreas } from '../lib/areas.js'
import { dismissRhythm, learnRhythms, readRhythms, restoreRhythm, rhythmLabel, showTimeChip, usualToday, visibleNow } from '../lib/rhythms.js'
import { taskClashes } from '../lib/timing.js'
import { dismissRadar, hasPrep, radarWhen, readRadar, restoreRadar, studyPlan, upcomingDeadlines } from '../lib/radar.js'
import '../components/today.css'
import { lazySheet, whenIdle } from '../lib/lazyPage.js'

// The task and class sheets load on first use (and quietly after launch), keeping them out of the
// code every launch runs.
const TaskSheet = lazySheet(() => import('../components/TaskSheet.jsx'))
const ClassSheet = lazySheet(() => import('../components/ClassSheet.jsx'), (props) => !!props.item)

// The Health glance (gym + food state) loads as its own chunk so the first bundle stays small.
const HealthGlance = lazy(() => import('../components/HealthGlance.jsx'))
// "Talked" asks what you talked about with the People page's own sheet (loaded when first needed).
const CatchUpSheet = lazy(() => import('./PeoplePage.jsx').then((module) => ({ default: module.CatchUpSheet })))

const OVERDUE_SHOWN = 8
const TOMORROW_SHOWN = 5
const PEOPLE_SHOWN = 3

// Phones, top to bottom: the assistant's morning note (only when it wrote one, until about noon),
// Today (with "Usually today" rows for tasks you repeat), at most one hint card ("Get set up" for
// a new account, or a reminders / Home Screen hint), Tomorrow, Health (one line each for the gym
// and food; the full cards live on Health → Today), Weather, Prayer, People. From 1000px the first ones form the
// main column and the rest the side column. Weather, Prayer and People are one line each; their
// details open on a tap (remembered per device). Areas turned off (lib/areas.js) don't appear.
export default function TodayPage({ displayName, loaded }) {
  const tasks = useData('tasks')
  const events = useData('events')
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const settings = useData('settings')
  const classes = useData('classes')
  const journalEntries = useData('journalEntries')
  const now = useNow(60000)
  const today = todayISO()
  const tomorrow = addDaysISO(today, 1)
  const location = useLocation()
  const areas = useAreas()
  // null = closed; { task } edits a task (pickDate: straight to its date); { defaults } adds one.
  const [sheet, setSheet] = useState(null)
  const [classSheet, setClassSheet] = useState(null)
  const [cityOpen, setCityOpen] = useState(false)
  const greetName = String(displayName || '').trim().split(/\s+/)[0]

  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  // intent: { pickDate: true } from a row's Later… → "Pick a date…".
  const openTask = (task, intent) => setSheet({ task, ...intent })
  // Class rows carry the class id; the sheet edits the whole class.
  const openClass = (id) => {
    const record = classes.find((item) => item.id === id)
    if (record) setClassSheet(record)
  }

  useEffect(() => whenIdle(() => {
    TaskSheet.preload().catch(() => {})
    ClassSheet.preload().catch(() => {})
  }), [])

  // "N" on a computer (the shell's daybook:command): a new task for today.
  useEffect(() => {
    const onCommand = (event) => {
      if (event.detail?.name !== 'new-task') return
      event.preventDefault() // tells the shell this page took it
      setSheet({ defaults: { date: todayISO() } })
    }
    window.addEventListener('daybook:command', onCommand)
    return () => window.removeEventListener('daybook:command', onCommand)
  }, [])

  return (
    <div className="today td-page">
      <header className="page-header td-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        {/* The first name only (as the assistant greets you): a full name was cut off with "…". */}
        <h1 className="td-greeting">{greeting(now)}{greetName ? `, ${greetName}` : ''}</h1>
      </header>

      <div className="today-grid">
        <div className="today-main">
          {/* The assistant's morning note (Settings → Notifications → Written by the assistant), until about noon. */}
          <CardBoundary>
            <MorningNote settings={settings} today={today} now={now} />
          </CardBoundary>
          <TodayCard
            tasks={active}
            allTasks={tasks}
            events={events}
            classes={classes}
            today={today}
            now={now}
            loaded={loaded}
            settings={settings}
            journal={areas.journal}
            journalEntries={journalEntries}
            onOpen={openTask}
            onOpenClass={openClass}
          />
          <CardBoundary>
            {/* primeKeyboard: the sheet opens with the keyboard already up (lib/keyboard.js). */}
            <TodayHint
              areas={areas}
              location={location}
              loaded={loaded}
              onAddClass={() => {
                primeKeyboard()
                setClassSheet({})
              }}
              onChooseCity={() => setCityOpen(true)}
            />
          </CardBoundary>
          <TomorrowCard
            tasks={active}
            classes={classes}
            tomorrow={tomorrow}
            loaded={loaded}
            onOpen={openTask}
            onOpenClass={openClass}
            onAdd={() => {
              primeKeyboard()
              setSheet({ defaults: { date: tomorrow } })
            }}
          />
          {(areas.gym || areas.food) && (
            <CardBoundary>
              <Suspense fallback={<CardSkeleton />}>
                <HealthGlance today={today} areas={areas} loaded={loaded} />
              </Suspense>
            </CardBoundary>
          )}
        </div>

        <div className="today-side">
          <WeatherCard location={location} today={today} onChooseCity={() => setCityOpen(true)} />
          {settings?.showPrayerTimes !== false && <PrayerCard coords={location.coords} method={settings?.prayerMethod || 'auto'} school={settings?.prayerSchool || 0} />}
          {loaded && areas.people && <PeopleCard friends={friends} contactLogs={contactLogs} today={today} />}
        </div>
      </div>

      <TaskSheet open={!!sheet} task={sheet?.task || null} defaults={sheet?.defaults || { date: today }} pickingDate={!!sheet?.pickDate} onClose={() => setSheet(null)} />
      <ClassSheet item={classSheet} onClose={() => setClassSheet(null)} onReopen={() => setClassSheet({})} />
      <CitySheet open={cityOpen} onClose={() => setCityOpen(false)} />
    </div>
  )
}

// ---- Today -------------------------------------------------------------------------------------

// "Talk about your day" shows from this time.
const TALK_DAY_FROM = '18:00'

// "14:30" from minutes after midnight, for the short time labels.
const clock = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

function TodayCard({ tasks, allTasks, events, classes, today, now, loaded, settings, journal, journalEntries, onOpen, onOpenClass }) {
  const tomorrow = addDaysISO(today, 1)
  const todayTasks = useMemo(() => tasks.filter((task) => task.date === today), [tasks, today])
  const open = useMemo(() => todayTasks.filter((task) => !task.done), [todayTasks])
  const done = useMemo(() => todayTasks.filter((task) => task.done).sort(compareTasks), [todayTasks])
  const past = useMemo(() => tasks.filter((task) => task.date && task.date < today), [tasks, today])
  const overdue = useMemo(() => past.filter((task) => !task.done).sort(compareTasks), [past])
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const nowHHMM = nowTimeHHMM(now)
  // A class leaves the list once it's over.
  const todayClasses = useMemo(() => classesOn(today).filter((item) => !classOver(item.time, nowMinutes)), [classes, today, nowMinutes]) // eslint-disable-line react-hooks/exhaustive-deps

  // A task ticked off here (today's or an overdue one) stays in place for a moment, with Undo
  // in its toast, then folds away (lib/useLinger.js).
  const openIds = useMemo(() => [...open, ...overdue].map((task) => task.id), [open, overdue])
  const doneIds = useMemo(() => [...done, ...past.filter((task) => task.done)].map((task) => task.id), [done, past])
  const { lingering, leaving, onLeft } = useLinger(openIds, doneIds)
  const overdueShown = useMemo(() => past.filter((task) => !task.done || lingering.has(task.id)).sort(compareTasks), [past, lingering])

  // Open tasks and classes by time; ticked-off rows keep their place while they linger.
  const timeline = useMemo(() => [
    ...open.map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...done.filter((task) => lingering.has(task.id)).map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...todayClasses.map((item, index) => ({ kind: 'class', key: `c-${item.id}-${item.time}-${index}`, time: item.time, item })),
  ].sort((a, b) => compareTimes(a.time, b.time) || (a.task && b.task ? compareTasks(a.task, b.task) : 0)), [open, done, lingering, todayClasses])
  const folded = done.filter((task) => !lingering.has(task.id))

  // A timed task that overlaps a class, an event or another task says so on its row (lib/timing.js).
  const clashes = useMemo(() => taskClashes({ tasks: todayTasks, events, classes, from: today, to: today }), [todayTasks, events, classes, today])

  // "Coming up": exams and deadlines in the next week (lib/radar.js), at most two, each with
  // "Plan 2 study blocks" when nothing is planned for it yet.
  const radarPrefs = useMemo(() => readRadar(settings), [settings?.radar]) // eslint-disable-line react-hooks/exhaustive-deps
  const deadlines = useMemo(
    // A few spare: RadarRows drops tomorrow's ones that have nothing to offer (the Tomorrow card lists them).
    () => (loaded ? upcomingDeadlines({ tasks, events, classes, today, dismissed: radarPrefs.dismissed }).slice(0, 4) : []),
    [loaded, tasks, events, classes, today, radarPrefs],
  )

  // "Now · Economics · until 4:30 PM" / "Next · Dentist 2:30 PM · in 25 min" / "Free until 4 PM · then Dentist".
  const line = useMemo(() => nowNext({ tasks: open, classSlots: todayClasses, nowMinutes }), [open, todayClasses, nowMinutes])

  // After the evening check-in time (Settings → Notifications; used even with that push off):
  // what's left can move to tomorrow in one tap, and a mood goes in the journal in one more.
  const eveningTime = notificationPrefs(settings).overdueTime || '18:00'
  const evening = nowHHMM >= eveningTime
  const leftovers = evening ? eveningLeftovers(open, today, nowHHMM) : []
  const moodSet = !!journalEntries?.find((entry) => entry.date === today)?.mood
  const askMood = loaded && evening && journal && !moodSet
  // From 6 PM, before today's journal has any words: "Talk about your day" opens a voice chat that
  // listens, then reads back a short entry to save (only with voice chats on).
  const wroteToday = !!journalEntries?.some((entry) => entry.date === today && (String(entry.body || '').trim() || String(entry.title || '').trim()))
  const talkDay = loaded && journal && nowHHMM >= TALK_DAY_FROM && !wroteToday && voicePrefs(settings).enabled && voiceAvailable()

  function moveAll() {
    const target = evening ? tomorrow : today
    const moved = overdue.map((task) => ({ id: task.id, date: task.date }))
    for (const task of overdue) updateTask(task.id, { date: target })
    toast(`Moved ${moved.length} task${moved.length === 1 ? '' : 's'} to ${evening ? 'tomorrow' : 'today'}`, {
      action: { label: 'Undo', onClick: () => moved.forEach((item) => updateTask(item.id, { date: item.date })) },
    })
  }

  function moveLeft() {
    const moved = leftovers.map((task) => ({ id: task.id, date: task.date }))
    for (const task of leftovers) updateTask(task.id, { date: tomorrow })
    toast(`Moved ${moved.length} task${moved.length === 1 ? '' : 's'} to tomorrow`, {
      action: { label: 'Undo', onClick: () => moved.forEach((item) => updateTask(item.id, { date: item.date })) },
    })
  }

  function moveOne(task) {
    const from = task.date
    updateTask(task.id, { date: today })
    toast(`Moved “${truncate(task.text, 28)}” to today`, { action: { label: 'Undo', onClick: () => updateTask(task.id, { date: from }) } })
  }

  function pickMood(mood) {
    saveJournalEntry(today, { mood: mood.id })
    // The Journal remembers the section and day it was left on; "Write more" means today's entry.
    const writeMore = () => {
      writeSessionState('journal.tab', 'journal')
      writeSessionState('journal.date', today)
      navigate('journal')
    }
    toast('Saved to today’s journal', { action: { label: 'Write more', onClick: writeMore } })
  }

  // "Usually today": tasks repeated on a rhythm (lib/rhythms.js), learned from the whole history
  // (archived too), offered until the evening check-in; after it only those with a later usual time.
  const learned = useMemo(() => learnRhythms(allTasks || tasks, today), [allTasks, tasks, today])
  const rhythmPrefs = useMemo(() => readRhythms(settings), [settings?.rhythms]) // eslint-disable-line react-hooks/exhaustive-deps
  const usualDue = useMemo(() => usualToday({ tasks: allTasks || tasks, today, rhythms: rhythmPrefs, learned, limit: 2 }), [allTasks, tasks, today, rhythmPrefs, learned])
  const usual = loaded ? visibleNow(usualDue, nowHHMM, eveningTime) : []

  const counts = [open.length ? `${open.length} left` : '', done.length ? `${done.length} done` : ''].filter(Boolean).join(' · ')
  const empty = timeline.length === 0
  const allDone = done.length > 0 && !overdue.length
  // While folded, the overdue line names the first tasks so the fold says what's in it.
  const overdueSummary = overdue.map((task) => task.text).join(', ')

  // The day cleared by a tap: a small burst on "All done for today" once the last row has folded
  // away, and a success tap (in the tap itself, where iOS allows it). Once a day.
  const [moment, setMoment] = useState('') // '' | 'armed' | 'shown'
  function onToggle(task, nowDone) {
    if (!nowDone) {
      if (moment === 'armed') setMoment('')
      return
    }
    if (task.date !== today || moment || readPref('moment.day', '') === today) return
    if (open.some((item) => item.id !== task.id) || overdue.length) return
    haptic('success')
    setMoment('armed')
  }
  const settling = done.some((task) => lingering.has(task.id))
  useEffect(() => {
    if (moment !== 'armed' || settling) return
    if (empty && allDone) {
      writePref('moment.day', today)
      setMoment('shown')
    } else setMoment('')
  }, [moment, settling, empty, allDone, today])

  // Under "All done for today": what tomorrow starts with, else how many tasks it has.
  const tomorrowLine = useMemo(() => {
    if (!empty || !allDone) return ''
    const upcoming = tasks.filter((task) => !task.done && task.date === tomorrow)
    const first = nowNext({ tasks: upcoming, classSlots: classesOn(tomorrow), nowMinutes: 0 })
    if (first) return `Tomorrow starts with ${first.title} ${formatTimeShort(clock(first.start))}`
    return upcoming.length ? `${upcoming.length} task${upcoming.length === 1 ? '' : 's'} tomorrow` : ''
  }, [empty, allDone, tasks, tomorrow, classes]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title="Today" icon="sun" className="td-today" action={loaded && counts ? <span className="td-count">{counts}</span> : null}>
      {!loaded ? <Skeleton lines={3} /> : (
        <div className="td-today-body">
          {line && <NowNextLine line={line} onOpen={() => (line.ref.type === 'task' ? onOpen(open.find((task) => task.id === line.ref.id)) : onOpenClass(line.ref.id))} />}

          {overdueShown.length > 0 && (
            <Disclosure
              id="today-overdue"
              className="td-section td-fold is-danger"
              label={<><span className="td-row-icon"><Icon name="alert" size={24} strokeWidth={1.9} /></span><span className="td-row-label">{overdue.length || overdueShown.length} overdue</span></>}
              summary={overdueSummary}
            >
              <ul className="task-list td-sublist">
                {overdueShown.slice(0, OVERDUE_SHOWN).map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpen={onOpen}
                    overdueGroup
                    leaving={leaving.has(task.id)}
                    onLeft={onLeft}
                    trailing={task.done ? null : (
                      <button type="button" className="td-chip-today" onClick={() => moveOne(task)} aria-label={`Move “${task.text}” to today`}>
                        Today
                      </button>
                    )}
                  />
                ))}
              </ul>
              {overdue.length > 0 && (
                <div className="td-fold-actions">
                  <button type="button" className="td-row-action" onClick={moveAll}>{evening ? 'Move all to tomorrow' : 'Move all to today'}</button>
                  {overdue.length > OVERDUE_SHOWN && <a className="td-row-action" href="#/tasks">See all {overdue.length}<Icon name="chevronRight" size={16} strokeWidth={2.2} /></a>}
                </div>
              )}
            </Disclosure>
          )}

          {empty ? (
            <div className="td-section td-empty">
              <span className={`td-row-icon ${allDone ? 'is-success' : 'is-quiet'}`}>
                <Icon name={allDone ? 'check' : 'sun'} size={15} strokeWidth={2.2} />
                {allDone && <Burst active={moment === 'shown'} radius={34} />}
              </span>
              <span className="td-empty-text">
                {allDone
                  ? 'All done for today.'
                  : overdue.length ? 'Nothing else planned for today.' : 'A clear day. Add something below or ask the assistant.'}
                {tomorrowLine && <span className="td-empty-sub">{tomorrowLine}</span>}
              </span>
            </div>
          ) : (
            <ul className="task-list td-section">
              {timeline.map((entry) => (entry.kind === 'task'
                ? (
                  <TaskRow
                    key={entry.key}
                    task={entry.task}
                    onOpen={onOpen}
                    showDate={false}
                    passed={timePassed(entry.task, today, nowMinutes)}
                    leaving={leaving.has(entry.task.id)}
                    onLeft={onLeft}
                    onToggle={onToggle}
                    overlap={clashes[entry.task.id]}
                  />
                )
                : <ClassRow key={entry.key} item={entry.item} onOpen={onOpenClass} />))}
            </ul>
          )}

          {usual.length > 0 && <UsualRows list={usual} today={today} nowHHMM={nowHHMM} />}

          {deadlines.length > 0 && <RadarRows list={deadlines} tasks={tasks} events={events} classes={classes} today={today} nowHHMM={nowHHMM} />}

          {leftovers.length > 0 && (
            <div className="td-section td-evening">
              <span className="td-evening-text">{leftovers.length} still open</span>
              <button type="button" className="td-row-action" onClick={moveLeft}>Move to tomorrow</button>
            </div>
          )}

          {askMood && (
            <div className="td-section td-mood" role="group" aria-label="How was today?">
              <span className="td-mood-label">How was today?</span>
              <span className="td-mood-faces">
                {MOODS.map((mood) => (
                  <button key={mood.id} type="button" className="td-mood-btn" onClick={() => pickMood(mood)} aria-label={mood.label} title={mood.label}>
                    <span aria-hidden="true">{mood.emoji}</span>
                  </button>
                ))}
              </span>
            </div>
          )}

          {talkDay && (
            <div className="td-section td-talk">
              <TalkButton variant="chip" intent="debrief" from="today" label="Talk about your day" />
            </div>
          )}

          {folded.length > 0 && (
            <Disclosure
              id="today-done"
              className="td-section td-fold is-done"
              label={<><span className="td-row-icon"><Icon name="check" size={14} strokeWidth={2.6} /></span><span className="td-row-label">{folded.length} done</span></>}
            >
              <ul className="task-list td-sublist">
                {folded.map((task) => <TaskRow key={task.id} task={task} onOpen={onOpen} showDate={false} />)}
              </ul>
            </Disclosure>
          )}

          <AddRow today={today} />
        </div>
      )}
    </Card>
  )
}

// "Usually today: Laundry · Every Sunday", with Add (no time), "Like last time · 5 PM" while that
// time is still ahead, and × ("Not this", remembered in settings.rhythms and undone from Settings →
// Suggestions). Nothing is added without a tap.
function UsualRows({ list, today, nowHHMM }) {
  function add(item, withTime) {
    const task = createTask({ text: item.title, date: today, time: withTime ? item.usualTime : '', priority: item.priority || 'medium' })
    haptic('light')
    toast(`Added “${truncate(item.title, 28)}” for today`, { action: { label: 'Undo', onClick: () => deleteTaskForever(task.id) } })
  }

  function dismiss(item) {
    const current = () => readRhythms(getState().data.settings)
    updateSettings({ rhythms: dismissRhythm(current(), item, today) })
    toast(`Won’t suggest “${truncate(item.title, 28)}” again`, { action: { label: 'Undo', onClick: () => updateSettings({ rhythms: restoreRhythm(current(), item.key) }) } })
  }

  return (
    <section className="td-section td-usual" aria-label="Usually today">
      <ul className="td-usual-list">
        {list.map((item) => {
          const time = showTimeChip(item, nowHHMM) ? formatTimeShort(item.usualTime) : ''
          return (
            <li key={item.key} className="td-usual-row">
              <span className="td-row-icon is-quiet" aria-hidden="true"><Icon name="repeat" size={14} strokeWidth={2.2} /></span>
              <span className="td-usual-text">
                <span className="td-usual-title"><span className="td-usual-lead">Usually today: </span><strong>{item.title}</strong></span>
                <span className="td-usual-sub">{rhythmLabel(item.rhythm)}</span>
              </span>
              <button type="button" className="td-usual-x" onClick={() => dismiss(item)} aria-label={`Don’t suggest “${item.title}”`}>
                <Icon name="close" size={16} strokeWidth={2.2} />
              </button>
              <span className="td-usual-actions">
                {time && (
                  <button type="button" className="td-usual-btn" onClick={() => add(item, true)} aria-label={`Add “${item.title}” at ${time}, like last time`}>
                    Like last time · {time}
                  </button>
                )}
                <button type="button" className="td-usual-btn is-add" onClick={() => add(item, false)} aria-label={`Add “${item.title}” for today`}>
                  <Icon name="plus" size={15} strokeWidth={2.4} />
                  Add
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// "Coming up: ECON 101 midterm" / "Thu, in 4 days", × = Not now (remembered in settings.radar).
// When nothing is planned for it yet: "Plan 2 study blocks", two tasks on the freest evenings
// before it (lib/radar.js studyPlan), made through the planner so each gets its calendar event,
// with one Undo for both. Nothing is added without the tap.
function RadarRows({ list, tasks, events, classes, today, nowHHMM }) {
  const plans = useMemo(() => Object.fromEntries(list.map((item) => [
    item.key,
    hasPrep(item, tasks, { today, classes }) ? [] : studyPlan({ item, tasks, events, classes, today, now: nowHHMM }),
  ])), [list, tasks, events, classes, today, nowHHMM])
  // A task due tomorrow is already in the Tomorrow card: it shows here only to offer a study block.
  const tomorrow = addDaysISO(today, 1)
  const shown = list.filter((item) => item.source !== 'task' || item.date !== tomorrow || (plans[item.key] || []).length > 0).slice(0, 2)

  function plan(item) {
    const blocks = plans[item.key] || []
    if (!blocks.length) return
    const created = blocks.map((block) => createTask({ text: block.text, date: block.date, time: block.time, priority: 'medium' }))
    haptic('light')
    const when = blocks.map((block) => `${block.date === today ? 'Today' : WEEKDAY_SHORT[new Date(`${block.date}T12:00:00`).getDay()]} ${formatTimeShort(block.time)}`).join(', ')
    toast(`Study ${blocks.length === 1 ? 'block' : 'blocks'} added · ${when}`, {
      action: { label: 'Undo', onClick: () => created.forEach((task) => deleteTaskForever(task.id)) },
    })
  }

  function dismiss(item) {
    const current = () => getState().data.settings?.radar
    updateSettings({ radar: dismissRadar(current(), item.key, today) })
    toast(`Hidden: “${truncate(item.title, 28)}”`, { action: { label: 'Undo', onClick: () => updateSettings({ radar: restoreRadar(current(), item.key) }) } })
  }

  if (!shown.length) return null
  return (
    <section className="td-section td-usual td-radar" aria-label="Coming up">
      <ul className="td-usual-list">
        {shown.map((item) => {
          const blocks = plans[item.key] || []
          const when = [radarWhen(item.date, today), item.time && formatTimeShort(item.time)].filter(Boolean).join(' · ')
          return (
            <li key={item.key} className="td-usual-row">
              <span className="td-row-icon is-quiet" aria-hidden="true"><Icon name={item.className || item.exam ? 'graduation' : 'flag'} size={14} strokeWidth={2.2} /></span>
              <span className="td-usual-text">
                <span className="td-usual-title"><span className="td-usual-lead">Coming up: </span><strong>{item.title}</strong></span>
                <span className="td-usual-sub">{when}</span>
              </span>
              <button type="button" className="td-usual-x" onClick={() => dismiss(item)} aria-label={`Not now: hide “${item.title}”`} title="Not now">
                <Icon name="close" size={16} strokeWidth={2.2} />
              </button>
              {blocks.length > 0 && (
                <span className="td-usual-actions">
                  <button type="button" className="td-usual-btn is-add" onClick={() => plan(item)} aria-label={`Plan ${blocks.length === 1 ? 'a study block' : `${blocks.length} study blocks`} before “${item.title}”`}>
                    <Icon name="calendarCheck" size={15} strokeWidth={2.2} />
                    {blocks.length === 1 ? 'Plan a study block' : `Plan ${blocks.length} study blocks`}
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// The line at the top of the Today card; a tap opens the task or class it names.
function NowNextLine({ line, onOpen }) {
  const time = (minutes) => formatTimeShort(clock(minutes))
  const parts = line.kind === 'now'
    ? { icon: 'graduation', lead: 'Now', title: line.title, meta: `until ${time(line.end)}` }
    : line.kind === 'next'
      ? { icon: line.ref.type === 'class' ? 'graduation' : 'clock', lead: 'Next', title: `${line.title} ${time(line.start)}`, meta: line.minutesUntil < 1 ? 'now' : `in ${formatDuration(line.minutesUntil)}` }
      : { icon: 'coffee', lead: `Free until ${time(line.start)}`, title: `then ${line.title}`, meta: '' }
  const label = [parts.lead, parts.title, parts.meta].filter(Boolean).join(' · ')
  return (
    <button type="button" className={`td-section td-next is-${line.kind}`} onClick={onOpen} aria-label={label}>
      <span className="td-row-icon is-quiet" aria-hidden="true"><Icon name={parts.icon} size={14} strokeWidth={2.2} /></span>
      <span className="td-next-text" aria-hidden="true">
        <span className="td-next-lead">{parts.lead}</span>
        <span className="td-next-dot"> · </span>
        <span className="td-next-title">{parts.title}</span>
        {parts.meta && <span className="td-next-meta"> · {parts.meta}</span>}
      </span>
      <Icon name="chevronRight" size={16} strokeWidth={2.2} className="td-next-chev" />
    </button>
  )
}

// Adds to today, unless a day or time is typed at the start or end ("Call mom tomorrow 5pm", the
// same parser as the Tasks page): that shows as a chip, and tapping the chip keeps the words in
// the title instead. A trailing " !", "!!" or "urgent" makes it urgent.
function AddRow({ today }) {
  const [text, setText] = useState('')
  const input = useRef(null)
  const quick = useQuickParse(text)
  const { understood } = quick

  function submit(event) {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    const task = createTask(understood
      ? { text: understood.title, date: understood.date || today, time: understood.time, priority: understood.priority || 'medium' }
      : { text: value, date: today })
    setText('')
    quick.reset()
    // Another day leaves this card: say where it went.
    if (task.date !== today) toast(`Added for ${dueSentence(task.date, task.time, today)}`, { action: { label: 'Undo', onClick: () => deleteTaskForever(task.id) } })
    // The key reads "Done", so on phones the keyboard goes away; on desktop keep typing.
    if (window.matchMedia?.('(pointer: coarse)').matches) input.current?.blur()
  }

  return (
    <form className="td-section td-add" onSubmit={submit}>
      <span className="td-row-icon is-accent" aria-hidden="true"><Icon name="plus" size={15} strokeWidth={2.6} /></span>
      <input
        ref={input}
        className="td-add-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Add a task for today"
        aria-label="Add a task for today"
        aria-describedby={understood ? 'td-add-parsed' : undefined}
        enterKeyHint="done"
        autoComplete="off"
      />
      {text.trim() && <button type="submit" className="btn btn-primary btn-sm td-add-btn">Add</button>}
      {understood && (
        <div className="td-add-parsed" id="td-add-parsed" aria-live="polite">
          <UnderstoodChip understood={understood} today={today} onDismiss={quick.dismiss} />
        </div>
      )}
    </form>
  )
}

// Tapping a class opens it for editing (room, times), like every other row.
function ClassRow({ item, onOpen }) {
  return (
    <li className="task-row class-row">
      <span className="class-dot" aria-hidden="true"><Icon name="graduation" size={15} /></span>
      <button type="button" className="task-body" onClick={() => onOpen?.(item.id)}>
        <span className="task-title">{item.name}</span>
        <span className="task-meta">
          {item.time && <span className="meta-chip"><Icon name="clock" size={13} />{item.time}</span>}
          {item.room && <span className="meta-chip"><Icon name="pin" size={13} />{item.room}</span>}
        </span>
      </button>
    </li>
  )
}

// ---- Tomorrow ----------------------------------------------------------------------------------

function TomorrowCard({ tasks, classes, tomorrow, loaded, onOpen, onOpenClass, onAdd }) {
  const upcoming = useMemo(() => tasks.filter((task) => !task.done && task.date === tomorrow).sort(compareTasks), [tasks, tomorrow])
  const tomorrowClasses = useMemo(() => classesOn(tomorrow), [classes, tomorrow]) // eslint-disable-line react-hooks/exhaustive-deps
  const addButton = (
    <button type="button" className="link-btn td-link-add" onClick={onAdd} aria-label="Add a task for tomorrow">
      <Icon name="plus" size={17} strokeWidth={2.2} />
      Add
    </button>
  )

  return (
    <Card title="Tomorrow" icon="sunrise" action={addButton}>
      {!loaded ? <Skeleton lines={2} /> : upcoming.length === 0 && tomorrowClasses.length === 0 ? (
        <p className="muted td-quiet">Nothing planned yet</p>
      ) : (
        <ul className="compact-list td-tomorrow">
          {tomorrowClasses.map((item, index) => (
            <li key={`c-${item.id}-${index}`}>
              <Icon name="graduation" size={16} />
              <button type="button" className="compact-link" onClick={() => onOpenClass(item.id)}>{item.name}</button>
              {item.time && <time>{item.time}</time>}
            </li>
          ))}
          {upcoming.slice(0, TOMORROW_SHOWN).map((task) => (
            <li key={task.id}>
              <Icon name={task.priority === 'urgent' ? 'flag' : 'tasks'} size={16} />
              <button type="button" className="compact-link" onClick={() => onOpen(task)}>{task.text}</button>
              {task.time && <time>{formatTime(task.time)}</time>}
            </li>
          ))}
          {upcoming.length > TOMORROW_SHOWN && (
            <li className="td-more-row">
              <a className="td-more" href="#/tasks">+{upcoming.length - TOMORROW_SHOWN} more</a>
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}

// ---- Weather -----------------------------------------------------------------------------------

// One line ("72° Partly cloudy · H 78° L 61°") that opens to the hours, the next days and the
// location controls. Without this device's position it uses the one saved with the account, and
// a blocked location can still pick a city by name.
function WeatherCard({ location, today, onChooseCity }) {
  const { coords, status, locate, stale, source, name } = location
  const { weather, error } = useWeather(coords)
  const locateError = status === 'error'
    ? <p className="muted">Couldn’t get your location. Check that Location Services is on, then try again.</p>
    : null

  if (!coords) {
    return (
      <Card title="Weather" icon="cloudSun">
        {status === 'denied' || status === 'unsupported' ? (
          <div className="journal-prompt">
            <p className="muted">{status === 'denied' ? 'Location is blocked for Daybook. Choose your city instead, or allow location in your browser settings.' : 'This browser can’t share your location. Choose your city instead.'}</p>
            <Button variant="secondary" size="sm" icon="search" onClick={onChooseCity}>Choose a city</Button>
          </div>
        ) : (
          <div className="journal-prompt">
            {locateError || <p>See the forecast and prayer times for where you are.</p>}
            <div className="td-locate-actions">
              <Button variant="secondary" size="sm" icon="pin" loading={status === 'locating'} onClick={locate}>{status === 'error' ? 'Try again' : 'Use my location'}</Button>
              <button type="button" className="link-btn td-hl-link" onClick={onChooseCity}>Choose a city</button>
            </div>
          </div>
        )}
      </Card>
    )
  }

  // A city chosen by hand: its name, and Change. iOS never refreshes the saved position on its own
  // (see useLocation), so offer it when it matters; a blocked location can only pick a city.
  const updateAction = source === 'manual' || status === 'denied' ? (
    <button type="button" className="link-btn td-hl-link" onClick={onChooseCity}>
      <Icon name="pin" size={16} strokeWidth={2.1} />
      {source === 'manual' ? 'Change city' : 'Choose a city'}
    </button>
  ) : source === 'saved' || stale || status === 'error' || status === 'locating' ? (
    <button type="button" className="link-btn td-hl-link" onClick={locate} disabled={status === 'locating'}>
      <Icon name="pin" size={16} strokeWidth={2.1} />
      {status === 'locating' ? 'Locating…' : source === 'saved' ? 'Update' : 'Update location'}
    </button>
  ) : null
  // Where the forecast is for, when it isn't this device's position: "Using your saved location · Update".
  const placeNote = source === 'manual' ? `Weather for ${name || 'your chosen city'}`
    : source === 'saved' ? 'Using your saved location'
      : ''
  const locateNote = locateError || (status === 'denied' && source === 'device'
    ? <p className="muted">Location is blocked for Daybook, so this is for your last saved location.</p>
    : null)

  if (!weather?.current) {
    return <Card title="Weather" icon="cloudSun" action={updateAction}>{locateNote}{error ? <p className="muted">{error}</p> : <Skeleton lines={2} />}</Card>
  }

  const current = weather.current
  const condition = describeWeather(current.weather_code, current.is_day)
  // Day 0 is only today until midnight; a payload fetched yesterday has today at index 1.
  const dayIndex = Math.max(0, weather.daily?.time?.indexOf(today) ?? 0)
  const high = Math.round(weather.daily?.temperature_2m_max?.[dayIndex])
  const low = Math.round(weather.daily?.temperature_2m_min?.[dayIndex])
  const rainChance = weather.daily?.precipitation_probability_max?.[dayIndex]
  const temp = Math.round(current.temperature_2m)
  const feels = Math.round(current.apparent_temperature)
  const hours = upcomingHours(weather, 5)
  const days = dailyForecast(weather, 6, today)
  const showRain = days.some((day) => day.rainChance >= 30)
  const hasRain = rainChance !== undefined && rainChance !== null
  const headlineFacts = [
    Number.isFinite(high) && Number.isFinite(low) ? `H ${high}° · L ${low}°` : '',
    hasRain && rainChance >= 20 ? `Rain ${rainChance}%` : '',
  ].filter(Boolean).join(' · ')

  return (
    <section className="card td-headline td-weather" aria-label="Weather">
      <Disclosure
        id="today-weather"
        label={(
          <>
            <span className="td-hl-icon"><Icon name={condition.icon} size={28} strokeWidth={1.6} /></span>
            <span className="td-hl-text">
              <span className="td-hl-main"><strong>{temp}°</strong> {condition.label}</span>
              {headlineFacts && <span className="td-hl-sub">{headlineFacts}</span>}
            </span>
          </>
        )}
      >
        {locateNote}
        {hours.length > 1 && (
          <ol className="weather-hours td-hours">
            {hours.map((hour) => (
              <li key={hour.key}>
                <span>{hour.label}</span>
                <Icon name={hour.icon} size={20} strokeWidth={1.6} />
                <strong>{hour.temp}°</strong>
              </li>
            ))}
          </ol>
        )}
        {days.length > 1 && (
          <ol className="td-forecast" aria-label="Next days">
            {days.map((day) => (
              <li key={day.date}>
                <span className="td-fc-day" aria-hidden="true">{day.label}</span>
                <Icon name={day.icon} size={20} strokeWidth={1.6} />
                {showRain && <span className="td-fc-rain" aria-hidden="true">{day.rainChance >= 30 ? `${day.rainChance}%` : ''}</span>}
                <span className="td-fc-temps" aria-hidden="true">
                  <strong>{day.high ?? '–'}°</strong>
                  <span>{day.low ?? '–'}°</span>
                </span>
                <span className="sr-only">
                  {[`${day.label}: ${day.condition}`, day.high !== null && `high ${day.high}°`, day.low !== null && `low ${day.low}°`, day.rainChance >= 30 && `${day.rainChance}% chance of rain`].filter(Boolean).join(', ')}
                </span>
              </li>
            ))}
          </ol>
        )}
        {(Number.isFinite(feels) || hasRain || (updateAction && !placeNote)) && (
          <div className="td-weather-foot">
            <dl className="weather-facts td-facts">
              {Number.isFinite(feels) && <div><dt>Feels like</dt><dd>{feels}°</dd></div>}
              {hasRain && <div><dt>Chance of rain</dt><dd>{rainChance}%</dd></div>}
            </dl>
            {!placeNote && updateAction}
          </div>
        )}
        {placeNote && (
          <div className="td-weather-foot td-place">
            <span className="muted">{placeNote}</span>
            {updateAction}
          </div>
        )}
      </Disclosure>
    </section>
  )
}

// ---- Prayer times ------------------------------------------------------------------------------

// '1h 20m', '45m', '2h'
function shortDuration(minutes) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (!hours) return `${mins}m`
  return mins ? `${hours}h ${mins}m` : `${hours}h`
}

// One line ("Next Asr 3:45 PM · in 1h 20m") that opens to the day's times; the choice is remembered.
function PrayerCard({ coords, method, school }) {
  const { timings, error } = usePrayerTimes(coords, { method, school })
  const now = useNow(30000)
  const schedule = prayerSchedule(timings, now)
  // The card used to remember its own "open" flag; hand it to the disclosure once.
  useState(() => {
    if (readPref('prayerExpanded', null) !== true) return null
    writePref('disclosure.today-prayer', true)
    writePref('prayerExpanded', null)
    return null
  })

  if (!coords) return null

  if (!schedule?.next) {
    const message = error || (timings ? 'Prayer times are unavailable right now.' : '')
    return (
      <section className="card td-headline td-prayer" aria-label="Prayer times">
        <div className="td-hl-line">
          <span className="td-hl-icon is-soft"><Icon name="moon" size={18} /></span>
          {message ? <span className="td-hl-text muted">{message}</span> : <span className="skeleton td-prayer-skel" />}
        </div>
      </section>
    )
  }

  const until = schedule.until ?? 0
  return (
    <section className="card td-headline td-prayer" aria-label="Prayer times">
      <Disclosure
        id="today-prayer"
        label={(
          <>
            <span className="td-hl-icon is-soft"><Icon name="moon" size={18} /></span>
            <span className="td-hl-text td-prayer-text">
              <span className="td-prayer-caption">Next </span>
              <strong>{schedule.next.name}</strong>{' '}
              <span className="td-prayer-time">{schedule.next.label}</span>
              <span className="td-prayer-in">{until < 1 ? ' · now' : ` · in ${shortDuration(until)}`}</span>
            </span>
          </>
        )}
      >
        <ol className="prayer-list">
          {schedule.entries.map((entry) => (
            <li key={entry.name} className={`${entry.name === schedule.next.name ? 'is-next' : ''} ${entry.name === 'Sunrise' ? 'is-muted' : ''}`}>
              <span>{entry.name}</span>
              <time>{entry.label}</time>
            </li>
          ))}
        </ol>
        <a className="td-prayer-method" href="#/settings/prayer">
          Calculation method
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </a>
      </Disclosure>
    </section>
  )
}

// ---- People ------------------------------------------------------------------------------------

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'someone'

// One line for what needs attention soon (birthdays within 3 days, catch-ups due); the people
// and the "Talked" buttons open on a tap.
function PeopleCard({ friends, contactLogs, today }) {
  const [talkedTo, setTalkedTo] = useState(null)
  const [sheetKey, setSheetKey] = useState(0)
  const [sheetUsed, setSheetUsed] = useState(false)
  const lastById = useMemo(() => lastContactMap(contactLogs), [contactLogs])
  const people = useMemo(() => friends.map((friend) => ({ friend, status: friendStatus(friend, lastById, today) })), [friends, lastById, today])
  const birthdays = people
    .filter(({ status }) => status.daysToBirthday !== null && status.daysToBirthday <= 3)
    .sort((a, b) => a.status.daysToBirthday - b.status.daysToBirthday)
    .slice(0, 3)
  const due = people
    .filter(({ friend, status }) => status.due && !birthdays.some((item) => item.friend.id === friend.id))
    .sort((a, b) => (b.status.daysSince ?? 9999) - (a.status.daysSince ?? 9999))
  const catchUp = due.slice(0, PEOPLE_SHOWN)

  // The sheet stays mounted after the first use so it can animate closed, even once the person is
  // no longer due and the card has nothing left to show.
  const sheet = sheetUsed && (
    <Suspense fallback={null}>
      <CatchUpSheet key={sheetKey} request={talkedTo} onClose={() => setTalkedTo(null)} />
    </Suspense>
  )
  if (!birthdays.length && !catchUp.length) return sheet || null

  // Asks what you talked about (saved with the catch-up itself); Skip still logs it.
  function markTalked(friend) {
    setSheetUsed(true)
    setSheetKey((key) => key + 1)
    setTalkedTo({ friendId: friend.id, mode: 'today' })
  }

  const birthdayLine = birthdays.length === 1
    ? (() => {
      const { friend, status } = birthdays[0]
      const name = firstName(friend.name)
      return status.daysToBirthday === 0 ? `${name}’s birthday is today 🎉` : status.daysToBirthday === 1 ? `${name}’s birthday is tomorrow` : `${name}’s birthday in ${status.daysToBirthday} days`
    })()
    : birthdays.length > 1 ? `${birthdays.length} birthdays in the next few days` : ''
  const catchUpLine = due.length === 1
    ? `Catch up with ${firstName(due[0].friend.name)}`
    : due.length === 2 ? `Catch up with ${firstName(due[0].friend.name)} and ${firstName(due[1].friend.name)}`
      : due.length > 2 ? `${due.length} people to catch up with` : ''
  const [main, sub] = [birthdayLine, catchUpLine].filter(Boolean)

  return (
    <>
    <section className="card td-headline td-people" aria-label="Your people">
      <Disclosure
        id="today-people"
        label={(
          <>
            <span className="td-hl-icon is-soft"><Icon name="people" size={18} /></span>
            <span className="td-hl-text">
              <span className="td-hl-main">{main}</span>
              {sub && <span className="td-hl-sub">{sub}</span>}
            </span>
          </>
        )}
      >
        <ul className="people-mini">
          {birthdays.map(({ friend, status }) => (
            <li key={`b-${friend.id}`}>
              <Avatar name={friend.name} src={friend.photoUrl} size={36} />
              <span className="people-mini-text">
                <strong>{friend.name}</strong>
                <small>
                  <Icon name="cake" size={13} />
                  {status.daysToBirthday === 0 ? 'Birthday today 🎉' : status.daysToBirthday === 1 ? 'Birthday tomorrow' : `Birthday in ${status.daysToBirthday} days`}
                </small>
              </span>
            </li>
          ))}
          {catchUp.map(({ friend, status }) => (
            <li key={friend.id}>
              <Avatar name={friend.name} src={friend.photoUrl} size={36} />
              <span className="people-mini-text">
                <strong>{friend.name}</strong>
                <small>{status.last ? `Talked ${timeAgo(status.last, today)}` : 'No catch-ups yet'}</small>
              </span>
              <Button variant="secondary" size="sm" onClick={() => markTalked(friend)}>Talked</Button>
            </li>
          ))}
        </ul>
        <a className="td-prayer-method td-people-all" href="#/people">
          All people
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </a>
      </Disclosure>
    </section>
    {sheet}
    </>
  )
}

function truncate(text, length) {
  const value = String(text || '')
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

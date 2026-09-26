import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import Disclosure from '../components/ui/Disclosure.jsx'
import { Avatar, Button, Card, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import ClassSheet from '../components/ClassSheet.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { readPref, writePref } from '../lib/api.js'
import { useData } from '../lib/store.js'
import { classOver, classesOn, compareTasks, createTask, deleteTaskForever, friendStatus, lastContactMap, updateTask } from '../lib/planner.js'
import { addDaysISO, compareTimes, dueSentence, formatDateLong, formatDue, formatTime, greeting, parseQuickAdd, todayISO } from '../lib/dates.js'
import { dailyForecast, describeWeather, prayerSchedule, upcomingHours, useLocation, useNow, usePrayerTimes, useWeather } from '../lib/environment.js'
import CardBoundary, { CardSkeleton } from '../components/CardBoundary.jsx'
import { useAreas } from '../lib/areas.js'
import '../components/today.css'

// The Health glance (gym + food state) loads as its own chunk so the first bundle stays small.
const HealthGlance = lazy(() => import('../components/HealthGlance.jsx'))
// "Talked" asks what you talked about with the People page's own sheet (loaded when first needed).
const CatchUpSheet = lazy(() => import('./PeoplePage.jsx').then((module) => ({ default: module.CatchUpSheet })))

const OVERDUE_SHOWN = 8
const TOMORROW_SHOWN = 5
const PEOPLE_SHOWN = 3
const DONE_LINGER_MS = 1600

// Phones, top to bottom: Today, Tomorrow, Health (one line each for the gym and food; the full
// cards live on Health → Today), Weather, Prayer, People. From 1000px the first three form the
// main column and the rest the side column. Weather, Prayer and People are one line each; their
// details open on a tap (remembered per device). Areas turned off (lib/areas.js) don't appear.
export default function TodayPage({ displayName, loaded }) {
  const tasks = useData('tasks')
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const settings = useData('settings')
  const classes = useData('classes')
  const now = useNow(60000)
  const today = todayISO()
  const tomorrow = addDaysISO(today, 1)
  const location = useLocation()
  const areas = useAreas()
  // null = closed; { task } edits a task; { defaults } adds one.
  const [sheet, setSheet] = useState(null)
  const [classSheet, setClassSheet] = useState(null)

  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const openTask = (task) => setSheet({ task })
  // Class rows carry the class id; the sheet edits the whole class.
  const openClass = (id) => {
    const record = classes.find((item) => item.id === id)
    if (record) setClassSheet(record)
  }

  return (
    <div className="today td-page">
      <header className="page-header td-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        <h1 className="td-greeting">{greeting(now)}, {displayName}</h1>
      </header>

      <div className="today-grid">
        <div className="today-main">
          <TodayCard tasks={active} classes={classes} today={today} now={now} loaded={loaded} onOpen={openTask} onOpenClass={openClass} />
          <TomorrowCard tasks={active} classes={classes} tomorrow={tomorrow} loaded={loaded} onOpen={openTask} onOpenClass={openClass} onAdd={() => setSheet({ defaults: { date: tomorrow } })} />
          {(areas.gym || areas.food) && (
            <CardBoundary>
              <Suspense fallback={<CardSkeleton />}>
                <HealthGlance today={today} areas={areas} loaded={loaded} />
              </Suspense>
            </CardBoundary>
          )}
        </div>

        <div className="today-side">
          <WeatherCard location={location} today={today} />
          {settings?.showPrayerTimes !== false && <PrayerCard coords={location.coords} method={settings?.prayerMethod || 'auto'} school={settings?.prayerSchool || 0} />}
          {loaded && areas.people && <PeopleCard friends={friends} contactLogs={contactLogs} today={today} />}
        </div>
      </div>

      <TaskSheet open={!!sheet} task={sheet?.task || null} defaults={sheet?.defaults || { date: today }} onClose={() => setSheet(null)} />
      <ClassSheet item={classSheet} onClose={() => setClassSheet(null)} />
    </div>
  )
}

// ---- Today -------------------------------------------------------------------------------------

function TodayCard({ tasks, classes, today, now, loaded, onOpen, onOpenClass }) {
  const todayTasks = useMemo(() => tasks.filter((task) => task.date === today), [tasks, today])
  const open = useMemo(() => todayTasks.filter((task) => !task.done), [todayTasks])
  const done = useMemo(() => todayTasks.filter((task) => task.done).sort(compareTasks), [todayTasks])
  const overdue = useMemo(() => tasks.filter((task) => !task.done && task.date && task.date < today).sort(compareTasks), [tasks, today])
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  // A class leaves the list once it's over.
  const todayClasses = useMemo(() => classesOn(today).filter((item) => !classOver(item.time, nowMinutes)), [classes, today, nowMinutes]) // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useRecentlyDone(open, done)

  // Open tasks and classes by time; a task ticked off here stays in place for a moment.
  const timeline = useMemo(() => [
    ...open.map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...done.filter((task) => recent.has(task.id)).map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...todayClasses.map((item, index) => ({ kind: 'class', key: `c-${item.id}-${item.time}-${index}`, time: item.time, item })),
  ].sort((a, b) => compareTimes(a.time, b.time) || (a.task && b.task ? compareTasks(a.task, b.task) : 0)), [open, done, recent, todayClasses])
  const folded = done.filter((task) => !recent.has(task.id))

  function moveAll() {
    const moved = overdue.map((task) => ({ id: task.id, date: task.date }))
    for (const task of overdue) updateTask(task.id, { date: today })
    toast(`Moved ${moved.length} task${moved.length === 1 ? '' : 's'} to today`, {
      action: { label: 'Undo', onClick: () => moved.forEach((item) => updateTask(item.id, { date: item.date })) },
    })
  }

  function moveOne(task) {
    const from = task.date
    updateTask(task.id, { date: today })
    toast(`Moved “${truncate(task.text, 28)}” to today`, { action: { label: 'Undo', onClick: () => updateTask(task.id, { date: from }) } })
  }

  const counts = [open.length ? `${open.length} left` : '', done.length ? `${done.length} done` : ''].filter(Boolean).join(' · ')
  const empty = timeline.length === 0
  // While folded, the overdue line names the first tasks so the fold says what's in it.
  const overdueSummary = overdue.map((task) => task.text).join(', ')

  return (
    <Card title="Today" icon="sun" className="td-today" action={loaded && counts ? <span className="td-count">{counts}</span> : null}>
      {!loaded ? <Skeleton lines={3} /> : (
        <div className="td-today-body">
          {overdue.length > 0 && (
            <Disclosure
              id="today-overdue"
              className="td-section td-fold is-danger"
              label={<><span className="td-row-icon"><Icon name="alert" size={24} strokeWidth={1.9} /></span><span className="td-row-label">{overdue.length} overdue</span></>}
              summary={overdueSummary}
            >
              <ul className="task-list td-sublist">
                {overdue.slice(0, OVERDUE_SHOWN).map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpen={onOpen}
                    trailing={(
                      <button type="button" className="td-chip-today" onClick={() => moveOne(task)} aria-label={`Move “${task.text}” to today`}>
                        Today
                      </button>
                    )}
                  />
                ))}
              </ul>
              <div className="td-fold-actions">
                <button type="button" className="td-row-action" onClick={moveAll}>Move all to today</button>
                {overdue.length > OVERDUE_SHOWN && <a className="td-row-action" href="#/tasks">See all {overdue.length}<Icon name="chevronRight" size={16} strokeWidth={2.2} /></a>}
              </div>
            </Disclosure>
          )}

          {empty ? (
            <p className="td-section td-empty">
              <span className={`td-row-icon ${done.length && !overdue.length ? 'is-success' : 'is-quiet'}`}>
                <Icon name={done.length && !overdue.length ? 'check' : 'sun'} size={15} strokeWidth={2.2} />
              </span>
              {done.length && !overdue.length
                ? 'All done for today.'
                : overdue.length ? 'Nothing else planned for today.' : 'A clear day. Add something below or ask the assistant.'}
            </p>
          ) : (
            <ul className="task-list td-section">
              {timeline.map((entry) => entry.kind === 'task'
                ? <TaskRow key={entry.key} task={entry.task} onOpen={onOpen} showDate={false} />
                : <ClassRow key={entry.key} item={entry.item} onOpen={onOpenClass} />)}
            </ul>
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

// Ids of tasks that went from open to done while this card was showing, kept for DONE_LINGER_MS
// so the tick animates in place (and Undo is still next to it) before the row folds into "N done".
function useRecentlyDone(open, done) {
  const [recent, setRecent] = useState(() => new Set())
  const previous = useRef(null)
  const timers = useRef(new Map())

  useEffect(() => {
    const before = previous.current
    previous.current = new Set(open.map((task) => task.id))
    if (!before) return
    const fresh = done.filter((task) => before.has(task.id) && !timers.current.has(task.id)).map((task) => task.id)
    if (!fresh.length) return
    setRecent((current) => new Set([...current, ...fresh]))
    for (const id of fresh) {
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id)
        setRecent((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, DONE_LINGER_MS))
    }
  }, [open, done])

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  return recent
}

// Adds to today, unless a day or time is typed at the start or end ("Call mom tomorrow 5pm", the
// same parser as the Tasks page): that shows as a chip, and tapping the chip keeps the words in
// the title instead.
function AddRow({ today }) {
  const [text, setText] = useState('')
  const [ignored, setIgnored] = useState('') // the parse the user dismissed, by its words
  const input = useRef(null)
  const parsed = useMemo(() => parseQuickAdd(text, new Date()), [text])
  const parseKey = parsed.matched.map((span) => span.text.toLowerCase()).join('|')
  const understood = parsed.matched.length > 0 && parseKey !== ignored ? parsed : null
  const understoodLabel = understood ? formatDue(understood.date, understood.time, today) : ''

  function submit(event) {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    const task = createTask(understood ? { text: understood.title, date: understood.date, time: understood.time } : { text: value, date: today })
    setText('')
    setIgnored('')
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
          <button
            type="button"
            className="chip chip-sm is-active tk-parsed"
            onClick={() => setIgnored(parseKey)}
            aria-label={`Due ${understoodLabel.replace(' · ', ' at ')}. Tap to keep those words in the title instead.`}
          >
            <Icon name="calendar" size={14} strokeWidth={2.1} />
            <span>{understoodLabel}</span>
            <Icon name="close" size={13} strokeWidth={2.4} className="tk-parsed-x" />
          </button>
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
        <p className="muted td-quiet">Nothing planned yet.</p>
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
// location controls.
function WeatherCard({ location, today }) {
  const { coords, status, locate, stale } = location
  const { weather, error } = useWeather(coords)
  const locateError = status === 'error'
    ? <p className="muted">Couldn’t get your location. Check that Location Services is on, then try again.</p>
    : null

  if (!coords) {
    return (
      <Card title="Weather" icon="cloudSun">
        {status === 'denied' ? (
          <p className="muted">Location is blocked for Daybook. Allow it in your browser settings to see local weather and prayer times.</p>
        ) : status === 'unsupported' ? (
          <p className="muted">This browser can’t share your location.</p>
        ) : (
          <div className="journal-prompt">
            {locateError || <p>See the forecast and prayer times for where you are.</p>}
            <Button variant="secondary" size="sm" icon="pin" loading={status === 'locating'} onClick={locate}>{status === 'error' ? 'Try again' : 'Use my location'}</Button>
          </div>
        )}
      </Card>
    )
  }

  // iOS never refreshes the saved position on its own (see useLocation), so offer it when it matters.
  const updateAction = stale || status === 'error' || status === 'denied' || status === 'locating' ? (
    <button type="button" className="link-btn td-hl-link" onClick={locate} disabled={status === 'locating'}>
      <Icon name="pin" size={16} strokeWidth={2.1} />
      {status === 'locating' ? 'Locating…' : 'Update location'}
    </button>
  ) : null
  const locateNote = locateError || (status === 'denied'
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
        {(Number.isFinite(feels) || hasRain || updateAction) && (
          <div className="td-weather-foot">
            <dl className="weather-facts td-facts">
              {Number.isFinite(feels) && <div><dt>Feels like</dt><dd>{feels}°</dd></div>}
              {hasRain && <div><dt>Chance of rain</dt><dd>{rainChance}%</dd></div>}
            </dl>
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
                <small>{status.last ? `Last talked ${status.daysSince} days ago` : 'No catch-up logged yet'}</small>
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

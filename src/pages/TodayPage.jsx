import { Component, Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { Avatar, Button, Card, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import GymWidget from '../components/GymWidget.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { readPref, writePref } from '../lib/api.js'
import { useData } from '../lib/store.js'
import { classesOn, compareTasks, createTask, friendStatus, lastContactMap, logContact, updateTask } from '../lib/planner.js'
import { addDaysISO, compareTimes, formatDateLong, formatTime, greeting, todayISO } from '../lib/dates.js'
import { dailyForecast, describeWeather, prayerSchedule, upcomingHours, useLocation, useNow, usePrayerTimes, useWeather } from '../lib/environment.js'
import { useActiveWorkout } from '../lib/gym/state.js'
import '../components/today.css'

// The food card (AI estimate, review, recorder) loads as its own chunk so the first bundle stays small.
const FoodQuickCard = lazy(() => import('../components/FoodQuickCard.jsx'))

const OVERDUE_SHOWN = 8
const TOMORROW_SHOWN = 5
const DONE_LINGER_MS = 1600

// Phones, top to bottom: [running workout], Today, Tomorrow, Gym, Food, Weather, Prayer, People.
// From 1000px the first four form the main column and the rest the side column.
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
  const workout = useActiveWorkout()
  // null = closed; { task } edits a task; { defaults } adds one.
  const [sheet, setSheet] = useState(null)

  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const openTask = (task) => setSheet({ task })

  return (
    <div className="today td-page">
      <header className="page-header td-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        <h1 className="td-greeting">{greeting(now)}, {displayName}</h1>
      </header>

      <div className="today-grid">
        <div className="today-main">
          {workout && <GymWidget today={today} loaded={loaded} />}
          <TodayCard tasks={active} classes={classes} today={today} loaded={loaded} onOpen={openTask} />
          <TomorrowCard tasks={active} classes={classes} tomorrow={tomorrow} loaded={loaded} onOpen={openTask} onAdd={() => setSheet({ defaults: { date: tomorrow } })} />
          {!workout && <GymWidget today={today} loaded={loaded} />}
          <CardBoundary>
            <Suspense fallback={<FoodSkeleton />}>
              <FoodQuickCard today={today} loaded={loaded} />
            </Suspense>
          </CardBoundary>
        </div>

        <div className="today-side">
          <WeatherCard location={location} today={today} />
          {settings?.showPrayerTimes !== false && <PrayerCard coords={location.coords} method={settings?.prayerMethod || 'auto'} school={settings?.prayerSchool || 0} />}
          {loaded && <PeopleCard friends={friends} contactLogs={contactLogs} today={today} />}
        </div>
      </div>

      <TaskSheet open={!!sheet} task={sheet?.task || null} defaults={sheet?.defaults || { date: today }} onClose={() => setSheet(null)} />
    </div>
  )
}

// ---- Today -------------------------------------------------------------------------------------

function TodayCard({ tasks, classes, today, loaded, onOpen }) {
  const [showOverdue, setShowOverdue] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const todayTasks = useMemo(() => tasks.filter((task) => task.date === today), [tasks, today])
  const open = useMemo(() => todayTasks.filter((task) => !task.done), [todayTasks])
  const done = useMemo(() => todayTasks.filter((task) => task.done).sort(compareTasks), [todayTasks])
  const overdue = useMemo(() => tasks.filter((task) => !task.done && task.date && task.date < today).sort(compareTasks), [tasks, today])
  const todayClasses = useMemo(() => classesOn(today), [classes, today]) // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useRecentlyDone(open, done)

  // Open tasks and classes by time; a task ticked off here stays in place for a moment.
  const timeline = useMemo(() => [
    ...open.map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...done.filter((task) => recent.has(task.id)).map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...todayClasses.map((item, index) => ({ kind: 'class', key: `c-${item.id}-${item.time}-${index}`, time: item.time, item })),
  ].sort((a, b) => compareTimes(a.time, b.time) || (a.task && b.task ? compareTasks(a.task, b.task) : 0)), [open, done, recent, todayClasses])
  const folded = done.filter((task) => !recent.has(task.id))

  useEffect(() => {
    if (!overdue.length) setShowOverdue(false)
  }, [overdue.length])

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

  return (
    <Card title="Today" icon="sun" className="td-today" action={loaded && counts ? <span className="td-count">{counts}</span> : null}>
      {!loaded ? <Skeleton lines={3} /> : (
        <div className="td-today-body">
          {overdue.length > 0 && (
            <div className="td-section">
              <div className="td-row">
                <button type="button" className="td-toggle is-danger" aria-expanded={showOverdue} onClick={() => setShowOverdue((value) => !value)}>
                  <span className="td-row-icon"><Icon name="alert" size={24} strokeWidth={1.9} /></span>
                  <span className="td-row-label">{overdue.length} overdue</span>
                  <Icon name="chevronDown" size={16} strokeWidth={2.2} className="td-chevron" />
                </button>
                <button type="button" className="td-row-action" onClick={moveAll}>Move all to today</button>
              </div>
              {showOverdue && (
                <>
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
                  {overdue.length > OVERDUE_SHOWN && <a className="td-row-link" href="#/tasks">See all {overdue.length} overdue</a>}
                </>
              )}
            </div>
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
                : <ClassRow key={entry.key} item={entry.item} />)}
            </ul>
          )}

          {folded.length > 0 && (
            <div className="td-section">
              <button type="button" className="td-toggle is-done" aria-expanded={showDone} onClick={() => setShowDone((value) => !value)}>
                <span className="td-row-icon"><Icon name="check" size={14} strokeWidth={2.6} /></span>
                <span className="td-row-label">{folded.length} done</span>
                <Icon name="chevronDown" size={16} strokeWidth={2.2} className="td-chevron" />
              </button>
              {showDone && (
                <ul className="task-list td-sublist">
                  {folded.map((task) => <TaskRow key={task.id} task={task} onOpen={onOpen} showDate={false} />)}
                </ul>
              )}
            </div>
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

function AddRow({ today }) {
  const [text, setText] = useState('')
  const input = useRef(null)

  function submit(event) {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    createTask({ text: value, date: today })
    setText('')
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
        placeholder="Add to today"
        aria-label="Add a task for today"
        enterKeyHint="done"
        autoComplete="off"
      />
      {text.trim() && <button type="submit" className="btn btn-primary btn-sm td-add-btn">Add</button>}
    </form>
  )
}

function ClassRow({ item }) {
  return (
    <li className="task-row class-row">
      <span className="class-dot" aria-hidden="true"><Icon name="graduation" size={15} /></span>
      <div className="task-body is-static">
        <span className="task-title">{item.name}</span>
        <span className="task-meta">
          {item.time && <span className="meta-chip"><Icon name="clock" size={13} />{item.time}</span>}
          {item.room && <span className="meta-chip"><Icon name="pin" size={13} />{item.room}</span>}
        </span>
      </div>
    </li>
  )
}

// ---- Tomorrow ----------------------------------------------------------------------------------

function TomorrowCard({ tasks, classes, tomorrow, loaded, onOpen, onAdd }) {
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
            <li key={`c-${item.id}-${index}`}><Icon name="graduation" size={16} /><span className="compact-link">{item.name}</span>{item.time && <time>{item.time}</time>}</li>
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

// ---- Food --------------------------------------------------------------------------------------

function FoodSkeleton() {
  return (
    <section className="card td-food-skel" aria-hidden="true">
      <span className="skeleton td-skel-title" />
      <span className="skeleton td-skel-pill" />
    </section>
  )
}

// A card that fails (or whose chunk can't load offline) disappears instead of taking Today with it.
class CardBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('Today card crashed:', error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

// ---- Weather -----------------------------------------------------------------------------------

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
    <button type="button" className="link-btn" onClick={locate} disabled={status === 'locating'}>
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

  return (
    <Card title="Weather" icon={condition.icon} className="weather-card" action={updateAction}>
      {locateNote}
      <div className="weather-now">
        <span className="weather-icon"><Icon name={condition.icon} size={40} strokeWidth={1.5} /></span>
        <div>
          <div className="weather-temp">{temp}°</div>
          <div className="weather-label">{condition.label}</div>
        </div>
        <dl className="weather-facts">
          {Number.isFinite(high) && Number.isFinite(low) && <div><dt>High / low</dt><dd>{high}° / {low}°</dd></div>}
          {Number.isFinite(feels) && Math.abs(feels - temp) > 2 && <div><dt>Feels like</dt><dd>{feels}°</dd></div>}
          {rainChance !== undefined && rainChance !== null && <div><dt>Rain</dt><dd>{rainChance}%</dd></div>}
        </dl>
      </div>
      {hours.length > 1 && (
        <ol className="weather-hours">
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
    </Card>
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

// One line ("Next Asr 3:45 PM · in 1h 20m") that expands to the day's times; the choice is remembered.
function PrayerCard({ coords, method, school }) {
  const { timings, error } = usePrayerTimes(coords, { method, school })
  const now = useNow(30000)
  const schedule = prayerSchedule(timings, now)
  const [open, setOpen] = useState(() => readPref('prayerExpanded', false) === true)
  const listId = useId()

  if (!coords) return null

  function toggle() {
    const next = !open
    setOpen(next)
    writePref('prayerExpanded', next)
  }

  if (!schedule?.next) {
    const message = error || (timings ? 'Prayer times are unavailable right now.' : '')
    return (
      <section className="card td-prayer" aria-label="Prayer times">
        <div className="td-prayer-line">
          <span className="td-prayer-icon"><Icon name="moon" size={18} /></span>
          {message ? <span className="td-prayer-text muted">{message}</span> : <span className="skeleton td-prayer-skel" />}
        </div>
      </section>
    )
  }

  const until = schedule.until ?? 0
  return (
    <section className={`card td-prayer${open ? ' is-open' : ''}`} aria-label="Prayer times">
      <button type="button" className="td-prayer-line td-prayer-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={toggle}>
        <span className="td-prayer-icon"><Icon name="moon" size={18} /></span>
        <span className="td-prayer-text">
          <span className="td-prayer-caption">Next </span>
          <strong>{schedule.next.name}</strong>{' '}
          <span className="td-prayer-time">{schedule.next.label}</span>
          <span className="td-prayer-in">{until < 1 ? ' · now' : ` · in ${shortDuration(until)}`}</span>
        </span>
        <Icon name="chevronDown" size={18} strokeWidth={2.2} className="td-chevron" />
      </button>
      {open && (
        <div id={listId} className="td-prayer-more">
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
        </div>
      )}
    </section>
  )
}

// ---- People ------------------------------------------------------------------------------------

// Only what needs attention soon: birthdays within 3 days and the 2 most overdue catch-ups.
function PeopleCard({ friends, contactLogs, today }) {
  const lastById = useMemo(() => lastContactMap(contactLogs), [contactLogs])
  const people = useMemo(() => friends.map((friend) => ({ friend, status: friendStatus(friend, lastById, today) })), [friends, lastById, today])
  const birthdays = people
    .filter(({ status }) => status.daysToBirthday !== null && status.daysToBirthday <= 3)
    .sort((a, b) => a.status.daysToBirthday - b.status.daysToBirthday)
    .slice(0, 3)
  const catchUp = people
    .filter(({ friend, status }) => status.due && !birthdays.some((item) => item.friend.id === friend.id))
    .sort((a, b) => (b.status.daysSince ?? 9999) - (a.status.daysSince ?? 9999))
    .slice(0, 2)

  if (!birthdays.length && !catchUp.length) return null

  function markTalked(friend) {
    const undo = logContact(friend.id)
    toast(`Logged a catch-up with ${friend.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <Card title="Your people" icon="people" action={<a className="link-btn" href="#/people">All people</a>}>
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
    </Card>
  )
}

function truncate(text, length) {
  const value = String(text || '')
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

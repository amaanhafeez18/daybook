import { useMemo, useState } from 'react'
import Icon from '../components/ui/Icon.jsx'
import { Avatar, Button, Card, EmptyState, Skeleton } from '../components/ui/primitives.jsx'
import { toast } from '../components/ui/feedback.jsx'
import GymWidget from '../components/GymWidget.jsx'
import TaskRow from '../components/TaskRow.jsx'
import TaskSheet from '../components/TaskSheet.jsx'
import { useData } from '../lib/store.js'
import { classesOn, compareTasks, createTask, friendStatus, lastContactMap, logContact, moodEmoji, updateTask } from '../lib/planner.js'
import { addDaysISO, compareTimes, formatDateLong, formatDuration, formatTime, greeting, relativeDay, todayISO } from '../lib/dates.js'
import { describeWeather, prayerSchedule, upcomingHours, useLocation, useNow, usePrayerTimes, useWeather } from '../lib/environment.js'
import { navigate } from '../lib/router.js'

export default function TodayPage({ displayName, loaded }) {
  const tasks = useData('tasks')
  const friends = useData('friends')
  const contactLogs = useData('contactLogs')
  const journalEntries = useData('journalEntries')
  const settings = useData('settings')
  useData('classes') // re-render when classes change
  const now = useNow(60000)
  const today = todayISO()
  const tomorrow = addDaysISO(today, 1)
  const [editing, setEditing] = useState(null)
  const [quickText, setQuickText] = useState('')
  const location = useLocation()

  const active = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const todayTasks = useMemo(() => active.filter((task) => task.date === today).sort((a, b) => Number(a.done) - Number(b.done) || compareTasks(a, b)), [active, today])
  const overdue = useMemo(() => active.filter((task) => !task.done && task.date && task.date < today).sort(compareTasks), [active, today])
  const tomorrowTasks = useMemo(() => active.filter((task) => !task.done && task.date === tomorrow).sort(compareTasks), [active, tomorrow])
  const todayClasses = classesOn(today)
  const tomorrowClasses = classesOn(tomorrow)
  const openToday = todayTasks.filter((task) => !task.done).length
  const doneToday = todayTasks.length - openToday

  const lastById = useMemo(() => lastContactMap(contactLogs), [contactLogs])
  const people = useMemo(() => friends.map((friend) => ({ friend, status: friendStatus(friend, lastById, today) })), [friends, lastById, today])
  const dueFriends = people.filter(({ status }) => status.due).sort((a, b) => (b.status.daysSince ?? 9999) - (a.status.daysSince ?? 9999))
  const catchUp = dueFriends.slice(0, 4)
  const birthdays = people.filter(({ status }) => status.daysToBirthday !== null && status.daysToBirthday <= 14).sort((a, b) => a.status.daysToBirthday - b.status.daysToBirthday).slice(0, 3)
  const journalToday = journalEntries.find((entry) => entry.date === today)

  const timeline = useMemo(() => [
    ...todayTasks.map((task) => ({ kind: 'task', key: `t-${task.id}`, time: task.time, task })),
    ...todayClasses.map((item, index) => ({ kind: 'class', key: `c-${item.id}-${item.time}-${index}`, time: item.time, item })),
  ].sort((a, b) => Number(a.task?.done || 0) - Number(b.task?.done || 0) || compareTimes(a.time, b.time)), [todayTasks, todayClasses])

  function quickAdd(event) {
    event.preventDefault()
    const text = quickText.trim()
    if (!text) return
    createTask({ text, date: today })
    setQuickText('')
    toast('Added to today')
  }

  function moveOverdueToToday() {
    const moved = overdue.map((task) => ({ id: task.id, date: task.date }))
    for (const task of overdue) updateTask(task.id, { date: today })
    toast(`Moved ${moved.length} task${moved.length === 1 ? '' : 's'} to today`, {
      action: { label: 'Undo', onClick: () => moved.forEach((item) => updateTask(item.id, { date: item.date })) },
    })
  }

  function markTalked(friend) {
    const undo = logContact(friend.id)
    toast(`Logged a catch-up with ${friend.name}`, { action: { label: 'Undo', onClick: undo } })
  }

  return (
    <div className="today">
      <header className="page-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        <h1>{greeting(now)}, {displayName}</h1>
        <div className="stat-row" role="list">
          <Stat icon="tasks" value={openToday} label={openToday === 1 ? 'task left today' : 'tasks left today'} tone={openToday ? 'accent' : ''} />
          {overdue.length > 0 && <Stat icon="alert" value={overdue.length} label="overdue" tone="danger" />}
          {doneToday > 0 && <Stat icon="check" value={doneToday} label="done" tone="success" />}
          {dueFriends.length > 0 && <Stat icon="people" value={dueFriends.length} label="to catch up with" />}
        </div>
      </header>

      <form className="quick-add" onSubmit={quickAdd}>
        <Icon name="plus" size={20} />
        <input
          className="quick-add-input"
          value={quickText}
          onChange={(event) => setQuickText(event.target.value)}
          placeholder="Add something for today…"
          aria-label="Add a task for today"
          enterKeyHint="done"
        />
        {quickText.trim() && <button type="submit" className="btn btn-primary btn-sm">Add</button>}
      </form>

      <div className="today-grid">
        <div className="today-main">
          <GymWidget today={today} loaded={loaded} />

          <Card title="Today" icon="sun" action={<button type="button" className="link-btn" onClick={() => setEditing({})}>New task</button>}>
            {!loaded ? <Skeleton lines={3} /> : timeline.length === 0 ? (
              <EmptyState icon="sun" title="A clear day">
                Nothing scheduled. Add a task above or ask the assistant to plan your day.
              </EmptyState>
            ) : (
              <ul className="task-list">
                {timeline.map((entry) => entry.kind === 'task'
                  ? <TaskRow key={entry.key} task={entry.task} onOpen={setEditing} showDate={false} />
                  : <ClassRow key={entry.key} item={entry.item} />)}
              </ul>
            )}
          </Card>

          {overdue.length > 0 && (
            <Card title="Overdue" icon="alert" tone="danger" action={<button type="button" className="link-btn" onClick={moveOverdueToToday}>Move all to today</button>}>
              <ul className="task-list">
                {overdue.slice(0, 6).map((task) => <TaskRow key={task.id} task={task} onOpen={setEditing} />)}
              </ul>
              {overdue.length > 6 && <a className="card-more" href="#/tasks">See all {overdue.length} overdue tasks</a>}
            </Card>
          )}

          <Card title="Tomorrow" icon="sunrise">
            {tomorrowTasks.length === 0 && tomorrowClasses.length === 0 ? (
              <p className="muted">Nothing planned yet.</p>
            ) : (
              <ul className="compact-list">
                {tomorrowClasses.map((item, index) => (
                  <li key={`c-${item.id}-${index}`}><Icon name="graduation" size={16} /><span>{item.name}</span><time>{item.time}</time></li>
                ))}
                {tomorrowTasks.slice(0, 5).map((task) => (
                  <li key={task.id}>
                    <Icon name={task.priority === 'urgent' ? 'flag' : 'tasks'} size={16} />
                    <button type="button" className="compact-link" onClick={() => setEditing(task)}>{task.text}</button>
                    {task.time && <time>{formatTime(task.time)}</time>}
                  </li>
                ))}
                {tomorrowTasks.length > 5 && <li className="muted">+{tomorrowTasks.length - 5} more</li>}
              </ul>
            )}
          </Card>
        </div>

        <div className="today-side">
          <WeatherCard location={location} />
          {settings?.showPrayerTimes !== false && <PrayerCard coords={location.coords} method={settings?.prayerMethod || 'auto'} school={settings?.prayerSchool || 0} />}

          {(catchUp.length > 0 || birthdays.length > 0) && (
            <Card title="Your people" icon="people" action={<a className="link-btn" href="#/people">All people</a>}>
              <ul className="people-mini">
                {birthdays.map(({ friend, status }) => (
                  <li key={`b-${friend.id}`}>
                    <Avatar name={friend.name} src={friend.photoUrl} size={36} />
                    <span className="people-mini-text">
                      <strong>{friend.name}</strong>
                      <small><Icon name="cake" size={13} /> Birthday {status.daysToBirthday === 0 ? 'today 🎉' : relativeDay(status.nextBirthday, today).toLowerCase() === 'tomorrow' ? 'tomorrow' : `in ${status.daysToBirthday} days`}</small>
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
          )}

          <Card title="Journal" icon="journal">
            {journalToday ? (
              <button type="button" className="journal-teaser" onClick={() => navigate('journal')}>
                <span className="journal-teaser-mood" aria-hidden="true">{moodEmoji(journalToday.mood) || '📝'}</span>
                <span>
                  <strong>{journalToday.title || 'Today’s entry'}</strong>
                  <small>{journalToday.body ? journalToday.body.slice(0, 120) : 'Keep writing…'}</small>
                </span>
                <Icon name="chevronRight" size={18} />
              </button>
            ) : (
              <div className="journal-prompt">
                <p>How was your day? A few lines now is a gift to future you.</p>
                <Button variant="secondary" size="sm" icon="pencil" onClick={() => navigate('journal')}>Write today’s entry</Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <TaskSheet open={!!editing} task={editing?.id ? editing : null} defaults={{ date: today }} onClose={() => setEditing(null)} />
    </div>
  )
}

function Stat({ icon, value, label, tone = '' }) {
  return (
    <span className={`stat ${tone ? `stat-${tone}` : ''}`} role="listitem">
      <Icon name={icon} size={16} />
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
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

function WeatherCard({ location }) {
  const { coords, status, locate } = location
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

  // iOS never refreshes the saved position on its own (see useLocation), so offer it here.
  const updateAction = (
    <button type="button" className="link-btn" onClick={locate} disabled={status === 'locating'}>
      {status === 'locating' ? 'Locating…' : 'Update location'}
    </button>
  )
  const locateNote = locateError || (status === 'denied'
    ? <p className="muted">Location is blocked for Daybook, so this is for your last saved location.</p>
    : null)

  if (!weather) {
    return <Card title="Weather" icon="cloudSun" action={updateAction}>{locateNote}{error ? <p className="muted">{error}</p> : <Skeleton lines={2} />}</Card>
  }

  const current = weather.current
  const condition = describeWeather(current.weather_code, current.is_day)
  // Day 0 is only today until midnight; a payload fetched yesterday has today at index 1.
  const dayIndex = Math.max(0, weather.daily?.time?.indexOf(todayISO()) ?? 0)
  const high = Math.round(weather.daily?.temperature_2m_max?.[dayIndex])
  const low = Math.round(weather.daily?.temperature_2m_min?.[dayIndex])
  const rainChance = weather.daily?.precipitation_probability_max?.[dayIndex]
  const hours = upcomingHours(weather, 5)

  return (
    <Card title="Weather" icon={condition.icon} className="weather-card" action={updateAction}>
      {locateNote}
      <div className="weather-now">
        <span className="weather-icon"><Icon name={condition.icon} size={40} strokeWidth={1.5} /></span>
        <div>
          <div className="weather-temp">{Math.round(current.temperature_2m)}°</div>
          <div className="weather-label">{condition.label}</div>
        </div>
        <dl className="weather-facts">
          <div><dt>High / low</dt><dd>{high}° / {low}°</dd></div>
          <div><dt>Feels like</dt><dd>{Math.round(current.apparent_temperature)}°</dd></div>
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
    </Card>
  )
}

function PrayerCard({ coords, method, school }) {
  const { timings, error } = usePrayerTimes(coords, { method, school })
  const now = useNow(30000)
  const schedule = prayerSchedule(timings, now)

  if (!coords) return null
  return (
    <Card title="Prayer times" icon="moon" action={<a className="link-btn" href="#/settings">Method</a>}>
      {!schedule ? (error ? <p className="muted">{error}</p> : <Skeleton lines={2} />) : (
        <>
          <div className="prayer-next">
            <span>Next</span>
            <strong>{schedule.next.name}</strong>
            <span className="prayer-countdown">{schedule.next.label} · in {formatDuration(schedule.until)}</span>
          </div>
          <ol className="prayer-list">
            {schedule.entries.map((entry) => (
              <li key={entry.name} className={`${entry.name === schedule.next.name ? 'is-next' : ''} ${entry.name === 'Sunrise' ? 'is-muted' : ''}`}>
                <span>{entry.name}</span>
                <time>{entry.label}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  )
}

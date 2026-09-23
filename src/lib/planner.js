import { getState, newId, updateData } from './store.js'
import { readPref, writePref } from './api.js'
import { WEEKDAY_SHORT, compareTimes, diffDays, isISODate, nextBirthday, todayISO, weekdayIndex } from './dates.js'

const nowIso = () => new Date().toISOString()
const data = () => getState().data

// ---- tasks & calendar ----------------------------------------------------------------------
// A dated task shows on the calendar through a linked event (event.taskId); calendar events
// created directly also get a linked task. These helpers keep the pair in step.

export function createTask({ text, details = '', date = '', time = '', priority = 'medium', reminderMinutes = null }) {
  const task = {
    id: newId(),
    text: text.trim(),
    details: details.trim(),
    date,
    time: date ? time : '',
    priority,
    done: false,
    archived: false,
    calendarEventId: date ? newId() : null,
    createdAt: nowIso(),
    ...(Number.isInteger(reminderMinutes) ? { reminderMinutes } : {}),
  }
  updateData('tasks', (list) => [task, ...list])
  syncTaskEvent(task)
  return task
}

export function updateTask(id, patch) {
  let updated = null
  updateData('tasks', (list) => list.map((task) => {
    if (task.id !== id) return task
    updated = { ...task, ...patch }
    if (!updated.date) updated.time = ''
    return updated
  }))
  if (updated) syncTaskEvent(updated)
  return updated
}

function syncTaskEvent(task) {
  const linked = data().events.filter((event) => event.taskId === task.id)
  if (task.done || task.archived || !task.date) {
    if (linked.length) updateData('events', (list) => list.filter((event) => event.taskId !== task.id))
    return
  }
  if (linked.length) {
    const needsUpdate = linked.some((event) => event.title !== task.text || event.date !== task.date || (event.time || '') !== (task.time || ''))
    if (needsUpdate) {
      updateData('events', (list) => list.map((event) => (event.taskId === task.id ? { ...event, title: task.text, date: task.date, time: task.time || '' } : event)))
    }
    return
  }
  const event = { id: task.calendarEventId || newId(), taskId: task.id, title: task.text, date: task.date, time: task.time || '', createdAt: nowIso() }
  updateData('events', (list) => [event, ...list.filter((item) => item.id !== event.id)])
}

// A friend-reminder task's catch-up log uses a fixed id, so undoing the completion removes it.
const catchUpLogId = (taskId) => `catch-up-${taskId}`
const reminderFriendId = (task) => (isReminderMarker(task?.details) ? task.details.split(':')[1] || null : null)

// Completing a "Talk to …" reminder also logs the catch-up, so the reminder doesn't come back tomorrow.
export function setTaskDone(id, done) {
  const before = data().tasks.find((task) => task.id === id)
  const updated = updateTask(id, { done })
  const friendId = reminderFriendId(before)
  if (!updated || !friendId || !!before.done === !!done) return updated
  const logId = catchUpLogId(id)
  if (done) {
    const today = todayISO()
    const known = data().friends.some((friend) => friend.id === friendId)
    const loggedToday = data().contactLogs.some((log) => (log.friendId || log.friend_id) === friendId && log.date === today)
    if (known && !loggedToday) updateData('contactLogs', (list) => [{ id: logId, friendId, date: today, createdAt: nowIso() }, ...list.filter((log) => log.id !== logId)])
  } else {
    // Unticking takes back the log the tick added, unless a note has been written on it since:
    // then the catch-up really happened, and removing it would lose the note.
    const log = data().contactLogs.find((item) => item.id === logId)
    if (log && !cleanNote(log.note)) updateData('contactLogs', (list) => list.filter((item) => item.id !== logId))
  }
  return updated
}

export const archiveTask = (id) => updateTask(id, { archived: true })
export const restoreTask = (id) => updateTask(id, { archived: false })

export function deleteTaskForever(id) {
  updateData('tasks', (list) => list.filter((task) => task.id !== id))
  updateData('events', (list) => list.filter((event) => event.taskId !== id))
}

// onlyIds limits it to the tasks shown (e.g. search results).
export function archiveCompletedTasks(onlyIds = null) {
  const ids = data().tasks.filter((task) => task.done && !task.archived && (!onlyIds || onlyIds.includes(task.id))).map((task) => task.id)
  if (ids.length) updateData('tasks', (list) => list.map((task) => (ids.includes(task.id) ? { ...task, archived: true } : task)))
  return ids
}

export function unarchiveTasks(ids) {
  updateData('tasks', (list) => list.map((task) => (ids.includes(task.id) ? { ...task, archived: false } : task)))
}

export function createEvent({ title, date, time = '' }) {
  const task = createTask({ text: title, date, time })
  return data().events.find((event) => event.taskId === task.id) || null
}

export function updateEvent(id, patch) {
  const event = data().events.find((item) => item.id === id)
  if (!event) return
  if (event.taskId && data().tasks.some((task) => task.id === event.taskId)) {
    updateTask(event.taskId, {
      ...(patch.title !== undefined ? { text: patch.title } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.time !== undefined ? { time: patch.time } : {}),
    })
    return
  }
  updateData('events', (list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
}

// Removing an event archives its task (restorable from Settings). Returns an undo function.
export function deleteEvent(id) {
  const event = data().events.find((item) => item.id === id)
  if (!event) return () => {}
  updateData('events', (list) => list.filter((item) => item.id !== id))
  const task = event.taskId ? data().tasks.find((item) => item.id === event.taskId) : null
  if (task && !task.archived) updateData('tasks', (list) => list.map((item) => (item.id === task.id ? { ...item, archived: true } : item)))
  return () => {
    if (task && !task.archived) updateData('tasks', (list) => list.map((item) => (item.id === task.id ? { ...item, archived: false } : item)))
    updateData('events', (list) => (list.some((item) => item.id === event.id) ? list : [event, ...list]))
  }
}

export function openTasks() {
  return data().tasks.filter((task) => !task.archived && !task.done)
}

export function compareTasks(a, b) {
  if (!!a.date !== !!b.date) return a.date ? -1 : 1
  const byDate = (a.date || '').localeCompare(b.date || '')
  if (byDate) return byDate
  const byTime = compareTimes(a.time, b.time)
  if (byTime) return byTime
  const order = { urgent: 0, medium: 1, low: 2 }
  return (order[a.priority] ?? 1) - (order[b.priority] ?? 1)
}

// Friend reminders store an internal marker in `details`.
export function isReminderMarker(details) {
  return typeof details === 'string' && details.startsWith('friend-reminder:')
}

// ---- classes ---------------------------------------------------------------------------------

// Classes store days either as ["Mon", ...] with dayDetails, or as [{ day, time, room }].
export function classSchedule(item) {
  return (item.days || []).map((entry) => {
    if (typeof entry === 'string') {
      const details = item.dayDetails?.[entry] || {}
      return { day: entry, time: details.time || item.time || '', room: details.room || item.room || '' }
    }
    return { day: entry?.day || '', time: entry?.time || '', room: entry?.room || '' }
  }).filter((entry) => WEEKDAY_SHORT.includes(entry.day))
}

export function classesOn(iso) {
  const day = WEEKDAY_SHORT[weekdayIndex(iso)]
  return data().classes
    .filter((item) => !item.endDate || iso <= item.endDate)
    .flatMap((item) => classSchedule(item).filter((entry) => entry.day === day).map((entry) => ({ ...entry, id: item.id, name: item.name })))
    .sort((a, b) => compareTimes(a.time, b.time))
}

export function saveClass(item) {
  const record = { ...item, id: item.id || newId(), createdAt: item.createdAt || nowIso() }
  updateData('classes', (list) => (list.some((entry) => entry.id === record.id) ? list.map((entry) => (entry.id === record.id ? record : entry)) : [...list, record]))
  return record
}

export function deleteClass(id) {
  const item = data().classes.find((entry) => entry.id === id)
  updateData('classes', (list) => list.filter((entry) => entry.id !== id))
  return () => item && updateData('classes', (list) => [...list, item])
}

// ---- people ----------------------------------------------------------------------------------

export const RELATIONSHIPS = [
  { id: 'close_friend', label: 'Close friend', reminderDays: 10 },
  { id: 'friend', label: 'Friend', reminderDays: 30 },
  { id: 'acquaintance', label: 'Acquaintance', reminderDays: null },
]

export function relationshipLabel(id) {
  return RELATIONSHIPS.find((item) => item.id === id)?.label || 'Friend'
}

export function reminderInterval(friend) {
  if (friend.reminderDays !== undefined && friend.reminderDays !== null) return friend.reminderDays
  return RELATIONSHIPS.find((item) => item.id === friend.relationship)?.reminderDays ?? null
}

export function contactLogsFor(friendId) {
  return data().contactLogs
    .filter((log) => (log.friendId || log.friend_id) === friendId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

// Last contact, how long ago, and whether a catch-up is due based on the relationship.
export function friendStatus(friend, lastContactById, today = todayISO()) {
  const last = lastContactById[friend.id] || null
  const daysSince = last ? diffDays(last, today) : null
  const interval = reminderInterval(friend)
  const due = interval ? daysSince === null || daysSince >= interval : false
  const soon = interval && !due && daysSince !== null ? daysSince >= interval * 0.75 : false
  const birthday = friend.birthday ? nextBirthday(friend.birthday, today) : null
  return { last, daysSince, interval, due, soon, nextBirthday: birthday, daysToBirthday: birthday ? diffDays(today, birthday) : null }
}

export function lastContactMap(logs = data().contactLogs) {
  const map = {}
  for (const log of logs) {
    const friendId = log.friendId || log.friend_id
    if (friendId && log.date && (!map[friendId] || log.date > map[friendId])) map[friendId] = log.date
  }
  return map
}

export function addFriend(fields) {
  const relationship = fields.relationship || 'friend'
  const friend = {
    id: newId(),
    name: fields.name.trim(),
    relationship,
    reminderDays: RELATIONSHIPS.find((item) => item.id === relationship)?.reminderDays ?? null,
    organization: fields.organization?.trim() || '',
    birthday: fields.birthday || '',
    currentStatus: fields.currentStatus?.trim() || '',
    facts: fields.facts?.trim() || '',
    photoUrl: fields.photoUrl?.trim() || '',
    createdAt: nowIso(),
  }
  updateData('friends', (list) => [...list, friend])
  return friend
}

export function updateFriend(id, patch) {
  const next = { ...patch }
  if (patch.relationship) next.reminderDays = RELATIONSHIPS.find((item) => item.id === patch.relationship)?.reminderDays ?? null
  updateData('friends', (list) => list.map((friend) => (friend.id === id ? { ...friend, ...next } : friend)))
}

// Removes a person, their history and their open "Talk to …" reminders. Returns an undo function.
export function removeFriend(id) {
  const friend = data().friends.find((item) => item.id === id)
  const logs = data().contactLogs.filter((log) => (log.friendId || log.friend_id) === id)
  const reminders = data().tasks.filter((task) => !task.done && !task.archived && typeof task.details === 'string' && task.details.startsWith(`friend-reminder:${id}:`))
  updateData('friends', (list) => list.filter((item) => item.id !== id))
  if (logs.length) updateData('contactLogs', (list) => list.filter((log) => (log.friendId || log.friend_id) !== id))
  reminders.forEach((task) => archiveTask(task.id))
  return () => {
    if (friend) updateData('friends', (list) => [...list, friend])
    if (logs.length) updateData('contactLogs', (list) => [...logs, ...list])
    reminders.forEach((task) => restoreTask(task.id))
  }
}

// A catch-up's `note` is what you talked about (dated, per conversation). It is different from
// the person's currentStatus (what they're doing now) and facts (durable details).
export const CONTACT_NOTE_MAX = 4000
const cleanNote = (note) => (typeof note === 'string' ? note.replace(/\r\n?/g, '\n').trim().slice(0, CONTACT_NOTE_MAX) : '')

// Adds `note` to `current` on a new line, unless it is already there as a whole line (block).
function appendNote(current, note) {
  const base = cleanNote(current)
  if (!note) return base
  if (!base) return note
  if (base === note || base.startsWith(`${note}\n`) || base.endsWith(`\n${note}`) || base.includes(`\n${note}\n`)) return base
  return `${base}\n${note}`.slice(0, CONTACT_NOTE_MAX)
}

// One line for lists: the note's lines joined with " · ".
export function contactTopic(note) {
  return cleanNote(note).split('\n').map((line) => line.trim()).filter(Boolean).join(' · ')
}

// Logs a catch-up, with an optional note on what you talked about, and completes any open
// "Talk to …" reminder for that person. There's one catch-up per person per day: logging the
// same day again (a second tap, the assistant) adds the note to that day's log on a new line
// instead of creating a duplicate. Returns undo, with the log's id as undo.logId.
export function logContact(friendId, date = todayISO(), note = '') {
  const text = cleanNote(note)
  const existing = data().contactLogs.find((item) => (item.friendId || item.friend_id) === friendId && item.date === date)
  let log = existing
  let noteChanged = false
  if (existing) {
    const merged = appendNote(existing.note, text)
    noteChanged = merged !== (existing.note || '')
    if (noteChanged) updateData('contactLogs', (list) => list.map((item) => (item.id === existing.id ? { ...item, note: merged } : item)))
  } else {
    log = { id: newId(), friendId, date, ...(text ? { note: text } : {}), createdAt: nowIso() }
    updateData('contactLogs', (list) => [log, ...list])
  }
  const reminders = data().tasks.filter((task) => !task.done && !task.archived && typeof task.details === 'string' && task.details.startsWith(`friend-reminder:${friendId}:`))
  // updateTask, not setTaskDone: this already logged the catch-up.
  for (const task of reminders) updateTask(task.id, { done: true })
  const undo = () => {
    if (!existing) updateData('contactLogs', (list) => list.filter((item) => item.id !== log.id))
    // An explicit '' (not a missing field), so a note that was already saved is cleared on the server.
    else if (noteChanged) updateData('contactLogs', (list) => list.map((item) => (item.id === existing.id ? { ...item, note: existing.note || '' } : item)))
    for (const task of reminders) updateTask(task.id, { done: false })
  }
  undo.logId = log.id
  return undo
}

// Replaces a catch-up's note ('' clears it). Returns undo.
export function updateContactNote(id, note) {
  const log = data().contactLogs.find((item) => item.id === id)
  if (!log) return () => {}
  const text = cleanNote(note)
  const previous = log.note || ''
  if (text === previous) return () => {}
  updateData('contactLogs', (list) => list.map((item) => (item.id === id ? { ...item, note: text } : item)))
  return () => updateData('contactLogs', (list) => list.map((item) => (item.id === id ? { ...item, note: previous } : item)))
}

// The latest catch-up per person: { [friendId]: { date, note } }, where note joins the notes of
// every log on that day (normally one).
export function lastCatchUpMap(logs = data().contactLogs) {
  const map = {}
  for (const log of logs) {
    const friendId = log.friendId || log.friend_id
    if (!friendId || !log.date) continue
    const note = cleanNote(log.note)
    const current = map[friendId]
    if (!current || log.date > current.date) map[friendId] = { date: log.date, note }
    else if (log.date === current.date && note) map[friendId] = { date: log.date, note: appendNote(current.note, note) }
  }
  return map
}

// Returns an undo function.
export function removeContactLog(id) {
  const log = data().contactLogs.find((item) => item.id === id)
  updateData('contactLogs', (list) => list.filter((item) => item.id !== id))
  return () => log && updateData('contactLogs', (list) => (list.some((item) => item.id === log.id) ? list : [log, ...list]))
}

// Once a day, add a "Talk to …" task for anyone who is due a catch-up.
export function ensureFriendReminders() {
  // Only on data confirmed by the server this session, never on an empty or stale cache.
  if (!getState().lastSyncedAt) return
  const today = todayISO()
  if (readPref('remindersCheckedOn') === today) return
  writePref('remindersCheckedOn', today)
  const lastById = lastContactMap()
  for (const friend of data().friends) {
    const status = friendStatus(friend, lastById, today)
    if (!status.due) continue
    const alreadyOpen = data().tasks.some((task) => !task.done && !task.archived
      && ((typeof task.details === 'string' && task.details.startsWith(`friend-reminder:${friend.id}:`)) || task.text === `Talk to ${friend.name}`))
    const alreadyToday = data().tasks.some((task) => task.details === `friend-reminder:${friend.id}:${today}`)
    if (alreadyOpen || alreadyToday) continue
    createTask({ text: `Talk to ${friend.name}`, details: `friend-reminder:${friend.id}:${today}`, date: today, priority: 'medium' })
  }
}

// ---- journal & notes -------------------------------------------------------------------------

export const MOODS = [
  { id: 'great', label: 'Great', emoji: '😄' },
  { id: 'good', label: 'Good', emoji: '🙂' },
  { id: 'okay', label: 'Okay', emoji: '😐' },
  { id: 'low', label: 'Low', emoji: '😕' },
  { id: 'rough', label: 'Rough', emoji: '😣' },
]

export function moodEmoji(id) {
  return MOODS.find((mood) => mood.id === id)?.emoji || ''
}

export function saveJournalEntry(date, fields) {
  if (!isISODate(date)) return
  const existing = data().journalEntries.find((entry) => entry.date === date)
  if (existing) {
    updateData('journalEntries', (list) => list.map((entry) => (entry.id === existing.id ? { ...entry, ...fields } : entry)))
    return
  }
  const entry = { id: newId(), date, title: '', body: '', mood: '', ...fields, createdAt: nowIso() }
  updateData('journalEntries', (list) => [entry, ...list])
}

export function deleteJournalEntry(id) {
  const entry = data().journalEntries.find((item) => item.id === id)
  updateData('journalEntries', (list) => list.filter((item) => item.id !== id))
  return () => entry && updateData('journalEntries', (list) => [entry, ...list])
}

export function addNote(text) {
  const note = { id: newId(), text: text.trim(), createdAt: nowIso() }
  updateData('voiceNotes', (list) => [note, ...list])
  return note
}

export function deleteNote(id) {
  const note = data().voiceNotes.find((item) => item.id === id)
  updateData('voiceNotes', (list) => list.filter((item) => item.id !== id))
  return () => note && updateData('voiceNotes', (list) => [note, ...list])
}

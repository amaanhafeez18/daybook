// The catch-up offer after ticking off a task (TaskRow's checkbox and swipe, TaskSheet's Complete).
import { toast } from './ui/feedback.jsx'
import { logContact } from '../lib/planner.js'
import { getState } from '../lib/store.js'
import { areaOn } from '../lib/areas.js'
import { personInText } from '../lib/peopleMatch.js'
import { todayISO } from '../lib/dates.js'

// Ticking off a task that names one of your people ("Coffee with Sam") offers to log a catch-up
// with them for today, once per task per session: not for the app's own "Talk to …" reminders
// (ticking those logs it already), not when one is logged for today, not with People turned off.
// The offer is its own toast; logging has Undo (which also reopens a "Talk to …" it completed).
const catchUpOffered = new Set()
export function offerCatchUp(task) {
  if (catchUpOffered.has(task.id)) return
  const { data } = getState()
  if (!areaOn(data.settings, 'people')) return
  const match = personInText(task, data.friends)
  if (!match) return
  const today = todayISO()
  if ((data.contactLogs || []).some((log) => (log.friendId || log.friend_id) === match.friend.id && log.date === today)) return
  catchUpOffered.add(task.id)
  const friendId = match.friend.id
  toast(`Talked to ${match.name}?`, {
    key: `catch-up-offer-${task.id}`,
    action: {
      label: 'Log catch-up',
      onClick: () => {
        if (!getState().data.friends.some((friend) => friend.id === friendId)) return
        const undo = logContact(friendId, todayISO())
        toast(`Logged a catch-up with ${match.name}`, { key: `catch-up-${friendId}`, action: { label: 'Undo', onClick: undo } })
      },
    },
  })
}

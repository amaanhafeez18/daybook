// Pure helpers for the Assistant page (no React, no browser APIs), tested in tests/assistant-chat.test.mjs:
// the start screen's prompts for the current space, the composer's placeholder, which action chips
// and cards a reply shows, and when a waiting card has expired.
import { toISO } from './dates.js'

// A waiting card can't be carried out after this long (or once the local day changes); the server
// then checks it again with the user.
export const PROPOSAL_TTL_MS = 30 * 60 * 1000
// An Undo chip works this long after the reply (the same limit as the server's).
export const UNDO_TTL_MS = 60 * 60 * 1000
// Settled cards that collapse to one line once they're not on the newest message.
const COLLAPSED_STATUSES = new Set(['superseded', 'expired', 'cancelled'])

const FALLBACK_SUGGESTIONS = [
  { icon: 'calendar', text: 'Help me plan the rest of my week' },
  { icon: 'sparkles', text: 'What can you do?' },
  { icon: 'journal', text: 'Help me write today’s journal' },
]

// The space the Assistant was opened from ('plan' or 'health'). Without Gym and Food there's only Plan.
export function assistantSpace(pref, areas) {
  const healthOn = areas?.gym !== false || areas?.food !== false
  return pref === 'health' && healthOn ? 'health' : 'plan'
}

// Up to four prompts, most useful first, from what's in the app right now and the space it was opened
// from. A prompt with `fill` puts the start of a message in the composer instead of sending.
export function buildSuggestions({ tasks, friends, settings, foodEntries, gymDay = false, noGymPlan = false, today, hour = 12, space = 'plan' }) {
  const areas = settings?.areas && typeof settings.areas === 'object' ? settings.areas : {}
  const gymOn = areas.gym !== false
  const foodOn = areas.food !== false
  const calorieGoal = Number(settings?.food?.goals?.calories)
  const tracksFood = foodOn && ((Number.isFinite(calorieGoal) && calorieGoal > 0) || (Array.isArray(foodEntries) && foodEntries.length > 0))
  const workout = gymOn && gymDay ? { icon: 'dumbbell', text: 'What’s today’s workout?' } : null
  const gymPlan = gymOn && noGymPlan ? { icon: 'dumbbell', text: 'Help me set up a gym plan' } : null
  const calories = tracksFood ? { icon: 'utensils', text: 'How many calories do I have left?' } : null
  const list = []

  if (assistantSpace(space, areas) === 'health') {
    if (foodOn) list.push({ icon: 'utensils', text: 'Log a meal…', fill: 'I had ' }, calories)
    list.push(workout || gymPlan)
    list.push({ icon: 'scale', text: 'Log my weight…', fill: 'I weigh ' })
    if (gymOn) list.push({ icon: 'dumbbell', text: 'Log a workout…', fill: 'I did ' })
  } else {
    const overdue = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task && !task.archived && !task.done && typeof task.date === 'string' && task.date && task.date < today).length
    if (overdue > 0) list.push({ icon: 'alert', text: overdue === 1 ? 'Reschedule my overdue task' : `Reschedule my ${overdue} overdue tasks` })
    list.push(hour >= 17 ? { icon: 'sunrise', text: 'Plan tomorrow' } : { icon: 'sun', text: 'What’s on my plate today?' })
    list.push({ icon: 'bell', text: 'Remind me to…', fill: 'Remind me to ' })
    if (areas.people !== false && Array.isArray(friends) && friends.length > 0) list.push({ icon: 'people', text: 'Who should I catch up with?' })
    list.push(workout, gymPlan, calories)
    if (settings?.showPrayerTimes !== false) list.push({ icon: 'moon', text: 'What are today’s prayer times?' })
  }
  list.push(...FALLBACK_SUGGESTIONS)
  const seen = new Set()
  return list.filter((item) => item && !seen.has(item.text) && seen.add(item.text)).slice(0, 4)
}

// The composer's hint, by space.
export const composerPlaceholder = (space) => (space === 'health' ? 'Log food, a workout or your weight…' : 'Ask, or tell me what to add…')

const sameText = (text) => String(text || '').toLowerCase().replace(/[“”"‘’']/g, '').replace(/\s+/g, ' ').replace(/[.!\s]+$/, '').trim()

// An Undo chip that can still be tapped (the action worked, wasn't undone, the server hasn't refused
// it for good on this visit, and it isn't too old).
export function canUndo(action, createdAt, now = Date.now()) {
  if (!action?.ok || !action.undoId || action.undone || action.undoBlocked) return false
  const stamp = Date.parse(createdAt || '')
  return !Number.isFinite(stamp) || now - stamp < UNDO_TTL_MS
}

// Chips worth showing under a reply: failures always; a chip whose text the reply already says is
// left out, unless it still offers Undo.
export function visibleActions(actions, reply = '', { createdAt, now = Date.now() } = {}) {
  const said = sameText(reply)
  return (Array.isArray(actions) ? actions : []).filter((action) => {
    if (!action || !(action.message || action.ok === false)) return false
    if (!action.ok || canUndo(action, createdAt, now) || action.undone) return true
    const text = sameText(action.message)
    return !text || !said.includes(text)
  })
}

// An Undo the server refused for good (too old, or already gone): the chip stops offering it. A
// refusal that might pass later doesn't count: a network or server error, or "changed since" (undoing
// the catch-up or edit that changed it, here or in the app, makes it possible again).
export const undoRefused = (error) => error?.status === 404 || error?.status === 410 || (error?.status === 409 && !!error.payload?.gone)

// "Log my sets" (offer_workout with when 'done') under a reply stands in for that reply's quick log.
// show: the quick log hasn't been saved (or its Undo chip was used): once saved, the sets are added
// by editing that workout in Gym → History, or it would be logged twice. cancels: the waiting card
// it replaces, only a card whose one action is that quick log (never one with other changes on it),
// to cancel once the workout has actually started.
export function setsOffer(offer, proposal, actions) {
  if (offer?.when !== 'done') return { show: true, cancels: null }
  const quickLogs = (Array.isArray(actions) ? actions : []).filter((action) => action?.tool === 'gym_quick_log' && action.ok)
  if (quickLogs.some((action) => !action.undone)) return { show: false, cancels: null }
  // It ran at once and was undone: any card on this reply holds other changes.
  if (quickLogs.length || !proposal) return { show: true, cancels: null }
  if (['done', 'partial', 'executing'].includes(proposal.status)) return { show: false, cancels: null }
  if (proposal.status !== 'pending') return { show: true, cancels: null } // nothing was logged
  const rows = Array.isArray(proposal.actions) ? proposal.actions : []
  const onlyQuickLog = rows.length === 1 && (!rows[0]?.tool || rows[0].tool === 'gym_quick_log')
  if (onlyQuickLog) return { show: true, cancels: proposal.id }
  // A card known not to hold a quick log (every row names its tool) is left alone.
  const tools = rows.map((row) => row?.tool)
  if (tools.length && tools.every(Boolean) && !tools.includes('gym_quick_log')) return { show: true, cancels: null }
  return { show: false, cancels: null }
}

// A settled card that's no longer on the newest message shows as one line until tapped.
export const collapsesCard = (status, isLast) => !isLast && COLLAPSED_STATUSES.has(status)

// Server stamps win; otherwise the message time. Expired after 30 min or once the local day changes.
export function proposalExpired(proposal, createdAt, now = Date.now()) {
  if (typeof proposal?.localDate === 'string' && proposal.localDate && proposal.localDate !== toISO(new Date(now))) return true
  const stamp = Date.parse(proposal?.createdAt || createdAt || '')
  if (!Number.isFinite(stamp)) return false
  return now - stamp > PROPOSAL_TTL_MS || toISO(new Date(stamp)) !== toISO(new Date(now))
}

// The card `proposalId` can no longer be carried out as it is (expired, or waiting past its time).
export function cardExpired(messages, proposalId, now = Date.now()) {
  const message = (Array.isArray(messages) ? messages : []).find((item) => item?.proposal?.id === proposalId)
  const status = message?.proposal?.status
  return status === 'expired' || (status === 'pending' && proposalExpired(message.proposal, message.createdAt, now))
}

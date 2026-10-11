// Pure helpers for the Assistant page (no React, no browser APIs), tested in tests/assistant-chat.test.mjs:
// the start screen's prompts for the current space, the composer's placeholder, which action chips
// and cards a reply shows, when a waiting card has expired, hand-off links, merging the server's
// history with what's on screen, the typing pace of a streamed reply and the cached message shape.
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

// Old open tasks worth a "Tidy up" prompt from this many on.
const STALE_PROMPT_FROM = 5

// Up to four prompts, most useful first, from what's in the app right now and the space it was opened
// from. A prompt with `fill` puts the start of a message in the composer instead of sending.
// facts (all optional, worked out by the page): birthdays [{ name, label: 'today' | 'tomorrow' | 'Sat' }]
// in the coming week, missedWorkout { name } (yesterday's planned workout wasn't done), proteinLeftG and
// proteinGoalG for today, staleCount (old open tasks), weekday (0 = Sunday).
export function buildSuggestions({ tasks, friends, settings, foodEntries, gymDay = false, noGymPlan = false, today, hour = 12, space = 'plan', facts = {} }) {
  const areas = settings?.areas && typeof settings.areas === 'object' ? settings.areas : {}
  const gymOn = areas.gym !== false
  const foodOn = areas.food !== false
  const calorieGoal = Number(settings?.food?.goals?.calories)
  const tracksFood = foodOn && ((Number.isFinite(calorieGoal) && calorieGoal > 0) || (Array.isArray(foodEntries) && foodEntries.length > 0))
  const workout = gymOn && gymDay ? { icon: 'dumbbell', text: 'What’s today’s workout?' } : null
  const gymPlan = gymOn && noGymPlan ? { icon: 'dumbbell', text: 'Help me set up a gym plan' } : null
  const calories = tracksFood ? { icon: 'utensils', text: 'How many calories do I have left?' } : null
  const known = facts && typeof facts === 'object' ? facts : {}
  const missed = gymOn && known.missedWorkout ? { icon: 'dumbbell', text: 'Fix my gym week' } : null
  const proteinGoal = Number(known.proteinGoalG)
  const proteinLeft = Number(known.proteinLeftG)
  const protein = foodOn && hour >= 15 && proteinGoal > 0 && proteinLeft >= Math.max(20, proteinGoal * 0.25)
    ? { icon: 'utensils', text: 'Protein ideas for tonight' } : null
  const list = []

  if (assistantSpace(space, areas) === 'health') {
    if (foodOn) list.push({ icon: 'utensils', text: 'Log a meal…', fill: 'I had ' })
    list.push(missed, protein)
    if (foodOn) list.push(calories)
    list.push(workout || gymPlan)
    list.push({ icon: 'scale', text: 'Log my weight…', fill: 'I weigh ' })
    if (gymOn) list.push({ icon: 'dumbbell', text: 'Log a workout…', fill: 'I did ' })
  } else {
    const open = (Array.isArray(tasks) ? tasks : []).filter((task) => task && !task.archived && !task.done)
    const overdue = open.filter((task) => typeof task.date === 'string' && task.date && task.date < today).length
    if (overdue > 0) list.push({ icon: 'alert', text: overdue === 1 ? 'Reschedule my overdue task' : `Reschedule my ${overdue} overdue tasks` })
    if (known.weekday === 0 && hour >= 16) list.push({ icon: 'calendarCheck', text: 'Review my week' })
    const birthday = areas.people !== false && Array.isArray(known.birthdays) ? known.birthdays.find((item) => item && String(item.name || '').trim()) : null
    if (birthday) list.push({ icon: 'cake', text: `Plan something for ${String(birthday.name).trim()}’s birthday${birthday.label ? ` (${birthday.label})` : ''}` })
    list.push(missed)
    list.push(hour >= 17 ? { icon: 'sunrise', text: 'Plan tomorrow' } : { icon: 'sun', text: 'What’s on my plate today?' })
    const stale = Math.floor(Number(known.staleCount) || 0)
    if (stale >= STALE_PROMPT_FROM) list.push({ icon: 'list', text: `Tidy up my ${stale} old tasks` })
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

// ---- hand-offs ---------------------------------------------------------------------------------

// The longest text a hand-off link puts in the composer.
export const ASK_MAX_CHARS = 500
const ASK_HASH = /^#\/?assistant\/ask\/(.*)$/

// A link that opens the Assistant with `text` in the composer (never sent: the user reads it and taps
// Send). Used by "Break into steps with the assistant" in the task sheet.
export function askAssistantHash(text) {
  const value = Array.from(String(text ?? '').trim()).slice(0, ASK_MAX_CHARS).join('')
  return `#/assistant/ask/${encodeURIComponent(value)}`
}

// The text a #/assistant/ask/<encoded> link carries (at most ASK_MAX_CHARS), or null for any other hash.
export function readAskHash(hash) {
  const match = ASK_HASH.exec(String(hash || ''))
  if (!match) return null
  let text = match[1]
  try {
    text = decodeURIComponent(text)
  } catch {
    // a hand-typed link with a stray "%": use it as it is
  }
  return Array.from(text.trim()).slice(0, ASK_MAX_CHARS).join('')
}

// ---- messages kept across visits ---------------------------------------------------------------

// A message's React key: its role and creation time (the server stamps every saved message), so the
// same message keeps its key when the history is loaded again. Messages without a time use `fallback`.
export const messageKey = (message, fallback = '') => (message?.createdAt ? `${message.role || 'assistant'}:${message.createdAt}` : fallback)

// Gives every message a unique `id` (its key; a repeat gets "#2").
export function withKeys(list) {
  const used = new Set()
  return (Array.isArray(list) ? list : []).filter((message) => message && typeof message === 'object').map((message, index) => {
    let id = message.id || messageKey(message, `m${index}`)
    for (let n = 2; used.has(id); n++) id = `${message.id || messageKey(message, `m${index}`)}#${n}`
    used.add(id)
    return id === message.id ? message : { ...message, id }
  })
}

const sameJson = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
// A message this device sent and the server's copy of it differ only in their time stamps.
const TWIN_WINDOW_MS = 10 * 60 * 1000
const twins = (local, server) => local.role === server.role && !local.error && (local.content || '') === (server.content || '')
  && Math.abs((Date.parse(local.createdAt || '') || 0) - (Date.parse(server.createdAt || '') || 0)) < TWIN_WINDOW_MS

// The server's history in place of what's on screen, keeping each message object that didn't change
// (so memoised rows and their cards keep their state and don't animate again). A message sent from
// here is matched to the server's copy by role, text and time, and keeps its key and photo previews.
export function mergeHistory(current, history) {
  const local = Array.isArray(current) ? current : []
  const byId = new Map(local.map((message) => [message.id, message]))
  const used = new Set()
  return withKeys((Array.isArray(history) ? history : []).filter((message) => message && typeof message === 'object').map((server) => {
    let match = byId.get(messageKey(server))
    if (match && used.has(match)) match = null
    if (!match) match = local.find((message) => !used.has(message) && twins(message, server)) || null
    if (!match) return server
    used.add(match)
    const next = { ...server, id: match.id, ...(Array.isArray(match.attachments) && match.attachments.some((item) => item?.thumb) ? { attachments: match.attachments } : {}) }
    const shape = (message) => ({ ...cacheMessage(message), offer: message.offer || null })
    return sameJson(shape(match), shape(next)) && match.createdAt === next.createdAt ? match : next
  }))
}

// How many waiting characters of a streamed reply to show in a frame `dtMs` long: all of a backlog
// within about 250 ms, at least one per frame.
export const TYPE_CATCH_UP_MS = 250
export function revealCount(backlog, dtMs) {
  const waiting = Math.max(0, Math.floor(Number(backlog) || 0))
  if (!waiting) return 0
  const share = Math.min(1, Math.max(0, Number(dtMs) || 0) / TYPE_CATCH_UP_MS)
  return Math.min(waiting, Math.max(1, Math.ceil(waiting * share)))
}

// Per-action results of a confirmed proposal, bounded: { label?, ok, message? } in action order.
export function cleanResults(value) {
  return (Array.isArray(value) ? value : []).filter((result) => result && typeof result === 'object').slice(0, 25).map((result) => ({
    ...(result.label ? { label: String(result.label).slice(0, 300) } : {}),
    ok: result.ok !== false,
    ...(result.message ? { message: String(result.message).slice(0, 300) } : {}),
  }))
}

// An action chip as kept: what it says, and its Undo (an id, or that it was undone).
export function chipFields({ tool, ok, message, undoId, undone }) {
  return { tool, ok, message, ...(undoId ? { undoId } : {}), ...(undone ? { undone: true } : {}) }
}

// The most attachments one message carries (src/lib/media.js MAX_ATTACHMENTS; kept here so this file
// stays free of browser code).
const CACHED_ATTACHMENTS = 10

// The shape kept in localStorage: no photos or file contents, and no in-flight states.
export function cacheMessage({ role, content, voice, actions, proposal, choices, attachments, createdAt }) {
  return {
    role,
    content: typeof content === 'string' ? content : '',
    ...(createdAt ? { createdAt } : {}),
    ...(voice ? { voice } : {}),
    ...(actions?.length ? { actions: actions.slice(0, 10).map(chipFields) } : {}),
    ...(proposal?.id ? {
      proposal: {
        id: proposal.id,
        // In-flight states can't be resumed from the cache; the server's history corrects it on load.
        status: ['executing', 'checking'].includes(proposal.status) ? 'interrupted' : proposal.status || 'pending',
        ...(proposal.summary ? { summary: String(proposal.summary).slice(0, 600) } : {}),
        ...(proposal.localDate ? { localDate: proposal.localDate } : {}),
        ...(proposal.createdAt ? { createdAt: proposal.createdAt } : {}),
        actions: (Array.isArray(proposal.actions) ? proposal.actions : []).slice(0, 12).map((action) => ({
          label: String(action?.label || '').slice(0, 300),
          ...(action?.detail ? { detail: String(action.detail).slice(0, 300) } : {}),
          ...(action?.tool ? { tool: String(action.tool).slice(0, 60) } : {}),
        })),
        ...(Array.isArray(proposal.results) ? { results: cleanResults(proposal.results) } : {}),
      },
    } : {}),
    ...(choices?.length ? { choices: choices.slice(0, 6) } : {}),
    ...(attachments?.length ? { attachments: attachments.slice(0, CACHED_ATTACHMENTS).map(({ kind, name }) => ({ kind, name })) } : {}),
  }
}

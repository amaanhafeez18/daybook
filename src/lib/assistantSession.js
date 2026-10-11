// The Assistant chat outside the page: the messages, whether a reply is on its way and its
// AbortController. Leaving the Assistant tab keeps a reply coming (the tab shows a dot meanwhile);
// only Stop, New chat and signing out cancel it. Read with useSyncExternalStore.
// A streamed reply is shown at a steady pace (a rAF loop that catches up within about 250 ms, one
// render per frame); this is display only and never changes what is saved.
import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from './api.js'
import { prefersReducedMotion } from './motion.js'
import { cacheMessage, revealCount, withKeys } from './assistantChat.js'

export const CHAT_CACHE = 'daybook.chat'

let state = null // { messages, busy, confirmingId }; read from the cache on first use
let controller = null // the reply on its way
let epoch = 0 // bumped by a reset: work started before it stops writing here
let viewers = 0
const listeners = new Set()

function current() {
  if (!state) {
    const cached = readJson(CHAT_CACHE, [])
    state = { messages: withKeys(Array.isArray(cached) ? cached : []), busy: false, confirmingId: null }
  }
  return state
}

function emit(next) {
  state = next
  for (const listener of listeners) listener()
}

// The finished conversation is cached so it shows at once next time (no photos: names only).
function persist(next) {
  if (next.busy) return
  const finished = next.messages.filter((message) => !message.error && !message.streaming && !message.pending)
  writeJson(CHAT_CACHE, finished.map(cacheMessage).slice(-40))
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getSession = () => current()

// The whole session, for the Assistant page.
export function useAssistantSession() {
  return useSyncExternalStore(subscribe, current, current)
}

// True while a reply is on its way (the Assistant tab's dot).
export function useAssistantStreaming() {
  return useSyncExternalStore(subscribe, () => current().busy, () => false)
}

// The current session's number. A request or check started under one session stops writing once it
// changes (signed out, or another account).
export const sessionEpoch = () => epoch

// Writers bound to the session they were made in: after a reset they do nothing.
export function sessionWriter(at = epoch) {
  const live = () => at === epoch
  const setMessages = (update) => {
    if (!live()) return
    const base = current()
    const messages = typeof update === 'function' ? update(base.messages) : update
    if (messages === base.messages) return
    const next = { ...base, messages }
    persist(next)
    emit(next)
  }
  return {
    live,
    setMessages,
    patchMessage(id, patch) {
      setMessages((list) => list.map((message) => (message.id === id ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)))
    },
  }
}

// Starts a reply: busy, with a fresh AbortController (returned). null when one is already on its way.
export function beginReply({ confirmingId = null } = {}) {
  if (current().busy) return null
  controller = new AbortController()
  emit({ ...current(), busy: true, confirmingId })
  return controller
}

// The reply started with `owner` has finished (or failed, or was stopped).
export function endReply(owner) {
  if (owner !== controller) return
  controller = null
  const next = { ...current(), busy: false, confirmingId: null }
  persist(next)
  emit(next)
}

// Stop: the reply on its way ends here (the server may still finish it).
export function stopReply() {
  controller?.abort()
}

// The Assistant page is on screen (speech and announcements only happen then). Returns the undo.
export function viewAssistant() {
  viewers += 1
  return () => { viewers = Math.max(0, viewers - 1) }
}
export const assistantViewed = () => viewers > 0

// Signing out or switching account: cancels the reply, forgets the conversation in memory (the next
// visit reads the cache, which signing out clears) and anything still writing to it.
export function clearAssistantSession() {
  epoch += 1
  const owner = controller
  controller = null
  owner?.abort()
  clearTyping()
  state = null
  for (const listener of listeners) listener()
}

// ---- the pace of a streamed reply ---------------------------------------------------------------

const waiting = new Map() // message id → text received but not shown yet
let frame = 0
let lastFrame = 0
let typingEpoch = 0

function clearTyping() {
  waiting.clear()
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  frame = 0
}

// Adds each chunk (message id → text) to its message, in one update.
function reveal(chunks) {
  if (!chunks.size) return
  sessionWriter(typingEpoch).setMessages((list) => {
    let changed = false
    const next = list.map((message) => {
      const text = chunks.get(message.id)
      if (!text) return message
      changed = true
      return { ...message, content: (message.content || '') + text, status: '' }
    })
    return changed ? next : list
  })
}

// The next `count` characters of `text` without splitting an emoji's surrogate pair.
function cut(text, count) {
  let end = Math.min(text.length, count)
  const code = text.charCodeAt(end - 1)
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1
  return end
}

function tick(time) {
  frame = 0
  if (typingEpoch !== epoch) {
    waiting.clear()
    return
  }
  const dt = lastFrame ? Math.min(100, time - lastFrame) : 16
  lastFrame = time
  const chunks = new Map()
  for (const [id, text] of waiting) {
    const end = cut(text, revealCount(text.length, dt))
    chunks.set(id, text.slice(0, end))
    if (end >= text.length) waiting.delete(id)
    else waiting.set(id, text.slice(end))
  }
  reveal(chunks)
  if (waiting.size) frame = requestAnimationFrame(tick)
}

// Streamed text for message `id`: shown over the next frames (at once under Reduce Motion, or while
// the page is hidden and frames don't run).
export function typeInto(id, text, at = epoch) {
  if (!text || at !== epoch) return
  typingEpoch = at
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (prefersReducedMotion() || hidden || typeof requestAnimationFrame !== 'function') {
    const chunks = new Map([[id, (waiting.get(id) || '') + text]])
    waiting.delete(id)
    reveal(chunks)
    return
  }
  waiting.set(id, (waiting.get(id) || '') + text)
  if (!frame) {
    lastFrame = 0
    frame = requestAnimationFrame(tick)
  }
}

// Everything received for `id` shown now (the reply finished, stopped or failed).
export function flushTyping(id) {
  const text = waiting.get(id)
  waiting.delete(id)
  if (text) reveal(new Map([[id, text]]))
  if (!waiting.size && frame && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frame)
    frame = 0
  }
}

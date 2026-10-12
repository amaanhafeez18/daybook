// The live voice chat's transcript, built from the realtime data channel's events. Pure: no
// imports and no browser code, so node --test runs it (tests/voice-client.test.mjs).
//
// Items are placed by `previous_item_id`, never by arrival: a user's transcription can finish after
// the assistant has started answering, and two completions can arrive out of order. Each realtime
// session (a "segment": the call was paused and continued) starts a fresh item list; the turns of
// the earlier segments are kept as they were.
//
// A turn is { id, r: 'u' (spoken) | 't' (typed) | 'a' (Daybook), text, partial, phase, interrupted,
// failed, responseId, at (ISO) }. Daybook's preamble before a tool call ("One sec…") has phase
// 'commentary': it shows while the call runs but is never saved.

export const NOT_CAUGHT = '(didn’t catch that)'

export function createTranscript() {
  return { past: [], order: [], items: {}, responses: {}, rev: 0 }
}

// Seeds the turns of a voice chat continued after a reload (its saved turns), so a checkpoint
// doesn't replace them with only the new ones.
export function seedTurns(state, turns) {
  const list = (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn.t === 'string' && /^[uta]$/.test(turn.r))
  state.past = list.map((turn, index) => ({
    id: String(turn.id || `seed${index}`), r: turn.r, text: turn.t, partial: false, phase: null,
    interrupted: false, failed: false, responseId: null, at: turn.at || null,
  }))
  state.rev += 1
  return state
}

// A new realtime session in the same voice chat: what was said so far is frozen.
export function startSegment(state) {
  // Preambles that led to a tool call are dropped now, while it's still known which they were.
  const kept = currentTurns(state).filter((turn) => !(turn.r === 'a' && turn.phase === 'commentary' && hadCall(state, turn.responseId)))
  state.past = [...state.past, ...kept.map((turn) => ({ ...turn, partial: false }))]
  state.order = []
  state.items = {}
  state.responses = {}
  state.rev += 1
  return state
}

const iso = (now) => new Date(now).toISOString()

function place(state, id, previousId) {
  const at = state.order.indexOf(id)
  if (previousId === undefined) {
    if (at === -1) state.order.push(id)
    return
  }
  const prev = previousId === null ? -1 : state.order.indexOf(previousId)
  // An unknown predecessor (an item from before we listened): keep it where it is, or at the end.
  if (previousId !== null && prev === -1) {
    if (at === -1) state.order.push(id)
    return
  }
  if (at !== -1) {
    if (at === prev + 1) return
    state.order.splice(at, 1)
  }
  const target = previousId === null ? 0 : state.order.indexOf(previousId) + 1
  state.order.splice(target, 0, id)
}

function ensure(state, id, fields, now) {
  let item = state.items[id]
  if (!item) {
    item = { id, role: 'assistant', kind: 'message', source: 'audio', text: '', partial: true, done: false, phase: null, interrupted: false, failed: false, local: false, responseId: null, at: iso(now) }
    state.items[id] = item
  }
  Object.assign(item, fields)
  return item
}

// The text of a conversation item's content parts, and what kind of message it is.
function readContent(item) {
  const parts = Array.isArray(item?.content) ? item.content : []
  let text = null
  let source = null
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
      source = source || 'text'
      if (typeof part.text === 'string') text = (text || '') + part.text
    } else if (part.type === 'input_audio' || part.type === 'output_audio' || part.type === 'audio') {
      source = source || 'audio'
      if (typeof part.transcript === 'string') text = (text || '') + part.transcript
    }
  }
  return { text, source }
}

function takeItem(state, raw, previousId, now, responseId = null) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null
  const id = String(raw.id)
  if (raw.type === 'function_call' || raw.type === 'function_call_output') {
    const item = ensure(state, id, { kind: raw.type, role: 'tool', local: true, partial: false, name: raw.name || null, callId: raw.call_id || null }, now)
    if (responseId) item.responseId = responseId
    place(state, id, previousId)
    return item
  }
  if (raw.type && raw.type !== 'message') return null
  const role = raw.role === 'user' ? 'user' : raw.role === 'system' ? 'system' : 'assistant'
  const { text, source } = readContent(raw)
  const item = ensure(state, id, { role, kind: 'message', local: role === 'system' }, now)
  if (source) item.source = source
  if (raw.phase) item.phase = raw.phase
  if (responseId) item.responseId = responseId
  if ((role === 'user' && item.source === 'text') || role === 'system') {
    item.text = text || item.text
    item.partial = false
    item.done = true
  } else if (text) {
    // An assistant item's own transcript wins over what the deltas added up to; a spoken user
    // item takes it only while its transcription hasn't finished.
    if (role === 'assistant') item.text = text
    else if (!item.done) {
      item.text = text
      item.partial = false
      item.done = true
    }
  }
  place(state, id, previousId)
  return item
}

// Applies one server event; returns the same state (rev bumped when something visible changed).
export function applyEvent(state, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return state
  const type = event.type
  switch (type) {
    case 'input_audio_buffer.committed': {
      if (!event.item_id) break
      ensure(state, event.item_id, { role: 'user', kind: 'message', source: 'audio' }, now)
      place(state, event.item_id, event.previous_item_id === undefined ? undefined : event.previous_item_id)
      break
    }
    case 'conversation.item.added':
    case 'conversation.item.created':
    case 'conversation.item.done':
      takeItem(state, event.item, event.previous_item_id === undefined ? undefined : event.previous_item_id, now)
      break
    case 'conversation.item.deleted':
      if (event.item_id && state.items[event.item_id]) {
        delete state.items[event.item_id]
        state.order = state.order.filter((id) => id !== event.item_id)
      }
      break
    case 'conversation.item.input_audio_transcription.delta': {
      if (!event.item_id) break
      const item = ensure(state, event.item_id, { role: 'user', kind: 'message', source: 'audio' }, now)
      if (!item.done && typeof event.delta === 'string') item.text += event.delta
      place(state, event.item_id)
      break
    }
    case 'conversation.item.input_audio_transcription.completed': {
      if (!event.item_id) break
      const item = ensure(state, event.item_id, { role: 'user', kind: 'message', source: 'audio' }, now)
      item.text = String(event.transcript ?? item.text ?? '').trim()
      item.partial = false
      item.done = true
      item.failed = false
      place(state, event.item_id)
      break
    }
    case 'conversation.item.input_audio_transcription.failed': {
      if (!event.item_id) break
      const item = ensure(state, event.item_id, { role: 'user', kind: 'message', source: 'audio' }, now)
      item.text = NOT_CAUGHT
      item.partial = false
      item.done = true
      item.failed = true
      place(state, event.item_id)
      break
    }
    case 'response.created': {
      const id = event.response?.id
      if (id) state.responses[id] = { status: 'in_progress', items: [] }
      break
    }
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const responseId = event.response_id || null
      const item = takeItem(state, event.item, undefined, now, responseId)
      if (item && responseId) {
        const response = state.responses[responseId] || (state.responses[responseId] = { status: 'in_progress', items: [] })
        if (!response.items.includes(item.id)) response.items.push(item.id)
      }
      break
    }
    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
    case 'response.audio_transcript.delta':
    case 'response.text.delta': {
      if (!event.item_id || typeof event.delta !== 'string') break
      const item = ensure(state, event.item_id, { role: 'assistant', kind: 'message' }, now)
      if (event.response_id) item.responseId = event.response_id
      item.text += event.delta
      item.partial = true
      place(state, event.item_id)
      break
    }
    case 'response.output_audio_transcript.done':
    case 'response.output_text.done':
    case 'response.audio_transcript.done':
    case 'response.text.done': {
      if (!event.item_id) break
      const item = ensure(state, event.item_id, { role: 'assistant', kind: 'message' }, now)
      const text = typeof event.transcript === 'string' ? event.transcript : typeof event.text === 'string' ? event.text : null
      if (text !== null) item.text = text
      item.partial = false
      place(state, event.item_id)
      break
    }
    case 'response.done': {
      const response = event.response || {}
      const id = response.id
      const record = id ? (state.responses[id] || (state.responses[id] = { status: 'in_progress', items: [] })) : null
      if (record) record.status = response.status || 'completed'
      for (const raw of Array.isArray(response.output) ? response.output : []) {
        const item = takeItem(state, raw, undefined, now, id || null)
        if (item && record && !record.items.includes(item.id)) record.items.push(item.id)
      }
      if (record) {
        for (const itemId of record.items) {
          const item = state.items[itemId]
          if (!item || item.role !== 'assistant') continue
          item.partial = false
          if (record.status === 'cancelled' || record.status === 'incomplete') item.interrupted = true
        }
      }
      break
    }
    default:
      return state
  }
  state.rev += 1
  return state
}

// Marks an item (and its answer) as an echo the client deleted; it leaves the transcript.
export function dropItem(state, itemId) {
  if (!itemId || !state.items[itemId]) return state
  delete state.items[itemId]
  state.order = state.order.filter((id) => id !== itemId)
  state.rev += 1
  return state
}

function currentTurns(state) {
  const turns = []
  for (const id of state.order) {
    const item = state.items[id]
    if (!item || item.local || item.kind !== 'message' || item.role === 'system') continue
    const r = item.role === 'user' ? (item.source === 'text' ? 't' : 'u') : 'a'
    turns.push({
      id: item.id, r, text: item.text, partial: !!item.partial, phase: item.phase || null,
      interrupted: !!item.interrupted, failed: !!item.failed, responseId: item.responseId || null, at: item.at,
    })
  }
  return turns
}

// Everything said so far, in conversation order (earlier segments first). Preambles included, for
// the screen; storedTurns leaves them out.
export function orderedTurns(state) {
  return [...state.past, ...currentTurns(state)]
}

// A user item's finished transcript: { done, text } ('' while still listening). Typed turns are
// done at once.
export function transcriptFor(state, itemId) {
  const item = itemId ? state.items[itemId] : null
  if (!item) return { done: false, text: '' }
  return { done: !!item.done, text: item.failed ? '' : String(item.text || '') }
}

// Whether a response produced a tool call (its preamble is then only a preamble).
function hadCall(state, responseId) {
  const record = responseId ? state.responses[responseId] : null
  return !!record && record.items.some((id) => state.items[id]?.kind === 'function_call')
}

// The newest `count` words Daybook said (for the echo check).
export function lastAssistantWords(state, count = 30) {
  const words = []
  const turns = orderedTurns(state)
  for (let index = turns.length - 1; index >= 0 && words.length < count; index -= 1) {
    if (turns[index].r !== 'a') continue
    const list = String(turns[index].text || '').split(/\s+/).filter(Boolean)
    words.unshift(...list.slice(Math.max(0, list.length - (count - words.length))))
  }
  return words.slice(-count)
}

const byteLength = (text) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length * 3)

// The turns as saved with the voice chat: [{ id, r, t, at }], with a count of the oldest dropped to
// stay inside the limits (the server applies the same caps) and inside a keepalive request.
// Preambles whose response went on to a tool call are left out, as are empty turns.
export function storedTurns(turns, { state = null, maxTurns = 150, maxChars = 1500, totalChars = 30000, maxBytes = 56000 } = {}) {
  let list = (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn && /^[uta]$/.test(turn.r))
    .filter((turn) => !(turn.r === 'a' && turn.phase === 'commentary' && (!state || hadCall(state, turn.responseId) || !turn.responseId)))
    .map((turn) => ({ id: String(turn.id || '').slice(0, 80), r: turn.r, t: String(turn.text ?? turn.t ?? '').trim().slice(0, maxChars), at: turn.at || null }))
    .filter((turn) => turn.t && turn.t !== NOT_CAUGHT)
  let trimmed = 0
  if (list.length > maxTurns) {
    trimmed += list.length - maxTurns
    list = list.slice(-maxTurns)
  }
  let chars = list.reduce((sum, turn) => sum + turn.t.length, 0)
  while (list.length && chars > totalChars) {
    chars -= list[0].t.length
    list = list.slice(1)
    trimmed += 1
  }
  while (list.length && byteLength(JSON.stringify(list)) > maxBytes) {
    const drop = Math.max(1, Math.ceil(list.length / 10))
    list = list.slice(drop)
    trimmed += drop
  }
  return { turns: list, trimmed }
}

// What the screen shows: the newest user turn and the newest Daybook turn after it (a preamble
// until its answer arrives).
export function latestPair(turns) {
  const list = Array.isArray(turns) ? turns : []
  let assistant = null
  let user = null
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const turn = list[index]
    if (turn.r === 'a') {
      if (!assistant && !user && String(turn.text || '').trim()) assistant = turn
    } else if (!user) {
      user = turn
      break
    }
  }
  return { user, assistant }
}

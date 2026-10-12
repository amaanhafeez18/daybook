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

// ---- Spoken numbers → digits (Daybook's captions) ---------------------------------------------------
// The realtime model's audio transcript sometimes spells numbers out ("two thousand three hundred
// eleven calories"), which reads badly as text. Daybook's turns are shown and saved with digits:
// compound numbers ("2,311", "fifteen hundred" → "1,500"), 13 and up ("forty-five" → "45"), clock
// times ("five thirty PM" → "5:30 PM", "seven oh five" → "7:05"), weights said in hundreds ("one
// thirty-five pounds" → "135 pounds"), years ("twenty twenty-six" → "2026") and decimals ("one point
// five" → "1.5"). Small counts stay words ("two slices", "one sec", "ten"), and "five thirty" with
// nothing saying whether it's a time or 530 stays as said.

const UNIT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
const TEEN_WORDS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const SCALE_WORDS = { thousand: 1000, million: 1000000 }
const DIGIT_WORDS = { zero: 0, oh: 0, ...UNIT_WORDS }
// "thirty first", "twenty second", "one hundred and first": an ordinal (a date, or "a thirty second
// plank") stays as words rather than turning into "30 first".
const ORDINAL_WORD = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|[a-z]+teenth|[a-z]+tieth|hundredth|thousandth|millionth)$/
const CLOCK_AFTER = new Set(['am', 'pm', 'a', 'p', 'oclock'])
const AMOUNT_AFTER = new Set(['pounds', 'pound', 'lb', 'lbs', 'kilos', 'kilo', 'kg', 'kgs', 'kilograms', 'calories', 'kcal', 'grams', 'g'])

// One word token → its parts ('twenty-five' → [['tens', 20], ['unit', 5]]), or null.
function numberParts(token) {
  const pieces = token.toLowerCase().split('-')
  const parts = []
  for (const piece of pieces) {
    if (Object.hasOwn(UNIT_WORDS, piece)) parts.push(['unit', UNIT_WORDS[piece]])
    else if (Object.hasOwn(TEEN_WORDS, piece)) parts.push(['teen', TEEN_WORDS[piece]])
    else if (Object.hasOwn(TENS_WORDS, piece)) parts.push(['tens', TENS_WORDS[piece]])
    else if (piece === 'hundred') parts.push(['hundred', 100])
    else if (Object.hasOwn(SCALE_WORDS, piece)) parts.push(['scale', SCALE_WORDS[piece]])
    else return null
  }
  // A hyphen only joins tens and a unit ("twenty-five").
  if (pieces.length > 1 && !(parts.length === 2 && parts[0][0] === 'tens' && parts[1][0] === 'unit')) return null
  return parts
}

// The longest number phrase starting at word `start` of `words` ([{ text, index }] of word tokens
// separated only by spaces): → { value, end (exclusive word index), big (has hundred/thousand),
// small (a single word under 100) } or null.
function readNumber(words, start) {
  let total = 0
  let group = 0
  let last = 'none'
  let lastScale = Infinity
  let big = false
  let count = 0
  let end = start
  let i = start
  const take = (kind, value) => {
    if (kind === 'unit') {
      if (!['none', 'tens', 'hundred', 'scale'].includes(last)) return false
      group += value
    } else if (kind === 'teen' || kind === 'tens') {
      if (!['none', 'hundred', 'scale'].includes(last)) return false
      group += value
    } else if (kind === 'hundred') {
      // "three hundred", "fifteen hundred", "a hundred"; never twice in one group.
      if (!['unit', 'teen', 'tens', 'article'].includes(last) || group >= 100 || group === 0) return false
      group *= 100
      big = true
    } else if (kind === 'scale') {
      if (last === 'none' || last === 'scale' || group === 0 || value >= lastScale) return false
      total += group * value
      group = 0
      lastScale = value
      big = true
    }
    last = kind
    return true
  }
  while (i < words.length) {
    const word = words[i].text.toLowerCase()
    if (word === 'a' && last === 'none' && i + 1 < words.length && /^(hundred|thousand)$/i.test(words[i + 1].text)) {
      group = 1
      last = 'article'
      i += 1
      continue
    }
    if (word === 'and' && (last === 'hundred' || last === 'scale') && i + 1 < words.length) {
      const next = numberParts(words[i + 1].text)
      if (next && ['unit', 'teen', 'tens'].includes(next[0][0])) {
        i += 1
        continue
      }
      break
    }
    const parts = numberParts(words[i].text)
    if (!parts) break
    const saved = { total, group, last, lastScale, big }
    if (!parts.every(([kind, value]) => take(kind, value))) {
      ;({ total, group, last, lastScale, big } = saved)
      break
    }
    count += 1
    i += 1
    end = i
  }
  if (!count || last === 'article') return null
  const value = total + group
  const single = count === 1 && end - start === 1
  return { value, end, big, small: single && value < 100, pure: !big && value < 100 }
}

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// Spelled-out numbers in Daybook's text → digits. `partial` (a caption still arriving) leaves a
// number at the very end alone, since it may still grow ("two thousand" → "two thousand three…").
export function spokenNumbersToDigits(text, { partial = false } = {}) {
  const source = String(text ?? '')
  if (!/[a-z]/i.test(source)) return source
  const tokens = [...source.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*|[^A-Za-z]+/g)].map((match) => match[0])
  // Runs of words joined by single spaces; a number never crosses punctuation.
  const out = []
  let run = []
  const flush = (trailing) => {
    out.push(...convertRun(run, { partial: partial && trailing }))
    run = []
  }
  for (const token of tokens) {
    if (/^[A-Za-z]/.test(token) || (/^ +$/.test(token) && run.length)) {
      run.push(token)
      continue
    }
    flush(false)
    out.push(token)
  }
  flush(true)
  return out.join('')
}

// A run like ['two', ' ', 'thousand', ' ', 'calories'] → the same with numbers replaced.
function convertRun(run, { partial }) {
  if (!run.length) return []
  const words = []
  const spaces = []
  for (const token of run) {
    if (/^[A-Za-z]/.test(token)) words.push({ text: token })
    else spaces[words.length - 1] = token
  }
  // A trailing space stays after the last word.
  const tail = run[run.length - 1] && !/^[A-Za-z]/.test(run[run.length - 1]) ? run[run.length - 1] : ''
  const pieces = [] // [{ text, from, to }] in word positions
  let i = 0
  while (i < words.length) {
    const found = readNumber(words, i)
    if (!found) {
      pieces.push({ text: words[i].text, from: i, to: i + 1, raw: true })
      i += 1
      continue
    }
    let { end } = found
    let text = null
    const next = end < words.length ? readNumber(words, end) : null
    const lower = (at) => (at < words.length ? words[at].text.toLowerCase() : '')
    const clockHour = found.small && found.value >= 1 && found.value <= 12
    const ordinalNext = ORDINAL_WORD.test(lower(end) === 'and' ? lower(end + 1) : lower(end))
    if (ordinalNext) {
      text = null
    } else if (clockHour && lower(end) === 'oh' && Object.hasOwn(UNIT_WORDS, lower(end + 1))) {
      text = `${found.value}:0${UNIT_WORDS[lower(end + 1)]}` // "seven oh five"
      end += 2
    } else if (clockHour && next && next.pure && next.value >= 10 && next.value <= 59 && CLOCK_AFTER.has(lower(next.end))) {
      text = `${found.value}:${next.value}` // "five thirty PM"
      end = next.end
    } else if (found.small && found.value <= 9 && next && next.pure && next.value >= 10 && AMOUNT_AFTER.has(lower(next.end))) {
      text = String(found.value * 100 + next.value) // "one thirty-five pounds"
      end = next.end
    } else if (found.small && found.value <= 12 && next && next.pure && next.value >= 10) {
      // "five thirty" or "one thirty-five" with nothing saying which: left as said.
      for (let at = i; at < next.end; at += 1) pieces.push({ text: words[at].text, from: at, to: at + 1, raw: true })
      i = next.end
      continue
    } else if (found.pure && found.value >= 10 && found.value <= 20 && next && next.pure && next.value >= 10) {
      text = `${found.value}${String(next.value).padStart(2, '0')}` // "twenty twenty-six", "nineteen ninety"
      end = next.end
    } else if (found.pure && found.value >= 10 && next && next.pure && next.value >= 10) {
      // "fifty fifty": not a year, not clearly two numbers: left as said.
      for (let at = i; at < next.end; at += 1) pieces.push({ text: words[at].text, from: at, to: at + 1, raw: true })
      i = next.end
      continue
    } else if (lower(end) === 'point' && Object.hasOwn(DIGIT_WORDS, lower(end + 1))) {
      let decimals = ''
      let at = end + 1
      while (at < words.length && Object.hasOwn(DIGIT_WORDS, lower(at))) {
        decimals += DIGIT_WORDS[lower(at)]
        at += 1
      }
      text = `${grouped(found.value)}.${decimals}`
      end = at
    } else if (found.big || found.value >= 13) {
      text = grouped(found.value)
    }
    if (text === null) {
      for (let at = i; at < found.end; at += 1) pieces.push({ text: words[at].text, from: at, to: at + 1, raw: true })
      i = found.end
      continue
    }
    pieces.push({ text, from: i, to: end, raw: false, words: words.slice(i, end).map((word) => word.text) })
    i = end
  }
  // A caption still arriving: a number touching the end may still grow, so it stays as heard.
  const last = pieces[pieces.length - 1]
  if (partial && !tail && last && !last.raw) {
    pieces.pop()
    for (let at = last.from; at < last.to; at += 1) pieces.push({ text: words[at].text, from: at, to: at + 1, raw: true })
  }
  const out = []
  for (const piece of pieces) {
    out.push(piece.text)
    const space = spaces[piece.to - 1]
    if (space && piece.to < words.length) out.push(space)
  }
  if (tail) out.push(tail)
  return out
}

export function createTranscript() {
  return { past: [], order: [], items: {}, responses: {}, rev: 0 }
}

// Seeds the turns of a voice chat continued after a reload (its saved turns), so a checkpoint
// doesn't replace them with only the new ones.
export function seedTurns(state, turns) {
  const list = (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn.t === 'string' && /^[uta]$/.test(turn.r))
  state.past = list.map((turn, index) => ({
    id: String(turn.id || `seed${index}`), r: turn.r, text: turn.r === 'a' ? spokenNumbersToDigits(turn.t) : turn.t, partial: false, phase: null,
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

// Daybook's turns show numbers as digits (spokenNumbersToDigits); `raw` keeps the words as spoken
// (the echo check compares them with what the mic heard).
function currentTurns(state, { raw = false } = {}) {
  const turns = []
  for (const id of state.order) {
    const item = state.items[id]
    if (!item || item.local || item.kind !== 'message' || item.role === 'system') continue
    const r = item.role === 'user' ? (item.source === 'text' ? 't' : 'u') : 'a'
    const text = r === 'a' && !raw ? spokenNumbersToDigits(item.text, { partial: !!item.partial }) : item.text
    turns.push({
      id: item.id, r, text, partial: !!item.partial, phase: item.phase || null,
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
  const turns = [...state.past, ...currentTurns(state, { raw: true })]
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

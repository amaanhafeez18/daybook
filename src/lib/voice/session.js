// The voice chat controller: one live call at a time, kept outside React (like assistantSession.js)
// and read with useVoice(). It owns the microphone, the WebRTC link (rtc.js), the transcript
// (transcript.js), the caps and timers (policy.js), tool calls (sent to /api/voice and, for
// anything else, the full assistant), checkpoints that save the call into the chat, and the
// iPhone lifecycle (a call pauses when the app is left, a phone call or Siri takes the mic, or the
// connection drops; Continue starts a new realtime session in the same voice chat).
//
// startVoice() must be called synchronously from a tap: the microphone, the audio element and the
// AudioContext can only be unlocked inside a user's gesture on iPhone.
import { useSyncExternalStore } from 'react'
import { apiRequest, getToken, readJson, readPref, writeJson, writePref } from '../api.js'
import { getState, refresh } from '../store.js'
import { navigate, setNavigationGuard, subscribeRoute } from '../router.js'
import { getSession, sessionWriter } from '../assistantSession.js'
import { undoRefused, withKeys } from '../assistantChat.js'
import { nowTimeHHMM, todayISO } from '../dates.js'
import { toast } from '../../components/ui/feedback.jsx'
import { addRealtimeUsage, dollars, emptyTally, tallyCost, transcriptionCost } from '../aiPricing.js'
import { voicePrefs } from './prefs.js'
import {
  applyEvent, createTranscript, dropItem, lastAssistantWords, orderedTurns, seedTurns, startSegment, storedTurns, transcriptFor,
} from './transcript.js'
import { HOLD_MIN_MS, HOLD_TAIL_MS, canContinue, capCheck, isEcho, newTalkId, skipFollowUp, tapNote } from './policy.js'
import { holdWakeLock, levelMeter, primeAudio, routeOf, setAudioSession, stopStream, lastRoute, supportsVoice as audioSupported } from './audio.js'
import { connectRealtime } from './rtc.js'

export const VOICE_PREFETCH = () => import('../../components/voice/VoiceView.jsx')
export const supportsVoice = () => audioSupported()

const TRANSCRIBE_MODEL = 'gpt-transcribe'
const UNSENT_KEY = 'daybook.voice.unsent'
const CHECKPOINT_EVERY_SEC = 30
const CHECKPOINT_EVERY_TURNS = 4
const TOOLS_TIMEOUT_MS = 20000
const ASK_TIMEOUT_MS = 60000
const HEARD_WAIT_MS = 3000
const SPEECH_END_WAIT_MS = 8000
const MUTE_PAUSE_MS = 1500
const DISCONNECT_PAUSE_MS = 5000
const REFRESH_DEBOUNCE_MS = 1500
const MAX_CALLS_PER_BATCH = 8
const MAX_ACTIONS = 25
const TIMEOUT_OUTPUT = JSON.stringify({ ok: false, message: 'Daybook didn’t answer in time; it may not have saved. Offer to check.' })
const INTERRUPTED_OUTPUT = JSON.stringify({ ok: false, message: 'Not run: interrupted.' })
const START_CHIPS = [
  { id: 'plan', label: 'Plan my day', text: 'Let’s plan my day.' },
  { id: 'journal', label: 'Journal my day', text: 'Let’s do my day.', area: 'journal' },
  { id: 'food', label: 'Log food', text: 'I want to log some food.', area: 'food' },
]
const noop = () => {}

// ---- the store the screen reads -------------------------------------------------------------------

const IDLE = {
  status: 'idle', // 'idle'|'connecting'|'live'|'paused'|'ending'|'ended'|'error'
  activity: 'connecting', // 'connecting'|'listening'|'hearing'|'thinking'|'working'|'speaking'
  talkId: null, intent: 'chat', from: null,
  seconds: 0, usd: 0, mode: 'open', muted: false, holding: false, keyboard: false, quiet: false,
  route: 'speaker', error: null, pauseReason: null, endReason: null, intro: null,
  turns: [], actions: [], proposal: null, deciding: false, working: 0,
  // The last Yes/No tapped on the card: { proposalId, decision, ok, status, already, at } (the screen
  // can confirm it; Daybook says it out loud).
  ack: null,
  notice: null, warnTime: false, leftSec: null, hasUserTurn: false, startedAt: null,
  summary: null, limits: null, dailyMinutes: 30, budgetUsd: 0, spentUsd: 0, startChips: [],
}

let state = IDLE
const listeners = new Set()
let emitFrame = 0

function set(patch) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function subscribeVoice(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const getVoice = () => state
export function useVoice() {
  return useSyncExternalStore(subscribeVoice, getVoice, getVoice)
}

export const voiceLive = () => state.status === 'connecting' || state.status === 'live' || state.status === 'ending'

// ---- the call --------------------------------------------------------------------------------------
// `talk` spans the whole voice chat (all its segments); `call` is the current realtime session.

let talk = null
let call = null
let epoch = 0
let queuedRoute = null
let refreshTimer = 0
let routeUnsubscribe = null
let lastOpts = { intent: 'chat' }

function randomFn() {
  try {
    const bytes = new Uint32Array(1)
    return () => {
      crypto.getRandomValues(bytes)
      return bytes[0] / 4294967296
    }
  } catch {
    return Math.random
  }
}

function clientContext() {
  const location = readPref('location', null)
  return {
    localDate: todayISO(),
    localTime: nowTimeHHMM(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pushEnabled: null,
    ...(location && Number.isFinite(location.lat) ? { location: { lat: location.lat, lon: location.lon } } : {}),
  }
}

const settingsNow = () => getState().data?.settings || {}

function areasOn(settings) {
  const areas = settings?.areas && typeof settings.areas === 'object' ? settings.areas : {}
  return (id) => areas[id] !== false
}

const live = (c) => !!c && c === call && !c.finishing

// The screen's view of the call, at most once a frame (deltas arrive many times a second).
function scheduleEmit() {
  if (emitFrame) return
  const flush = () => {
    emitFrame = 0
    emitNow()
  }
  emitFrame = typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible'
    ? requestAnimationFrame(flush)
    : setTimeout(flush, 120)
}

function liveUsd(c = call) {
  if (!c) return 0
  const micros = (tallyCost(c.tally, c.model)?.micros || 0) + (transcriptionCost({ seconds: c.transcribeSeconds }, TRANSCRIBE_MODEL)?.micros || 0)
  return dollars(micros)
}

function deriveActivity(c) {
  if (!c || !c.connected) return 'connecting'
  if (c.speaking) return 'speaking'
  if (c.hearing || state.holding) return 'hearing'
  if (c.toolBusy > 0) return 'working'
  if (c.activeResponseId) return 'thinking'
  return 'listening'
}

function emitNow() {
  if (!talk) return
  const c = call
  const turns = orderedTurns(talk.transcript)
  const segmentUsd = c ? liveUsd(c) : 0
  set({
    turns,
    activity: c ? deriveActivity(c) : state.activity,
    seconds: Math.round(talk.priorSeconds + (c ? c.elapsed : 0)),
    usd: talk.priorUsd + segmentUsd,
    hasUserTurn: talk.hasUserTurn,
  })
}

// ---- starting --------------------------------------------------------------------------------------

function openOverlay() {
  document.documentElement.classList.add('voice-open')
  setNavigationGuard((route) => {
    if (!voiceLive()) return true
    queuedRoute = route
    return false
  })
  if (!routeUnsubscribe) {
    // Nothing should change the hash during a call (WebKit can drop the mic); if something does
    // (a notification tap), the call pauses cleanly.
    routeUnsubscribe = subscribeRoute(() => {
      if (state.status === 'live' || state.status === 'connecting') pauseVoice('navigated')
    })
  }
}

function errorState(code, message, extra = {}) {
  openOverlay()
  set({ status: 'error', error: { code, message, ...extra }, intro: null, activity: 'connecting' })
}

// Opens a voice chat. Call it synchronously inside a tap (no await before it).
//   intent: 'chat' | 'journal' | 'debrief';  from: where it was opened (for the summary's links)
//   continueTalkId: go on with that voice chat (a new segment), when it ended < 30 min ago
export function startVoice({ intent = 'chat', from = null, continueTalkId = null } = {}) {
  if (voiceLive()) return
  const opts = { intent: ['chat', 'journal', 'debrief'].includes(intent) ? intent : 'chat', from, continueTalkId }
  lastOpts = opts
  if (!readPref('voice.introSeen', false)) {
    set({ ...IDLE, intro: opts }) // the intro sheet; its Start is the tap that starts the call
    return
  }
  if (!audioSupported()) {
    errorState('unsupported', 'Voice chat needs a newer browser. You can still type or send voice notes.')
    return
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    errorState('offline', 'You’re offline. Voice chat needs a connection; typing works when you’re back.')
    return
  }
  // Inside the tap, before anything waits: sound, the call audio mode and the microphone.
  const primed = primeAudio()
  begin(primed, opts).catch((error) => {
    console.error('Voice chat failed to start', error)
    // Never leave "Connecting…" up with the mic and sound still open.
    if (call && !call.finishing) failStart(call, { code: 'connect', message: 'Couldn’t start the voice chat. Please try again.' })
    else {
      primed.micP.then(stopStream, noop)
      primed.audioCtx?.close?.().catch?.(noop)
      setAudioSession('auto')
    }
  })
}

// The first-time intro's Start button (a fresh tap).
export function startFromIntro() {
  const opts = state.intro || { intent: 'chat' }
  writePref('voice.introSeen', true)
  set({ intro: null })
  startVoice(opts)
}

export function cancelIntro() {
  if (!state.intro) return
  closeVoice()
}

// "Try again" after an error (a tap).
export function retryVoice() {
  startVoice(lastOpts)
}

// Continue a paused or ended voice chat (a tap).
export function continueVoice() {
  if (!talk) return
  startVoice({ intent: talk.intent, from: talk.from, continueTalkId: talk.talkId })
}

function newTalk({ talkId, intent, from }) {
  const transcript = createTranscript()
  const saved = getSession().messages?.find?.((message) => message?.talk?.id === talkId)?.talk
  if (saved) seedTurns(transcript, saved.turns)
  return {
    talkId,
    intent,
    from,
    startedAt: saved?.startedAt || new Date().toISOString(),
    transcript,
    priorSeconds: Number(saved?.seconds) || 0,
    priorUsd: Number(saved?.usd) || 0,
    hasUserTurn: !!saved?.turns?.some?.((turn) => turn?.r === 'u' || turn?.r === 't'),
    actions: Array.isArray(saved?.actions) ? saved.actions : [],
    proposal: null,
  }
}

async function begin(primed, { intent, from, continueTalkId }) {
  const myEpoch = ++epoch
  const continuing = !!continueTalkId
  const pausedFor = continuing && talk?.talkId === continueTalkId ? state.endReason || state.pauseReason || '' : ''
  if (continuing && talk?.talkId === continueTalkId) {
    startSegment(talk.transcript)
  } else {
    talk = newTalk({ talkId: continuing ? continueTalkId : newTalkId(randomFn()), intent, from })
  }
  teardown(call)
  const settings = settingsNow()
  const prefs = safely(() => voicePrefs(settings), {}) || {}
  const mode = readPref('voice.mode', 'open') === 'hold' ? 'hold' : 'open'
  const routeHint = lastRoute()
  const c = {
    epoch: myEpoch,
    abort: new AbortController(),
    audioCtx: primed.audioCtx,
    audioEl: primed.audioEl,
    stream: null, micTrack: null, micMeter: null, remoteMeter: null, remoteStream: null,
    rtc: null, sessionId: null, model: 'gpt-realtime-2.1-mini', limits: null, budget: null,
    monthBase: 0, liveAtBase: 0, dailyAt: 0,
    tally: safely(emptyTally, {}), transcribeSeconds: 0, seq: 0, lastCheckpointAt: 0, turnsAtCheckpoint: 0,
    checkpointChain: Promise.resolve(),
    activeResponseId: null, pendingCreate: null, greeting: true, speaking: false, hearing: false,
    responseUser: {}, lastUserItemId: null, lastTurnTyped: false, echoSnap: {},
    toolQueue: Promise.resolve(), toolBusy: 0, idleSec: 0, elapsed: 0, ticker: 0, wakeRelease: noop,
    echoCount: 0, warned: {}, timers: new Set(), stopWaiters: new Set(), heardWaiters: new Map(),
    holdStartAt: 0, connected: false, finishing: false, mode, route: routeHint, lastDeltaAt: 0, zeroSince: 0,
    cleanup: [], turnDetection: null, intent,
  }
  call = c
  openOverlay()
  set({
    ...IDLE,
    status: 'connecting', activity: 'connecting', talkId: talk.talkId, intent, from,
    mode, quiet: readPref('voice.quiet', false) === true, route: routeHint, startedAt: talk.startedAt,
    actions: talk.actions, proposal: talk.proposal, dailyMinutes: prefs.dailyMinutes || 30,
    startChips: START_CHIPS.filter((chip) => !chip.area || areasOn(settings)(chip.area)),
  })
  emitNow()

  const mintBody = { talkId: talk.talkId, continue: continuing, intent, mode, routeHint, ...(pausedFor ? { reason: pausedFor } : {}), context: clientContext() }
  const mint = () => apiRequest('/api/voice?op=start', { method: 'POST', body: mintBody, signal: c.abort.signal })
  const mintP = mint()
  mintP.catch(noop)

  // The microphone (the permission prompt overlaps the mint).
  let stream
  try {
    stream = await primed.micP
  } catch (error) {
    if (!live(c)) return
    c.abort.abort()
    failStart(c, micError(error))
    return
  }
  if (!live(c)) {
    stopStream(stream)
    return
  }
  c.stream = stream
  c.micTrack = stream.getAudioTracks()[0] || null
  if (!c.micTrack) {
    failStart(c, { code: 'mic_failed', message: 'No microphone was found.' })
    return
  }
  c.route = routeOf(c.micTrack)
  writePref('voice.lastRoute', c.route)
  c.micMeter = levelMeter(c.audioCtx, stream)
  c.micTrack.enabled = mode === 'open'
  watchTrack(c)
  set({ route: c.route })

  const applyMint = (minted) => {
    c.minted = minted
    c.sessionId = minted.sessionId || c.sessionId
    if (minted.talkId && minted.talkId !== talk.talkId) talk.talkId = minted.talkId
    c.model = minted.model || c.model
    c.mintedAt = Date.now()
    c.limits = {
      sessionSec: numberOr(minted.limits?.sessionSec, 15 * 60),
      dailyLeftSec: numberOr(minted.limits?.dailyLeftSec, Infinity),
      silenceSec: numberOr(minted.limits?.silenceSec, 60),
    }
    c.budget = { usd: numberOr(minted.budget?.usd, 0), monthUsd: numberOr(minted.budget?.monthUsd, 0) }
    c.monthBase = c.budget.monthUsd
    c.liveAtBase = 0
    c.dailyAt = 0
    c.turnDetection = minted.turnDetection || null
    if (minted.continued && isNumber(minted.priorUsd)) talk.priorUsd = minted.priorUsd // the server's sum of the earlier segments
    // Continued after a reload: the saved turns (the chat's cache keeps only the newest), so a
    // checkpoint never replaces them with fewer.
    if (minted.continued && Array.isArray(minted.turns) && minted.turns.length > talk.transcript.past.length && !talk.transcript.order.length) {
      seedTurns(talk.transcript, minted.turns)
    }
    if (minted.pending && typeof minted.pending === 'object') setProposal(minted.pending)
    set({ limits: c.limits, budgetUsd: c.budget.usd, talkId: talk.talkId })
    return minted
  }

  let rtc
  try {
    rtc = await connectRealtime({
      getSecret: async (attempt) => {
        const minted = attempt === 0 ? await mintP : await mint()
        if (!live(c)) throw new Error('stopped')
        applyMint(minted)
        if (!minted.clientSecret) throw Object.assign(new Error('The voice service didn’t start.'), { code: 'setup' })
        return { clientSecret: minted.clientSecret }
      },
      micTrack: c.micTrack,
      audioEl: c.audioEl,
      onEvent: (event) => onEvent(c, event),
      onState: (connection) => onConnection(c, connection),
      signal: c.abort.signal,
    })
  } catch (error) {
    if (!live(c)) return
    failStart(c, mintError(error))
    return
  }
  if (!live(c)) {
    rtc.close()
    return
  }
  c.rtc = rtc
  c.connected = true

  // The day's context and the opening line, then the greeting. Appended items (never new
  // instructions) keep the prompt cache warm.
  systemItem(c, c.minted?.contextText)
  systemItem(c, c.minted?.opening)
  send(c, { type: 'response.create' })
  if (c.route === 'headphones' && routeHint !== 'headphones') {
    send(c, { type: 'session.update', session: { type: 'realtime', audio: { input: { noise_reduction: { type: 'near_field' } } } } })
  } else if (c.route !== 'headphones' && routeHint === 'headphones') {
    send(c, { type: 'session.update', session: { type: 'realtime', audio: { input: { noise_reduction: { type: 'far_field' } } } } })
  }
  // A touch device keeps its screen on; a computer doesn't need it.
  if (window.matchMedia?.('(pointer: coarse)').matches) holdWakeLock().then((release) => {
    if (live(c)) c.wakeRelease = release
    else release()
  })
  c.ticker = setInterval(() => tick(c), 1000)
  set({ status: 'live' })
  emitNow()
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function numberOr(value, fallback) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value)
}

function safely(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function micError(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { code: 'mic_denied', message: 'Microphone is blocked for Daybook. On iPhone: Settings → Apps → Safari → Microphone → Allow.' }
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return { code: 'mic_busy', message: 'Another app is using the mic.' }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { code: 'mic_failed', message: 'No microphone was found.' }
  return { code: 'mic_failed', message: 'The microphone didn’t start. Please try again.' }
}

function mintError(error) {
  const code = error?.payload?.code || error?.code
  if (['off', 'daily', 'budget', 'setup', 'busy'].includes(code)) return { code, message: error.message }
  if (error?.status === 0) return { code: 'offline', message: 'You’re offline. Voice chat needs a connection; typing works when you’re back.' }
  if (code === 'invalid_offer') return { code: 'unsupported', message: error.message }
  return { code: 'connect', message: error?.message && error.message !== 'stopped' ? error.message : 'Couldn’t start the voice chat. Please try again.' }
}

function failStart(c, error) {
  teardown(c)
  if (c === call) call = null
  errorState(error.code, error.message)
}

// ---- events ------------------------------------------------------------------------------------------

function send(c, event) {
  return !!c?.rtc && c.rtc.send(event)
}

function systemItem(c, text) {
  if (!text) return
  send(c, { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: String(text) }] } })
}

function replyOptions(c) {
  return state.quiet && c.lastTurnTyped ? { output_modalities: ['text'] } : null
}

// One response.create: now, or once the active response has finished.
function requestResponse(c, options = replyOptions(c)) {
  if (!live(c)) return
  if (c.activeResponseId) {
    c.pendingCreate = options || true
    return
  }
  c.pendingCreate = null
  c.lastCreate = options || true
  c.createSentAt = Date.now()
  send(c, options ? { type: 'response.create', response: options } : { type: 'response.create' })
}

function cancelResponse(c) {
  if (c.activeResponseId) send(c, { type: 'response.cancel' })
  if (c.speaking) send(c, { type: 'output_audio_buffer.clear' })
}

function turnDetection(c, mode, { interrupt }) {
  if (mode === 'hold') return null
  const base = c.turnDetection?.open && typeof c.turnDetection.open === 'object'
    ? c.turnDetection.open
    : { type: 'semantic_vad', eagerness: c.intent === 'journal' || c.intent === 'debrief' ? 'low' : 'medium', create_response: true }
  return { ...base, interrupt_response: interrupt }
}

function sendTurnDetection(c) {
  send(c, { type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: turnDetection(c, c.mode, { interrupt: !c.greeting }) } } } })
}

function onEvent(c, event) {
  if (!live(c)) return
  applyEvent(talk.transcript, event)
  const type = event.type
  switch (type) {
    case 'session.created':
      c.connected = true
      break
    case 'input_audio_buffer.speech_started':
      c.hearing = true
      c.idleSec = 0
      break
    case 'input_audio_buffer.speech_stopped':
      c.hearing = false
      break
    case 'input_audio_buffer.committed':
      c.hearing = false
      if (event.item_id) {
        c.lastUserItemId = event.item_id
        c.lastTurnTyped = false
        c.echoSnap[event.item_id] = lastAssistantWords(talk.transcript, 30)
        markUserTurn(c)
      }
      break
    case 'conversation.item.added':
    case 'conversation.item.created': {
      const item = event.item
      if (item?.role === 'user' && item.type === 'message' && item.content?.some?.((part) => part?.type === 'input_text')) {
        c.lastUserItemId = item.id
        c.lastTurnTyped = true
        markUserTurn(c)
        resolveHeard(c, item.id)
      }
      break
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const usage = event.usage
      if (usage?.type === 'duration') c.transcribeSeconds += Math.max(0, Number(usage.seconds) || 0)
      else if (usage?.type === 'tokens') c.transcribeSeconds += Math.max(0, Number(usage.input_token_details?.audio_tokens) || 0) / 10
      // The echo check first: a waiting tool batch must know the turn was Daybook's own voice.
      checkEcho(c, event.item_id, String(event.transcript || ''))
      resolveHeard(c, event.item_id)
      break
    }
    case 'conversation.item.input_audio_transcription.failed':
      resolveHeard(c, event.item_id)
      break
    case 'response.created': {
      const id = event.response?.id
      if (id) {
        c.activeResponseId = id
        c.responseUser[id] = c.lastUserItemId
      }
      c.createSentAt = 0
      c.idleSec = 0
      break
    }
    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
      c.lastDeltaAt = performance.now()
      break
    case 'output_audio_buffer.started':
      c.speaking = true
      c.idleSec = 0
      break
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      c.speaking = false
      c.idleSec = 0
      for (const resolve of c.stopWaiters) resolve()
      c.stopWaiters.clear()
      if (c.greeting) endGreeting(c)
      break
    case 'response.done':
      onResponseDone(c, event.response || {})
      break
    case 'error':
      onError(c, event.error || {})
      break
    default:
      break
  }
  scheduleEmit()
}

function markUserTurn(c) {
  c.idleSec = 0
  talk.hasUserTurn = true
}

// After the greeting has played, open mic may interrupt Daybook again (it couldn't during the
// greeting, so the speaker's echo can't cut it off).
function endGreeting(c) {
  c.greeting = false
  if (c.mode === 'open') sendTurnDetection(c)
}

function onResponseDone(c, response) {
  c.tally = safely(() => addRealtimeUsage(c.tally, response.usage || {}), c.tally)
  if (!response.id || response.id === c.activeResponseId) c.activeResponseId = null
  const calls = (Array.isArray(response.output) ? response.output : []).filter((item) => item?.type === 'function_call')
  if (c.greeting && !c.speaking && !hasAudio(response)) endGreeting(c) // a greeting with no sound: no guard to keep
  if (response.status === 'cancelled' || response.status === 'failed') {
    for (const item of calls) {
      send(c, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: INTERRUPTED_OUTPUT } })
    }
  } else {
    const ready = calls.filter((item) => item.status === 'completed' || !item.status)
    if (ready.length) {
      enqueueCalls(c, ready, response.id)
      return // the batch's own response.create follows its outputs
    }
  }
  if (c.pendingCreate && !c.activeResponseId) {
    const options = c.pendingCreate === true ? null : c.pendingCreate
    c.pendingCreate = null
    c.createSentAt = Date.now()
    send(c, options ? { type: 'response.create', response: options } : { type: 'response.create' })
  }
  maybeCheckpoint(c)
}

function hasAudio(response) {
  return (Array.isArray(response.output) ? response.output : []).some((item) => (Array.isArray(item?.content) ? item.content : [])
    .some((part) => part?.type === 'output_audio' || part?.type === 'audio'))
}

let lastErrorNotice = 0
function onError(c, error) {
  const code = String(error.code || error.type || '')
  c.createSentAt = 0
  if (code === 'conversation_already_has_active_response') {
    c.pendingCreate = c.pendingCreate || c.lastCreate || true
    return
  }
  if (/commit_empty|cancel_not_active|response_cancel|item_delete|buffer_too_small/.test(code)) return
  console.warn('Voice chat error', code, error.message)
  if (/session|expired/i.test(code)) {
    finishSegment(c, 'error')
    return
  }
  if (Date.now() - lastErrorNotice > 10000) {
    lastErrorNotice = Date.now()
    flashNotice('error', error.message ? `Voice hiccup: ${error.message}` : 'Something went wrong in the voice chat.', 4000)
  }
}

// ---- the echo guard ------------------------------------------------------------------------------------
// Open mic on the phone speaker can hear Daybook itself. A finished transcript that matches what
// Daybook just said is taken out (with the reply it started), and a second one offers Hold to talk.

function checkEcho(c, itemId, text) {
  if (!itemId || c.mode !== 'open' || c.route === 'headphones') return
  const said = c.echoSnap[itemId]
  delete c.echoSnap[itemId]
  if (!said?.length || !isEcho(text, said)) return
  c.echoed = c.echoed || new Set()
  c.echoed.add(itemId)
  const record = Object.entries(c.responseUser).find(([, user]) => user === itemId)
  const responseId = record?.[0]
  if (responseId && responseId === c.activeResponseId) cancelResponse(c)
  send(c, { type: 'conversation.item.delete', item_id: itemId })
  dropItem(talk.transcript, itemId)
  const items = responseId ? talk.transcript.responses[responseId]?.items || [] : []
  for (const id of items) {
    if (talk.transcript.items[id]?.kind === 'function_call') continue
    send(c, { type: 'conversation.item.delete', item_id: id })
    dropItem(talk.transcript, id)
  }
  c.echoCount += 1
  if (c.echoCount >= 2 && !c.warned.echo) {
    c.warned.echo = true
    showNotice({ id: 'echo', text: 'Sounds like I’m hearing myself. Switch to Hold to talk?', action: 'switch' })
  }
}

// ---- tool calls ----------------------------------------------------------------------------------------

function enqueueCalls(c, calls, responseId) {
  c.toolBusy += 1
  scheduleEmit()
  c.toolQueue = c.toolQueue
    .then(() => runCalls(c, calls, responseId))
    .catch((error) => console.error('Voice tool batch failed', error))
    .finally(() => {
      c.toolBusy = Math.max(0, c.toolBusy - 1)
      c.idleSec = 0
      scheduleEmit()
    })
}

function waitHeard(c, itemId, ms) {
  const now = transcriptFor(talk.transcript, itemId)
  if (!itemId || now.done) return Promise.resolve(now.text)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      c.heardWaiters.delete(itemId)
      resolve(transcriptFor(talk.transcript, itemId).text)
    }
    const timer = setTimeout(done, ms)
    c.heardWaiters.set(itemId, done)
  })
}

function resolveHeard(c, itemId) {
  const waiter = itemId && c.heardWaiters.get(itemId)
  if (waiter) waiter()
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const value = JSON.parse(String(raw || '{}'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return null
  }
}

async function runCalls(c, calls, responseId) {
  if (!live(c)) return
  const heardItemId = c.responseUser[responseId] ?? c.lastUserItemId
  const heard = await waitHeard(c, heardItemId, HEARD_WAIT_MS)
  if (!live(c)) return
  // The "user turn" was Daybook's own read-back coming through the speaker: run nothing (a yes in it
  // must never confirm the card) and don't ask for another reply.
  if (heardItemId && c.echoed?.has(heardItemId)) {
    for (const item of calls) {
      send(c, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify({ ok: false, message: 'Not run: that was Daybook’s own voice.' }) } })
    }
    return
  }
  const outputs = new Map()
  let endCall = false
  const serverCalls = calls.filter((item) => item.name !== 'end_call' && item.name !== 'ask_daybook')
  for (let start = 0; start < serverCalls.length; start += MAX_CALLS_PER_BATCH) {
    const batch = serverCalls.slice(start, start + MAX_CALLS_PER_BATCH)
    try {
      const result = await apiRequest('/api/voice?op=tools', {
        method: 'POST',
        body: {
          talkId: talk.talkId, sessionId: c.sessionId, heard, heardItemId, startedAt: talk.startedAt, mode: c.mode, intent: talk.intent,
          calls: batch.map((item) => ({ callId: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) })),
          context: clientContext(),
        },
        signal: timeoutSignal(TOOLS_TIMEOUT_MS),
      })
      for (const output of Array.isArray(result?.outputs) ? result.outputs : []) {
        if (output?.callId) outputs.set(output.callId, typeof output.output === 'string' ? output.output : JSON.stringify(output.output ?? { ok: true }))
      }
      applyResult(result) // the refreshed Today lines (todayNow) ride inside an output
    } catch (error) {
      const timedOut = error?.status === 408 || error?.name === 'TimeoutError'
      for (const item of batch) outputs.set(item.call_id, timedOut ? TIMEOUT_OUTPUT : JSON.stringify({ ok: false, message: error?.message || 'That didn’t work.' }))
    }
    if (!live(c)) return
  }
  for (const item of calls) {
    if (item.name === 'end_call') {
      endCall = true
      outputs.set(item.call_id, JSON.stringify({ ok: true }))
    } else if (item.name === 'ask_daybook') {
      outputs.set(item.call_id, await askDaybook(c, parseArgs(item.arguments), heardItemId))
      if (!live(c)) return
    }
  }
  for (const item of calls) {
    send(c, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: outputs.get(item.call_id) || JSON.stringify({ ok: false, message: 'Not run.' }) } })
  }
  // Like the text assistant: when every call was staged cleanly and Daybook already asked whether to
  // go ahead in this response, it doesn't read the card back a second time.
  const said = responseSpeech(responseId)
  const quietAfter = skipFollowUp({ calls: calls.map((item) => ({ name: item.name, output: outputs.get(item.call_id) })), said })
  // (A reply queued meanwhile, like a typed turn, still goes out.)
  if (!(calls.length === 1 && endCall) && (!quietAfter || c.pendingCreate)) requestResponse(c)
  if (endCall) {
    waitForSpeechEnd(c, SPEECH_END_WAIT_MS).then(() => {
      if (live(c)) finishSegment(c, 'user')
    })
  }
}

// What Daybook said (as heard) in one response.
function responseSpeech(responseId) {
  const record = responseId ? talk?.transcript.responses[responseId] : null
  if (!record) return ''
  return record.items.map((id) => talk.transcript.items[id]).filter((item) => item?.kind === 'message' && item.role === 'assistant')
    .map((item) => String(item.text || '').trim()).filter(Boolean).join(' ')
}

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

// The full text assistant, for anything the voice tools don't cover. Its messages are saved with
// `via` (hidden in the chat; the voice chat item stands for them).
async function askDaybook(c, args, heardItemId = null) {
  const request = String(args?.request || '').trim()
  if (!request) return JSON.stringify({ ok: false, message: 'Say what to ask Daybook in one sentence.' })
  set({ working: state.working + 1 })
  // A hand-off settles every card still waiting (the full assistant starts a new turn): if this call's
  // card was waiting, the model is told it's gone, so it doesn't ask for a yes to it later.
  const waitingBefore = talk.proposal?.status === 'pending' ? talk.proposal : null
  try {
    await Promise.race([checkpoint(c).catch(noop), new Promise((resolve) => setTimeout(resolve, 4000))])
    const reply = await apiRequest('/api/assistant', {
      method: 'POST',
      // The turn that asked: a card staged by this hand-off takes a spoken yes only in a later turn.
      body: { message: request.slice(0, 2000), spoken: true, via: { talk: talk.talkId, ...(heardItemId ? { turn: String(heardItemId).slice(0, 80) } : {}) }, context: clientContext(), stream: false },
      signal: timeoutSignal(ASK_TIMEOUT_MS),
    })
    applyResult({ actions: reply?.actions, proposal: reply?.proposal, proposalUpdate: reply?.proposalUpdate, dataChanged: reply?.dataChanged })
    const waiting = Array.isArray(reply?.proposal?.actions) ? reply.proposal.actions.map((action) => action?.label).filter(Boolean) : []
    const done = Array.isArray(reply?.actions) ? reply.actions.map((action) => action?.message).filter(Boolean) : []
    const replaced = waitingBefore && reply?.proposal?.id !== waitingBefore.id ? waitingBefore : null
    if (replaced) patchProposal({ id: replaced.id, status: 'superseded' })
    return JSON.stringify({
      ok: true,
      reply: String(reply?.reply || '').slice(0, 600),
      ...(waiting.length ? { waiting_for_yes: waiting } : {}),
      ...(done.length ? { done } : {}),
      ...(replaced ? { replaced: `${String(replaced.summary || 'The change that was waiting').slice(0, 200)}: no longer waiting and not saved. Stage it again if they still want it.` } : {}),
      ...(Array.isArray(reply?.choices) && reply.choices.length ? { choices: reply.choices.slice(0, 6) } : {}),
    })
  } catch (error) {
    const timedOut = error?.status === 408 || error?.name === 'TimeoutError'
    return timedOut ? TIMEOUT_OUTPUT : JSON.stringify({ ok: false, message: error?.message || 'Daybook couldn’t do that.' })
  } finally {
    set({ working: Math.max(0, state.working - 1) })
  }
}

// What a tool batch, a tap or a hand-off returned: chips, the card waiting for a yes, fresh data.
function applyResult(result) {
  if (!result || typeof result !== 'object' || !talk) return
  const chips = (Array.isArray(result.actions) ? result.actions : []).filter((action) => action && typeof action === 'object' && action.message)
  if (chips.length) {
    const known = new Set(talk.actions.map((action) => action.undoId).filter(Boolean))
    const added = chips.filter((action) => !action.undoId || !known.has(action.undoId))
    talk.actions = [...talk.actions, ...added].slice(-MAX_ACTIONS)
    set({ actions: talk.actions })
  }
  // A spoken "undo that" (undo_last): those chips now read "Undone", here and in the chat.
  const undone = (Array.isArray(result.undone) ? result.undone : []).filter((id) => typeof id === 'string' && id)
  if (undone.length) {
    for (const id of undone) patchChip(id, { undone: true })
    const gone = new Set(undone)
    sessionWriter().setMessages((list) => list.map((message) => (message?.actions?.some?.((action) => gone.has(action.undoId))
      ? { ...message, actions: message.actions.map((action) => (gone.has(action.undoId) ? { ...action, undone: true } : action)) }
      : message)))
  }
  if (result.proposal && typeof result.proposal === 'object' && result.proposal.id) setProposal(result.proposal)
  if (result.proposalUpdate && typeof result.proposalUpdate === 'object') patchProposal(result.proposalUpdate)
  if (result.dataChanged) refreshSoon()
}

function setProposal(proposal) {
  talk.proposal = { ...proposal, createdAt: proposal.createdAt || new Date().toISOString() }
  set({ proposal: talk.proposal })
}

function patchProposal(update) {
  if (!talk?.proposal) return
  if (update.id && update.id !== talk.proposal.id) return
  talk.proposal = { ...talk.proposal, ...update }
  set({ proposal: talk.proposal })
}

function refreshSoon() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => refresh().catch(noop), REFRESH_DEBOUNCE_MS)
}

function waitForSpeechEnd(c, ms) {
  return new Promise((resolve) => {
    let quiet = null
    const finish = () => {
      clearTimeout(cap)
      clearInterval(quiet)
      c.stopWaiters.delete(finish)
      resolve()
    }
    const cap = setTimeout(finish, ms)
    c.stopWaiters.add(finish)
    // Not speaking (and nothing about to be): done once that has held for a moment.
    let calm = 0
    quiet = setInterval(() => {
      calm = c.speaking || c.activeResponseId ? 0 : calm + 1
      if (calm >= 3) finish()
    }, 250)
  })
}

// ---- the 1 s ticker: time, caps, silence, checkpoints ------------------------------------------------

function tick(c) {
  if (!live(c) || state.status !== 'live') return
  c.elapsed += 1
  const busy = c.hearing || c.speaking || !!c.activeResponseId || c.toolBusy > 0 || state.keyboard || state.holding || state.working > 0
  c.idleSec = busy ? 0 : c.idleSec + 1
  const usdNow = liveUsd(c)
  const spentUsd = c.monthBase + Math.max(0, usdNow - c.liveAtBase)
  const check = capCheck({
    elapsedSec: c.elapsed,
    sessionSec: c.limits?.sessionSec,
    dailyLeftSec: c.limits?.dailyLeftSec,
    dailyAt: c.dailyAt,
    spentUsd,
    budgetUsd: c.budget?.usd || 0,
    idleSec: c.idleSec,
    silenceSec: c.limits?.silenceSec || 60,
    busy,
  })
  c.lastCheck = check
  if (check.warnTime && !c.warned.time) {
    c.warned.time = true
    systemItem(c, 'About a minute left in this call; wrap up naturally.')
  }
  if (check.warnBudget && !c.warned.budget && !check.end) {
    c.warned.budget = true
    showNotice({ id: 'budget', text: `You’ve used 80% of this month’s $${formatBudget(c.budget.usd)} AI budget.`, tone: 'warn' })
  }
  if (check.warnSilence && !check.end) {
    if (state.notice?.id !== 'silence') showNotice({ id: 'silence', text: `Still there? Hanging up in ${check.idleLeftSec} s`, action: 'keep' })
    else set({ notice: { ...state.notice, text: `Still there? Hanging up in ${check.idleLeftSec} s` } })
  } else if (state.notice?.id === 'silence') {
    set({ notice: null })
  }
  set({ warnTime: check.warnTime || (!!check.end && check.end !== 'quiet'), leftSec: check.leftSec, spentUsd })
  if (check.end && !c.ending) {
    c.ending = true
    if (check.end === 'budget') systemItem(c, 'This month’s AI budget is used up, so the call is ending now.')
    const wait = check.end === 'quiet' ? Promise.resolve() : waitForSpeechEnd(c, SPEECH_END_WAIT_MS)
    wait.then(() => {
      if (live(c)) finishSegment(c, check.end)
    })
    return
  }
  maybeCheckpoint(c)
  scheduleEmit()
}

function formatBudget(usd) {
  const value = Number(usd) || 0
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// "Keep going" on the "Still there?" bar.
export function keepGoing() {
  if (call) call.idleSec = 0
  if (state.notice?.id === 'silence') set({ notice: null })
}

let noticeTimer = 0
function showNotice(notice) {
  clearTimeout(noticeTimer)
  set({ notice })
}
function flashNotice(id, text, ms = 2500) {
  showNotice({ id, text, tone: 'hint' })
  noticeTimer = setTimeout(() => {
    if (state.notice?.id === id) set({ notice: null })
  }, ms)
}
export function dismissNotice() {
  if (state.notice?.id === 'silence') keepGoing()
  set({ notice: null })
}

// ---- checkpoints: the transcript and usage, saved into the chat as the call goes -------------------

function checkpointBody(c, { final = false, end = null } = {}) {
  const { turns } = storedTurns(orderedTurns(talk.transcript), { state: talk.transcript })
  c.seq += 1
  return {
    talkId: talk.talkId,
    sessionId: c.sessionId,
    seq: c.seq,
    startedAt: talk.startedAt,
    seconds: Math.round(c.elapsed),
    turns,
    tally: { ...c.tally }, // a copy: a queued checkpoint must carry the usage as it was when it was made
    transcribeSeconds: Math.round(c.transcribeSeconds * 10) / 10,
    final,
    end,
    mode: c.mode,
    intent: talk.intent,
  }
}

function maybeCheckpoint(c) {
  if (!live(c) || !c.sessionId) return
  const turnCount = orderedTurns(talk.transcript).length
  if (c.elapsed - c.lastCheckpointAt >= CHECKPOINT_EVERY_SEC || turnCount - c.turnsAtCheckpoint >= CHECKPOINT_EVERY_TURNS) {
    checkpoint(c).catch(noop)
  }
}

// Sent one after another, so an older body never lands after a newer one.
function checkpoint(c, { final = false, end = null, keepalive = false } = {}) {
  if (!c?.sessionId || !talk) return Promise.resolve(null)
  c.lastCheckpointAt = c.elapsed
  c.turnsAtCheckpoint = orderedTurns(talk.transcript).length
  const body = checkpointBody(c, { final, end })
  const usdAtSend = liveUsd(c)
  const elapsedAtSend = c.elapsed
  writeJson(UNSENT_KEY, { body, at: Date.now() })
  const post = () => (keepalive ? postKeepalive(body) : apiRequest('/api/voice?op=checkpoint', { method: 'POST', body }))
  const run = c.checkpointChain.then(post, post).then((result) => {
    clearUnsent(body)
    if (result && typeof result === 'object') {
      if (isNumber(result.monthUsd)) {
        c.monthBase = Number(result.monthUsd)
        c.liveAtBase = usdAtSend
      }
      if (isNumber(result.dailyLeftSec) && c.limits) {
        c.limits = { ...c.limits, dailyLeftSec: Number(result.dailyLeftSec) }
        c.dailyAt = elapsedAtSend
      }
    }
    return result
  })
  c.checkpointChain = run.catch(noop)
  return run
}

function clearUnsent(body) {
  const stored = readJson(UNSENT_KEY, null)
  if (stored?.body?.talkId === body.talkId && stored.body.sessionId === body.sessionId && stored.body.seq <= body.seq) {
    try {
      localStorage.removeItem(UNSENT_KEY)
    } catch {
      // ignore
    }
  }
}

// A request that finishes even while the page is going away (keepalive bodies stay under 64 KB).
async function postKeepalive(body) {
  const token = getToken()
  const response = await fetch('/api/voice?op=checkpoint', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`checkpoint ${response.status}`)
  return response.json().catch(() => ({}))
}

// A checkpoint the app couldn't send before it closed (VoiceHost, at launch). Billing is cumulative,
// so a repeat never counts twice.
export async function flushUnsent() {
  const stored = readJson(UNSENT_KEY, null)
  if (!stored?.body || voiceLive() || !getToken()) return
  if (Date.now() - (Number(stored.at) || 0) > 24 * 60 * 60 * 1000) {
    clearUnsent(stored.body)
    return
  }
  try {
    const result = await apiRequest('/api/voice?op=checkpoint', { method: 'POST', body: { ...stored.body, final: true, end: stored.body.end || 'background' } })
    clearUnsent(stored.body)
    if (result?.message) mergeTalkMessage(result.message)
  } catch (error) {
    // Refused for good (unknown call, bad body): drop it. Offline: try again next launch.
    if (error?.status >= 400 && error.status < 500) clearUnsent(stored.body)
  }
}

// The saved voice chat goes into the chat at once (the Assistant page reloads its history later and
// matches it by talk id).
function mergeTalkMessage(message) {
  if (!message?.talk?.id) return
  sessionWriter().setMessages((list) => {
    const at = list.findIndex((item) => item?.talk?.id === message.talk.id)
    if (at >= 0) {
      const next = list.slice()
      next[at] = { ...message, id: list[at].id }
      return next
    }
    return withKeys([...list, message])
  })
}

// ---- ending and pausing ------------------------------------------------------------------------------

// The segment ends: a last checkpoint (it saves the chat item and bills the call), everything closes.
// Pause reasons leave a Continue; the others show the summary.
const PAUSES = new Set(['background', 'interrupted', 'network', 'navigated'])

function finishSegment(c, reason) {
  if (!c || c.finishing) return
  const pause = PAUSES.has(reason)
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const hasSession = !!c.sessionId && c.connected
  const usd = liveUsd(c)
  const dailyLeftSec = Number.isFinite(c.limits?.dailyLeftSec) ? c.limits.dailyLeftSec - Math.max(0, c.elapsed - c.dailyAt) : Infinity
  const continuable = canContinue(reason, { dailyLeftSec, budgetPct: c.lastCheck?.budgetPct || 0 })
  // The last checkpoint, once more after a moment if it didn't go through (and the app is still
  // open; otherwise VoiceHost sends the copy kept on the device at the next launch).
  const final = hasSession
    ? checkpoint(c, { final: true, end: reason, keepalive: hidden || pause }).catch(() => (document.visibilityState === 'hidden'
      ? Promise.reject(new Error('hidden'))
      : new Promise((resolve) => setTimeout(resolve, 2000)).then(() => checkpoint(c, { final: true, end: reason }))))
    : Promise.resolve(null)
  c.finishing = true
  teardown(c)
  talk.priorSeconds += c.elapsed
  talk.priorUsd += usd
  call = null
  const turns = orderedTurns(talk.transcript)
  set({
    status: pause ? 'paused' : 'ending',
    pauseReason: pause ? reason : null,
    endReason: reason,
    holding: false,
    keyboard: false,
    notice: null,
    warnTime: false,
    turns,
    seconds: Math.round(talk.priorSeconds),
    usd: talk.priorUsd,
    summary: {
      seconds: Math.round(talk.priorSeconds), usd: talk.priorUsd, end: reason, saved: null,
      canContinue: continuable,
      empty: !talk.hasUserTurn && !talk.actions.length,
    },
  })
  final.then((result) => {
    // The next look at the usage (Settings, the start screen) fetches the new spend (loaded on
    // demand, so the usage code stays out of the app's first download).
    import('../aiUsageClient.js').then((usage) => usage.staleAiUsage(), noop)
    if (result?.message) mergeTalkMessage(result.message)
    if (state.talkId === talk?.talkId && state.summary) {
      set({ summary: { ...state.summary, saved: true }, ...(state.status === 'ending' ? { status: 'ended' } : {}) })
    }
  }, () => {
    if (state.talkId === talk?.talkId && state.summary) {
      set({ summary: { ...state.summary, saved: false }, ...(state.status === 'ending' ? { status: 'ended' } : {}) })
    }
  })
  // The summary shows within a moment even if the save is slow (it keeps trying in the background).
  setTimeout(() => {
    if (state.status === 'ending' && state.talkId === talk?.talkId) set({ status: 'ended' })
  }, 2500)
  refreshSoon()
}

function pauseVoice(reason) {
  if (call && (state.status === 'live' || state.status === 'connecting')) {
    if (!call.connected || !call.sessionId) {
      // Still connecting: nothing to save yet.
      const c = call
      c.finishing = true
      teardown(c)
      call = null
      set({ status: 'paused', pauseReason: reason, endReason: reason, summary: { seconds: Math.round(talk?.priorSeconds || 0), usd: talk?.priorUsd || 0, end: reason, saved: true, canContinue: true, empty: true } })
      return
    }
    finishSegment(call, reason)
  }
}

// Ends the call (End button, Esc, the model's goodbye, a cap). From a paused call it shows the
// summary; from the summary it closes.
export function endVoice(reason = 'user') {
  if (state.status === 'connecting') {
    closeVoice() // nothing was said yet: nothing to save
    return
  }
  if (state.status === 'live' && call) {
    finishSegment(call, reason)
    return
  }
  if (state.status === 'paused') {
    set({ status: 'ended' })
    return
  }
  closeVoice()
}

// The overlay goes away (Done, Type instead, Settings). A route asked for during the call opens now.
export function closeVoice({ then = null } = {}) {
  if (call) {
    const c = call
    if (c.sessionId && c.connected && !c.finishing) finishSegment(c, 'user')
    else {
      c.finishing = true
      teardown(c)
      call = null
    }
  }
  set({ ...IDLE })
  document.documentElement.classList.remove('voice-open')
  setNavigationGuard(null)
  routeUnsubscribe?.()
  routeUnsubscribe = null
  const route = then || queuedRoute
  queuedRoute = null
  if (route) navigate(route)
}

function teardown(c) {
  if (!c) return
  c.tornDown = true // our own close below reports 'closed': not a dropped connection
  clearInterval(c.ticker)
  for (const timer of c.timers) clearTimeout(timer)
  c.timers.clear()
  for (const resolve of c.stopWaiters) resolve()
  c.stopWaiters.clear()
  for (const done of c.heardWaiters.values()) done()
  for (const undo of c.cleanup) safely(undo)
  c.cleanup = []
  try {
    c.rtc?.close()
  } catch {
    // ignore
  }
  try {
    c.abort.abort()
  } catch {
    // ignore
  }
  stopStream(c.stream)
  c.micMeter?.close()
  c.remoteMeter?.close()
  safely(() => c.wakeRelease())
  setAudioSession('auto')
  try {
    if (c.audioEl) c.audioEl.srcObject = null
  } catch {
    // ignore
  }
  c.audioCtx?.close?.().catch?.(noop)
}

// Signing out or an expired session: everything stops, nothing is saved (the token is gone).
export function clearVoice() {
  const c = call
  call = null
  epoch += 1
  if (c) {
    c.finishing = true
    teardown(c)
  }
  talk = null
  clearTimeout(refreshTimer)
  try {
    localStorage.removeItem(UNSENT_KEY)
  } catch {
    // ignore
  }
  queuedRoute = null
  set({ ...IDLE })
  if (typeof document !== 'undefined') document.documentElement.classList.remove('voice-open')
  setNavigationGuard(null)
  routeUnsubscribe?.()
  routeUnsubscribe = null
}

// ---- the iPhone lifecycle -------------------------------------------------------------------------------

function watchTrack(c) {
  const track = c.micTrack
  let muteTimer = 0
  track.onmute = () => {
    clearTimeout(muteTimer)
    muteTimer = setTimeout(() => {
      if (live(c) && track.muted) pauseVoice('interrupted')
    }, MUTE_PAUSE_MS)
    c.timers.add(muteTimer)
  }
  track.onunmute = () => clearTimeout(muteTimer)
  track.onended = () => {
    if (live(c)) pauseVoice('interrupted')
  }
  if (c.audioCtx) {
    c.audioCtx.onstatechange = () => {
      if (live(c) && c.audioCtx.state === 'interrupted') pauseVoice('interrupted')
    }
  }
  const onHidden = () => {
    if (document.visibilityState === 'hidden' && live(c)) pauseVoice('background')
  }
  const onPageHide = () => {
    if (live(c)) pauseVoice('background')
  }
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onPageHide)
  c.cleanup.push(() => {
    track.onmute = null
    track.onunmute = null
    track.onended = null
    clearTimeout(muteTimer)
    if (c.audioCtx) c.audioCtx.onstatechange = null
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', onPageHide)
  })
}

function onConnection(c, connection) {
  if (!live(c)) return
  if (connection === 'failed') {
    pauseVoice('network')
    return
  }
  // OpenAI closed the channel while the network stayed up (e.g. its session limit): pause, so the
  // call doesn't sit "live" with every send failing.
  if (connection === 'closed') {
    if (!c.tornDown && c.connected) pauseVoice('network')
    return
  }
  if (connection === 'disconnected') {
    const timer = setTimeout(() => {
      if (live(c) && c.rtc?.pc?.connectionState !== 'connected') pauseVoice('network')
    }, DISCONNECT_PAUSE_MS)
    c.timers.add(timer)
  }
}

// ---- controls --------------------------------------------------------------------------------------------

export function toggleMute() {
  const c = call
  if (!c?.micTrack) return
  const muted = !state.muted
  set({ muted })
  if (c.mode === 'open') c.micTrack.enabled = !muted && !c.typingFocus
}

export function setMode(mode) {
  const next = mode === 'hold' ? 'hold' : 'open'
  writePref('voice.mode', next)
  set({ mode: next, notice: state.notice?.id === 'echo' ? null : state.notice })
  const c = call
  if (!c) return
  c.mode = next
  if (c.micTrack) c.micTrack.enabled = next === 'open' && !state.muted && !c.typingFocus
  if (live(c) && c.connected) sendTurnDetection(c)
}

// Hold to talk: press.
export function holdStart() {
  const c = call
  if (!live(c) || c.mode !== 'hold' || !c.micTrack) return
  cancelResponse(c)
  send(c, { type: 'input_audio_buffer.clear' })
  c.micTrack.enabled = true
  c.holdStartAt = Date.now()
  c.idleSec = 0
  set({ holding: true })
  scheduleEmit()
}

// Hold to talk: release (`cancel` when the finger slid off the button).
export function holdEnd({ cancel = false } = {}) {
  const c = call
  if (!c || !state.holding) return
  set({ holding: false })
  const held = Date.now() - c.holdStartAt
  if (cancel || held < HOLD_MIN_MS) {
    if (c.micTrack) c.micTrack.enabled = false
    send(c, { type: 'input_audio_buffer.clear' })
    if (!cancel) flashNotice('hint', 'Hold while you talk')
    scheduleEmit()
    return
  }
  const timer = setTimeout(() => {
    if (!live(c)) return
    if (c.micTrack && !state.holding) c.micTrack.enabled = false
    send(c, { type: 'input_audio_buffer.commit' })
    c.lastTurnTyped = false
    requestResponse(c)
  }, HOLD_TAIL_MS)
  c.timers.add(timer)
  scheduleEmit()
}

// A tap on the orb while Daybook talks.
export function interrupt() {
  const c = call
  if (!live(c)) return
  cancelResponse(c)
}

// The keyboard inside the call.
export function setKeyboard(open) {
  set({ keyboard: !!open })
  if (!open) setTypingFocus(false)
}

// While the field has focus the mic is off; blur gives it back.
export function setTypingFocus(focused) {
  const c = call
  if (!c) return
  c.typingFocus = !!focused
  if (c.micTrack && c.mode === 'open') c.micTrack.enabled = !focused && !state.muted
}

export function setQuiet(quiet) {
  writePref('voice.quiet', !!quiet)
  set({ quiet: !!quiet })
}

// A typed turn (the keyboard, or a start chip) into the same live conversation.
export function sendTyped(text) {
  const c = call
  const value = String(text || '').trim()
  if (!live(c) || !c.connected || !value) return false
  if (c.activeResponseId || c.speaking) cancelResponse(c)
  send(c, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: value.slice(0, 4000) }] } })
  c.lastTurnTyped = true
  c.idleSec = 0
  talk.hasUserTurn = true
  if (c.greeting) endGreeting(c)
  requestResponse(c, state.quiet ? { output_modalities: ['text'] } : null)
  scheduleEmit()
  return true
}

// Save / No tapped on the card waiting for a yes. Daybook stops talking, the card is answered, and
// Daybook says in one short spoken line that it's saved (or not): the model is told the card is
// settled, so it never calls confirm_pending for it (which used to come back "nothing is waiting").
// A reply that is running, or was asked for and is about to start, when a tap has settled the card:
// it would ask "Save it?" about something already saved. Waits at most ~1 s for one just requested.
async function cancelStale(c) {
  const until = Date.now() + 1000
  while (live(c) && !c.activeResponseId && c.createSentAt && Date.now() - c.createSentAt < 2500 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (live(c) && (c.activeResponseId || c.speaking)) cancelResponse(c)
}

export async function decideCard(proposalId, decision) {
  if (!talk || !proposalId || state.deciding) return
  const c = call
  const yes = decision === 'yes'
  set({ deciding: true })
  // Usually it was still reading the card back or asking "Save it?".
  if (live(c) && (c.activeResponseId || c.speaking)) cancelResponse(c)
  const summary = talk.proposal?.id === proposalId ? talk.proposal.summary || '' : ''
  // The version of the card on screen: if it changed on the server meanwhile, the tap doesn't count.
  const revision = talk.proposal?.id === proposalId ? talk.proposal.revision || 1 : undefined
  if (yes) patchProposal({ id: proposalId, status: 'executing', executingAt: new Date().toISOString(), answeredBy: 'tap' })
  try {
    const result = await apiRequest('/api/voice?op=confirm', {
      method: 'POST',
      body: { talkId: talk.talkId, proposalId, decision: yes ? 'yes' : 'no', tapped: true, revision, context: clientContext() },
    })
    applyResult(result)
    if (result?.changed) {
      // The server's newer card replaces the one on screen (still waiting); nothing was saved.
      if (!result.proposal) patchProposal({ id: proposalId, status: 'pending', executingAt: undefined, answeredBy: undefined })
      toast('The card just changed. Check it and tap again.')
      return
    }
    const failed = result?.ok === false
    if (!result?.proposalUpdate) patchProposal({ id: proposalId, status: failed ? 'failed' : yes ? 'done' : 'cancelled', answeredBy: 'tap' })
    else if (!result.proposalUpdate.answeredBy) patchProposal({ id: proposalId, answeredBy: 'tap' })
    const status = talk.proposal?.id === proposalId ? talk.proposal.status : (failed ? 'failed' : yes ? 'done' : 'cancelled')
    set({ ack: { proposalId, decision: yes ? 'yes' : 'no', ok: !failed, status, already: result?.already === true, at: Date.now() } })
    if (live(c)) {
      // A reply that started while the tap was on its way (a follow-up sent just before it) is stale.
      await cancelStale(c)
      const chips = (Array.isArray(result?.actions) ? result.actions : []).map((action) => action?.message).filter(Boolean)
      systemItem(c, tapNote({ decision: yes ? 'yes' : 'no', status, what: chips.join('; ') || summary, said: result?.say || '' }))
      c.lastTurnTyped = false
      // Spoken (a tap isn't typing), unless the keyboard is open with Quiet replies on.
      requestResponse(c, state.quiet && state.keyboard ? { output_modalities: ['text'] } : null)
    }
  } catch (error) {
    patchProposal({ id: proposalId, status: talk.proposal?.status === 'executing' ? 'pending' : talk.proposal?.status, answeredBy: undefined })
    toast(error?.message || 'That didn’t work. Please try again.', { tone: 'error' })
  } finally {
    set({ deciding: false })
  }
}

function patchChip(undoId, patch) {
  if (!talk) return
  talk.actions = talk.actions.map((action) => (action.undoId === undoId ? { ...action, ...patch } : action))
  set({ actions: talk.actions })
}

// Undo on a chip: the chat's own undo; Daybook is told quietly (no reply).
export async function undoCard(undoId) {
  if (!talk || !undoId) return
  const c = call
  const label = talk.actions.find((action) => action.undoId === undoId)?.message || 'that'
  patchChip(undoId, { undoing: true })
  try {
    const result = await apiRequest('/api/assistant?undo=1', { method: 'POST', body: { action: 'undo', undoId, context: clientContext() } })
    patchChip(undoId, { undoing: false, undone: true })
    for (const id of Array.isArray(result?.alsoUndone) ? result.alsoUndone : []) patchChip(id, { undone: true })
    sessionWriter().setMessages((list) => list.map((message) => (message?.actions?.some?.((action) => action.undoId === undoId)
      ? { ...message, actions: message.actions.map((action) => (action.undoId === undoId ? { ...action, undone: true } : action)) }
      : message)))
    if (live(c)) systemItem(c, `(The user tapped Undo on '${String(label).slice(0, 200)}'; it's taken back.)`)
    refreshSoon()
  } catch (error) {
    patchChip(undoId, { undoing: false, ...(undoRefused(error) ? { undoBlocked: true } : {}) })
    toast(error?.message || 'Couldn’t undo that.', { tone: 'error' })
  }
}

// ---- the orb's level -----------------------------------------------------------------------------------
// 0..1: the mic while listening, Daybook's voice while it talks. Safari can read zeros from a remote
// WebRTC stream; after 600 ms of that the orb follows the reply's caption deltas instead.

export function voiceLevel(now = performance.now()) {
  const c = call
  if (!c || !c.connected) return 0
  if (c.speaking) {
    const stream = c.audioEl?.srcObject
    if (stream && stream !== c.remoteStream && stream.getAudioTracks?.().length) {
      c.remoteMeter?.close()
      c.remoteStream = stream
      c.remoteMeter = levelMeter(c.audioCtx, stream)
    }
    const remote = c.remoteMeter ? c.remoteMeter.level() : 0
    if (remote > 0.004) {
      c.zeroSince = 0
      return remote
    }
    if (!c.zeroSince) c.zeroSince = now
    if (now - c.zeroSince < 600) return remote
    const recent = now - c.lastDeltaAt < 450
    return recent ? 0.35 + 0.4 * Math.abs(Math.sin(now / 95)) : 0.22 + 0.08 * Math.sin(now / 240)
  }
  c.zeroSince = 0
  if (state.muted && c.mode === 'open') return 0
  if (c.mode === 'hold' && !state.holding) return 0
  return c.micMeter ? c.micMeter.level() : 0
}

// Day's numbers for the timer pill's tap: "today 12 of 30 min".
export function todayMinutes() {
  const c = call
  const daily = state.dailyMinutes || 30
  const left = c?.limits && Number.isFinite(c.limits.dailyLeftSec) ? c.limits.dailyLeftSec - Math.max(0, c.elapsed - c.dailyAt) : null
  if (left === null) return null
  return { used: Math.max(0, Math.round(daily - left / 60)), daily }
}

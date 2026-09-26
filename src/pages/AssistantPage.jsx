import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../components/ui/Icon.jsx'
import Sheet from '../components/ui/Sheet.jsx'
import { AutoTextarea, EmptyState } from '../components/ui/primitives.jsx'
import { confirmAction, toast } from '../components/ui/feedback.jsx'
import { SESSION_EXPIRED_EVENT, apiRequest, getToken, readJson, readPref, writeJson, writePref } from '../lib/api.js'
import { refresh, useData } from '../lib/store.js'
import { nowTimeHHMM, toISO, todayISO } from '../lib/dates.js'
import {
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_UPLOAD_TOTAL, attachmentKind, fileAccept, formatBytes, inlineAttachment, photoAccept,
  prepareAttachment, revokePreview, uploadAttachment,
} from '../lib/media.js'
import { formatSeconds, useRecorder } from '../lib/recorder.js'
import { pushSupport } from '../lib/notifications.js'
import { useGym, useGymSessions, useToday } from '../lib/gym/state.js'
import { resolveDay } from '../lib/gym/schedule.js'
import '../components/assistant.css'

const CHAT_CACHE = 'daybook.chat'
// After this long without a message the page opens on the start screen (prompts) instead of in the
// middle of the old conversation; "Continue chat" brings it back and nothing is deleted.
const START_AFTER_MS = 3 * 60 * 60 * 1000
const lastMessageAt = (list) => Date.parse(list[list.length - 1]?.createdAt || '') || 0
const PROPOSAL_TTL_MS = 30 * 60 * 1000
// A confirmed run takes seconds; one still "executing" after this was cut off (timeout, crash).
const EXECUTING_STALE_MS = 3 * 60 * 1000
// After Stop or a dropped connection during Yes / No, how long to wait before each look at the server.
const CHECK_DELAYS_MS = [1200, 2500, 5000]
// Vercel refuses request bodies over 4.5 MB; this leaves room for the JSON around the files.
const MAX_REQUEST_BYTES = 4_200_000
// Voice notes are asked for at 32 kbps; budget for twice that (some browsers ignore it), as base64.
const VOICE_BYTES_PER_SECOND = 11_000
const MAX_VOICE_SECONDS = 120
const MIN_VOICE_SECONDS = 5
// Fallback for a server that doesn't send done.actions yet: read-only tools never become chips.
const LOOKUP_TOOLS = new Set(['search', 'read_journal', 'get_weather', 'get_prayer_times', 'gym_get_schedule', 'gym_list_sessions', 'gym_exercise_records', 'food_day', 'food_week', 'ask_choice'])
const STATUS_LABELS = {
  done: 'Done ✓',
  partial: 'Partly done',
  failed: 'Didn’t work',
  cancelled: 'Cancelled',
  superseded: 'Replaced',
  expired: 'Expired',
  interrupted: 'Interrupted — check the result',
  checking: 'Checking…',
  stale: 'Not confirmed',
}
// Statuses after Yes was carried out: each row shows how its action went.
const RESULT_STATUSES = new Set(['done', 'partial', 'failed', 'interrupted'])
const DEEP_LINKS = [
  { test: /^gym_/, href: '#/gym', label: 'Open Gym', icon: 'dumbbell' },
  { test: /^(food_|weight_)/, href: '#/food', label: 'Open Food', icon: 'utensils' },
  { test: /^(create|update|delete)_tasks?$/, href: '#/tasks', label: 'Open Tasks', icon: 'tasks' },
]
const FALLBACK_SUGGESTIONS = [
  { icon: 'calendar', text: 'Help me plan the rest of my week' },
  { icon: 'sparkles', text: 'What can you do?' },
  { icon: 'journal', text: 'Help me write today’s journal' },
]
const TIMETABLE_PROMPT = 'Add the classes from this timetable'
// Where the "+" menu picks from. Each opens its own file input (rendered outside .shell).
const ATTACH_SOURCES = [
  { id: 'camera', icon: 'camera', label: 'Camera', hint: 'Take a photo' },
  { id: 'photos', icon: 'image', label: 'Photos', hint: `Choose up to ${MAX_ATTACHMENTS}` },
  { id: 'files', icon: 'fileText', label: 'Files', hint: `PDFs up to ${formatBytes(MAX_UPLOAD_TOTAL)}, or text files` },
]
const TOO_MANY = `You can attach up to ${MAX_ATTACHMENTS} files to one message.`
// The "what can I ask?" hint above the composer goes away for good once dismissed (per device),
// and on its own after this many messages.
const ASK_HINT_PREF = 'hint.assistantAsk'
const ASK_HINT_UNTIL = 8
const ASK_HINT_PROMPT = 'What can you do?'

let messageId = 0
const nextId = () => `m${Date.now()}-${++messageId}`
const nowIso = () => new Date().toISOString()

export default function AssistantPage({ displayName }) {
  const [messages, setMessages] = useState(() => {
    const cached = readJson(CHAT_CACHE, [])
    return (Array.isArray(cached) ? cached : []).filter((message) => message && typeof message === 'object').map((message) => ({ ...message, id: nextId() }))
  })
  const [memories, setMemories] = useState([])
  // The start screen (prompts) shows for an empty chat, when the last message is old, or on request.
  const [startOpen, setStartOpen] = useState(() => {
    const cached = readJson(CHAT_CACHE, [])
    return !Array.isArray(cached) || !cached.length || Date.now() - lastMessageAt(cached) > START_AFTER_MS
  })
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState(null) // the proposal this device is carrying out
  const [speak, setSpeak] = useState(() => readPref('speakReplies', false))
  // Composer attachments: { id, kind, name, status: 'preparing' | 'uploading' | 'ready' | 'error',
  // progress (0…1), bytes, previewUrl?, prepared? (kept to retry), path | dataUrl | text, error? }.
  const [attachments, setAttachmentState] = useState([])
  const [attachError, setAttachError] = useState('')
  const [attachMenu, setAttachMenu] = useState(null) // the "+" menu: null, or { keyboard } while open
  const [toolsMenu, setToolsMenu] = useState(null) // the header's ⋯ menu, likewise
  const [askHintSeen, setAskHintSeen] = useState(() => readPref(ASK_HINT_PREF, false) === true)
  // Screen readers hear the finished reply once, not every streamed token.
  const [announcement, setAnnouncement] = useState('')
  const endRef = useRef(null)
  const toolsRef = useRef(null)
  const abortRef = useRef(null)
  const busyRef = useRef(false)
  const followRef = useRef(true) // keep the newest message in view unless the user scrolled up
  const jumpRef = useRef(true) // next scroll is instant (first render, loaded history)
  const mountedRef = useRef(false)
  const cameraInputRef = useRef(null)
  const photosInputRef = useRef(null)
  const filesInputRef = useRef(null)
  const attachmentsRef = useRef([]) // mirror of `attachments`, read by async file processing
  const uploadsRef = useRef(new Map()) // attachment id → AbortController of its upload
  const previewsRef = useRef(new Set()) // photo preview URLs made on this visit (freed on leaving)
  const storageRef = useRef(null) // false once the server says uploads aren't available (then inline)
  const timetableRef = useRef(false) // the picker was opened from the timetable hint
  const pushRef = useRef(null) // push on this device: true / false / null (unknown)
  const inputRefs = { camera: cameraInputRef, photos: photosInputRef, files: filesInputRef }

  const setAttachments = useCallback((next) => {
    const value = typeof next === 'function' ? next(attachmentsRef.current) : next
    attachmentsRef.current = value
    setAttachmentState(value)
  }, [])

  // Server history (source of truth) and memories.
  useEffect(() => {
    mountedRef.current = true
    const uploads = uploadsRef.current
    const previews = previewsRef.current
    apiRequest('/api/assistant')
      .then((response) => {
        const history = (response.messages || []).map((message) => ({ ...message, id: nextId() }))
        jumpRef.current = true
        followRef.current = true
        setMessages((current) => (current.some((message) => message.streaming || message.pending) ? current : history))
        writeJson(CHAT_CACHE, response.messages || [])
        setMemories(response.memories || [])
        setMemoryEnabled(response.memoryEnabled !== false)
      })
      .catch(() => {})
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      window.speechSynthesis?.cancel()
      for (const controller of uploads.values()) controller.abort()
      uploads.clear()
      for (const url of previews) revokePreview(url)
      previews.clear()
    }
  }, [])

  // Whether this device gets push reminders, so the assistant can mention it. Best effort, once.
  useEffect(() => {
    let cancelled = false
    devicePushStatus().then((value) => {
      if (!cancelled) pushRef.current = value
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onScroll = () => {
      const end = endRef.current
      if (end) followRef.current = end.getBoundingClientRect().bottom <= window.innerHeight + 150
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // While a reply streams in, jump rather than restart a smooth scroll on every token.
  useEffect(() => {
    // The start screen reads from the top; the chat follows its newest message.
    if (startOpen) {
      window.scrollTo({ top: 0 })
      return undefined
    }
    if (!followRef.current) return undefined
    const behavior = jumpRef.current || busy ? 'auto' : 'smooth'
    jumpRef.current = false
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior }))
    return () => cancelAnimationFrame(frame)
  }, [messages, busy, startOpen])

  // Cache the finished conversation so it shows instantly next time (no photos: names only).
  useEffect(() => {
    if (busy) return
    const finished = messages.filter((message) => !message.error && !message.streaming && !message.pending)
    writeJson(CHAT_CACHE, finished.map(cacheMessage).slice(-40))
  }, [messages, busy])

  // Attachment problems fade after a while.
  useEffect(() => {
    if (!attachError) return undefined
    const timer = setTimeout(() => setAttachError(''), 7000)
    return () => clearTimeout(timer)
  }, [attachError])

  function patchMessage(id, patch) {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)))
  }

  // `results` (per action, from the server) replace the card's; `from` applies the change only while
  // the card still has that status (a late answer must not undo a newer one).
  function setProposalStatus(proposalId, status, { results, from } = {}) {
    const cleaned = results === undefined ? undefined : cleanResults(results)
    setMessages((current) => current.map((message) => {
      const proposal = message.proposal
      if (!proposal || proposal.id !== proposalId || !status) return message
      if (from && proposal.status !== from) return message
      if (proposal.status === status && !cleaned) return message
      return {
        ...message,
        proposal: {
          ...proposal,
          status,
          ...(cleaned ? { results: cleaned } : {}),
          ...(status === 'executing' && proposal.status !== 'executing' ? { executingAt: nowIso() } : {}),
        },
      }
    }))
  }

  // Stop or a dropped connection during Yes / No: the server may have carried on regardless, so read
  // what it recorded instead of guessing, then load any changes it made.
  async function checkProposal(proposalId) {
    setProposalStatus(proposalId, 'checking')
    let found = null
    let known = false // the server answered
    for (const delay of CHECK_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!mountedRef.current) return
      try {
        const response = await apiRequest('/api/assistant')
        found = (Array.isArray(response?.messages) ? response.messages : []).map((message) => message?.proposal).find((proposal) => proposal?.id === proposalId) || null
        known = true
      } catch {
        break
      }
      if (found?.status !== 'executing') break
    }
    if (!mountedRef.current) return
    // Not in the server's history: nothing can carry it out any more (shows as "Not confirmed").
    const status = typeof found?.status === 'string' && found.status ? found.status : known ? 'pending' : 'interrupted'
    setProposalStatus(proposalId, status, { results: Array.isArray(found?.results) ? found.results : undefined, from: 'checking' })
    // Sending the same Yes / No again can't help once it was answered.
    if (known && status !== 'pending') {
      setMessages((current) => current.map((message) => (message.retry?.payload?.confirm?.proposalId === proposalId ? { ...message, retry: undefined } : message)))
    }
    if (!['pending', 'cancelled', 'superseded', 'expired'].includes(status)) refresh().catch(() => {})
  }

  // `shown`: how the attachments look in the sent message (photo previews), when known.
  async function send(payload, shownText, { restore = [], restoreText = '', shown } = {}) {
    if (busyRef.current) return
    busyRef.current = true
    window.speechSynthesis?.cancel()
    if (speak) unlockSpeech()
    const userId = nextId()
    const replyId = nextId()
    const hasAudio = !!payload.audio
    const isVoice = hasAudio || !!payload.spoken
    const confirm = payload.confirm || null
    const shownAttachments = Array.isArray(shown) ? shown : Array.isArray(payload.attachments) ? payload.attachments.map(shownAttachment) : []
    setBusy(true)
    setConfirmingId(confirm?.proposalId || null)
    setAnnouncement('')
    followRef.current = true
    setMessages((current) => [
      ...current.filter((message) => !message.error),
      { id: userId, role: 'user', content: shownText, voice: isVoice, pending: hasAudio, createdAt: nowIso(), ...(shownAttachments.length ? { attachments: shownAttachments } : {}) },
      { id: replyId, role: 'assistant', content: '', streaming: true, status: hasAudio ? 'Listening…' : 'Thinking…', actions: [], createdAt: nowIso() },
    ])
    // Tapped Yes / No: show the answer on the card straight away.
    if (confirm) setProposalStatus(confirm.proposalId, confirm.decision === 'yes' ? 'executing' : 'cancelled')

    const controller = new AbortController()
    abortRef.current = controller
    let acted = false // something was saved, so the request must not simply be sent again
    let transcript = ''
    let proposal = null
    const settleConfirm = (status, results) => { if (confirm) setProposalStatus(confirm.proposalId, status, { results }) }
    try {
      const done = await streamAssistant({ ...payload, context: clientContext(pushRef.current) }, controller.signal, (event) => {
        if (event.type === 'status') patchMessage(replyId, { status: event.text })
        else if (event.type === 'transcript') {
          transcript = event.text
          patchMessage(userId, { content: event.text, pending: false })
        } else if (event.type === 'delta') patchMessage(replyId, (message) => ({ content: message.content + event.text, status: '' }))
        else if (event.type === 'action') {
          if (event.ok) acted = true
          patchMessage(replyId, (message) => ({ actions: [...message.actions, { tool: event.tool, ok: !!event.ok, message: event.message }] }))
        } else if (event.type === 'staged') {
          // A failed or internal step carries a note for the model (a validation error, "ask the user…"), not for the owner.
          if (event.ok === false || event.internal) return
          patchMessage(replyId, (message) => ({ staged: [...(message.staged || []), { tool: event.tool, ok: true, label: event.label }] }))
        } else if (event.type === 'proposal' && event.proposal?.id) {
          proposal = event.proposal
          patchMessage(replyId, { proposal: event.proposal })
        } else if (event.type === 'choices') {
          const choices = cleanChoices(event.choices)
          if (choices.length) patchMessage(replyId, { choices })
        }
      })
      if (done.proposal?.id) proposal = done.proposal
      const choices = cleanChoices(done.choices)
      const reply = typeof done.reply === 'string' && done.reply ? done.reply : proposal?.summary || ''
      patchMessage(userId, { pending: false, ...(done.transcript ? { content: done.transcript } : {}) })
      patchMessage(replyId, (message) => ({
        content: reply || message.content,
        streaming: false,
        status: '',
        staged: undefined,
        actions: doneActions(done, message.actions),
        ...(proposal ? { proposal } : {}),
        ...(choices.length ? { choices } : {}),
      }))
      const updates = [done.proposalUpdate].flat().filter((update) => update?.id && update.status)
      // The Yes just carried out: per-action results, from the update or (older server) the reply's actions.
      const confirmResults = confirm && Array.isArray(done.actions) && done.actions.length ? done.actions : undefined
      for (const update of updates) {
        const results = Array.isArray(update.results) ? update.results
          : update.id === confirm?.proposalId && ['done', 'partial', 'failed'].includes(update.status) ? confirmResults : undefined
        setProposalStatus(update.id, update.status, { results })
      }
      if (confirm && !updates.some((update) => update.id === confirm.proposalId)) {
        // No word on the card (an older server, or another request got there first): don't guess.
        if (acted) settleConfirm(outcomeOf(done.actions), confirmResults)
        else checkProposal(confirm.proposalId)
      }
      // Being carried out by another request (a double tap, another device): follow it to the end.
      for (const update of updates) if (update.status === 'executing') checkProposal(update.id)
      if (done.memories) setMemories(done.memories)
      if (done.dataChanged || acted) refresh().catch(() => {})
      // With quick replies on screen the question is theirs to answer, not "go ahead?".
      const asking = proposal?.status === 'pending' && !choices.length
      const spoken = asking && !endsWithQuestion(reply) ? `${plainText(reply)} Shall I go ahead?` : reply
      if (speak) speakText(spoken)
      else setAnnouncement(plainText(spoken || ''))
    } catch (error) {
      if (error.name === 'AbortError') {
        // Stopped by the user: keep whatever arrived so far.
        patchMessage(replyId, (message) => ({ streaming: false, status: '', staged: undefined, content: message.content || 'Stopped.' }))
        patchMessage(userId, { pending: false })
        // The server doesn't stop with us: a Yes / No may still have gone through.
        if (confirm) checkProposal(confirm.proposalId)
        else if (acted) refresh().catch(() => {})
        setAnnouncement('Stopped.')
        return
      }
      if (acted) {
        // Keep the reply and its action chips, load what was saved, and offer no retry
        // (it would repeat those actions).
        patchMessage(replyId, () => ({ streaming: false, status: '', staged: undefined }))
        patchMessage(userId, { pending: false })
        if (confirm) checkProposal(confirm.proposalId)
        else refresh().catch(() => {})
        setMessages((current) => current.concat({ id: nextId(), role: 'assistant', error: `${error.message} Some changes were already made.` }))
        return
      }
      if (error.status === 413) {
        // The same request would be refused again: no retry. Hand the files (and text) back so one can go.
        if (restore.length) {
          setAttachments((current) => [...restore, ...current.filter((item) => !restore.some((back) => back.id === item.id))].slice(0, MAX_ATTACHMENTS))
        }
        if (restoreText) setText((current) => (current.trim() ? current : restoreText))
        setMessages((current) => current
          .filter((message) => message.id !== replyId && message.id !== userId)
          .concat({ id: nextId(), role: 'assistant', error: error.message }))
        return
      }
      // Never sent (offline): still waiting for an answer. Otherwise ask the server what happened.
      if (confirm) {
        if (error.notSent) settleConfirm('pending')
        else checkProposal(confirm.proposalId)
      }
      // Once a voice message is transcribed, a retry sends the text instead of the audio again
      // (with the same attachments).
      const retry = transcript
        ? { payload: { message: transcript, spoken: true, ...(payload.attachments ? { attachments: payload.attachments } : {}) }, shownText: transcript, userId, shown: shownAttachments }
        : { payload, shownText, userId, shown: shownAttachments }
      setMessages((current) => current
        .filter((message) => message.id !== replyId && !(message.id === userId && hasAudio && message.pending))
        .concat({ id: nextId(), role: 'assistant', error: error.message, retry }))
    } finally {
      abortRef.current = null
      busyRef.current = false
      setBusy(false)
      setConfirmingId(null)
    }
  }

  function submitText(event, preset) {
    event?.preventDefault()
    if (busyRef.current) return
    setStartOpen(false)
    const fromComposer = preset == null
    const message = (preset ?? text).trim()
    const pending = fromComposer ? attachmentsRef.current : []
    if (pending.some(inFlight)) {
      setAttachError('Still uploading — it’ll be ready in a moment.')
      return
    }
    const failed = pending.filter((item) => item.status === 'error')
    if (failed.length) {
      setAttachError(failed.length === 1
        ? `“${failed[0].name}” didn’t upload. Tap it to try again, or remove it.`
        : `${failed.length} files didn’t upload. Tap them to try again, or remove them.`)
      return
    }
    const ready = pending.filter((item) => item.status === 'ready')
    if (!message && !ready.length) return
    // Typing one of the quick replies on screen ("yes") answers the question, like tapping it,
    // rather than confirming a plan shown alongside it.
    const choice = !ready.length && message ? matchChoice(messages[messages.length - 1], message) : ''
    if (fromComposer) {
      setText('')
      setAttachments([])
      setAttachMenu(null)
    }
    setAttachError('')
    send(
      { ...(message ? { message } : {}), ...(choice ? { choice } : {}), ...(ready.length ? { attachments: ready.map(attachmentPayload) } : {}) },
      message,
      { restore: ready, restoreText: fromComposer ? message : '', shown: ready.map(shownAttachment) },
    )
  }

  // A finished voice recording, sent together with any photos or files waiting in the composer.
  async function sendAudio(audio, mimeType) {
    setStartOpen(false)
    if (busyRef.current) throw new Error('Wait for the reply to finish, then send your voice message.')
    const ready = attachmentsRef.current.filter((item) => item.status === 'ready')
    const payload = { audio, mimeType, ...(ready.length ? { attachments: ready.map(attachmentPayload) } : {}) }
    // Too big for one request: it would be refused every time, so keep the files here and say so.
    if (requestBytes(payload) > MAX_REQUEST_BYTES) {
      setAttachError(ready.length
        ? 'That voice note plus the attachments is too big for one message. Remove an attachment and record again, or type your message instead.'
        : 'That voice note is too long to send. Try a shorter one.')
      return
    }
    if (ready.length) setAttachments((current) => current.filter((item) => item.status !== 'ready'))
    setAttachError('')
    send(payload, 'Voice message', { restore: ready, shown: ready.map(shownAttachment) })
  }

  // The "+" menu. `keyboard`: opened with the keyboard, so focus moves into it.
  function toggleAttachMenu(event) {
    timetableRef.current = false
    setAttachError('')
    setAttachMenu((open) => (open ? null : { keyboard: event?.detail === 0 }))
  }

  // The timetable hint opens the same menu; whatever gets picked gets the timetable prompt.
  function openTimetablePicker(event) {
    timetableRef.current = true
    setAttachError('')
    setAttachMenu({ keyboard: event?.detail === 0 })
  }

  const closeAttachMenu = useCallback(() => setAttachMenu(null), [])

  // Runs inside the tap on a menu item, so iOS lets it open the picker.
  function pickFrom(source) {
    setAttachMenu(null)
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      timetableRef.current = false
      setAttachError(TOO_MANY)
      return
    }
    inputRefs[source]?.current?.click()
  }

  function onFilesChosen(event) {
    const input = event.target
    const files = Array.from(input.files || [])
    input.value = '' // so choosing the same file again still fires a change
    input.blur()
    const fromTimetable = timetableRef.current
    timetableRef.current = false
    addFiles(files, fromTimetable)
  }

  const hasAttachment = (id) => attachmentsRef.current.some((item) => item.id === id)
  const patchAttachment = (id, patch) => setAttachments((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  const dropAttachment = (id) => setAttachments((current) => current.filter((item) => item.id !== id))
  function failAttachment(id, message) {
    patchAttachment(id, { status: 'error', progress: 0, error: message })
    setAttachError(message)
  }

  // Picked or pasted files: checked, then prepared one at a time (decoding several large photos at
  // once can run an iPhone out of memory). Each photo or PDF starts uploading as soon as it's ready,
  // so sending is instant.
  async function addFiles(files, fromTimetable = false) {
    if (!files.length) return
    setAttachError('')

    const supported = files.filter((file) => attachmentKind(file))
    if (supported.length < files.length) setAttachError('Only photos, PDFs and text files can be attached.')
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length
    if (supported.length > room) setAttachError(TOO_MANY)
    const accepted = supported.slice(0, Math.max(0, room))
    if (!accepted.length) return
    if (fromTimetable) setText((current) => (current.trim() ? current : TIMETABLE_PROMPT))

    const placeholders = accepted.map((file) => ({ id: nextId(), status: 'preparing', progress: 0, kind: attachmentKind(file), name: file.name || 'file' }))
    setAttachments((current) => [...current, ...placeholders])
    for (const [index, file] of accepted.entries()) {
      const { id } = placeholders[index]
      let prepared
      try {
        prepared = await prepareAttachment(file)
      } catch (error) {
        if (!mountedRef.current) return
        dropAttachment(id)
        setAttachError(error?.message || 'Couldn’t read that file.')
        continue
      }
      if (!mountedRef.current || !hasAttachment(id)) { // left the page, or removed meanwhile
        revokePreview(prepared.previewUrl)
        if (!mountedRef.current) return
        continue
      }
      const others = attachmentsRef.current.filter((item) => item.id !== id)
      // Text goes inside the request; photos and PDFs go to storage.
      const isText = prepared.kind === 'text'
      const limit = isText ? MAX_ATTACHMENT_BYTES : MAX_UPLOAD_TOTAL
      if (sumBytes(others, isText ? inlineBytes : uploadBytes) + prepared.bytes > limit) {
        revokePreview(prepared.previewUrl)
        dropAttachment(id)
        setAttachError(`That’s too much for one message — attachments can add up to ${formatBytes(limit)}.`)
        continue
      }
      if (isText) {
        patchAttachment(id, { status: 'ready', progress: 1, name: prepared.name, text: prepared.text, bytes: prepared.bytes })
        continue
      }
      if (prepared.previewUrl) previewsRef.current.add(prepared.previewUrl)
      patchAttachment(id, { name: prepared.name, bytes: prepared.bytes, previewUrl: prepared.previewUrl, prepared })
      startUpload(id, prepared)
    }
  }

  // Uploads one prepared photo or PDF to storage. When storage isn't available (or the upload
  // itself fails) it goes inside the message instead, as before, if it's small enough.
  async function startUpload(id, prepared) {
    uploadsRef.current.get(id)?.abort()
    const controller = new AbortController()
    uploadsRef.current.set(id, controller)
    const current = () => mountedRef.current && uploadsRef.current.get(id) === controller && hasAttachment(id)
    patchAttachment(id, { status: 'uploading', progress: 0, error: '', path: undefined, dataUrl: undefined })
    try {
      if (storageRef.current === false) throw Object.assign(new Error('Uploads aren’t available.'), { fallback: true, code: 'storage_unavailable' })
      let shown = 0
      const result = await uploadAttachment(prepared, {
        signal: controller.signal,
        onProgress: (value) => {
          const step = Math.floor(value * 50) / 50 // re-render every 2%, not on every progress event
          if (step <= shown || !current()) return
          shown = step
          patchAttachment(id, { progress: step })
        },
      })
      storageRef.current = true
      if (current()) patchAttachment(id, { status: 'ready', progress: 1, path: result.path })
    } catch (error) {
      if (error?.name === 'AbortError' || !current()) return
      if (!error?.fallback) {
        failAttachment(id, error?.message || 'Couldn’t upload that file.')
        return
      }
      const noStorage = error.code === 'storage_unavailable'
      if (noStorage) storageRef.current = false
      const uploadFailed = `Couldn’t upload “${prepared.name}”. Check your connection, then tap it to try again.`
      try {
        const inline = await inlineAttachment(prepared)
        if (!current()) return
        const others = attachmentsRef.current.filter((item) => item.id !== id)
        if (sumBytes(others, inlineBytes) + inline.bytes > MAX_ATTACHMENT_BYTES) {
          failAttachment(id, noStorage
            ? `Big uploads aren’t available right now, so attachments can add up to ${formatBytes(MAX_ATTACHMENT_BYTES)}. Send “${prepared.name}” in its own message.`
            : uploadFailed)
          return
        }
        patchAttachment(id, { status: 'ready', progress: 1, dataUrl: inline.dataUrl })
      } catch (inlineError) {
        if (!current()) return
        failAttachment(id, noStorage ? inlineError?.message || uploadFailed : uploadFailed)
      }
    } finally {
      if (uploadsRef.current.get(id) === controller) uploadsRef.current.delete(id)
    }
  }

  function retryAttachment(id) {
    const item = attachmentsRef.current.find((attachment) => attachment.id === id)
    if (!item?.prepared || item.status !== 'error') return
    setAttachError('')
    storageRef.current = null // ask the server again
    startUpload(id, item.prepared)
  }

  // Removing a file cancels its upload.
  function removeAttachment(id) {
    setAttachError('')
    uploadsRef.current.get(id)?.abort()
    uploadsRef.current.delete(id)
    const item = attachmentsRef.current.find((attachment) => attachment.id === id)
    if (item?.previewUrl) {
      revokePreview(item.previewUrl)
      previewsRef.current.delete(item.previewUrl)
    }
    dropAttachment(id)
  }

  function retry(message) {
    // Drop the error and the message that failed; send() adds the message back.
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id)
      const previous = current[index - 1]
      const failedId = message.retry.userId ?? (previous?.role === 'user' && previous.content === message.retry.shownText ? previous.id : null)
      return current.filter((item, position) => position !== index && item.id !== failedId)
    })
    send(message.retry.payload, message.retry.shownText, { shown: message.retry.shown })
  }

  function decide(proposalId, decision) {
    if (busyRef.current || !proposalId) return
    send({ confirm: { proposalId, decision } }, decision === 'yes' ? 'Yes' : 'No')
  }

  function choose(choice) {
    if (busyRef.current || !choice) return
    send({ message: choice, choice }, choice)
  }

  // Stable across renders, so unchanged messages don't re-render while a reply streams.
  const actionsRef = useRef(null)
  actionsRef.current = { retry, decide, choose }
  const onRetry = useCallback((message) => actionsRef.current.retry(message), [])
  const onDecide = useCallback((proposalId, decision) => actionsRef.current.decide(proposalId, decision), [])
  const onChoose = useCallback((choice) => actionsRef.current.choose(choice), [])

  async function newChat() {
    if (messages.length && !(await confirmAction({ title: 'Start a new chat?', message: 'This clears the conversation. What I remember about you is kept.', confirmLabel: 'New chat', tone: 'default' }))) return
    try {
      await apiRequest('/api/assistant', { method: 'DELETE' })
      setMessages([])
      writeJson(CHAT_CACHE, [])
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  function toggleSpeak() {
    const next = !speak
    setSpeak(next)
    writePref('speakReplies', next)
    if (next) unlockSpeech()
    else window.speechSynthesis?.cancel()
    toast(next ? 'Replies will be read aloud' : 'Replies won’t be read aloud')
  }

  function dismissAskHint() {
    setAskHintSeen(true)
    writePref(ASK_HINT_PREF, true)
  }

  const empty = messages.length === 0
  const lastIndex = messages.length - 1
  const showAskHint = !empty && !askHintSeen && messages.length <= ASK_HINT_UNTIL
  const closeToolsMenu = useCallback(() => setToolsMenu(null), [])
  const toolItems = [
    { id: 'memory', icon: 'bookmark', label: 'What I remember', hint: memories.length ? `${memories.length} ${memories.length === 1 ? 'thing' : 'things'} you’ve told me` : 'Nothing yet', onClick: () => setMemoryOpen(true) },
    { id: 'speak', icon: speak ? 'volume' : 'volumeOff', label: 'Read replies aloud', hint: speak ? 'On' : 'Off', checked: speak, onClick: toggleSpeak },
    { id: 'new', icon: 'message', label: 'New chat', hint: 'Clears this conversation', disabled: busy, onClick: newChat },
  ]

  return (
    <div className="assistant">
      <header className="assistant-header">
        <div>
          <h1>Assistant</h1>
          <p className="page-subtitle">Knows your tasks, calendar, people, gym and food</p>
        </div>
        <div className="assistant-tools asst-tools">
          <button
            ref={toolsRef}
            type="button"
            className={`icon-btn ${toolsMenu ? 'is-active' : ''}`}
            onClick={(event) => setToolsMenu((open) => (open ? null : { keyboard: event.detail === 0 }))}
            aria-label="More"
            title="More"
            aria-haspopup="menu"
            aria-expanded={!!toolsMenu}
            aria-controls={toolsMenu ? 'asst-tools-menu' : undefined}
          >
            <Icon name="more" size={22} />
          </button>
          {toolsMenu && <PopMenu id="asst-tools-menu" label="Assistant options" items={toolItems} focusFirst={!!toolsMenu.keyboard} anchorRef={toolsRef} onClose={closeToolsMenu} placement="down" />}
        </div>
      </header>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="chat">
        {empty || startOpen ? (
          <Welcome
            displayName={displayName}
            busy={busy}
            onAsk={(prompt) => submitText(null, prompt)}
            onTimetable={openTimetablePicker}
            messageCount={messages.length}
            lastAt={empty ? 0 : lastMessageAt(messages)}
            onContinue={() => { jumpRef.current = true; setStartOpen(false) }}
            onNewChat={newChat}
          />
        ) : messages.map((message, index) => {
          const isLast = index === lastIndex
          // Only a card this device is running spins; any other "executing" one was cut off.
          const status = message.proposal?.status
          const liveCard = status === 'pending' || (status === 'executing' && !!confirmingId && message.proposal.id === confirmingId)
          return (
            <Message
              key={message.id}
              message={message}
              isLast={isLast}
              busy={busy && (isLast || liveCard)}
              onRetry={onRetry}
              onDecide={onDecide}
              onChoose={onChoose}
            />
          )
        })}
        <div ref={endRef} className="chat-end" />
      </div>

      {/* Outside .shell, so a focused picker never counts as "typing" (which hides the tab bar). */}
      {createPortal(
        <>
          <input ref={cameraInputRef} type="file" accept={photoAccept} capture="environment" className="asst-file-input" onChange={onFilesChosen} tabIndex={-1} aria-hidden="true" />
          <input ref={photosInputRef} type="file" accept={photoAccept} multiple className="asst-file-input" onChange={onFilesChosen} tabIndex={-1} aria-hidden="true" />
          <input ref={filesInputRef} type="file" accept={fileAccept} multiple className="asst-file-input" onChange={onFilesChosen} tabIndex={-1} aria-hidden="true" />
        </>,
        document.body,
      )}

      <div className="composer-dock">
        {!empty && !startOpen && !showAskHint && (
          <div className="asst-dock-row">
            <button type="button" className="asst-start-btn" onClick={() => setStartOpen(true)} title="Back to the start screen with ready-made prompts">
              <Icon name="sparkles" size={15} strokeWidth={2.2} />
              <span>Prompts</span>
            </button>
          </div>
        )}
        {showAskHint && (
          <div className="asst-tip" role="note">
            <button type="button" className="asst-tip-text" onClick={() => { dismissAskHint(); submitText(null, ASK_HINT_PROMPT) }} disabled={busy}>
              <Icon name="sparkles" size={15} />
              <span>Try asking “{ASK_HINT_PROMPT}”</span>
            </button>
            <button type="button" className="asst-tip-close" onClick={dismissAskHint} aria-label="Dismiss this tip"><Icon name="close" size={15} strokeWidth={2.4} /></button>
          </div>
        )}
        <Composer
          text={text}
          setText={setText}
          busy={busy}
          attachments={attachments}
          notice={attachError}
          menu={attachMenu}
          onSubmit={submitText}
          onToggleMenu={toggleAttachMenu}
          onCloseMenu={closeAttachMenu}
          onPick={pickFrom}
          onRemoveAttachment={removeAttachment}
          onRetryAttachment={retryAttachment}
          onPasteFiles={(files) => addFiles(files)}
          onAudio={sendAudio}
          onNotice={setAttachError}
          onStop={() => abortRef.current?.abort()}
        />
      </div>

      <MemorySheet open={memoryOpen} onClose={() => setMemoryOpen(false)} memories={memories} setMemories={setMemories} enabled={memoryEnabled} />
    </div>
  )
}

// ---- welcome and starter prompts ---------------------------------------------------------------

function Welcome({ displayName, busy, onAsk, onTimetable, messageCount = 0, lastAt = 0, onContinue, onNewChat }) {
  const suggestions = useSuggestions()
  const firstName = String(displayName || '').trim().split(/\s+/)[0]
  const hasChat = messageCount > 0
  return (
    <div className="chat-welcome">
      {hasChat && (
        <div className="asst-resume">
          <button type="button" className="asst-resume-main" onClick={onContinue}>
            <Icon name="message" size={18} />
            <span className="asst-resume-text">
              <strong>Continue chat</strong>
              <small>{messageCount} {messageCount === 1 ? 'message' : 'messages'}{lastAt ? ` · last ${agoText(lastAt)}` : ''}</small>
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
          <button type="button" className="asst-resume-new" onClick={onNewChat} disabled={busy}>Start fresh</button>
        </div>
      )}
      <span className="assistant-avatar assistant-avatar-lg" aria-hidden="true"><Icon name="sparkles" size={30} /></span>
      <h2>{firstName ? `Hi ${firstName}, how can I help?` : 'How can I help?'}</h2>
      <p>Ask in plain words, type or talk: “move the dentist to Friday at 3”, “what’s on today?”, “had coffee with Ali”. I check with you before changing anything.</p>
      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion.text} type="button" className="suggestion" onClick={() => onAsk(suggestion.text)} disabled={busy}>
            <Icon name={suggestion.icon} size={18} />
            <span>{suggestion.text}</span>
          </button>
        ))}
      </div>
      <button type="button" className="asst-hint" onClick={onTimetable}>
        <Icon name="camera" size={18} />
        <span>Snap a photo of your class timetable</span>
      </button>
    </div>
  )
}

// "just now" / "35 min ago" / "3 h ago" / "yesterday" / "3 days ago", for the Continue chat line.
function agoText(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function useSuggestions() {
  const tasks = useData('tasks')
  const friends = useData('friends')
  const settings = useData('settings')
  const foodEntries = useData('foodEntries')
  const gym = useGym()
  const sessions = useGymSessions()
  const today = useToday()
  const hour = new Date().getHours()
  return useMemo(() => {
    let gymDay = false
    try {
      const day = resolveDay(gym, sessions, today, today)
      gymDay = day.status === 'today' && day.shown?.kind === 'routine'
    } catch {
      // no plan / unreadable plan: no workout prompt
    }
    return buildSuggestions({ tasks, friends, settings, foodEntries, gymDay, today, hour })
  }, [tasks, friends, settings, foodEntries, gym, sessions, today, hour])
}

// Up to four prompts, most useful first, from what's in the app right now.
export function buildSuggestions({ tasks, friends, settings, foodEntries, gymDay = false, today, hour = 12 }) {
  const list = []
  const overdue = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && !task.archived && !task.done && typeof task.date === 'string' && task.date && task.date < today).length
  if (overdue > 0) list.push({ icon: 'alert', text: overdue === 1 ? 'Reschedule my overdue task' : `Reschedule my ${overdue} overdue tasks` })
  list.push(hour >= 17 ? { icon: 'sunrise', text: 'Plan tomorrow' } : { icon: 'sun', text: 'What’s on my plate today?' })
  const areas = settings?.areas && typeof settings.areas === 'object' ? settings.areas : {}
  if (gymDay && areas.gym !== false) list.push({ icon: 'dumbbell', text: 'What’s today’s workout?' })
  const calorieGoal = Number(settings?.food?.goals?.calories)
  if (areas.food !== false && ((Number.isFinite(calorieGoal) && calorieGoal > 0) || (Array.isArray(foodEntries) && foodEntries.length > 0))) {
    list.push({ icon: 'utensils', text: 'How many calories do I have left?' })
  }
  if (areas.people !== false && Array.isArray(friends) && friends.length > 0) list.push({ icon: 'people', text: 'Who should I catch up with?' })
  if (settings?.showPrayerTimes !== false) list.push({ icon: 'moon', text: 'What are today’s prayer times?' })
  for (const fallback of FALLBACK_SUGGESTIONS) list.push(fallback)
  return list.slice(0, 4)
}

// ---- messages ----------------------------------------------------------------------------------

const Message = memo(function Message({ message, isLast, busy, onRetry, onDecide, onChoose }) {
  if (message.error) {
    return (
      <div className="msg msg-assistant msg-error" role="alert">
        <span className="assistant-avatar" aria-hidden="true"><Icon name="alert" size={16} /></span>
        <div className="msg-body">
          <p>{message.error}</p>
          {message.retry && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRetry(message)}><Icon name="refresh" size={16} />Try again</button>}
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter((item) => item && typeof item === 'object') : []
    const showBubble = message.pending || !!message.content || !attachments.length
    return (
      <div className={`msg msg-user ${message.pending ? 'is-pending' : ''}`}>
        <div className="asst-user-stack">
          {attachments.length > 0 && <SentAttachments items={attachments} />}
          {showBubble && (
            <div className="msg-bubble">
              {message.voice && <Icon name="mic" size={15} />}
              {message.pending ? <span className="typing" aria-label="Transcribing"><i /><i /><i /></span> : message.content}
            </div>
          )}
        </div>
      </div>
    )
  }

  const proposal = message.proposal && typeof message.proposal === 'object' ? message.proposal : null
  const text = message.content || proposal?.summary || ''
  const staged = message.streaming && !proposal && Array.isArray(message.staged) ? message.staged.filter((item) => item && item.ok !== false && !item.internal) : []
  const actions = (Array.isArray(message.actions) ? message.actions : []).filter((action) => action && (action.message || action.ok === false))
  const links = message.streaming ? [] : deepLinks(actions)
  const choices = isLast && !message.streaming && Array.isArray(message.choices) ? message.choices : []

  return (
    <div className="msg msg-assistant">
      <span className="assistant-avatar" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
      <div className={`msg-body ${proposal ? 'has-card' : ''}`}>
        {text ? <RichText text={text} /> : null}
        {message.streaming && !text && (
          <p className="msg-status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{message.status}</p>
        )}
        {message.streaming && text && message.status && <p className="msg-status">{message.status}</p>}
        {staged.length > 0 && (
          <ul className="action-chips asst-staged" aria-label="Getting ready">
            {staged.map((item, index) => (
              <li key={index} className="is-staged">
                <Icon name="clock" size={14} />
                {inline(String(item.label || 'Preparing a change'))}
              </li>
            ))}
          </ul>
        )}
        {proposal && (
          <ProposalCard
            proposal={proposal}
            createdAt={message.createdAt}
            isLast={isLast}
            busy={busy || !!message.streaming}
            question={choices.length > 0}
            onDecide={(decision) => onDecide(proposal.id, decision)}
            onAlternative={onChoose}
          />
        )}
        {actions.length > 0 && (
          <ul className="action-chips">
            {actions.map((action, index) => (
              <li key={index} className={action.ok ? 'is-ok' : 'is-failed'}>
                <Icon name={action.ok ? 'check' : 'alert'} size={14} />
                {action.message || 'That didn’t work.'}
              </li>
            ))}
          </ul>
        )}
        {links.length > 0 && (
          <div className="asst-links">
            {links.map((link) => (
              <a key={link.href} className="asst-link" href={link.href}>
                <Icon name={link.icon} size={15} />
                {link.label}
                <Icon name="chevronRight" size={14} />
              </a>
            ))}
          </div>
        )}
        {choices.length > 0 && (
          <div className="asst-choices" role="group" aria-label="Quick replies">
            {choices.map((choice) => (
              <button key={choice} type="button" className="asst-choice" onClick={() => onChoose(choice)} disabled={busy}>{choice}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

// "I'll do:" with the server's labels, then Yes / No. Buttons work only on the newest message, and
// not while a question with quick replies waits under it (the answer comes first).
export function ProposalCard({ proposal, createdAt, isLast, busy, question = false, onDecide, onAlternative, now = Date.now() }) {
  const actions = (Array.isArray(proposal.actions) ? proposal.actions : [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action && (action.label || action.detail))
  let status = typeof proposal.status === 'string' && proposal.status ? proposal.status : 'pending'
  if (status === 'pending' && proposalExpired(proposal, createdAt, now)) status = 'expired'
  if (status === 'pending' && !isLast && !busy) status = 'stale' // answered some other way
  // Nothing here is running it (reloaded, or the run was cut off): don't spin forever.
  if (status === 'executing' && (!busy || executingStale(proposal, now))) status = 'interrupted'
  const outcomes = RESULT_STATUSES.has(status) ? rowOutcomes(proposal, status) : []
  // Saved as "done" by an older server although some actions failed: say what really happened.
  if (status === 'done' && outcomes.includes('failed')) status = outcomes.includes('ok') ? 'partial' : 'failed'
  const open = status === 'pending' || status === 'executing'
  const waiting = status === 'pending' && question
  const canDecide = status === 'pending' && isLast && !busy && !question
  const tone = status === 'done' ? 'is-done' : open ? 'is-open' : 'is-closed'
  // Other ways to do it ("Look it up online", "Estimate instead"): a tap sends it as the reply.
  const alternatives = canDecide && onAlternative && Array.isArray(proposal.alternatives)
    ? proposal.alternatives.filter((item) => typeof item === 'string' && item.trim()).slice(0, 3)
    : []

  return (
    <section className={`asst-proposal ${tone} is-${status}`} aria-label="Proposed changes">
      <p className="asst-proposal-head">
        {status === 'checking' && <span className="spinner" aria-hidden="true" />}
        {open ? 'I’ll do:' : STATUS_LABELS[status] || 'Not confirmed'}
      </p>
      {actions.length > 0 && (
        <ul className="asst-proposal-list">
          {actions.map(({ action, index }) => {
            const outcome = outcomes[index] || ''
            return (
              <li key={index} className={outcome ? `is-${outcome}` : undefined}>
                <span className={`asst-proposal-mark ${outcome ? `is-${outcome}` : ''}`} aria-hidden="true">
                  {outcome === 'ok' && <Icon name="check" size={12} strokeWidth={3} />}
                  {outcome === 'failed' && <span className="asst-proposal-bang">!</span>}
                </span>
                <span className="asst-proposal-text">
                  {action.label && <span>{inline(String(action.label))}</span>}
                  {action.detail && <small>{inline(String(action.detail))}</small>}
                  {outcome && <span className="sr-only">{outcome === 'ok' ? ' (done)' : ' (didn’t work)'}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {waiting ? (
        <p className="asst-proposal-note">Answer the question below first, then I’ll update this.</p>
      ) : open && (
        <div className="asst-proposal-actions">
          <button type="button" className="btn btn-primary btn-grow" disabled={!canDecide} aria-busy={status === 'executing' || undefined} onClick={() => onDecide('yes')}>
            {status === 'executing' ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} strokeWidth={2.4} />}
            {status === 'executing' ? 'Working…' : 'Yes, do it'}
          </button>
          <button type="button" className="btn btn-secondary asst-proposal-no" disabled={!canDecide} onClick={() => onDecide('no')}>No</button>
        </div>
      )}
      {alternatives.length > 0 && (
        <div className="asst-proposal-alts" role="group" aria-label="Or instead">
          <span className="asst-proposal-or">or</span>
          {alternatives.map((item) => (
            <button key={item} type="button" className="asst-choice" onClick={() => onAlternative(item)}>{item}</button>
          ))}
        </div>
      )}
    </section>
  )
}

// "executing" for longer than any real run takes. Uses the server's (or this device's) start stamp.
export function executingStale(proposal, now = Date.now()) {
  const stamp = Date.parse(proposal?.executingAt || '')
  return Number.isFinite(stamp) && now - stamp > EXECUTING_STALE_MS
}

// How each action went, by position in proposal.actions: 'ok', 'failed' or '' (not known).
// Results are matched by position, or by label when the server sends labels that don't line up.
export function rowOutcomes(proposal, status = proposal?.status) {
  const actions = Array.isArray(proposal?.actions) ? proposal.actions : []
  const results = Array.isArray(proposal?.results) ? proposal.results.filter((result) => result && typeof result === 'object') : []
  const used = new Set()
  return actions.map((action, index) => {
    let match = -1
    const atIndex = results[index]
    if (atIndex && !used.has(index) && (!atIndex.label || !action?.label || atIndex.label === action.label)) match = index
    else if (action?.label) match = results.findIndex((result, position) => !used.has(position) && result.label === action.label)
    if (match >= 0) {
      used.add(match)
      return results[match].ok === false ? 'failed' : 'ok'
    }
    // No result for this row: the overall status is all there is to go on.
    return status === 'done' ? 'ok' : status === 'failed' ? 'failed' : ''
  })
}

// Server stamps win; otherwise the message time. Expired after 30 min or once the local day changes.
export function proposalExpired(proposal, createdAt, now = Date.now()) {
  if (typeof proposal?.localDate === 'string' && proposal.localDate && proposal.localDate !== toISO(new Date(now))) return true
  const stamp = Date.parse(proposal?.createdAt || createdAt || '')
  if (!Number.isFinite(stamp)) return false
  return now - stamp > PROPOSAL_TTL_MS || toISO(new Date(stamp)) !== toISO(new Date(now))
}

function SentAttachments({ items }) {
  const images = items.filter((item) => item.kind === 'image' && item.thumb)
  const files = items.filter((item) => !(item.kind === 'image' && item.thumb))
  const columns = images.length <= 1 ? 1 : images.length === 2 || images.length === 4 ? 2 : 3
  return (
    <>
      {images.length > 0 && (
        <div className={`asst-sent-images cols-${columns}`}>
          {images.map((item, index) => <img key={index} src={item.thumb} alt={item.name || 'Photo'} decoding="async" />)}
        </div>
      )}
      {files.length > 0 && (
        <ul className="asst-sent-files">
          {files.map((item, index) => (
            <li key={index} className={`is-${item.kind}`}>
              <Icon name={kindIcon(item.kind)} size={17} />
              <span>{item.name || kindName(item.kind)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/

// Minimal, safe markdown: paragraphs, bullet/numbered lists, **bold**, *italic*, `code`.
// A block can mix text and list lines (e.g. an intro line followed by bullets).
function RichText({ text }) {
  const blocks = text.trim().split(/\n{2,}/)
  return blocks.flatMap((block, index) => {
    const groups = []
    for (const line of block.split('\n')) {
      const isItem = LIST_ITEM.test(line)
      const last = groups[groups.length - 1]
      if (last && last.isItem === isItem) last.lines.push(line)
      else groups.push({ isItem, lines: [line] })
    }
    return groups.map(({ isItem, lines }, groupIndex) => {
      const key = `${index}-${groupIndex}`
      if (isItem) {
        const ordered = /^\s*\d/.test(lines[0])
        const List = ordered ? 'ol' : 'ul'
        return <List key={key} start={ordered ? parseInt(lines[0], 10) || 1 : undefined}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(LIST_ITEM, ''))}</li>)}</List>
      }
      return <p key={key}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{inline(line)}</Fragment>)}</p>
    })
  })
}

function inline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g)
  return parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>
    return part
  })
}

// ---- composer ----------------------------------------------------------------------------------

// iMessage-style bar: "+" (camera, photos, files) · the message · mic, send or stop. Attachments wait
// in a tray above the field, each with its upload progress.
function Composer({
  text, setText, busy, attachments, notice, menu, onSubmit, onToggleMenu, onCloseMenu, onPick,
  onRemoveAttachment, onRetryAttachment, onPasteFiles, onAudio, onNotice, onStop,
}) {
  // Attachments and the voice note travel in one request: the recording stops before it would overflow.
  const voiceSeconds = useMemo(() => voiceBudgetSeconds(attachments), [attachments])
  const [voiceLimit, setVoiceLimit] = useState(MAX_VOICE_SECONDS) // fixed when a recording starts
  const recorder = useRecorder({ onAudio, maxSeconds: voiceLimit })
  const plusRef = useRef(null)
  const menuId = useId()
  const hasText = text.trim().length > 0
  const uploading = attachments.some(inFlight)
  const readyCount = attachments.filter((item) => item.status === 'ready').length
  const hasAttachments = attachments.length > 0
  const error = recorder.error || notice
  const tray = hasAttachments && <AttachmentTray items={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
  const capped = voiceLimit < MAX_VOICE_SECONDS

  function startRecording() {
    if (uploading) {
      onNotice?.('Wait for the uploads to finish, then record your voice message.')
      return
    }
    if (attachments.some((item) => item.status === 'error')) {
      onNotice?.('A file didn’t upload — tap it to try again, or remove it first.')
      return
    }
    if (voiceSeconds < MIN_VOICE_SECONDS) {
      onNotice?.('These attachments leave no room for a voice note. Type your message, or remove an attachment first.')
      return
    }
    onCloseMenu?.()
    setVoiceLimit(voiceSeconds)
    recorder.start()
  }

  if (recorder.recording) {
    return (
      <div className="asst-composer-wrap">
        <div className={`composer asst-composer is-recording ${hasAttachments ? 'has-attachments' : ''}`}>
          {tray}
          <div className="asst-row">
            <button type="button" className="asst-icon-btn" onClick={() => recorder.stop(true)} aria-label="Cancel recording"><Icon name="close" size={20} /></button>
            <div className="recorder" aria-label={`Recording, ${formatSeconds(recorder.seconds)}${capped ? ` of ${formatSeconds(voiceLimit)}` : ''}`}>
              <span className="rec-dot" aria-hidden="true" />
              <span className="rec-time">{formatSeconds(recorder.seconds)}{capped && <span className="asst-rec-limit"> / {formatSeconds(voiceLimit)}</span>}</span>
              <span className="waveform" aria-hidden="true">
                {recorder.levels.map((level, index) => <i key={index} style={{ transform: `scaleY(${level})` }} />)}
              </span>
            </div>
            <button type="button" className="send-btn" onClick={() => recorder.stop(false)} aria-label={readyCount ? 'Send voice message with attachments' : 'Send voice message'}>
              <Icon name="send" size={20} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="asst-composer-wrap">
      {error && <p className="composer-error asst-notice" role="alert">{error}</p>}
      {menu && (
        <PopMenu
          id={menuId}
          label="Add to your message"
          items={ATTACH_SOURCES.map((source) => ({ ...source, onClick: () => onPick(source.id) }))}
          focusFirst={!!menu.keyboard}
          anchorRef={plusRef}
          onClose={onCloseMenu}
        />
      )}
      <form className={`composer asst-composer ${hasAttachments ? 'has-attachments' : ''}`} onSubmit={onSubmit}>
        {tray}
        <div className="asst-row">
          <button
            ref={plusRef}
            type="button"
            className={`asst-plus ${menu ? 'is-open' : ''}`}
            onClick={onToggleMenu}
            aria-label="Add photos or files"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            aria-controls={menu ? menuId : undefined}
          >
            <span className="asst-plus-disc" aria-hidden="true"><Icon name="plus" size={20} strokeWidth={2.2} /></span>
          </button>
          <AutoTextarea
            className="composer-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              // A pasted screenshot becomes an attachment; anything with text pastes as text.
              const files = Array.from(event.clipboardData?.files || [])
              if (!files.length || !onPasteFiles || event.clipboardData.getData('text/plain')) return
              event.preventDefault()
              onPasteFiles(files)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
                event.preventDefault()
                onSubmit(event)
              }
            }}
            placeholder="Ask anything…"
            aria-label="Message"
            minRows={1}
            maxRows={6}
            maxLength={4000}
          />
          {busy ? (
            <button type="button" className="send-btn is-stop" onClick={onStop} aria-label="Stop"><span className="stop-square" /></button>
          ) : hasText || hasAttachments ? (
            <>
              {!hasText && recorder.supported && (
                <button type="button" className="asst-icon-btn is-mic" onClick={startRecording} disabled={uploading} aria-label="Record a voice message to send with the attachments">
                  <Icon name="mic" size={21} />
                </button>
              )}
              <button type="submit" className="send-btn" aria-label={uploading ? 'Waiting for uploads to finish' : 'Send'} disabled={uploading}>
                {uploading ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} strokeWidth={2.4} />}
              </button>
            </>
          ) : recorder.supported ? (
            <button type="button" className="send-btn is-mic" onClick={startRecording} aria-label="Record a voice message"><Icon name="mic" size={20} /></button>
          ) : (
            <button type="submit" className="send-btn" aria-label="Send" disabled><Icon name="send" size={20} strokeWidth={2.4} /></button>
          )}
        </div>
      </form>
    </div>
  )
}

// A small popover menu: the composer's "+" (Camera, Photos, Files) and the header's ⋯. Closes on
// a tap outside, Escape or a choice. items: [{ id, icon, label, hint?, checked?, disabled?, onClick }].
function PopMenu({ id, label, items: entries, focusFirst, anchorRef, onClose, placement = 'up' }) {
  const menuRef = useRef(null)
  const items = () => Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])

  useEffect(() => {
    if (focusFirst) items()[0]?.focus({ preventScroll: true })
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target) || anchorRef.current?.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
      anchorRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [focusFirst, anchorRef, onClose])

  function onMenuKeyDown(event) {
    if (event.key === 'Tab') {
      onClose()
      return
    }
    const list = items()
    const index = list.indexOf(document.activeElement)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key]
    if (next === undefined || !list.length) return
    event.preventDefault()
    list[(next + list.length) % list.length]?.focus()
  }

  return (
    <div ref={menuRef} id={id} className={`asst-menu is-${placement}`} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
      {entries.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          className={`asst-menu-item ${item.checked ? 'is-checked' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          <span className={`asst-menu-icon is-${item.id}`} aria-hidden="true"><Icon name={item.icon} size={20} /></span>
          <span className="asst-menu-text">
            <strong>{item.label}</strong>
            {item.hint && <small>{item.hint}</small>}
          </span>
          {item.checked && <Icon name="check" size={18} strokeWidth={2.4} className="asst-menu-check" />}
        </button>
      ))}
    </div>
  )
}

function AttachmentTray({ items, onRemove, onRetry }) {
  return (
    <ul className="asst-tray" aria-label="Attachments">
      {items.map((item) => <TrayItem key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} />)}
    </ul>
  )
}

// A photo thumbnail or a file chip, with its upload progress, an × and (after a failed upload) retry.
function TrayItem({ item, onRemove, onRetry }) {
  const photo = item.kind === 'image'
  const failed = item.status === 'error'
  const working = inFlight(item)
  const percent = Math.round((Number(item.progress) || 0) * 100)
  const status = item.status === 'preparing' ? 'Preparing…'
    : item.status === 'uploading' ? `Uploading… ${percent}%`
      : failed ? 'Didn’t upload · Tap to retry'
        : `${kindName(item.kind)} · ${formatBytes(item.bytes)}`
  const preview = item.previewUrl || item.dataUrl
  const ring = <ProgressRing value={item.status === 'uploading' ? item.progress : undefined} />
  const content = photo ? (
    <>
      {preview ? <img src={preview} alt="" /> : null}
      {(working || failed) && <span className="asst-veil" aria-hidden="true">{failed ? <Icon name="refresh" size={20} strokeWidth={2.2} /> : ring}</span>}
    </>
  ) : (
    <>
      <span className={`asst-chip-icon is-${item.kind}`} aria-hidden="true">
        {working ? ring : <Icon name={failed ? 'refresh' : kindIcon(item.kind)} size={18} />}
      </span>
      <span className="asst-chip-text" aria-hidden="true">
        <strong>{item.name}</strong>
        <small>{status}</small>
      </span>
    </>
  )

  return (
    <li className={`asst-tray-item ${photo ? 'is-photo' : 'is-file'} is-${item.status}`}>
      {failed ? (
        <button type="button" className="asst-tray-body" onClick={() => onRetry(item.id)} aria-label={`${item.name} didn’t upload. Try again`} title={item.error || undefined}>
          {content}
        </button>
      ) : (
        <span className="asst-tray-body">
          {content}
          <span className="sr-only">{`${item.name}, ${photo && item.status === 'ready' ? 'photo' : status}`}</span>
        </span>
      )}
      <button type="button" className="asst-tray-remove" onClick={() => onRemove(item.id)} aria-label={`${working ? 'Cancel' : 'Remove'} ${item.name}`}>
        <Icon name="close" size={12} strokeWidth={3} />
      </button>
    </li>
  )
}

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

// Upload progress (0…1), or a spinning arc while the size isn't known yet.
function ProgressRing({ value }) {
  const known = Number.isFinite(value)
  const shown = known ? Math.max(0.04, Math.min(1, value)) : 0.28
  return (
    <svg className={`asst-ring ${known ? '' : 'is-spinning'}`} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <circle className="asst-ring-track" cx="12" cy="12" r={RING_RADIUS} />
      <circle className="asst-ring-bar" cx="12" cy="12" r={RING_RADIUS} strokeDasharray={RING_LENGTH} strokeDashoffset={RING_LENGTH * (1 - shown)} />
    </svg>
  )
}

function MemorySheet({ open, onClose, memories, setMemories, enabled }) {
  async function forget(memory) {
    try {
      await apiRequest(`/api/assistant?memoryId=${encodeURIComponent(memory.id)}`, { method: 'DELETE' })
      setMemories((current) => current.filter((item) => item.id !== memory.id))
      toast('Forgotten')
    } catch (error) {
      toast(error.message, { tone: 'error' })
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="What I remember" description="Things you’ve told me, kept for every conversation. Tap × to forget one." initialFocus={false}>
      {!enabled ? (
        <p className="muted">Memory isn’t switched on yet: the assistant_memories table needs to be created in Supabase.</p>
      ) : memories.length === 0 ? (
        <EmptyState icon="bookmark" title="Nothing yet">Tell me things like “my sister is Sara” or “I’m vegetarian” and I’ll remember them.</EmptyState>
      ) : (
        <ul className="memory-list asst-memories">
          {memories.map((memory) => (
            <li key={memory.id}>
              <span>{memory.content}</span>
              <button type="button" className="icon-btn icon-btn-sm asst-forget" onClick={() => forget(memory)} aria-label={`Forget: ${memory.content}`}><Icon name="close" size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

// ---- helpers -----------------------------------------------------------------------------------

// What goes to the server for one attachment: text inline, photos and PDFs by their storage path
// (or, when uploads aren't available, as a data URL).
function attachmentPayload({ kind, name, text, path, dataUrl }) {
  if (kind === 'text') return { kind, name, text }
  return path ? { kind, name, path } : { kind, name, dataUrl }
}

// How an attachment shows in the sent message: photos keep their preview (this visit only).
function shownAttachment({ kind, name, previewUrl, dataUrl }) {
  const thumb = kind === 'image' ? previewUrl || dataUrl : ''
  return { kind, name, ...(thumb ? { thumb } : {}) }
}

// Still being prepared or uploaded.
const inFlight = (item) => item?.status === 'preparing' || item?.status === 'uploading'
// Bytes an attachment adds to the chat request itself, and to storage.
const inlineBytes = (item) => (item.kind === 'text' || item.dataUrl ? Number(item.bytes) || 0 : 0)
const uploadBytes = (item) => (item.kind !== 'text' && !item.dataUrl ? Number(item.bytes) || 0 : 0)
const sumBytes = (items, bytesOf) => items.reduce((sum, item) => sum + bytesOf(item), 0)

// The shape kept in localStorage: no photos or file contents, and no in-flight states.
function cacheMessage({ role, content, voice, actions, proposal, choices, attachments, createdAt }) {
  return {
    role,
    content: typeof content === 'string' ? content : '',
    ...(createdAt ? { createdAt } : {}),
    ...(voice ? { voice } : {}),
    ...(actions?.length ? { actions: actions.slice(0, 10).map(({ tool, ok, message }) => ({ tool, ok, message })) } : {}),
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
        })),
        ...(Array.isArray(proposal.results) ? { results: cleanResults(proposal.results) } : {}),
      },
    } : {}),
    ...(choices?.length ? { choices: choices.slice(0, 6) } : {}),
    ...(attachments?.length ? { attachments: attachments.slice(0, MAX_ATTACHMENTS).map(({ kind, name }) => ({ kind, name })) } : {}),
  }
}

// Action chips for the finished reply: the server's filtered list, or (older server) its results
// without lookups. Chips need a message unless they report a failure.
function doneActions(done, streamed) {
  const list = Array.isArray(done.actions)
    ? done.actions
    : Array.isArray(done.results) ? done.results.filter((result) => result && (!LOOKUP_TOOLS.has(result.tool) || !result.ok)) : streamed || []
  return list
    .filter((action) => action && typeof action === 'object' && (action.message || action.ok === false))
    .map(({ tool, ok, message }) => ({ tool, ok: ok !== false, message }))
}

// Per-action results of a confirmed proposal, bounded: { label?, ok, message? } in action order.
export function cleanResults(value) {
  return (Array.isArray(value) ? value : []).filter((result) => result && typeof result === 'object').slice(0, 25).map((result) => ({
    ...(result.label ? { label: String(result.label).slice(0, 300) } : {}),
    ok: result.ok !== false,
    ...(result.message ? { message: String(result.message).slice(0, 300) } : {}),
  }))
}

// done / partial / failed from a confirmed run's action results.
export function outcomeOf(results) {
  const list = (Array.isArray(results) ? results : []).filter((result) => result && typeof result === 'object')
  const ok = list.filter((result) => result.ok !== false).length
  if (ok === list.length) return 'done'
  return ok ? 'partial' : 'failed'
}

// The reply already asks something ("Shall I go ahead?"), so read-aloud doesn't ask twice.
export const endsWithQuestion = (text) => /\?["'”’)\]]*$/.test(plainText(text).trim())

// The quick reply on the newest message that `text` repeats ("yes" for "Yes"), or ''.
export function matchChoice(message, text) {
  if (!message || message.role !== 'assistant' || message.streaming || !Array.isArray(message.choices)) return ''
  const key = choiceKey(text)
  return key ? message.choices.find((choice) => typeof choice === 'string' && choiceKey(choice) === key) || '' : ''
}
const choiceKey = (text) => String(text || '').toLowerCase().replace(/[’‘]/g, '\'').replace(/[\s.!,;:]+$/g, '').replace(/\s+/g, ' ').trim()

const REQUEST_OVERHEAD_BYTES = 2_000 // device context, stream flag, the audio's keys and MIME type

// UTF-8 bytes of `value` as JSON.
function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || '').length
  } catch {
    return 0
  }
}

// Size of the request for this payload, in bytes.
export const requestBytes = (payload) => jsonBytes(payload) + REQUEST_OVERHEAD_BYTES

const PATH_ALLOWANCE_BYTES = 300 // an uploaded file's storage path, not known until it has uploaded

// Seconds of voice note that still fit in one request next to these attachments. Uploaded files
// only add their path; ones still being prepared are counted once ready, failed ones don't go.
export function voiceBudgetSeconds(attachments) {
  let used = REQUEST_OVERHEAD_BYTES
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || ['preparing', 'loading', 'error'].includes(item.status)) continue
    used += jsonBytes(attachmentPayload(item)) + (item.kind === 'text' || item.dataUrl ? 1 : PATH_ALLOWANCE_BYTES)
  }
  const room = MAX_REQUEST_BYTES - used
  return Math.max(0, Math.min(MAX_VOICE_SECONDS, Math.floor(room / VOICE_BYTES_PER_SECOND)))
}

function cleanChoices(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.choices) ? value.choices : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const choice = typeof item === 'string' ? item.trim() : ''
    if (!choice || seen.has(choice.toLowerCase())) continue
    seen.add(choice.toLowerCase())
    out.push(choice.slice(0, 80))
    if (out.length === 6) break
  }
  return out
}

// Small "Open Gym ›" style links after changes that live on another page.
function deepLinks(actions) {
  const links = []
  for (const link of DEEP_LINKS) {
    if (actions.some((action) => action.ok && typeof action.tool === 'string' && link.test.test(action.tool))) links.push(link)
  }
  return links.slice(0, 2)
}

const kindIcon = (kind) => (kind === 'image' ? 'image' : kind === 'pdf' ? 'fileText' : 'file')
const kindName = (kind) => (kind === 'image' ? 'Photo' : kind === 'pdf' ? 'PDF' : 'Text')

// true / false for this device, null when it can't be told (no push support, dev build).
async function devicePushStatus() {
  try {
    const support = pushSupport()
    if (support === 'denied' || support === 'default') return false
    if (support !== 'granted') return null
    // A worker that isn't ready in time means "can't tell", not "off" (currentSubscription() folds the two).
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ])
    if (!registration?.pushManager) return null
    return !!(await registration.pushManager.getSubscription())
  } catch {
    return null
  }
}

// POST with stream:true and read newline-delimited JSON events as they arrive.
async function streamAssistant(payload, signal, onEvent) {
  const token = getToken()
  const response = await fetch('/api/assistant', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ...payload, stream: true }),
  }).catch((error) => {
    if (error.name === 'AbortError') throw error
    // Nothing reached the server, so nothing can have happened there.
    throw Object.assign(new Error('You’re offline — the assistant needs a connection.'), { notSent: true })
  })

  if (!response.ok || !(response.headers.get('content-type') || '').includes('ndjson')) {
    const raw = await response.text()
    let data = {}
    try { data = JSON.parse(raw) } catch { /* not JSON */ }
    // Only when the session that sent this is still the current one.
    if (response.status === 401 && token && getToken() === token) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    // Vercel's own 413 (body over 4.5 MB) has no JSON message.
    const message = response.status === 413 && !data.error
      ? 'That’s too much to send in one message. Remove an attachment and try again.'
      : data.error || `The assistant is unavailable right now (${response.status}).`
    throw Object.assign(new Error(message), { status: response.status })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = null
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (error) {
      // iOS reports a dropped connection as a bare "Load failed".
      if (error.name === 'AbortError') throw error
      throw new Error('The connection dropped before the reply finished. Please try again.')
    }
    const { value, done: finished } = chunk
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const event = JSON.parse(line)
      if (event.type === 'error') throw new Error(event.error || 'The assistant ran into a problem.')
      if (event.type === 'done') done = event
      else onEvent(event)
    }
  }
  if (!done) throw new Error('The connection dropped before the reply finished. Please try again.')
  return done
}

// Local date/time/zone so "today" is right, the last known location for weather and prayer
// times, and whether this device gets push reminders.
function clientContext(pushEnabled) {
  const location = readPref('location', null)
  return {
    localDate: todayISO(),
    localTime: nowTimeHHMM(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pushEnabled: typeof pushEnabled === 'boolean' ? pushEnabled : null,
    ...(location ? { location: { lat: location.lat, lon: location.lon } } : {}),
  }
}

// iOS Safari only speaks after a user gesture; an empty utterance during the tap unlocks it for the
// reply that arrives seconds later.
function unlockSpeech() {
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
  } catch {
    // not supported
  }
}

// Reply text without markdown symbols, for speech and screen readers.
const plainText = (text) => String(text || '').replace(/[*`_#>]/g, '').replace(/^\s*[-•]\s+/gm, '')

function speakText(text) {
  if (!('speechSynthesis' in window) || !text) return
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(text)))
}

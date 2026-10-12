import { useEffect, useState } from 'react'
import VoiceView from './VoiceView.jsx'
import TalkCard from './TalkCard.jsx'
import { ACCENTS, applyTheme } from '../../lib/theme.js'
import './voice.css'

// DEV ONLY (#/voice-preview, registered in App.jsx behind import.meta.env.DEV, so production builds
// don't contain it): the voice chat screen and the chat's voice-chat card in every state, with made-up
// data, for checking the layout in a browser without a microphone, a login or an OpenAI call.
//   #/voice-preview/<state>[/<light|dark>[/<accent>]]   e.g. #/voice-preview/pending/dark/lagoon
// ← / → step through the states. Buttons on the screen do nothing (there's no call behind it), except
// what's drawn locally (Transcript, the mode menu). Use a phone-sized window (the layout follows the
// window, not a frame): the browser pane's mobile preset, or 852×393 for a phone on its side.

const now = Date.now()
const ago = (ms) => new Date(now - ms).toISOString()
// The fixtures' times, moved up to the moment of drawing: a tab left open doesn't turn "executing"
// into "interrupted" or a waiting card into an expired one.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
function restamp(value, shift) {
  if (typeof value === 'string') return ISO_RE.test(value) ? new Date(Date.parse(value) + shift).toISOString() : value
  if (Array.isArray(value)) return value.map((item) => restamp(item, shift))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restamp(item, shift)]))
  return value
}
const fakeLevel = () => 0.35 + 0.3 * Math.sin(Date.now() / 180)

const BASE = {
  status: 'live', activity: 'listening', talkId: 'talk_preview', intent: 'chat', from: 'chat',
  seconds: 94, usd: 0.07, mode: 'open', muted: false, holding: false, keyboard: false, quiet: false,
  route: 'speaker', error: null, pauseReason: null, endReason: null, intro: null,
  turns: [], actions: [], proposal: null, deciding: false, working: 0,
  notice: null, warnTime: false, leftSec: null, hasUserTurn: true, startedAt: ago(94000),
  summary: null, limits: null, dailyMinutes: 30, budgetUsd: 20, spentUsd: 3, startChips: [],
}

const turn = (id, r, text, extra = {}) => ({ id, r, text, partial: false, phase: null, interrupted: false, failed: false, responseId: null, at: ago(60000), ...extra })

const BREAKFAST = [
  'Scrambled eggs · 2 eggs · 180 kcal', 'Whole wheat toast · 2 slices · 160 kcal', 'Butter · 1 tbsp · 100 kcal',
  'Greek yogurt · 170 g · 150 kcal', 'Banana · 1 medium · 105 kcal', 'Orange juice · 250 ml · 110 kcal',
  'Milk tea · 1 cup · 90 kcal', 'Miscellaneous · 100 kcal',
]
const FOOD_CARD = {
  id: 'prop_food', status: 'pending', createdAt: ago(4000), summary: 'Log 8 items for breakfast',
  actions: BREAKFAST.map((label) => ({ label, tool: 'food_log' })),
}
const LONG_TURNS = [
  turn('u1', 'u', 'For breakfast I had two scrambled eggs, two slices of whole wheat toast with butter, Greek yogurt, a banana, orange juice and a milk tea.'),
  turn('a1', 'a', 'Got it. That’s 7 items for breakfast, about 895 calories. Save it?'),
  turn('u2', 'u', 'And add 100 calories extra for miscellaneous.'),
  turn('a2', 'a', 'Here’s what I’ll log for breakfast: scrambled eggs, whole wheat toast, butter, Greek yogurt, a banana, orange juice, milk tea and a miscellaneous 100 calories. That’s 8 items, about 995 calories, which puts today at 1,410 of 2,000. Save it?'),
]
const LOGGED = { ok: true, tool: 'food_log', undoId: 'undo_food', message: 'Logged 8 items (Scrambled eggs, Whole wheat toast, Butter, Greek yogurt, Banana, Orange juice, Milk tea, Miscellaneous) · 995 kcal' }
const TASK = { ok: true, tool: 'create_task', undoId: 'undo_task', message: 'Added “Call the dentist” for tomorrow 9:00 AM' }

const STATES = {
  connecting: { status: 'connecting', activity: 'connecting', seconds: 0, usd: 0, hasUserTurn: false },
  listening: {
    activity: 'listening', hasUserTurn: false, seconds: 3, usd: 0,
    turns: [turn('g', 'a', 'Hi! What’s on your mind?')],
    startChips: [{ id: 'plan', label: 'Plan my day', text: '' }, { id: 'journal', label: 'Journal my day', text: '' }, { id: 'food', label: 'Log food', text: '' }],
  },
  hearing: { activity: 'hearing', turns: [turn('a0', 'a', 'Hi! What’s on your mind?'), turn('u0', 'u', '', { partial: true })] },
  speaking: {
    activity: 'speaking',
    turns: [turn('u1', 'u', 'What does my afternoon look like?'), turn('a1', 'a', 'You’ve got the design review at 2:00 PM, then a gap until your 4:30 PM call with Sam. Your gym session is at 6:00 PM, and you still have “Send the invoice” due today. Want me to move the invoice to the 3:00 PM gap?', { partial: true })],
  },
  thinking: { activity: 'thinking', turns: [turn('u1', 'u', 'Move the invoice to three.'), turn('a1', 'a', 'One sec…', { phase: 'commentary' })] },
  working: { activity: 'working', working: 1, turns: [turn('u1', 'u', 'How much protein did I have this week?'), turn('a1', 'a', 'Let me check that for you.', { phase: 'commentary' })] },
  pending: { activity: 'listening', turns: LONG_TURNS, proposal: FOOD_CARD },
  'pending-hold': { activity: 'listening', mode: 'hold', turns: LONG_TURNS, proposal: FOOD_CARD, actions: [TASK] },
  // The waiting card changed in place by a later turn (same id, revision 2).
  updated: { activity: 'listening', turns: LONG_TURNS, proposal: { ...FOOD_CARD, revision: 2 } },
  executing: { activity: 'thinking', turns: LONG_TURNS, proposal: { ...FOOD_CARD, status: 'executing', executingAt: ago(500) }, deciding: true },
  saved: {
    activity: 'speaking',
    turns: [...LONG_TURNS, turn('a3', 'a', 'Done, saved your breakfast.')],
    proposal: { ...FOOD_CARD, status: 'done', answeredBy: 'tap', results: BREAKFAST.map(() => ({ ok: true })) },
    actions: [LOGGED],
    ack: { proposalId: FOOD_CARD.id, decision: 'yes', ok: true, status: 'done', already: false, at: Date.now() },
  },
  cancelled: { turns: [...LONG_TURNS, turn('a3', 'a', 'Okay, I won’t save it.')], proposal: { ...FOOD_CARD, status: 'cancelled' } },
  // Replaced by a hand-off to the full assistant (ask_daybook).
  superseded: { turns: [...LONG_TURNS, turn('a3', 'a', 'I passed that to Daybook. It needs one more detail first.')], proposal: { ...FOOD_CARD, status: 'superseded' } },
  muted: { muted: true, notice: { id: 'silence', tone: 'warn', text: 'Still there? Hanging up in 0:12', action: 'keep' }, turns: [turn('a1', 'a', 'Anything else?')] },
  hold: { mode: 'hold', holding: true, activity: 'hearing', turns: [turn('a1', 'a', 'Anything else?'), turn('u1', 'u', '', { partial: true })] },
  warn: {
    warnTime: true, leftSec: 50, seconds: 850, usd: 0.62,
    notice: { id: 'budget', tone: 'warn', text: 'You’ve used 80% of this month’s AI budget.' },
    turns: [turn('u1', 'u', 'Let’s wrap up the plan.'), turn('a1', 'a', 'Sure. Tomorrow starts with the gym at 7:00 AM, then the team sync at 10:00 AM.')],
  },
  echo: { notice: { id: 'echo', tone: 'info', text: 'I might be hearing myself. Hold to talk works better on the speaker.', action: 'switch' }, turns: [turn('a1', 'a', 'Anything else?')] },
  keyboard: { keyboard: true, quiet: true, turns: [turn('t1', 't', 'Add milk to the shopping list'), turn('a1', 'a', 'Added milk to your shopping list.')], actions: [{ ok: true, tool: 'create_task', undoId: 'u_milk', message: 'Added “Milk” to Shopping' }] },
  paused: { status: 'paused', pauseReason: 'background', summary: { saved: true, seconds: 312, usd: 0.24, canContinue: true }, turns: LONG_TURNS, proposal: FOOD_CARD },
  ending: { status: 'ending', summary: { saved: null, seconds: 312, usd: 0.24 } },
  ended: { status: 'ended', endReason: 'user', summary: { saved: true, end: 'user', seconds: 671, usd: 0.38 }, proposal: { ...FOOD_CARD, status: 'done' }, actions: [LOGGED, TASK] },
  'ended-cap': { status: 'ended', endReason: 'cap', summary: { saved: true, end: 'cap', seconds: 900, usd: 0.71, canContinue: true }, actions: [TASK] },
  'ended-unsaved': { status: 'ended', summary: { saved: false, end: 'error', seconds: 120, usd: 0.09 } },
  'ended-empty': { status: 'ended', summary: { saved: true, empty: true, end: 'user', seconds: 8, usd: 0.01 } },
  'error-mic': { status: 'error', error: { code: 'mic_denied', message: 'Daybook can’t use the microphone. Allow it in Settings, then try again.' } },
  'error-offline': { status: 'error', error: { code: 'offline', message: 'You’re offline. Voice chat needs a connection.' } },
  'error-budget': { status: 'error', error: { code: 'budget', message: 'This month’s AI budget is used up, so voice is paused. Typing still works.' } },
}
const NAMES = [...Object.keys(STATES), 'chat']

// Voice chats as the chat page shows them.
const TALK_TURNS = [
  { id: 'a', r: 'u', t: 'Log breakfast: two scrambled eggs, toast and a milk tea.' },
  { id: 'b', r: 'a', t: 'Here’s what I’ll log for breakfast: scrambled eggs, two slices of toast and a milk tea, about four hundred ninety calories. Save it?' },
  { id: 'c', r: 'u', t: 'And add 100 calories extra for miscellaneous.' },
  { id: 'd', r: 'a', t: 'Updated: 4 items, about 590 calories. Save it?' },
  { id: 'e', r: 't', t: 'yes' },
  { id: 'f', r: 'a', t: 'Done, saved your breakfast.' },
  { id: 'g', r: 'u', t: 'What’s left for today?' },
  { id: 'h', r: 'a', t: 'You have the design review at two and the invoice. That’s it.' },
]
const TALKS = [
  {
    id: 'm1', role: 'assistant', createdAt: ago(3600000), actions: [LOGGED, TASK],
    talk: { id: 'talk_1', startedAt: ago(3600000), endedAt: ago(3600000 - 671000), seconds: 671, usd: 0.38, end: 'user', turns: TALK_TURNS },
  },
  {
    id: 'm2', role: 'assistant', createdAt: ago(600000), actions: [],
    talk: { id: 'talk_2', startedAt: ago(1500000), endedAt: ago(600000), seconds: 900, usd: 0.71, end: 'cap', turns: TALK_TURNS.slice(0, 4) },
  },
  {
    id: 'm3', role: 'assistant', createdAt: ago(120000), actions: [{ ...TASK, undone: true }],
    talk: { id: 'talk_3', startedAt: ago(200000), endedAt: ago(120000), seconds: 80, usd: 0.04, end: 'error', turns: TALK_TURNS.slice(6) },
  },
]

function readHash() {
  const [, state = 'pending', appearance = '', accent = ''] = window.location.hash.replace(/^#\/?/, '').split('/')
  return { state: NAMES.includes(state) ? state : 'pending', appearance, accent }
}

export default function VoicePreview() {
  const [view, setView] = useState(readHash)

  useEffect(() => {
    const onHash = () => setView(readHash())
    const onKey = (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      const at = NAMES.indexOf(readHash().state)
      const next = NAMES[(at + (event.key === 'ArrowRight' ? 1 : NAMES.length - 1)) % NAMES.length]
      const { appearance, accent } = readHash()
      window.location.hash = ['', 'voice-preview', next, appearance, accent].join('/').replace(/\/+$/, '')
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    applyTheme({ appearance: ['light', 'dark'].includes(view.appearance) ? view.appearance : 'system', theme: ACCENTS.some((item) => item.id === view.accent) ? view.accent : undefined })
    document.title = `Voice preview · ${view.state}`
  }, [view])

  const shift = Date.now() - now
  if (view.state === 'chat') {
    const talks = restamp(TALKS, shift)
    return (
      <main className="page page-assistant" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }}>
        <div className="assistant">
          <div className="chat">
            {talks.map((message) => <TalkCard key={message.id} message={message} onUndo={() => {}} />)}
            <TalkCard
              message={{ ...talks[0], id: 'm4', talk: { ...talks[0].talk, id: 'talk_4' } }}
              proposals={[{ proposal: { ...FOOD_CARD, createdAt: new Date().toISOString() }, createdAt: new Date().toISOString() }]}
              isLast
              onUndo={() => {}}
              renderCard={() => <p className="talk-transcript-note">(a card waiting for a yes is drawn here by the chat page)</p>}
            />
          </div>
        </div>
      </main>
    )
  }

  const voice = restamp({ ...BASE, ...STATES[view.state] }, shift)
  return (
    <div style={{ position: 'fixed', inset: 0 }} data-preview-state={view.state}>
      <VoiceView key={view.state} voice={voice} inline level={fakeLevel} />
    </div>
  )
}

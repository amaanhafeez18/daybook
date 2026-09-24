import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../ui/Icon.jsx'
import { getState, updateSettings } from '../../lib/store.js'
import { createTask, deleteTaskForever } from '../../lib/planner.js'
import { dueSentence, parseQuickAdd, todayISO } from '../../lib/dates.js'
import { currentSubscription, enableNotifications, pushSupport } from '../../lib/notifications.js'
import { AddHomeIcon, AssistantVisual, DoneVisual, ExtrasVisual, HeroVisual, NotifyVisual, ShareIcon, TILE_IDS, TodayVisual } from './visuals.jsx'
import '../welcome.css'

const INTERESTS = [
  { id: 'tasks', label: 'Tasks & reminders', icon: 'tasks' },
  { id: 'classes', label: 'Classes', icon: 'graduation' },
  { id: 'people', label: 'People & catch-ups', icon: 'people' },
  { id: 'gym', label: 'Gym', icon: 'dumbbell' },
  { id: 'food', label: 'Food', icon: 'utensils' },
  { id: 'journal', label: 'Journal', icon: 'journal' },
]
// Tapped first-task ideas; the day/time words show off the quick-add parsing.
const IDEAS = { classes: 'Finish essay Friday', gym: 'Gym tomorrow 7am', food: 'Meal prep Sunday' }
const BASE_IDEAS = ['Plan my week', 'Call mom at 6pm', 'Groceries tomorrow']

const SWIPE_SLOP = 10
const SWIPE_PX = 60
const FLICK_PX_PER_MS = 0.4
const NOT_A_SWIPE = 'input, textarea, select, [contenteditable]'
const WIDE_QUERY = '(min-width: 900px)'
const NAME_LIKE = /^\p{L}[\p{L} .'’-]*$/u
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true

// Web push on iPhone needs the Home Screen app, so outside it the step explains how to install.
function initialPush() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const support = pushSupport()
  if (support === 'install' || (ios && !isStandalone())) return 'install'
  if (support === 'default' || support === 'granted') return 'ask'
  return support === 'denied' ? 'denied' : 'unavailable'
}

// Full-screen tour for a new account (a centred card on wide screens): one idea per screen, swipe or
// buttons, Skip on every screen. Every change it makes goes through the store like anywhere else.
export default function WelcomeFlow({ user, onClose }) {
  // Their display name, or the username when it reads as a name ("Sarah", not "sk_2004"), so the
  // greetings in the tour don't address them by a login handle.
  const [name, setName] = useState(() => getState().data.settings?.displayName || (NAME_LIKE.test(user?.username || '') ? user.username : ''))
  const [picks, setPicks] = useState(() => new Set(['tasks']))
  const [added, setAdded] = useState([]) // tasks made on the Today screen, newest first
  const [draft, setDraft] = useState('')
  const [push, setPush] = useState(initialPush)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState('')
  const [index, setIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  const dialogRef = useRef(null)
  const trackRef = useRef(null)
  const taskInputRef = useRef(null)
  const closeTimer = useRef(null)
  const baseId = useId()

  const steps = useMemo(() => [
    'welcome', 'you', 'today', 'assistant',
    ...(TILE_IDS.some((id) => picks.has(id)) ? ['more'] : []),
    'notify', 'done',
  ], [picks])
  const step = steps[index]
  const firstName = name.trim().split(/\s+/)[0] || ''
  const ideas = useMemo(() => [...Object.keys(IDEAS).filter((id) => picks.has(id)).map((id) => IDEAS[id]).slice(0, 2), ...BASE_IDEAS].slice(0, 3), [picks])
  const wide = useWide()

  // ---- leaving -------------------------------------------------------------------------------

  function saveName() {
    const next = name.trim().slice(0, 40)
    const current = getState().data.settings?.displayName || ''
    if (next === current || (!current && (!next || next === user?.username))) return
    updateSettings({ displayName: next })
  }

  function finish(route) {
    if (closing) return
    saveName()
    if (route) window.location.hash = `#/${route}`
    setClosing(true)
    closeTimer.current = setTimeout(onClose, reducedMotion() ? 0 : 260)
  }

  function go(target) {
    const next = Math.max(0, Math.min(steps.length - 1, target))
    if (next === index) return
    if (step === 'you') saveName()
    setIndex(next)
  }

  // ---- first task ----------------------------------------------------------------------------

  function addTask(text) {
    const value = text.trim()
    if (!value) return
    const parsed = parseQuickAdd(value, new Date())
    const understood = parsed.matched.length > 0 && parsed.title
    const today = todayISO()
    const task = createTask(understood ? { text: parsed.title, date: parsed.date || today, time: parsed.time } : { text: value, date: today })
    setAdded((list) => [task, ...list])
    setDraft('')
  }

  // Typed (Return or the + button): on a phone the keyboard then goes away, so the new task can be
  // seen landing on the card above.
  function submitDraft() {
    if (!draft.trim()) return
    addTask(draft)
    if (window.matchMedia?.('(pointer: coarse)').matches) taskInputRef.current?.blur()
  }

  function undoTask() {
    const [last] = added
    if (!last) return
    deleteTaskForever(last.id)
    setAdded((list) => list.slice(1))
  }

  // ---- notifications (must start from the tap: iOS only asks for a user gesture) ----------

  useEffect(() => {
    currentSubscription().then((subscription) => { if (subscription) setPush('on') }).catch(() => {})
  }, [])

  async function turnOnPush() {
    setPushBusy(true)
    setPushError('')
    try {
      await enableNotifications()
      setPush('on')
    } catch (error) {
      setPushError(error.message)
      setPush(initialPush())
    } finally {
      setPushBusy(false)
    }
  }

  // ---- focus, keys, scroll lock -------------------------------------------------------------

  // Keys are heard on the document: focus can drop to <body> when its screen slides away (inert).
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      finish()
    } else if (event.key === 'Tab') {
      trapFocus(event, dialogRef.current)
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !event.target.closest?.(NOT_A_SWIPE)) {
      event.preventDefault()
      go(index + (event.key === 'ArrowRight' ? 1 : -1))
    }
  }
  const keyRef = useRef(onKeyDown)
  keyRef.current = onKeyDown

  useEffect(() => {
    const returnTo = document.activeElement
    const root = document.documentElement
    root.classList.add('has-welcome')
    const onKey = (event) => keyRef.current(event)
    document.addEventListener('keydown', onKey)
    const timer = setTimeout(() => dialogRef.current?.focus({ preventScroll: true }), 60)
    return () => {
      clearTimeout(timer)
      clearTimeout(closeTimer.current)
      document.removeEventListener('keydown', onKey)
      root.classList.remove('has-welcome')
      returnTo?.focus?.({ preventScroll: true })
    }
  }, [])

  // ---- slides & swipe -----------------------------------------------------------------------

  const place = (dx = 0) => {
    if (trackRef.current) trackRef.current.style.transform = `translate3d(calc(${-index * 100}% + ${dx}px), 0, 0)`
  }
  useLayoutEffect(() => place(), [index]) // eslint-disable-line react-hooks/exhaustive-deps

  const drag = useRef(null)
  const swallowClick = useRef(false)
  const swipe = {
    onPointerDown(event) {
      swallowClick.current = false
      if (event.pointerType === 'mouse' || !event.isPrimary || event.target.closest?.(NOT_A_SWIPE)) return
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false, samples: [[event.timeStamp, event.clientX]] }
    },
    onPointerMove(event) {
      const d = drag.current
      if (!d || event.pointerId !== d.id) return
      const dx = event.clientX - d.x
      const dy = event.clientY - d.y
      if (!d.active) {
        if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) > Math.abs(dx)) { drag.current = null; return } // a scroll
        if (Math.abs(dx) < SWIPE_SLOP) return
        d.active = true
        trackRef.current?.classList.add('is-dragging')
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
      }
      const edge = (index === 0 && dx > 0) || (index === steps.length - 1 && dx < 0)
      d.dx = edge ? dx / 3 : dx
      d.samples.push([event.timeStamp, event.clientX])
      if (d.samples.length > 6) d.samples.shift()
      place(d.dx)
    },
    onPointerUp(event) { endSwipe(event, true) },
    onPointerCancel(event) { endSwipe(event, false) },
  }

  function endSwipe(event, released) {
    const d = drag.current
    if (!d || event.pointerId !== d.id) return
    drag.current = null
    if (!d.active) return
    swallowClick.current = true
    trackRef.current?.classList.remove('is-dragging')
    const [first] = d.samples
    const speed = (event.clientX - first[1]) / Math.max(1, event.timeStamp - first[0])
    const dir = !released ? 0 : d.dx < -SWIPE_PX || speed < -FLICK_PX_PER_MS ? 1 : d.dx > SWIPE_PX || speed > FLICK_PX_PER_MS ? -1 : 0
    const target = Math.max(0, Math.min(steps.length - 1, index + dir))
    if (target === index) place()
    else go(target)
  }

  // ---- screens -------------------------------------------------------------------------------

  const SCREENS = {
    welcome: {
      title: 'Welcome to Daybook',
      body: 'Your tasks, calendar, people and habits in one calm place, with an assistant that handles the busywork.',
      visual: <HeroVisual />,
      primary: { label: 'Get started', onClick: () => go(1), next: true },
      note: 'Takes about a minute',
    },
    you: {
      title: 'Make it yours',
      body: 'Pick what you’d like help with and we’ll tailor the tour. You can use everything either way.',
      content: (
        <div className="wl-form">
          <label className="wl-label" htmlFor={`${baseId}-name`}>What should we call you?</label>
          <input
            id={`${baseId}-name`}
            className="wl-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            maxLength={40}
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="done"
            placeholder="Your name"
          />
          <span className="wl-label" id={`${baseId}-picks`}>What do you want help with? <small>Pick any</small></span>
          <div className="wl-picks" role="group" aria-labelledby={`${baseId}-picks`}>
            {INTERESTS.map((item) => {
              const on = picks.has(item.id)
              return (
                <button
                  key={item.id}
                  type="button"
                  className="wl-pick"
                  aria-pressed={on}
                  onClick={() => setPicks((current) => {
                    const next = new Set(current)
                    if (on) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })}
                >
                  <span className="wl-pick-icon">
                    <Icon name={item.icon} size={19} />
                    <span className="wl-pick-check"><Icon name="check" size={10} strokeWidth={3.4} /></span>
                  </span>
                  <span className="wl-pick-label">{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      ),
      primary: { label: 'Continue', onClick: () => go(index + 1), next: true },
    },
    today: {
      title: 'Your day on one screen',
      body: 'Tasks, classes and catch-ups line up on Today. Try it: add your first task.',
      visual: <TodayVisual name={firstName} picks={picks} added={added} />,
      content: (
        <div className="wl-form">
          <form className="wl-add" onSubmit={(event) => { event.preventDefault(); submitDraft() }}>
            <label className="sr-only" htmlFor={`${baseId}-task`}>Your first task</label>
            <input
              ref={taskInputRef}
              id={`${baseId}-task`}
              className="wl-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                submitDraft()
              }}
              placeholder="e.g. Call mom tomorrow at 5pm"
              maxLength={200}
              autoComplete="off"
              enterKeyHint="done"
            />
            <button type="submit" className="wl-add-btn" disabled={!draft.trim()} aria-label="Add task">
              <Icon name="plus" size={20} strokeWidth={2.4} />
            </button>
          </form>
          {added.length ? (
            <p className="wl-added" role="status">
              <span className="wl-tick"><Icon name="check" size={11} strokeWidth={3} /></span>
              <span>Added for {dueSentence(added[0].date, added[0].time)}.</span>
              <button type="button" className="wl-link" onClick={undoTask}>Undo</button>
            </p>
          ) : (
            <div className="wl-ideas">
              {ideas.map((idea) => (
                <button key={idea} type="button" className="wl-idea" onClick={() => addTask(idea)}>
                  <Icon name="plus" size={14} strokeWidth={2.4} />{idea}
                </button>
              ))}
            </div>
          )}
        </div>
      ),
      primary: { label: 'Continue', onClick: () => go(index + 1), next: true },
    },
    assistant: {
      title: 'Or just ask',
      body: 'Type or talk. The assistant adds tasks, plans your week and answers questions, and checks with you before changing anything.',
      visual: <AssistantVisual />,
      primary: { label: 'Continue', onClick: () => go(index + 1), next: true },
    },
    more: {
      title: 'Built around your routine',
      body: 'The things you picked each have a home of their own.',
      visual: <ExtrasVisual picks={picks} />,
      primary: { label: 'Continue', onClick: () => go(index + 1), next: true },
    },
    notify: {
      title: 'Never miss a thing',
      body: 'A summary of your day each morning, and a nudge 15 minutes before anything with a time.',
      visual: <NotifyVisual />,
      content: <PushStatus state={push} error={pushError} />,
      primary: push === 'ask'
        ? { label: pushBusy ? 'Turning on…' : 'Turn on notifications', onClick: turnOnPush, busy: pushBusy }
        : { label: 'Continue', onClick: () => go(index + 1), next: true },
      secondary: push === 'ask' ? { label: 'Not now', onClick: () => go(index + 1) } : null,
    },
    done: {
      title: `You’re all set${firstName ? `, ${firstName}` : ''}`,
      body: 'Here’s where to find things.',
      visual: <DoneVisual />,
      content: <WhereThings picks={picks} wide={wide} />,
      primary: { label: 'Start using Daybook', onClick: () => finish('today') },
      secondary: { label: 'Ask the assistant something', onClick: () => finish('assistant') },
    },
  }
  const current = SCREENS[step]

  return createPortal(
    <div className={`wl ${closing ? 'is-closing' : ''}`}>
      <div
        ref={dialogRef}
        className="wl-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title-${step}`}
        tabIndex={-1}
      >
        <header className="wl-top">
          <button type="button" className="wl-icon-btn" onClick={() => go(index - 1)} aria-label="Back" disabled={index === 0}>
            <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
          </button>
          <span className="wl-progress" aria-hidden="true">
            {steps.map((id, i) => <span key={id} className={i <= index ? 'is-on' : ''} />)}
          </span>
          {step === 'done'
            ? <span className="wl-skip" aria-hidden="true" />
            : <button type="button" className="wl-skip" onClick={() => finish()}>Skip</button>}
        </header>
        <p className="sr-only" aria-live="polite">{`Step ${index + 1} of ${steps.length}: ${current.title}`}</p>

        <div
          className="wl-viewport"
          {...swipe}
          onClickCapture={(event) => {
            if (!swallowClick.current) return
            swallowClick.current = false
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <div ref={trackRef} className="wl-track">
            {steps.map((id, i) => {
              const screen = SCREENS[id]
              const active = i === index
              return (
                <section
                  key={id}
                  className={`wl-slide wl-slide-${id} ${active ? 'is-active' : ''}`}
                  aria-hidden={!active}
                  inert={active ? undefined : ''}
                >
                  <div className="wl-slide-inner">
                    {screen.visual && <div className="wl-visual">{screen.visual}</div>}
                    <h2 id={`${baseId}-title-${id}`} className="wl-title">{screen.title}</h2>
                    <p className="wl-body">{screen.body}</p>
                    {screen.content}
                  </div>
                </section>
              )
            })}
          </div>
        </div>

        <footer className="wl-foot">
          <button
            type="button"
            className="wl-primary"
            onClick={current.primary.onClick}
            disabled={current.primary.busy}
            aria-busy={current.primary.busy || undefined}
          >
            {current.primary.label}
            {current.primary.next && <Icon name="arrowRight" size={18} strokeWidth={2.2} />}
          </button>
          {current.secondary
            ? <button type="button" className="wl-secondary" onClick={current.secondary.onClick}>{current.secondary.label}</button>
            : <span className="wl-foot-note">{current.note || ''}</span>}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function PushStatus({ state, error }) {
  if (state === 'install') {
    return (
      <div className="wl-panel">
        <strong>On iPhone, add Daybook to your Home Screen first:</strong>
        <ol className="wl-steps">
          <li><span className="wl-step-n">1</span><span>Tap <span className="wl-kbd"><ShareIcon /> Share</span> in Safari</span></li>
          <li><span className="wl-step-n">2</span><span>Choose <span className="wl-kbd"><AddHomeIcon /> Add to Home Screen</span></span></li>
          <li><span className="wl-step-n">3</span><span>Open Daybook from your Home Screen and turn notifications on in Settings</span></li>
        </ol>
      </div>
    )
  }
  if (state === 'on') return <p className="wl-added wl-notify-on" role="status"><span className="wl-tick"><Icon name="check" size={11} strokeWidth={3} /></span>Notifications are on for this device.</p>
  const note = error || {
    denied: 'Notifications are blocked for Daybook. You can allow them in your phone’s Settings → Notifications.',
    // Already the installed app (an older iPhone, say): installing isn't the answer there.
    unavailable: isStandalone()
      ? 'Notifications aren’t available on this device yet. You’ll still see everything on Today.'
      : 'You can turn them on any time in Settings → Notifications, from the installed app.',
  }[state]
  return note ? <p className={`wl-panel ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined}>{note}</p> : null
}

function WhereThings({ picks, wide }) {
  const extras = [['journal', 'Journal'], ['gym', 'Gym'], ['food', 'Food']].filter(([id]) => picks.has(id)).map(([, label]) => label)
  const rows = [
    { icon: 'tasks', title: 'Tasks, Calendar & People', text: `In the ${wide ? 'sidebar' : 'tab bar'}, with Today and the Assistant.` },
    extras.length > 0 && { icon: picks.has('gym') ? 'dumbbell' : picks.has('food') ? 'utensils' : 'journal', title: extras.join(', ').replace(/, ([^,]*)$/, ' & $1'), text: wide ? 'Also in the sidebar.' : extras.length > 1 ? 'The icons at the top right.' : 'Its icon at the top right.' },
    picks.has('classes') && { icon: 'graduation', title: 'Classes', text: 'Add your timetable in Settings, or just tell the assistant.' },
    { icon: 'settings', title: 'Settings', text: wide ? 'At the foot of the sidebar: themes, notifications and more.' : 'Tap your picture, top left: themes, notifications and more.' },
  ].filter(Boolean)
  return (
    <ul className="wl-where">
      {rows.map((row) => (
        <li key={row.title}>
          <span className="wl-badge"><Icon name={row.icon} size={17} /></span>
          <span className="wl-row-text"><strong>{row.title}</strong><small>{row.text}</small></span>
        </li>
      ))}
    </ul>
  )
}

// The app's own switch from tab bar to sidebar (App.css), followed live: an iPad can rotate across it.
function useWide() {
  const [wide, setWide] = useState(() => !!window.matchMedia?.(WIDE_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia?.(WIDE_QUERY)
    if (!query?.addEventListener) return undefined
    const onChange = () => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
}

function trapFocus(event, container) {
  if (!container) return
  const focusable = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && !element.closest('[inert]') && element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const outside = !container.contains(document.activeElement)
  if (event.shiftKey && (outside || document.activeElement === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (outside || document.activeElement === last)) {
    event.preventDefault()
    first.focus()
  }
}

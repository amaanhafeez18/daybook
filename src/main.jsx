import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import { toast } from './components/ui/feedback.jsx'
import { hasUnsavedChanges } from './lib/store.js'
import { isTyping } from './lib/keyboard.js'
import { getSession } from './lib/assistantSession.js'
import { QUIET_WINDOW_MS, SCROLL_KEY, WORKOUT_KEY, awayLongEnough, canUpdateQuietly, holdsTypedText, scrollMemo, scrollToRestore, workoutRunning } from './lib/quietUpdate.js'
import './App.css'
import './glass.css'
import './apple.css'

// index.html's #root holds a static shell (top bar, title, two cards, tab bar) so the installed app
// never opens on a blank screen; the first render replaces it.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

restoreScrollAfterUpdate()

// Installed (home-screen) apps can stay open for days, so check for a new version whenever the app
// comes back to the foreground. A waiting version is applied quietly when nobody would notice (see
// lib/quietUpdate.js): at launch or on coming back after 10+ minutes away, before the first tap,
// with nothing unsaved or half-typed, no sheet open, no field focused, no reply being written and no
// workout running. Otherwise it's
// offered with a one-tap "Update" toast rather than swapping code mid-use. onNeedRefresh only fires
// once (when the worker starts waiting), so the toast is re-offered on each foreground while a
// worker is still waiting, throttled so it doesn't stack up.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let lastPrompt = 0
  let registration = null
  let hiddenAt = 0
  // The quiet window: open at launch and on a return after a while; the first tap or key closes it.
  let windowUntil = Date.now() + QUIET_WINDOW_MS
  const closeWindow = () => { windowUntil = 0 }
  window.addEventListener('pointerdown', closeWindow, { capture: true, passive: true })
  window.addEventListener('keydown', closeWindow, { capture: true })

  const promptUpdate = () => {
    if (Date.now() - lastPrompt < 60000) return
    lastPrompt = Date.now()
    toast('A new version of Daybook is ready.', { duration: 60000, action: { label: 'Update', onClick: () => updateSW(true) } })
  }
  const quietlySafe = (waiting) => canUpdateQuietly({
    inWindow: Date.now() < windowUntil && document.visibilityState === 'visible',
    waiting,
    unsaved: safely(hasUnsavedChanges, true),
    // A sheet, the welcome tour or the photo viewer is open.
    sheetOpen: ['has-sheet', 'has-welcome', 'has-att-viewer'].some((name) => document.documentElement.classList.contains(name)),
    typing: isTyping(document.activeElement),
    workoutActive: safely(() => workoutRunning(localStorage.getItem(WORKOUT_KEY)), true),
    // Text left in a field (quick add, the food card, the assistant's composer) or photos waiting to send.
    typed: safely(() => !!document.querySelector('#root .asst-tray li')
      || [...document.querySelectorAll('#root input, #root textarea')].some(holdsTypedText), true),
    replying: safely(() => !!getSession().busy, false),
  })
  // Apply now if it's safe, else offer it.
  const offer = (waiting) => {
    if (!quietlySafe(waiting)) {
      promptUpdate()
      return
    }
    safely(() => sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrollMemo(window.scrollY, window.location.hash, Date.now()))))
    updateSW(true)
  }
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => offer(true),
    onRegisteredSW(_url, reg) {
      if (!reg) return
      registration = reg
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') {
          hiddenAt = Date.now()
          return
        }
        if (awayLongEnough(hiddenAt, Date.now())) windowUntil = Date.now() + QUIET_WINDOW_MS
        if (registration.waiting) offer(true)
        registration.update().catch(() => {})
      })
    },
  })
}

// After a quiet update: back to where the page was, once the screen is tall enough again (the page
// renders from the local cache, but lazy parts may take a moment). Stops at the first touch.
function restoreScrollAfterUpdate() {
  const memo = safely(() => {
    const raw = sessionStorage.getItem(SCROLL_KEY)
    sessionStorage.removeItem(SCROLL_KEY)
    return raw ? JSON.parse(raw) : null
  }, null)
  const y = scrollToRestore(memo, window.location.hash, Date.now())
  if (!y) return
  const until = Date.now() + 2000
  let settled = 0
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('wheel', stop, true)
    window.removeEventListener('keydown', stop, true)
  }
  window.addEventListener('pointerdown', stop, true)
  window.addEventListener('wheel', stop, { capture: true, passive: true })
  window.addEventListener('keydown', stop, true)
  const step = () => {
    if (Date.now() > until) return stop()
    const room = (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight
    if (Math.abs(window.scrollY - y) <= 2) settled += 1
    else if (room >= y - 2) {
      settled = 0
      window.scrollTo(0, y)
    }
    // Held for a few frames: the page has stopped moving it (its own restore runs on mount too).
    if (settled >= 8) return stop()
    frame = requestAnimationFrame(step)
    return undefined
  }
  frame = requestAnimationFrame(step)
}

function safely(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

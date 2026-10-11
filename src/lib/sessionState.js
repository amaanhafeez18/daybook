import { useEffect, useState } from 'react'

// State that outlives a page while the app is in use: the Calendar's day, a search, a half-typed
// message come back as they were when you return to the tab. It's kept in memory only (never
// saved), and forgotten after more than 30 minutes in the background, at a new day and on sign-out
// (clearSessionState), so a second account never sees the first one's search or draft.

const STALE_MS = 30 * 60 * 1000
const memory = new Map()
let day = dayKey()
let hiddenAt = 0

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function clearSessionState() {
  memory.clear()
  day = dayKey()
}

// Drops everything once the day has changed.
function checkDay() {
  const today = dayKey()
  if (today === day) return
  memory.clear()
  day = today
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    if (hiddenAt && Date.now() - hiddenAt > STALE_MS) memory.clear()
    hiddenAt = 0
    checkDay()
  })
}

export function readSessionState(key, fallback) {
  checkDay()
  return memory.has(key) ? memory.get(key) : fallback
}

export function writeSessionState(key, value) {
  memory.set(key, value)
}

// Like useState, but the value starts from the last one this session kept under `key`.
export function useSessionState(key, initial) {
  const [value, setValue] = useState(() => {
    checkDay()
    if (memory.has(key)) return memory.get(key)
    return typeof initial === 'function' ? initial() : initial
  })
  useEffect(() => {
    memory.set(key, value)
  }, [key, value])
  return [value, setValue]
}

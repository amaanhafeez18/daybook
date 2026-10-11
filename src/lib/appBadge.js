import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './store.js'
import { badgeCount } from './agenda.js'
import { todayISO } from './dates.js'
import { isHomeScreenApp } from './notifications.js'

// The number on the app icon (Settings → Notifications → "Count on app icon", settings
// notifications.badge, off by default): open tasks that are overdue or due today, the set Today
// shows. This device keeps it right while the app is open or going to the background; with the app
// closed, every push carries the server's count (payload.appBadge, applied by public/push-sw.js).
// Never a "0": at nothing due the badge is cleared.

const isIOS = () => typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const hasBadgeApi = () => typeof navigator !== 'undefined' && 'setAppBadge' in navigator

// 'install' (open it from the Home Screen first; an iPhone Safari tab always lands here) |
// 'unsupported' (no badge API in this browser) | 'permission' (needs notifications allowed here) | 'ok'.
export function badgeSupport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported'
  const installed = isHomeScreenApp()
  if (isIOS() && !installed) return 'install'
  if (!hasBadgeApi()) return 'unsupported'
  if (!installed) return 'install' // desktop browsers only badge an installed app
  if ('Notification' in window && window.Notification.permission !== 'granted') return 'permission'
  return 'ok'
}

// Shows n on the icon (0 clears it). Resolves false when it couldn't; never throws.
export async function setIconCount(n) {
  try {
    if (!hasBadgeApi()) return false
    const count = Math.max(0, Math.min(9999, Math.round(Number(n) || 0)))
    if (count > 0) await navigator.setAppBadge(count)
    else await navigator.clearAppBadge?.()
    return true
  } catch {
    return false // no permission, or iPhone's Badges setting is off
  }
}

export async function clearIconCount() {
  try {
    if (!hasBadgeApi()) return false
    await navigator.clearAppBadge?.()
    return true
  } catch {
    return false
  }
}

// Local midnight + 1 s from now, in ms.
function msToTomorrow() {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
  return Math.max(1000, next - now)
}

export function useAppBadge() {
  const on = useStore((state) => state.data.settings?.notifications?.badge === true)
  const people = useStore((state) => state.data.settings?.areas?.people !== false)
  const loaded = useStore((state) => state.loaded)
  const tasks = useStore((state) => state.data.tasks)

  // The day rolls over at midnight (timer, re-armed each time) and on coming back to the app.
  const [day, setDay] = useState(todayISO)
  useEffect(() => {
    let timer = 0
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setDay(todayISO())
        arm()
      }, msToTomorrow())
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setDay(todayISO())
      arm() // timers stall while the app is suspended
    }
    arm()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const count = useMemo(() => badgeCount(tasks, day, { people }), [tasks, day, people])
  const supported = hasBadgeApi()

  // Off: clear once when this mounts, and again each time it's switched off.
  const wasOn = useRef(null)
  useEffect(() => {
    if (!supported) return
    if (!on && wasOn.current !== false) clearIconCount()
    wasOn.current = on
  }, [supported, on])

  // On: once the data has loaded, set the count a moment after it settles (ticking several tasks
  // in a row sets it once). Going to the background sets a pending count straight away.
  const pending = useRef(null)
  const timer = useRef(0)
  useEffect(() => {
    if (!supported || !on || !loaded) return undefined
    pending.current = count
    timer.current = setTimeout(() => {
      pending.current = null
      setIconCount(count)
    }, 250)
    return () => {
      clearTimeout(timer.current)
      pending.current = null
    }
  }, [supported, on, loaded, count])

  useEffect(() => {
    if (!supported) return undefined
    const onHidden = () => {
      if (document.visibilityState !== 'hidden' || pending.current === null) return
      clearTimeout(timer.current)
      const value = pending.current
      pending.current = null
      setIconCount(value)
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [supported])
}

// Mounted once in the app shell (signed in only).
export function AppBadgeSync() {
  useAppBadge()
  return null
}

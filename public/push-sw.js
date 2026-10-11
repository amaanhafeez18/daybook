// Imported by the generated service worker (vite.config.js → workbox.importScripts).
// Shows Daybook reminders and opens the right screen when one is tapped.

// The number on the app icon, when the push carries one (`appBadge`: Settings → Notifications →
// Count on app icon). 0 clears it. Never rejects: the notification matters more than the count.
function applyBadge(data) {
  try {
    if (!data || typeof data !== 'object' || !('appBadge' in data)) return Promise.resolve()
    const count = Math.min(9999, Math.round(Number(data.appBadge)))
    if (!Number.isFinite(count)) return Promise.resolve()
    const nav = self.navigator
    const result = count > 0 ? nav?.setAppBadge?.(count) : nav?.clearAppBadge?.()
    return Promise.resolve(result).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  if (!data || typeof data !== 'object') data = {}
  const title = data.title || 'Daybook'
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/badge-96.png', // monochrome mark for the Android status bar (iOS ignores it)
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || '/#/today' },
    }),
    applyBadge(data),
  ]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/#/today', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus()
        if ('navigate' in client) await client.navigate(url).catch(() => {})
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})

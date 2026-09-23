import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import { toast } from './components/ui/feedback.jsx'
import './App.css'
import './glass.css'
import './apple.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Installed (home-screen) apps can stay open for days, so check for a new version whenever the app
// comes back to the foreground and offer a one-tap reload rather than swapping code mid-use.
// onNeedRefresh only fires once (when the worker starts waiting), so re-offer the update on each
// foreground while a worker is still waiting, throttled so the prompt doesn't stack up.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let lastPrompt = 0
  const promptUpdate = () => {
    if (Date.now() - lastPrompt < 60000) return
    lastPrompt = Date.now()
    toast('A new version of Daybook is ready.', { duration: 60000, action: { label: 'Update', onClick: () => updateSW(true) } })
  }
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: promptUpdate,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (registration.waiting) promptUpdate()
        registration.update().catch(() => {})
      })
    },
  })
}

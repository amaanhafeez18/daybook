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
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast('A new version of Daybook is ready.', { duration: 60000, action: { label: 'Update', onClick: () => updateSW(true) } })
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {})
      })
    },
  })
}

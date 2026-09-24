import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { getState, updateSettings, useStore } from '../lib/store.js'
import { WELCOME_EVENT, openWelcome, welcomeDecision } from './welcome/rules.js'

export { openWelcome }

// The tour itself loads as its own chunk: only new accounts (or a replay) ever need it.
const WelcomeFlow = lazy(() => import('./welcome/WelcomeFlow.jsx'))

// First-run welcome tour, shown over the app for a brand-new account (see welcome/rules.js) and
// whenever openWelcome() is called. Finishing or skipping sets settings.welcomeDone.
export default function Welcome({ user }) {
  const decision = useStore(welcomeDecision)
  const [open, setOpen] = useState(false)
  const failed = useRef(false)

  useEffect(() => {
    if (decision === 'show' && !failed.current) setOpen(true)
    // An existing account that predates the tour: don't show it, and don't ask again.
    else if (decision === 'mark-done' && !open) updateSettings({ welcomeDone: true })
  }, [decision, open])

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(WELCOME_EVENT, onOpen)
    return () => window.removeEventListener(WELCOME_EVENT, onOpen)
  }, [])

  const close = useCallback(() => {
    if (getState().data.settings?.welcomeDone !== true) updateSettings({ welcomeDone: true })
    setOpen(false)
  }, [])

  // The tour couldn't load (offline, or an old file gone after an update) or crashed: get out of
  // the way without marking it seen, so it's offered again next launch rather than retried now.
  const fail = useCallback(() => {
    failed.current = true
    setOpen(false)
  }, [])

  if (!open) return null
  return (
    <TourGuard onError={fail}>
      <Suspense fallback={null}>
        <WelcomeFlow user={user} onClose={close} />
      </Suspense>
    </TourGuard>
  )
}

// The tour sits outside the page's error boundary, so without this a failure in it would take the
// whole app down with it.
class TourGuard extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('Welcome tour failed:', error)
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

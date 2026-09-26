import { Suspense, lazy } from 'react'
import Icon from '../components/ui/Icon.jsx'
import GymWidget from '../components/GymWidget.jsx'
import CardBoundary, { CardSkeleton } from '../components/CardBoundary.jsx'
import WeightCard from '../components/WeightCard.jsx'
import { formatDateLong, todayISO } from '../lib/dates.js'
import { useNow } from '../lib/environment.js'
import { useAreas } from '../lib/areas.js'
import '../components/today.css'

// Health → Today (#/health): the workout card, the food card and the weight line, which used to sit
// on the planner's Today. Gym and Food are areas (Settings → What you use); with an area off its
// card stays away, and with both off the page only points to Settings (a deep link can still land here).
const FoodQuickCard = lazy(() => import('../components/FoodQuickCard.jsx'))

export default function HealthPage({ loaded }) {
  useNow(60000) // re-render at midnight
  const today = todayISO()
  const areas = useAreas()

  return (
    <div className="today td-page">
      <header className="page-header td-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        <h1>Health</h1>
      </header>

      <div className="today-main hl-main">
        {areas.gym && <GymWidget today={today} loaded={loaded} />}
        {areas.food && (
          <CardBoundary>
            <Suspense fallback={<CardSkeleton />}>
              <FoodQuickCard today={today} loaded={loaded} />
            </Suspense>
          </CardBoundary>
        )}
        {areas.food && <WeightCard today={today} loaded={loaded} />}
        {!areas.gym && !areas.food && (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="dumbbell" size={24} /></span>
            <h3>Gym and Food are turned off</h3>
            <p>Turn them on under “What you use” to track workouts, meals and weight here.</p>
            <a className="btn btn-primary" href="#/settings/areas">Open Settings</a>
          </div>
        )}
      </div>
    </div>
  )
}

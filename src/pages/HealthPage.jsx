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
// On a wide screen (1000px+) with both on, the gym and weight cards sit beside the food card; on a
// phone the columns dissolve (display: contents) and the cards stack gym, food, weight.
const FoodQuickCard = lazy(() => import('../components/FoodQuickCard.jsx'))

export default function HealthPage({ loaded }) {
  useNow(60000) // re-render at midnight
  const today = todayISO()
  const areas = useAreas()
  const both = areas.gym && areas.food

  return (
    <div className="today td-page">
      <header className="page-header td-header">
        <p className="eyebrow">{formatDateLong(today)}</p>
        <h1>Health</h1>
      </header>

      <div className={`today-main hl-main${both ? ' hl-grid' : ''}`}>
        {/* In reading order (gym, food, weight); wide screens place them in two columns (gym-widget.css). */}
        {areas.gym && <div className="hl-cell is-gym"><GymWidget today={today} loaded={loaded} /></div>}
        {areas.food && (
          <div className="hl-cell is-food">
            <CardBoundary>
              <Suspense fallback={<CardSkeleton />}>
                <FoodQuickCard today={today} loaded={loaded} />
              </Suspense>
            </CardBoundary>
          </div>
        )}
        {areas.food && <div className="hl-cell is-weight"><WeightCard today={today} loaded={loaded} /></div>}
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

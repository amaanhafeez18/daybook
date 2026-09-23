import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isISODate } from '../lib/dates.js'
import { useToday } from '../lib/food/state.js'
import { useStore } from '../lib/store.js'
import DayView from './food/DayView.jsx'
import GoalWizard from './food/GoalWizard.jsx'
import InsightsView from './food/InsightsView.jsx'
import WeightView from './food/WeightView.jsx'
import './food/food.css'

// #/food (today), #/food/day/<date>, #/food/insights[/<week start>], #/food/weight, #/food/goals.

function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  const view = parts[1] || 'day'
  if (view === 'day') return { view: 'day', param: isISODate(parts[2]) ? parts[2] : null }
  if (view === 'insights') return { view, param: isISODate(parts[2]) ? parts[2] : null }
  if (view === 'weight' || view === 'goals') return { view, param: null }
  return { view: 'day', param: null }
}

export default function FoodPage({ loaded: loadedProp }) {
  const [route, setRoute] = useState(parseHash)
  const today = useToday()
  const storeLoaded = useStore((state) => state.loaded)
  const loaded = loadedProp ?? storeLoaded
  const previous = useRef(route)

  useEffect(() => {
    const onHash = () => {
      const next = parseHash()
      setRoute((current) => (current.view === next.view && current.param === next.param ? current : next))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // A new view starts at the top; paging through days or weeks keeps the scroll position.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = route
    if (from !== route && from.view !== route.view) window.scrollTo({ top: 0 })
  }, [route])

  if (route.view === 'insights') return <InsightsView today={today} param={route.param} loaded={loaded} />
  if (route.view === 'weight') return <WeightView today={today} loaded={loaded} />
  if (route.view === 'goals') return <GoalWizard today={today} />
  return <DayView date={route.param || today} today={today} loaded={loaded} />
}

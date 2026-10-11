import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isISODate } from '../lib/dates.js'
import { useToday } from '../lib/food/state.js'
import { navLevel, subscribeRoute } from '../lib/router.js'
import { useStore } from '../lib/store.js'
import DayView from './food/DayView.jsx'
import GoalWizard from './food/GoalWizard.jsx'
import InsightsView from './food/InsightsView.jsx'
import MyFoodsView from './food/MyFoodsView.jsx'
import WeightView from './food/WeightView.jsx'
import './food/food.css'

// #/food (today), #/food/day/<date>, #/food/insights[/<week start>], #/food/weight, #/food/goals,
// #/food/foods (My foods).

function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  const view = parts[1] || 'day'
  if (view === 'day') return { view: 'day', param: isISODate(parts[2]) ? parts[2] : null }
  if (view === 'insights') return { view, param: isISODate(parts[2]) ? parts[2] : null }
  if (view === 'weight' || view === 'goals' || view === 'foods') return { view, param: null }
  return { view: 'day', param: null }
}

// How deep a view sits (today, then Insights / Weight / Goals / My foods, then a day opened from
// Insights), shared with the slide between them (lib/router.js).
const levelOf = (route) => navLevel({ page: 'food', view: route.view, param: route.param })
const scrollKey = (route) => `${route.view}/${route.param || ''}`

export default function FoodPage({ loaded: loadedProp }) {
  const [route, setRoute] = useState(parseHash)
  const today = useToday()
  const storeLoaded = useStore((state) => state.loaded)
  const loaded = loadedProp ?? storeLoaded
  const previous = useRef(route)
  // Scroll positions of the views a deeper one was opened from, restored on the way back.
  const scrolls = useRef({})
  // Where the page was when the route last changed, read before the new view renders (afterwards a
  // shorter view would already have clamped it).
  const leftAt = useRef(0)

  useEffect(() => subscribeRoute(() => {
    leftAt.current = window.scrollY
    const next = parseHash()
    setRoute((current) => (current.view === next.view && current.param === next.param ? current : next))
  }), [])

  // Paging through days or weeks keeps the scroll position. Going deeper starts the new view at
  // the top and keeps the one left behind; coming back up returns to where it was.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = route
    if (from === route || from.view === route.view) return
    const deeper = levelOf(route) > levelOf(from)
    const returning = levelOf(route) < levelOf(from)
    if (deeper) scrolls.current[scrollKey(from)] = leftAt.current
    const y = returning ? scrolls.current[scrollKey(route)] || 0 : 0
    window.scrollTo({ top: y })
    if (y && Math.abs(window.scrollY - y) > 1) requestAnimationFrame(() => window.scrollTo({ top: y }))
  }, [route])

  if (route.view === 'insights') return <InsightsView today={today} param={route.param} loaded={loaded} />
  if (route.view === 'weight') return <WeightView today={today} loaded={loaded} />
  if (route.view === 'goals') return <GoalWizard today={today} />
  if (route.view === 'foods') return <MyFoodsView today={today} loaded={loaded} />
  return <DayView date={route.param || today} today={today} loaded={loaded} />
}

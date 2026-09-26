import { useMemo } from 'react'
import { useStore } from './store.js'

// The optional areas of the app. Someone who only wants a planner turns the rest off in Settings →
// "What you use" (settings.areas; a missing key means on, so existing accounts see everything).
// An area that's off leaves the tab bar, the top bar, Today and the assistant's prompts. Nothing is
// deleted, and a deep link (#/gym) still opens the page. Gym and Food together make up the Health
// space (App.jsx); with both off the app is just the planner and there is no space switch.
export const AREAS = [
  { id: 'people', label: 'People', text: 'Catch-ups, birthdays and what you talked about', icon: 'people' },
  { id: 'journal', label: 'Journal', text: 'A mood and a few lines a day', icon: 'journal' },
  { id: 'gym', label: 'Gym', text: 'Routines, a schedule and every set you log', icon: 'dumbbell' },
  { id: 'food', label: 'Food', text: 'Meals, calories and weigh-ins', icon: 'utensils' },
]
export const AREA_IDS = AREAS.map((area) => area.id)

export function areasFrom(settings) {
  const raw = settings?.areas
  const out = {}
  for (const id of AREA_IDS) out[id] = !(raw && typeof raw === 'object' && raw[id] === false)
  return out
}

export const areaOn = (settings, id) => areasFrom(settings)[id]
export const healthOn = (areas) => Boolean(areas?.gym || areas?.food)

export function useAreas() {
  const raw = useStore((state) => state.data.settings?.areas)
  return useMemo(() => areasFrom({ areas: raw }), [raw])
}

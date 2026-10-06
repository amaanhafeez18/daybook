import { useEffect, useState } from 'react'
import Icon from './ui/Icon.jsx'
import Sheet from './ui/Sheet.jsx'
import { toast } from './ui/feedback.jsx'
import { getState, updateSettings } from '../lib/store.js'
import { cityResults, geocodeUrl } from '../lib/location.js'
import './setup.css'

const SEARCH_DELAY_MS = 300

// "Choose a city": searches Open-Meteo's place names (free, no key) and saves the pick as
// settings.location = { lat, lon, name, manual: true }. Weather, prayer times and the server's
// prayer reminders then use it, and GPS refreshes don't overwrite it (only "Use my location" does).
// Undo puts the previous location back.
export default function CitySheet({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [state, setState] = useState('idle') // idle | loading | done | error

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setState('idle')
  }, [open])

  useEffect(() => {
    const url = open ? geocodeUrl(query) : ''
    if (!url) {
      setResults([])
      setState('idle')
      return undefined
    }
    const controller = new AbortController()
    setState('loading')
    const timer = setTimeout(() => {
      fetch(url, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Search failed'))))
        .then((payload) => {
          setResults(cityResults(payload))
          setState('done')
        })
        .catch((error) => {
          if (error.name !== 'AbortError') setState('error')
        })
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  function choose(city) {
    const previous = getState().data.settings?.location ?? null
    updateSettings({ location: { lat: city.lat, lon: city.lon, name: city.label, manual: true, at: Date.now() } })
    onClose()
    toast(`Location set to ${city.name}`, { action: { label: 'Undo', onClick: () => updateSettings({ location: previous }) } })
  }

  return (
    <Sheet open={open} onClose={onClose} title="Choose a city" description="For weather, prayer times and prayer reminders. Your phone’s location won’t change it.">
      <form className="city-search" role="search" onSubmit={(event) => event.preventDefault()}>
        <Icon name="search" size={18} />
        <input
          className="input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="City name"
          aria-label="City name"
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="search"
          maxLength={80}
          data-autofocus
        />
      </form>
      {results.length > 0 ? (
        <ul className="city-results" aria-label="Places">
          {results.map((city) => (
            <li key={city.id}>
              <button type="button" className="city-option" onClick={() => choose(city)}>
                <Icon name="pin" size={18} />
                <span>
                  <strong>{city.name}</strong>
                  {city.label !== city.name && <small>{city.label.slice(city.name.length + 2)}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="city-note" role="status">
          {state === 'loading' ? 'Searching…'
            : state === 'error' ? 'Couldn’t search right now. Check your connection and try again.'
              : state === 'done' ? 'No places found. Try another spelling.'
                : 'Type at least two letters.'}
        </p>
      )}
    </Sheet>
  )
}

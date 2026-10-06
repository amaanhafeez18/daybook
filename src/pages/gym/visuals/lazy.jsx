// Small stand-ins the gym screens import directly. The visuals themselves (rig, patterns, mapping)
// load as a separate chunk the first time one is shown; until then a same-size placeholder holds
// the space, so rows never jump.
import { Suspense, lazy, useMemo, useState } from 'react'
import Icon from '../../../components/ui/Icon.jsx'
import { exerciseById } from '../../../lib/gym/library.js'
import { getGym } from '../../../lib/gym/state.js'
import './thumb.css'

const load = () => import('./ExerciseVisual.jsx')
const LazyThumb = lazy(() => load().then((module) => ({ default: module.Thumb })))
const LazyPanel = lazy(() => load().then((module) => ({ default: module.VisualPanel })))
const LazySheet = lazy(() => load().then((module) => ({ default: module.VisualSheet })))

// The library or custom entry, from an entry or an id.
function useEntry(exercise, exerciseId) {
  return useMemo(() => {
    if (exercise && typeof exercise === 'object') return exercise
    if (typeof exerciseId !== 'string' || !exerciseId) return null
    return exerciseById(exerciseId, getGym().exercises)
  }, [exercise, exerciseId])
}

function Placeholder({ size, className = '', children = null }) {
  return <span className={`gvis-tile ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">{children}</span>
}

// Still thumbnail (animate: 'hover' loops while its row is hovered/pressed, true always).
export function ExerciseThumb({ exercise, exerciseId, size = 36, animate = false, className = '', fallback = null }) {
  const entry = useEntry(exercise, exerciseId)
  if (!entry) return fallback == null ? null : <Placeholder size={size} className={className}>{fallback}</Placeholder>
  return (
    <Suspense fallback={<Placeholder size={size} className={className}>{fallback}</Placeholder>}>
      <LazyThumb exercise={entry} size={size} animate={animate} className={className} fallback={fallback} />
    </Suspense>
  )
}

// The exercise page's header visual: animation, muscle map and form cues.
export function ExerciseVisualPanel({ exercise, exerciseId }) {
  const entry = useEntry(exercise, exerciseId)
  if (!entry) return null
  return (
    <Suspense fallback={<div className="gvis-panel-holder" aria-hidden="true" />}>
      <LazyPanel exercise={entry} />
    </Suspense>
  )
}

// A thumbnail button (live workout cards) that opens a sheet with the full visual.
export function ExerciseVisualButton({ exercise, exerciseId, name, size = 34 }) {
  const entry = useEntry(exercise, exerciseId)
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  if (!entry) return null
  const title = name || entry.name || 'Exercise'
  return (
    <>
      <button
        type="button"
        className="gvis-btn"
        aria-label={`How to do ${title}`}
        aria-haspopup="dialog"
        onClick={() => {
          setUsed(true)
          setOpen(true)
        }}
      >
        <ExerciseThumb exercise={entry} size={size} fallback={<Icon name="dumbbell" size={18} />} />
      </button>
      {used && (
        <Suspense fallback={null}>
          <LazySheet open={open} onClose={() => setOpen(false)} exercise={entry} title={title} />
        </Suspense>
      )}
    </>
  )
}

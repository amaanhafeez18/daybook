// Small stand-ins the gym screens import directly. The visuals themselves (rig, patterns, mapping)
// load as a separate chunk the first time one is shown; until then a same-size placeholder holds
// the space, so rows never jump.
import { Component, Suspense, lazy, useMemo, useState } from 'react'
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

// A visual that fails (its chunk didn't load, e.g. a tab left on an old build, or an odd exercise
// threw while drawing) shows `fallback` instead of taking the screen down with it, mid-workout too.
// It tries again when the exercise changes.
class VisualBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('Exercise visual failed:', error)
  }

  componentDidUpdate(previous) {
    if (this.state.failed && previous.entry !== this.props.entry) this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children
  }
}

// Still thumbnail (animate: 'hover' loops while its row is hovered/pressed, true always).
export function ExerciseThumb({ exercise, exerciseId, size = 36, animate = false, className = '', fallback = null }) {
  const entry = useEntry(exercise, exerciseId)
  if (!entry) return fallback == null ? null : <Placeholder size={size} className={className}>{fallback}</Placeholder>
  const holder = <Placeholder size={size} className={className}>{fallback}</Placeholder>
  return (
    <VisualBoundary entry={entry} fallback={holder}>
      <Suspense fallback={holder}>
        <LazyThumb exercise={entry} size={size} animate={animate} className={className} fallback={fallback} />
      </Suspense>
    </VisualBoundary>
  )
}

// The exercise page's header visual: animation, muscle map and form cues.
export function ExerciseVisualPanel({ exercise, exerciseId }) {
  const entry = useEntry(exercise, exerciseId)
  if (!entry) return null
  return (
    <VisualBoundary entry={entry}>
      <Suspense fallback={<div className="gvis-panel-holder" aria-hidden="true" />}>
        <LazyPanel exercise={entry} />
      </Suspense>
    </VisualBoundary>
  )
}

// The pop-up with the full visual (animation, muscles, cues), for anything that should open it:
// { entry, title, show(), sheet }. Render `sheet` once; call show() from a tap. onDetails adds a
// "History & records" button that closes the sheet first.
export function useExerciseVisual({ exercise, exerciseId, name, onDetails }) {
  const entry = useEntry(exercise, exerciseId)
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  const title = name || entry?.name || 'Exercise'
  const show = () => {
    setUsed(true)
    setOpen(true)
  }
  const sheet = entry && used ? (
    <VisualBoundary entry={entry}>
      <Suspense fallback={null}>
        <LazySheet
          open={open}
          onClose={() => setOpen(false)}
          exercise={entry}
          title={title}
          onDetails={onDetails ? () => {
            setOpen(false)
            onDetails()
          } : undefined}
        />
      </Suspense>
    </VisualBoundary>
  ) : null
  return { entry, title, show, sheet }
}

// The thumbnail that opens it (live workout cards, routine editor, exercise lists). It is its own
// button: in a row that is a button too, render it as the row's sibling (never inside it). The tap
// doesn't reach the row. className goes on the button, tileClassName on the picture; animate and
// fallback as for ExerciseThumb (a dumbbell by default).
export function ExerciseVisualThumbButton({ visual, size = 34, className = '', tileClassName = '', animate = false, fallback }) {
  if (!visual.entry) return null
  const open = (event) => {
    event.stopPropagation()
    visual.show()
  }
  return (
    <button type="button" className={`gvis-btn ${className}`.trim()} aria-label={`How to do ${visual.title}`} aria-haspopup="dialog" onClick={open}>
      <ExerciseThumb
        exercise={visual.entry}
        size={size}
        animate={animate}
        className={tileClassName}
        fallback={fallback === undefined ? <Icon name="dumbbell" size={18} /> : fallback}
      />
    </button>
  )
}

// A thumbnail button with its own sheet (onDetails adds "History & records").
export function ExerciseVisualButton({ exercise, exerciseId, name, onDetails, size = 34, ...button }) {
  const visual = useExerciseVisual({ exercise, exerciseId, name, onDetails })
  return (
    <>
      <ExerciseVisualThumbButton visual={visual} size={size} {...button} />
      {visual.sheet}
    </>
  )
}

// The exercise visual components. This module (and everything it pulls in: the rig, patterns,
// mapping) is its own chunk, loaded on demand through ./lazy.jsx.
import Sheet from '../../../components/ui/Sheet.jsx'
import { MUSCLES } from '../../../lib/gym/library.js'
import { Figure, MuscleMap } from './render.js'
import { visualFor } from './visual.js'
import './visuals.css'

const LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))
const muscleNames = (set) => [...set].map((id) => LABEL[id] || id)

// A small still picture: the figure, or the muscle map when no movement fits; `fallback` (e.g. the
// row's initial) when there's nothing to show at all.
export function Thumb({ exercise, size = 36, animate = false, className = '', fallback = null }) {
  const vis = visualFor(exercise)
  const hasMuscles = vis.muscles.primary.size > 0
  return (
    <span className={`gvis-tile${vis.info ? '' : ' is-map'} ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">
      {vis.info
        ? <Figure vis={vis} size={size} animate={animate} tight />
        : hasMuscles ? <MuscleMap muscles={vis.muscles} size={size} only="best" /> : fallback}
    </span>
  )
}

function Legend({ muscles }) {
  const main = muscleNames(muscles.primary)
  const also = muscleNames(muscles.secondary)
  if (!main.length) return null
  return (
    <p className="gvis-legend">
      <span><i className="gvis-swatch is-hot" aria-hidden="true" />{main.join(', ')}</span>
      {also.length > 0 && <span><i className="gvis-swatch is-warm" aria-hidden="true" />{also.join(', ')}</span>}
    </p>
  )
}

// Large animated figure + front/back muscle map + 2-3 form cues.
export function VisualPanel({ exercise, className = '' }) {
  const vis = visualFor(exercise)
  const main = muscleNames(vis.muscles.primary)
  if (!vis.info && !main.length) return null
  const name = exercise?.name || 'this exercise'
  return (
    <section className={`gvis-panel${vis.info ? '' : ' is-map-only'} ${className}`.trim()} aria-label={`How to do ${name}`}>
      <div className="gvis-panel-art">
        {vis.info && (
          <div className="gvis-panel-figure">
            <Figure vis={vis} size={220} animate label={`Animation: ${name}`} />
          </div>
        )}
        {main.length > 0 && (
          <figure className="gvis-panel-map">
            <MuscleMap muscles={vis.muscles} size={150} label={`Muscles worked: ${[...main, ...muscleNames(vis.muscles.secondary)].join(', ')}`} />
            <figcaption className="gvis-map-caption" aria-hidden="true"><span>Front</span><span>Back</span></figcaption>
          </figure>
        )}
      </div>
      <Legend muscles={vis.muscles} />
      {vis.cues.length > 0 && (
        <ol className="gvis-cues" aria-label="Form cues">
          {vis.cues.map((cue) => <li key={cue}>{cue}</li>)}
        </ol>
      )}
    </section>
  )
}

export function VisualSheet({ open, onClose, exercise, title }) {
  return (
    <Sheet open={open} onClose={onClose} title={title || exercise?.name || 'Exercise'} size="md">
      {exercise && <VisualPanel exercise={exercise} className="in-sheet" />}
    </Sheet>
  )
}

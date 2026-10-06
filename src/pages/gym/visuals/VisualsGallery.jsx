// #/gym/visuals: every library exercise's figure and muscle map in one grid, for reviewing the
// visuals. Not linked from anywhere in the app.
import { useState } from 'react'
import Icon from '../../../components/ui/Icon.jsx'
import { Segmented } from '../../../components/ui/primitives.jsx'
import { EXERCISES } from '../../../lib/gym/library.js'
import { goBack } from '../common.jsx'
import { Figure, MuscleMap } from './render.js'
import { visualFor } from './visual.js'
import './visuals.css'

const MODES = [
  { id: 'move', label: 'Moving' },
  { id: 'still', label: 'Still' },
  { id: 'thumb', label: 'Thumbnails' },
]

const variantText = (variant) => Object.entries(variant || {}).map(([key, value]) => (value === true ? key : value)).join(' · ')

export default function VisualsGallery() {
  const [mode, setMode] = useState('move')
  return (
    <div className="gym-st gvis-gallery">
      <div className="gym-xd-top">
        <button type="button" className="gym-xd-back" onClick={() => goBack('gym')}>
          <Icon name="chevronLeft" size={22} />
          Gym
        </button>
      </div>
      <header className="gym-st-head">
        <h1>Exercise visuals</h1>
        <p className="muted">{EXERCISES.length} exercises</p>
      </header>
      <Segmented options={MODES} value={mode} onChange={setMode} label="Show" className="gvis-gallery-mode" />
      <ul className={`gvis-grid${mode === 'thumb' ? ' is-thumbs' : ''}`}>
        {EXERCISES.map((exercise) => {
          const vis = visualFor(exercise)
          return (
            <li key={exercise.id} className="card gvis-cell">
              <div className="gvis-cell-art">
                {vis.info && (mode === 'thumb'
                  ? <span className="gvis-tile"><Figure vis={vis} size={36} tight /></span>
                  : <Figure vis={vis} size={132} animate={mode === 'move'} />)}
                {mode !== 'thumb' && <MuscleMap muscles={vis.muscles} size={84} />}
              </div>
              <p className="gvis-cell-name">{exercise.name}</p>
              <p className="gvis-cell-meta">{vis.motion?.pattern || 'no pattern'}{variantText(vis.variant) ? ` · ${variantText(vis.variant)}` : ''}</p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

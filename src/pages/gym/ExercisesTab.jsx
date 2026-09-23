import { useEffect, useMemo, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { searchExercises } from '../../lib/gym/library.js'
import { useGym, useGymSessions } from '../../lib/gym/state.js'
import { navigate } from '../../lib/router.js'
import { GymEmpty } from './common.jsx'
import CustomExerciseSheet from './CustomExerciseSheet.jsx'
import { ExerciseFilters, ExerciseRowBody, exerciseUsage, groupByLetter, recentExercises } from './ExercisePicker.jsx'
import './exercises.css'

// The search and filters survive a trip to an exercise and back (GymPage restores the scroll).
const remembered = { query: '', muscle: '', equipment: '' }

export default function ExercisesTab() {
  const gym = useGym()
  const sessions = useGymSessions()
  const [query, setQuery] = useState(remembered.query)
  const [muscle, setMuscle] = useState(remembered.muscle)
  const [equipment, setEquipment] = useState(remembered.equipment)
  const [creating, setCreating] = useState(null) // null | { name }

  useEffect(() => {
    Object.assign(remembered, { query, muscle, equipment })
  }, [query, muscle, equipment])

  const usage = exerciseUsage(sessions)
  const trimmed = query.trim()
  const filtering = Boolean(trimmed || muscle || equipment)
  const results = useMemo(
    () => searchExercises(trimmed, { muscle, equipment, customExercises: gym.exercises }),
    [trimmed, muscle, equipment, gym.exercises],
  )
  const recent = useMemo(() => (filtering ? [] : recentExercises(usage, gym.exercises, 8)), [filtering, usage, gym.exercises])
  const groups = useMemo(() => (trimmed ? null : groupByLetter(results)), [results, trimmed])

  const open = (id) => navigate(`gym/exercise/${id}`)

  const row = (exercise) => (
    <li key={exercise.id}>
      <button type="button" className="gym-lib-row" onClick={() => open(exercise.id)}>
        <ExerciseRowBody exercise={exercise} count={usage.counts.get(exercise.id) || 0} />
        <Icon name="chevronRight" size={18} className="gym-lib-chevron" />
      </button>
    </li>
  )

  const clearFilters = () => {
    setQuery('')
    setMuscle('')
    setEquipment('')
  }

  return (
    <div className="gym-lib">
      <ExerciseFilters
        query={query}
        onQuery={setQuery}
        muscle={muscle}
        onMuscle={setMuscle}
        equipment={equipment}
        onEquipment={setEquipment}
        trailing={(
          <button type="button" className="gym-lib-new" onClick={() => setCreating({ name: trimmed })} aria-label="New exercise" title="New exercise">
            <Icon name="plus" size={22} />
          </button>
        )}
      />

      {results.length === 0 ? (
        <GymEmpty
          icon="search"
          title="No exercises found"
          action={(
            <div className="gym-lib-empty-actions">
              <Button icon="plus" onClick={() => setCreating({ name: trimmed })}>
                {trimmed ? `Create “${trimmed}”` : 'Create an exercise'}
              </Button>
              <Button variant="ghost" onClick={clearFilters}>{muscle || equipment ? (trimmed ? 'Clear search and filters' : 'Clear filters') : 'Clear search'}</Button>
            </div>
          )}
        >
          {trimmed
            ? `Nothing matches “${trimmed}”${muscle || equipment ? ' with these filters' : ''}. You can add it as your own exercise.`
            : 'No exercises match these filters.'}
        </GymEmpty>
      ) : (
        <>
          <p className="gym-lib-summary" aria-live="polite">
            {filtering ? `${results.length} match${results.length === 1 ? '' : 'es'}` : `${results.length} exercises`}
            {filtering && (
              <button type="button" className="link-btn" onClick={clearFilters}>Clear</button>
            )}
          </p>

          {recent.length > 0 && (
            <section className="gym-lib-group" aria-labelledby="gym-lib-recent">
              <h2 className="gym-lib-letter" id="gym-lib-recent">Recent</h2>
              <ul className="card-list gym-lib-list">{recent.map(row)}</ul>
            </section>
          )}

          {groups ? groups.map((group) => (
            <section key={group.letter} className="gym-lib-group" aria-label={`Exercises starting with ${group.letter}`}>
              <h2 className="gym-lib-letter" aria-hidden="true">{group.letter}</h2>
              <ul className="card-list gym-lib-list">{group.items.map(row)}</ul>
            </section>
          )) : (
            <section className="gym-lib-group" aria-label="Search results">
              <ul className="card-list gym-lib-list">{results.map(row)}</ul>
            </section>
          )}
        </>
      )}

      <CustomExerciseSheet
        open={Boolean(creating)}
        onClose={() => setCreating(null)}
        initialName={creating?.name || ''}
        onSaved={(entry) => {
          if (entry && trimmed && !entry.name.toLowerCase().includes(trimmed.toLowerCase())) setQuery('')
        }}
      />
    </div>
  )
}

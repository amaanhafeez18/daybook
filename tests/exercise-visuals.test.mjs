// Run: node --test tests/exercise-visuals.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import server from 'react-dom/server'
import { EXERCISES } from '../src/lib/gym/library.js'
import { EXERCISE_MOTION, guessMotion, motionFor } from '../src/pages/gym/visuals/motion.js'
import { PATTERNS, cuesFor, patternInfo } from '../src/pages/gym/visuals/patterns.js'
import { LIMBS, anchorNames, lerpPose, limbSpec, normDeg, poseAt, reach, sameShape, solvePose, stops } from '../src/pages/gym/visuals/rig.js'
import { keyScene, phaseScene, viewBox, visualFor } from '../src/pages/gym/visuals/visual.js'
import { muscleMapScene } from '../src/pages/gym/visuals/musclemap.js'
import { muscleSets } from '../src/pages/gym/visuals/scene.js'
import { Figure, MuscleMap } from '../src/pages/gym/visuals/render.js'

const finite = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)

// Every pattern with every variant the library uses (plus its default).
function variantsInUse() {
  const out = new Map()
  for (const id of Object.keys(PATTERNS)) out.set(`${id}|{}`, [id, {}])
  for (const [pattern, variant] of Object.values(EXERCISE_MOTION)) out.set(`${pattern}|${JSON.stringify(variant)}`, [pattern, variant])
  return [...out.values()]
}

function walk(items, fn) {
  for (const item of items) {
    if (item.k === 'seg') fn(item.a), fn(item.b)
    else if (item.k === 'poly') item.pts.forEach(fn)
    else fn(item.c)
  }
}

describe('exercise visuals: mapping', () => {
  test('every library exercise has an explicit motion, and every entry is a library id', () => {
    const ids = new Set(EXERCISES.map((entry) => entry.id))
    for (const id of ids) {
      assert.ok(Object.prototype.hasOwnProperty.call(EXERCISE_MOTION, id), `no motion for ${id}`)
      const [pattern, variant] = EXERCISE_MOTION[id]
      assert.ok(PATTERNS[pattern], `${id} uses unknown pattern ${pattern}`)
      assert.equal(typeof variant, 'object')
    }
    for (const id of Object.keys(EXERCISE_MOTION)) assert.ok(ids.has(id), `${id} is not in the library`)
    assert.equal(Object.keys(EXERCISE_MOTION).length, EXERCISES.length)
  })

  test('library entries use the table, not a guess', () => {
    for (const entry of EXERCISES) {
      const motion = motionFor(entry)
      assert.equal(motion.guessed, false)
      assert.equal(motion.pattern, EXERCISE_MOTION[entry.id][0])
    }
  })

  test('there are about thirty movement families, each with 2-3 cues', () => {
    assert.ok(Object.keys(PATTERNS).length >= 30)
    for (const [pattern, variant] of variantsInUse()) {
      const cues = cuesFor(pattern, variant)
      assert.ok(cues.length >= 2 && cues.length <= 3, `${pattern} ${JSON.stringify(variant)} has ${cues.length} cues`)
      for (const cue of cues) assert.ok(cue.length > 0 && cue.length <= 60, `cue too long: ${cue}`)
    }
  })

  test('variant cues win over the default ones', () => {
    assert.notDeepEqual(cuesFor('hinge', { style: 'rdl' }), cuesFor('hinge', {}))
    assert.notDeepEqual(cuesFor('overhead_press', { gear: 'dumbbell', seat: true }), cuesFor('overhead_press', {}))
    assert.deepEqual(cuesFor('squat', { hold: 'back' }), cuesFor('squat', {}))
  })
})

describe('exercise visuals: custom exercise fallback', () => {
  const custom = (name, extra = {}) => ({ id: `c-${name}`, name, custom: true, primary: null, secondary: [], equipment: 'barbell', movement: 'push', ...extra })
  const cases = [
    ['Incline Smith Press', 'bench_press', { bench: 'incline' }],
    ['Floor Press', 'bench_press', {}],
    ['Cable Fly (low to high)', 'chest_fly', {}],
    ['Zercher Squat', 'squat', {}],
    ['Sissy squat', 'squat', {}],
    ['Kettlebell Goblet Squat', 'squat', { hold: 'goblet' }],
    ['Seated Hamstring Curl', 'leg_curl', { style: 'seated' }],
    ['Spider Curl', 'curl', {}],
    ['Rope Hammer Curls', 'curl', { grip: 'hammer' }],
    ['Landmine Row', 'row_bent', { gear: 'landmine' }],
    ['Meadows Row', 'row_bent', {}],
    ['Banded Hip Abduction', 'hip_machine', { dir: 'out' }],
    ['Copenhagen adduction', 'hip_machine', { dir: 'in' }],
    ['Stiff-legged deadlift', 'hinge', { style: 'rdl' }],
    ['Hex bar deadlift', 'hinge', { style: 'trap' }],
    ['Jump Rope', 'jump_rope', {}],
    ['Assault Bike Sprints', 'bike', { air: true }],
    ['Concept2 Erg', 'rower', {}],
    ['Hanging Knee Tucks', 'hanging_raise', { style: 'knee' }],
    ['Weighted Chin-Ups', 'pull_up', { grip: 'chin' }],
    ['Cable Woodchop', 'twist', { style: 'woodchop' }],
    ['Lying Triceps Extension', 'skull_crusher', {}],
    ['JM Press', 'bench_press', {}],
  ]
  for (const [name, pattern, variant] of cases) {
    test(`"${name}" → ${pattern}`, () => {
      const primary = name === 'JM Press' ? 'chest' : null
      const found = guessMotion(custom(name, { primary }))
      assert.ok(found, `nothing for ${name}`)
      assert.equal(found.pattern, pattern)
      for (const [key, value] of Object.entries(variant)) assert.equal(found.variant[key], value, `${name}: ${key}`)
      assert.equal(found.guessed, true)
    })
  }

  test('equipment picks the gear when the name doesn’t say', () => {
    assert.equal(guessMotion(custom('Incline press', { equipment: 'dumbbell', primary: 'chest' })).variant.gear, 'dumbbell')
    assert.equal(guessMotion(custom('Preacher curl', { equipment: 'cable' })).variant.gear, 'cable')
    assert.equal(guessMotion(custom('Chest press', { equipment: 'machine' })).pattern, 'machine_press')
    assert.equal(guessMotion(custom('Row', { equipment: 'cable' })).pattern, 'row_seated')
    assert.equal(guessMotion(custom('Row', { equipment: 'dumbbell' })).pattern, 'row_one_arm')
  })

  test('no keyword: the primary muscle decides; nothing at all: no pattern', () => {
    assert.equal(guessMotion(custom('Thing one', { primary: 'lats', equipment: 'machine' })).pattern, 'pulldown')
    assert.equal(guessMotion(custom('Thing two', { primary: 'lats', equipment: 'bodyweight' })).pattern, 'pull_up')
    assert.equal(guessMotion(custom('Thing three', { primary: 'calves' })).pattern, 'calf_raise')
    assert.equal(guessMotion(custom('Thing four', { primary: 'hamstrings' })).variant.style, 'rdl')
    assert.equal(guessMotion(custom('Mystery move', { primary: null, movement: 'push' })), null)
    assert.equal(guessMotion(null), null)
    assert.equal(motionFor(undefined), null)
  })

  test('a custom exercise that reuses a library id is still matched by its name', () => {
    const found = motionFor({ id: 'bench-press', name: 'My cable curl', custom: true, equipment: 'cable', primary: 'biceps' })
    assert.equal(found.pattern, 'curl')
  })

  test('the muscle map alone when no pattern fits', () => {
    const vis = visualFor(custom('Mystery move', { primary: 'abs' }))
    assert.ok(vis.info === null || vis.motion.pattern === 'crunch')
    const nothing = visualFor(custom('Mystery move', { primary: null }))
    assert.equal(nothing.info, null)
    assert.deepEqual(nothing.cues, [])
  })
})

describe('exercise visuals: keyframes', () => {
  // Side-view joint ranges (flexion in degrees). Arms holding a bar on the back or across the front
  // of the shoulders are out to the sides, so their side-view angle is a projection: not checked.
  const RANGE = { knee: [-8, 165], ankle: [-15, 165], elbow: [-10, 172] }
  const heldAcross = (spec) => Boolean(spec && !Array.isArray(spec) && spec.to && spec.to.from && Array.isArray(spec.to.local) && spec.to.local[1] < 0)

  for (const [id, variant] of variantsInUse()) {
    test(`${id} ${JSON.stringify(variant)}`, () => {
      const info = patternInfo(id, variant)
      const { keys, view, loop } = info
      const spin = loop === 'spin'
      assert.ok(keys.length >= 2 && keys.length <= (spin ? 4 : 3), `${keys.length} keys`)
      assert.ok(['side', 'front'].includes(view))
      assert.ok(info.thumb >= 0 && info.thumb < keys.length)
      for (const key of keys) {
        assert.ok(sameShape(keys[0], key), 'keyframes must have the same shape to blend')
        if (key.anchor !== undefined) assert.ok(anchorNames(view).includes(key.anchor), `bad anchor ${key.anchor}`)
        // A joint that pins the pose must belong to a limb placed by angles (IK limbs come after).
        const anchor = typeof key.anchor === 'string' ? key.anchor : 'hip'
        const joint = anchor.replace(/2$/, '')
        const owner = ['hand', 'elbow'].includes(joint) ? 'arm' : ['knee', 'ankle', 'toe', 'heel'].includes(joint) ? 'leg' : null
        if (owner) assert.ok(Array.isArray(limbSpec(key, owner + (anchor.endsWith('2') ? '2' : ''))), `${anchor} pins the pose but its limb uses IK`)
        for (const limb of LIMBS) {
          const spec = limbSpec(key, limb)
          if (Array.isArray(spec)) for (const angle of spec) assert.ok(Number.isFinite(angle) && Math.abs(angle) <= 400, `angle ${angle}`)
        }
      }
      for (let i = 0; i <= 16; i += 1) {
        const pose = poseAt(keys, i / 16, info)
        const skel = solvePose(pose, view)
        for (const [name, point] of Object.entries(skel.joints)) assert.ok(finite(point), `${name} not finite at ${i / 16}`)
        // Every joint stays in a sane area around the 100×100 box.
        for (const point of Object.values(skel.joints)) assert.ok(point[0] > -40 && point[0] < 140 && point[1] > -40 && point[1] < 120)
        if (view !== 'side') continue
        for (const [leg, arm] of [['leg', 'arm'], ['leg2', 'arm2']]) {
          const [thigh, shin, foot] = skel.angles[leg]
          const knee = normDeg(thigh - shin)
          const ankle = normDeg(foot - shin)
          assert.ok(knee >= RANGE.knee[0] && knee <= RANGE.knee[1], `${leg} knee ${knee.toFixed(0)}° at ${i / 16}`)
          assert.ok(ankle >= RANGE.ankle[0] && ankle <= RANGE.ankle[1], `${leg} ankle ${ankle.toFixed(0)}° at ${i / 16}`)
          if (heldAcross(limbSpec(pose, arm))) continue
          const [upper, fore] = skel.angles[arm]
          const elbow = normDeg(fore - upper)
          assert.ok(elbow >= RANGE.elbow[0] && elbow <= RANGE.elbow[1], `${arm} elbow ${elbow.toFixed(0)}° at ${i / 16}`)
        }
      }
    })
  }
})

describe('exercise visuals: rig maths', () => {
  test('two-bone reach lands on reachable targets and points at far ones', () => {
    const near = reach([0, 0], [10, 10], 13, 12, 1)
    assert.ok(Math.hypot(near.end[0] - 10, near.end[1] - 10) < 1e-6)
    const far = reach([0, 0], [0, 100], 13, 12, 1)
    assert.ok(Math.abs(far.end[0]) < 0.05 && Math.abs(far.end[1] - 25) < 0.05)
    const other = reach([0, 0], [10, 10], 13, 12, -1)
    assert.notDeepEqual(near.mid.map(Math.round), other.mid.map(Math.round))
  })

  test('poses blend member by member', () => {
    assert.deepEqual(lerpPose({ trunk: 180, arm: [0, 0] }, { trunk: 90, arm: [90, 180] }, 0.5), { trunk: 135, arm: [45, 90] })
    assert.equal(sameShape({ arm: [1, 2] }, { arm: { to: [1, 2] } }), false)
  })

  test('loops: there and back, round, and spin', () => {
    assert.deepEqual(stops(2), [0, 1])
    assert.deepEqual(stops(3), [0, 1, 2, 1])
    assert.deepEqual(stops(3, 'cycle'), [0, 1, 2])
    const keys = [{ trunk: 0 }, { trunk: 100 }]
    assert.equal(poseAt(keys, 0).trunk, 0)
    assert.equal(poseAt(keys, 0.5).trunk, 100)
    assert.ok(poseAt(keys, 0.3).trunk > 0 && poseAt(keys, 0.3).trunk < 100)
    const spin = [{ a: 0 }, { a: 120 }, { a: 240 }, { a: 360 }]
    assert.equal(poseAt(spin, 0.5, { loop: 'spin', smooth: true }).a, 180)
  })

  test('a front view mirrors the left side across the body', () => {
    const skel = solvePose({ at: [50, 50], trunk: 180, arm: [80, 80], leg: [5, 0, 90] }, 'front')
    const { hand, hand2, hip } = skel.joints
    assert.ok(Math.abs((hand[0] - hip[0]) + (hand2[0] - hip[0])) < 1e-6)
    assert.ok(Math.abs(hand[1] - hand2[1]) < 1e-6)
  })
})

describe('exercise visuals: scenes and SVG', () => {
  test('every library exercise draws finite shapes in a stable square box', () => {
    for (const entry of EXERCISES) {
      const vis = visualFor(entry)
      assert.ok(vis.info, `${entry.id} has no visual`)
      const box = viewBox(vis)
      assert.ok(box.every(Number.isFinite) && box[2] > 0 && box[2] === box[3], `${entry.id} box`)
      const still = viewBox(vis, vis.info.thumb)
      assert.ok(still[2] <= box[2] + 1e-9, `${entry.id}: the still box should be no bigger than the loop box`)
      for (const phase of [0, 0.3, 0.6, 0.9]) walk(phaseScene(vis, phase).items, (p) => assert.ok(finite(p), `${entry.id} at ${phase}`))
      const items = keyScene(vis, vis.info.thumb).items
      assert.ok(items.some((item) => item.role === 'hot' || item.role === 'tint'), `${entry.id}: the main muscle is highlighted on the figure`)
    }
  })

  test('the muscle map colours primary and secondary muscles', () => {
    const items = muscleMapScene(muscleSets({ primary: 'chest', secondary: ['triceps'] }))
    assert.ok(items.filter((item) => item.role === 'hot').length >= 2)
    assert.ok(items.some((item) => item.role === 'warm'))
    const whole = muscleMapScene(muscleSets({ primary: 'full_body', secondary: [] }))
    assert.ok(whole.filter((item) => item.role === 'hot').length > 20)
    const cardio = muscleMapScene(muscleSets({ primary: 'cardio', secondary: ['quads'] }))
    assert.ok(cardio.some((item) => item.role === 'hot') && cardio.some((item) => item.role === 'warm'))
  })

  for (const id of ['bench-press', 'lateral-raise', 'pull-up', 'stationary-bike', 'side-plank', 'power-clean']) {
    test(`renderToString: ${id}`, () => {
      const entry = EXERCISES.find((item) => item.id === id)
      const vis = visualFor(entry)
      for (const props of [{ size: 36, tight: true }, { size: 220, animate: true, label: entry.name }]) {
        const html = server.renderToString(createElement(Figure, { vis, ...props }))
        assert.match(html, /^<span class="gvis-wrap"><svg [^>]*viewBox="[-\d. ]+"[^>]*>/)
        assert.ok(html.endsWith('</svg></span>'))
        assert.doesNotMatch(html, /NaN|undefined|Infinity/)
        assert.match(html, /<line /)
        assert.match(html, /<circle /)
        assert.match(html, /<polygon /)
        const opened = (html.match(/<svg/g) || []).length
        assert.equal(opened, (html.match(/<\/svg>/g) || []).length)
        if (props.label) assert.match(html, /role="img"/)
        else assert.match(html, /aria-hidden="true"/)
      }
      const map = server.renderToString(createElement(MuscleMap, { muscles: vis.muscles, size: 120 }))
      assert.match(map, /^<svg [^>]*class="gvis gvis-map"/)
      assert.match(map, /<ellipse /)
      assert.doesNotMatch(map, /NaN|undefined/)
    })
  }
})

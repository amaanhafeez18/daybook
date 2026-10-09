// Everything the components need for one exercise, computed without React: the pattern and its
// keyframes, the scene at any moment of the loop, and stable view boxes.
import { GROUND, lerpPose, poseAt, solvePose, stops } from './rig.js'
import { PATTERNS, cuesFor, patternInfo } from './patterns.js'
import { figureScene, muscleSets, sceneBounds, seg, squareBox } from './scene.js'
import { motionFor } from './motion.js'

export const LOOP_MS = 2600

// { entry, motion, info, muscles, cues, variant }; info is null when no pattern fits (custom
// exercise with nothing to go on): then only the muscle map shows. Cached per entry object (the
// library's entries never change; an edited custom exercise is a new object).
const visuals = new WeakMap()
export function visualFor(entry) {
  const cacheable = entry && typeof entry === 'object'
  if (cacheable && visuals.has(entry)) return visuals.get(entry)
  const muscles = muscleSets(entry)
  const motion = motionFor(entry)
  const info = motion && PATTERNS[motion.pattern] ? patternInfo(motion.pattern, motion.variant) : null
  const vis = {
    entry,
    motion,
    info,
    muscles,
    variant: motion?.variant || {},
    cues: info ? cuesFor(motion.pattern, motion.variant) : [],
  }
  if (cacheable) visuals.set(entry, vis)
  return vis
}

// Per-visual memo for things that never change: the first pose, still scenes, view boxes.
const memos = new WeakMap()
function memo(vis, key, make) {
  let map = memos.get(vis)
  if (!map) memos.set(vis, (map = new Map()))
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}

const base = (vis) => memo(vis, 'base', () => solvePose(vis.info.keys[0], vis.info.view))

// The scene for one pose. `ghost` draws a faint copy (reduced motion's start pose) with only the
// equipment that moves.
export function poseScene(vis, pose, { ghost = false } = {}) {
  const skel = solvePose(pose, vis.info.view)
  const skel0 = base(vis)
  let gear = {}
  try {
    gear = vis.info.pattern.gear({ v: vis.variant, j: skel.joints, skel, j0: skel0.joints, skel0 }) || {}
  } catch {
    gear = {}
  }
  if (ghost) {
    const faint = (list) => (list || []).map((item) => ({ ...item, role: 'ghost', fill: undefined }))
    gear = { far: faint(gear.far), front: faint(gear.front) }
  }
  return { items: figureScene(skel, { muscles: vis.muscles, gear, ghost }), ground: !gear.noGround }
}

export function phaseScene(vis, phase) {
  const { keys, loop, smooth } = vis.info
  return poseScene(vis, poseAt(keys, phase, { loop, smooth }))
}

export function keyScene(vis, index, { ghost = false } = {}) {
  const { keys } = vis.info
  const i = Math.min(keys.length - 1, Math.max(0, index))
  return memo(vis, `key${i}${ghost ? 'g' : ''}`, () => poseScene(vis, keys[i], { ghost }))
}

// A square box that holds the whole loop (so the animation never jumps), or just one still pose.
export function viewBox(vis, still = null) {
  if (still != null) return memo(vis, `box${still}`, () => squareBox(sceneBounds(keyScene(vis, still).items), 2.5, 36))
  return memo(vis, 'box', () => {
    const box = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i <= 24; i += 1) sceneBounds(phaseScene(vis, i / 24).items, box)
    return squareBox(box, 3, 44)
  })
}

// The loop box (to within a hair) from the key poses and the pose halfway through each move between
// them: 3-8 solves instead of 25, for lists of hover thumbnails. It still holds the whole loop.
export function keysBox(vis) {
  return memo(vis, 'keysBox', () => {
    const { keys, loop } = vis.info
    const box = [Infinity, Infinity, -Infinity, -Infinity]
    keys.forEach((_, i) => sceneBounds(keyScene(vis, i).items, box))
    const order = stops(keys.length, loop)
    const moves = loop === 'spin' ? order.length - 1 : order.length
    const done = new Set()
    for (let s = 0; s < moves; s += 1) {
      const a = order[s]
      const b = order[(s + 1) % order.length]
      const id = `${Math.min(a, b)}-${Math.max(a, b)}`
      if (a === b || done.has(id)) continue
      done.add(id)
      sceneBounds(poseScene(vis, lerpPose(keys[a], keys[b], 0.5)).items, box)
    }
    return squareBox(box, 3, 44)
  })
}

// The floor line across a view box (when the floor is inside it).
export function groundLine(box) {
  const [x, y, size] = box
  if (GROUND < y || GROUND > y + size) return null
  return seg([x - 2, GROUND + 0.9], [x + size + 2, GROUND + 0.9], 0.9, 'ground')
}

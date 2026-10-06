// Front + back body map with the worked muscles coloured: primary in the accent colour, secondary
// in a lighter tint, everything else a quiet neutral so the anatomy still reads. Pure scene data.
import { dot, ell, poly, seg } from './scene.js'

export const FRONT_X = 25
export const BACK_X = 75

// Muscles that sit on the back of the body (the map leads with the back view for these).
export const BACK_MUSCLES = new Set(['lats', 'upper_back', 'traps', 'lower_back', 'triceps', 'glutes', 'hamstrings', 'calves'])

function silhouette(cx) {
  const out = []
  const at = (x, y) => [cx + x, y]
  out.push(dot(at(0, 9.6), 5.4, 'map'), seg(at(0, 14), at(0, 19.5), 4.2, 'map'))
  out.push(poly([[-10.6, 20], [10.6, 20], [11.8, 23.6], [9.9, 34], [8.2, 44], [9.8, 51.5], [-9.8, 51.5], [-8.2, 44], [-9.9, 34], [-11.8, 23.6]].map(([x, y]) => at(x, y)), 'map'))
  for (const s of [-1, 1]) {
    out.push(seg(at(s * 11, 23), at(s * 13.4, 36.5), 5.4, 'map'), seg(at(s * 13.4, 36.5), at(s * 15, 49), 4.4, 'map'), dot(at(s * 15.3, 52), 2.4, 'map'))
    out.push(seg(at(s * 5, 51), at(s * 5.6, 71), 8, 'map'), seg(at(s * 5.6, 71), at(s * 5.2, 89), 5.6, 'map'), seg(at(s * 5.2, 90.2), at(s * 7.4, 92.4), 2.6, 'map'))
  }
  return out
}

// [muscle, x, y, rx, ry, rotation], mirrored left/right.
const FRONT = [
  ['traps', 4.4, 20.6, 3.2, 1.3, -18],
  ['shoulders', 10.8, 23.6, 2.9, 3.3, 0],
  ['chest', 4.7, 26.8, 4.6, 3.4, 0],
  ['biceps', 12.4, 30, 2.1, 4.6, -10],
  ['forearms', 14.2, 43, 1.9, 5.2, -8],
  ['lats', 8.7, 33.5, 1.3, 4.4, -8],
  ['abductors', 8.5, 51.6, 1.8, 3.4, 0],
  ['quads', 5.8, 62, 3.3, 8, -2],
  ['adductors', 2.2, 57, 1.4, 4.8, 6],
  ['calves', 6.9, 78, 1.3, 4.4, 0],
]
const BACK = [
  ['shoulders', 10.8, 23.8, 2.9, 3.2, 0],
  ['upper_back', 4.3, 27.6, 3.4, 2.8, 0],
  ['lats', 7.3, 35, 3.2, 6.4, 14],
  ['lower_back', 2.1, 44.2, 1.8, 4.8, 0],
  ['triceps', 12.4, 30.5, 2.2, 4.8, -10],
  ['forearms', 14.2, 43, 1.9, 5.2, -8],
  ['abductors', 7.8, 49.2, 2.3, 2.1, 0],
  ['glutes', 4.6, 54.2, 4.3, 4.1, 0],
  ['adductors', 2.1, 60.5, 1.3, 4.4, 4],
  ['hamstrings', 5.7, 64.5, 3.1, 7.2, -2],
  ['calves', 5.6, 78.6, 2.7, 5.6, 0],
]
// Not mirrored: the trapezius diamond and the six-pack.
const FRONT_CENTRE = [['abs', poly([[-3.6, 31], [3.6, 31], [3.9, 46.5], [0, 48.5], [-3.9, 46.5]], '')]]
const BACK_CENTRE = [['traps', poly([[0, 15.5], [6.6, 20.8], [3.2, 27.4], [0, 30.2], [-3.2, 27.4], [-6.6, 20.8]], '')]]

// role for a muscle id: hot (primary), warm (secondary) or plain.
export function muscleRole(id, muscles) {
  const primary = muscles.primary
  if (primary.has('full_body')) return 'hot'
  if (primary.has(id)) return 'hot'
  if (muscles.secondary.has(id)) return primary.has('cardio') ? 'hot' : 'warm'
  return primary.has('cardio') ? 'warm' : 'mapMuscle'
}

function side(cx, spots, centre, muscles) {
  const out = silhouette(cx)
  for (const [id, shape] of centre) out.push({ ...shape, pts: shape.pts.map(([x, y]) => [cx + x, y]), role: muscleRole(id, muscles) })
  for (const [id, x, y, rx, ry, rot] of spots) {
    const role = muscleRole(id, muscles)
    out.push(ell([cx - x, y], rx, ry, -rot, role), ell([cx + x, y], rx, ry, rot, role))
  }
  return out
}

// Both views side by side in a 100-wide box; `only` = 'front' | 'back' draws one, centred.
export function muscleMapScene(muscles, only = null) {
  if (only === 'front') return side(50, FRONT, FRONT_CENTRE, muscles)
  if (only === 'back') return side(50, BACK, BACK_CENTRE, muscles)
  return [...side(FRONT_X, FRONT, FRONT_CENTRE, muscles), ...side(BACK_X, BACK, BACK_CENTRE, muscles)]
}

// Which single view shows the main muscle best (for small sizes).
export function bestSide(muscles) {
  for (const id of muscles.primary) if (BACK_MUSCLES.has(id)) return 'back'
  return 'front'
}
